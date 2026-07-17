// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {CoverageEvidenceTestBase} from "./helpers/CoverageEvidenceTestBase.sol";

contract V04FreshnessAndRecoveryTest is CoverageEvidenceTestBase {
    MockERC20 internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;
    CoverageManager internal manager;

    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal adapter = makeAddr("adapter");
    bytes32 internal constant MARKETPLACE = keccak256("OKX.AI");
    bytes32 internal constant FINGERPRINT = keccak256("freshness-service-v1");
    uint256 internal jobNonce;
    bytes32 internal policyId;

    function setUp() public {
        _setUpEvidenceVerifier();
        asset = new MockERC20("USD0", "USD0", 6);
        vault = new ProviderBondVault(address(asset), address(this), 8 days);
        identity = new MockAgentIdentityRegistry();
        registry = new AgentPolicyRegistry(address(identity), address(vault), address(this), 500_000, 7 days);
        manager = new CoverageManager(
            address(registry), address(vault), address(evidenceVerifier), address(recoveryEvidenceVerifier)
        );
        vault.initializeManager(address(manager));

        identity.setOwner(3808, provider);
        asset.mint(provider, 5_000_000);
        vm.startPrank(provider);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(5_000_000);
        policyId = registry.registerPolicy(_terms());
        vm.stopPrank();
    }

    function testStaleZeroRecoverySettlementCannotDoublePayAfterRefundWindow() public {
        bytes32 id = _issueDefault();
        _advancePastDeadlineAndBreach(id);
        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);

        CoverageManager.SettlementEvidence memory stale = _settlement(id, 0, 0, true, "ZERO_RECOVERY");
        bytes[] memory signatures = _signatures(manager.settlementEvidenceDigest(stale));
        vm.warp(uint256(stale.observedAt) + manager.SETTLEMENT_EVIDENCE_MAX_AGE() + 1);

        vm.expectRevert(CoverageManager.EvidenceStale.selector);
        manager.settleNetLoss(stale, signatures);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PayoutDue));
        assertEq(asset.balanceOf(buyer), 0);
        assertEq(vault.availableBond(provider), 4_500_000);
    }

    function testSettlementRequiresExplicitTerminalRecoveryAttestation() public {
        bytes32 id = _issueDefault();
        _advancePastDeadlineAndBreach(id);

        CoverageManager.SettlementEvidence memory nonterminal = _settlement(id, 0, 0, false, "NOT_FINAL");
        bytes[] memory signatures = _signatures(manager.settlementEvidenceDigest(nonterminal));

        vm.expectRevert(CoverageManager.RecoveryNotFinal.selector);
        manager.settleNetLoss(nonterminal, signatures);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PayoutDue));
    }

    function testLateCompletionCannotRaceAndBeatBreach() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + 1);

        CoverageManager.ReleaseEvidence memory late = CoverageManager.ReleaseEvidence({
            covenantId: id,
            completedAt: uint64(block.timestamp),
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("LATE_DELIVERY")
        });
        bytes[] memory lateSignatures = _signatures(manager.releaseEvidenceDigest(late));
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.release(late, lateSignatures);

        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("MISSED_DEADLINE")
        });
        _markPayoutDue(manager, breach);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PayoutDue));
    }

    function testOnTimeCompletionCanStillBeRelayedAfterDeadline() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + 1 hours);

        CoverageManager.ReleaseEvidence memory ontime = CoverageManager.ReleaseEvidence({
            covenantId: id,
            completedAt: deadline,
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("ONTIME_DELIVERY")
        });
        _release(manager, ontime);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Released));
        assertEq(vault.availableBond(provider), 5_000_000);
    }

    function testOnTimeCompletionCanCorrectProvisionalBreachDuringChallenge() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + 1);
        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("PROVISIONAL_BREACH")
        });
        _markPayoutDue(manager, breach);

        CoverageManager.ReleaseEvidence memory ontime = CoverageManager.ReleaseEvidence({
            covenantId: id,
            completedAt: deadline,
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("LATE_ARRIVING_ONTIME_PROOF")
        });
        _release(manager, ontime);

        CoverageManager.Covenant memory covenant = manager.getCovenant(id);
        assertEq(uint256(covenant.state), uint256(CoverageManager.CovenantState.Released));
        assertEq(covenant.completedAt, deadline);
        assertEq(vault.availableBond(provider), 5_000_000);
    }

    function testSettlementCannotBeatReleaseDuringChallengePeriod() public {
        bytes32 id = _issueDefault();
        _advancePastDeadlineAndBreach(id);
        CoverageManager.SettlementEvidence memory settlement = _settlement(id, 0, 0, true, "TERMINAL_RECOVERY");
        bytes[] memory earlySignatures = _signatures(manager.settlementEvidenceDigest(settlement));

        vm.expectRevert(CoverageManager.SettlementChallengeActive.selector);
        manager.settleNetLoss(settlement, earlySignatures);

        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        settlement.observedAt = uint64(block.timestamp);
        assertEq(_settle(manager, settlement), 500_000);
    }

    function testRecoveryQuorumCannotActEarlyOrReusePrimarySignatures() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + manager.EMERGENCY_EVIDENCE_DELAY());

        CoverageManager.ReleaseEvidence memory evidence = CoverageManager.ReleaseEvidence({
            covenantId: id,
            completedAt: deadline,
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("RECOVERY_RELEASE")
        });
        bytes[] memory recoverySignatures = _recoverySignatures(manager.emergencyReleaseEvidenceDigest(evidence));
        vm.expectRevert(CoverageManager.EmergencyResolutionNotReady.selector);
        manager.emergencyRelease(evidence, recoverySignatures);

        vm.warp(block.timestamp + 1);
        evidence.observedAt = uint64(block.timestamp);
        bytes[] memory primarySignatures = _signatures(manager.releaseEvidenceDigest(evidence));
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        manager.emergencyRelease(evidence, primarySignatures);

        manager.emergencyRelease(evidence, _recoverySignatures(manager.emergencyReleaseEvidenceDigest(evidence)));
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Released));
    }

    function testRecoveryPathsRejectInapplicableCovenantStates() public {
        AgentPolicyRegistry.PolicyTerms memory relayTerms = _terms();
        relayTerms.serviceId = 33462;
        relayTerms.serviceFingerprint = keccak256("recovery-pending-service");
        relayTerms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(relayTerms);
        bytes32 jobId = keccak256("recovery-pending-job");
        CoverageManager.IssueEvidence memory pendingEvidence = CoverageManager.IssueEvidence({
            policyId: relayPolicyId,
            observedFingerprint: relayTerms.serviceFingerprint,
            jobId: jobId,
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: 500_000,
            buyerPaidAtomic: 500_000,
            verifiedAcceptanceAt: uint64(block.timestamp),
            enrollmentExpiresAt: uint64(block.timestamp + 60),
            acceptanceEvidenceHash: keccak256(abi.encode("OKX_ACCEPTANCE", jobId)),
            feeAuthorization: CoverageManager.FeeAuthorization({
                authorizationHash: keccak256(abi.encode("POLICYPOOL_FEE_AUTHORIZATION", jobId)),
                validBefore: uint64(block.timestamp + 600)
            })
        });
        bytes32 pendingId = _issue(manager, pendingEvidence);
        CoverageManager.ReleaseEvidence memory pendingRelease = CoverageManager.ReleaseEvidence({
            covenantId: pendingId,
            completedAt: uint64(block.timestamp),
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("PENDING_RELEASE")
        });
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.emergencyRelease(pendingRelease, new bytes[](0));

        bytes32 activeId = _issueDefault();
        CoverageManager.SettlementEvidence memory premature = _settlement(activeId, 0, 0, true, "ACTIVE_SETTLEMENT");
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.emergencySettleNetLoss(premature, new bytes[](0));
    }

    function testRecoveryQuorumCanFinishBreachAndTerminalSettlementAfterDelay() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + manager.EMERGENCY_EVIDENCE_DELAY() + 1);

        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("RECOVERY_QUORUM_BREACH")
        });
        manager.emergencyMarkPayoutDue(breach, _recoverySignatures(manager.emergencyBreachEvidenceDigest(breach)));

        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        CoverageManager.SettlementEvidence memory settlement = _settlement(id, 0, 0, true, "TERMINAL_ZERO_RECOVERY");
        uint256 payout = manager.emergencySettleNetLoss(
            settlement, _recoverySignatures(manager.emergencySettlementEvidenceDigest(settlement))
        );
        assertEq(payout, 500_000);
        assertEq(asset.balanceOf(buyer), 500_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Paid));
    }

    function testEmergencySettlementCannotSkipLateBreachChallenge() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        uint256 challengePeriod = manager.SETTLEMENT_CHALLENGE_PERIOD();
        uint256 emergencyDelay = manager.EMERGENCY_EVIDENCE_DELAY();

        vm.warp(uint256(deadline) + emergencyDelay - challengePeriod / 2);
        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("LATE_REPORTED_BREACH")
        });
        _markPayoutDue(manager, breach);

        vm.warp(uint256(deadline) + emergencyDelay + 1);
        CoverageManager.SettlementEvidence memory settlement =
            _settlement(id, 0, 0, true, "LATE_BREACH_TERMINAL_RECOVERY");
        bytes[] memory earlySignatures = _recoverySignatures(manager.emergencySettlementEvidenceDigest(settlement));
        vm.expectRevert(CoverageManager.SettlementChallengeActive.selector);
        manager.emergencySettleNetLoss(settlement, earlySignatures);

        uint64 payoutDueAt = manager.getCovenant(id).payoutDueAt;
        vm.warp(uint256(payoutDueAt) + challengePeriod + 1);
        settlement.observedAt = uint64(block.timestamp);
        uint256 payout = manager.emergencySettleNetLoss(
            settlement, _recoverySignatures(manager.emergencySettlementEvidenceDigest(settlement))
        );
        assertEq(payout, 500_000);
        assertEq(asset.balanceOf(buyer), 500_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Paid));
    }

    function testHeldBreachEvidenceCannotConsumeChallengeWindow() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + 1);

        CoverageManager.BreachEvidence memory heldBreach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("HELD_VALID_BREACH")
        });
        bytes[] memory heldSignatures = _signatures(manager.breachEvidenceDigest(heldBreach));

        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        manager.markPayoutDue(heldBreach, heldSignatures);
        uint64 committedAt = uint64(block.timestamp);
        assertEq(manager.getCovenant(id).payoutDueAt, committedAt);

        CoverageManager.SettlementEvidence memory immediate = _settlement(id, 0, 0, true, "FRESH_TERMINAL_RECOVERY");
        bytes[] memory immediateSignatures = _signatures(manager.settlementEvidenceDigest(immediate));
        vm.expectRevert(CoverageManager.SettlementChallengeActive.selector);
        manager.settleNetLoss(immediate, immediateSignatures);

        vm.warp(uint256(committedAt) + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        immediate.observedAt = uint64(block.timestamp);
        assertEq(_settle(manager, immediate), 500_000);
    }

    function _issueDefault() internal returns (bytes32 id) {
        bytes32 jobId = keccak256(abi.encode("freshness-job", ++jobNonce));
        CoverageManager.IssueEvidence memory evidence = CoverageManager.IssueEvidence({
            policyId: policyId,
            observedFingerprint: FINGERPRINT,
            jobId: jobId,
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: 500_000,
            buyerPaidAtomic: 500_000,
            verifiedAcceptanceAt: uint64(block.timestamp),
            enrollmentExpiresAt: uint64(block.timestamp + 60),
            acceptanceEvidenceHash: keccak256(abi.encode("OKX_ACCEPTANCE", jobId)),
            feeAuthorization: CoverageManager.FeeAuthorization({
                authorizationHash: keccak256(abi.encode("POLICYPOOL_FEE_AUTHORIZATION", jobId)),
                validBefore: uint64(block.timestamp + 600)
            })
        });
        id = _issue(manager, evidence);
    }

    function _advancePastDeadlineAndBreach(bytes32 id) internal {
        vm.warp(uint256(manager.getCovenant(id).deadline) + 1);
        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("DEADLINE_MISSED")
        });
        _markPayoutDue(manager, breach);
    }

    function _settlement(bytes32 id, uint128 refund, uint128 recovery, bool finalized, string memory label)
        internal
        view
        returns (CoverageManager.SettlementEvidence memory)
    {
        return CoverageManager.SettlementEvidence({
            covenantId: id,
            escrowRefundAtomic: refund,
            otherRecoveryAtomic: recovery,
            observedAt: uint64(block.timestamp),
            recoveryFinalized: finalized,
            recoveryEvidenceHash: keccak256(bytes(label))
        });
    }

    function _terms() internal view returns (AgentPolicyRegistry.PolicyTerms memory) {
        return AgentPolicyRegistry.PolicyTerms({
            marketplace: MARKETPLACE,
            agentId: 3808,
            serviceId: 33461,
            serviceFingerprint: FINGERPRINT,
            scopeHash: keccak256("standard-20-payload-audit"),
            slaSeconds: 300,
            enrollmentWindowSeconds: 60,
            maxCapAtomic: 500_000,
            premiumBps: 0,
            payoutBasis: 0,
            clockMode: 0,
            expiresAt: uint64(block.timestamp + 180 days),
            adapter: adapter
        });
    }
}
