// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "@openzeppelin/contracts-hardhat-zksync-upgradable/utils/cryptography/WebAuthn.sol";
import {IAuthorityModule, Tier} from "../IAuthorityModule.sol";

/// @title WebAuthnPasskeyAuthority
/// @notice High-tier authority for a REAL platform passkey (WebAuthn ES256 /
///         P-256), as produced by iOS/Android (`react-native-passkeys`) or a
///         browser `navigator.credentials`. It is the production sibling of
///         `PasskeyAuthority`: same High tier, same `config = abi.encode(qx, qy)`
///         public-key blob, but it verifies a full WebAuthn *assertion* rather
///         than a raw P-256 signature.
///
/// @dev    WHY A SEPARATE MODULE. `PasskeyAuthority` verifies `P256.verify` over
///         the bare 32-byte `digest` (the account's tx hash). A hardware
///         authenticator never signs a bare digest — it signs
///         `sha256(authenticatorData || sha256(clientDataJSON))`, where the
///         account's tx hash is carried as the WebAuthn *challenge* inside
///         `clientDataJSON`. This module reconstructs and checks that envelope
///         via OpenZeppelin's audited `WebAuthn` library, so the
///         `CofferdamSmartAccount` need not change: it still hands the module an
///         opaque `(digest, config, signature)` and learns only a bool.
///
///         SIGNATURE ENCODING. `signature` is an ABI-encoded
///         `WebAuthn.WebAuthnAuth`:
///           (bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex,
///            bytes authenticatorData, string clientDataJSON)
///         The off-chain signer MUST set the WebAuthn challenge to the raw 32
///         bytes of `digest`; on-chain we Base64URL-encode `digest` and require
///         it to appear at `challengeIndex` in `clientDataJSON` (handled inside
///         `WebAuthn.verify`).
///
///         USER VERIFICATION. `requireUserVerification` is a compile-time
///         `constant true`: a High-tier financial authority is always
///         biometric-gated, so every assertion MUST carry the UV bit (the device
///         performed Face/Touch ID or PIN). The User-Present (UP) bit is always
///         required by the library.
///
///         WHY A CONSTANT (NOT IMMUTABLE/STORAGE). `isValidSignature` runs inside
///         the ZKSync AA *validation* step, where the account may only touch
///         storage slots associated with its own address. Reading an `immutable`
///         goes through the `ImmutableSimulator` system contract (0x…8005), and a
///         plain storage var lives in this module's (non-account-keyed) slots —
///         both are rejected as "touched disallowed storage slots". A `constant`
///         is inlined into bytecode, so the read needs no storage / system call.
contract WebAuthnPasskeyAuthority is IAuthorityModule {
    bytes32 public constant KIND = keccak256("passkey");

    /// @notice Whether assertions must carry the User-Verified (UV) flag. Always
    ///         `true` for this High-tier module (see contract docs for why this
    ///         is a `constant` rather than a deploy-time parameter).
    bool public constant requireUserVerification = true;

    /// @inheritdoc IAuthorityModule
    function tier() external pure returns (Tier) {
        return Tier.High;
    }

    /// @inheritdoc IAuthorityModule
    function kind() external pure returns (bytes32) {
        return KIND;
    }

    /// @inheritdoc IAuthorityModule
    /// @param config    abi.encode(bytes32 qx, bytes32 qy) — the passkey pubkey.
    /// @param signature abi.encode(WebAuthn.WebAuthnAuth) — the assertion. The
    ///                  WebAuthn challenge must equal the 32 bytes of `digest`.
    function isValidSignature(
        address, /* account */
        bytes32 digest,
        bytes calldata config,
        bytes calldata signature
    ) external view returns (bool) {
        if (config.length != 64) return false;

        (bool ok, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature);
        if (!ok) return false;

        (bytes32 qx, bytes32 qy) = abi.decode(config, (bytes32, bytes32));

        // The account's tx hash is the WebAuthn challenge. `WebAuthn.verify`
        // Base64URL-encodes it and matches it against `clientDataJSON`, checks
        // the type is "webauthn.get", the UP (and, if required, UV) flags, and
        // finally the P-256 signature over the WebAuthn signature base.
        return WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy, requireUserVerification);
    }
}
