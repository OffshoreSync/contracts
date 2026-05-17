// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISelfGroth16Verifier} from "../ISelfGroth16Verifier.sol";

/// @title MockSelfGroth16Verifier
/// @notice Drop-in replacement for the real `Verifier_vc_and_disclose` whose result
///         can be set by the test harness. Lets us exercise `NullifierRegistry`
///         and downstream consumers without juggling real Groth16 inputs.
/// @dev    There is **no** cryptographic check here — `verifyProof` ignores its
///         arguments entirely and returns whatever the harness configured. This is
///         intentional: the mock's job is to control the `(true | false)` branch
///         of the verifier path so we can unit-test the rest of the stack.
///         Verifier call-count assertions are not needed because the consumer
///         (`NullifierRegistry`) emits `NullifierBound` only on the true branch —
///         the presence/absence of that event is sufficient to prove the verifier
///         was exercised.
contract MockSelfGroth16Verifier is ISelfGroth16Verifier {
    /// @notice The boolean returned by every `verifyProof` call.
    bool public result;

    constructor(bool _initialResult) {
        result = _initialResult;
    }

    /// @notice Configure the next return value.
    /// @dev    Permissionless on purpose — tests usually run as the deployer; if
    ///         we ever need access control here, restrict it then.
    function setResult(bool _result) external {
        result = _result;
    }

    function verifyProof(
        uint256[2] calldata, /* a */
        uint256[2][2] calldata, /* b */
        uint256[2] calldata, /* c */
        uint256[21] calldata /* pubSignals */
    ) external view override returns (bool) {
        return result;
    }
}
