// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SelfPublicSignals
/// @notice Index constants for Self.xyz's `vc_and_disclose` circuit public signals
///         (E_PASSPORT attestation, 21 uint256 elements).
/// @dev    Copied verbatim from Self's `CircuitConstantsV2.getDiscloseIndices(E_PASSPORT)`.
///         Locking these as constants (vs. function-returned struct) saves gas and
///         keeps `NullifierRegistry` free of an external library jump.
library SelfPublicSignals {
    // ---- E_PASSPORT (vc_and_disclose, 21 signals) ----
    uint256 internal constant REVEALED_DATA_PACKED_0 = 0;
    uint256 internal constant REVEALED_DATA_PACKED_1 = 1;
    uint256 internal constant REVEALED_DATA_PACKED_2 = 2;
    uint256 internal constant FORBIDDEN_COUNTRIES_PACKED_0 = 3;
    uint256 internal constant FORBIDDEN_COUNTRIES_PACKED_1 = 4;
    uint256 internal constant FORBIDDEN_COUNTRIES_PACKED_2 = 5;
    uint256 internal constant FORBIDDEN_COUNTRIES_PACKED_3 = 6;
    uint256 internal constant NULLIFIER = 7;
    uint256 internal constant ATTESTATION_ID = 8;
    uint256 internal constant MERKLE_ROOT = 9;
    uint256 internal constant CURRENT_DATE_0 = 10;
    uint256 internal constant CURRENT_DATE_5 = 15;
    uint256 internal constant PASSPORT_NO_SMT_ROOT = 16;
    uint256 internal constant NAMEDOB_SMT_ROOT = 17;
    uint256 internal constant NAMEYOB_SMT_ROOT = 18;
    uint256 internal constant SCOPE = 19;
    uint256 internal constant USER_IDENTIFIER = 20;

    /// @notice E_PASSPORT attestation ID, mirrors `AttestationId.E_PASSPORT` in
    ///         Self's official contracts (`bytes32(uint256(1))`).
    /// @dev    Verified against `pubSignals[ATTESTATION_ID]` in `NullifierRegistry`
    ///         so that proofs from other attestation circuits (EU_ID_CARD = 2,
    ///         AADHAAR = 3, KYC = 4) cannot be replayed against this contract.
    uint256 internal constant E_PASSPORT_ATTESTATION_ID = 1;
}
