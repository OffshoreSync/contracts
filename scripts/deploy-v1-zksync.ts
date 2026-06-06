// α-2 — Deploy the v1 ZKSync Era contracts (CofferdamReceiver + Escrow).
//
// Usage:
//   yarn deploy:v1-zksync:local      # against anvil-zksync (in-memory node)
//   yarn deploy:v1-zksync:sepolia    # against ZKSync Era Sepolia (needs funded key)
//
// What it does:
//   1. Deploys CofferdamReceiver, initial owner = deployer EOA.
//   2. Deploys CofferdamSpotEscrow wired to that receiver; initial owner = deployer EOA.
//   3. Writes both addresses (+ deployer + timestamp) to
//        contracts/deployments/<network>.json
//      so the SDK's LocalChainProvider, the smoke-test, and the consumer-app
//      env files can pick them up programmatically.
//
// Ownership hand-off (production):
//   For Sepolia / mainnet, follow-up step is to transferOwnership() on both
//   contracts to the OffshoreSync LLC Treasury Safe. We do NOT bake that into
//   this script — Safe addresses are env-managed and the transfer is a manual
//   gate per the deploy checklist. The two-step accept-flow on each contract
//   prevents fat-finger handoff to a dead key.

import { Wallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import * as fs from 'fs';
import * as path from 'path';

export default async function deploy(hardhat: HardhatRuntimeEnvironment): Promise<void> {
  console.log('[deploy-v1-zksync] network:', hardhat.network.name);

  // Key selection: for local networks (`inMemoryNode`, `hardhat`) prefer the
  // network-config account (= anvil-zksync rich wallet), so local deploys
  // work out of the box regardless of what's in .env. For remote networks
  // (sepolia / mainnet) prefer DEPLOYER_PRIVATE_KEY so the .env-managed
  // funded key always wins.
  const isLocal = hardhat.network.name === 'inMemoryNode' || hardhat.network.name === 'hardhat';
  const networkAccounts = hardhat.network.config.accounts as string[] | undefined;
  const networkPk = Array.isArray(networkAccounts) ? networkAccounts[0] : undefined;
  const pk = isLocal ? networkPk || process.env.DEPLOYER_PRIVATE_KEY : process.env.DEPLOYER_PRIVATE_KEY || networkPk;
  if (!pk) {
    throw new Error(
      'No deployer key available. Set DEPLOYER_PRIVATE_KEY in .env or configure ' +
        '`networks.<name>.accounts` for this network.',
    );
  }

  const wallet = new Wallet(pk);
  const deployer = new Deployer(hardhat, wallet);

  console.log('[deploy-v1-zksync] deployer:', wallet.address);
  const balance = await deployer.zkWallet.getBalance();
  console.log('[deploy-v1-zksync] L2 balance (wei):', balance.toString());
  if (balance === 0n) {
    throw new Error(
      'Deployer L2 balance is 0. Bridge ETH to ' + hardhat.network.name + ' first.',
    );
  }

  // ── 1. CofferdamReceiver ────────────────────────────────────────────────
  const receiverArtifact = await deployer.loadArtifact('CofferdamReceiver');
  const receiver = await deployer.deploy(receiverArtifact, [wallet.address]);
  const receiverAddress = await receiver.getAddress();
  const receiverTx = receiver.deploymentTransaction()?.hash;
  console.log('[deploy-v1-zksync] ✅ CofferdamReceiver');
  console.log('[deploy-v1-zksync]    address:', receiverAddress);
  console.log('[deploy-v1-zksync]    tx:     ', receiverTx);

  // ── 2. CofferdamSpotEscrow (wired to receiver) ──────────────────────────────
  const escrowArtifact = await deployer.loadArtifact('CofferdamSpotEscrow');
  const escrow = await deployer.deploy(escrowArtifact, [receiverAddress, wallet.address]);
  const escrowAddress = await escrow.getAddress();
  const escrowTx = escrow.deploymentTransaction()?.hash;
  console.log('[deploy-v1-zksync] ✅ CofferdamSpotEscrow');
  console.log('[deploy-v1-zksync]    address:', escrowAddress);
  console.log('[deploy-v1-zksync]    tx:     ', escrowTx);
  console.log('[deploy-v1-zksync]    identity:', receiverAddress);

  // ── 3. Persist deployment record ───────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const outPath = path.join(deploymentsDir, `${hardhat.network.name}.json`);
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const deployedAt = new Date().toISOString();
  prev.CofferdamReceiver = {
    address: receiverAddress,
    txHash: receiverTx,
    deployedAt,
    deployer: wallet.address,
    owner: wallet.address,
  };
  prev.CofferdamSpotEscrow = {
    address: escrowAddress,
    txHash: escrowTx,
    deployedAt,
    deployer: wallet.address,
    owner: wallet.address,
    identity: receiverAddress,
  };
  fs.writeFileSync(outPath, JSON.stringify(prev, null, 2) + '\n');
  console.log('[deploy-v1-zksync] wrote', outPath);
}
