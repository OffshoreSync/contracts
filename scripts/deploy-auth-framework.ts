// Deploy the CofferdamAccount authority framework on ZKSync Era.
//
// What ships (all stateless singletons — deployed ONCE per network and shared
// by every CofferdamAccount; per-user accounts are deployed separately by the
// app/factory and reference these module addresses):
//
//   1. PasskeyAuthority          — High tier, RAW P-256 over the digest (the
//      α-2 software/Secure-Enclave key path).
//   2. WebAuthnPasskeyAuthority  — High tier, a REAL WebAuthn assertion
//      (react-native-passkeys / navigator.credentials). Deployed with
//      requireUserVerification=true (biometric-gated). This is the module the
//      production mobile app bootstraps its account on.
//   3. SessionKeyAuthority(Untrusted) — LowUntrusted legacy bridge: the module
//      a consumer on local-password / Google-Apple OAuth registers a server
//      session-signer against, so users can transact today and migrate to a
//      passkey via CofferdamAccount.enrollFirstPasskey (the one-way ratchet).
//   4. SessionKeyAuthority(Managed)   — LowManaged bridge for enterprise Polis
//      SSO (NOT ratchet-locked; OR-semantics with a later passkey).
//
// Optionally (SAMPLE_ACCOUNT=1) deploys one legacy-first CofferdamAccount
// bootstrapped on the untrusted session module with SAMPLE_SESSION_SIGNER as
// its server key, for end-to-end smoke testing.
//
// Usage:
//   npx hardhat deploy-zksync --script deploy-auth-framework.ts --network inMemoryNode
//   npx hardhat deploy-zksync --script deploy-auth-framework.ts --network zkSyncSepolia
//
// Prerequisites for sepolia: DEPLOYER_PRIVATE_KEY in .env, funded with ≥ 0.005
// L2 ETH (three small deploys + buffer).

import { ethers } from 'ethers';
import { Wallet as ZkWallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import * as fs from 'fs';
import * as path from 'path';

// Must match IAuthorityModule.sol Tier enum order.
const Tier = { None: 0, LowUntrusted: 1, LowManaged: 2, High: 3 } as const;

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
  console.log('[deploy-auth-framework] network:', networkName);

  // ── Deployer key selection (mirrors deploy-v2-self.ts) ──────────────
  const isLocal = networkName === 'inMemoryNode' || networkName === 'hardhat';
  const networkAccounts = hardhat.network.config.accounts as string[] | undefined;
  const networkPk = Array.isArray(networkAccounts) ? networkAccounts[0] : undefined;
  const pk = isLocal
    ? networkPk || process.env.DEPLOYER_PRIVATE_KEY
    : process.env.DEPLOYER_PRIVATE_KEY || networkPk;
  if (!pk) throw new Error('No deployer key available. Set DEPLOYER_PRIVATE_KEY in .env.');

  const wallet = new ZkWallet(pk);
  const deployer = new Deployer(hardhat, wallet);
  console.log('[deploy-auth-framework] deployer:', wallet.address);

  const balance = await deployer.zkWallet.getBalance();
  console.log('[deploy-auth-framework] L2 balance (wei):', balance.toString());
  if (balance === 0n) throw new Error(`Deployer L2 balance is 0. Bridge ETH to ${networkName} first.`);

  // ── Deploy the three stateless authority modules ────────────────────
  const passkeyMod = await deployer.deploy(await deployer.loadArtifact('PasskeyAuthority'), []);
  const passkeyModAddr = await passkeyMod.getAddress();
  console.log('[deploy-auth-framework] ✅ PasskeyAuthority:', passkeyModAddr);

  // UV is a compile-time `constant true` on this module (a High-tier financial
  // authority is always biometric-gated). It must be a constant — not an
  // immutable/storage value — so `isValidSignature` is safe to call inside the
  // ZKSync AA validation step. Hence no constructor args.
  const webauthnMod = await deployer.deploy(
    await deployer.loadArtifact('WebAuthnPasskeyAuthority'),
    [],
  );
  const webauthnModAddr = await webauthnMod.getAddress();
  console.log('[deploy-auth-framework] ✅ WebAuthnPasskeyAuthority (requireUV):', webauthnModAddr);

  const untrustedMod = await deployer.deploy(
    await deployer.loadArtifact('SessionKeyAuthority'),
    [Tier.LowUntrusted],
  );
  const untrustedModAddr = await untrustedMod.getAddress();
  console.log('[deploy-auth-framework] ✅ SessionKeyAuthority(LowUntrusted):', untrustedModAddr);

  const managedMod = await deployer.deploy(
    await deployer.loadArtifact('SessionKeyAuthority'),
    [Tier.LowManaged],
  );
  const managedModAddr = await managedMod.getAddress();
  console.log('[deploy-auth-framework] ✅ SessionKeyAuthority(LowManaged):', managedModAddr);

  // ── Persist module records ──────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const registryPath = path.join(deploymentsDir, `${networkName}.json`);
  const registry: DeploymentRegistry = fs.existsSync(registryPath)
    ? (JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DeploymentRegistry)
    : {};

  const now = new Date().toISOString();
  registry['PasskeyAuthority'] = {
    address: passkeyModAddr,
    txHash: passkeyMod.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    tier: 'High',
    kind: 'passkey',
  };
  registry['WebAuthnPasskeyAuthority'] = {
    address: webauthnModAddr,
    txHash: webauthnMod.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    tier: 'High',
    kind: 'passkey',
    requireUserVerification: true,
  };
  registry['SessionKeyAuthority_LowUntrusted'] = {
    address: untrustedModAddr,
    txHash: untrustedMod.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    tier: 'LowUntrusted',
    kind: 'session',
  };
  registry['SessionKeyAuthority_LowManaged'] = {
    address: managedModAddr,
    txHash: managedMod.deploymentTransaction()?.hash,
    deployedAt: now,
    deployer: wallet.address,
    tier: 'LowManaged',
    kind: 'polis_sso',
  };

  // ── Optional sample legacy-first account ────────────────────────────
  if (process.env.SAMPLE_ACCOUNT === '1') {
    const signer = process.env.SAMPLE_SESSION_SIGNER || wallet.address;
    const config = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [signer]);
    const account = await deployer.deploy(await deployer.loadArtifact('CofferdamAccount'), [
      untrustedModAddr,
      config,
    ]);
    const accountAddr = await account.getAddress();
    console.log('[deploy-auth-framework] ✅ sample CofferdamAccount (legacy-first):', accountAddr);
    console.log('[deploy-auth-framework]    session signer:', signer);
    registry['CofferdamAccount_sample'] = {
      address: accountAddr,
      txHash: account.deploymentTransaction()?.hash,
      deployedAt: now,
      deployer: wallet.address,
      bootstrapModule: untrustedModAddr,
      bootstrapTier: 'LowUntrusted',
      sessionSigner: signer,
    };
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('[deploy-auth-framework] wrote:', registryPath);
}
