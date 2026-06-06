# v1/zksync/ — ZKSync Era-side contracts

> **Rev-6 status (2026-05-30) — production ingress moved to v2.** The Receiver in this directory remains deployed and continues to work (it implements `IIdentityRegistry` like everything else), but **production identity binding now goes through `../../v2/self/NullifierRegistry`** with a Cloudflare Container Self prover. The α-3 LayerZero OApp variant (`CofferdamReceiverLZ`) is **deferred indefinitely** — the v2 path obsoletes it for production. The escrow + recurring-escrow + witness-registry contracts in this dir are unaffected (they consume `IIdentityRegistry`, which both v1 and v2 implement identically). See `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` for the production flow.

Destination chain for OffshoreSync's enterprise concerns: identity bindings, job-contract escrow, proof-of-presence, payroll settlement. **α-2 status: shipped** (Receiver + Escrow + IIdentityRegistry interface; tests + local deploy green).

## Architectural evolution (three eras, one interface)

The contracts in this directory are designed to be **verifier-agnostic**: the escrow (and any future paymaster / settlement / payroll contracts) depend only on the `IIdentityRegistry` interface, never on a concrete identity-source implementation. That lets us migrate the *source* of identity bindings without rewriting anything downstream.

| Era | Identity source | Auth on `bindNullifier` | Status |
|---|---|---|---|
| **α-2** | `CofferdamReceiver` (this dir) | `onlyOwner` — simulates upstream delivery | ✅ Shipped (now used only for local-dev / Sepolia smoke testing post rev-6) |
| **α-3** | `CofferdamReceiverLZ` (LayerZero V2 OApp variant) | `onlyLzEndpoint` — decoded inside `_lzReceive` | ❌ **Deferred indefinitely (rev-6)** — superseded by the v2 path; no longer planned for production |
| **v2 (production)** | [`v2/self/NullifierRegistry`](../../v2/self/NullifierRegistry.sol) | Groth16 proof + Cofferdam attester signature (cf. `SelfAttesterRegistry`) | ✅ On-chain side audited + ready; off-chain `cofferdam-prover` Cloudflare Container + `cofferdam-attester` Worker scheduled under T1.3 per `TODO.md` |

All three implement `IIdentityRegistry` and emit the same `NullifierBound(account, nullifier, ...)` event topic. Swapping eras is a deploy-config change in `scripts/deploy-v1-zksync.ts`, not a contract rewrite.

### Why this layering matters: the v2 architecture

**v2 is a self-sovereign clone of Self.xyz's full stack on ZKSync Era**, not a trust-downgraded shortcut:

| Layer | Self.xyz today | Cofferdam v2 |
|---|---|---|
| Off-chain TEE reads passport NFC, produces ZK proof inputs | Their TEE | Our TEE (Cloudflare Worker / AWS Nitro Enclave) |
| Off-chain attester signs `(inputs, nullifier)` with allow-listed key | Their attester | Our attester (key in `SelfAttesterRegistry`) |
| User holds ZK proof, submits on-chain | Same | Same |
| On-chain Groth16 verifier checks proof | Celo | **ZKSync Era** (our fork — already deployed) |
| On-chain nullifier registry binds account ↔ nullifier | Celo (their hub) | **ZKSync Era** (`v2/self/NullifierRegistry`) |

Trust-model parity with using Self.xyz directly (same ZK soundness, same chain finality, same TEE-key-custody assumption — just with us as the operator). Crucially: **eliminates Celo as a verification source**, which removes the LayerZero cross-chain hop from the verification path. LayerZero is then retained only for optional fiat on/off-ramp to Celo for countries that need MiniPay/Valora rails — not for identity.

### Deployment target: ZKSync Era L2 (not an L3)

Cofferdam's contracts target **ZKSync Era L2 directly**. We evaluated and rejected building a Cofferdam-operated L3 on ZKSync OS: per [zkSync-Community-Hub discussion #778](https://github.com/zkSync-Community-Hub/zksync-developers/discussions/778), L3 support is outside Matter Labs' current roadmap scope. Native AA + paymasters on Era L2 give us everything we need (sponsored gas, account-abstraction UX, native USDC) without the operational burden of running our own settlement layer.

Dev stack:

- **Local:** `anvil-zksync` (chain id 260) for tests and the SDK's `LocalChainProvider`.
- **Testnet:** ZKSync Era Sepolia (chain id 300).
- **Mainnet:** ZKSync Era (chain id 324) at Phase β.

Contracts are kept **chain-portable** (vanilla Solidity, no era-specific syscalls where avoidable) and the SDK takes `{rpcUrl, chainId, contracts}` as data so any future chain swap is a config change, not a rewrite.

