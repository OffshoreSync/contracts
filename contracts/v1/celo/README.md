# v1/celo/ — Celo-side contracts

> **Rev-6 status (2026-05-30) — deprecated, not refilled.** Production identity binding moved to **`v2/self/NullifierRegistry` on ZKSync Era** with a Cloudflare Container Self prover. The contracts in this directory remain deployed (and the Celo paymaster contract is retained for verifiability) but are **not part of the production traffic rotation** — the Celo paymaster is not refilled, and new attesters are not registered here. See `cofferdam-app/ARCHITECTURE.md` §10.2 + `ENTERPRISE_MODULE_PLAN.md` §13.3 + `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §3 for the current ingress.

Source chain for the legacy LayerZero hybrid flow (α-2 / α-3 era).

## Planned contracts

### `OffshoreSyncCeloVerifier.sol`

Extends `SelfVerificationRoot` (Self.xyz abstract base) **and** LayerZero V2's `OApp`. After Self's `IdentityVerificationHubImplV2` validates the user's Groth16 proof + policy on Celo, our overridden `customVerificationHook` fires. We:

1. Check `usedNullifier[nullifier]` (replay guard on Celo side).
2. Pack a minimal payload `(account, nullifier, configId, timestamp)` — **no PII** (no gender, no nationality, no DOB).
3. `_lzSend(ZKSyncEraEID, payload, options)` — LayerZero V2 DVN network relays the message.

The contract pre-funds itself with CELO for LZ messaging fees (~0.001-0.01 CELO/message). `receive() external payable {}` lets us top it up. `withdraw()` for the owner.

## Build / deploy notes

- Uses standard Solidity + `solc` (NOT zksolc — this is Celo).
- We'll probably set this up as a sibling Hardhat workspace (`contracts-celo/` or `apps/celo-contracts/`), separate from the ZKSync Era project, because the `solidity` compiler config is incompatible.
- Alternative: use Foundry, like Self's reference implementation (`selfxyz/self-layerzero-example`). Lighter weight for a single OApp contract. Decision deferred to next session.

## Dependencies (will be added next session)

- `@selfxyz/contracts` — provides `SelfVerificationRoot` abstract + `ISelfVerificationRoot`
- `@layerzerolabs/oapp-evm` — provides `OApp`, `OAppOptionsType3`, `OptionsBuilder`, `Origin`, `MessagingFee`
- `@openzeppelin/contracts` — `Ownable`
