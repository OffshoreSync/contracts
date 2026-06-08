// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {P256} from "@openzeppelin/contracts-hardhat-zksync-upgradable/utils/cryptography/P256.sol";
import {IAuthorityModule, Tier} from "../IAuthorityModule.sol";

/// @title PasskeyAuthority
/// @notice High-tier authority module: a device passkey (P-256 / secp256r1,
///         WebAuthn ES256). Backed by hardware (iOS Secure Enclave / Android
///         StrongBox) on the user's device; non-exportable, biometric-gated.
///
/// @dev    Stateless singleton. The account stores the public key as
///         `config = abi.encode(qx, qy)` and the signature is the raw 64-byte
///         `r || s`. Validation goes through OpenZeppelin's `P256.verify`, which
///         uses the RIP-7212 precompile (0x100) when available and falls back to
///         a pure-Solidity secp256r1 implementation on dev nodes that lack it —
///         the same path the α-2 `CofferdamPasskeyAccount` used.
///
///         NOTE: this module verifies a raw P-256 signature over `digest`. The
///         caller (the account) is responsible for computing `digest` as the
///         WebAuthn signature base (authenticatorData || sha256(clientDataJSON))
///         when wiring a real platform authenticator; for the α-2 account the
///         digest is the account's own tx hash. The module is agnostic to how
///         `digest` was derived.
contract PasskeyAuthority is IAuthorityModule {
    bytes32 public constant KIND = keccak256("passkey");

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
    /// @param signature 64 bytes: r (first 32) || s (last 32).
    function isValidSignature(
        address, /* account */
        bytes32 digest,
        bytes calldata config,
        bytes calldata signature
    ) external view returns (bool) {
        if (signature.length != 64) return false;
        if (config.length != 64) return false;

        (bytes32 qx, bytes32 qy) = abi.decode(config, (bytes32, bytes32));
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
        return P256.verify(digest, r, s, qx, qy);
    }
}
