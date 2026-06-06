// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IIdentityRegistry
/// @notice Minimal cross-era identity-binding interface consumed by
///         CofferdamSpotEscrow (and future paymasters, settlement contracts,
///         etc.). Three concrete implementations satisfy this interface,
///         one per architectural era:
///
///           α-2  CofferdamReceiver           (Ownable, simulates LZ)
///           α-3  CofferdamReceiver (LZ)      (decoded LZ V2 OApp message)
///           v2   v2/self/NullifierRegistry      (Groth16 + Cofferdam TEE attester sig)
///
///         All three carry the same storage shape and emit the same event
///         topic (`NullifierBound`); only the auth check on the mutator
///         differs. Downstream contracts depend only on this interface,
///         so swapping the era is a deploy-config change — not a rewrite.
///
/// @dev    `bytes32` nullifier shape is the lowest-common-denominator across
///         eras. v2/self uses `uint256` natively (Poseidon hash) but the
///         `bytes32` view of the same value is what this interface exposes,
///         keeping all three implementations interchangeable from the
///         consumer's perspective.
interface IIdentityRegistry {
    /// @notice True iff `account` has had any nullifier bound to it.
    /// @dev    This is the canonical identity check used by escrow / paymaster
    ///         / settlement contracts. Cheap O(1) storage read.
    function isAccountBound(address account) external view returns (bool);

    /// @notice True iff `nullifier` has been bound to some account.
    function isNullifierBound(bytes32 nullifier) external view returns (bool);

    /// @notice Block timestamp at which `account` was bound. 0 if unbound.
    /// @dev    Useful for `verifiedRecently(account, maxAge)` policies in
    ///         downstream contracts (e.g. paymaster rate-limits, time-locked
    ///         escrow features).
    function verifiedAt(address account) external view returns (uint256);
}
