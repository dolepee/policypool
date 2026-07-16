// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CoverageEvidenceVerifier} from "../../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../../src/CoverageManager.sol";

abstract contract CoverageEvidenceTestBase is Test {
    CoverageEvidenceVerifier internal evidenceVerifier;
    address internal evidenceSignerOne;
    address internal evidenceSignerTwo;
    uint256 internal evidenceSignerKeyOne;
    uint256 internal evidenceSignerKeyTwo;

    function _setUpEvidenceVerifier() internal {
        (evidenceSignerOne, evidenceSignerKeyOne) = makeAddrAndKey("evidence-signer-one");
        (evidenceSignerTwo, evidenceSignerKeyTwo) = makeAddrAndKey("evidence-signer-two");
        address[] memory signers = new address[](2);
        signers[0] = evidenceSignerOne;
        signers[1] = evidenceSignerTwo;
        evidenceVerifier = new CoverageEvidenceVerifier(signers, 2);
    }

    function _signatures(bytes32 digest) internal view returns (bytes[] memory signatures) {
        bytes memory first = _signature(evidenceSignerKeyOne, digest);
        bytes memory second = _signature(evidenceSignerKeyTwo, digest);
        signatures = new bytes[](2);
        if (evidenceSignerOne < evidenceSignerTwo) {
            signatures[0] = first;
            signatures[1] = second;
        } else {
            signatures[0] = second;
            signatures[1] = first;
        }
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _issue(CoverageManager manager, CoverageManager.IssueEvidence memory evidence)
        internal
        returns (bytes32 covenantId)
    {
        covenantId = manager.issue(evidence, _signatures(manager.issueEvidenceDigest(evidence)));
    }

    function _startClock(CoverageManager manager, CoverageManager.ClockEvidence memory evidence) internal {
        manager.startClock(evidence, _signatures(manager.clockEvidenceDigest(evidence)));
    }

    function _release(CoverageManager manager, CoverageManager.ReleaseEvidence memory evidence) internal {
        manager.release(evidence, _signatures(manager.releaseEvidenceDigest(evidence)));
    }

    function _markPayoutDue(CoverageManager manager, CoverageManager.BreachEvidence memory evidence) internal {
        manager.markPayoutDue(evidence, _signatures(manager.breachEvidenceDigest(evidence)));
    }

    function _settle(CoverageManager manager, CoverageManager.SettlementEvidence memory evidence)
        internal
        returns (uint256 payout)
    {
        payout = manager.settleNetLoss(evidence, _signatures(manager.settlementEvidenceDigest(evidence)));
    }
}
