// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAuthorityModule, Tier} from "./IAuthorityModule.sol";

/// @title AuthorityManagerBase
/// @notice The chain-agnostic core of Cofferdam's tiered-authority model: the
///         authority registry, the passkey cap, and the one-way legacy→passkey
///         upgrade ratchet specified in `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md`
///         §2.5. It is deliberately free of any *execution* or *replay-scheme*
///         opinion so two very different accounts can share it unchanged:
///
///           - `CofferdamAccount`      — a custom-`execute` harness whose replay
///                                       protection is an internal `nonce`
///                                       counter folded into a keccak digest. Used
///                                       for fast local unit testing of the
///                                       authority/ratchet logic.
///           - `CofferdamSmartAccount` — a ZKSync Era native `IAccount` whose
///                                       replay protection is the protocol
///                                       `NonceHolder` and whose signed digest is
///                                       the transaction hash.
///
/// @dev    Modules are stateless singletons (see `IAuthorityModule`); all
///         per-account key material lives here in each `Authority.config` blob.
///         This base owns ONLY: storage layout, the authority lifecycle
///         primitives (`_addAuthority`, `_revokeAuthorityRecord`,
///         `_enrollFirstPasskey`), the `_authenticate` module dispatch, and the
///         ratchet. Subclasses own how a `digest` is formed, where the nonce
///         comes from, and how calls are executed.
abstract contract AuthorityManagerBase {
    // ── Authority storage ──────────────────────────────────────────────────

    struct Authority {
        IAuthorityModule module;
        Tier tier;
        bool active;
        bytes config;
    }

    uint8 public constant MAX_PASSKEYS = 3;

    mapping(uint256 => Authority) internal _authorities;
    uint256 public authorityCount;

    /// @notice Number of active High-tier (passkey) authorities. Capped at MAX_PASSKEYS.
    uint8 public passkeyCount;

    /// @notice True once the one-way ratchet has fired (a passkey exists, so no
    ///         untrusted low-tier authority may ever add/remove authorities).
    bool public upgradeLocked;

    // ── Events ───────────────────────────────────────────────────────────────

    event AuthorityAdded(uint256 indexed authorityId, address indexed module, Tier tier, bytes32 kind);
    event AuthorityRevoked(uint256 indexed authorityId);
    event FirstPasskeyEnrolled(uint256 indexed lowAuthorityId, uint256 indexed passkeyAuthorityId);
    event RatchetFired();

    // ── Errors ─────────────────────────────────────────────────────────────

    error ZeroModule();
    error UnknownAuthority(uint256 authorityId);
    error InactiveAuthority(uint256 authorityId);
    error InvalidAuthoritySignature(uint256 authorityId);
    error TierNotPermitted(Tier tier);
    error PasskeyCapReached();
    error UpgradeLocked();
    error NotUntrustedLowTier(Tier tier);
    error PasskeyAlreadyExists();
    error NotAPasskey(Tier tier);

    // ── Views ──────────────────────────────────────────────────────────────

    function getAuthority(uint256 authorityId)
        external
        view
        returns (address module, Tier tier, bool active, bytes memory config)
    {
        Authority storage a = _authorities[authorityId];
        return (address(a.module), a.tier, a.active, a.config);
    }

    // ── Initialisation ───────────────────────────────────────────────────────

    /// @notice Seed authority 0. Either a passkey (sovereign-first onboarding) or
    ///         a low-tier session key (legacy-first / enterprise onboarding).
    /// @dev    A passkey at genesis closes the ratchet immediately — no untrusted
    ///         credential can ever bootstrap an attacker passkey on this account.
    function _initFirstAuthority(IAuthorityModule initialModule, bytes memory initialConfig) internal {
        if (address(initialModule) == address(0)) revert ZeroModule();
        Tier t = initialModule.tier();

        _authorities[0] = Authority({module: initialModule, tier: t, active: true, config: initialConfig});
        authorityCount = 1;

        if (t == Tier.High) {
            passkeyCount = 1;
            upgradeLocked = true;
        }

        emit AuthorityAdded(0, address(initialModule), t, initialModule.kind());
    }

    // ── Authority lifecycle primitives ────────────────────────────────────────

    /// @dev Verify `signature` authorises `digest` under authority `authorityId`,
    ///      returning the authority's tier. Reverts on unknown/inactive/invalid.
    ///      `signature` is `memory` so both a calldata-sourced custom execute and
    ///      a decoded native-AA transaction signature can call it.
    function _authenticate(uint256 authorityId, bytes32 digest, bytes memory signature)
        internal
        view
        returns (Tier)
    {
        Authority storage a = _authorities[authorityId];
        if (address(a.module) == address(0)) revert UnknownAuthority(authorityId);
        if (!a.active) revert InactiveAuthority(authorityId);
        if (!a.module.isValidSignature(address(this), digest, a.config, signature)) {
            revert InvalidAuthoritySignature(authorityId);
        }
        return a.tier;
    }

    /// @dev Append an authority record; enforces the passkey cap for High tiers.
    function _addAuthority(IAuthorityModule module, bytes memory config) internal returns (uint256 id) {
        Tier t = module.tier();
        if (t == Tier.High) {
            if (passkeyCount >= MAX_PASSKEYS) revert PasskeyCapReached();
            passkeyCount++;
        }
        id = authorityCount;
        _authorities[id] = Authority({module: module, tier: t, active: true, config: config});
        authorityCount = id + 1;
        emit AuthorityAdded(id, address(module), t, module.kind());
    }

    /// @dev Deactivate an authority record; decrements the passkey count if the
    ///      target was an active passkey. Reverts if the target never existed.
    function _revokeAuthorityRecord(uint256 targetId) internal {
        Authority storage target = _authorities[targetId];
        if (address(target.module) == address(0)) revert UnknownAuthority(targetId);

        if (target.active && target.tier == Tier.High && passkeyCount > 0) {
            passkeyCount--;
        }
        target.active = false;
        emit AuthorityRevoked(targetId);
    }

    /// @dev Invariants every first-passkey enrolment must satisfy, regardless of
    ///      which account shape calls it: the candidate must be a High passkey and
    ///      no passkey may already exist / the ratchet must not have fired.
    function _preEnrollChecks(IAuthorityModule passkeyModule) internal view {
        if (address(passkeyModule) == address(0)) revert ZeroModule();
        if (passkeyModule.tier() != Tier.High) revert NotAPasskey(passkeyModule.tier());
        if (upgradeLocked || passkeyCount > 0) revert PasskeyAlreadyExists();
    }

    /// @dev Register the first passkey and FIRE THE ONE-WAY RATCHET: permanently
    ///      deactivate every untrusted low-tier authority so a leaked legacy
    ///      credential can never add an attacker passkey (§2.5.2). The caller is
    ///      responsible for having authenticated a LowUntrusted authority first.
    function _enrollFirstPasskey(
        uint256 lowAuthorityId,
        IAuthorityModule passkeyModule,
        bytes memory passkeyConfig
    ) internal returns (uint256 passkeyAuthorityId) {
        passkeyAuthorityId = _addAuthority(passkeyModule, passkeyConfig);

        upgradeLocked = true;
        for (uint256 i = 0; i < authorityCount; i++) {
            Authority storage a = _authorities[i];
            if (a.active && a.tier == Tier.LowUntrusted) {
                a.active = false;
                emit AuthorityRevoked(i);
            }
        }

        emit FirstPasskeyEnrolled(lowAuthorityId, passkeyAuthorityId);
        emit RatchetFired();
    }

    /// @dev Tier gate shared by management/execution entrypoints: only trusted
    ///      tiers (High, LowManaged) may act. LowUntrusted is confined to
    ///      `enrollFirstPasskey` and is locked out by the ratchet.
    function _requireTrustedTier(Tier t) internal pure {
        if (t != Tier.High && t != Tier.LowManaged) revert TierNotPermitted(t);
    }

    function _hashDataArray(bytes[] calldata data) internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            hashes[i] = keccak256(data[i]);
        }
    }
}
