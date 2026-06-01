# v1/ — LayerZero hybrid (Celo verification → ZKSync Era settlement)

> **Rev-6 status (2026-05-30) — superseded by v2.** This directory hosts the **legacy α-2 / α-3 LayerZero ingress**: Self.xyz verification on Celo → LayerZero V2 → `OffshoreSyncReceiver._lzReceive` on ZKSync Era. The contracts remain deployed for verifiability + audit-trail continuity. **Production identity binding is now single-chain on ZKSync Era via [`v2/self/NullifierRegistry`](../v2/self/NullifierRegistry.sol)**, attested by a Cloudflare Container Self prover (`cofferdam-prover`) + Cloudflare Worker (`cofferdam-attester`). The downstream `OffshoreSyncEscrow`, `OffshoreSyncWitnessRegistry`, and recurring-escrow contracts are unchanged — they consume `IIdentityRegistry`, which both v1 and v2 implement identically. See `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §3 + `cofferdam-app/ARCHITECTURE.md` §3.

**Status: legacy.** Originally targeted Phase 1 (Self.xyz / Celo bounty era); superseded by the rev-6 Cloudflare-native stack pivot.

## Architecture

```
┌────────────────────┐                        ┌────────────────────┐
│  Self App (mobile) │  scan passport         │  Cofferdam app     │
│  + TEE attest      │  ───────────────────▶  │  (RN companion)    │
└─────────┬──────────┘                        └─────────┬──────────┘
          │                                             │
          │ proof + userContextData                     │ deeplink handoff
          ▼                                             │
┌─────────────────────────┐                             │
│  Celo  (Self Hub)       │                             │
│  IdentityVerificationHubV2.verify()                   │
│       └─▶ OffshoreSyncCeloVerifier                    │
│              (SelfVerificationRoot + LZ OApp)         │
│              └─▶ customVerificationHook               │
│                     └─▶ _lzSend(ZKSync Era EID, …)    │
└─────────┬───────────────┘                             │
          │                                             │
          │  LayerZero V2 DVN network                   │
          │  (verifies + relays)                        │
          ▼                                             │
┌─────────────────────────┐                             │
│  ZKSync Era             │                             │
│  OffshoreSyncReceiver._lzReceive(…)                   │
│       └─▶ binds (account ↔ nullifier)                 │
│       └─▶ exposes isAccountBound() / nullifier lookup │
│                                                       │
│  OffshoreSyncEscrow (job contracts, milestones)       │
│  OffshoreSyncPaymaster (sponsors verified workers)    │ ◀───────┘
└─────────────────────────┘
```

## Layout

- `celo/` — source-side contracts (Celo Sepolia → Celo Mainnet)
  - `OffshoreSyncCeloVerifier.sol` *(planned)* — extends `SelfVerificationRoot` + `OApp`. After Self verifies, hooks `customVerificationHook` to `_lzSend` minimal payload `(account, nullifier, configId, timestamp)` to ZKSync Era.
- `zksync/` — destination-side contracts (ZKSync Era Sepolia → ZKSync Era Mainnet)
  - `OffshoreSyncReceiver.sol` *(planned)* — `OApp` receiver. Decodes the LZ message, persists `(account → nullifier)` binding, emits `NullifierBound` event for downstream consumers (escrow, paymaster, frontend).
  - `OffshoreSyncEscrow.sol` *(planned)* — Job-contract escrow. Recruiter locks payment; worker checks in / out; auto-settles to worker's address on completion. References `OffshoreSyncReceiver.isAccountBound(worker)` as identity gate.
  - `OffshoreSyncPaymaster.sol` *(planned)* — ZKSync Era native paymaster. Sponsors gas for any tx whose `from` address is bound in `OffshoreSyncReceiver`. Verified workers pay zero gas.

## What we don't deploy on ZKSync Era under v1

- No on-chain Groth16 verifier (Self does it on Celo)
- No attester allow-list (LZ DVN network handles cross-chain auth)
- No merkle tree mirroring (verification finalizes on Celo before LZ message is sent)

These live in `v2/` for the future native-deployment path.

## Trust model

The LZ DVN network is the cross-chain trust anchor. Default = 1 LZ DVN + 1 Executor; **for production we configure 2-of-3 DVNs minimum** for stronger guarantees. Worker identity is only as trustworthy as the DVN set — but Self's TEE + merkle-root checks have already happened upstream on Celo, so DVN compromise can only delay or reorder verifications, not fabricate them.

## Ownership

All four v1 contracts (one on Celo, three on ZKSync Era) are deployed via scripts that hand off ownership to the **OffshoreSync LLC Treasury Safe** as their final transaction — one Safe per chain, same canonical address used across every OffshoreSync contract on that chain. The deployer EOA is a transit role, not a custodial role; it never retains authority past the deployment block.

See `../README.md` *Ownership and treasury* for the per-contract owner table, the relationship to the Cofferdam Partners-platform Treasury orchestrator, and references to the OffshoreSync LLC treasury maturity ladder.

## Open items (next session)

1. Validate LayerZero V2 ZKSync Era endpoint addresses (mainnet EID 30165, Sepolia EID TBD).
2. Confirm zksolc compiles `@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol`.
3. Implement the four contracts above + matching unit tests.
4. End-to-end smoke test: Celo Sepolia → ZKSync Era Sepolia.
