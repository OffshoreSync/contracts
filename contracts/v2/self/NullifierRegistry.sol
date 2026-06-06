// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISelfGroth16Verifier} from "./ISelfGroth16Verifier.sol";
import {SelfAttesterRegistry} from "./SelfAttesterRegistry.sol";
import {SelfPublicSignals} from "./SelfPublicSignals.sol";

/// @title NullifierRegistry
/// @notice One-shot binding from a Self.xyz passport-derived nullifier to a
///         Cofferdam account address. Enforces the "one passport = one account"
///         rule that powers Cofferdam's sybil resistance.
/// @dev    The `verifyAndBind` entrypoint composes three independent security
///         checks:
///           1. Public-signal sanity: attestation ID matches E_PASSPORT, and the
///              proof's `userIdentifier` field equals the target `account`.
///           2. TEE attestation: the attester signature recovers to a key
///              currently allow-listed in `SelfAttesterRegistry`. This is what
///              prevents an attacker from feeding fabricated passport data to
///              snarkjs locally.
///           3. Groth16 proof: the deployed `Verifier_vc_and_disclose` accepts
///              the proof. This proves the math (commitment in Merkle tree,
///              valid DSC signature, etc.) but, crucially, says nothing about
///              whether the inputs came from a real NFC scan — that's check (2).
///
///         All three must pass for `NullifierBound` to be emitted.
///
///         **One-shot semantics**: once bound, neither (account, nullifier) can
///         be reused. There is intentionally no `unbind` path — re-binding would
///         break the sybil-resistance guarantee. If a user loses their account
///         keys, the recovery path is to re-prove the passport against a *new*
///         account in a new (registry, deploy) tuple.
contract NullifierRegistry {
    // ────────────────────────────────────────────────────────────────────────
    // Immutable wiring
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Self.xyz Groth16 verifier for the `vc_and_disclose` circuit.
    ISelfGroth16Verifier public immutable verifier;

    /// @notice Allow-list of trusted Self TEE attester ECDSA addresses.
    SelfAttesterRegistry public immutable attesterRegistry;

    /// @notice Application scope (Poseidon-hashed string) that the prover must
    ///         have used when generating the proof. Locks proofs from a different
    ///         scope (e.g. another Cofferdam deployment, or a third-party app
    ///         using the same Self stack) out of this registry.
    /// @dev    Set at construction; immutable thereafter. To change scope you
    ///         deploy a new `NullifierRegistry`.
    uint256 public immutable expectedScope;

    // ────────────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────────────

    /// @notice nullifier → account that bound it. address(0) = unbound.
    mapping(uint256 => address) public nullifierToAccount;

    /// @notice account → nullifier it bound. 0 = unbound.
    mapping(address => uint256) public accountToNullifier;

    // ────────────────────────────────────────────────────────────────────────
    // Events
    // ────────────────────────────────────────────────────────────────────────

    event NullifierBound(
        address indexed account,
        uint256 indexed nullifier,
        uint256 attestationId,
        uint256 scope
    );

    // ────────────────────────────────────────────────────────────────────────
    // Errors
    // ────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error WrongAttestationId(uint256 expected, uint256 got);
    error WrongScope(uint256 expected, uint256 got);
    error UserIdentifierMismatch(address expected, address got);
    error AccountAlreadyBound(address account, uint256 boundNullifier);
    error NullifierAlreadyBound(uint256 nullifier, address boundAccount);
    error UntrustedAttester();
    error InvalidProof();

    // ────────────────────────────────────────────────────────────────────────
    // Constructor
    // ────────────────────────────────────────────────────────────────────────

    constructor(
        address _verifier,
        address _attesterRegistry,
        uint256 _expectedScope
    ) {
        if (_verifier == address(0)) revert ZeroAddress();
        if (_attesterRegistry == address(0)) revert ZeroAddress();
        verifier = ISelfGroth16Verifier(_verifier);
        attesterRegistry = SelfAttesterRegistry(_attesterRegistry);
        expectedScope = _expectedScope;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Entrypoint
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Verify a Self.xyz passport ZK proof + TEE attestation, and bind
    ///         the resulting nullifier to `account`.
    /// @dev    Caller is unconstrained: the smart account itself, a paymaster
    ///         relay, or any third party can submit. Security comes entirely
    ///         from the proof + attester signature.
    /// @param  account         Target account to bind. Must equal
    ///                         `pubSignals[USER_IDENTIFIER]` cast from uint160.
    /// @param  a, b, c         Groth16 proof components.
    /// @param  pubSignals      21 public signals (see `SelfPublicSignals` for layout).
    /// @param  attesterSig     65-byte EIP-191 personal_sign over
    ///                         `attesterMessageHash(account, pubSignals)`.
    function verifyAndBind(
        address account,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[21] calldata pubSignals,
        bytes calldata attesterSig
    ) external {
        if (account == address(0)) revert ZeroAddress();

        // (1a) Attestation ID must match E_PASSPORT — guards against replay of
        //      proofs from EU_ID_CARD / AADHAAR / KYC circuits whose verifiers
        //      may share a public-signal arity (other circuits have different
        //      arities, but defense in depth is cheap here).
        uint256 attestationId = pubSignals[SelfPublicSignals.ATTESTATION_ID];
        if (attestationId != SelfPublicSignals.E_PASSPORT_ATTESTATION_ID) {
            revert WrongAttestationId(SelfPublicSignals.E_PASSPORT_ATTESTATION_ID, attestationId);
        }

        // (1b) Scope must match this registry's expected scope. Prevents a proof
        //      generated for app X being replayed against this contract.
        uint256 scope = pubSignals[SelfPublicSignals.SCOPE];
        if (scope != expectedScope) revert WrongScope(expectedScope, scope);

        // (1c) The circuit binds a `userIdentifier` to the proof. We require
        //      that identifier to equal the target account. This makes proofs
        //      non-transferable: an attacker who steals a `(proof, sig)` tuple
        //      cannot re-bind it to a different account.
        uint256 userIdentifier = pubSignals[SelfPublicSignals.USER_IDENTIFIER];
        if (userIdentifier != uint256(uint160(account))) {
            revert UserIdentifierMismatch(account, address(uint160(userIdentifier)));
        }

        // (2) Replay / one-shot guards. Cheap before the expensive cryptography.
        uint256 nullifier = pubSignals[SelfPublicSignals.NULLIFIER];
        uint256 existingForAccount = accountToNullifier[account];
        if (existingForAccount != 0) {
            revert AccountAlreadyBound(account, existingForAccount);
        }
        address existingForNullifier = nullifierToAccount[nullifier];
        if (existingForNullifier != address(0)) {
            revert NullifierAlreadyBound(nullifier, existingForNullifier);
        }

        // (3) Attester signature: TEE-side proof of authentic NFC input.
        bytes32 msgHash = attesterMessageHash(account, pubSignals);
        if (!attesterRegistry.verifyAttesterSig(msgHash, attesterSig)) {
            revert UntrustedAttester();
        }

        // (4) Groth16 proof: the math.
        if (!verifier.verifyProof(a, b, c, pubSignals)) revert InvalidProof();

        // (5) Bind. Two-way mapping for cheap reads in both directions.
        nullifierToAccount[nullifier] = account;
        accountToNullifier[account] = nullifier;

        emit NullifierBound(account, nullifier, attestationId, scope);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Read helpers
    // ────────────────────────────────────────────────────────────────────────

    /// @notice True iff `account` has bound a passport nullifier on this registry.
    function isAccountBound(address account) external view returns (bool) {
        return accountToNullifier[account] != 0;
    }

    /// @notice True iff `nullifier` has been bound to some account on this registry.
    function isNullifierBound(uint256 nullifier) external view returns (bool) {
        return nullifierToAccount[nullifier] != address(0);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Attester message
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Canonical message hash that the Self TEE attester must sign.
    /// @dev    Includes:
    ///           - block.chainid → prevents cross-chain replay
    ///           - address(this) → prevents replay against a redeployed registry
    ///           - account       → binds attestation to the target account
    ///           - full pubSignals → binds attestation to the exact proof
    ///         The TEE must reproduce this hash byte-for-byte; clients of the
    ///         off-chain TEE sidechannel call this view to fetch the canonical
    ///         hash and attach it to the relayer payload.
    function attesterMessageHash(address account, uint256[21] calldata pubSignals)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                account,
                pubSignals
            )
        );
    }
}
