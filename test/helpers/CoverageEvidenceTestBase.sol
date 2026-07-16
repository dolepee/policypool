// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CoverageEvidenceVerifier} from "../../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../../src/CoverageManager.sol";

abstract contract CoverageEvidenceTestBase is Test {
    CoverageEvidenceVerifier internal evidenceVerifier;
    CoverageEvidenceVerifier internal recoveryEvidenceVerifier;
    address internal evidenceSignerOne;
    address internal evidenceSignerTwo;
    address internal evidenceSignerThree;
    address internal evidenceSignerFour;
    address internal evidenceSignerFive;
    uint256 internal evidenceSignerKeyOne;
    uint256 internal evidenceSignerKeyTwo;
    uint256 internal evidenceSignerKeyThree;
    uint256 internal evidenceSignerKeyFour;
    uint256 internal evidenceSignerKeyFive;
    address internal recoveryEvidenceSignerOne;
    address internal recoveryEvidenceSignerTwo;
    address internal recoveryEvidenceSignerThree;
    address internal recoveryEvidenceSignerFour;
    address internal recoveryEvidenceSignerFive;
    uint256 internal recoveryEvidenceSignerKeyOne;
    uint256 internal recoveryEvidenceSignerKeyTwo;
    uint256 internal recoveryEvidenceSignerKeyThree;
    uint256 internal recoveryEvidenceSignerKeyFour;
    uint256 internal recoveryEvidenceSignerKeyFive;

    function _setUpEvidenceVerifier() internal {
        (evidenceSignerOne, evidenceSignerKeyOne) = makeAddrAndKey("evidence-signer-one");
        (evidenceSignerTwo, evidenceSignerKeyTwo) = makeAddrAndKey("evidence-signer-two");
        (evidenceSignerThree, evidenceSignerKeyThree) = makeAddrAndKey("evidence-signer-three");
        (evidenceSignerFour, evidenceSignerKeyFour) = makeAddrAndKey("evidence-signer-four");
        (evidenceSignerFive, evidenceSignerKeyFive) = makeAddrAndKey("evidence-signer-five");
        address[] memory signers = new address[](5);
        signers[0] = evidenceSignerOne;
        signers[1] = evidenceSignerTwo;
        signers[2] = evidenceSignerThree;
        signers[3] = evidenceSignerFour;
        signers[4] = evidenceSignerFive;
        evidenceVerifier = new CoverageEvidenceVerifier(signers, 3);

        (recoveryEvidenceSignerOne, recoveryEvidenceSignerKeyOne) = makeAddrAndKey("recovery-evidence-signer-one");
        (recoveryEvidenceSignerTwo, recoveryEvidenceSignerKeyTwo) = makeAddrAndKey("recovery-evidence-signer-two");
        (recoveryEvidenceSignerThree, recoveryEvidenceSignerKeyThree) = makeAddrAndKey("recovery-evidence-signer-three");
        (recoveryEvidenceSignerFour, recoveryEvidenceSignerKeyFour) = makeAddrAndKey("recovery-evidence-signer-four");
        (recoveryEvidenceSignerFive, recoveryEvidenceSignerKeyFive) = makeAddrAndKey("recovery-evidence-signer-five");
        address[] memory recoverySigners = new address[](5);
        recoverySigners[0] = recoveryEvidenceSignerOne;
        recoverySigners[1] = recoveryEvidenceSignerTwo;
        recoverySigners[2] = recoveryEvidenceSignerThree;
        recoverySigners[3] = recoveryEvidenceSignerFour;
        recoverySigners[4] = recoveryEvidenceSignerFive;
        recoveryEvidenceVerifier = new CoverageEvidenceVerifier(recoverySigners, 3);
    }

    function _recoverySignatures(bytes32 digest) internal view returns (bytes[] memory signatures) {
        signatures = _orderedThresholdSignatures(
            digest,
            recoveryEvidenceSignerOne,
            recoveryEvidenceSignerKeyOne,
            recoveryEvidenceSignerTwo,
            recoveryEvidenceSignerKeyTwo,
            recoveryEvidenceSignerThree,
            recoveryEvidenceSignerKeyThree
        );
    }

    function _signatures(bytes32 digest) internal view returns (bytes[] memory signatures) {
        signatures = _orderedThresholdSignatures(
            digest,
            evidenceSignerOne,
            evidenceSignerKeyOne,
            evidenceSignerTwo,
            evidenceSignerKeyTwo,
            evidenceSignerThree,
            evidenceSignerKeyThree
        );
    }

    function _orderedThresholdSignatures(
        bytes32 digest,
        address signerOne,
        uint256 keyOne,
        address signerTwo,
        uint256 keyTwo,
        address signerThree,
        uint256 keyThree
    ) private pure returns (bytes[] memory signatures) {
        address[] memory signerAddresses = new address[](3);
        signerAddresses[0] = signerOne;
        signerAddresses[1] = signerTwo;
        signerAddresses[2] = signerThree;
        signatures = new bytes[](3);
        signatures[0] = _signature(keyOne, digest);
        signatures[1] = _signature(keyTwo, digest);
        signatures[2] = _signature(keyThree, digest);
        for (uint256 left; left < signerAddresses.length; ++left) {
            for (uint256 right = left + 1; right < signerAddresses.length; ++right) {
                if (signerAddresses[right] < signerAddresses[left]) {
                    (signerAddresses[left], signerAddresses[right]) = (signerAddresses[right], signerAddresses[left]);
                    (signatures[left], signatures[right]) = (signatures[right], signatures[left]);
                }
            }
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
