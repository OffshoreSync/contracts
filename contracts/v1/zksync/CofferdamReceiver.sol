// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title CofferdamReceiver
/// @notice α-2 identity registry. Records `(account ↔ nullifier)` bindings
///         produced upstream by the Cofferdam verification flow and exposes
///         them to downstream contracts (CofferdamSpotEscrow, future paymaster,
///         settlement) via `IIdentityRegistry`.
///
/// @dev    Era-portable design. The storage layout, public read API, and
///         event topic are deliberately identical across all three Cofferdam
///         eras so downstream consumers can swap the *source* of bindings
///         without recompilation:
///
///           α-2 (this contract)
///             - Auth: `onlyOwner` calls `bindNullifier(account, nullifier)`.
///             - Owner is initially the deployer EOA, transferred to the
///               OffshoreSync LLC Treasury Safe via the two-step flow.
///             - Purpose: lets the SDK + escrow be developed and tested
///               end-to-end on anvil-zksync before any cross-chain or TEE
///               infrastructure exists.
///
///           α-3 (LayerZero V2 OApp variant — separate contract)
///             - Auth: `onlyLzEndpoint`; the bind happens inside
///               `_lzReceive(...)` after DVN attestation.
///             - Same storage + events; escrow code is unchanged.
///
///           v2 (`v2/self/NullifierRegistry` — already implemented)
///             - Auth: Groth16 proof verification + Cofferdam TEE attester
///               signature (cf. `SelfAttesterRegistry`). Replicates Self.xyz's
///               own architecture but deployed on ZKSync Era, removing the
///               cross-chain hop.
///             - Same `isAccountBound` / `isNullifierBound` semantics; the
///               escrow points at this contract instead.
///
///         One-shot replay guard: once a nullifier is bound to an account it
///         can never be rebound, and once an account is bound it cannot be
///         re-used for a different nullifier. This is the cryptographic
///         mooring of Cofferdam's sybil resistance.
contract CofferdamReceiver is IIdentityRegistry {
    // ────────────────────────────────────────────────────────────────────────
    // Ownership (two-step)
    // ────────────────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;

    // ────────────────────────────────────────────────────────────────────────
    // Bindings
    // ────────────────────────────────────────────────────────────────────────

    /// @notice account → nullifier that bound it. bytes32(0) = unbound.
    mapping(address => bytes32) public accountToNullifier;

    /// @notice nullifier → account. address(0) = unbound.
    mapping(bytes32 => address) public nullifierToAccount;

    /// @notice account → block.timestamp at which the binding occurred.
    ///         0 = unbound. Used for `verifiedRecently()` policies.
    mapping(address => uint256) private _verifiedAt;

    // ────────────────────────────────────────────────────────────────────────
    // Events
    // ────────────────────────────────────────────────────────────────────────

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted once per successful bind. Topic is stable across all
    ///         Cofferdam eras; the α-3 LZ variant and v2 NullifierRegistry
    ///         emit the same event (additional unindexed fields may be
    ///         appended in future eras for context).
    /// @param  account    Account that just acquired a verified identity.
    /// @param  nullifier  Cryptographic identifier of the verified human.
    /// @param  timestamp  block.timestamp at bind.
    event NullifierBound(
        address indexed account,
        bytes32 indexed nullifier,
        uint256 timestamp
    );

    // ────────────────────────────────────────────────────────────────────────
    // Errors
    // ────────────────────────────────────────────────────────────────────────

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroNullifier();
    error AccountAlreadyBound(address account, bytes32 boundNullifier);
    error NullifierAlreadyBound(bytes32 nullifier, address boundAccount);

    // ────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Constructor
    // ────────────────────────────────────────────────────────────────────────

    /// @param  _initialOwner  Address that may call `bindNullifier`. In
    ///                        production this is the OffshoreSync LLC Treasury
    ///                        Safe (after a two-step transfer); in local dev
    ///                        tests it's a rich-wallet EOA.
    constructor(address _initialOwner) {
        if (_initialOwner == address(0)) revert ZeroAddress();
        owner = _initialOwner;
        emit OwnershipTransferred(address(0), _initialOwner);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Ownership transfer (two-step, prevents fat-finger handoff to dead key)
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
    // Bind mutator (α-2: onlyOwner; later eras swap the auth check)
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Bind `account` to `nullifier`. One-shot in both directions.
    /// @dev    α-2 simulation of LZ delivery: the LLC Treasury (or test rich
    ///         wallet during dev) attests off-chain that a Self.xyz proof was
    ///         observed for the user, then calls this. Same storage write the
    ///         α-3 LZ-OApp variant performs inside `_lzReceive`, and the v2
    ///         NullifierRegistry performs after Groth16 + attester checks.
    function bindNullifier(address account, bytes32 nullifier) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (nullifier == bytes32(0)) revert ZeroNullifier();

        bytes32 existingForAccount = accountToNullifier[account];
        if (existingForAccount != bytes32(0)) {
            revert AccountAlreadyBound(account, existingForAccount);
        }
        address existingForNullifier = nullifierToAccount[nullifier];
        if (existingForNullifier != address(0)) {
            revert NullifierAlreadyBound(nullifier, existingForNullifier);
        }

        accountToNullifier[account] = nullifier;
        nullifierToAccount[nullifier] = account;
        _verifiedAt[account] = block.timestamp;

        emit NullifierBound(account, nullifier, block.timestamp);
    }

    // ────────────────────────────────────────────────────────────────────────
    // IIdentityRegistry — read API
    // ────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IIdentityRegistry
    function isAccountBound(address account) external view returns (bool) {
        return accountToNullifier[account] != bytes32(0);
    }

    /// @inheritdoc IIdentityRegistry
    function isNullifierBound(bytes32 nullifier) external view returns (bool) {
        return nullifierToAccount[nullifier] != address(0);
    }

    /// @inheritdoc IIdentityRegistry
    function verifiedAt(address account) external view returns (uint256) {
        return _verifiedAt[account];
    }
}
