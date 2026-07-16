// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {OkxA2AClockAdapter} from "../src/adapters/OkxA2AClockAdapter.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";
import {MockOkxTaskStatus} from "../src/mocks/MockOkxTaskStatus.sol";

contract CoverageAdaptersTest is Test {
    MockOkxTaskStatus internal taskStatus;
    OkxA2AClockAdapter internal a2aAdapter;
    RelayReceiptVerifier internal relayVerifier;
    address internal signer;
    uint256 internal signerKey;
    bytes32 internal constant JOB_ID = keccak256("adapter-job");

    function setUp() public {
        taskStatus = new MockOkxTaskStatus();
        a2aAdapter = new OkxA2AClockAdapter(address(taskStatus));
        (signer, signerKey) = makeAddrAndKey("relay-signer");
        relayVerifier = new RelayReceiptVerifier(address(this), signer);
    }

    function testA2AClockHoldsThenBreachesAcceptedJob() public {
        taskStatus.setJobStatus(JOB_ID, 1);
        (, OkxA2AClockAdapter.Action beforeDeadline) = a2aAdapter.observe(JOB_ID, uint64(block.timestamp + 60));
        assertEq(uint256(beforeDeadline), uint256(OkxA2AClockAdapter.Action.Hold));

        vm.warp(block.timestamp + 61);
        (, OkxA2AClockAdapter.Action afterDeadline) = a2aAdapter.observe(JOB_ID, uint64(block.timestamp - 1));
        assertEq(uint256(afterDeadline), uint256(OkxA2AClockAdapter.Action.Breach));
    }

    function testA2AClockReleasesDeliveredOrTerminalJob() public {
        taskStatus.setJobStatus(JOB_ID, 2);
        (, OkxA2AClockAdapter.Action delivered) = a2aAdapter.observe(JOB_ID, uint64(block.timestamp + 60));
        assertEq(uint256(delivered), uint256(OkxA2AClockAdapter.Action.Release));

        taskStatus.setJobStatus(JOB_ID, 9);
        (, OkxA2AClockAdapter.Action refunded) = a2aAdapter.observe(JOB_ID, uint64(block.timestamp - 1));
        assertEq(uint256(refunded), uint256(OkxA2AClockAdapter.Action.Release));
    }

    function testRelayReceiptSignatureVerifiesAndTamperingFails() public view {
        bytes32 receiptDigest = keccak256("relay-receipt");
        bytes32 digest = relayVerifier.messageDigest(receiptDigest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        assertTrue(relayVerifier.verify(receiptDigest, signature));
        assertFalse(relayVerifier.verify(keccak256("tampered"), signature));
    }
}
