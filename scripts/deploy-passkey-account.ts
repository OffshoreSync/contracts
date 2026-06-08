// Deploy a CofferdamPasskeyAccount to ZKSync Era (local or Sepolia).
//
// Usage:
//   npx hardhat deploy-zksync --script deploy-passkey-account.ts --network inMemoryNode
//   npx hardhat deploy-zksync --script deploy-passkey-account.ts --network zkSyncSepolia
//
// Environment:
//   DEPLOYER_PRIVATE_KEY  — funded EOA on the target network
//   Optionally set PASSKEY_QX and PASSKEY_QY to deploy with a specific key.
//   If omitted, a deterministic test key is used.

import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { Wallet as ZkWallet } from 'zksync-ethers';
import * as fs from 'fs';
import * as path from 'path';

interface DeploymentEntry {
  address: string;
  txHash: string | undefined;
  deployedAt: string;
  deployer: string;
  [extra: string]: unknown;
}

type DeploymentRegistry = Record<string, DeploymentEntry>;

export default async function deploy(hardhat: HardhatRuntimeEnvironment): Promise<void> {
  const networkName = hardhat.network.name;
  console.log('[deploy-passkey-account] network:', networkName);

  const accounts = hardhat.network.config.accounts as string[];
  const deployerWallet = new ZkWallet(accounts[0]);
  const deployer = new Deployer(hardhat, deployerWallet);
  console.log('  deployer:', deployerWallet.address);

  // ── Passkey public key ────────────────────────────────────────────
  // In production the app sends these. For a standalone deploy script
  // we accept them via env or fall back to a deterministic test key.
  const qx = process.env.PASSKEY_QX || '0xa71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957';
  const qy = process.env.PASSKEY_QY || '0x5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b';
  console.log('  passkey Qx:', qx);
  console.log('  passkey Qy:', qy);

  // ── Deploy ────────────────────────────────────────────────────────
  const artifact = await deployer.loadArtifact('CofferdamPasskeyAccount');
  const contract = await deployer.deploy(artifact, [qx, qy]);
  const address = await contract.getAddress();
  const tx = contract.deploymentTx ? await contract.deploymentTx() : undefined;

  console.log('  deployed at:', address);
  console.log('  tx hash:', tx?.hash);

  // ── Record in registry ────────────────────────────────────────────
  const registryPath = path.join(__dirname, '..', 'deployments', `${networkName}.json`);
  let registry: DeploymentRegistry = {};
  if (fs.existsSync(registryPath)) {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as DeploymentRegistry;
  } else {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  }

  registry['CofferdamPasskeyAccount'] = {
    address,
    txHash: tx?.hash,
    deployedAt: new Date().toISOString(),
    deployer: deployerWallet.address,
    passkeyX: qx,
    passkeyY: qy,
  };

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('  registry updated:', registryPath);
}
