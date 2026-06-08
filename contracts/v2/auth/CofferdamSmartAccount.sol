// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccount, ACCOUNT_VALIDATION_SUCCESS_MAGIC} from "@matterlabs/zksync-contracts/contracts/system-contracts/interfaces/IAccount.sol";
import {TransactionHelper, Transaction} from "@matterlabs/zksync-contracts/contracts/system-contracts/libraries/TransactionHelper.sol";
import {SystemContractsCaller} from "@matterlabs/zksync-contracts/contracts/system-contracts/libraries/SystemContractsCaller.sol";
import {Utils} from "@matterlabs/zksync-contracts/contracts/system-contracts/libraries/Utils.sol";
import {
    BOOTLOADER_FORMAL_ADDRESS,
    NONCE_HOLDER_SYSTEM_CONTRACT,
    DEPLOYER_SYSTEM_CONTRACT,
    INonceHolder
} from "@matterlabs/zksync-contracts/contracts/system-contracts/Constants.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {IAuthorityModule, Tier} from "./IAuthorityModule.sol";
import {AuthorityManagerBase} from "./AuthorityManagerBase.sol";

/// @title CofferdamSmartAccount
/// @notice The **production** ZKSync Era native Account Abstraction (`IAccount`)
///         realisation of Cofferdam's tiered-authority identity. It is the native
///         sibling of the custom-`execute` `CofferdamAccount` test harness: both
///         inherit the same `AuthorityManagerBase`, so the authority registry,
///         passkey cap, and one-way legacy→passkey ratchet behave identically.
///         The only difference is the *replay scheme* and *execution surface*:
///           - replay protection here is the protocol `NonceHolder`;
///           - the signed digest is the ZKSync transaction hash;
///           - execution is the bootloader-driven `executeTransaction`.
///
/// @dev    SIGNATURE ENCODING. `Transaction.signature` is
///         `abi.encode(uint256 authorityId, bytes innerSignature)`. `authorityId`
///         selects which on-account authority is asserting, and `innerSignature`
///         is that authority module's native proof over the tx hash (a P-256
///         WebAuthn assertion for a passkey, an ECDSA signature for the legacy
///         session bridge). Validation is non-reverting (returns a zero magic on
///         failure) so the operator's fee-estimation pass works.
///
///         PER-TIER TRANSACTION GATING (mirrors `CofferdamAccount`, enforced in
///         `_validateTransaction` where the tx target + selector are visible):
///           - High / LowManaged → may authorise ANY transaction, including
///             self-calls to `addAuthority` / `revokeAuthority` (management).
///           - LowUntrusted      → may ONLY authorise a zero-value self-call to
///             `enrollFirstPasskey`; the ratchet then permanently locks it out.
///
///         MANAGEMENT AS SELF-CALLS. `addAuthority` / `revokeAuthority` /
///         `enrollFirstPasskey` are `onlySelf`: they can only run as the *target*
///         of an already-validated `executeTransaction`, so the tx-level
///         signature + tier gate is their sole authorisation. They do not
///         re-verify a signature.
contract CofferdamSmartAccount is IAccount, IERC1271, AuthorityManagerBase {
    using TransactionHelper for Transaction;

    bytes4 private constant EIP1271_SUCCESS = 0x1626ba7e;

    error OnlyBootloader();
    error OnlySelf();
    error InsufficientBalanceForFee();
    error ExecutionFailed();

    modifier onlyBootloader() {
        if (msg.sender != BOOTLOADER_FORMAL_ADDRESS) revert OnlyBootloader();
        _;
    }

    /// @dev Management entrypoints may only be reached as the validated target of
    ///      this account's own `executeTransaction` (or a direct self-call).
    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    constructor(IAuthorityModule initialModule, bytes memory initialConfig) {
        _initFirstAuthority(initialModule, initialConfig);
    }

    // ── IAccount: validation ───────────────────────────────────────────────────

    function validateTransaction(bytes32, bytes32 _suggestedSignedHash, Transaction calldata _transaction)
        external
        payable
        override
        onlyBootloader
        returns (bytes4 magic)
    {
        return _validateTransaction(_suggestedSignedHash, _transaction);
    }

    function _validateTransaction(bytes32 _suggestedSignedHash, Transaction calldata _transaction)
        internal
        returns (bytes4 magic)
    {
        // Bump the protocol nonce (replay protection for the native account).
        SystemContractsCaller.systemCallWithPropagatedRevert(
            uint32(gasleft()),
            address(NONCE_HOLDER_SYSTEM_CONTRACT),
            0,
            abi.encodeCall(INonceHolder.incrementMinNonceIfEquals, (_transaction.nonce))
        );

        bytes32 txHash =
            _suggestedSignedHash == bytes32(0) ? _transaction.encodeHash() : _suggestedSignedHash;

        // Operator must be paid; verifying balance here mirrors the canonical
        // pattern and avoids being charged for an un-includable tx.
        uint256 totalRequiredBalance = _transaction.totalRequiredBalance();
        if (totalRequiredBalance > address(this).balance) revert InsufficientBalanceForFee();

        (uint256 authorityId, bytes memory innerSignature) =
            abi.decode(_transaction.signature, (uint256, bytes));

        // Non-reverting authority check so fee estimation succeeds on bad sigs.
        Tier tier = _checkAuthority(authorityId, txHash, innerSignature);
        if (tier != Tier.None && _tierPermitsTx(tier, _transaction)) {
            magic = ACCOUNT_VALIDATION_SUCCESS_MAGIC;
        } else {
            magic = bytes4(0);
        }
    }

    /// @dev Non-reverting variant of `_authenticate`: returns the asserting
    ///      authority's tier, or `Tier.None` if the authority is unknown,
    ///      inactive, or the signature does not verify.
    function _checkAuthority(uint256 authorityId, bytes32 digest, bytes memory signature)
        internal
        view
        returns (Tier)
    {
        Authority storage a = _authorities[authorityId];
        if (address(a.module) == address(0) || !a.active) return Tier.None;
        if (!a.module.isValidSignature(address(this), digest, a.config, signature)) return Tier.None;
        return a.tier;
    }

    /// @dev Decide whether `tier` may authorise `_transaction`. High/LowManaged
    ///      authorise anything; LowUntrusted is confined to a zero-value self-call
    ///      to `enrollFirstPasskey` (the one-way migration entrypoint).
    function _tierPermitsTx(Tier tier, Transaction calldata _transaction) internal view returns (bool) {
        if (tier == Tier.High || tier == Tier.LowManaged) return true;
        if (tier == Tier.LowUntrusted) {
            if (address(uint160(_transaction.to)) != address(this)) return false;
            if (_transaction.value != 0) return false;
            if (_transaction.data.length < 4) return false;
            return bytes4(_transaction.data[:4]) == this.enrollFirstPasskey.selector;
        }
        return false;
    }

    // ── IAccount: execution ────────────────────────────────────────────────────

    function executeTransaction(bytes32, bytes32, Transaction calldata _transaction)
        external
        payable
        override
        onlyBootloader
    {
        _executeTransaction(_transaction);
    }

    /// @notice Lets a self-validated transaction be replayed by anyone holding the
    ///         signed payload (e.g. a relayer), bypassing the bootloader path.
    function executeTransactionFromOutside(Transaction calldata _transaction) external payable {
        bytes4 magic = _validateTransaction(bytes32(0), _transaction);
        require(magic == ACCOUNT_VALIDATION_SUCCESS_MAGIC, "NOT VALIDATED");
        _executeTransaction(_transaction);
    }

    function _executeTransaction(Transaction calldata _transaction) internal {
        address to = address(uint160(_transaction.to));
        uint128 value = Utils.safeCastToU128(_transaction.value);
        bytes memory data = _transaction.data;

        if (to == address(DEPLOYER_SYSTEM_CONTRACT)) {
            // Deploys must go through the system caller with EraVM extensions on.
            uint32 gas = Utils.safeCastToU32(gasleft());
            SystemContractsCaller.systemCallWithPropagatedRevert(gas, to, value, data);
        } else {
            bool success;
            assembly {
                success := call(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
            if (!success) revert ExecutionFailed();
        }
    }

    // ── IAccount: fee + paymaster ───────────────────────────────────────────────

    function payForTransaction(bytes32, bytes32, Transaction calldata _transaction)
        external
        payable
        override
        onlyBootloader
    {
        bool success = _transaction.payToTheBootloader();
        require(success, "Failed to pay the fee to the operator");
    }

    function prepareForPaymaster(bytes32, bytes32, Transaction calldata _transaction)
        external
        payable
        override
        onlyBootloader
    {
        _transaction.processPaymasterInput();
    }

    // ── IERC1271 ────────────────────────────────────────────────────────────────

    /// @notice EIP-1271: a hash is "signed by this account" iff `_signature`
    ///         (`abi.encode(authorityId, innerSig)`) verifies under any active
    ///         authority. No tier gating here — that is a transaction-level policy.
    function isValidSignature(bytes32 _hash, bytes memory _signature)
        public
        view
        override
        returns (bytes4 magic)
    {
        (uint256 authorityId, bytes memory innerSignature) = abi.decode(_signature, (uint256, bytes));
        return _checkAuthority(authorityId, _hash, innerSignature) != Tier.None
            ? EIP1271_SUCCESS
            : bytes4(0);
    }

    // ── Management (only reachable via a validated self-call) ────────────────────

    /// @notice Add a new authority (backup passkey ≤ MAX_PASSKEYS, or an
    ///         OR-semantics managed/Self authority). Authorised at the tx layer by
    ///         a High/LowManaged signature gating this self-call.
    function addAuthority(IAuthorityModule newModule, bytes calldata newConfig)
        external
        onlySelf
        returns (uint256 newAuthorityId)
    {
        if (address(newModule) == address(0)) revert ZeroModule();
        newAuthorityId = _addAuthority(newModule, newConfig);
    }

    /// @notice Deactivate an authority. Authorised at the tx layer by a
    ///         High/LowManaged signature gating this self-call.
    function revokeAuthority(uint256 targetId) external onlySelf {
        _revokeAuthorityRecord(targetId);
    }

    /// @notice Enrol the FIRST device passkey and fire the one-way ratchet.
    ///         Reachable only via a zero-value self-call authorised at the tx
    ///         layer by a LowUntrusted signature (see `_tierPermitsTx`).
    function enrollFirstPasskey(IAuthorityModule passkeyModule, bytes calldata passkeyConfig)
        external
        onlySelf
        returns (uint256 passkeyAuthorityId)
    {
        _preEnrollChecks(passkeyModule);
        passkeyAuthorityId = _enrollFirstPasskey(0, passkeyModule, passkeyConfig);
    }

    fallback() external {
        // Must never be invoked by the bootloader; behaves like an EOA otherwise.
        assert(msg.sender != BOOTLOADER_FORMAL_ADDRESS);
    }

    receive() external payable {}
}
