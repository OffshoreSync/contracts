// Deploy the Cofferdam native Account Abstraction stack on ZKSync Era.
//
// What ships:
//   1. CofferdamAccountFactory — CREATE2 factory. Constructed with the ZKSync
//      bytecode hash of CofferdamSmartAccount and carries that account's bytecode
//      as a factoryDep, so it can deploy per-user accounts via create2Account.
//   2. CofferdamPaymaster      — general-flow gas sponsor, owned + funded by the
//      deployer. Starts in `open` (sponsor-all) mode for testnet unless
//      PAYMASTER_OPEN=0; restrict later with setOpen(false)+setSponsored(...).
//
// CofferdamSmartAccount itself has NO standalone address: it is only ever
// instantiated through the factory's create2Account. We record its bytecode hash
// (the counterfactual-address input the SDK needs) in the registry.
//
// The stateless authority modules (PasskeyAuthority / SessionKeyAuthority) are
// deployed separately by deploy-auth-framework.ts and referenced per-account.
//
// Usage:
//   npx hardhat deploy-zksync --script deploy-native-account.ts --network inMemoryNode
//   npx hardhat deploy-zksync --script deploy-native-account.ts --network zkSyncSepolia
//
// Env:
//   DEPLOYER_PRIVATE_KEY   deployer/owner key (required on sepolia).
//   PAYMASTER_OPEN=0       deploy the paymaster in allowlist-only mode.
//   PAYMASTER_FUND=0.01    ETH to seed the paymaster with after deploy (optional).

import { ethers } from 'ethers';
import { utils, Wallet as ZkWallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import * as fs from 'fs';
import * as path from 'path';

interface DeploymentEntry {
  address?: string;
  txHash?: string;
  deployedAt: string;
  deployer: string;
  [extra: string]: unknown;
}

type DeploymentRegistry = Record<string, DeploymentEntry>;

export default async function deploy(hardhat: HardhatRuntimeEnvironment): Promise<void> {
  const networkName = hardhat.network.name;
  console.log('[deploy-native-account] network:', networkName);

  const isLocal = networkName === 'inMemoryNode' || networkName === 'hardhat';
  const networkAccounts = hardhat.network.config.accounts as string[] | undefined;
  const networkPk = Array.isArray(networkAccounts) ? networkAccounts[0] : undefined;
  const pk = isLocal
    ? networkPk || process.env.DEPLOYER_PRIVATE_KEY
    : process.env.DEPLOYER_PRIVATE_KEY || networkPk;
  if (!pk) throw new Error('No deployer key available. Set DEPLOYER_PRIVATE_KEY in .env.');

  const wallet = new ZkWallet(pk);
  const deployer = new Deployer(hardhat, wallet);
  console.log('[deploy-native-account] deployer:', wallet.address);

  const balance = await deployer.zkWallet.getBalance();
  console.log('[deploy-native-account] L2 balance (wei):', balance.toString());
  if (balance === 0n) throw new Error(`Deployer L2 balance is 0. Bridge ETH to ${networkName} first.`);

  // ── Factory (carries CofferdamSmartAccount bytecode as a factoryDep) ──
  const accountArtifact = await deployer.loadArtifact('CofferdamSmartAccount');
  const aaBytecodeHash = utils.hashBytecode(accountArtifact.bytecode);
  console.log('[deploy-native-account] CofferdamSmartAccount bytecodeHash:', ethers.hexlify(aaBytecodeHash));

  const factoryArtifact = await deployer.loadArtifact('CofferdamAccountFactory');
  const factory = await deployer.deploy(
    factoryArtifact,
    [aaBytecodeHash],
    undefined,
    {},
    [accountArtifact.bytecode],
  );
  const factoryAddr = await factory.getAddress();
  console.log('[deploy-native-account] ✅ CofferdamAccountFactory:', factoryAddr);

  // ── Paymaster ─────────────────────────────────────────────────────────
  const openMode = process.env.PAYMASTER_OPEN !== '0';
  const paymasterArtifact = await deployer.loadArtifact('CofferdamPaymaster');
  const paymaster = await deployer.deploy(paymasterArtifact, [openMode]);
  const paymasterAddr = await paymaster.getAddress();
  console.log(`[deploy-native-account] ✅ CofferdamPaymaster (open=${openMode}):`, paymasterAddr);

  // ── Optional paymaster funding ──────────────────────────────────────────
  const fundEth = process.env.PAYMASTER_FUND;
  if (fundEth && Number(fundEth) > 0) {
    const value = ethers.parseEther(fundEth);
    const tx = await deployer.zkWallet.sendTransaction({ to: paymasterAddr, value });
    await tx.wait();
    console.log(`[deploy-native-account] 💸 funded paymaster with ${fundEth} ETH (tx ${tx.hash})`);
  }

  // ── Persist records ──────────────────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const registryPath = path.join(deploymentsDir, `${networkName}.json`);
  const registry: DeploymentRegistry = fs.existsSync(registryPath)
    ? (JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DeploymentRegistry)
    : {};

  const now = new Date().toISOString();
  registry['CofferdamSmartAccount'] = {
    deployedAt: now,
    deployer: wallet.address,
    note: 'Implementation deployed only via factory create2Account; no standalone address.',
    aaBytecodeHash: ethers.hexlify(aaBytecodeHash),
  };
  registry['CofferdamAccountFactory'] = {
    address: factoryAddr,
    txHash: factory.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    aaBytecodeHash: ethers.hexlify(aaBytecodeHash),
  };
  registry['CofferdamPaymaster'] = {
    address: paymasterAddr,
    txHash: paymaster.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    owner: wallet.address,
    open: openMode,
    fundedEth: fundEth && Number(fundEth) > 0 ? fundEth : '0',
  };

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('[deploy-native-account] wrote:', registryPath);
}
