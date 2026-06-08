// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    IPaymaster,
    ExecutionResult,
    PAYMASTER_VALIDATION_SUCCESS_MAGIC
} from "@matterlabs/zksync-contracts/contracts/system-contracts/interfaces/IPaymaster.sol";
import {IPaymasterFlow} from "@matterlabs/zksync-contracts/contracts/system-contracts/interfaces/IPaymasterFlow.sol";
import {TransactionHelper, Transaction} from "@matterlabs/zksync-contracts/contracts/system-contracts/libraries/TransactionHelper.sol";
import {BOOTLOADER_FORMAL_ADDRESS} from "@matterlabs/zksync-contracts/contracts/system-contracts/Constants.sol";

/// @title CofferdamPaymaster
/// @notice Gas sponsor for Cofferdam smart accounts on ZKSync Era. It implements
///         the `general` paymaster flow and pays the bootloader the full fee, so
///         a brand-new passkey user with a zero-balance counterfactual account can
///         transact (enrol a passkey, execute) without ever holding ETH.
///
/// @dev    The paymaster is funded by its `owner` (the Cofferdam deployer on
///         Sepolia) topping up this contract's balance. Sponsorship policy:
///           - `open == true`  → sponsor any account (convenient for testnet);
///           - `open == false` → sponsor only `sponsored[account]` allowlisted
///             addresses (the production-leaning posture).
///
///         α-SCOPE NOTE: production hardening (bind sponsorship to accounts
///         provably deployed by `CofferdamAccountFactory`, or to a signed
///         server-issued sponsorship voucher carried in `paymasterInput`, plus
///         per-account rate/spend limits) is a deliberate follow-up. The
///         allowlist + open toggle is the minimal safe testnet control.
contract CofferdamPaymaster is IPaymaster {
    using TransactionHelper for Transaction;

    address public owner;
    bool public open;
    mapping(address => bool) public sponsored;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OpenModeSet(bool open);
    event SponsorshipSet(address indexed account, bool sponsored);
    event Withdrawn(address indexed to, uint256 amount);

    error OnlyBootloader();
    error OnlyOwner();
    error UnsupportedPaymasterFlow();
    error AccountNotSponsored(address account);
    error FeeTransferFailed();

    modifier onlyBootloader() {
        if (msg.sender != BOOTLOADER_FORMAL_ADDRESS) revert OnlyBootloader();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @param _open Start in open (sponsor-all) mode — recommended only on testnet.
    constructor(bool _open) {
        owner = msg.sender;
        open = _open;
        emit OwnerChanged(address(0), msg.sender);
        emit OpenModeSet(_open);
    }

    // ── IPaymaster ──────────────────────────────────────────────────────────────

    function validateAndPayForPaymasterTransaction(bytes32, bytes32, Transaction calldata _transaction)
        external
        payable
        override
        onlyBootloader
        returns (bytes4 magic, bytes memory)
    {
        magic = PAYMASTER_VALIDATION_SUCCESS_MAGIC;
        require(_transaction.paymasterInput.length >= 4, "paymasterInput too short");

        // The account being sponsored is the transaction sender.
        address account = address(uint160(_transaction.from));
        if (!open && !sponsored[account]) revert AccountNotSponsored(account);

        bytes4 flow = bytes4(_transaction.paymasterInput[0:4]);
        if (flow != IPaymasterFlow.general.selector) revert UnsupportedPaymasterFlow();

        uint256 requiredETH = _transaction.gasLimit * _transaction.maxFeePerGas;
        (bool success,) = payable(BOOTLOADER_FORMAL_ADDRESS).call{value: requiredETH}("");
        if (!success) revert FeeTransferFailed();

        return (magic, "");
    }

    function postTransaction(
        bytes calldata,
        Transaction calldata,
        bytes32,
        bytes32,
        ExecutionResult,
        uint256
    ) external payable override onlyBootloader {}

    // ── Owner controls ───────────────────────────────────────────────────────────

    function setOpen(bool _open) external onlyOwner {
        open = _open;
        emit OpenModeSet(_open);
    }

    function setSponsored(address account, bool isSponsored) external onlyOwner {
        sponsored[account] = isSponsored;
        emit SponsorshipSet(account, isSponsored);
    }

    function setSponsoredBatch(address[] calldata accounts, bool isSponsored) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            sponsored[accounts[i]] = isSponsored;
            emit SponsorshipSet(accounts[i], isSponsored);
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert FeeTransferFailed();
        emit Withdrawn(to, amount);
    }

    receive() external payable {}
}
