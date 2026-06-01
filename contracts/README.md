# OffshoreSync — On-chain contracts

This directory holds Solidity contracts grouped by deployment vintage.

> **Rev-6 status (2026-05-30) — v1 vs v2 is now legacy vs production.** Until rev-6, this directory described "two complementary on-chain architectures" with v1 active and v2 parked. The rev-6 Cloudflare-native stack pivot **promoted v2 to production** and **demoted v1's LayerZero ingress to legacy** (contracts remain deployed, no new production traffic). The escrow contracts inside `v1/zksync/` (`OffshoreSyncEscrow`, the planned `OffshoreSyncRecurringEscrow`, `OffshoreSyncWitnessRegistry`) are **not** legacy — they consume the `IIdentityRegistry` interface and continue to work unchanged with either ingress. What changed is the *identity-binding source*, not the *settlement layer*. See `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` for the v2 production flow.

## Versioning model

We pursue **two complementary on-chain architectures** for Self.xyz-backed identity verification, separated here as `v1/` and `v2/`.

### `v1/` — α-2 ZKSync-native escrow + identity binding (shipped; identity ingress now legacy per rev-6)

**Status: α-2 shipped** on local `anvil-zksync`. ZKSync Era Sepolia deploy pending.

- **Identity binding** via `OffshoreSyncReceiver` — α-2 `Ownable` (simulates upstream delivery); α-3 LZ-OApp variant planned but **may be skipped** in favour of the v2 path (see below).
- **Settlement** via `OffshoreSyncEscrow` — native ETH, identity-gated, full state machine (post → award → checkIn → checkOut → settle, with cancel + dispute/resolve paths). **Two entry paths**: α-2 self-funded (`postContract`) for solo operators; α-3 corporate (`postContractIntent` + `fundContract`) for the enterprise HR ≠ Finance flow. 72 hardhat tests passing (51 α-2 + 21 α-3 corporate flow).
- **Verifier-agnostic** via `IIdentityRegistry` interface — α-2 Ownable receiver, α-3 LZ receiver, and v2 NullifierRegistry are all interchangeable from the escrow's perspective.

```
v1/zksync/    → IIdentityRegistry         (shared interface, era-portable)
                OffshoreSyncReceiver      (α-2 Ownable; simulates upstream binding)
                OffshoreSyncEscrow        (job-contract escrow, identity-gated)
                                          [+ paymaster deferred to α-3]
                                          [+ LZ-OApp variant α-3, may-skip]
v1/celo/      → OffshoreSyncCeloVerifier  (LZ-bridge source — pending deprecation
                                          decision; v2 may obviate)
```

See `v1/zksync/README.md` for full details. **Deployment target: ZKSync Era L2 only.** We evaluated and rejected building a Cofferdam-operated L3 on ZKSync OS — per [zkSync-Community-Hub discussion #778](https://github.com/zkSync-Community-Hub/zksync-developers/discussions/778), L3s are outside Matter Labs' current roadmap scope. Native AA + paymasters on Era L2 cover everything we need (sponsored gas, AA UX, native USDC) without us operating our own settlement layer.

**Reference-template positioning:** `OffshoreSyncEscrow` is OffshoreSync's first consumer-app contract, but it's intentionally designed as a reference pattern for any Cofferdam-integrated app. See `v1/zksync/README.md` § *Build your own consumer-app contracts* for the layering rules + PR workflow.

### `v2/` — Self-sovereign Self.xyz clone on ZKSync Era

**Status: on-chain side shipped (37 unit tests passing); off-chain TEE service pending.**

This is **Cofferdam's own implementation of Self.xyz's architecture**, deployed natively on ZKSync Era — not a contingent fallback. The architecture mirrors Self.xyz exactly: an off-chain TEE reads passport NFC and produces proof inputs; an off-chain attester signs an envelope with a key in an allow-list; the user holds the ZK proof and submits it on-chain; an on-chain Groth16 verifier checks the proof; a nullifier registry binds account ↔ nullifier. **Trust model is identical to using Self.xyz directly** — same ZK soundness, same chain finality, same TEE-key-custody assumption — just with Cofferdam in the operator role for the TEE and attester pieces (which Self.xyz also operates centrally; there's no decentralized TEE network at play in their stack either).

Strategic upside: **eliminates Celo as a verification source**, which removes the LayerZero hop from the verification path entirely. LZ is then retained only as an optional fiat on/off-ramp for countries needing MiniPay/Valora rails — not for identity.

Contents:

- `Verifier_vc_and_disclose.sol` — Self's own Groth16 verifier, forked, deployed to ZKSync Era Sepolia at `0xf23537eF06fC1283F5be80676418b71aEd81b7E5`.
- `self/SelfAttesterRegistry.sol` — Two-step-ownable allow-list of trusted attester ECDSA keys. **Cofferdam-controlled** in v2; our TEE service holds a key listed here.
- `self/NullifierRegistry.sol` — One-shot binding from a passport nullifier to an account, gated on Groth16 proof verification + attester signature. Fully wired and tested.
- `self/ISelfGroth16Verifier.sol`, `self/SelfPublicSignals.sol` — Interfaces.
- `self/mocks/MockSelfGroth16Verifier.sol` — Test fixture.

Remaining work (tracked in `TODO.md` under Phase α-3): off-chain **Cofferdam TEE service** (separate repo) — AWS Nitro Enclave initially, migration to Cloudflare Confidential Workers when GA. Signs `(account, pubSignals)` attestation envelopes with a key allow-listed in `SelfAttesterRegistry`.

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

The Safe's signer composition scales with org maturity — a phased treasury maturity ladder governs threshold and authorized signers from founder-hot-wallet today through institutional custody at maturity. The contract-owner *address* never changes from deployment onward; only the off-chain signer set behind that address evolves. Public outline of the ladder lives in `../../cofferdam-app/ARCHITECTURE.md` §11.2; private operational specifics (hardware picks, signer identities, caps, storage locations, recovery procedures) live in OffshoreSync LLC's internal treasury runbook at `../../financial/TREASURY.md` (outside any git repo).

Paymaster pools funded by this Safe receive their balance via the **Cofferdam Partners-platform Treasury orchestrator** (`../../cofferdam-app/ARCHITECTURE.md` §11.4), which converts Stripe revenue → Lili Finance bank deposit → Circle Mint USDC mint → LLC Safe → paymaster pool top-up in a four-step accountant-visible audit trail. No bridging vendor sits in this path: Circle Mint mints native USDC directly on both Celo (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`) and ZKSync Era (`0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4`).

This pattern decouples on-chain ownership identity (stable, immutable from the contracts' perspective) from off-chain key management (evolving with org maturity), and decouples both from the fiat revenue pipeline (regulated, accountant-visible).

## Test layout

Tests live in `contracts/test/` (one level up). Hardhat compiles all `.sol` under `contracts/` recursively, so the `v1/` ↔ `v2/` split has no compilation-time effect — it's purely organizational.

Existing tests for `v2/self/` artifacts (37 passing as of 2026-05-16) continue to run unchanged.
