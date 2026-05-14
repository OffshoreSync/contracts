// Phase 0 — Deploy Self.xyz's forked `Verifier_vc_and_disclose` to ZKSync Era.
// Usage:
//   yarn deploy:self-verifier:sepolia
//
// Prerequisites:
//   1. Funded DEPLOYER_PRIVATE_KEY on ZKSync Era Sepolia (bridge ETH via
//      https://portal.zksync.io/bridge/?network=sepolia ).
//   2. `yarn compile` succeeded.

import { Wallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import * as fs from 'fs';
import * as path from 'path';

export default async function deploy(hardhat: HardhatRuntimeEnvironment): Promise<void> {
  console.log('[deploy] network:', hardhat.network.name);

  // Prefer env override; fall back to whatever the network config provides
  // (e.g. the rich wallet for `inMemoryNode`). This way `yarn deploy:local`
  // works out of the box and `yarn deploy:sepolia` requires explicit funding.
  const networkAccounts = hardhat.network.config.accounts as string[] | undefined;
  const pk = process.env.DEPLOYER_PRIVATE_KEY || (Array.isArray(networkAccounts) ? networkAccounts[0] : undefined);
  if (!pk) {
    throw new Error(
      'No deployer key available. Set DEPLOYER_PRIVATE_KEY in .env or configure ' +
        '`networks.<name>.accounts` for this network.',
    );
  }

  const wallet = new Wallet(pk);
  const deployer = new Deployer(hardhat, wallet);

  console.log('[deploy] deployer address:', wallet.address);
  const balance = await deployer.zkWallet.getBalance();
  console.log('[deploy] L2 balance (wei):', balance.toString());
  if (balance === 0n) {
    throw new Error(
      'Deployer L2 balance is 0. Bridge Sepolia ETH to ZKSync Era Sepolia first.',
    );
  }

  const artifact = await deployer.loadArtifact('Verifier_vc_and_disclose');
  console.log('[deploy] artifact bytecode size:', artifact.bytecode.length / 2 - 1, 'bytes');

  const verifier = await deployer.deploy(artifact, []);
  const address = await verifier.getAddress();
  const txHash = verifier.deploymentTransaction()?.hash;

  console.log('[deploy] ✅ Verifier_vc_and_disclose deployed');
  console.log('[deploy]    address:', address);
  console.log('[deploy]    tx:     ', txHash);
  console.log(
    '[deploy]    explorer: https://sepolia.explorer.zksync.io/address/' + address,
  );

  // Persist deployment record so the smoke test can find it.
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const outPath = path.join(deploymentsDir, `${hardhat.network.name}.json`);
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  prev.Verifier_vc_and_disclose = {
    address,
    txHash,
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
  };
  fs.writeFileSync(outPath, JSON.stringify(prev, null, 2) + '\n');
  console.log('[deploy] wrote', outPath);
}
