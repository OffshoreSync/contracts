// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Authority tiers
/// @notice On-chain mirror of the off-chain tiered-authority model in
///         `cofferdam-sdk/packages/core/src/types.ts` (`AuthorityTier`) and the
///         spec in `cofferdam-sdk/IDENTITY_LAYER_DESIGN.md` §2.5.
///
///         The tier of the authority that signs a transaction decides what that
///         transaction may do (enforced by `CofferdamAccount`):
///
///           High          — a device passkey (P-256, Secure Enclave/StrongBox).
///                           May sign anything.
///           LowUntrusted  — a leakable credential (password / social OAuth,
///                           bridged on-chain via a server session signer). May
///                           ONLY authorise the first-passkey enrolment with zero
///                           value, then is permanently locked out by the one-way
///                           ratchet (§2.5.2).
///           LowManaged    — an IdP-brokered, centrally SCIM-revocable authority
///                           (e.g. Polis SSO). NOT ratchet-locked; coexists with a
///                           later passkey with OR semantics (§3.10).
enum Tier {
    None,
    LowUntrusted,
    LowManaged,
    High
}

/// @title IAuthorityModule
/// @notice The single, uniform ABI every authentication mode plugs into so that
///         any consumer app on a legacy auth method (local password, Google /
///         Apple OAuth, Polis SSO JWT, …) can bootstrap a ZKSync Era smart
///         account and migrate to a hardware passkey through one common path.
///
/// @dev    Modules are **stateless singletons**. All per-account key material
///         lives in the `CofferdamAccount` as an opaque `config` blob, which the
///         account passes back to the module on every validation. This keeps a
///         module deployable once and shared by every account, and keeps the
///         account self-contained (one storage read, no cross-contract key
///         lookup). A module encapsulates exactly one decision: "given this
///         account's stored config, is `signature` a valid authorisation of
///         `digest`?" — be it a P-256 WebAuthn assertion, an ECDSA session-signer
///         signature standing in for a verified JWT, or a future native RS256
///         OIDC check. The account never learns how; it only sees a bool.
interface IAuthorityModule {
    /// @notice The trust tier this module's authorities carry on an account.
    /// @dev    `pure` because a module's tier is fixed at deploy time. A single
    ///         module implementation MAY be deployed twice at different tiers
    ///         (e.g. `SessionKeyAuthority` as LowUntrusted vs LowManaged) — each
    ///         deployment returns its own immutable tier.
    function tier() external view returns (Tier);

    /// @notice Stable identifier of the authority kind, e.g.
    ///         `keccak256("passkey")`, `keccak256("session")`. Mirrors the SDK's
    ///         `AuthorityKind`. Used for off-chain indexing + UI labelling.
    function kind() external pure returns (bytes32);

    /// @notice Validate `signature` over `digest` against this account's stored
    ///         `config` for this authority.
    /// @param  account   The `CofferdamAccount` whose authority is being checked.
    ///                    Passed so a module MAY bind validation to the account
    ///                    (e.g. domain separation) if it chooses.
    /// @param  digest    32-byte message the signature must cover.
    /// @param  config    Opaque per-account authority material the account stored
    ///                    at `addAuthority` time (e.g. abi.encode(qx,qy) for a
    ///                    passkey, abi.encode(signer) for a session key).
    /// @param  signature Authorisation produced by the off-chain authority.
    /// @return ok        True iff the signature is a valid authorisation.
    function isValidSignature(
        address account,
        bytes32 digest,
        bytes calldata config,
        bytes calldata signature
    ) external view returns (bool ok);
}
