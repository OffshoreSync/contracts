// Session 2 — Deploy the v2 Self.xyz identity rail on ZKSync Era.
//
// What ships:
//   1. SelfAttesterRegistry — allow-list of trusted Self TEE attester
//      ECDSA addresses. Owned by the deployer. Initial attester is a
//      freshly-generated key (its private key is printed once to the
//      operator's terminal and never persisted by this script).
//   2. NullifierRegistry — wires the existing Verifier_vc_and_disclose
//      (already deployed on Sepolia at 0xf2353…b7E5) to the
//      SelfAttesterRegistry above, locked to the per-environment scope
//      (cofferdam-sepolia / cofferdam-mainnet) chosen for Session 2.
//
// Reads from the existing deployment registry for the verifier address
// (assumes Verifier_vc_and_disclose is already deployed on the target
// network — pre-existing on Sepolia, must be deployed on
// inMemoryNode/local first via deploy-self-verifier.ts).
//
// Usage:
//   yarn deploy:v2-self:local        # against anvil-zksync
//   yarn deploy:v2-self:sepolia      # against ZKSync Era Sepolia
//
// Prerequisites for sepolia:
//   - DEPLOYER_PRIVATE_KEY in .env, address funded with ≥ 0.005 ETH
//     on Sepolia (two contract deploys + buffer).
//   - Verifier_vc_and_disclose entry present in
//     deployments/zkSyncSepolia.json (already true 2026-05-16).

import { Wallet, ethers } from 'ethers';
import { Wallet as ZkWallet } from 'zksync-ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { hashEndpointWithScope } from '@selfxyz/common';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────
// Scope policy — locked 2026-05-30, Session 2.
//
// Per user decision: per-environment scope to avoid chain pollution
// between dev and prod. Endpoint is the root Cofferdam domain (same
// across all environments) — the scope string is the environment
// differentiator.
//
// Whatever value lands on-chain for `_expectedScope` MUST be matched
// exactly by the prover-side scope-hashing in Sessions 4-5. The values
// below are recorded in progress.txt at deploy time.
// ────────────────────────────────────────────────────────────────────
const COFFERDAM_ENDPOINT = 'cofferdam.xyz';

const SCOPE_FOR_NETWORK: Record<string, string> = {
  zkSyncSepolia: 'cofferdam-sepolia',
  inMemoryNode: 'cofferdam-local',
  hardhat: 'cofferdam-local',
  // Mainnet entry added when that network is configured.
};

interface DeploymentEntry {
  address: string;
  txHash: string | undefined;
  deployedAt: string;
  deployer: string;
  [extra: string]: unknown;
}

type DeploymentRegistry = Record<string, DeploymentEntry>;

