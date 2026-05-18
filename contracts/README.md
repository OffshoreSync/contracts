# OffshoreSync — On-chain contracts

This directory holds Solidity contracts grouped by deployment vintage.

## Versioning model

We pursue **two complementary on-chain architectures** for Self.xyz-backed identity verification, separated here as `v1/` and `v2/`.

### `v1/` — LayerZero hybrid (Celo verification → ZKSync Era settlement)

**Status: active development.** This is what we ship for the Phase 1 milestone and for the Self.xyz / Celo bounty.

- **Verification on Celo** via Self.xyz's canonical `IdentityVerificationHubImplV2`. Inherits Self's full security model: TEE-attested registration, merkle root trust, OFAC + age + country policy.
- **Settlement on ZKSync Era** for OffshoreSync's enterprise concerns: contract escrow, proof-of-presence, payroll, audit trail, native paymaster (sponsored gas for verified workers).
- **Bridge** via LayerZero V2's OApp pattern. Self ships a reference implementation (`selfxyz/self-layerzero-example`); we adapt it for ZKSync Era as the destination chain.

```
v1/celo/      → OffshoreSyncCeloVerifier (extends SelfVerificationRoot + LZ OApp)
v1/zksync/    → OffshoreSyncReceiver     (LZ OApp, holds nullifier ↔ account bindings)
                OffshoreSyncEscrow       (job-contract escrow, references nullifier)
                OffshoreSyncPaymaster    (sponsors gas for verified workers)
```

### `v2/` — ZKSync-native Self deployment (preserved foundation)

**Status: contingent on Self.xyz prioritizing a ZKSync Era native deployment** of their full contract suite (`IdentityVerificationHubImplV2`, `IdentityRegistryImplV1`, all per-circuit Groth16 verifiers, TEE registration flow updates, mobile SDK chain-ID scoping). That's a 3-6 month project on Self's side; outside our control.

Until then, `v2/` preserves the on-chain Groth16 verification stack we built in Phase 0 + Phase 1 (first slice). It contains:

- `Verifier_vc_and_disclose.sol` — Self's own Groth16 verifier (forked, deployed to ZKSync Era Sepolia at `0xf23537eF06fC1283F5be80676418b71aEd81b7E5`). Proves BN254 precompiles work on ZKSync Era — useful as a builder-bounty contribution and as the foundation for v2 if Self ships natively.
- `self/SelfAttesterRegistry.sol` — Two-step-ownable allow-list of trusted attester ECDSA keys. 23 unit tests passing.
- `self/NullifierRegistry.sol` — One-shot binding from a Self nullifier to an account, with proof + attester-signature verification. 14 unit tests passing.
- `self/ISelfGroth16Verifier.sol`, `self/SelfPublicSignals.sol` — Interfaces.
- `self/mocks/MockSelfGroth16Verifier.sol` — Test fixture.

If Self ever exposes a primitive like *"TEE attests `(merkle_root, timestamp)` pairs"*, the `SelfAttesterRegistry` becomes useful immediately as the verification entry point. If they deploy their hub natively on ZKSync, the `Verifier_vc_and_disclose` becomes the on-chain proof verifier in our `_basicVerification` chain.

## Why two architectures?

The dual-chain split mirrors a fundamental product split in OffshoreSync:

| Concern | Chain | Why |
|---|---|---|
| **Enterprise / B2B** — identity binding, contract settlement, escrow, proof-of-presence, payroll, audit trail | ZKSync Era | Native AA + paymaster (sponsored gas, no UX friction). ZK-aligned, future-compatible with Self if they go ZKSync-native. |
| **Consumer / Retail** — USDC on/off-ramp, cross-border remittances, mobile money UX, fiat gateways | Celo | Best-in-class mobile money infrastructure (MiniPay, Valora, Mento). Native USDC. Self lives here today. |
| **Bridge** — Self attestations Celo→ZKSync; settled USDC ZKSync→Celo | LayerZero V2 | Decentralized DVN network. Reference implementation already exists from Self. |

This isn't a compromise — it's each chain doing what it's best at.

## Ownership and treasury

Every OffshoreSync contract deployed under `v1/` (and, if ever activated, the consumer-facing contracts in `v2/`) is owned by the **OffshoreSync LLC Treasury Safe** — one canonical Safe address per chain, shared across every OffshoreSync v1 contract on that chain. Deploy scripts call `transferOwnership(LLC_SAFE_ADDRESS_<chain>)` as their last step, so the deployer EOA never retains authority past the deployment transaction.

| Contract | Chain | Owner |
|---|---|---|
| `OffshoreSyncCeloVerifier` | Celo Mainnet | LLC Treasury Safe (Celo) |
| `OffshoreSyncReceiver` | ZKSync Era | LLC Treasury Safe (ZKSync Era) |
| `OffshoreSyncEscrow` | ZKSync Era | LLC Treasury Safe (ZKSync Era) |
| `OffshoreSyncPaymaster` | ZKSync Era | LLC Treasury Safe (ZKSync Era) |
| `OffshoreSyncAccountValidator` *(if added in v1)* | ZKSync Era | LLC Treasury Safe (ZKSync Era) |

The Safe's signer composition scales with org maturity — a phased treasury maturity ladder governs threshold and authorized signers from founder-hot-wallet today through institutional custody at maturity. The contract-owner *address* never changes from deployment onward; only the off-chain signer set behind that address evolves. Public outline of the ladder lives in `../../Cofferdam/README.md` §11.2; private operational specifics (hardware picks, signer identities, caps, storage locations, recovery procedures) live in OffshoreSync LLC's internal treasury runbook at `../../financial/TREASURY.md` (outside any git repo).

Paymaster pools funded by this Safe receive their balance via the **Cofferdam Partners-platform Treasury orchestrator** (`../../Cofferdam/README.md` §11.4), which converts Stripe revenue → Lili Finance bank deposit → Circle Mint USDC mint → LLC Safe → paymaster pool top-up in a four-step accountant-visible audit trail. No bridging vendor sits in this path: Circle Mint mints native USDC directly on both Celo (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`) and ZKSync Era (`0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4`).

This pattern decouples on-chain ownership identity (stable, immutable from the contracts' perspective) from off-chain key management (evolving with org maturity), and decouples both from the fiat revenue pipeline (regulated, accountant-visible).

## Test layout

Tests live in `contracts/test/` (one level up). Hardhat compiles all `.sol` under `contracts/` recursively, so the `v1/` ↔ `v2/` split has no compilation-time effect — it's purely organizational.

Existing tests for `v2/self/` artifacts (37 passing as of 2026-05-16) continue to run unchanged.
