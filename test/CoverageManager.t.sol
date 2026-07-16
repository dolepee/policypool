// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {CoverageEvidenceTestBase} from "./helpers/CoverageEvidenceTestBase.sol";

contract ReentryPolicyRegistry {
    address internal immutable provider;

    constructor(address provider_) {
        provider = provider_;
    }

    function policyProvider(bytes32) external view returns (address) {
        return provider;
    }

    function policyPayoutBasis(bytes32) external pure returns (uint8) {
        return 0;
    }

    function policyClock(bytes32) external pure returns (uint8, uint32) {
        return (0, 300);
    }

    function policyCoverageLimits(bytes32) external pure returns (uint128, uint32) {
        return (500_000, 60);
    }

    function isCoverable(bytes32, bytes32) external pure returns (bool) {
        return true;
    }
}

contract ReentryBondManager {
    CoverageManager internal manager;

    function setManager(CoverageManager manager_) external {
        manager = manager_;
    }

    function lock(bytes32, address, uint256) external {
        manager.expireUnstarted(bytes32(0));
    }

    function release(bytes32) external {}

    function slash(bytes32, address, uint256) external {}
}

contract PassiveBondManager {
    function lock(bytes32, address, uint256) external {}
    function release(bytes32) external {}
    function slash(bytes32, address, uint256) external {}
}

contract StaticEvidenceVerifier {
    bytes32 internal constant DIGEST = keccak256("static-evidence-digest");
    uint8 public immutable threshold;
    address[] private signers;
    mapping(address signer => bool authorized) public isSigner;

    constructor(CoverageEvidenceVerifier source) {
        threshold = source.threshold();
        uint256 count = source.signerCount();
        for (uint256 index; index < count; ++index) {
            address signer = source.signerAt(index);
            signers.push(signer);
            isSigner[signer] = true;
        }
    }

    function verify(bytes32, bytes32, bytes[] calldata) external pure returns (bytes32) {
        return DIGEST;
    }

    function attestationDigest(address, bytes32, bytes32) external pure returns (bytes32) {
        return DIGEST;
    }

    function signerCount() external view returns (uint256) {
        return signers.length;
    }

    function signerAt(uint256 index) external view returns (address) {
        return signers[index];
    }
}

