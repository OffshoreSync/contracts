# offshoresync-contracts

ZKSync Era contracts for the OffshoreSync Web3 conversion. See `../WEB3_CONVERSION.md` for the full architecture.

## Phase 0 — Self.xyz verifier compile/deploy spike

**Goal:** prove that Self.xyz's auto-generated Groth16 verifier compiles cleanly under `zksolc` and runs correctly on ZKSync Era Sepolia. This is the gate that decides whether on-chain identity verification is viable; everything else in `WEB3_CONVERSION.md` depends on it.

The contract under test is `contracts/self/Verifier_vc_and_disclose.sol`, fetched verbatim from [`selfxyz/self`](https://github.com/selfxyz/self/blob/main/contracts/contracts/verifiers/disclose/Verifier_vc_and_disclose.sol) (GPL-3.0 — snarkjs output, public domain math).

### Setup

```bash
yarn install
cp .env.example .env
# Fill in DEPLOYER_PRIVATE_KEY with a Sepolia EOA private key.
# Bridge a small amount of Sepolia ETH to ZKSync Era Sepolia via
#   https://portal.zksync.io/bridge/?network=sepolia
```

#### Vendor the compiler binaries

The current `@matterlabs/hardhat-zksync-solc@1.5.1` plugin's auto-downloader uses an `undici` API (`maxRedirections`) that was removed in `undici@6`, so the first compile crashes with `maxRedirections is not supported`. Until matter-labs ships a fix, vendor both binaries (`zksolc` itself and `zkvm-solc`, the matter-labs solc fork that zksolc ≥ 1.5.0 requires) manually.

**1. zksolc** — pointed at by `hardhat.config.ts`:

```bash
mkdir -p bin

# macOS Apple Silicon (M1/M2/M3/M4):
curl -L \
  https://github.com/matter-labs/era-compiler-solidity/releases/download/1.5.16/zksolc-macosx-arm64-v1.5.16 \
  -o bin/zksolc

# macOS Intel:
# curl -L https://github.com/matter-labs/era-compiler-solidity/releases/download/1.5.16/zksolc-macosx-amd64-v1.5.16 -o bin/zksolc

# Linux x86_64:
# curl -L https://github.com/matter-labs/era-compiler-solidity/releases/download/1.5.16/zksolc-linux-amd64-musl-v1.5.16 -o bin/zksolc

chmod +x bin/zksolc
./bin/zksolc --version   # should print 1.5.16
```

**2. zkvm-solc** — placed at the global hardhat cache path the plugin checks before downloading. The plugin auto-resolves the version tuple as `{solidity.version}-{latestEraVersion}` (currently `0.8.28-1.0.2`).

```bash
ZKVM_SOLC_DIR=~/Library/Caches/hardhat-nodejs/compilers-v2/zkvm-solc
mkdir -p "$ZKVM_SOLC_DIR"

# macOS Apple Silicon:
curl -L \
  https://github.com/matter-labs/era-solidity/releases/download/0.8.28-1.0.2/solc-macosx-arm64-0.8.28-1.0.2 \
  -o "$ZKVM_SOLC_DIR/zkvm-solc-v0.8.28-1.0.2"

# macOS Intel:
# curl -L https://github.com/matter-labs/era-solidity/releases/download/0.8.28-1.0.2/solc-macosx-amd64-0.8.28-1.0.2 -o "$ZKVM_SOLC_DIR/zkvm-solc-v0.8.28-1.0.2"

chmod +x "$ZKVM_SOLC_DIR/zkvm-solc-v0.8.28-1.0.2"
"$ZKVM_SOLC_DIR/zkvm-solc-v0.8.28-1.0.2" --version
```

**3. anvil-zksync** — local in-memory ZKSync Era node, used for fast iteration without a funded testnet wallet. Same downloader-bypass story.

```bash
# macOS Apple Silicon:
curl -L \
  https://github.com/matter-labs/anvil-zksync/releases/download/v0.6.11/anvil-zksync-v0.6.11-aarch64-apple-darwin.tar.gz \
  -o /tmp/anvil-zksync.tar.gz

# macOS Intel:
# curl -L https://github.com/matter-labs/anvil-zksync/releases/download/v0.6.11/anvil-zksync-v0.6.11-x86_64-apple-darwin.tar.gz -o /tmp/anvil-zksync.tar.gz

tar -xzf /tmp/anvil-zksync.tar.gz -C bin
chmod +x bin/anvil-zksync
./bin/anvil-zksync --version
```

### Run — local in-memory node (no faucet needed)

```bash
# Step 1 — Compile with zksolc.
yarn compile

# Step 2 — Launch local ZKSync Era node in a separate terminal (leave running).
yarn node:start
# Listens on http://127.0.0.1:8011, prefunds rich wallet 0x36615C...dc049 with 10000 ETH.

# Step 3 — Deploy the verifier to the local node.
yarn deploy:self-verifier:local

# Step 4 — Smoke test (calls verifyProof with a known-bad proof).
yarn smoke:self-verifier:local
```

### Run — ZKSync Era Sepolia (testnet)

Requires `DEPLOYER_PRIVATE_KEY` set in `.env` and that address funded on ZKSync Era Sepolia (faucet: https://faucet.chainstack.com/zksync-testnet-faucet ).

```bash
yarn deploy:self-verifier:sepolia
yarn smoke:self-verifier:sepolia
```

### Pass / fail criteria

| Step       | Pass                                               | Fail                                                                |
|------------|----------------------------------------------------|---------------------------------------------------------------------|
| `compile`  | `artifacts-zk/` populated, no zksolc errors        | zksolc error → Phase 0 gate **RED**, fall back to off-chain verify  |
| `deploy`   | Contract address logged + saved to `deployments/`  | Deploy revert → investigate (often L2 balance or RPC issue)         |
| `smoke`    | Verifier returns `false` cleanly                   | Revert / OOG → precompile incompatibility → gate **RED**             |

A `false` return on the smoke test is **the desired outcome**. The smoke test feeds a zero proof; correct behaviour is to reject it without reverting. A revert would mean the BN254 pairing precompile (0x08) isn't behaving identically to Ethereum mainnet under `zksolc` — at which point we ship the off-chain `snarkjs` verifier instead (the `IDENTITY_VERIFY_MODE=offchain` fallback in the plan).

### Phase 1+ contracts (placeholders, not yet written)

- `CofferdamAccountValidator.sol` — 3-passkey cap.
- `CofferdamPaymaster.sol` — gas sponsorship + rate limits.
- `SelfAttesterRegistry.sol` — TEE attester key allow-list.
- `NullifierRegistry.sol` — `verifyAndBind` + 1 passport ↔ 1 account.

These land once Phase 0 is green.
