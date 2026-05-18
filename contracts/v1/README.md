# v1/ — LayerZero hybrid (Celo verification → ZKSync Era settlement)

**Status: active development.** Target for Phase 1 milestone and the Self.xyz / Celo bounty.

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
