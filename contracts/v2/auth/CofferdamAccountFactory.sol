// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemContractsCaller} from "@matterlabs/zksync-contracts/contracts/system-contracts/libraries/SystemContractsCaller.sol";
import {DEPLOYER_SYSTEM_CONTRACT, IContractDeployer} from "@matterlabs/zksync-contracts/contracts/system-contracts/Constants.sol";
import {L2ContractHelper} from "@matterlabs/zksync-contracts/contracts/l2-contracts/L2ContractHelper.sol";

import {IAuthorityModule} from "./IAuthorityModule.sol";

/// @title CofferdamAccountFactory
/// @notice CREATE2 factory for `CofferdamSmartAccount`. Deploying an AA on ZKSync
///         Era requires calling the `ContractDeployer` system contract's
///         `create2Account` (a plain `create2` yields "Sender is not an account").
///
/// @dev    The salt is the binding identifier the SDK derives for a Cofferdam
///         identity (e.g. keccak of the user's stable Cofferdam ref), so the
///         account address is COUNTERFACTUAL: known before deployment and stable
///         across re-deployment. `getAccountAddress` returns that address so the
///         client can show / fund / reference the wallet pre-deployment, matching
///         the off-chain `zksync-ethers` create2 derivation.
///
///         `aaBytecodeHash` is the ZKSync bytecode hash of `CofferdamSmartAccount`
///         (sha256 with the first two bytes overwritten by the length in 32-byte
///         words — produced by the SDK/hardhat tooling) and must be supplied as a
///         `factoryDeps` entry of the deploying transaction.
contract CofferdamAccountFactory {
    bytes32 public immutable aaBytecodeHash;

    event AccountDeployed(address indexed account, bytes32 indexed salt, address indexed initialModule);

    constructor(bytes32 _aaBytecodeHash) {
        aaBytecodeHash = _aaBytecodeHash;
    }

    /// @notice Deploy a `CofferdamSmartAccount` bootstrapped with one authority.
    /// @param salt           Identity-derived CREATE2 salt (counterfactual key).
    /// @param initialModule  Bootstrap authority module (passkey or session-key).
    /// @param initialConfig  Per-account material for that module.
    function deployAccount(bytes32 salt, IAuthorityModule initialModule, bytes calldata initialConfig)
        external
        returns (address accountAddress)
    {
        bytes memory input = abi.encode(initialModule, initialConfig);

        (bool success, bytes memory returnData) = SystemContractsCaller.systemCallWithReturndata(
            uint32(gasleft()),
            address(DEPLOYER_SYSTEM_CONTRACT),
            uint128(0),
            abi.encodeCall(
                DEPLOYER_SYSTEM_CONTRACT.create2Account,
                (salt, aaBytecodeHash, input, IContractDeployer.AccountAbstractionVersion.Version1)
            )
        );
        require(success, "Deployment failed");

        (accountAddress) = abi.decode(returnData, (address));
        emit AccountDeployed(accountAddress, salt, address(initialModule));
    }

    /// @notice Counterfactual address of the account for `salt` + bootstrap args,
    ///         computed exactly as the protocol's CREATE2 derivation does.
    function getAccountAddress(bytes32 salt, IAuthorityModule initialModule, bytes calldata initialConfig)
        external
        view
        returns (address)
    {
        bytes32 inputHash = keccak256(abi.encode(initialModule, initialConfig));
        return L2ContractHelper.computeCreate2Address(address(this), salt, aaBytecodeHash, inputHash);
    }
}
