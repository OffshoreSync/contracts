// Phase 1 — Deploy `SelfAttesterRegistry` + `NullifierRegistry` to ZKSync Era.
// Reuses the `Verifier_vc_and_disclose` deployed in Phase 0 (its address must
// already be present in `deployments/<network>.json`).
//
// Usage:
//   yarn deploy:phase1:local       # deploys against local anvil-zksync
//   yarn deploy:phase1:sepolia     # deploys against ZKSync Era Sepolia
//
// Required env vars (read from `.env`):
//   DEPLOYER_PRIVATE_KEY         — funded ZKSync Era deployer key.
//   SELF_TEE_ATTESTERS           — comma-separated 0x addresses to seed the
//                                  trusted attester allow-list. For Sepolia,
//                                  set this to Self.xyz's STAGING TEE attester
//                                  address. For mainnet, the PRODUCTION one.
//                                  Source: `@selfxyz/mobile-sdk-alpha` SDK
//                                  constants (TODO: link once we wire the
//                                  mobile SDK in Phase 2). For local dev a
//                                  random 0x address is fine.
//   NULLIFIER_REGISTRY_SCOPE     — Poseidon-hashed application scope as a
//                                  decimal or 0x-hex uint256 string. Locks
//                                  proofs from a different scope out of this
//                                  registry. For local dev set to "1".

import { Wallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import * as fs from 'fs';
import * as path from 'path';

type Deployments = Record<
  string,
  {
    address: string;
    txHash?: string;
    deployedAt?: string;
    deployer?: string;
    [k: string]: unknown;
  }
>;

function readDeployments(networkName: string): Deployments {
  const p = path.join(__dirname, '..', 'deployments', `${networkName}.json`);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Deployments;
}

function writeDeployments(networkName: string, data: Deployments): string {
  const dir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

function explorerUrl(networkName: string, addressOrTx: string, kind: 'address' | 'tx'): string {
  const base = networkName === 'zkSyncSepolia'
    ? 'https://sepolia.explorer.zksync.io'
    : networkName === 'zkSyncMainnet'
    ? 'https://explorer.zksync.io'
    : '';
  return base ? `${base}/${kind}/${addressOrTx}` : '(local)';
}

function parseAttesters(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseScope(raw: string | undefined): bigint {
  if (!raw) {
    throw new Error('NULLIFIER_REGISTRY_SCOPE is required');
  }
  // Accepts 0x-hex or decimal.
  return raw.startsWith('0x') || raw.startsWith('0X') ? BigInt(raw) : BigInt(raw);
}

export default async function deploy(hardhat: HardhatRuntimeEnvironment): Promise<void> {
  const networkName = hardhat.network.name;
  console.log('[phase1] network:', networkName);

  // ── Inputs ────────────────────────────────────────────────────────────
  const networkAccounts = hardhat.network.config.accounts as string[] | undefined;
  const pk = process.env.DEPLOYER_PRIVATE_KEY ||
    (Array.isArray(networkAccounts) ? networkAccounts[0] : undefined);
  if (!pk) throw new Error('No deployer key. Set DEPLOYER_PRIVATE_KEY or configure network accounts.');

  const attesters = parseAttesters(process.env.SELF_TEE_ATTESTERS);
  if (attesters.length === 0) {
    console.warn(
      '[phase1] WARN: SELF_TEE_ATTESTERS is empty. Deploying registry with no\n' +
        '         trusted attesters — verifyAndBind will fail until you add one\n' +
        '         via SelfAttesterRegistry.addAttester(...).',
    );
  }
  const scope = parseScope(process.env.NULLIFIER_REGISTRY_SCOPE);

  const existing = readDeployments(networkName);
  const verifierAddress = existing.Verifier_vc_and_disclose?.address;
  if (!verifierAddress) {
    throw new Error(
      `No Verifier_vc_and_disclose found in deployments/${networkName}.json. Run Phase 0 deploy first.`,
    );
  }

  // ── Wallet / deployer ─────────────────────────────────────────────────
  const wallet = new Wallet(pk);
  const deployer = new Deployer(hardhat, wallet);
  console.log('[phase1] deployer:', wallet.address);
  const bal = await deployer.zkWallet.getBalance();
  console.log('[phase1] L2 balance (wei):', bal.toString());
  if (bal === 0n) {
    throw new Error('Deployer L2 balance is 0. Bridge Sepolia ETH to ZKSync Era Sepolia first.');
  }

  // ── 1) SelfAttesterRegistry ────────────────────────────────────────────
  console.log('[phase1] (1/2) deploying SelfAttesterRegistry');
  console.log('[phase1]      owner:', wallet.address);
  console.log('[phase1]      initial attesters:', attesters.length === 0 ? '(none)' : attesters.join(', '));
  const attesterRegistryArtifact = await deployer.loadArtifact('SelfAttesterRegistry');
  const attesterRegistry = await deployer.deploy(attesterRegistryArtifact, [
    wallet.address,
    attesters,
  ]);
  const attesterRegistryAddress = await attesterRegistry.getAddress();
  const attesterRegistryTx = attesterRegistry.deploymentTransaction()?.hash;
  console.log('[phase1]      ✅ deployed at', attesterRegistryAddress);
  console.log('[phase1]      tx:', attesterRegistryTx, '-', explorerUrl(networkName, attesterRegistryTx ?? '', 'tx'));

  // ── 2) NullifierRegistry ───────────────────────────────────────────────
  console.log('[phase1] (2/2) deploying NullifierRegistry');
  console.log('[phase1]      verifier:', verifierAddress);
  console.log('[phase1]      attesterRegistry:', attesterRegistryAddress);
  console.log('[phase1]      scope:', scope.toString(), '(0x' + scope.toString(16) + ')');
  const nullifierRegistryArtifact = await deployer.loadArtifact('NullifierRegistry');
  const nullifierRegistry = await deployer.deploy(nullifierRegistryArtifact, [
    verifierAddress,
    attesterRegistryAddress,
    // Pass as string to dodge JSON.stringify(BigInt) in matter-labs' deploy cache.
    scope.toString(),
  ]);
  const nullifierRegistryAddress = await nullifierRegistry.getAddress();
  const nullifierRegistryTx = nullifierRegistry.deploymentTransaction()?.hash;
  console.log('[phase1]      ✅ deployed at', nullifierRegistryAddress);
  console.log('[phase1]      tx:', nullifierRegistryTx, '-', explorerUrl(networkName, nullifierRegistryTx ?? '', 'tx'));

  // ── Persist ───────────────────────────────────────────────────────────
  existing.SelfAttesterRegistry = {
    address: attesterRegistryAddress,
    txHash: attesterRegistryTx,
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
    initialAttesters: attesters,
  };
  existing.NullifierRegistry = {
    address: nullifierRegistryAddress,
    txHash: nullifierRegistryTx,
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
    verifier: verifierAddress,
    attesterRegistry: attesterRegistryAddress,
    scope: scope.toString(),
  };
  const out = writeDeployments(networkName, existing);
  console.log('[phase1] wrote', out);
  console.log('[phase1] done.');
}
