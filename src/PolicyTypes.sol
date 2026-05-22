// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pool-level limits enforced by PolicyPoolHook before a v4 swap executes.
struct Policy {
    uint256 maxSwapAmount;
    uint256 dailyCap;
    uint256 spentToday;
    uint64 lastResetTimestamp;
}

library PolicyReasons {
    bytes32 internal constant POLICY_NOT_SET = "POLICY_NOT_SET";
    bytes32 internal constant EXACT_OUTPUT_NOT_SUPPORTED = "EXACT_OUTPUT_NOT_SUPPORTED";
    bytes32 internal constant MAX_SWAP_EXCEEDED = "MAX_SWAP_EXCEEDED";
    bytes32 internal constant DAILY_CAP_EXCEEDED = "DAILY_CAP_EXCEEDED";
}

error PolicyBlocked(bytes32 reason, uint256 attempted, uint256 limit);
error InvalidPolicy();
error NotPolicyOwner();
error OnlyPoolManager();