export default async function deploy(
  hardhat: HardhatRuntimeEnvironment,
): Promise<void> {
  const networkName = hardhat.network.name;
  console.log('[deploy-v2-self] network:', networkName);

  // ── Scope selection ────────────────────────────────────────────
  const scope = SCOPE_FOR_NETWORK[networkName];
  if (!scope) {
    throw new Error(
      `No scope policy configured for network '${networkName}'. ` +
        `Add an entry to SCOPE_FOR_NETWORK in deploy-v2-self.ts.`,
    );
  }
  const expectedScope = BigInt(
    hashEndpointWithScope(COFFERDAM_ENDPOINT, scope),
  );
  console.log('[deploy-v2-self] endpoint:', COFFERDAM_ENDPOINT);
  console.log('[deploy-v2-self] scope:   ', scope);
  console.log(
    '[deploy-v2-self] _expectedScope (uint256):',
    expectedScope.toString(),
  );
  console.log(
    '[deploy-v2-self] _expectedScope (hex):    0x' +
      expectedScope.toString(16),
  );

  // ── Deployer key selection (mirrors deploy-v1-zksync.ts logic) ─
  const isLocal =
    networkName === 'inMemoryNode' || networkName === 'hardhat';
  const networkAccounts = hardhat.network.config.accounts as
    | string[]
    | undefined;
  const networkPk = Array.isArray(networkAccounts)
    ? networkAccounts[0]
    : undefined;
  const pk = isLocal
    ? networkPk || process.env.DEPLOYER_PRIVATE_KEY
    : process.env.DEPLOYER_PRIVATE_KEY || networkPk;
  if (!pk) {
    throw new Error(
      'No deployer key available. Set DEPLOYER_PRIVATE_KEY in .env.',
    );
  }
  const wallet = new ZkWallet(pk);
  const deployer = new Deployer(hardhat, wallet);
  console.log('[deploy-v2-self] deployer:', wallet.address);

  const balance = await deployer.zkWallet.getBalance();
  console.log('[deploy-v2-self] L2 balance (wei):', balance.toString());
  if (balance === 0n) {
    throw new Error(
      `Deployer L2 balance is 0. Bridge ETH to ${networkName} first.`,
    );
  }

  // ── Load existing deployments (for Verifier_vc_and_disclose) ───
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const registryPath = path.join(deploymentsDir, `${networkName}.json`);
  const registry: DeploymentRegistry = fs.existsSync(registryPath)
    ? (JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DeploymentRegistry)
    : {};

  const verifierEntry = registry['Verifier_vc_and_disclose'];
  if (!verifierEntry) {
    throw new Error(
      `Verifier_vc_and_disclose missing from ${registryPath}. ` +
        `Deploy it first via deploy-self-verifier.ts.`,
    );
  }
  const verifierAddress = verifierEntry.address;
  console.log('[deploy-v2-self] verifier (existing):', verifierAddress);

  // ── Generate attester keypair ──────────────────────────────────
  // Fresh secp256k1 key. The private key is printed IMMEDIATELY — even
  // if subsequent deploys fail, the operator sees the key in stdout
  // and can save it. (An earlier version printed at the end of the
  // script and a mid-script crash lost the key for the address we'd
  // already committed on-chain.)
  const attesterWallet = Wallet.createRandom();
  const attesterAddress = ethers.getAddress(attesterWallet.address);
  const attesterPrivateKey = attesterWallet.privateKey;

  console.log('');
  console.log(
    '═══════════════════════════════════════════════════════════════════',
  );
  console.log(' ATTESTER PRIVATE KEY — COPY NOW INTO 1PASSWORD / SECRETS');
  console.log(
    '═══════════════════════════════════════════════════════════════════',
  );
  console.log(' Address:', attesterAddress);
  console.log(' Privkey:', attesterPrivateKey);
  console.log('');
  console.log(' Save this BEFORE letting the script continue. Session 3:');
  console.log('   wrangler secret put ATTESTER_PRIVATE_KEY \\');
  console.log('     --name cofferdam-attester       # paste privkey above');
  console.log(
    '═══════════════════════════════════════════════════════════════════',
  );
  console.log('');

  // ── 1. Deploy SelfAttesterRegistry ─────────────────────────────
  const attesterRegistryArtifact = await deployer.loadArtifact(
    'SelfAttesterRegistry',
  );
  const attesterRegistry = await deployer.deploy(attesterRegistryArtifact, [
    wallet.address, // initial owner
    [attesterAddress], // initial attester allow-list
  ]);
  const attesterRegistryAddress = await attesterRegistry.getAddress();
  const attesterRegistryTx = attesterRegistry.deploymentTransaction()?.hash;
  console.log('[deploy-v2-self] ✅ SelfAttesterRegistry');
  console.log(
    '[deploy-v2-self]    address:',
    attesterRegistryAddress,
  );
  console.log('[deploy-v2-self]    tx:     ', attesterRegistryTx);

  // ── 2. Deploy NullifierRegistry ────────────────────────────────
  // Pass expectedScope as a decimal string. hardhat-zksync-deploy's
  // internal deployment-saver cache uses JSON.stringify on the
  // constructor args, which throws on BigInt values. The contract's
  // uint256 constructor parameter accepts string just fine via ethers.
  const nullifierRegistryArtifact = await deployer.loadArtifact(
    'NullifierRegistry',
  );
  const nullifierRegistry = await deployer.deploy(nullifierRegistryArtifact, [
    verifierAddress,
    attesterRegistryAddress,
    expectedScope.toString(),
  ]);
  const nullifierRegistryAddress = await nullifierRegistry.getAddress();
  const nullifierRegistryTx =
    nullifierRegistry.deploymentTransaction()?.hash;
  console.log('[deploy-v2-self] ✅ NullifierRegistry');
  console.log(
    '[deploy-v2-self]    address:',
    nullifierRegistryAddress,
  );
  console.log('[deploy-v2-self]    tx:     ', nullifierRegistryTx);
  console.log('[deploy-v2-self]    verifier:', verifierAddress);
  console.log(
    '[deploy-v2-self]    attesterRegistry:',
    attesterRegistryAddress,
  );
  console.log(
    '[deploy-v2-self]    expectedScope:',
    expectedScope.toString(),
  );

  // ── 3. Persist deployment records ──────────────────────────────
  const now = new Date().toISOString();
  registry['SelfAttesterRegistry'] = {
    address: attesterRegistryAddress,
    txHash: attesterRegistryTx,
    deployedAt: now,
    deployer: wallet.address,
    owner: wallet.address,
    initialAttesters: [attesterAddress],
  };
  registry['NullifierRegistry'] = {
    address: nullifierRegistryAddress,
    txHash: nullifierRegistryTx,
    deployedAt: now,
    deployer: wallet.address,
    verifier: verifierAddress,
    attesterRegistry: attesterRegistryAddress,
    expectedScope: expectedScope.toString(),
    scopeString: scope,
    scopeEndpoint: COFFERDAM_ENDPOINT,
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('[deploy-v2-self] wrote:', registryPath);

  // ── 4. Re-print attester key as a tail reminder ────────────────
  // The authoritative print is at the top of the script (before
  // deploys, so a mid-script failure can't lose the key). This tail
  // reprint is a courtesy so the operator doesn't have to scroll up
  // through the verbose hardhat-zksync deploy chatter to find it.
  console.log('');
  console.log(
    '═══════════════════════════════════════════════════════════════════',
  );
  console.log(' REMINDER — attester key (already printed above):');
  console.log('   address: ' + attesterAddress);
  console.log('   privkey: ' + attesterPrivateKey);
  console.log(
    '═══════════════════════════════════════════════════════════════════',
  );
}