### Reference-template positioning

`CofferdamSpotEscrow` is OffshoreSync's first consumer-app contract, but it's intentionally designed as a **reference pattern** for any Cofferdam-integrated app needing identity-gated, condition-based automatic payments. See [§ Build your own consumer-app contracts](#build-your-own-consumer-app-contracts) below.

## Implemented contracts (α-2)

### `IIdentityRegistry.sol`

Minimal cross-era identity interface. Three functions:

- `isAccountBound(address) → bool`
- `isNullifierBound(bytes32) → bool`
- `verifiedAt(address) → uint256`

Consumed by `CofferdamSpotEscrow` and any future identity-gated contract.

### `CofferdamReceiver.sol`

α-2 identity registry. `Ownable` with a two-step transfer pattern (`transferOwnership` → `acceptOwnership`) to prevent fat-finger handoff to a dead key. Owner calls `bindNullifier(account, nullifier)` to simulate the future LZ-delivered or TEE-attested bind.

**Storage:**

- `mapping(address => bytes32) accountToNullifier`
- `mapping(bytes32 => address) nullifierToAccount`
- `mapping(address => uint256) verifiedAt` (private, exposed via `verifiedAt()`)

**One-shot replay guard** in both directions: an account can never be re-bound to a different nullifier, and a nullifier can never be re-bound to a different account.

**Event:**

```solidity
event NullifierBound(
  address indexed account,
  bytes32 indexed nullifier,
  uint256 timestamp
);
```

Topic-stable across eras; α-3 and v2 implementations emit the same event (may append unindexed fields in future eras for context — `srcEid` in α-3, `attestationId` / `scope` in v2).

### `CofferdamSpotEscrow.sol`

Native-ETH job-contract escrow gated on `IIdentityRegistry.isAccountBound(msg.sender)`. **Two entry paths**, one shared lifecycle:

```
                         ┌── self-funded path ──┐
                         ▼                      │
   postContractIntent  Drafted ──fundContract──▶ Posted ──▶ Awarded ──▶ CheckedIn ──▶ CheckedOut ──▶ Settled
         │                │                       │             │            │             │
         │          cancelDraft                cancel           └────────────┴─────────────┴── dispute ──▶ Disputed ──▶ Resolved
         │                │                       │
         ▼                ▼                       ▼
    (id created)     Cancelled                Cancelled
                     (no funds                (refund → c.funder)
                      ever locked)
```

The **self-funded path** (`postContract`) is the α-2 single-tx flow for solo operators / small businesses where recruiter == funder. The **corporate path** (`postContractIntent` → `fundContract`) is the α-3 multi-party flow modelling real enterprises where HR ≠ Finance. Both paths converge at `Posted`; everything after that is identical.

**Public surface:**

```solidity
// Entry — self-funded (α-2):
postContract(bytes32 termsHash) external payable returns (uint256)              // recruiter+funder

// Entry — corporate (α-3):
postContractIntent(bytes32 termsHash, uint256 amount, address designatedFunder) // recruiter only
       external returns (uint256)
fundContract(uint256 contractId) external payable                                // designatedFunder
cancelDraft(uint256 contractId)                                                  // recruiter, Drafted-only

// Shared lifecycle:
awardContract(uint256 id, address worker)                                        // recruiter
checkIn(uint256 id)                                                              // worker
checkOut(uint256 id)                                                             // worker
settle(uint256 id)                                                               // anyone (keeper/relayer-friendly)
cancel(uint256 id)                                                               // recruiter, Posted-only — refunds c.funder
dispute(uint256 id, string reason)                                               // either party
resolveDispute(uint256 id, address payee)                                        // owner (LLC Safe) — payee = funder|worker
```

**Identity-gate exemption for `settle()`** — public on purpose so workers don't need ETH for gas (keeper or paymaster pays). All other write paths (including `fundContract`) require Cofferdam identity.

**Refund routing.** `cancel()` and `resolveDispute(payee=funder-side)` pay `c.funder`, not `c.recruiter`. For self-funded contracts `funder == recruiter`, so α-2 behaviour is preserved without any caller changes.

**Designated funder.** `postContractIntent` takes a `designatedFunder` address:

- Non-zero: only that address can call `fundContract` — pinned to a specific Finance account.
- `address(0)` ("open funding"): any Cofferdam-bound account can fund — useful when the recruiter wants to leave the door open for any of N Finance people.

**Off-chain coordination.** The recruiter ↔ funder handoff ("hey Maria from Finance, can you sign the funding?") happens off-chain via the Cofferdam SDK's messaging primitive + push notifications. The chain just sees addresses. See `cofferdam-sdk/README.md` for the UX flow.

**Off-chain terms.** Only the `keccak256(canonical-terms-blob)` is committed on-chain. Auditors verify off-chain that recruiter and worker agreed to the same terms by recomputing the hash.

**ERC-20 / USDC support is β-blocking** (not just deferred). Production corporate treasuries hold USDC sourced via Circle Mint, not ETH; without it no company can use the corporate path in production. Native ETH is sufficient for α-2 / α-3 local + testnet PoCs.

### Deferred from α-2 v1 scope

- **`CofferdamPaymaster.sol`** — moved to α-3. The paymaster needs a real user-traffic shape to design rate limits and per-callsite policies; building it before the SDK exercises real flows is premature optimization. When built, it's a vanilla `IPaymaster` implementation (not a `zksync-sso` fork — we evaluated and rejected; see `TODO.md`).
- **LayerZero V2 wiring** — moved to α-3 as `CofferdamReceiverLZ` (separate contract, same storage layout). May be deprecated entirely in favour of the v2 TEE path; final decision pending v2 TEE service prototype.
- **`CofferdamRotationEscrow.sol`** — β-scope sibling of `CofferdamSpotEscrow` covering archetypes the current escrow doesn't fit: rotation+monthly, rotation+per-rotation, fixed-term/permanent salaried, day-rate spot. The current escrow models **~20–25% of the OffshoreSync Jobs API vacancy taxonomy** (single-settlement fixed-task only); the recurring escrow lifts coverage to ~100%. Full spec, real-maritime payment-pattern analysis, contract sketch, SDK routing plan, and open questions in [`RECURRING_ESCROW_DESIGN.md`](./RECURRING_ESCROW_DESIGN.md). Implementation pending β audit cycle.

## Build / deploy

Compiles with `zksolc` 1.5.16. The `inMemoryNode` hardhat network points at a local `anvil-zksync`.

```bash
yarn compile                       # compile all contracts (v1 + v2)
yarn node:start                    # in another terminal — leave running
yarn test                          # 109 tests (51 α-2 + 21 α-3 corporate flow + 37 v2/self)
yarn deploy:v1-zksync:local        # deploy Receiver + Escrow to anvil-zksync
yarn deploy:v1-zksync:sepolia      # deploy to ZKSync Era Sepolia (needs funded key)
```

The deploy script:

1. Picks the local rich wallet for `inMemoryNode`, env `DEPLOYER_PRIVATE_KEY` for testnets/mainnet.
2. Deploys `CofferdamReceiver(initialOwner = deployer)`.
3. Deploys `CofferdamSpotEscrow(identity = receiver, initialOwner = deployer)`.
4. Writes `{receiver, escrow}` addresses to `contracts/deployments/<network>.json` — picked up by the `cofferdam-sdk` `LocalChainProvider` integration tests and consumer-app env files.

**Production ownership hand-off** is a manual step *after* the deploy script, not baked in: `transferOwnership(LLC_SAFE_ADDRESS_ZKSYNC)` from each contract, then the Safe signs `acceptOwnership()`. The two-step transfer prevents handing off to a dead key.

## Dependencies

Intentionally **none beyond Solidity + zksolc**. The codebase convention (cf. `v2/self/SelfAttesterRegistry`) is inlined minimal primitives (`Ownable` + `ReentrancyGuard`) rather than OpenZeppelin imports — keeps audit surface small and zksolc-compile times predictable.

Added only when needed:

- **α-3:** `@layerzerolabs/oapp-evm` for the LZ-OApp variant (validate zksolc compatibility first).
- **α-3:** `SafeERC20` if/when USDC support lands (inline pattern, not OZ).

## Build your own consumer-app contracts

`CofferdamSpotEscrow` is the **first** Cofferdam consumer-app contract — not the only one. Any app that needs identity-gated automatic payments triggered by app-specific conditions can fork this pattern. Examples:

- **Freelance / gig** — checkpoint-based milestone releases (`milestoneCompleted(uint256 id, uint256 idx)` → settle).
- **SaaS / subscription** — recurring authorized debits with cancel-anytime semantics.
- **Rental / equipment hire** — check-in / check-out for proof-of-use, time-prorated settlement.
- **Marketplace / escrow-as-a-service** — buyer-seller dispute resolution with Cofferdam-attested identities on both sides.

What you reuse unchanged:

| Layer | Where | Reuse policy |
|---|---|---|
| `v2/self/NullifierRegistry` | `contracts/v2/self/` | **Shared** — every Cofferdam app reads from the same registry. Same passport ↔ account binding works across all consumer apps. |
| `v2/self/SelfAttesterRegistry` | `contracts/v2/self/` | **Shared** — Cofferdam-controlled allow-list of TEE attesters. Updates apply to all consumers atomically. |
| `v2/self/Verifier_vc_and_disclose` | `contracts/v2/` | **Shared** — same Groth16 verifier serves all consumers. |
| `IIdentityRegistry` | `v1/zksync/IIdentityRegistry.sol` | **Interface contract** — your escrow depends on this, not on a concrete implementation. |

What you write yourself:

```solidity
// contracts/v1/<your-app>/<YourApp>Escrow.sol
contract YourAppEscrow {
    IIdentityRegistry public immutable identity;

    modifier onlyVerified() {
        require(identity.isAccountBound(msg.sender), "not verified");
        _;
    }

    // Your state machine + conditions go here.
    function startThing(...) external payable onlyVerified { ... }
    function endThing(...) external onlyVerified { ... }
    function settle(uint256 id) external { ... }
}
```

### Contribution workflow

Two options for getting your contracts into the Cofferdam ecosystem:

1. **PR to this repo** (`contracts/contracts/v1/<your-app>/`). We review for: (a) the contract only reads from `IIdentityRegistry` (never bypasses), (b) `Ownable` transferred to a known multisig at deploy time, (c) tests against `anvil-zksync` covering the state machine + identity-gate negative paths. On merge, we maintain it alongside `v1/zksync/`.
2. **External repo** referencing `@offshoresync/contracts` (TBD npm publish; α-3 work) for the `IIdentityRegistry` interface. You retain governance; users still get the same Cofferdam identity layer.

`CofferdamSpotEscrow` is the canonical PR template: read it as "the worked example" before opening yours.

## Open items

1. **α-3 LZ-OApp variant.** Validate `@layerzerolabs/oapp-evm` zksolc compatibility, then implement `CofferdamReceiverLZ` mirroring α-2 storage. May be skipped entirely if the v2 TEE path obviates Celo verification.
2. **Cofferdam TEE service** (separate repo). Off-chain Nitro Enclave / Cloudflare Worker that reads passport NFC, generates Self.xyz-shaped proof inputs, signs the attestation envelope with a key listed in `v2/self/SelfAttesterRegistry`. This is the v2 unlock; the on-chain side (`v2/self/NullifierRegistry`) is already shipped.
3. **Paymaster (α-3).** Vanilla `IPaymaster` implementation gated on `isAccountBound`. Per-account rate limits, per-callsite policies, billing event log for Cofferdam reconciliation.
4. **ZKSync Era Sepolia deploy** of the α-2 Receiver + Escrow for an end-to-end SDK-on-testnet demo (a step beyond the current local-only PoC).
5. **Publish `@offshoresync/contracts`** (npm) with just the `IIdentityRegistry` interface + ABIs, to support external-repo consumer-app contributions per the workflow above.
6. **AA account contract — rev-7.1 authority-module model + `recoverWithSelf`.** The smart account that holds the worker's funds is, in rev-7.1, a multi-authority account: it can carry a `PolisSessionAuthority` (Polis SSO ID-token validator, installed when a worker is onboarded enterprise-side via `enterprise.offshoresync.com`), a `SelfNullifierAuthority` (sovereign Self.xyz validator), and/or a P-256 passkey validator — composed with OR semantics. This generalises the passkey-only stub sketched in `../../../WEB3_CONVERSION.md` §3.1 (`CofferdamAccountValidator.sol`). Method surface to implement:
   - `addAuthority(...)` — add a module (e.g. a worker still under active SSO binding Self adds `SelfNullifierAuthority` alongside the retained `PolisSessionAuthority`). Happy path; see `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §3.10 E7.
   - `removeAuthority(...)` — drop a module.
   - **`recoverWithSelf(RecoverParams)`** — the post-employment escape hatch. Callable with **no existing authority signature**; authorised by (a) a fresh Groth16 Self proof, (b) a Cofferdam attester signature that *vouches for the off-chain human-match* (Self disclosure ↔ former-employer HR record — same trust class as the bind attester, NOT a cryptographic re-derivation), and (c) a Merkle inclusion proof of the dormant `companyBoundPseudonym` leaf against a historical `CofferdamCorporateRegistry` OrgRoot. Atomically replaces the account's authority set with a single `SelfNullifierAuthority` and binds the nullifier in `v2/self/NullifierRegistry` in the same tx. **Authoritative method-level spec (struct, four on-chain checks, events, idempotency, paymaster + anti-abuse policy, and the honest trust-model framing for the human-match) lives in `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §3.11.5** — implement against that. Enterprise context + org-tree mechanics in `ENTERPRISE_MODULE_PLAN.md` §3.3 (two-tier identity binding) + §6.B (`CofferdamCorporateRegistry` historical roots). Not yet implemented; β-scope alongside the enterprise contracts.
