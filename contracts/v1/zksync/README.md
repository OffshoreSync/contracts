# v1/zksync/ — ZKSync Era-side contracts

Destination chain for the LayerZero hybrid flow. This is where OffshoreSync's enterprise concerns live: identity bindings, job-contract escrow, proof-of-presence, payroll settlement, native paymaster.

## Planned contracts

### `OffshoreSyncReceiver.sol`

LayerZero V2 `OApp` receiver. Overrides `_lzReceive(Origin, bytes32, bytes, address, bytes)` to decode the cross-chain message from `OffshoreSyncCeloVerifier` and persist the `(account → nullifier)` binding.

Storage:

- `mapping(address => bytes32) accountToNullifier`
- `mapping(bytes32 => address) nullifierToAccount` (one-shot replay guard — once a nullifier is bound to an account, it can never be rebound)
- `mapping(address => uint256) verifiedAt` (block timestamp of the LZ message receipt — useful for `verifiedRecently()` policies)

Public read API:

- `isAccountBound(address) → bool`
- `isNullifierBound(bytes32) → bool`
- `verifiedAt(address) → uint256`

Events:

- `NullifierBound(address indexed account, bytes32 indexed nullifier, uint32 srcEid, uint256 timestamp)`

### `OffshoreSyncEscrow.sol`

Job-contract escrow. Recruiter locks the contract amount when posting/awarding a vacancy; worker checks in / out for proof-of-presence; on contract completion the funds auto-settle to the worker's verified address.

Identity gate: every write requires `OffshoreSyncReceiver.isAccountBound(msg.sender) == true`. This is the cryptographic mooring — no Self-verified passport → no on-chain employment relationship.

Surface (planned, refine in next session):

```
function postContract(JobTerms terms) external payable        // recruiter
function awardContract(uint256 contractId, address worker)    // recruiter
function checkIn(uint256 contractId)                          // worker
function checkOut(uint256 contractId)                         // worker
function dispute(uint256 contractId, string reason)           // either party
function settle(uint256 contractId)                           // anyone, after checkout
```

### `OffshoreSyncPaymaster.sol`

ZKSync Era native paymaster (implements `IPaymaster`). Sponsors gas for any tx whose sender is `OffshoreSyncReceiver.isAccountBound(sender) == true`. Verified workers pay zero gas — recruiters and OffshoreSync absorb the cost as a UX investment.

**Funding model:** the paymaster contract is owned by the **OffshoreSync LLC Treasury Safe** on ZKSync Era (one canonical Safe address shared across every OffshoreSync v1 contract on this chain — see the parent `contracts/README.md` *Ownership and treasury* section). The Cofferdam Partners-platform Treasury orchestrator (see `../../../../Cofferdam/README.md` §11.4) drafts USDC top-up transactions, sourced from the Stripe → Lili → Circle Mint → LLC Safe pipeline; the Safe signs and executes per the LLC's treasury maturity ladder. The contract exposes `topUp()` and `withdraw()` restricted to the Safe via `Ownable`. Per-account rate limits prevent abuse (e.g. max 50 sponsored tx / day / account).

## Build / deploy notes

- Compiles with **zksolc** (this is ZKSync Era, not standard EVM).
- LayerZero V2 contracts (`@layerzerolabs/oapp-evm`) must be zksolc-compatible. We'll verify in the next-session spike.
- Deploy script: `scripts/deploy-v1-zksync.ts` (planned). Reuses the existing `scripts/deploy-phase1.ts` structure but targets the new contracts.

## Dependencies (will be added next session)

- `@layerzerolabs/oapp-evm` — `OApp`, `Origin`, `MessagingFee`
- `@openzeppelin/contracts` — `Ownable`, `ReentrancyGuard`, `SafeERC20`

## Open items (next session)

1. Validate LZ V2 ZKSync Era endpoint address + zksolc compilation.
2. Implement `OffshoreSyncReceiver` + unit tests (mock LZ endpoint).
3. Implement `OffshoreSyncEscrow` skeleton + a happy-path unit test.
4. Implement `OffshoreSyncPaymaster` skeleton + a sponsored-tx unit test.
5. End-to-end smoke test: Celo Sepolia → ZKSync Era Sepolia, single nullifier binding round-trip.
