# OffshoreSync — Web3 Conversion Plan

> ZKSync Era account abstraction (passkey login + paymaster) for the enterprise/B2B layer (jobs, escrow, payroll, audit trail). Self.xyz NFC-passport ZK identity proofs verified on Celo (Self's canonical chain) and **mirrored to ZKSync Era via LayerZero V2**. Celo doubles as the consumer/retail layer for USDC on/off-ramp and cross-border remittances. Companion app (Cofferdam) holds the Web3 surface; main OffshoreSync app stays open + non-Web3.

This document is the consolidated, authoritative spec for the Web3 conversion. It supersedes the two staging plans under `~/.windsurf/plans/`. Read it top-to-bottom before opening a PR against any of the layers below.

**Architecture evolution log:**
- *2026-05-14*: Phase 0 first gate GREEN — Self's Groth16 verifier compiles + deploys on ZKSync Era under zksolc. Native-ZKSync verification confirmed feasible.
- *2026-05-16*: Phase 1 first slice GREEN — `SelfAttesterRegistry` + `NullifierRegistry` shipped with 37 passing unit tests + local deploy. Architectural review uncovered: (a) Self's actual trust root is merkle-root-based, not attester-sig-based; (b) Self ships a LayerZero V2 reference implementation (`selfxyz/self-layerzero-example`) explicitly for non-Celo destination chains; (c) Celo's mobile-money infrastructure is a strategic fit for the consumer/fintech layer.
- *2026-05-17*: **Pivoted to hybrid Celo+ZKSync architecture.** Phase 1 contracts moved to `contracts/v2/self/` as preserved foundation for a future ZKSync-native Self deployment (contingent on Self's roadmap, 3-6 months Self-side). Phase 1 active dev targets `contracts/v1/` (Celo source + ZKSync receiver via LayerZero V2).

---

## 0. TL;DR

- **Auth**: Passkey + ZKSync smart account becomes the **primary** login. Google / Apple / local password coexist during a transition window, then sunset.
- **Sybil resistance**: Self.xyz passport ZK proof is **mandatory before sensitive actions** (post, comment, apply, recruiter publish, message a stranger). One passport ↔ one smart account, enforced on-chain via a nullifier registry.
- **Devices**: ≤ **3 passkeys per account**, enforced by a custom on-chain validator. Add / revoke flows ship on day one.
- **Gas**: OffshoreSync **paymaster sponsors every user tx** on ZKSync Era (account deploy, passkey ops, escrow, check-in/out, future on-chain features) within per-account rate limits.
- **Proof verification (v1, active)**: Self.xyz's `IdentityVerificationHubImplV2` on Celo validates the Groth16 proof + policy (OFAC, age, country). On success, our `OffshoreSyncCeloVerifier` (extends `SelfVerificationRoot` + LayerZero `OApp`) fires `_lzSend` with a minimal `(account, nullifier, configId, timestamp)` payload to ZKSync Era. `OffshoreSyncReceiver` on ZKSync Era receives via `_lzReceive` and persists the `(account ↔ nullifier)` binding. Inherits Self's full security model for free.
- **Dual-chain split**: **ZKSync Era = enterprise/B2B** (identity binding, contract escrow, proof-of-presence, payroll, audit trail, native AA + paymaster). **Celo = consumer/retail fintech** (USDC on/off-ramp, cross-border remittances via MiniPay / Valora / Mento, mobile money UX in emerging markets). LayerZero V2 is the bridge in both directions: Self attestations Celo→ZKSync; settled USDC ZKSync→Celo.
- **Companion app**: A separate React Native app branded **Cofferdam** (`cofferdam.xyz`) holds the Web3 surface (wallet, passkey mgmt, passport scan, escrow signing, on/off-ramp). The main OffshoreSync app stays Capacitor + remains open + non-Web3 for the social-networking experience. Cofferdam is open-source and pitched as a maritime-industry RWA wallet with an SDK other apps can integrate. Decision pending final polish; scope outline only in §4.5.
- **Proof generation**: Self's TEE (Trusted Execution Environment) — same path their production app uses for real and mock passports. The phone encrypts circuit inputs and ships them to Self's WebSocket relayer; the TEE generates the Groth16 proof + signs an attestation that the inputs came from an authentic NFC scan. **Raw passport data never leaves the device unencrypted.** Free during Self's growth phase; pricing/SLA TBD long-term.
- **Versioning**:
  - `contracts/v1/` — **active dev**. LayerZero hybrid (Celo source + ZKSync receiver). Target for Phase 1 milestone and the Self + Celo bounties.
  - `contracts/v2/` — **parked, preserved**. ZKSync-native Self deployment (37 passing unit tests, deployed verifier on ZKSync Era Sepolia). Contingent on Self.xyz deploying their full contract suite on ZKSync Era natively — 3-6 month roadmap item on their side.
- **Estimated effort**: ~8-9 weeks across 5 phases (revised down from 9-10 — LayerZero V2 removes the need for our own attester sig + merkle root mirroring on ZKSync).
- **Phase 0 status (2026-05-14)**: ✅ first gate GREEN — Self's `Verifier_vc_and_disclose` compiles + deploys on ZKSync Era Sepolia (`0xf23537eF06fC1283F5be80676418b71aEd81b7E5`). Preserved in `v2/` as foundation for future native deployment.
- **Phase 1 first slice status (2026-05-16)**: ✅ `SelfAttesterRegistry` + `NullifierRegistry` shipped with 37 passing unit tests + local deploy script (`yarn deploy:phase1:local`). **Moved to `v2/` after architectural review on 2026-05-17.**
- **Phase 1 second slice status (current)**: 🔄 hybrid pivot in progress. `contracts/v1/{celo,zksync}/` scaffolded with READMEs. Next: validate LayerZero V2 on ZKSync Era, implement `OffshoreSyncCeloVerifier` + `OffshoreSyncReceiver` + `OffshoreSyncEscrow` + `OffshoreSyncPaymaster`.

---

## 1. Locked product decisions

| Decision | Outcome |
|----------|---------|
| Smart account role | **Auth replacement** — passkey login is primary, JWT issuance is gated by passkey signature. |
| Passport proof | **Mandatory before sensitive actions** (not at signup). Verified badge on profile once proven. |
| Self.xyz integration | **Consume Self's deployed contracts on Celo via `SelfVerificationRoot` abstract base** (their canonical integration pattern, used in `selfxyz/self-layerzero-example`). Mobile UX wraps `@selfxyz/mobile-sdk-alpha`. |
| Legacy auth | **Coexist for a transition window** (Google / Apple / local password kept for ~2 releases). |
| Passkey cap | **3 per account, enforced on-chain** by `OffshoreSyncAccountValidator` on ZKSync Era. |
| Paymaster scope | **Full sponsorship** of all user txs on ZKSync Era. The paymaster contract is owned by the **OffshoreSync LLC Treasury Safe**; top-ups flow from Stripe → Lili Finance → Circle Mint → LLC Safe → paymaster pool (four-step audit trail, see `../Cofferdam/README.md` §11.4). |
| Verifier location (v1) | **Off our chain.** Self's `IdentityVerificationHubImplV2` on Celo validates the proof + policy. We consume the result via LayerZero V2 OApp messaging. |
| Verifier location (v2, future) | On-chain on ZKSync Era. Foundation preserved in `contracts/v2/self/`; activated if Self ever ships native ZKSync Era deployment. |
| Cross-chain transport | **LayerZero V2.** Default DVN config on testnet; production minimum 2-of-3 DVNs. |
| Companion app shape | **TBD.** RN companion (`Cofferdam`, `cofferdam.xyz`) is the leading proposal; final scope deferred. Capacitor extension of main app is the fallback. |
| Fintech expansion | **Celo = on/off-ramp + remittance layer.** ZKSync Era = enterprise/audit layer. Bridge via LayerZero V2. |

---

## 2. High-level architecture (v1, hybrid Celo + ZKSync via LayerZero V2)

```
┌──────────── Cofferdam companion app (RN, iOS / Android) ─────────────┐
│  (open-source maritime Web3 wallet; deep-links from OffshoreSync     │
│   for any flow that needs verified identity)                         │
│                                                                       │
│  AuthContext  ──►  zksyncSsoService  ──► passkey                     │
│                       │                  (Secure Enclave /            │
│                       │                   StrongBox)                  │
│                       └─► AccountClient.sendTransaction ──┐           │
│                                                            │          │
│  identityService  ──►  @selfxyz/mobile-sdk-alpha           │          │
│                          ├─ NFC scan (ICAO 9303)           │          │
│                          ├─ Crypto / DSC parse             │          │
│                          └─ TEE relay client (WS, AES-GCM) │          │
│                                  │                         │          │
│                                  ▼                         │          │
│              Self.xyz TEE backend (Groth16 prover +        │          │
│              attester signature). Returns proof to phone.  │          │
│                                                            │          │
│  paymasterClient ──► sponsorship sig fetch ────────────────┘          │
└───────────┬───────────────────────────────────────────────────────────┘
            │                                                       │
            │ submit proof + userContextData                        │
            ▼                                                       │
┌─────────────────── Celo (verification chain) ───────────────────┐  │
│  Self IdentityVerificationHubImplV2.verify()                     │  │
│       └─▶ OffshoreSyncCeloVerifier (v1/celo/)                    │  │
│              (extends SelfVerificationRoot + LayerZero OApp)     │  │
│              └─▶ customVerificationHook                          │  │
│                     └─▶ _lzSend(ZKSync Era EID, payload, …)      │  │
│                                                                  │  │
│  Consumer-layer (USDC, MiniPay, Mento, Valora) — out of contract │  │
│  scope here; the worker's Celo address receives funds via the    │  │
│  ZKSync → Celo settlement bridge (also LZ V2 OApp, future work). │  │
└─────────────────────────────┬────────────────────────────────────┘  │
                              │                                       │
                              │ LayerZero V2 DVN network               │
                              │ (validates + relays)                   │
                              ▼                                       │
┌──────────────────── ZKSync Era (enterprise chain) ───────────────┐  │
│  OffshoreSyncReceiver (v1/zksync/)                                │  │
│       └─▶ _lzReceive → binds (account ↔ nullifier)                │  │
│       └─▶ exposes isAccountBound() / nullifier reads              │  │
│                                                                   │  │
│  ZKSync SSO account factory (stock) + native AA                   │  │
│  OffshoreSyncAccountValidator  (3-passkey cap)                    │  │
│  OffshoreSyncPaymaster         (sponsorship + rate limits)        │ ◀┘
│                                  └─ gates on isAccountBound()       │
│  OffshoreSyncEscrow            (job contracts, milestones,          │
│                                  proof-of-presence check-in/out)    │
└───────────────────────────────────────────────────────────────────┬─┘
                                                                    │
                            ▼                                       │
┌─────────────── Express server (react-server) ────────────────────┘
│  Auth                                                              │
│    POST /api/auth/passkey-challenge                                │
│    POST /api/auth/passkey-verify                                   │
│  Wallet                                                            │
│    POST /api/wallet/account     GET    /api/wallet/passkeys        │
│    DELETE /api/wallet/passkeys/:id                                 │
│  Identity                                                          │
│    POST /api/identity/notify    (UX nudge after LZ delivery)       │
│    GET  /api/identity/qr-handoff/:sessionId  (web → Cofferdam)     │
│    POST /api/identity/qr-handoff/:sessionId                        │
│  Paymaster policy service (rate-limit per account)                 │
│  Chain indexer (Celo: VerificationConsumed; ZKSync: NullifierBound,│
│                 Passkey events; LZ: MessageDelivered)              │
└────────────────────────────────────────────────────────────────────┘
```

## 2.5. Dual-chain financial architecture rationale

The dual-chain split is **not a compromise** — it's each chain doing what it's structurally best at.

| Layer | Chain | Functions | Why |
|---|---|---|---|
| **Enterprise / B2B** | ZKSync Era | Identity binding (Self nullifier), contract settlement, escrow, proof-of-presence check-in/out, payroll, audit trail. | Native AA + paymaster → sponsored gas for verified workers; ZK-aligned with Self if they ever go ZKSync-native. Future-compatible with v2. |
| **Consumer / Retail** | Celo | USDC on/off-ramp, cross-border remittances, mobile money UX, fiat gateways (Mento for cUSD ↔ fiat, MiniPay via Opera, Valora). | Best-in-class mobile money infrastructure in emerging markets. Native USDC (Circle deployed Q4 2024). Self.xyz lives here today. |
| **Bridge** | LayerZero V2 | Self attestations Celo→ZKSync (one-time per worker); settled USDC ZKSync→Celo (per payout). | Decentralized DVN network. Reference implementation exists from Self. Audited deploys on both chains. |

### Concrete user flow (post-launch)

1. **Onboarding** — Worker downloads Cofferdam, creates passkey (Secure Enclave / StrongBox), passport scan via Self mobile SDK, proof generated in Self TEE, submitted to OffshoreSyncCeloVerifier on Celo. LZ V2 relays attestation to ZKSync Era OffshoreSyncReceiver (~30-45s end-to-end).
2. **Job acceptance** — Recruiter posts vacancy via main OffshoreSync app (Capacitor, no Web3). Worker applies. On match: recruiter locks payment in OffshoreSyncEscrow on ZKSync Era (paymaster-sponsored).
3. **Work period** — Worker checks in via Cofferdam (proof-of-presence on ZKSync, sponsored). Worker works according to contract. Worker checks out.
4. **Settlement** — OffshoreSyncEscrow auto-releases payment in USDC to worker's ZKSync address.
5. **Off-ramp** — Worker initiates ZKSync→Celo bridge in Cofferdam (LZ V2). Funds arrive on Celo as native USDC.
6. **Family transfer / fiat** — Worker uses MiniPay / Valora / direct send to family wallet on Celo. Family off-ramps via Mento to local fiat.

High-stakes data (employment relationship, work history, audit trail) stays on ZKSync Era — sharp, auditable, enterprise-grade. Low-stakes data (consumer payments, remittances) flows through Celo — mobile-native, cheap, plugged into emerging-market fiat rails.

Neither chain is replaceable in this architecture. ZKSync Era can't (today) do mobile-money UX at Celo's quality. Celo's account model + ecosystem doesn't fit enterprise auditing as cleanly as ZKSync's AA + paymaster + native USDC.

---

## 3. Smart contract layer

Repo: `contracts/` at workspace root. Two parallel workspaces (Hardhat for ZKSync Era + Hardhat/Foundry for Celo — final tooling for Celo TBD next session). Top-level layout: `contracts/contracts/v1/{celo,zksync}/` (active) + `contracts/contracts/v2/self/` (preserved foundation). See `contracts/contracts/README.md` for the canonical structure description.

### 3.1 v1/ — LayerZero hybrid contracts (active dev)

#### `v1/celo/OffshoreSyncCeloVerifier.sol`

Extends both `SelfVerificationRoot` (from `@selfxyz/contracts`) and LayerZero V2's `OApp`. After Self's `IdentityVerificationHubImplV2` validates the user's Groth16 proof + policy on Celo, our overridden `customVerificationHook` fires. We:

1. Check `usedNullifier[nullifier]` (replay guard on Celo side).
2. Pack a minimal payload `(account, nullifier, configId, timestamp)` — **no PII** (no gender, no nationality, no DOB).
3. `_lzSend(ZKSyncEraEID, payload, options)` to ZKSync Era.

Pre-funded with CELO for LZ messaging fees (~0.001-0.01 CELO/message). `receive() external payable {}` for top-ups. `withdraw()` for owner. **Compiles with `solc`, not `zksolc`** — deployed to Celo.

#### `v1/zksync/OffshoreSyncReceiver.sol`

LayerZero V2 `OApp` receiver. Overrides `_lzReceive(Origin, bytes32, bytes, address, bytes)` to decode the cross-chain message from `OffshoreSyncCeloVerifier` and persist the `(account ↔ nullifier)` binding.

Storage:
- `mapping(address => bytes32) accountToNullifier`
- `mapping(bytes32 => address) nullifierToAccount` (one-shot replay guard)
- `mapping(address => uint256) verifiedAt`

Public read API: `isAccountBound(address) → bool`, `isNullifierBound(bytes32) → bool`, `verifiedAt(address) → uint256`.

Events: `NullifierBound(address indexed account, bytes32 indexed nullifier, uint32 srcEid, uint256 timestamp)`.

#### `v1/zksync/OffshoreSyncEscrow.sol`

Job-contract escrow + proof-of-presence. Recruiter locks payment; worker checks in / out; on completion the funds auto-settle to worker's verified address.

Identity gate: every write requires `OffshoreSyncReceiver.isAccountBound(msg.sender) == true`. No Self-verified passport → no on-chain employment relationship.

Surface (refine in next session):

```solidity
function postContract(JobTerms terms) external payable        // recruiter
function awardContract(uint256 contractId, address worker)    // recruiter
function checkIn(uint256 contractId)                          // worker
function checkOut(uint256 contractId)                         // worker
function dispute(uint256 contractId, string reason)           // either party
function settle(uint256 contractId)                           // anyone, after checkout
```

#### `v1/zksync/OffshoreSyncAccountValidator.sol`

Extends ZKSync SSO's stock passkey validator.
- Enforces `passkeys.length <= 3`.
- `addPasskey(bytes32 credentialId, bytes pubKey, string label)`
- `revokePasskey(bytes32 credentialId)`
- `getPasskeys() view returns (Passkey[] memory)`
- Emits `PasskeyAdded` / `PasskeyRevoked` for off-chain indexing.

#### `v1/zksync/OffshoreSyncPaymaster.sol`

`IPaymaster` implementation.
- Sponsors txs only when:
  - `from` is a known OffshoreSync account (deployed via our factory path).
  - The userOp is signed by a currently-registered passkey on that account.
  - Sender is bound in `OffshoreSyncReceiver.isAccountBound(from) == true`.
  - Selector is in the sponsorship whitelist.
  - Per-account, per-IP, per-selector rate limits are below cap.
- Whitelisted selectors: account deploy, `addPasskey`, `revokePasskey`, escrow `checkIn`/`checkOut`/`settle`, and a forward-looking allow-list for future on-chain features.
- Sponsorship approval is an off-chain ECDSA signature from a server-side signer key, valid 5 min, verified on-chain (`SignatureVerifier` pattern).

### 3.2 v2/ — ZKSync-native foundation (parked, preserved)

Location: `contracts/contracts/v2/self/`. **Status: parked, contingent on Self.xyz deploying their full contract suite on ZKSync Era natively** (3-6 month roadmap item on their side; outside our control).

Preserved contracts (37 passing unit tests, verifier deployed to ZKSync Era Sepolia at `0xf23537eF06fC1283F5be80676418b71aEd81b7E5`):

- `Verifier_vc_and_disclose.sol` — Self's Groth16 verifier (forked, zksolc-compiled). Useful as proof of feasibility + future v2 building block.
- `ISelfGroth16Verifier.sol`, `SelfPublicSignals.sol` — Interfaces.
- `SelfAttesterRegistry.sol` — Two-step-ownable allow-list of trusted attester ECDSA keys. **Not used under v1** (LayerZero's DVN network replaces the attester sig). Becomes immediately useful if Self ever exposes a *"attest over `(merkle_root, timestamp)`"* primitive.
- `NullifierRegistry.sol` — One-shot account ↔ nullifier binding with proof + attester sig verification. Has full check sequence (attestation ID, scope, user identifier, proof). When Self ships native ZKSync, this becomes the on-chain consumer.
- `mocks/MockSelfGroth16Verifier.sol` — Test fixture.

See `contracts/contracts/v2/README.md` for the full v2 rationale and future-work plan.

### 3.3 What we don't fork from Self.xyz (under v1)
- Their hub / verifier contracts on Celo — we consume them via `SelfVerificationRoot`, we don't redeploy.
- Their TEE relayer — we hit theirs (staging + production endpoints, env-configured).
- Their attester key set — not relevant under v1 (LZ DVN handles cross-chain auth).
- Their UI / dapp-glue contracts.

### 3.4 Trust model (v1)

- **Identity proof correctness**: Self's deployed contracts on Celo (TEE-attested registration → merkle root → Groth16 proof → OFAC / age / country policy).
- **Cross-chain message authenticity**: LayerZero V2 DVN network. Default = 1 DVN + 1 Executor on testnet; mainnet = 2-of-3 DVNs minimum.
- **OffshoreSyncReceiver storage** = source of truth for `(account ↔ nullifier)` on ZKSync Era. Mongo mirrors it via an event indexer.
- **The indexer is idempotent** and re-runnable from genesis to rebuild Mongo state if needed.
- **Worst case under DVN compromise**: attacker can delay or reorder verifications, **not fabricate them** — Self's TEE + merkle-root checks have already happened upstream on Celo before the LZ message is sent.

---

## 4. Mobile / native integration

**Architectural decision**: under v1 the Web3 surface (passkey, passport scan, escrow signing, on/off-ramp) lives in a **separate React Native companion app, Cofferdam** — see §4.5. The main OffshoreSync app stays Capacitor and stays open + non-Web3. Deep links handle handoff between the two.

This section describes the SDKs/integrations Cofferdam consumes. If we ever fall back to the Capacitor-extension shape, the same SDKs apply via Capacitor plugin shims.

### 4.1 `zksync-sso` (RN integration in Cofferdam)

Native-RN integration of `zksync-sso` patterns.
- **iOS** (Swift bridge): `ASAuthorizationPlatformPublicKeyCredentialProvider` (Secure Enclave passkeys) + zksync-sso Swift lib.
- **Android** (Kotlin bridge): Credential Manager API + zksync-sso Android lib.
- **JS surface** (in Cofferdam's `services/zksyncSsoService.ts`):
  - `register({ name, userId, rpId, challenge })`
  - `signTx(tx)` / `sendTx(tx)` (paymaster sponsorship attached upstream by `paymasterClient`)
  - `getCredentials()`, `addCredential()`, `revokeCredential(credentialId)`

### 4.2 `@selfxyz/mobile-sdk-alpha` (RN integration in Cofferdam)

Self's official SDK engine, mid-refactor toward a WebView + native-shell delivery model. We do **not** port Self's RN code — we consume their published SDK directly (it's RN-native).
- **Native shell** (iOS/Android): hosts the WebView engine + provides NFC permissions and the `IsoDep`/`CoreNFC` bridge that the SDK calls into for the physical passport scan.
- **Proof generation**: **TEE-side** — the SDK encrypts circuit inputs and WebSocket-ships them to Self's TEE relayer (staging or production endpoint, env-configured). The SDK then returns `{ proof, publicSignals, attesterSig }`. snarkjs does **not** run on the phone.
- **Under v1**: we submit the proof to **Self's hub on Celo** (not our own contract). Self's hub validates everything and our `OffshoreSyncCeloVerifier` consumes the result via `customVerificationHook`. The mobile SDK already knows how to target the Celo hub — we just configure scope + endpoint.
- **Dev mode**: a build flag swaps `WS_DB_RELAYER` (`wss://websocket.self.xyz`) for `WS_DB_RELAYER_STAGING` (`wss://websocket.staging.self.xyz`) so we can use Self's staging TEE with programmatically-generated mock passports from `@selfxyz/common` — no Self mobile app required at any point in our pipeline.

### 4.3 Web fallbacks (main OffshoreSync app, Capacitor)
- **Passkey**: standard WebAuthn (`navigator.credentials.create` / `.get`) for cases where the user accesses a verified-identity feature from the web app.
- **Passport scan**: not feasible in-browser. Web renders a QR code that opens `cofferdam://verify-identity?session=…` on the user's installed Cofferdam app, which runs the NFC + ZK flow and submits the proof on Celo. Web polls `/api/identity/qr-handoff/:sessionId` for completion.
- **App store install nudge**: if the user opens a verified-identity feature on web without Cofferdam installed, we render a download CTA to App Store / Play Store.

### 4.4 Main app (OffshoreSync) deep-link surface

Main app stays Capacitor + non-Web3. When a flow needs verified identity, the main app emits a deep link:

- `cofferdam://verify-identity?returnTo=offshoresync://post-composer&sessionId=...` — trigger passport scan + on-chain bind, then return to the originating screen.
- `cofferdam://sign-tx?contractId=...&action=accept&returnTo=offshoresync://job/123` — ask the user to sign a specific escrow transaction.
- `cofferdam://send-payment?amount=100&token=USDC&to=0x...&memo=...` — trigger an off-ramp / remittance flow.

Main app handles the response via `offshoresync://verify-result?sessionId=...&txHash=...&status=success|cancelled|error`.

## 4.5. Cofferdam companion app (high-level scope outline)

> **Status**: branding + strategic intent confirmed (2026-05-16). Detailed scope, monorepo layout, and SDK API are deferred to a follow-up session.

### 4.5.1 Identity

- **Brand**: Cofferdam. A cofferdam (maritime engineering) is a watertight enclosure built to keep water out during construction/repair below the waterline — the perfect metaphor for a security-grade Web3 wallet that keeps cryptographic material sealed from the open social-networking surface of OffshoreSync.
- **Domain**: `cofferdam.xyz`.
- **Positioning**: an open-source Web3 wallet for the maritime industry (offshore + onshore workers). Pitches as the high-grade security companion that other apps can plug into; OffshoreSync is its first integration.
- **Tagline candidates** (refine later): *"Sealed crypto for the offshore industry."* / *"Your maritime Web3 vault."*

### 4.5.2 Scope (preliminary — to be polished in a follow-up session)

User-facing features:

- **Wallet** — ZKSync Era smart account, passkey-managed (≤ 3 devices, Secure Enclave / StrongBox-backed).
- **Identity** — Self.xyz passport scan + on-chain bind (verification on Celo, mirror to ZKSync Era).
- **Contracts** — view + sign job-contract escrows from OffshoreSync. Check-in / check-out for proof-of-presence.
- **Payments** — USDC balance view (ZKSync Era + Celo). Bridge ZKSync→Celo via LayerZero. Send to Celo addresses for family transfers.
- **Documents** — encrypted document vault (passport scans, certificates, employment letters). Encryption key derived from the Secure Enclave keypair; documents never leave the device unencrypted.
- **Messaging** *(future)* — E2EE messaging with key exchange via the device keypair. Useful for recruiter ↔ worker private conversations once on-chain identities are bound.

### 4.5.3 SDK (`@cofferdam/sdk` or similar — name TBD)

A standalone open-source SDK other Web3 apps can integrate to delegate:

- **Verified identity** — *"Sign in with Cofferdam"* button (analogous to *"Sign in with World ID"*).
- **Document encryption** — client-side AES-GCM with keys held in the device secure enclave.
- **Device keypair management** — generate, attest, rotate device keys for E2EE messaging integrations.
- **"PQR tunneling"** *(user-named primitive — clarification deferred)*: probably either post-quantum key exchange for the transport layer, or QR-based pairing handoff between devices, or both. Final definition deferred to a follow-up session.
- **Finance** — on/off-ramp UI components (Mento, MiniPay, Valora integrations on Celo).

### 4.5.4 Decisions deferred

- App-store branding strategy (sub-brand of OffshoreSync vs. fully separate brand identity — *cf.* Robinhood / Robinhood Crypto split).
- Monorepo layout (`apps/cofferdam/` in OffshoreSync repo vs. fresh `cofferdam/` repo with separate release pipeline).
- Open-source license (likely Apache 2.0 or MIT for SDK; main app possibly stricter).
- Multi-tenancy: do we allow third parties to white-label Cofferdam, or only consume its SDK?
- Funding model: free for individual workers; SDK consumer enterprises pay an integration fee?

None of these block Phase 1 contract work. They become the focus of Phase 2 (mobile integration).

---

## 5. Server (`react-server/`)

### 5.1 Routes

**`routes/auth.js`** (extended)
- `POST /api/auth/passkey-challenge` → `{ challenge, rpId, allowCredentials? }`.
- `POST /api/auth/passkey-verify` → verifies WebAuthn assertion against stored credential pubkey, issues JWT (same cookie shape as existing flows).

**`routes/wallet.js`** *(new)*
- `POST /api/wallet/account` — records `{ smartAccountAddress, network }` after first deploy. Client provides a signed message proving control.
- `GET /api/wallet/passkeys` — list registered credentials (label, addedAt, lastUsedAt only; never pubkey to the client list view).
- `DELETE /api/wallet/passkeys/:id` — server queues an on-chain `revokePasskey` via paymaster session, awaits confirmation, then nulls the Mongo row.

**`routes/identity.js`** *(new)*
- `POST /api/identity/notify` — `{ txHash }`. Server fetches receipt + `NullifierBound` event, updates Mongo immediately. Idempotent with the chain watcher.
- `GET /api/identity/qr-handoff/:sessionId` — web long-poll; resolves once mobile posts a tx hash.
- `POST /api/identity/qr-handoff/:sessionId` — mobile posts `{ txHash }` after on-chain bind.

### 5.2 Middleware

**`middleware/identityGate.js`** *(new)* — `requireVerifiedIdentity`. Returns 403 + machine-readable code `IDENTITY_REQUIRED` so the client can open the inline flow.

Mounted on:
- `routes/posts.js` — create.
- `routes/comments.js` — create.
- `routes/jobs.js` — worker apply, recruiter create vacancy, reveal candidate.
- `routes/conversations.js` — start conversation with a non-friend.

### 5.3 Services

- **`services/paymaster/`** *(new)* — sponsorship signature service (decides which OffshoreSync user operations to co-sign for paymaster sponsorship), per-account / per-IP / per-selector rate limits. *Treasury balance monitoring and top-up orchestration live in the separate **Cofferdam Partners platform** Treasury orchestrator Worker (see `../Cofferdam/README.md` §11.4), which manages paymaster pools for all integrators including OffshoreSync as the Tier 1 reference integrator.*
- **`services/chainIndexer/`** *(new)* — `viem`-based watcher for `NullifierBound`, `PasskeyAdded`, `PasskeyRevoked`. Idempotent. Resumes from last processed block stored in Mongo.

### 5.4 Mongo schema changes (`models/User.js`)

Extend `authProvider` enum: `['local', 'google', 'apple', 'zksync-passkey']`.

Add subdocs:

```js
wallet: {
  smartAccountAddress: { type: String, default: null, index: true, sparse: true },
  network: { type: String, enum: ['zksync-era-testnet', 'zksync-era-mainnet', null], default: null },
  passkeys: [{
    credentialId:  { type: String, required: true },   // base64url
    publicKey:     { type: String, required: true },   // for WebAuthn assertion verify
    label:         { type: String, default: 'Device' },// e.g. "iPhone 15 Pro"
    platform:      { type: String, enum: ['ios','android','web'] },
    addedAt:       { type: Date, default: Date.now },
    lastUsedAt:    { type: Date, default: null },
    revokedAt:     { type: Date, default: null }
  }],
  deployedAt:        { type: Date, default: null },
  migrationStatus:   { type: String, enum: ['pending','enrolled','declined'], default: 'pending' }
},
identity: {
  verified:        { type: Boolean, default: false, index: true },
  nullifierHash:   { type: String, default: null, unique: true, sparse: true }, // server-only, never exposed
  proofVersion:    { type: String, default: null },                              // Self circuit version
  verifiedAt:      { type: Date, default: null },
  passportCountry: { type: String, default: null }                               // ISO-3, from public inputs
}
```

`createUserResponse` exposes `wallet.smartAccountAddress`, `wallet.passkeys` (label / addedAt / platform only), `identity.verified`, `identity.verifiedAt`, `identity.passportCountry`. **Never** expose `nullifierHash` or passkey public keys.

### 5.5 Env vars (`react-server/.env.example` additions)

```
# ZKSync Era
ZKSYNC_RPC_URL=
ZKSYNC_CHAIN_ID=
ZKSYNC_NETWORK=zksync-era-testnet
PAYMASTER_ADDRESS=
PAYMASTER_SIGNER_PRIVATE_KEY=
ACCOUNT_FACTORY_ADDRESS=
ACCOUNT_VALIDATOR_ADDRESS=
NULLIFIER_REGISTRY_ADDRESS=
SELF_VERIFIER_ADDRESS=
SELF_ATTESTER_REGISTRY_ADDRESS=

# Identity
OFFSHORESYNC_SCOPE_SALT=          # never sent to client
IDENTITY_VERIFY_MODE=onchain      # onchain | offchain (fallback)

# Chain indexer
CHAIN_INDEXER_START_BLOCK=
```

---

## 6. Client (`react-client/`)

### 6.1 Services (`src/services/`)
- `zksyncSsoService.js` — wraps `@offshoresync/capacitor-zksync-sso` + `viem` / `zksync-ethers` for tx construction.
- `selfIdentityService.js` — wraps `@offshoresync/capacitor-self`. On native: scan + prove + submit on-chain via `accountClient.sendTransaction(verifyAndBind…)`. On web: open QR handoff and poll.
- `paymasterClient.js` — fetches sponsorship signature from server and attaches to outgoing userOps.

### 6.2 Context (`src/context/Web3Context.jsx`) *(new)*

```js
{
  smartAccount,          // { address, network, deployedAt }
  passkeys,              // array (label, addedAt, platform)
  isVerifiedIdentity,    // boolean
  deploy,                // () => Promise
  addPasskey,            // () => Promise
  revokePasskey,         // (credentialId) => Promise
  signTx,                // (tx) => Promise<signed>
  sendTx,                // (tx) => Promise<receipt>
  startPassportProof,    // () => opens VerifyPassportFlow
}
```

Provider tree: `AuthProvider > Web3Provider > PermissionProvider > SocketProvider > NotificationProvider > SearchProvider > SubscriptionProvider > UIProvider`.

### 6.3 Screens / flows

- **Onboarding "Secure your account"** — new step, runs before existing greeter:
  1. Create passkey on this device → server registers credential.
  2. Server triggers paymaster-sponsored account deploy → stores address.
  3. Passport scan is **not** in onboarding — deferred to first gated action.
- **`/wallet`** — list devices (passkeys), add device (cross-device QR), revoke device, account address with explorer link.
- **`/verify-identity`** — drives Self.xyz NFC scan + prove + submit on-chain. Shows "Submitting to chain…" intermediate while the tx confirms (1-3 s).
- **Verified badge** — small icon on `ProfileHeader`, `PostCard` author row, `CommentCard`, `MessageBubble` author chip, recruiter cards. Read from `user.identity.verified`.
- **Migration banner** — for existing legacy users at first login post-update: "Add a passkey to keep using OffshoreSync." Soft for release N, forced at session expiry for N+1.

### 6.4 Login screen
- Primary CTA: **Sign in with passkey** (WebAuthn on web / native passkey on mobile).
- Below divider: existing Google / Apple / email-password buttons. Feature-flagged via `VITE_LEGACY_AUTH=true`.

### 6.5 Action gates
`<RequiresVerifiedIdentity>` HOC opens the passport flow inline if `!identity.verified`. Wraps:
- Post composer submit (`PostComposer`)
- Comment send (`CommentComposer`)
- Job apply CTA (`JobCard` worker apply, `JobFeed` swipe)
- Recruiter publish (`VacancyComposer`)
- Recruiter reveal (`CandidateList`)
- "Message" button on a non-friend profile (`ProfileActions`)

### 6.6 Native config
- `capacitor.config.ts` — register both plugins.
- `ios/App/App/Info.plist` — add `NFCReaderUsageDescription`, `com.apple.developer.nfc.readersession.iso7816.select-identifiers` (passport AID `A0000002471001`), passkey associated domains entitlement.
- `android/app/src/main/AndroidManifest.xml` — `<uses-permission android:name="android.permission.NFC"/>`, `<uses-feature android:name="android.hardware.nfc"/>`, Credential Manager intent filters.

---

## 7. Migration story for existing users

| Release | State |
|---------|-------|
| N (soft launch) | Both auth systems live, legacy default. Banner + email campaign: "Add a passkey." |
| N+1 | Passkey login default. Legacy still works. `wallet.migrationStatus` tracked per user. |
| N+2 | Legacy auth disabled. Users without a passkey get a one-time email enrolment link. Manual KYC fallback if all devices lost. |

Account recovery (all 3 passkeys lost): user re-proves passport → nullifier matches existing account → server re-binds a fresh passkey to the same on-chain account via a paymaster-sponsored admin path.

---

## 8. Security & privacy

- **Nullifier hashing**: `keccak256(self_nullifier || OFFSHORESYNC_SCOPE_SALT)` — salt is a server-side env var, never shipped to the client. Prevents cross-app correlation.
- **Passport data never leaves the device.** Only the ZK proof, nullifier hash, and selected public inputs (country, optionally age range) reach our server / chain.
- **Passkey credential public keys** are stored server-side for WebAuthn assertion verification but never enumerated to other users.
- **Paymaster anti-abuse**: rate-limit per account / per IP / per selector / per device fingerprint; sponsorship signatures have 5-min TTL. Specifically `verifyAndBind`: **1 successful call per account lifetime; 3 failed attempts per IP / day**.
- **Stolen device**: revoke from any of the other ≤ 2 devices instantly.
- **All-devices-lost**: re-prove passport → nullifier match → new passkey bound to same account.

---

## 9. Phased rollout

### Phase 0 — Spike (1.5 weeks) — **gates everything below**

**Status: partially complete — first gate (verifier compile + zero-proof rejection) is GREEN.**

1. Hello-world Capacitor plugin: register a passkey, deploy a stock ZKSync SSO account on Sepolia, send a no-op tx via stock paymaster. *(pending)*
2. Hello-world Self plugin: scan a real passport, generate a real Groth16 proof. *(pending)*
3. ✅ **Compile Self.xyz's published Groth16 verifier with `zksolc` — no source edits.** **DONE 2026-05-14.** Source: Self's `prove_vc_and_disclose` circuit, `Verifier_vc_and_disclose.sol`. Compiled with `zksolc v1.5.16` + `zkvm-solc v0.8.28-1.0.2`, codegen `yul`, optimizer mode `3`. Artifact: 21,024 bytes runtime bytecode, single function `verifyProof(uint256[2], uint256[2][2], uint256[2], uint256[21]) returns (bool)`. Deployment confirmed on anvil-zksync local node.
4. ✅ **Submit a known-bad proof to `verifyProof(…)`.** **DONE 2026-05-14.** Returns `false` cleanly — no revert, no OOG. Confirms `ecPairing`-equivalent BN254 precompile path works under zksolc-generated bytecode on the EraVM. *(Real-proof submission still pending — depends on §1 + §2.)*
5. Confirm Self's exact attester key format (ECDSA address vs raw key hash) and public-input layout (does `country` actually appear?). *(pending — needs item 2.)*

**Remaining Phase 0 confidence steps**

- Re-run deploy + smoke-test on real ZKSync Era Sepolia (not just local anvil-zksync) to rule out forked-only quirks.
- Once item 2 produces a real proof, submit it to the deployed verifier on Sepolia and measure actual gas. Target: ≤ Ethereum-mainnet ~300 k baseline; should be cheaper in USD on ZKSync.

**Off-chain fallback (`IDENTITY_VERIFY_MODE=offchain`) is no longer the expected path — it remains documented as a contingency only.**

### Phase 1 — Custom contracts (2 weeks, hybrid pivot)

**First slice (2026-05-16, ✅ DONE)** — native-ZKSync stack. Moved to `contracts/v2/` after architectural review.
- `SelfAttesterRegistry`, `NullifierRegistry`, `ISelfGroth16Verifier`, `MockSelfGroth16Verifier` — 37 unit tests passing on anvil-zksync. Local stack deploy verified end-to-end (`yarn deploy:phase1:local`). `Verifier_vc_and_disclose` deployed on ZKSync Era Sepolia (`0xf23537eF06fC1283F5be80676418b71aEd81b7E5`). All preserved in `v2/` as foundation for future native deployment.

**Second slice (current, 🔄 in progress)** — v1/ hybrid stack.
- ✅ Repo restructured: `contracts/v1/{celo,zksync}/` scaffolded with READMEs documenting planned contracts. 37 unit tests still passing.
- ⏳ LayerZero V2 validation on ZKSync Era — verify endpoint addresses (mainnet EID 30165, Sepolia TBD), confirm zksolc compiles `@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol`, deploy a "hello world" OApp pair on Celo Sepolia ↔ ZKSync Sepolia.
- ⏳ Implement `OffshoreSyncCeloVerifier` (Celo source, extends `SelfVerificationRoot` + LZ `OApp`).
- ⏳ Implement `OffshoreSyncReceiver` (ZKSync target, LZ `OApp` receiver) with unit tests.
- ⏳ Implement `OffshoreSyncAccountValidator`, `OffshoreSyncPaymaster`, `OffshoreSyncEscrow` skeletons + happy-path tests.
- ⏳ End-to-end smoke test: Celo Sepolia → ZKSync Sepolia, single nullifier binding round-trip.
- ⏳ Testnet deploy + addresses committed to `react-server/.env.staging` and Cofferdam config.

### Phase 2 — Cofferdam companion app + native integration (3-4 weeks)
- RN bootstrap (`apps/cofferdam/` or fresh repo — decision deferred), TypeScript, NativeWind / Tamagui / similar.
- Wire `@selfxyz/mobile-sdk-alpha` (passport NFC scan + TEE relay client) — RN-native, no Capacitor shim required.
- Wire `zksync-sso` patterns (Secure Enclave / StrongBox-backed passkeys + AA tx flows).
- Wire LayerZero ZKSync ↔ Celo bridge UI for USDC settlement.
- Implement core screens: Wallet, Identity, Contracts (view + sign), Payments, Documents (encrypted vault). Messaging deferred to Phase 5+.
- Deep-link surface (`cofferdam://verify-identity`, `cofferdam://sign-tx`, `cofferdam://send-payment`) + return-path to OffshoreSync main app.
- iOS + Android builds + app store listings.
- **Open-source release** of the SDK (`@cofferdam/sdk` or similar) under permissive license; OffshoreSync is the first published integration.

### Phase 3 — Server (1-1.5 weeks)
- New routes, models, middleware (§5).
- Paymaster policy service (§5.3).
- Chain indexer: Celo `VerificationConsumed` events + ZKSync `NullifierBound`, `PasskeyAdded`, `PasskeyRevoked` + LayerZero `MessageDelivered`.
- LayerZero attestation reconciliation: detect stuck Celo→ZKSync messages and surface to ops dashboard.
- Mongo schema migration to add `wallet` + `identity` subdocs (§5.4).

### Phase 4 — Main app integration (1.5 weeks)
- Main OffshoreSync app stays Capacitor + non-Web3 for the social-networking surface.
- Add `RequiresVerifiedIdentity` HOC — wraps gated CTAs, deep-links to Cofferdam if not verified.
- Add `cofferdam-install-nudge` UI flow (App Store / Play Store deep links).
- Migration banner for existing users: "Add Cofferdam to keep using sensitive features."
- Web fallback: QR handoff between desktop OffshoreSync and Cofferdam mobile.
- Verified badges on `ProfileHeader`, `PostCard`, `CommentCard`, `MessageBubble`, recruiter cards.

### Phase 5 — Migration & rollout (2 weeks across 3 releases)
- Soft launch → verified-identity default for sensitive actions → legacy auth sunset.

**Total: ~8-9 weeks of focused work** (revised down from 9-10 — LayerZero V2 removes the need for our own attester sig + merkle root mirroring on ZKSync).

**Bounty target dates (tentative):**
- *End of Phase 1*: Self.xyz builder bounty submission (LayerZero V2 integration on ZKSync Era as a new destination chain).
- *End of Phase 2*: ZKSync Era ecosystem grant submission (paymaster + AA showcase for an enterprise vertical).
- *End of Phase 3*: Celo Foundation grant outreach (USDC remittance use case targeting maritime workers in emerging markets).

---

## 10. Risks

### Resolved
- ~~**`zksolc` codegen for Self's Groth16 verifier.**~~ Resolved 2026-05-14. Compiles, deploys, returns `false` on bad proof. BN254 precompile path verified on anvil-zksync AND ZKSync Era Sepolia. Preserved in `v2/`.
- ~~**Self.xyz prover on mid-range Android.**~~ No longer applicable — Self's mobile SDK does **not** prove on-device. All proofs run in Self's TEE.
- ~~**Merkle root trust gap on ZKSync (under native v2 path).**~~ Resolved by pivoting to v1 hybrid. Verification happens on Celo via Self's hub; we inherit Self's full merkle-root trust model. ZKSync side has no proof verification at all under v1.
- ~~**Custom attester sig allow-list management.**~~ Resolved by pivoting to v1. LayerZero V2 DVN network handles cross-chain auth; no attester key for us to manage.

### Phase 1 blockers (current sprint)
- **LayerZero V2 ZKSync Era compatibility.** Need to confirm: (a) LZ's official V2 endpoint contracts are deployed on both ZKSync Era Mainnet (EID 30165) and ZKSync Sepolia; (b) `@layerzerolabs/oapp-evm` source compiles under zksolc without patches. Investigation deferred to next session as the first validation spike.
- **Celo tooling decision.** Source-side contracts (Celo) compile with standard `solc`, not `zksolc`. Either run a sibling Hardhat workspace (mirrors our current setup, less framework overhead) or switch to Foundry (matches Self's reference repo `selfxyz/self-layerzero-example`). Decision deferred to next session.
- **iOS passkey cross-device add** uses Apple's QR + Bluetooth flow; verify it works inside Cofferdam (not just Safari) once Phase 2 starts.

### Ongoing
- **LayerZero DVN trust.** Default config = 1 DVN + 1 Executor; this is a single point of failure for cross-chain message integrity. Mitigation: configure 2-of-3 DVNs minimum for production mainnet deployment. Worst-case DVN compromise can delay or reorder verifications but **cannot fabricate them** — Self's TEE + merkle-root checks have already happened upstream on Celo.
- **LayerZero fees on Celo.** OffshoreSyncCeloVerifier pays LZ messaging fees from its own balance. Recommend pre-funding ~0.5 CELO per ~50 verifications. Top-up cron + low-balance alert needed.
- **Self circuit version churn.** New circuit ⇒ new vkey at Self's hub. Their `customVerificationHook` payload schema may change. Need to watch their SDK release notes + handle gracefully (versioned `configId`).
- **Self TEE availability / pricing.** Self runs the TEE relayer free during the growth phase. If they introduce pricing or strict rate limits before our launch, we'd need to either pay for higher tier access, negotiate via the builder grant (see §13), or eventually self-host (heavy: requires SGX/SEV hardware).
- **Self IdentityVerificationHubImplV2 upgrades on Celo.** Their hub is upgradeable. If they push a breaking change to `verify(...)` or the `customVerificationHook` ABI, our `OffshoreSyncCeloVerifier` would need an upgrade. Mitigation: integration test against staging hub on Celo Sepolia in CI; weekly diff of mainnet hub bytecode for drift detection.
- **LZ message failure handling.** LZ messages can be stuck / replay-needed in rare cases. Need a `manualReplay()` admin function on `OffshoreSyncCeloVerifier` and an ops runbook.
- **Country public input** may not be exposed by Self's `customVerificationHook` output — confirm against `ISelfVerificationRoot.GenericDiscloseOutputV2` once we wire it. Drop `identity.passportCountry` from the schema if so. (Self's example does expose `gender`, `nationality`, `olderThan`; likely fine.)
- **Paymaster economics on ZKSync Era.** Model worst-case daily op count × ZKSync L2 gas → size treasury runway. Alert at < 1 day burn. Detailed economic model and per-tier MAU costing in `../Cofferdam/README.md` §10; LLC-side anti-runaway caps and reconciliation in OffshoreSync's internal treasury runbook (`../financial/TREASURY.md` §6–7).
- **Cofferdam app store reviews.** Crypto + KYC features in a dedicated wallet app face different review surface vs. a job-board app. Maintain a release runbook + reviewer responses doc.
- **Cofferdam adoption friction.** Users must install a second app for verified-identity flows. Mitigate via clear value-prop in the install nudge + frictionless deep-linking + onboarding cohort UX testing.

---

## 11. Files to be touched (preview, not exhaustive)

### Contracts (`contracts/` at workspace root)

**v1/ active dev** — see `contracts/contracts/v1/README.md` for full architecture.
- `contracts/v1/celo/OffshoreSyncCeloVerifier.sol` — extends `SelfVerificationRoot` + LZ `OApp`. *(planned, Phase 1 second slice)*
- `contracts/v1/zksync/OffshoreSyncReceiver.sol` — LZ `OApp` receiver, holds nullifier bindings. *(planned, Phase 1 second slice)*
- `contracts/v1/zksync/OffshoreSyncEscrow.sol` — job contracts + proof-of-presence. *(planned, Phase 1 second slice)*
- `contracts/v1/zksync/OffshoreSyncAccountValidator.sol` — 3-passkey cap. *(planned, Phase 1 second slice)*
- `contracts/v1/zksync/OffshoreSyncPaymaster.sol` — sponsorship + rate limits, gates on `isAccountBound`. *(planned, Phase 1 second slice)*
- `contracts/v1/celo/README.md`, `contracts/v1/zksync/README.md` — *(✅ done 2026-05-17)*.
- Deploy scripts: `scripts/deploy-v1-celo.ts`, `scripts/deploy-v1-zksync.ts` *(planned)*.
- Tooling note: Celo workspace may end up as a sibling Hardhat or Foundry repo. Decision deferred.

**v2/ preserved foundation** — see `contracts/contracts/v2/README.md`.
- `contracts/v2/self/Verifier_vc_and_disclose.sol` — forked from Self.xyz, zksolc-compiled, deployed on ZKSync Era Sepolia at `0xf23537eF06fC1283F5be80676418b71aEd81b7E5`. *(✅ done)*
- `contracts/v2/self/SelfAttesterRegistry.sol` — 23 unit tests passing. *(✅ done)*
- `contracts/v2/self/NullifierRegistry.sol` — 14 unit tests passing. *(✅ done)*
- `contracts/v2/self/ISelfGroth16Verifier.sol`, `SelfPublicSignals.sol`. *(✅ done)*
- `contracts/v2/self/mocks/MockSelfGroth16Verifier.sol`. *(✅ done)*

**Toolchain note**: the matter-labs hardhat plugins' auto-downloaders are broken on `undici@6` (they pass the removed `maxRedirections` option). We sidestep by vendoring `zksolc`, `zkvm-solc`, and `anvil-zksync` binaries manually — see `contracts/README.md`. We also maintain an upstream-PR-ready patched fork at `OffshoreSync/hardhat-zksync` (undici v6 redirect interceptor fix). When matter-labs ships fixed plugin versions, the `compilerPath` / `binaryPath` overrides in `hardhat.config.ts` can be removed.

### Server (`react-server/`)
- `models/User.js` — `wallet` + `identity` subdocs, `authProvider` enum.
- `routes/auth.js` — `passkey-challenge` / `passkey-verify`, updated `createUserResponse`.
- `routes/wallet.js` *(new)*, `routes/identity.js` *(new)*.
- `middleware/identityGate.js` *(new)*.
- `routes/posts.js`, `routes/comments.js`, `routes/jobs.js`, `routes/conversations.js` — mount `requireVerifiedIdentity`.
- `services/paymaster/` *(new)*.
- `services/chainIndexer/` *(new)* — Celo (`VerificationConsumed`) + ZKSync (`NullifierBound`, passkey events) + LayerZero (`MessageDelivered`).
- `.env.example` — new vars.

### Main app (`react-client/`, Capacitor, **stays non-Web3**)
- `src/components/auth/Login/` — passkey-first CTA *(only if the user has Cofferdam installed)*.
- `src/components/posts/PostComposer`, `comments/CommentComposer`, `jobs/JobCard`, `jobs/VacancyComposer`, `jobs/CandidateList`, `friends/.../MessageButton` — wrap in `RequiresVerifiedIdentity` HOC. HOC opens Cofferdam via deep link if not verified.
- `src/components/identity/VerifiedBadge` *(new)* — visual indicator only; reads from server-cached `user.identity.verified`.
- `src/components/identity/CofferdamInstallNudge` *(new)* — download CTA when needed.
- `src/utils/cofferdamDeepLink.js` *(new)* — helper for building `cofferdam://...` URIs + handling `offshoresync://verify-result` returns.
- `capacitor.config.ts` — register custom URL scheme `offshoresync://` for return-paths.
- `ios/App/App/Info.plist`, `android/app/src/main/AndroidManifest.xml` — deep-link intent filters.

### Cofferdam companion app (`apps/cofferdam/` or fresh repo — TBD)
- `apps/cofferdam/package.json`, `App.tsx`, `metro.config.js`, etc. *(planned, Phase 2)*
- `src/services/zksyncSsoService.ts` *(new, Phase 2)*.
- `src/services/selfIdentityService.ts` *(new, Phase 2)*.
- `src/services/paymasterClient.ts` *(new, Phase 2)*.
- `src/services/lzBridgeService.ts` *(new, Phase 2)*.
- `src/screens/WalletScreen.tsx`, `IdentityScreen.tsx`, `ContractsScreen.tsx`, `PaymentsScreen.tsx`, `DocumentsScreen.tsx` *(planned, Phase 2)*.
- `src/sdk/` *(new, Phase 2)* — the `@cofferdam/sdk` public surface other apps can integrate.
- `ios/`, `android/` — native modules for NFC, Secure Enclave / StrongBox, deep-link handlers.

---

## 12. What is explicitly NOT in this plan

- **Social recovery** beyond "re-prove passport." Multi-sig + guardian-based recovery deferred.
- **Tokenization / loyalty / rewards.** Possible later vertical (verified maritime workers might earn a token tied to work history) but not in scope here.
- **Recruiter-side identity proof variants** (e.g. company KYB). Worker-side only for v1.
- **DAO governance** of any contract. The owner of every OffshoreSync contract (`OffshoreSyncCeloVerifier`, `OffshoreSyncReceiver`, `OffshoreSyncEscrow`, `OffshoreSyncPaymaster`) is the **OffshoreSync LLC Treasury Safe** from deployment onward — the deploy script's last step is `transferOwnership(LLC_SAFE_ADDRESS_<chain>)` so the deployer EOA never retains authority past the deployment block. Safe signer composition is governed by the OffshoreSync LLC treasury maturity ladder (public outline in `../Cofferdam/README.md` §11.2; private operational specifics in `../financial/TREASURY.md`). The contract-owner address never changes from deployment onward — only the off-chain signer set behind that address evolves. Full on-chain DAO governance is a v3+ concern.
- **Direct fiat on/off-ramp inside Cofferdam.** We rely on third-party ramps (Mento, MiniPay, Valora, etc.) accessed via Celo address — we don't operate as an MSB.
- **Cross-chain bridging beyond LayerZero V2.** Only Celo ↔ ZKSync via LZ. No additional chains.
- **Cofferdam app store on Web3-only stores** (e.g. Solana Mobile Stack-style alternative app stores). Standard iOS / Android only for v1.

Each will get its own plan once the foundation here is in production.

**Reversed from earlier plan (now IN scope):**
- **On-chain job-contract escrow** (`OffshoreSyncEscrow`) — added as part of v1/zksync. Drives the killer product feature (recruiter locks payment, worker check-in/out, auto-settle).
- **Celo USDC remittance flow** — added as part of the v1 dual-chain financial architecture. Phase 2 ships Cofferdam's Payments screen with LZ bridge + Celo send.

---

## 13. Builder bounties + ecosystem grants

We have **three independent angles** for ecosystem funding, all reinforcing the same dual-chain architecture:

### 13.1 Self.xyz builder bounty (primary)

Self publishes bounties for new applications built on their protocol. OffshoreSync hits at least four buckets:

- **Sybil resistance for a vertical professional network** — maritime workers + enterprises. Not a generic airdrop gate.
- **First production LayerZero V2 destination chain = ZKSync Era** — Self's reference example targets Celo → Base. We extend the pattern to Celo → ZKSync Era, which is a substantially more interesting destination chain (native AA + paymaster + ZK alignment).
- **High-stakes economic use case** — maritime hiring is regulated, employer-verifiable work history matters, recruiter sybil resistance has real money at stake. Not toy social-media humanity checks.
- **Native ZKSync Era foundation** — we've separately proven Self's Groth16 verifier compiles + deploys on ZKSync Era under zksolc (preserved in `v2/`). If Self ever ships native ZKSync deployment, we already have the receiver-side machinery ready (`SelfAttesterRegistry`, `NullifierRegistry`).

**Action items (post Phase 1 second slice):**
- Publish a writeup: "ZKSync Era as a Self.xyz LayerZero destination — implementation + Phase 0 findings (zksolc compile, BN254 precompile confirmation)."
- Open-source the LayerZero V2 OApp pair for Celo ↔ ZKSync Era under MIT.
- Reach out via [Self builder Telegram](https://t.me/selfprotocolbuilder) and [Discord](https://discord.gg/AQ3TrX6dce).
- Apply for builder grant — funds can offset paymaster treasury and TEE-relay costs.
- Offer to contribute back: `hardhat-zksync` undici v6 fix PR (already authored on our fork at `OffshoreSync/hardhat-zksync`).

### 13.2 ZKSync Era ecosystem grant (secondary)

Matter Labs runs ZKSync Era ecosystem grants for projects showcasing native AA + paymaster + production use cases.

- **Enterprise paymaster showcase** — OffshoreSyncPaymaster sponsors verified workers across passkey ops, escrow check-in/out, settlement. Real production user volume from maritime industry.
- **First Self.xyz / LayerZero V2 hybrid integration on ZKSync Era** — references the Self bounty angle.
- **Real-world adoption signal** — OffshoreSync has an existing user base (recruiters + offshore/onshore workers); not a green-field experiment.

**Action items (post Phase 2 ship):**
- Apply via [ZKSync Era ecosystem program](https://zksync.io/ecosystem).
- Publish gas economics breakdown (paymaster cost per typical user flow).
- Open-source Cofferdam wallet under permissive license.

### 13.3 Celo Foundation grant (tertiary)

Celo's grants focus on real-world fintech use cases in emerging markets.

- **Cross-border remittance for offshore workers** — Philippine seafarers, Brazilian rig workers, Nigerian offshore engineers earn USD-denominated wages and send portions home. USDC on Celo + Mento + MiniPay is a fit.
- **MiniPay integration** — Cofferdam can expose a "Send to MiniPay" handoff that uses phone-number addressing.
- **Mento liquidity** — cUSD / cEUR / cREAL fiat ramps for offshore worker home countries.
- **Auditable cross-border payments** — dual-chain architecture (ZKSync audit trail + Celo settlement) is a unique narrative for regulated remittance.

**Action items (post Phase 3 ship):**
- Reach out via [Celo Foundation grants](https://celo.org/community).
- Publish a maritime-industry remittance pilot writeup.
- Coordinate with Mento Labs on cUSD/USDC liquidity for worker home-country corridors.

---

_Last updated: 2026-05-17 — Architecture pivoted to hybrid Celo + ZKSync via LayerZero V2. Phase 1 first slice (`SelfAttesterRegistry`, `NullifierRegistry`, 37 passing tests, ZKSync Sepolia verifier deploy) preserved under `contracts/v2/` as foundation for future ZKSync-native Self deployment. Phase 1 second slice (`OffshoreSyncCeloVerifier` + `OffshoreSyncReceiver` + escrow + paymaster + validator under `contracts/v1/`) is active dev. Companion app branding decided: **Cofferdam** (`cofferdam.xyz`), open-source RN wallet for the maritime industry; detailed scope deferred. Repo restructured + READMEs landed in `contracts/contracts/{README,v1/README,v1/celo/README,v1/zksync/README,v2/README}.md`. Next session: validate LayerZero V2 on ZKSync Era + implement the v1 contract pair._
