// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {P256} from "@openzeppelin/contracts-hardhat-zksync-upgradable/utils/cryptography/P256.sol";

/**
 * @title CofferdamPasskeyAccount
 * @notice A minimal P-256 passkey-based smart wallet for ZKSync Era.
 *
 *  - Stores a P-256 public key (passkeyX, passkeyY)
 *  - Validates signatures via the RIP-7212 precompile (0x100) with a
 *    pure-Solidity secp256r1 fallback for local dev nodes that lack it.
 *  - Executes arbitrary calls after signature validation
 *
 * This is the α-2 test contract for the passkey flow. Production will
 * migrate to ZKSync native AA or ERC-4337 with a proper EntryPoint.
 */
contract CofferdamPasskeyAccount {

    bytes32 public passkeyX;
    bytes32 public passkeyY;
    uint256 public nonce;

    event Executed(bytes32 indexed txHash, address indexed target, uint256 value);

    constructor(bytes32 _x, bytes32 _y) {
        passkeyX = _x;
        passkeyY = _y;
    }

    /**
     * @notice Validate a raw P-256 signature over a 32-byte digest.
     */
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bool) {
        (bytes32 r, bytes32 s) = _extractRS(signature);
        return P256.verify(digest, r, s, passkeyX, passkeyY);
    }

    /**
     * @notice Execute a call after validating a P-256 signature.
     * @param target   The contract or EOA to call.
     * @param value    ETH to send.
     * @param data     Calldata.
     * @param signature  64-byte P-256 signature of:
     *                   keccak256(abi.encodePacked(nonce, target, value, keccak256(data)))
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        bytes calldata signature
    ) external payable returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(nonce, target, value, keccak256(data)));

        (bytes32 r, bytes32 s) = _extractRS(signature);
        require(P256.verify(digest, r, s, passkeyX, passkeyY), "invalid signature");

        nonce++;

        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        emit Executed(digest, target, value);
        return result;
    }

    /**
     * @notice Execute a batch of calls with a single signature.
     * @param targets  Array of targets.
     * @param values   Array of ETH amounts.
     * @param data     Array of calldatas.
     * @param signature  64-byte P-256 signature of:
     *                   keccak256(abi.encodePacked(nonce, keccak256(abi.encode(targets, values, data))))
     */
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata data,
        bytes calldata signature
    ) external payable {
        require(
            targets.length == values.length && targets.length == data.length,
            "length mismatch"
        );

        bytes32 digest = keccak256(
            abi.encodePacked(nonce, keccak256(abi.encode(targets, values, data)))
        );

        (bytes32 r, bytes32 s) = _extractRS(signature);
        require(P256.verify(digest, r, s, passkeyX, passkeyY), "invalid signature");

        nonce++;

        for (uint256 i = 0; i < targets.length; i++) {
            (bool success, bytes memory result) = targets[i].call{value: values[i]}(data[i]);
            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            emit Executed(digest, targets[i], values[i]);
        }
    }

    // ── internal helpers ───────────────────────────────────────────────

    function _extractRS(bytes calldata signature) internal pure returns (bytes32 r, bytes32 s) {
        require(signature.length == 64, "bad signature length");
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
    }

    receive() external payable {}
}
