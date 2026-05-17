// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISelfGroth16Verifier
/// @notice Minimal interface for Self.xyz's auto-generated Groth16 verifier for the
///         `vc_and_disclose` circuit (E_PASSPORT attestation, 21 public signals).
/// @dev    Mirrors `Verifier_vc_and_disclose.verifyProof(...)` so that
///         `NullifierRegistry` can call either the real verifier (deployed at
///         `0xf23537eF06fC1283F5be80676418b71aEd81b7E5` on ZKSync Era Sepolia)
///         or a controllable mock in unit tests, via a single injected address.
///
///         Public-signal layout (per Self's CircuitConstantsV2 for E_PASSPORT):
///           [0..2]  revealedDataPacked
///           [3..6]  forbiddenCountriesListPacked
///           [7]     nullifier
///           [8]     attestationId
///           [9]     merkleRoot
///           [10..15] currentDate (ASCII YYMMDD)
///           [16]    passportNoSmtRoot
///           [17]    namedobSmtRoot
///           [18]    nameyobSmtRoot
///           [19]    scope
///           [20]    userIdentifier
interface ISelfGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[21] calldata pubSignals
    ) external view returns (bool);
}
