# Escrow family — design doc (Spot / Shift / Rotation)

> **Status:** design / pre-implementation. The shipped escrow
> (`CofferdamSpotEscrow`, formerly `OffshoreSyncEscrow.sol`) handles a
> fixed-duration, single-settlement model only. Real employment — maritime
> *and* onshore — also runs on cyclical settlement, which that contract
> does not cover.
>
> **Rev-7.3 (2026-06-02) — three contracts, not two; abstract naming.**
> An earlier draft proposed a 2-contract split (Spot +
> `OffshoreSyncRecurringEscrow`). Per `ENTERPRISE_MODULE_PLAN.md` rev-7.3
> (the enterprise module is a *Cofferdam* product serving onshore + offshore
> verticals, not maritime-only), the recurring half splits again so a single
> contract never carries both the **high-frequency-small (onshore)** and
> **low-frequency-large (offshore)** reserve profiles. The family, all
> `Cofferdam*`-branded:
>
> - **`CofferdamSpotEscrow`** (was `OffshoreSyncEscrow`) — single settlement.
> - **`CofferdamShiftEscrow`** (new, onshore) — hourly/daily cadence, daily
>   check-in/out, small rolling reserve; no leave-pay/allotment/severance.
> - **`CofferdamRotationEscrow`** (was the planned `OffshoreSyncRecurringEscrow`)
>   — hitch/monthly/per-rotation cadence, large multi-period reserve,
>   leave-pay accrual, allotment split, severance/notice.
>
> The `.sol`/test/SDK-client/deployment rename + the new ShiftEscrow build
> are tracked as the code migration in `ENTERPRISE_MODULE_PLAN.md` §14;
> this doc is the spec. §3–§10 keep their maritime archetype detail and
> pre-rename inline names; §4 maps every archetype to its contract.

## 1. The gap in one sentence

The on-chain escrow handles **"lock funds → worker works once → settle once"**.
The Jobs API accepts and the maritime market actually runs on **"lock reserve
→ worker works in cycles → settle each cycle → top up the reserve"** for
~85% of vacancies.

## 2. What the Jobs API currently models

Authoritative source: `react-server/models/JobVacancy.js`.

### 2.1 `contractType` enum

| Value | Meaning | Working regime required |
|---|---|---|
| `permanent` | Indefinite employment, monthly salary, accrued leave | yes (rotation pattern, e.g. 28/28) |
| `contract` | Fixed-term employment (e.g. 12-month), salaried | yes |
| `rotation` | Crewing-style cycle (on-duty / off-duty), salaried per period | yes |
| `temporary` | Bounded engagement (trip / voyage / project / etc.) | optional |

### 2.2 `temporaryType` enum (only meaningful when `contractType === 'temporary'`)

| Value | Real-world example |
|---|---|
| `trip` | 14-day rig trip, sea trial — stint-defined |
| `voyage` | Port A → Port B — route-defined |
| `project` | Decommissioning, ROV survey — scope-defined |
| `single_assignment` | One tour of duty, no back-to-back relief |
| `day_rate` | Harbor pilot, surge labour — flat daily fee, no benefits |

### 2.3 `compensation.paymentType` enum

| Value | When fees accrue |
|---|---|
| `daily` | Per day on-duty |
| `monthly` | Per calendar month (regardless of on/off-duty) |
| `per_rotation` | Lump at end of each on-duty cycle |
| `contract` | Single lump at end of contract |

### 2.4 `compensation.leavePay` enum

| Value | Behaviour |
|---|---|
| `consolidated` | Leave value rolled into salary; no separate accrual |
| `accrued` | Accumulates at e.g. 8.33%/month; paid at tour end or annually |

### 2.5 `compensation.isContractor`

Boolean. Independent contractor (no leave / benefits) vs employee
(statutory leave, benefits per jurisdiction).

### 2.6 `settlementMethod` (composer field)

| Value | Status |
|---|---|
| `company_hr` | Default. Off-chain. Status-quo payroll path. |
| `zk_contract` | **UI-disabled today** — placeholder for the on-chain path. |

## 3. The five real maritime payment archetypes

After collapsing the enum cross-product into patterns we actually see in
the market, there are five distinct **settlement archetypes**:

### 3.1 Spot / voyage / project (single lump)

- Vacancy shape: `contractType='temporary'` + `paymentType='contract'`
- Examples: relief master for a single ferry crossing, ROV inspection
  job, salvage-tow operation, 14-day rig stint.
- Cashflow: one lump at completion. Maybe a partial advance at check-in.
- **Market share:** ~15–20% of OffshoreSync vacancies (rough estimate
  from current crewing-industry composition).
- **On-chain fit:** Current `OffshoreSyncEscrow.sol` is purpose-built
  for this. No changes needed.

### 3.2 Day-rate spot

- Vacancy shape: `contractType='temporary'` + `temporaryType='day_rate'`
  + `paymentType='daily'`
- Examples: harbor pilot per call ($800–1,500/day), survey day-rate
  consultant, surge labour for a port call.
- Cashflow: paid per day, often invoiced at end of week or end of job.
- **Market share:** ~5–10%.
- **On-chain fit:** Could be coerced into the current escrow by
  posting one contract per day (high gas overhead, terrible UX) or
  one contract covering the whole engagement with internal day
  tracking (loses the per-day audit trail). Needs the recurring
  contract for cycle clarity.

