// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title OffshoreSyncEscrow
/// @notice Native-ETH job-contract escrow with two posting paths:
///
///         1. **Self-funded** (α-2; solo operators / small businesses):
///            `postContract{value: amount}(termsHash)` — recruiter posts AND
///            funds in a single tx.
///
///         2. **Multi-party / corporate** (α-3; the typical company flow
///            where HR ≠ Finance):
///            `postContractIntent(termsHash, amount, designatedFunder)`
///              → contract created in `Drafted` state, no funds locked yet.
///            `fundContract{value: amount}(contractId)`  (called by Finance)
///              → funds locked, transitions to `Posted`.
///
///         Both paths converge at `Posted`; everything after that
///         (`awardContract`, `checkIn`, `checkOut`, `settle`, `cancel`,
///         `dispute`, `resolveDispute`) is identical between paths.
///
///         Refunds and recruiter-side dispute payouts go to whoever actually
///         fronted the money (`c.funder`), not to the recruiter. For the
///         self-funded path `funder == recruiter`, so behaviour is preserved.
///
/// @dev    α-2 → α-3 scope:
///           - Native ETH only. ERC-20 / USDC support is β-blocking
///             (production corporate treasuries hold USDC, not ETH).
///           - Identity-gated on both sides: every state-mutating call from
///             a recruiter / funder / worker requires
///             `identity.isAccountBound(msg.sender) == true`. This is the
///             cryptographic mooring — no Cofferdam-verified identity, no
///             on-chain employment relationship.
///           - Disputes resolved by the contract owner (LLC Treasury Safe in
///             production; test rich-wallet in local dev). On-chain arbitration
///             / juror voting is out of scope for the PoC.
///           - Off-chain content: the contract description, terms, milestone
///             schedule, etc. live off-chain (IPFS / S3 / Postgres). Only the
///             keccak256 of the canonical terms blob is committed on-chain.
///             The worker accepts an award knowing this hash; if the recruiter
///             tries to substitute different terms later, the hash mismatch
///             is verifiable off-chain by any auditor.
///           - The recruiter ↔ funder coordination ("hey Maria, can you sign
///             the funding?") happens off-chain via the Cofferdam messaging
///             primitive + push notifications. The chain just sees addresses.
///
///         Reentrancy: native-ETH transfers happen at exactly three state
///         transitions (`settle` → pay worker; `cancel` → refund funder;
///         `resolveDispute` → pay funder or worker). All use the
///         checks-effects-interactions pattern + a single reentrancy guard.
///         We don't pull in OZ for this — codebase convention is inlined
///         minimal primitives.
contract OffshoreSyncEscrow {
    // ────────────────────────────────────────────────────────────────────────
    // Wiring
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Identity-binding source. α-2: `OffshoreSyncReceiver`. α-3: LZ
    ///         variant of the same. v2: `v2/self/NullifierRegistry`. The
    ///         escrow only depends on the `IIdentityRegistry` interface, so
    ///         the era swap is a deploy-config change.
    IIdentityRegistry public immutable identity;

    /// @notice Dispute arbiter. In production this is the OffshoreSync LLC
    ///         Treasury Safe (handed off via two-step transfer); in local
    ///         dev tests it's a rich-wallet EOA. Distinct from "the deployer
    ///         EOA": the deployer's authority ends the moment ownership is
    ///         transferred to the Safe.
    address public owner;
    address public pendingOwner;

    // ────────────────────────────────────────────────────────────────────────
    // Job-contract state machine
    // ────────────────────────────────────────────────────────────────────────

    /// @dev `Drafted` is appended (value 8) rather than prepended so that
    ///      existing numeric encodings of Posted=0..Resolved=7 are stable.
    ///      Reads less naturally as a lifecycle but preserves ABI compat
    ///      with the α-2 shipped binary.
    enum Status {
        Posted,     // 0 — funds locked; no worker yet (entry state for self-funded path)
        Awarded,    // 1 — recruiter has assigned a worker; worker has not yet checked in
        CheckedIn,  // 2 — worker is on-site / engaged
        CheckedOut, // 3 — worker has finished; waiting for settlement
        Settled,    // 4 — funds released to worker; terminal
        Cancelled,  // 5 — recruiter cancelled before award; funds refunded (if any); terminal
        Disputed,   // 6 — either party raised a dispute; arbiter must resolve
        Resolved,   // 7 — arbiter has resolved a dispute; terminal
        Drafted     // 8 — intent posted, awaiting funding (entry state for corporate path)
    }

    struct JobContract {
        address recruiter;
        address designatedFunder; // address(0) on self-funded path OR "open funding" intent
        address funder;           // address(0) until funded; realised payer (for refunds)
        address worker;           // address(0) until awarded
        uint256 amount;           // wei committed at intent / locked at funding
        bytes32 termsHash;        // keccak256 of canonical off-chain terms blob
        uint64 draftedAt;         // 0 if posted via the self-funded path
        uint64 postedAt;          // set when funded (or at postContract time for self-funded)
        uint64 awardedAt;
        uint64 checkedInAt;
        uint64 checkedOutAt;
        Status status;
    }

    /// @notice Monotonically-increasing contract id. Starts at 1; 0 is a
    ///         sentinel meaning "no such contract".
    uint256 public nextContractId = 1;

    mapping(uint256 => JobContract) public contracts;

    // ────────────────────────────────────────────────────────────────────────
    // Events
    // ────────────────────────────────────────────────────────────────────────

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted on the corporate-flow entry point. The contract is in
    ///         `Drafted` state with no funds locked.
    event ContractDrafted(
        uint256 indexed contractId,
        address indexed recruiter,
        address indexed designatedFunder, // address(0) means "open funding"
        uint256 amount,
        bytes32 termsHash
    );

    /// @notice Emitted when a draft is funded by `funder`. Indexers can
    ///         treat this as "the corporate-path equivalent of
    ///         ContractPosted". Note that fundContract ALSO emits
    ///         `ContractPosted` so a single listener works for both paths.
    event ContractFunded(
        uint256 indexed contractId,
        address indexed funder,
        uint256 amount
    );

    /// @notice Emitted when a recruiter cancels their own draft before any
    ///         funder has paid. No refund involved (no funds were locked).
    event DraftCancelled(
        uint256 indexed contractId,
        address indexed recruiter
    );

    event ContractPosted(
        uint256 indexed contractId,
        address indexed recruiter,
        uint256 amount,
        bytes32 termsHash
    );
    event ContractAwarded(
        uint256 indexed contractId,
        address indexed recruiter,
        address indexed worker
    );
    event WorkerCheckedIn(uint256 indexed contractId, address indexed worker, uint64 at);
    event WorkerCheckedOut(uint256 indexed contractId, address indexed worker, uint64 at);
    event ContractSettled(
        uint256 indexed contractId,
        address indexed worker,
        uint256 amount
    );
    event ContractCancelled(
        uint256 indexed contractId,
        address indexed recruiter,
        uint256 refund
    );
    event ContractDisputed(
        uint256 indexed contractId,
        address indexed by,
        string reason
    );
    event DisputeResolved(
        uint256 indexed contractId,
        address indexed arbiter,
        address paidTo,
        uint256 amount
    );

    // ────────────────────────────────────────────────────────────────────────
    // Errors
    // ────────────────────────────────────────────────────────────────────────

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroTermsHash();
    error AccountNotBound(address account);
    error UnknownContract(uint256 contractId);
    error WrongStatus(Status expected, Status got);
    error NotRecruiter(address caller, address recruiter);
    error NotWorker(address caller, address worker);
    error NotParticipant(address caller);
    error EthTransferFailed(address to, uint256 amount);
    error Reentrant();
    error PayeeMustBeParticipant(address payee);
    error NotDesignatedFunder(address caller, address designatedFunder);
    error WrongFundingAmount(uint256 expected, uint256 got);

    // ────────────────────────────────────────────────────────────────────────
    // Reentrancy guard (inlined; codebase convention)
    // ────────────────────────────────────────────────────────────────────────

    uint256 private _reentrancyStatus = 1; // 1 = not entered; 2 = entered

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) revert Reentrant();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Identity gate. Bypassed for `owner` so the arbiter doesn't need
    ///      a Cofferdam identity to resolve disputes (it's the LLC Safe).
    modifier onlyBoundAccount() {
        if (!identity.isAccountBound(msg.sender)) {
            revert AccountNotBound(msg.sender);
        }
        _;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Constructor
    // ────────────────────────────────────────────────────────────────────────

    constructor(address _identity, address _initialOwner) {
        if (_identity == address(0)) revert ZeroAddress();
        if (_initialOwner == address(0)) revert ZeroAddress();
        identity = IIdentityRegistry(_identity);
        owner = _initialOwner;
        emit OwnershipTransferred(address(0), _initialOwner);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Ownership transfer (two-step)
    // ────────────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function renounceOwnership() external onlyOwner {
        address previous = owner;
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, address(0));
    }

    // ────────────────────────────────────────────────────────────────────────
    // Job-contract lifecycle
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Post a new job contract. Caller must be a Cofferdam-verified
    ///         recruiter and must lock the contract amount as `msg.value`.
    /// @param  termsHash  keccak256 of the canonical off-chain terms blob.
    ///                    Worker validates this hash off-chain before
    ///                    accepting the award.
    /// @return contractId The id of the freshly-created contract.
    function postContract(bytes32 termsHash)
        external
        payable
        onlyBoundAccount
        returns (uint256 contractId)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (termsHash == bytes32(0)) revert ZeroTermsHash();

        contractId = nextContractId++;
        contracts[contractId] = JobContract({
            recruiter: msg.sender,
            designatedFunder: msg.sender, // self-funded ⇒ recruiter is also the designated funder
            funder: msg.sender,           // and the realised funder, paid in this tx
            worker: address(0),
            amount: msg.value,
            termsHash: termsHash,
            draftedAt: 0,                 // self-funded path skips the Drafted state
            postedAt: uint64(block.timestamp),
            awardedAt: 0,
            checkedInAt: 0,
            checkedOutAt: 0,
            status: Status.Posted
        });

        emit ContractPosted(contractId, msg.sender, msg.value, termsHash);
    }

    /// @notice Corporate-flow entry point: recruiter (HR) posts a contract
    ///         intent without locking any funds. The designated funder
    ///         (Finance) must then call `fundContract` to actually lock
    ///         the money and move the contract into the `Posted` state.
    ///
    /// @dev    UX coordination between recruiter and funder (notifications,
    ///         chat, contact-graph discovery) happens off-chain via the
    ///         Cofferdam SDK. The on-chain contract just sees addresses.
    ///
    /// @param termsHash         keccak256 of canonical off-chain terms blob.
    /// @param amount            wei to be locked at funding time.
    /// @param designatedFunder  address allowed to fund this intent. Pass
    ///                          `address(0)` for "open funding" (any
    ///                          Cofferdam-bound account can fund) — useful
    ///                          for solo recruiters who want to leave the
    ///                          door open.
    /// @return contractId The id of the freshly-drafted contract.
    function postContractIntent(
        bytes32 termsHash,
        uint256 amount,
        address designatedFunder
    )
        external
        onlyBoundAccount
        returns (uint256 contractId)
    {
        if (amount == 0) revert ZeroAmount();
        if (termsHash == bytes32(0)) revert ZeroTermsHash();
        // `designatedFunder == address(0)` is intentionally allowed (open funding).

        contractId = nextContractId++;
        contracts[contractId] = JobContract({
            recruiter: msg.sender,
            designatedFunder: designatedFunder,
            funder: address(0),
            worker: address(0),
            amount: amount,
            termsHash: termsHash,
            draftedAt: uint64(block.timestamp),
            postedAt: 0,
            awardedAt: 0,
            checkedInAt: 0,
            checkedOutAt: 0,
            status: Status.Drafted
        });

        emit ContractDrafted(contractId, msg.sender, designatedFunder, amount, termsHash);
    }

    /// @notice Fund a drafted contract. Caller must be the `designatedFunder`
    ///         (or anyone, if the draft was created with "open funding").
    ///         Caller must be Cofferdam-verified and the value sent must
    ///         match the committed amount exactly.
    function fundContract(uint256 contractId)
        external
        payable
        onlyBoundAccount
    {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Drafted);

        // If the recruiter pinned a specific funder, enforce it.
        // address(0) = open funding (anyone Cofferdam-bound can fund).
        if (c.designatedFunder != address(0) && msg.sender != c.designatedFunder) {
            revert NotDesignatedFunder(msg.sender, c.designatedFunder);
        }
        if (msg.value != c.amount) {
            revert WrongFundingAmount(c.amount, msg.value);
        }

        c.funder = msg.sender;
        c.postedAt = uint64(block.timestamp);
        c.status = Status.Posted;

        emit ContractFunded(contractId, msg.sender, msg.value);
        // Also emit ContractPosted so indexers that listen on "contract is
        // ready to award" don't need to special-case the corporate path.
        emit ContractPosted(contractId, c.recruiter, msg.value, c.termsHash);
    }

    /// @notice Recruiter cancels their own draft before any funder has paid.
    ///         No fund transfer happens (no funds were ever locked).
    function cancelDraft(uint256 contractId)
        external
        onlyBoundAccount
    {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Drafted);
        if (msg.sender != c.recruiter) revert NotRecruiter(msg.sender, c.recruiter);

        c.status = Status.Cancelled;
        emit DraftCancelled(contractId, msg.sender);
    }

    /// @notice Award a posted contract to a specific worker. Both recruiter
    ///         (caller) and worker must be Cofferdam-verified.
    /// @dev    Recruiter-driven on purpose: in production the worker's
    ///         acceptance happens off-chain (Cofferdam Partners dashboard);
    ///         the on-chain award is the recruiter committing to that
    ///         off-chain match.
    function awardContract(uint256 contractId, address workerAccount)
        external
        onlyBoundAccount
    {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Posted);
        if (msg.sender != c.recruiter) revert NotRecruiter(msg.sender, c.recruiter);
        if (workerAccount == address(0)) revert ZeroAddress();
        if (!identity.isAccountBound(workerAccount)) {
            revert AccountNotBound(workerAccount);
        }

        c.worker = workerAccount;
        c.awardedAt = uint64(block.timestamp);
        c.status = Status.Awarded;

        emit ContractAwarded(contractId, c.recruiter, workerAccount);
    }

    /// @notice Worker proof-of-presence: arrival. Records `block.timestamp`.
    function checkIn(uint256 contractId) external onlyBoundAccount {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Awarded);
        if (msg.sender != c.worker) revert NotWorker(msg.sender, c.worker);

        c.checkedInAt = uint64(block.timestamp);
        c.status = Status.CheckedIn;

        emit WorkerCheckedIn(contractId, msg.sender, c.checkedInAt);
    }

    /// @notice Worker proof-of-presence: completion. Records `block.timestamp`.
    function checkOut(uint256 contractId) external onlyBoundAccount {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.CheckedIn);
        if (msg.sender != c.worker) revert NotWorker(msg.sender, c.worker);

        c.checkedOutAt = uint64(block.timestamp);
        c.status = Status.CheckedOut;

        emit WorkerCheckedOut(contractId, msg.sender, c.checkedOutAt);
    }

    /// @notice Release escrowed funds to the worker. Callable by anyone once
    ///         the contract has reached `CheckedOut` (the worker, recruiter,
    ///         a relayer / paymaster, or a Cofferdam keeper bot).
    /// @dev    Public-on-purpose so the worker doesn't need to pay gas if a
    ///         paymaster / keeper is willing to.
    function settle(uint256 contractId) external nonReentrant {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.CheckedOut);

        address worker = c.worker;
        uint256 amount = c.amount;

        // Effects before interaction
        c.amount = 0;
        c.status = Status.Settled;

        emit ContractSettled(contractId, worker, amount);

        _sendEth(worker, amount);
    }

    /// @notice Recruiter cancels a posted-but-not-yet-awarded contract.
    ///         Refunds the locked amount to whoever actually fronted it
    ///         (`c.funder`), which for the self-funded path is the recruiter
    ///         themselves — preserving α-2 behaviour.
    function cancel(uint256 contractId) external nonReentrant onlyBoundAccount {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Posted);
        if (msg.sender != c.recruiter) revert NotRecruiter(msg.sender, c.recruiter);

        uint256 refund = c.amount;
        address recruiter = c.recruiter;
        address refundTo = c.funder; // self-funded: == recruiter; corporate: Finance

        c.amount = 0;
        c.status = Status.Cancelled;

        emit ContractCancelled(contractId, recruiter, refund);

        _sendEth(refundTo, refund);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Dispute path
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Either party raises a dispute. Freezes the contract pending
    ///         arbiter resolution. Allowed from any non-terminal state.
    /// @param  reason  Free-form string committed on-chain for auditability.
    ///                 Keep short — long reasons should live off-chain with
    ///                 their hash included here as a reference.
    function dispute(uint256 contractId, string calldata reason)
        external
        onlyBoundAccount
    {
        JobContract storage c = _mustExist(contractId);
        if (
            c.status == Status.Settled ||
            c.status == Status.Cancelled ||
            c.status == Status.Resolved ||
            c.status == Status.Disputed
        ) {
            revert WrongStatus(Status.Posted, c.status); // "any active state"
        }
        if (msg.sender != c.recruiter && msg.sender != c.worker) {
            revert NotParticipant(msg.sender);
        }

        c.status = Status.Disputed;
        emit ContractDisputed(contractId, msg.sender, reason);
    }

    /// @notice Arbiter (`owner`) resolves a disputed contract by paying the
    ///         full escrowed amount to one of the two participants.
    /// @dev    PoC arbitration. Splits / partial refunds are not modelled in
    ///         α-2; if needed, arbiter can off-chain settle the difference
    ///         and pay the lump to one party here. Designed to be replaced
    ///         by an on-chain arbitration mechanism (jurors / committee /
    ///         Kleros-style) in a later era without changing the rest of
    ///         the escrow.
    /// @dev `payee` must be the worker (worker-side wins) or the funder
    ///      (recruiter-side wins — refund goes to whoever paid, not to HR).
    ///      For self-funded contracts `funder == recruiter`, so passing the
    ///      recruiter address still works and α-2 tests are preserved.
    function resolveDispute(uint256 contractId, address payee)
        external
        nonReentrant
        onlyOwner
    {
        JobContract storage c = _mustExist(contractId);
        _mustBeStatus(c, Status.Disputed);
        if (payee != c.funder && payee != c.worker) {
            revert PayeeMustBeParticipant(payee);
        }

        uint256 amount = c.amount;
        c.amount = 0;
        c.status = Status.Resolved;

        emit DisputeResolved(contractId, msg.sender, payee, amount);

        _sendEth(payee, amount);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Read helpers
    // ────────────────────────────────────────────────────────────────────────

    function getContract(uint256 contractId)
        external
        view
        returns (JobContract memory)
    {
        JobContract memory c = contracts[contractId];
        if (c.recruiter == address(0)) revert UnknownContract(contractId);
        return c;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Internal
    // ────────────────────────────────────────────────────────────────────────

    function _mustExist(uint256 contractId) private view returns (JobContract storage c) {
        c = contracts[contractId];
        if (c.recruiter == address(0)) revert UnknownContract(contractId);
    }

    function _mustBeStatus(JobContract storage c, Status expected) private view {
        if (c.status != expected) revert WrongStatus(expected, c.status);
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }
}
