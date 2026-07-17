// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockOkxTaskStatus {
    mapping(bytes32 jobId => uint8 status) public statuses;

    function setJobStatus(bytes32 jobId, uint8 status) external {
        statuses[jobId] = status;
    }

    function getJobStatus(bytes32 jobId) external view returns (uint8) {
        return statuses[jobId];
    }
}