### 3.3 Rotation with monthly salary (the classic offshore model)

- Vacancy shape: `contractType='rotation'` + `paymentType='monthly'`
  + `workingRegime: { onDutyDays: 28, offDutyDays: 28 }` (or 14/14,
  21/21, etc.) + `leavePay: 'consolidated'` typically.
- Examples: DPO on a drillship, AB on an OSV, electrician on an FPSO.
  Crew is paid every month, regardless of whether they're currently
  on the vessel or at home — they are "on payroll".
- Cashflow: monthly salary credit, every month, indefinitely (rolling
  rotations). Often with an "allotment" split — part to the
  seafarer's card, part to family back home.
- **Market share:** ~35–45% of OffshoreSync vacancies. The dominant
  pattern in offshore oil & gas and OSV.
- **On-chain fit:** Doesn't fit current escrow at all. Needs
  continuous / cycle-aware settlement.

### 3.4 Rotation with per-rotation lump

- Vacancy shape: `contractType='rotation'` + `paymentType='per_rotation'`
  + `workingRegime: { onDutyDays: 14, offDutyDays: 14 }` etc.
- Examples: short-rotation crewing-agency engagements (especially
  Brazilian PCH / coastal cabotage), some seismic-survey contracts.
  Crew is paid only at the end of each on-duty cycle, off-duty days
  are unpaid (or compensated only via consolidated leave).
- Cashflow: one lump per completed rotation. Rotations continue
  rolling as long as the relationship lasts.
- **Market share:** ~15–20%.
- **On-chain fit:** Same as 3.3 — needs cycle-aware settlement.

### 3.5 Fixed-term contract / permanent salaried

- Vacancy shape: `contractType='contract'` (12 or 24 months) or
  `contractType='permanent'` (indefinite) + `paymentType='monthly'`
  + `leavePay: 'accrued'` often.
- Examples: senior bridge/engineering officer on a deep-sea fleet,
  cruise-line in-house crew, large shipping company permanent
  contract.
- Cashflow: monthly salary + accrued leave pay (1.5–2.5 days/month
  of service) typically paid as a lump at tour end or annually.
  Severance / end-of-service gratuity in some jurisdictions.
- **Market share:** ~20–25%.
- **On-chain fit:** Same as 3.3 / 3.4 — needs continuous settlement
  *and* leave-pay accrual.

### 3.6 Coverage summary