contract CoverageManagerTest is CoverageEvidenceTestBase {
    MockERC20 internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;
    CoverageManager internal manager;

    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal adapter = makeAddr("adapter");
    bytes32 internal constant MARKETPLACE = keccak256("OKX.AI");
    bytes32 internal constant FINGERPRINT = keccak256("service-v1");
    bytes32 internal constant SLA_FINGERPRINT = keccak256("service-sla-credit");
    bytes32 internal constant JOB_ID = keccak256("job-1");
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

    function testIssueLocksProviderFirstLossAndQuorumReleaseRestoresIt() public {
        bytes32 id = _issueDefault();
        assertEq(vault.availableBond(provider), 4_500_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Active));

        _release(
            manager,
            CoverageManager.ReleaseEvidence({
                covenantId: id,
                completedAt: uint64(block.timestamp),
                observedAt: uint64(block.timestamp),
                evidenceHash: keccak256("JOB_COMPLETED")
            })
        );
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Released));
    }

    function testFullEscrowRefundCannotStackWithCoveragePayout() public {
        bytes32 id = _issueDefault();
        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("DEADLINE_MISSED"));
        uint256 payout = _settleDefault(id, 500_000, 0, keccak256("ESCROW_REFUND_FINAL"));

        assertEq(payout, 0);
        assertEq(asset.balanceOf(buyer), 0);
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.RecoveredWithoutPayout));
    }

    function testOnlyUnrecoveredLossIsPaid() public {
        bytes32 id = _issueDefault();
        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("DEADLINE_MISSED"));
        uint256 payout = _settleDefault(id, 350_000, 25_000, keccak256("RECOVERY_FINAL"));

        assertEq(payout, 125_000);
        assertEq(asset.balanceOf(buyer), 125_000);
        assertEq(vault.availableBond(provider), 4_875_000);
        assertEq(manager.getCovenant(id).payoutAtomic, 125_000);
    }

    function testProviderFundedSlaCreditDoesNotDependOnEscrowRefund() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33462;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.payoutBasis = 1;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 slaPolicyId = registry.registerPolicy(terms);
        bytes32 id = _issue(
            manager, _issueEvidence(slaPolicyId, SLA_FINGERPRINT, keccak256("sla-job"), buyer, 500_000, 500_000)
        );
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PendingStart));

        _startClock(
            manager,
            CoverageManager.ClockEvidence({
                covenantId: id, startedAt: uint64(block.timestamp), evidenceHash: keccak256("RELAY_RECEIPT")
            })
        );
        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("SLA_MISSED"));
        uint256 payout = _settleDefault(id, 500_000, 0, keccak256("REFUND_FINAL"));

        assertEq(payout, 500_000);
        assertEq(asset.balanceOf(buyer), 500_000);
        assertEq(vault.availableBond(provider), 4_500_000);
    }

    function testSingleRelayerCannotInventBuyerOrJobEvidence() public {
        CoverageManager.IssueEvidence memory legitimate =
            _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        bytes32 legitimateDigest = manager.issueEvidenceDigest(legitimate);
        bytes[] memory oneSignature = new bytes[](1);
        oneSignature[0] = _signature(evidenceSignerKeyOne, legitimateDigest);

        vm.expectRevert(CoverageEvidenceVerifier.InsufficientSignatures.selector);
        manager.issue(legitimate, oneSignature);

        CoverageManager.IssueEvidence memory forged = legitimate;
        forged.buyer = makeAddr("attacker-buyer");
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        manager.issue(forged, _signatures(legitimateDigest));

        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(manager.coveredJobCovenant(JOB_ID), bytes32(0));
    }

    function testSettlementRecoveryAmountsAreSignedAndCannotBeReducedByRelayer() public {
        bytes32 id = _issueDefault();
        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("DEADLINE_MISSED"));
        CoverageManager.SettlementEvidence memory truthful = CoverageManager.SettlementEvidence({
            covenantId: id,
            escrowRefundAtomic: 500_000,
            otherRecoveryAtomic: 0,
            observedAt: uint64(block.timestamp),
            recoveryFinalized: true,
            recoveryEvidenceHash: keccak256("FULL_REFUND")
        });
        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        truthful.observedAt = uint64(block.timestamp);
        bytes[] memory signatures = _signatures(manager.settlementEvidenceDigest(truthful));
        CoverageManager.SettlementEvidence memory forged = truthful;
        forged.escrowRefundAtomic = 0;

        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        manager.settleNetLoss(forged, signatures);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PayoutDue));
        assertEq(asset.balanceOf(buyer), 0);
    }

    function testPermissionlessExecutorCanSubmitValidQuorumEvidence() public {
        CoverageManager.IssueEvidence memory evidence =
            _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        bytes[] memory signatures = _signatures(manager.issueEvidenceDigest(evidence));
        vm.prank(makeAddr("unprivileged-relayer"));
        bytes32 id = manager.issue(evidence, signatures);
        assertEq(manager.coveredJobCovenant(JOB_ID), id);
    }

    function testManagerRejectsReentryFromImmutableBondDependency() public {
        ReentryPolicyRegistry reentryRegistry = new ReentryPolicyRegistry(provider);
        ReentryBondManager reentryVault = new ReentryBondManager();
        CoverageManager reentryManager = new CoverageManager(
            address(reentryRegistry),
            address(reentryVault),
            address(evidenceVerifier),
            address(recoveryEvidenceVerifier)
        );
        reentryVault.setManager(reentryManager);
        CoverageManager.IssueEvidence memory evidence = CoverageManager.IssueEvidence({
            policyId: keccak256("reentry-policy"),
            observedFingerprint: FINGERPRINT,
            jobId: keccak256("reentry-job"),
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: 500_000,
            buyerPaidAtomic: 500_000,
            verifiedAcceptanceAt: uint64(block.timestamp),
            enrollmentExpiresAt: uint64(block.timestamp + 60),
            acceptanceEvidenceHash: keccak256("reentry-acceptance")
        });
        bytes[] memory signatures = _signatures(reentryManager.issueEvidenceDigest(evidence));

        vm.expectRevert(CoverageManager.Reentrancy.selector);
        reentryManager.issue(evidence, signatures);
        assertEq(reentryManager.coveredJobCovenant(evidence.jobId), bytes32(0));
    }

    function testManagerRejectsReusedEvidenceDigestAcrossDifferentJobs() public {
        ReentryPolicyRegistry simpleRegistry = new ReentryPolicyRegistry(provider);
        PassiveBondManager simpleVault = new PassiveBondManager();
        StaticEvidenceVerifier staticVerifier = new StaticEvidenceVerifier(evidenceVerifier);
        StaticEvidenceVerifier recoveryStaticVerifier = new StaticEvidenceVerifier(recoveryEvidenceVerifier);
        CoverageManager simpleManager = new CoverageManager(
            address(simpleRegistry), address(simpleVault), address(staticVerifier), address(recoveryStaticVerifier)
        );
        CoverageManager.IssueEvidence memory first = CoverageManager.IssueEvidence({
            policyId: keccak256("static-policy"),
            observedFingerprint: FINGERPRINT,
            jobId: keccak256("static-job-one"),
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: 500_000,
            buyerPaidAtomic: 500_000,
            verifiedAcceptanceAt: uint64(block.timestamp),
            enrollmentExpiresAt: uint64(block.timestamp + 60),
            acceptanceEvidenceHash: keccak256("static-acceptance-one")
        });
        simpleManager.issue(first, new bytes[](0));
        CoverageManager.IssueEvidence memory second = CoverageManager.IssueEvidence({
            policyId: first.policyId,
            observedFingerprint: first.observedFingerprint,
            jobId: keccak256("static-job-two"),
            provider: first.provider,
            buyer: first.buyer,
            coverageCapAtomic: first.coverageCapAtomic,
            buyerPaidAtomic: first.buyerPaidAtomic,
            verifiedAcceptanceAt: first.verifiedAcceptanceAt,
            enrollmentExpiresAt: first.enrollmentExpiresAt,
            acceptanceEvidenceHash: keccak256("static-acceptance-two")
        });

        vm.expectRevert(CoverageManager.EvidenceAlreadyConsumed.selector);
        simpleManager.issue(second, new bytes[](0));
        assertEq(simpleManager.coveredJobCovenant(second.jobId), bytes32(0));
    }

    function testCannotCoverSameJobAcrossPolicyVersions() public {
        bytes32 first = _issueDefault();
        AgentPolicyRegistry.PolicyTerms memory replacement = _terms();
        replacement.serviceFingerprint = keccak256("service-v2");
        vm.prank(provider);
        bytes32 replacementPolicyId = registry.registerPolicy(replacement);
        CoverageManager.IssueEvidence memory second = _issueEvidence(
            replacementPolicyId, replacement.serviceFingerprint, JOB_ID, makeAddr("second-buyer"), 500_000, 500_000
        );

        bytes[] memory secondSignatures = _signatures(manager.issueEvidenceDigest(second));
        vm.expectRevert(CoverageManager.JobAlreadyCovered.selector);
        manager.issue(second, secondSignatures);
        assertEq(manager.coveredJobCovenant(JOB_ID), first);
    }

    function testIssueRejectsInvalidEvidenceDimensionsAndExactReplay() public {
        CoverageManager.IssueEvidence memory evidence =
            _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);

        CoverageManager.IssueEvidence memory invalid =
            _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.observedFingerprint = bytes32(0);
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.jobId = bytes32(0);
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.coverageCapAtomic = 0;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.buyerPaidAtomic = 0;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.coverageCapAtomic = 500_001;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.verifiedAcceptanceAt = 0;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.enrollmentExpiresAt = uint64(block.timestamp);
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.acceptanceEvidenceHash = bytes32(0);
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.provider = makeAddr("wrong-provider");
        _expectInvalidIssue(invalid, CoverageManager.ProviderMismatch.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.coverageCapAtomic = 600_000;
        invalid.buyerPaidAtomic = 600_000;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);
        invalid = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        invalid.enrollmentExpiresAt += 1;
        _expectInvalidIssue(invalid, CoverageManager.InvalidCovenant.selector);

        evidence = _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        bytes32 id = _issue(manager, evidence);
        bytes[] memory replaySignatures = _signatures(manager.issueEvidenceDigest(evidence));
        vm.expectRevert(CoverageManager.CovenantAlreadyExists.selector);
        manager.issue(evidence, replaySignatures);
        assertEq(manager.coveredJobCovenant(JOB_ID), id);
    }

    function testLifecycleRejectsInvalidClockReleaseAndBreachEvidence() public {
        AgentPolicyRegistry.PolicyTerms memory relayTerms = _terms();
        relayTerms.serviceId = 33465;
        relayTerms.serviceFingerprint = SLA_FINGERPRINT;
        relayTerms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(relayTerms);
        bytes32 relayId = _issue(
            manager,
            _issueEvidence(relayPolicyId, SLA_FINGERPRINT, keccak256("branch-relay-job"), buyer, 500_000, 500_000)
        );

        CoverageManager.ClockEvidence memory clockEvidence =
            CoverageManager.ClockEvidence({covenantId: relayId, startedAt: 0, evidenceHash: keccak256("clock")});
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(clockEvidence, new bytes[](0));
        clockEvidence.startedAt = uint64(block.timestamp + 1);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(clockEvidence, new bytes[](0));
        clockEvidence.startedAt = uint64(block.timestamp);
        clockEvidence.evidenceHash = bytes32(0);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(clockEvidence, new bytes[](0));
        vm.warp(block.timestamp + 61);
        clockEvidence.startedAt = uint64(block.timestamp);
        clockEvidence.evidenceHash = keccak256("late-clock");
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(clockEvidence, new bytes[](0));

        bytes32 activeId = _issue(
            manager, _issueEvidence(policyId, FINGERPRINT, keccak256("release-branches"), buyer, 500_000, 500_000)
        );
        CoverageManager.ReleaseEvidence memory releaseEvidence = CoverageManager.ReleaseEvidence({
            covenantId: activeId, completedAt: 0, observedAt: 0, evidenceHash: keccak256("release")
        });
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.release(releaseEvidence, new bytes[](0));
        releaseEvidence.observedAt = uint64(block.timestamp + 1);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.release(releaseEvidence, new bytes[](0));
        releaseEvidence.observedAt = uint64(block.timestamp);
        releaseEvidence.evidenceHash = bytes32(0);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.release(releaseEvidence, new bytes[](0));

        vm.warp(block.timestamp + 301);
        CoverageManager.BreachEvidence memory breach = CoverageManager.BreachEvidence({
            covenantId: activeId, observedAt: manager.getCovenant(activeId).deadline, evidenceHash: keccak256("breach")
        });
        vm.expectRevert(CoverageManager.DeadlineNotElapsed.selector);
        manager.markPayoutDue(breach, new bytes[](0));
        breach.observedAt = uint64(block.timestamp + 1);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.markPayoutDue(breach, new bytes[](0));
        breach.observedAt = uint64(block.timestamp);
        breach.evidenceHash = bytes32(0);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.markPayoutDue(breach, new bytes[](0));
    }

    function testSettlementRejectsStaleFutureAndMissingRecoveryEvidence() public {
        bytes32 id = _issueDefault();
        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("DEADLINE_MISSED"));
        uint64 payoutDueAt = manager.getCovenant(id).payoutDueAt;
        CoverageManager.SettlementEvidence memory evidence = CoverageManager.SettlementEvidence({
            covenantId: id,
            escrowRefundAtomic: 0,
            otherRecoveryAtomic: 0,
            observedAt: payoutDueAt - 1,
            recoveryFinalized: true,
            recoveryEvidenceHash: keccak256("recovery")
        });
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.settleNetLoss(evidence, new bytes[](0));
        evidence.observedAt = uint64(block.timestamp + 1);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.settleNetLoss(evidence, new bytes[](0));
        evidence.observedAt = uint64(block.timestamp);
        evidence.recoveryEvidenceHash = bytes32(0);
        vm.expectRevert(CoverageManager.RecoveryEvidenceRequired.selector);
        manager.settleNetLoss(evidence, new bytes[](0));
    }

    function testEvidenceHashHelpersExposeStableNonzeroPayloads() public view {
        CoverageManager.IssueEvidence memory issueEvidence =
            _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000);
        assertNotEq(manager.hashIssueEvidence(issueEvidence), bytes32(0));
        assertNotEq(
            manager.hashClockEvidence(CoverageManager.ClockEvidence(JOB_ID, uint64(block.timestamp), FINGERPRINT)),
            bytes32(0)
        );
        assertNotEq(
            manager.hashReleaseEvidence(
                CoverageManager.ReleaseEvidence(JOB_ID, uint64(block.timestamp), uint64(block.timestamp), FINGERPRINT)
            ),
            bytes32(0)
        );
        assertNotEq(
            manager.hashBreachEvidence(CoverageManager.BreachEvidence(JOB_ID, uint64(block.timestamp), FINGERPRINT)),
            bytes32(0)
        );
        assertNotEq(
            manager.hashSettlementEvidence(
                CoverageManager.SettlementEvidence(JOB_ID, 1, 2, uint64(block.timestamp), true, FINGERPRINT)
            ),
            bytes32(0)
        );
        assertNotEq(manager.covenantId(policyId, JOB_ID, buyer), bytes32(0));
    }

    function testCannotMarkBreachBeforeDeadlineOrSettleWithoutEvidence() public {
        bytes32 id = _issueDefault();
        CoverageManager.BreachEvidence memory early = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("EARLY")
        });
        bytes[] memory earlySignatures = _signatures(manager.breachEvidenceDigest(early));
        vm.expectRevert(CoverageManager.DeadlineNotElapsed.selector);
        manager.markPayoutDue(early, earlySignatures);

        vm.warp(block.timestamp + 301);
        _breach(id, keccak256("DEADLINE_MISSED"));
        CoverageManager.SettlementEvidence memory missing = CoverageManager.SettlementEvidence({
            covenantId: id,
            escrowRefundAtomic: 0,
            otherRecoveryAtomic: 0,
            observedAt: uint64(block.timestamp),
            recoveryFinalized: true,
            recoveryEvidenceHash: bytes32(0)
        });
        vm.expectRevert(CoverageManager.RecoveryEvidenceRequired.selector);
        manager.settleNetLoss(missing, new bytes[](0));
    }

    function testRelayClockRejectsMissingEvidenceAndLateStart() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33464;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(terms);
        bytes32 id = _issue(
            manager,
            _issueEvidence(relayPolicyId, SLA_FINGERPRINT, keccak256("relay-validation-job"), buyer, 500_000, 500_000)
        );
        CoverageManager.ClockEvidence memory missing = CoverageManager.ClockEvidence({
            covenantId: id, startedAt: uint64(block.timestamp), evidenceHash: bytes32(0)
        });
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(missing, new bytes[](0));

        vm.warp(block.timestamp + 61);
        CoverageManager.ClockEvidence memory late = CoverageManager.ClockEvidence({
            covenantId: id, startedAt: uint64(block.timestamp), evidenceHash: keccak256("LATE_RELAY_RECEIPT")
        });
        bytes[] memory lateSignatures = _signatures(manager.clockEvidenceDigest(late));
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(late, lateSignatures);
    }

    function testUnstartedRelayClockExpiresPermissionlesslyAndUnlocksBond() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33463;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(terms);
        bytes32 id = _issue(
            manager, _issueEvidence(relayPolicyId, SLA_FINGERPRINT, keccak256("unstarted-job"), buyer, 500_000, 500_000)
        );
        vm.warp(block.timestamp + 61);
        vm.prank(makeAddr("expiry-keeper"));
        manager.expireUnstarted(id);
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Released));
    }

    function _issueDefault() internal returns (bytes32) {
        return _issue(manager, _issueEvidence(policyId, FINGERPRINT, JOB_ID, buyer, 500_000, 500_000));
    }

    function _issueEvidence(
        bytes32 selectedPolicyId,
        bytes32 fingerprint,
        bytes32 jobId,
        address selectedBuyer,
        uint128 cap,
        uint128 paid
    ) internal view returns (CoverageManager.IssueEvidence memory) {
        return CoverageManager.IssueEvidence({
            policyId: selectedPolicyId,
            observedFingerprint: fingerprint,
            jobId: jobId,
            provider: provider,
            buyer: selectedBuyer,
            coverageCapAtomic: cap,
            buyerPaidAtomic: paid,
            verifiedAcceptanceAt: uint64(block.timestamp),
            enrollmentExpiresAt: uint64(block.timestamp + 60),
            acceptanceEvidenceHash: keccak256(abi.encode("OKX_ACCEPTANCE", jobId))
        });
    }

    function _breach(bytes32 id, bytes32 evidenceHash) internal {
        _markPayoutDue(
            manager,
            CoverageManager.BreachEvidence({
                covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: evidenceHash
            })
        );
    }

    function _settleDefault(bytes32 id, uint128 refund, uint128 recovery, bytes32 evidenceHash)
        internal
        returns (uint256)
    {
        uint256 settlementOpensAt =
            uint256(manager.getCovenant(id).payoutDueAt) + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1;
        if (block.timestamp < settlementOpensAt) vm.warp(settlementOpensAt);
        return _settle(
            manager,
            CoverageManager.SettlementEvidence({
                covenantId: id,
                escrowRefundAtomic: refund,
                otherRecoveryAtomic: recovery,
                observedAt: uint64(block.timestamp),
                recoveryFinalized: true,
                recoveryEvidenceHash: evidenceHash
            })
        );
    }

    function _expectInvalidIssue(CoverageManager.IssueEvidence memory evidence, bytes4 selector) internal {
        vm.expectRevert(selector);
        manager.issue(evidence, new bytes[](0));
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
            premiumBps: 2_000,
            payoutBasis: 0,
            clockMode: 0,
            expiresAt: uint64(block.timestamp + 30 days),
            adapter: adapter
        });
    }
}
