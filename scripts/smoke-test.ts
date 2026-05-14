// Phase 0 — Smoke test: call `verifyProof(...)` with a well-formed but invalid
// proof and confirm the contract returns `false` cleanly (i.e. the BN254
// precompiles function under zksolc).
//
// A `false` return is the CORRECT outcome here. A revert with an out-of-gas
// or "invalid opcode" message would indicate that ZKSync Era's pairing
// precompile (0x08) is not behaving identically to Ethereum mainnet —
// in which case Phase 0 fails and we fall back to off-chain verification.
//
// Usage:
//   yarn smoke:self-verifier:sepolia

import { Provider, Wallet, Contract } from 'zksync-ethers';
import * as hre from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const networkAccounts = hre.network.config.accounts as string[] | undefined;
  const pk = process.env.DEPLOYER_PRIVATE_KEY || (Array.isArray(networkAccounts) ? networkAccounts[0] : undefined);
  if (!pk) {
    throw new Error(
      'No signer key available. Set DEPLOYER_PRIVATE_KEY in .env or configure ' +
        '`networks.<name>.accounts` for this network.',
    );
  }

  const networkName = hre.network.name;
  const deploymentsPath = path.join(__dirname, '..', 'deployments', `${networkName}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath}. Run deploy first.`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
  const verifierAddress = deployments.Verifier_vc_and_disclose?.address;
  if (!verifierAddress) throw new Error('Verifier_vc_and_disclose not in deployments');

  // Build provider/wallet from network config.
  const rpcUrl = (hre.network.config as any).url as string;
  const provider = new Provider(rpcUrl);
  const wallet = new Wallet(pk, provider);

  // Snarkjs Groth16 verifier ABI (only the function we need).
  // The disclose circuit has 21 public inputs (verified by inspecting the
  // generated contract's `calldataload` count). The smoke test just needs to
  // shape the inputs correctly; values are deliberately zeros so the proof
  // is invalid and the verifier must reject by returning `false`.
  const PUBLIC_INPUT_COUNT = 21;
  const abi = [
    `function verifyProof(uint[2] _pA, uint[2][2] _pB, uint[2] _pC, uint[${PUBLIC_INPUT_COUNT}] _pubSignals) public view returns (bool)`,
  ];
  const verifier = new Contract(verifierAddress, abi, wallet);

  const zeroPair: [bigint, bigint] = [0n, 0n];
  const zeroPairPair: [[bigint, bigint], [bigint, bigint]] = [zeroPair, zeroPair];
  const publicInputs: bigint[] = new Array(PUBLIC_INPUT_COUNT).fill(0n);

  console.log('[smoke] calling verifyProof(0,0,...) on', verifierAddress);
  console.log('[smoke] expected outcome: returns false (NOT revert)');

  try {
    const result: boolean = await verifier.verifyProof(
      zeroPair,
      zeroPairPair,
      zeroPair,
      publicInputs,
    );
    if (result === false) {
      console.log('[smoke] ✅ PASS — verifier returned false on zero proof.');
      console.log('[smoke]    BN254 precompiles appear to work under zksolc.');
      console.log('[smoke]    Phase 0 gate: GREEN.');
    } else {
      console.error('[smoke] ❌ UNEXPECTED — zero proof returned true. Aborting.');
      process.exit(2);
    }
  } catch (err: any) {
    console.error('[smoke] ❌ FAIL — verifier reverted instead of returning false.');
    console.error('[smoke]    Error:', err?.shortMessage || err?.message || err);
    console.error('[smoke]    This likely indicates a precompile / zksolc issue.');
    console.error('[smoke]    Falls back to off-chain verification (Path B).');
    process.exit(3);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