Maritime archetypes (this doc's original enumeration) plus the onshore
archetypes the Cofferdam module must also serve (factory hourly/daily, per
`ENTERPRISE_MODULE_PLAN.md` rev-7.3), each mapped to its contract:

| Archetype | Market | Contract |
|---|---|---|
| 3.1 Spot / voyage / project (lump) | ~15–20% maritime | `CofferdamSpotEscrow` |
| 3.2 Day-rate spot | ~5–10% maritime | `CofferdamShiftEscrow` (Daily) |
| 3.3 Rotation + monthly | ~35–45% maritime | `CofferdamRotationEscrow` (Monthly) |
| 3.4 Rotation + per-rotation lump | ~15–20% maritime | `CofferdamRotationEscrow` (PerRotation) |
| 3.5 Fixed-term / permanent salaried | ~20–25% maritime | `CofferdamRotationEscrow` (Monthly + `endsAt`) |
| 3.7 Factory hourly (paid by hours, daily check-in/out) | onshore vertical | `CofferdamShiftEscrow` (Hourly) |
| 3.8 Factory daily (paid by days, daily check-in/out, goes home) | onshore vertical | `CofferdamShiftEscrow` (Daily) |

The three-contract family addresses **all** enumerated archetypes, onshore
and offshore. `CofferdamSpotEscrow` alone (the only contract shipped today)
covers just archetype 3.1 — ~20–25% of the maritime market and none of the
onshore shift cases — leaving the rest on the status-quo SWIFT /
payroll-service rails until `CofferdamShiftEscrow` + `CofferdamRotationEscrow`
ship.

### 3.9 US labor reality + stablecoin-payment compliance

The onshore US cases (archetypes 3.7/3.8 + the biweekly/semimonthly salaried
workers §3 added) bring a compliance surface the maritime cases mostly
sidestep. US federal (FLSA) and most state wage-payment laws require wages to
be paid in cash or a negotiable instrument **payable at par**, and several
states also restrict the *method* of payment (no scrip; employee-choice
rules). Settling wages directly in a volatile asset would not satisfy this.
Three design choices keep the on-chain path inside the lines:

**1. USDC, redeemable at par.** Net pay settles in **USDC** — a fully
reserved, USD-pegged regulated payment stablecoin — which the worker redeems
1:1 ("at par") for USD via Circle Mint → bank, or spends through a chosen
off-ramp (Valora / MiniPay / MoonPay). The worker never has to hold a
fluctuating asset to be made whole. (Payment-stablecoin footing: US GENIUS
Act + Circle's regulated issuance.)

**2. Consent is mandatory — via the OffshoreSync T&C, as an opt-in to the
Cofferdam SDK.** On-chain settlement (`settlementMethod: 'zk_contract'`) is
**opt-in**: the worker chooses the Cofferdam SDK path. That opt-in is
governed by the **OffshoreSync Terms & Conditions** — there is **no separate
Cofferdam T&C** (deferred). Consenting to receive net pay in a USD-stablecoin
is a **mandatory, non-negotiable precondition** of opting in: you cannot use
the on-chain rail without it. Consent is therefore captured **once**, at T&C
acceptance (versioned + identity-anchored), and is **not** re-collected per
settlement. (This corrects the earlier "per-settlement consent record" sketch
— consent is platform-level and mandatory, not per-payment.)

**3. Net-amount-only.** The escrow only ever moves the **net** the employer's
payroll engine already computed; withholding, tax, and benefits stay upstream
(`ENTERPRISE_MODULE_PLAN.md` §8.1). The employer remains the payer of record;
OffshoreSync/Cofferdam is the settlement rail, **not a party** to the
employment or wage obligation — consistent with the OffshoreSync T&C §8.

**Per-settlement USD-reference record (this is what *is* per-settlement).**
Each `settlePeriod()` emits `PeriodSettled(contractId, periodIndex,
netSettledUSDC, usdReferenceMicros, settledAt)`. `usdReferenceMicros` is the
USD value of the USDC settled at that moment (6-dp, matching USDC; 1:1 for
USDC, and the field future-proofs non-par or multi-asset settlement). It
makes the on-chain compliance artifact explicit — *what* net wage, in USD
terms, moved *when*, to *whom*, under *which* signed contract (`termsHash`).
The worker and employer reconcile their own payslip/tax records against this
event; Cofferdam neither computes nor files anything.

**Still off-chain / out of scope here.** Jurisdiction method-of-payment edge
cases (the few states with written-consent or specific-instrument rules) are
handled by the OffshoreSync onboarding/compliance module gating *who may opt
in*, not by the contract.

**Legal infrastructure deferred to post-production.** This section records
*design intent only*. The opt-in clause wording and the full legal
infrastructure — including the standalone Cofferdam T&C — are deliberately
sequenced **after** Cofferdam reaches production; **no OffshoreSync (or
Cofferdam) terms files are being edited now** (user direction, 2026-06-03).

## 4. Proposed split: three contracts (Spot / Shift / Rotation)

Don't extend `CofferdamSpotEscrow` (the renamed `OffshoreSyncEscrow`).
Keep it scoped to the single-settlement archetype (3.1) and add **two**
sibling contracts — one for the **onshore shift** profile, one for the
**offshore rotation** profile — so neither carries the other's weight:

- **`CofferdamSpotEscrow`** (was `OffshoreSyncEscrow`) — single-settlement,
  fixed-duration. Lifecycle `Posted → Awarded → CheckedIn → CheckedOut →
  Settled`. Archetype 3.1 (temporary/contract, voyage, project,
  single_assignment, trip).
- **`CofferdamShiftEscrow`** (NEW, onshore) — high-frequency, thin rolling
  reserve; the worker checks in/out each shift and goes home. No leave-pay,
  allotment, or severance. Cadence `Hourly | Daily`; **batched** settlement
  (gas-bounded, §8.7). Archetypes: factory-hourly (3.7), factory-daily
  (3.8), onshore day-rate / surge labour (3.2).
- **`CofferdamRotationEscrow`** (was `OffshoreSyncRecurringEscrow`) — the
  **calendar-period** base: `settlePeriod()` per cycle + `topUpReserve()` on
  demand. Its offshore origin adds a large multi-period reserve + leave-pay
  accrual + allotment split + severance/notice; the worker checks in/out once
  per hitch. Cadence `Weekly | Biweekly | SemiMonthly | Monthly | PerRotation
  | Custom`. Archetypes: rotation/monthly (3.3), rotation/per_rotation (3.4 —
  the 21-day hitch), fixed-term / permanent salaried (3.5), **plus US onshore
  W-2 payroll** (weekly/biweekly/semimonthly) which reuses this base with the
  offshore fields (leave-pay/allotment/severance) left unused and
  `payClass = W2Net`. (1099 contractors use `payClass = Contractor1099Gross`
  on the same cadences.)

**Why Shift and Rotation are separate contracts, not one cadence enum.**
The onshore shift worker and the offshore rotation seafarer have opposite
reserve/settlement profiles; merging them bloats both:

| Dimension | `CofferdamShiftEscrow` (onshore) | `CofferdamRotationEscrow` (offshore) |
|---|---|---|
| Settlement frequency | hourly / daily (high) | per-hitch / monthly (low) |
| Per-settlement amount | small | large |
| Reserve held | thin (≈1–2 days) | thick (≈1–2+ months / hitches) |
| Leave-pay accrual | none | yes (`leavePayBps`) |
| Allotment split (family) | no | yes |
| Severance / notice | no | yes |
| Settle gas strategy | **batched** (daily settles are death by gas) | per-period fine at monthly cadence |
| Check-in/out | every shift (goes home) | once per hitch |

One merged contract makes every onshore micro-settlement pay for storage
slots and code paths (leave accrual, allotment, severance) it never uses,
and saddles the offshore reserve logic with a high-frequency settle path it
never wants. Two lean contracts keep each audit small.

All three share the same `IIdentityRegistry` gate, the same arbiter (LLC
Treasury Safe), the same witness / check-in primitive (§6 of
`ENTERPRISE_MODULE_PLAN.md`), and the same fee-router pattern
(`financial/REVENUE_MODEL.md` §3.5 — a `Cofferdam{Spot,Shift,Rotation}EscrowRouter`
each). The SDK exposes three clients over a shared base; routing from a job
archetype to the right client happens off-chain (§6).

The Jobs API → contract routing happens **off-chain in the SDK**
(SDK reads `vacancy.contractType + vacancy.paymentType` and picks
the right client). The on-chain contracts don't know about Jobs
API enums — they speak in their own minimal vocabulary.

## 5. Recurring-escrow sketch (`CofferdamShiftEscrow` + `CofferdamRotationEscrow`)

Not a final API; this is the **shape** the design points at. Open
questions enumerated in §8.

> **Two contracts from one sketch (rev-7.3).** The struct below is the
> shared recurring base. **`CofferdamRotationEscrow`** (offshore) uses it in
> full. **`CofferdamShiftEscrow`** (onshore) is the *reduced* subset: drop
> `leavePayBps`, `accruedLeavePay`, the allotment split, and `severanceCap`;
> restrict `Cadence` to `Hourly | Daily`; and replace the per-period
> `settlePeriod()` with a gas-batched settle (§8.7). The identifier in the
> sketch is the pre-rename `OffshoreSyncRecurringEscrow`.

```solidity
contract OffshoreSyncRecurringEscrow {   // → CofferdamRotationEscrow (+ reduced CofferdamShiftEscrow), rev-7.3

    // Two settlement families: attendance-event (onshore shift, worker goes
    // home) and calendar-period (US W-2 payroll + offshore rotation). The US
    // private-sector frequencies (Weekly/Biweekly/SemiMonthly) settle per
    // calendar period on the CofferdamRotationEscrow base with the offshore
    // fields (leavePayBps, allotment, severance) left unused — see §4.
    enum Cadence {
        // ── Attendance-event (CofferdamShiftEscrow) ──
        Hourly,       // archetype 3.7 (factory hourly, daily check-in/out)
        Daily,        // archetypes 3.2, 3.8 (day-rate, factory daily)
        // ── Calendar-period (CofferdamRotationEscrow base) ──
        Weekly,       // US onshore — ~27% of US private payrolls
        Biweekly,     // US onshore — ~43%, the dominant US private-sector frequency
        SemiMonthly,  // US onshore — ~19%, twice/month on fixed days (e.g. 15th + last);
                      //   calendar-anchored: settled by date, NOT a constant periodSeconds
        Monthly,      // archetypes 3.3, 3.5 (rotation+monthly, contract, permanent)
        // ── Offshore rotation ──
        PerRotation,  // archetype 3.4 (per-rotation lump; 21-day hitch)
        // ── Escape hatch ──
        Custom        // arbitrary periodSeconds
    }

    // Worker classification — governs whether the settled amount is
    // post-withholding (employee) or full gross (contractor). Cofferdam never
    // computes the split; this flag only records which the upstream payroll
    // produced, keeping settlement net-amount-only (ENTERPRISE_MODULE_PLAN.md
    // §8.1) while the on-chain proof stays unambiguous about what was paid.
    enum PayClass {
        W2Net,               // employee — employer payroll already withheld; escrow settles NET
        Contractor1099Gross  // 1099 contractor — full GROSS settled; worker self-remits taxes
    }

    enum Status {
        Drafted,      // intent posted, no funds locked
        Funded,       // reserve locked, no worker yet
        Awarded,      // worker assigned, hasn't checked in
        Active,       // worker on-board / engaged; settlements flowing
        Paused,       // mid-stream pause (e.g. worker on unpaid leave, dispute)
        Closed,       // graceful end, all settled
        Cancelled,    // pre-award cancel
        Disputed,     // arbiter must resolve
        Resolved      // arbiter resolved
    }

    struct RecurringContract {
        // Parties (same shape as OffshoreSyncEscrow).
        address recruiter;
        address designatedFunder;
        address funder;
        address worker;

        // Cadence + rate.
        Cadence  cadence;
        PayClass payClass;            // W-2 net vs 1099 gross (records upstream classification; not computed here)
        uint64   periodSeconds;       // 604800 (Weekly), 1209600 (Biweekly), 86400 (Daily),
                                      //   ~2_592_000 (Monthly), workingRegime onDutyDays (PerRotation),
                                      //   arbitrary (Custom). SemiMonthly is calendar-anchored
                                      //   (two fixed pay-days/month) — periodSeconds unused, settled by date.
        uint256  ratePerPeriod;       // wei (v1) or USDC (v2) per period.

        // Reserve model. The funder pre-loads N periods of reserve so
        // the worker doesn't have to trust month-to-month wires. As
        // periods settle, the reserve drains; the funder tops it up.
        uint256  reserveLocked;       // wei currently held by the contract.
        uint256  totalSettledToWorker;// running total paid out to date.
        uint64   minReservePeriods;   // refuse-to-onboard threshold (e.g. 2)

        // Schedule.
        uint64   startedAt;           // when status moved to Active.
        uint64   lastPeriodSettledAt; // boundary timestamp for next settlePeriod().
        uint64   endsAt;              // 0 = open-ended (permanent / continuing rotation).

        // Leave-pay accrual (off the ratePerPeriod, paid on Close).
        uint16   leavePayBps;         // e.g. 833 = 8.33% per period (~1 month/year).
        uint256  accruedLeavePay;     // running total owed.

        // Termination terms.
        uint32   noticePeriodSeconds; // notice required for non-fault termination.
        uint256  severanceCap;        // cap on recruiter-side severance liability.

        bytes32  termsHash;           // keccak256 of off-chain canonical terms.
        Status   status;
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    /// HR (recruiter) drafts. No funds locked.
    function postRecurringIntent(
        bytes32 termsHash,
        Cadence cadence,
        PayClass payClass,
        uint64  periodSeconds,
        uint256 ratePerPeriod,
        uint64  minReservePeriods,
        uint64  endsAt,            // 0 = permanent
        uint16  leavePayBps,
        uint32  noticePeriodSeconds,
        uint256 severanceCap,
        address designatedFunder
    ) external returns (uint256 contractId);

    /// Finance loads the initial reserve. Must be >= minReservePeriods * ratePerPeriod.
    function fundReserve(uint256 contractId) external payable;

    /// HR awards.
    function awardContract(uint256 contractId, address worker) external;

    /// Worker checks in → Status.Active, clock starts.
    function checkIn(uint256 contractId) external;

    /// Anyone (worker, recruiter, keeper bot) can call. Pays out
    /// (elapsed_periods * ratePerPeriod) - totalSettledToWorker
    /// from reserveLocked, accrues leavePayBps on the settled amount.
    /// Emits PeriodSettled(contractId, periodIndex, netSettledUSDC,
    /// usdReferenceMicros, settledAt) — the per-settlement USD-reference
    /// record for the worker's/employer's tax + audit trail (§3.9).
    function settlePeriod(uint256 contractId) external;

    /// Funder tops up reserve to keep the stream healthy. Indexers
    /// surface "X periods of runway remaining" off this state.
    function topUpReserve(uint256 contractId) external payable;

    /// Mid-tour advance. Worker can pull up to `pendingAccrual` of
    /// not-yet-settled rate (the "allotment" pattern). Bounded by a
    /// contract-level advance ratio (e.g. ≤50% of one period).
    function requestAdvance(uint256 contractId, uint256 amount) external;

    /// Either party can pause (e.g. worker on unpaid leave, dispute
    /// pending). Stops accrual until unpaused.
    function pause(uint256 contractId) external;
    function unpause(uint256 contractId) external;

    /// Graceful close. Settles outstanding period dues + accrued
    /// leave pay + (optional) severance. Refunds remaining reserve
    /// to funder.
    function closeContract(uint256 contractId, uint256 severanceWei) external;

    /// Standard dispute / resolveDispute, same shape as the
    /// existing OffshoreSyncEscrow.
    function dispute(uint256 contractId, string calldata reason) external;
    function resolveDispute(uint256 contractId, address payee, uint256 amount) external;

    // ── Reads ──────────────────────────────────────────────────────

    function getContract(uint256 contractId) external view returns (RecurringContract memory);
    function pendingSettlement(uint256 contractId) external view returns (uint256);
    function runwayPeriods(uint256 contractId) external view returns (uint256);
    function pendingLeavePay(uint256 contractId) external view returns (uint256);
}
```

### 5.1 Why "reserve + period settle" and not "stream per second"

Sablier / Superfluid model: `flowRate * elapsedTime` is computed
on-chain at every read. Beautiful for DeFi, hostile to maritime
payroll because:

- **Audit trail.** Maritime finance teams reconcile against the
  shipping company's HR cycle — they want monthly settlement events,
  not a continuously-changing balance. `settlePeriod()` produces a
  discrete `PeriodSettled` event per cycle, which maps 1-to-1 to a
  payroll ledger entry.
- **Off-ramp UX.** Crew off-ramping through Valora / MiniPay want a
  single confirmable wire of "this month's salary", not a hundred
  micro-claims. Bulk settle → bulk off-ramp.
- **Fee model.** `financial/REVENUE_MODEL.md` charges a flat 0.5%
  (no cap, post rev-7) *per fee event*. Per-second streaming would
  need a separate fee semantics; per-period settlement keeps the
  existing fee model intact (open question §8.4).
- **Gas predictability.** Per-period settlement = one tx per period.
  Continuous streaming = one tx per claim (any time) + on-chain
  arithmetic on every read. Period settle is cheaper at the
  maritime cadence (monthly), more predictable for forecasting
  paymaster sponsorship.

### 5.2 Why reserve and not pull-from-EOA

Status-quo trust model: every month the company's Finance team has
to actually wire the salary. **That's exactly the failure mode
on-chain we want to fix.** The whole appeal of the on-chain rail is
"the worker doesn't have to trust the funder to wire monthly —
they trust the immutable contract holding N months of reserve".

A `minReservePeriods` of 2 means: at any moment, the contract is
holding at least two months' salary. If the funder vanishes /
defaults / goes bankrupt, the worker has runway to either continue
working with confidence or terminate cleanly.

The funder tops up `topUpReserve` whenever their treasury cadence
allows (monthly batch wire from Lili → Circle Mint → reserve).

## 6. SDK integration

The SDK is the **only** layer that knows about the Jobs API enums.
Routing logic in `OffshoreSyncEscrowClient.fromVacancy(vacancy)`:

```ts
import {
  OffshoreSyncEscrowClient,
  OffshoreSyncRecurringEscrowClient,
  Cadence,
  PayClass,
} from '@cofferdam/sdk'

export function clientForVacancy(vacancy, signer) {
  const { contractType, temporaryType, compensation } = vacancy

  // Archetype 3.1 — single-settlement fixed task.
  if (
    contractType === 'temporary' &&
    compensation.paymentType === 'contract' &&
    ['voyage', 'project', 'single_assignment', 'trip'].includes(temporaryType)
  ) {
    return new OffshoreSyncEscrowClient({ signer, ... })
  }

  // Archetypes 3.2–3.5 + US onshore W-2 payroll — recurring.
  const cadence =
    compensation.paymentType === 'daily'        ? Cadence.Daily       :
    compensation.paymentType === 'weekly'       ? Cadence.Weekly      :
    compensation.paymentType === 'biweekly'     ? Cadence.Biweekly    :
    compensation.paymentType === 'semimonthly'  ? Cadence.SemiMonthly :
    compensation.paymentType === 'monthly'      ? Cadence.Monthly     :
    compensation.paymentType === 'per_rotation' ? Cadence.PerRotation :
    /* paymentType === 'contract' && contractType !== 'temporary' */
    Cadence.Monthly  // fixed-term salaried — treat as monthly stream with endsAt set

  // W-2 employees settle net (employer withheld upstream); 1099 settle gross.
  const payClass = compensation.workerClass === '1099'
    ? PayClass.Contractor1099Gross
    : PayClass.W2Net

  return new OffshoreSyncRecurringEscrowClient({ signer, cadence, payClass, ... })
}
```

The Jobs API itself doesn't change. The `settlementMethod: 'zk_contract'`
field in the VacancyComposer (currently UI-disabled) becomes the toggle
that turns on this routing. The composer is already aware of the
two-method choice; it just needs the second method to actually have a
contract behind it.

### 6.1 What the OffshoreSync app calls

When a recruiter posts a vacancy with `settlementMethod: 'zk_contract'`
and a candidate is hired:

1. SDK reads `vacancy.contractType + compensation.paymentType + workingRegime`.
2. Picks `OffshoreSyncEscrowClient` (archetype 3.1) or
   `OffshoreSyncRecurringEscrowClient` (everything else).
3. Calls `postContractIntent` (single-settlement) or
   `postRecurringIntent` (multi-period).
4. Designated funder funds reserve / lump.
5. Worker checks in.
6. **For recurring contracts only**: a Cofferdam keeper bot calls
   `settlePeriod()` at every cycle boundary (cron-driven; runs on
   Cloudflare Workers, sponsored by the paymaster). No human
   intervention needed for the steady-state monthly settlement.
7. At graceful end: `closeContract()` (recurring) or `checkOut()` +
   `settle()` (single).

The OffshoreSync UI then displays:

- "Reserve runway: 2.3 periods" (so the worker can see runway in real
  time and the funder knows when to top up).
- "Accrued leave pay: $1,250.00" (visible to worker as soon as it
  starts accruing).
- "Last settlement: 2026-05-01" + tx hash for every period.

## 7. Implementation order

This is sized as **β work**, not α-3 — too large and audit-heavy
for the α-3 paymaster cycle.

1. **Spec freeze on the OffshoreSyncRecurringEscrow ABI.** All the
   open questions in §8 resolved, written into this file's §5.
2. **Contract implementation + hardhat tests.** Mirrors the
   `OffshoreSyncEscrow` test suite scale (~50 tests minimum,
   covering each archetype, cadence, leave-pay edge case, mid-tour
   advance, pause/unpause, severance, refund-on-close).
3. **SDK client** `OffshoreSyncRecurringEscrowClient` in
   `@cofferdam/sdk/escrow`. Shares a base class with
   `OffshoreSyncEscrowClient` for `dispute` / `resolveDispute` /
   identity-bound checks.
4. **Cofferdam keeper bot** — Cloudflare Worker cron that polls
   active recurring contracts and calls `settlePeriod()` at each
   cycle boundary. Sponsored gas via paymaster. Audit-logged.
5. **Jobs API routing** — `clientForVacancy()` helper in the SDK +
   the OffshoreSync app wiring it into the post-hire flow.
6. **Unlock `settlementMethod: 'zk_contract'`** in the
   VacancyComposer once the keeper bot is live in production.
7. **USDC denomination at v2.** ETH (v1) is the right denomination
   for α-2 PoC; β must be USDC to be touchable by corporate
   treasuries. See `OffshoreSyncEscrow.sol` deferred-from-α-2 note.

Total LOC estimate: ~600 Solidity + ~400 TypeScript + ~100 cron.
Audit cycle: ~4–6 weeks for the new contract alone, sharing the
auditor and groundwork with the paymaster.

## 8. Open questions

### 8.1 Per-period fee or per-contract fee?

`financial/REVENUE_MODEL.md` §3.1 specifies a flat 0.5% (no cap,
post rev-7) **per contract**. For a 24-month rotation paying
$5k/month, that single-fee interpretation means the funder is
charged **$600 upfront** (0.5% × $120k notional) at `fundContract`
time — covering 24 months of service in one lump-sum payment. With
the rev-7 cap removed, the revenue total is now correct (0.5% ×
$120k = $600, 12× cheaper than the SWIFT-stack baseline), but the
**cash-flow shape** is wrong: the funder's reserve top-up cadence
is monthly, not lump-sum.

The intuition fix: charge **per `settlePeriod` event**, same flat
0.5% rate. Twenty-four monthly settles × $25 = **$600 total fee
on $120k throughput, identical revenue, but spread across the same
24 cash-flow events as the underlying payroll**. Aligns the fee
cadence with the value-delivery cadence; matches the funder's
reserve-top-up rhythm; eliminates the upfront lump-sum-fee friction.
Also interacts more cleanly with the future §7.6 $COFF staking-
discount channel — each `settlePeriod` event re-applies the
staked-tier rate at the moment of charging, rather than locking in
a 24-month-forward rate at funding time.

**Pending decision** — to be locked into REVENUE_MODEL.md once we
have a signal from the first real customer on whether per-period
shows up in their cost-of-payroll calculation as more or less
acceptable than the single-fee variant.

### 8.2 Leave-pay calculation: simple or jurisdiction-aware?

Naive: `accruedLeavePay = totalSettledToWorker * leavePayBps / 10_000`.

Real maritime: leave entitlement varies by flag state, contract type,
ITF Total Crew Cost band, and seafarer nationality. A Panama-flag
vessel with a Filipino crew under POEA has different statutory leave
than a Norwegian-flag vessel with EEA crew under NIS.

**v1 stance:** stick to naive. The marketplace surfaces the correct
`leavePayBps` for the jurisdiction off-chain (in the vacancy
composer's helper text) and the contract just executes what it's
told. Jurisdiction logic lives off-chain in the OffshoreSync
back-end's compliance module. The contract is dumb math.

### 8.3 What happens to the reserve on `dispute`?

Current `OffshoreSyncEscrow` freezes the lump until `resolveDispute`.
For a recurring contract, freezing the entire reserve is harsh on
the worker (they'd lose access to already-earned wages).

**Proposed:** `dispute` freezes only future settlements (reserve
stays held by contract). `resolveDispute(payee, amount)` is the
arbiter's lever — they can settle pending dues to the worker,
refund partial reserve to the funder, etc.

Worth modelling carefully in §5 once a real dispute scenario is
walked through. Add to the test suite.

### 8.4 Termination notice: how strict?

Real-life norm: 30-day notice for permanent, contractual
termination clauses for fixed-term. The on-chain `closeContract`
should respect `noticePeriodSeconds` (probably: closing within
notice window = mandatory severance ≥ `noticePeriodSeconds *
ratePerPeriod / periodSeconds`).

**Edge case:** worker abandons mid-tour. Recruiter calls
`closeContract` after a grace window with zero severance; the
contract emits a `WorkerAbandoned` event for compliance ledger.

### 8.5 What about `temporary/day_rate`?

Routes to `Cadence.Daily` in the recurring escrow with `endsAt`
fixed at vacancy end. Effectively a finite-horizon stream with
1-day cadence. Tests should cover this explicitly because it sits
on the boundary between "temporary" and "recurring".

### 8.6 What about `paymentType='contract'` on a non-temporary vacancy?

The Jobs API allows `contractType='permanent' + paymentType='contract'`
which is semantically odd ("permanent employment, paid once at end of
contract"). Likely a UI bug or a legitimate but rare pattern. The
SDK's `clientForVacancy` should reject this combination with a
clear error rather than silently coerce. Add validation upstream in
the Jobs API.

### 8.7 Per-day cadence vs continuous: is Daily worth it?

For day-rate spot, a single daily `settlePeriod()` per worker is
~$0.10 gas + $0.01 paymaster overhead. Over a 14-day stint that's
$1.40 in gas — material against a $200/day rate. Worth modelling
**batched daily** settlement (settle weekly or at job end) for
day-rate vacancies, where the contract still accrues daily but the
settle event is rate-limited. Open: where to draw the rate-limit
line.

### 8.8 ABI-stable evolution path

The current `OffshoreSyncEscrow.sol` ships `Status.Drafted` appended
at value 8 to preserve binary ABI compat (see contract docstring).
The new contract is a separate deployment — no ABI-compat concerns
between them. But the **SDK's** `EscrowStatus` union should be
namespaced (`SpotEscrowStatus | RecurringEscrowStatus`) so we don't
accidentally cross-contaminate.

## 9. Relationship to existing α-3 work

| α-3 task | Recurring escrow impact |
|---|---|
| `OffshoreSyncPaymaster.sol` | Must sponsor `settlePeriod`, `topUpReserve`, `requestAdvance`, `checkIn`, `pause`, `unpause`, `closeContract`. The funder still pays for `fundReserve` directly (real money movement). |
| `OffshoreSyncEscrowRouter.sol` (fee router) | Needs a sibling `OffshoreSyncRecurringEscrowRouter.sol` that injects fee on `fundReserve` + `topUpReserve`. Open: also fee on `settlePeriod` (§8.1)? |
| Pre-flight `isAccountBound` UX hook | Unchanged. Reuses the same hook. |
| v2 USDC migration | Must land for recurring escrow at the same time as for the spot escrow. ETH-denominated payroll has no production legs. |

## 10. What this design explicitly does NOT cover

- **On-chain HR functionality** (time-off requests, sick days,
  jurisdiction tax withholding, statutory contribution remittance).
  Lives off-chain in the OffshoreSync HR module; the on-chain
  contract just sees periods and amounts.
- **Bonus / variable-pay structures** (performance bonuses,
  end-of-tour completion bonuses, overtime). Modelled as separate
  one-off `OffshoreSyncEscrow` contracts, posted as needed.
  Keeps the recurring contract simple.
- **Foreign-exchange handling.** Contract is denominated in one
  asset (ETH v1, USDC v2). FX into local fiat happens at the
  off-ramp layer (Valora / MiniPay / MoonPay), outside the
  contract.
- **Multi-worker contracts** (e.g. "this contract pays a whole
  crew of 12"). Each worker gets their own recurring contract.
  Bulk operations are an SDK-level concern.

## 11. Change log

- 2026-06-03 (rev-7.3b) — Stablecoin-payment compliance + consent model. New
  §3.9 (US labor reality + stablecoin-payment compliance): net pay settles in
  **USDC redeemable at par** (satisfies FLSA "payable at par"); **consent to
  stablecoin payment is mandatory and obtained through the OffshoreSync Terms
  & Conditions as an opt-in to the Cofferdam SDK** — on-chain settlement is
  opt-in, but consenting to USDC is a non-negotiable precondition of it,
  captured once at T&C acceptance (versioned, identity-anchored), **not**
  per-settlement. A standalone **Cofferdam T&C is deferred**; the OffshoreSync
  T&C is the sole consent vehicle for now. This corrects the earlier
  "per-settlement consent record" idea. What *is* per-settlement: a
  USD-reference record — `settlePeriod()` now documents a `PeriodSettled(
  contractId, periodIndex, netSettledUSDC, usdReferenceMicros, settledAt)`
  event as the tax/audit artifact. Net-amount-only + employer-is-payer-of-
  record posture reaffirmed (`ENTERPRISE_MODULE_PLAN.md` §8.1; OffshoreSync
  T&C §8 — "not a party" to compensation). Per user direction (2026-06-03),
  the consent-clause wording + full legal infrastructure (incl. the standalone
  Cofferdam T&C) are **deferred until post-production**; **no terms files are
  edited now** — §3.9 records design intent only.
- 2026-06-02 (rev-7.3a) — US calendar-period payroll cadences + worker
  classification. Added `Weekly`, `Biweekly`, `SemiMonthly` to the `Cadence`
  enum (biweekly is the dominant US private-sector frequency; previously only
  reachable via `Custom`), grouped the enum into attendance-event vs
  calendar-period families, and flagged that SemiMonthly is calendar-anchored
  (two fixed pay-days/month — settled by date, not a constant `periodSeconds`).
  Added a `PayClass` enum (`W2Net | Contractor1099Gross`) + a `payClass` field
  on `RecurringContract` and a `payClass` param on `postRecurringIntent`,
  recording the upstream W-2-net vs 1099-gross classification **without**
  computing it (settlement stays net-amount-only, `ENTERPRISE_MODULE_PLAN.md`
  §8.1). US onshore W-2 payroll settles on the `CofferdamRotationEscrow`
  calendar-period base with the offshore fields (leave-pay/allotment/severance)
  unused (§4). SDK `clientForVacancy` routing + example extended. (The §3.9
  compliance section + per-settlement USD-reference record landed in rev-7.3b,
  which also reframed worker consent as a mandatory OffshoreSync-T&C opt-in to
  the Cofferdam SDK rather than a per-settlement record.)
- 2026-06-02 (rev-7.3) — Split the recurring half in two and renamed the
  family to `Cofferdam*`. The escrow is now three contracts —
  `CofferdamSpotEscrow` (was `OffshoreSyncEscrow`), `CofferdamShiftEscrow`
  (new, onshore hourly/daily), `CofferdamRotationEscrow` (was
  `OffshoreSyncRecurringEscrow`, offshore hitch/monthly) — so one contract
  never carries both the high-frequency-small and low-frequency-large
  reserve profiles (§4). Added an `Hourly` cadence + onshore archetypes
  3.7/3.8 (factory hourly/daily). Driven by `ENTERPRISE_MODULE_PLAN.md`
  rev-7.3 (the enterprise module is a Cofferdam product serving onshore +
  offshore, not maritime-only). The `.sol`/test/SDK/deployment rename + the
  ShiftEscrow build are tracked there as the §14 code migration.
- 2026-05-28 — Initial design draft. Five archetypes enumerated,
  contract sketch in §5, integration plan in §6, open questions
  in §8. Implementation deferred to β; not in the α-3 critical
  path. No on-chain code written yet — this document is the spec.
