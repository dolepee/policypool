// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IOkxTaskStatus {
    function getJobStatus(bytes32 jobId) external view returns (uint8);
}

/// @notice Coarse on-chain status observation for OKX A2A jobs.
/// @dev Historical delivery timing is still proven from the status-change log;
///      this adapter intentionally does not pretend a current status proves time.
contract OkxA2AClockAdapter {
    enum Action {
        Hold,
        Release,
        Breach
    }

    IOkxTaskStatus public immutable taskEscrow;

    constructor(address taskEscrow_) {
        require(taskEscrow_ != address(0), "task escrow required");
        taskEscrow = IOkxTaskStatus(taskEscrow_);
    }

    function observe(bytes32 jobId, uint64 deadline) external view returns (uint8 status, Action action) {
        status = taskEscrow.getJobStatus(jobId);
        if (status == 1) {
            action = block.timestamp > deadline ? Action.Breach : Action.Hold;
        } else if (status >= 2 && status <= 9) {
            action = Action.Release;
        } else {
            action = Action.Hold;
        }
    }
}
