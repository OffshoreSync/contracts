// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAuthorityModule, Tier} from "./IAuthorityModule.sol";
import {AuthorityManagerBase} from "./AuthorityManagerBase.sol";

/// @title CofferdamAccount
/// @notice A multi-authority smart account for ZKSync Era. The on-chain enforcer
///         of the tiered-authority model + one-way upgrade ratchet specified in
///         `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §2.5, and the production
///         successor to the α-2 `CofferdamPasskeyAccount`.
///
///         The whole point of this contract is **auth-mode abstraction**: every
///         authentication method — a hardware passkey, a consumer's legacy
///         password / Google-Apple OAuth session, or an enterprise Polis SSO
///         JWT — plugs in behind one `IAuthorityModule` ABI. A consumer app
///         already running on a legacy auth method binds an account today (via a
///         `SessionKeyAuthority`) and migrates the user to a hardware passkey
///         later through `enrollFirstPasskey`, with no change to this account's
///         interface and no seed phrase ever.
///
/// @dev    Authority records are stored on the account; the modules themselves
///         are stateless singletons (see `IAuthorityModule`). Every
///         signature-consuming entrypoint binds the signature to
///         `(address(this), chainid, nonce, tag, payload)` so signatures are
///         non-replayable across accounts, chains, nonces, and operations.
///
///         Tier gating (enforced here, mirrored client-side in the SDK):
///           - High         → may `execute` / `addAuthority` / `revokeAuthority`.
///           - LowManaged   → may `execute` (company-bound ops) + `addAuthority`
///                            of a High passkey via the OR-semantics path.
///           - LowUntrusted → may ONLY call `enrollFirstPasskey` (zero value);
///                            everything else reverts. After the first passkey
///                            registers, the one-way ratchet permanently
///                            deactivates every LowUntrusted authority.
///
///         SCOPE NOTE: this is a custom-`execute` account (same shape as the α-2
///         `CofferdamPasskeyAccount`), not yet a ZKSync native `IAccount`
///         (`validateTransaction`/`payForTransaction`). Native-AA + paymaster
///         integration is a deliberate follow-up; the authority abstraction here
///         is designed to drop into that `validateTransaction` unchanged.
contract CofferdamAccount is AuthorityManagerBase {
    /// @notice Replay-protection counter, bumped on every signature-consuming op.
    ///         This account's own scheme; the native `CofferdamSmartAccount` uses
    ///         the protocol `NonceHolder` instead.
    uint256 public nonce;

    // ── Signature-binding tags (domain separation per operation) ─────────────

    bytes32 private constant TAG_EXECUTE = keccak256("CofferdamAccount.execute");
    bytes32 private constant TAG_EXECUTE_BATCH = keccak256("CofferdamAccount.executeBatch");
    bytes32 private constant TAG_ADD_AUTHORITY = keccak256("CofferdamAccount.addAuthority");
    bytes32 private constant TAG_REVOKE_AUTHORITY = keccak256("CofferdamAccount.revokeAuthority");
    bytes32 private constant TAG_ENROLL_FIRST_PASSKEY = keccak256("CofferdamAccount.enrollFirstPasskey");

    // ── Events ───────────────────────────────────────────────────────────────

    event Executed(uint256 indexed authorityId, bytes32 indexed digest, address indexed target, uint256 value);

    // ── Errors ─────────────────────────────────────────────────────────────

    error LengthMismatch();
    error CallFailed();

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @notice Bootstrap the account with a single initial authority. Either a
    ///         passkey (sovereign-first onboarding) or a low-tier session key
    ///         (legacy-first / enterprise onboarding).
    /// @param initialModule The bootstrap authority module.
    /// @param initialConfig  Per-account material for that module (e.g. passkey
    ///                        pubkey, or abi.encode(sessionSigner)).
    constructor(IAuthorityModule initialModule, bytes memory initialConfig) {
        _initFirstAuthority(initialModule, initialConfig);
    }

    // ── Execute ──────────────────────────────────────────────────────────────

    /// @notice Execute a call, authorised by authority `authorityId`.
    /// @dev    Only High and LowManaged authorities may execute. LowUntrusted is
    ///         confined to `enrollFirstPasskey`.
    function execute(
        uint256 authorityId,
        address target,
        uint256 value,
        bytes calldata data,
        bytes calldata signature
    ) external payable returns (bytes memory) {
        bytes32 digest = _digest(TAG_EXECUTE, abi.encode(target, value, keccak256(data)));
        _requireTrustedTier(_authenticate(authorityId, digest, signature));

        nonce++;
        bytes memory result = _call(target, value, data);
        emit Executed(authorityId, digest, target, value);
        return result;
    }

    /// @notice Execute a batch of calls under a single authorisation.
    function executeBatch(
        uint256 authorityId,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata data,
        bytes calldata signature
    ) external payable {
        if (targets.length != values.length || targets.length != data.length) revert LengthMismatch();

        bytes32 digest = _digest(TAG_EXECUTE_BATCH, abi.encode(targets, values, _hashDataArray(data)));
        _requireTrustedTier(_authenticate(authorityId, digest, signature));

        nonce++;
        for (uint256 i = 0; i < targets.length; i++) {
            _call(targets[i], values[i], data[i]);
            emit Executed(authorityId, digest, targets[i], values[i]);
        }
    }

    // ── Authority management (High / LowManaged only) ────────────────────────

    /// @notice Add a new authority, authorised by an existing High (or LowManaged)
    ///         authority. Used to add backup passkeys (≤ MAX_PASSKEYS) and to
    ///         attach OR-semantics authorities (e.g. a Self nullifier / managed
    ///         module) per IDENTITY_LAYER_DESIGN.md §3.10.
    function addAuthority(
        uint256 authorityId,
        IAuthorityModule newModule,
        bytes calldata newConfig,
        bytes calldata signature
    ) external returns (uint256 newAuthorityId) {
        if (address(newModule) == address(0)) revert ZeroModule();

        bytes32 digest = _digest(TAG_ADD_AUTHORITY, abi.encode(address(newModule), keccak256(newConfig)));
        // Only trusted tiers may manage authorities. Untrusted low-tier is
        // confined to enrollFirstPasskey and is locked out by the ratchet.
        _requireTrustedTier(_authenticate(authorityId, digest, signature));

        nonce++;
        newAuthorityId = _addAuthority(newModule, newConfig);
    }

    /// @notice Deactivate an authority, authorised by a High (or LowManaged)
    ///         authority. Decrements the passkey count if the target was a passkey.
    function revokeAuthority(
        uint256 authorityId,
        uint256 targetId,
        bytes calldata signature
    ) external {
        bytes32 digest = _digest(TAG_REVOKE_AUTHORITY, abi.encode(targetId));
        _requireTrustedTier(_authenticate(authorityId, digest, signature));

        nonce++;
        _revokeAuthorityRecord(targetId);
    }

    // ── The one-way ratchet: legacy → passkey migration ───────────────────────

    /// @notice Enrol the FIRST device passkey, authorised by an untrusted
    ///         low-tier authority (the legacy-auth bridge). This is the single
    ///         migration entrypoint for every consumer on a legacy auth method.
    ///
    /// @dev    Enforces the one-way ratchet (IDENTITY_LAYER_DESIGN.md §2.5.2):
    ///           - the signing authority MUST be active and LowUntrusted;
    ///           - no passkey may already exist and the ratchet must not have
    ///             fired (`!upgradeLocked`, `passkeyCount == 0`);
    ///           - on success the new passkey becomes a High authority and EVERY
    ///             LowUntrusted authority is permanently deactivated.
    ///         A managed low-tier (Polis SSO) authority does NOT use this path —
    ///         it adds a passkey via `addAuthority` with OR semantics (§3.10).
    function enrollFirstPasskey(
        uint256 lowAuthorityId,
        IAuthorityModule passkeyModule,
        bytes calldata passkeyConfig,
        bytes calldata signature
    ) external returns (uint256 passkeyAuthorityId) {
        _preEnrollChecks(passkeyModule);

        bytes32 digest =
            _digest(TAG_ENROLL_FIRST_PASSKEY, abi.encode(address(passkeyModule), keccak256(passkeyConfig)));
        Tier t = _authenticate(lowAuthorityId, digest, signature);
        if (t != Tier.LowUntrusted) revert NotUntrustedLowTier(t);

        nonce++;
        passkeyAuthorityId = _enrollFirstPasskey(lowAuthorityId, passkeyModule, passkeyConfig);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _call(address target, uint256 value, bytes calldata data) internal returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            if (result.length > 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert CallFailed();
        }
        return result;
    }

    function _digest(bytes32 tag, bytes memory payload) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, nonce, tag, payload));
    }

    receive() external payable {}
}
