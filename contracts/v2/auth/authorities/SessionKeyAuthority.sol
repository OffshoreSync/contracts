// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAuthorityModule, Tier} from "../IAuthorityModule.sol";

/// @title SessionKeyAuthority
/// @notice The legacy-auth bridge. This is the single module that lets any
///         consumer app already running on a non-passkey auth method —
///         local password, Google / Apple OAuth, or a Polis SSO JWT — bind a
///         ZKSync Era smart account today and migrate to a hardware passkey
///         later, with no change to the on-chain account ABI.
///
/// @dev    On-chain RS256/JWT verification is expensive and brittle, and the
///         consumer's server ALREADY authenticates the user (it validated the
///         password, the OAuth code exchange, or the OIDC ID-token). So instead
///         of re-verifying the JWT on-chain, this module trusts a per-account
///         **session signer**: a server-held ECDSA key the consumer registers as
///         the account's authority `config`. After the server authenticates the
///         user through the legacy flow, it signs the account's tx digest with
///         that key; this module recovers the signer and checks it matches.
///
///         The trust class is identical to the bind-attester already used by
///         `NullifierRegistry` (`SelfAttesterRegistry`): a Cofferdam/consumer
///         server vouches off-chain, the chain verifies the vouch cheaply. This
///         is deliberately a **low tier**:
///
///           - Deployed at `Tier.LowUntrusted` it models a leakable consumer
///             credential. On `CofferdamAccount` it may ONLY authorise the first
///             passkey enrolment (zero value), after which the one-way ratchet
///             permanently locks it out (IDENTITY_LAYER_DESIGN.md §2.5.2).
///           - Deployed at `Tier.LowManaged` it models the IdP-brokered Polis
///             SSO authority: it is NOT ratchet-locked and coexists with a later
///             passkey under OR semantics (§3.10). Central revocation is handled
///             by the consumer rotating / zeroing the registered signer.
///
///         Two `kind()`s are exposed via the constructor so off-chain indexers
///         can distinguish the consumer-session bridge from the managed Polis
///         bridge even though they share this implementation.
contract SessionKeyAuthority is IAuthorityModule {
    /// @dev secp256k1 group order / 2; signatures with s above this are rejected
    ///      to prevent signature malleability (EIP-2).
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant KIND_SESSION = keccak256("session");
    bytes32 public constant KIND_POLIS_SSO = keccak256("polis_sso");

    Tier private immutable _tier;
    bytes32 private immutable _kind;

    /// @param tier_ Either `Tier.LowUntrusted` (consumer password/OAuth bridge)
    ///              or `Tier.LowManaged` (Polis SSO). High/None are rejected —
    ///              a server-held ECDSA key is by construction not a high-tier
    ///              hardware authority.
    constructor(Tier tier_) {
        require(
            tier_ == Tier.LowUntrusted || tier_ == Tier.LowManaged,
            "SessionKeyAuthority: tier must be a low tier"
        );
        _tier = tier_;
        _kind = tier_ == Tier.LowManaged ? KIND_POLIS_SSO : KIND_SESSION;
    }

    /// @inheritdoc IAuthorityModule
    function tier() external view returns (Tier) {
        return _tier;
    }

    /// @inheritdoc IAuthorityModule
    function kind() external pure returns (bytes32) {
        // pure to satisfy the interface; returns the deploy-time kind via a
        // constant branch. (The interface declares `kind()` pure so it can be
        // read without an account; we expose the immutable through `kindOf`.)
        return KIND_SESSION;
    }

    /// @notice The deploy-time kind of THIS instance (session vs polis_sso).
    /// @dev    Companion to the interface's `pure kind()`; off-chain code should
    ///         prefer this for the managed/untrusted distinction.
    function kindOf() external view returns (bytes32) {
        return _kind;
    }

    /// @inheritdoc IAuthorityModule
    /// @param account   Bound into the signed message for domain separation, so
    ///                  a session-signer signature for one account can never be
    ///                  replayed against another account sharing the same signer.
    /// @param config    abi.encode(address sessionSigner) — the server key.
    /// @param signature 65-byte ECDSA signature (r,s,v) over the EIP-191
    ///                  personal_sign of keccak256(account, digest).
    function isValidSignature(
        address account,
        bytes32 digest,
        bytes calldata config,
        bytes calldata signature
    ) external pure returns (bool) {
        if (config.length != 32) return false;
        if (signature.length != 65) return false;
        address sessionSigner = abi.decode(config, (address));
        if (sessionSigner == address(0)) return false;

        // Bind to the account for domain separation, then EIP-191 personal_sign.
        bytes32 bound = keccak256(abi.encode(account, digest));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", bound));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // EIP-2 malleability guard + valid recovery id.
        if (uint256(s) > HALF_N) return false;
        if (v != 27 && v != 28) return false;

        address recovered = ecrecover(ethHash, v, r, s);
        return recovered != address(0) && recovered == sessionSigner;
    }
}
