// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CallEcho
/// @notice Test-only call target. Records the last call so tests can assert that
///         `CofferdamAccount.execute` actually forwarded value + data.
contract CallEcho {
    uint256 public lastArg;
    uint256 public lastValue;
    address public lastCaller;
    uint256 public calls;

    event Poked(address caller, uint256 arg, uint256 value);

    function poke(uint256 arg) external payable {
        lastArg = arg;
        lastValue = msg.value;
        lastCaller = msg.sender;
        calls++;
        emit Poked(msg.sender, arg, msg.value);
    }

    function boom() external pure {
        revert("CallEcho: boom");
    }
}
