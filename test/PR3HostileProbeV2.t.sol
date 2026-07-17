// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {CoverageEvidenceTestBase} from "./helpers/CoverageEvidenceTestBase.sol";

/// @dev Sends the recipient less than requested on outbound transfer (taxed), untaxed inbound.
contract OutboundTaxToken {
    mapping(address => uint256) public balanceOf;
    uint256 public immutable tax;

    constructor(uint256 tax_) {
        tax = tax_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        uint256 net = amount > tax ? amount - tax : 0;
        balanceOf[to] += net;
        return true;
    }
}

/// @dev transfer() reports success but moves nothing then returns false.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Reenters the vault on outbound transfer to attempt a nested state change.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    ProviderBondVault public vault;

    function setVault(ProviderBondVault vault_) external {
        vault = vault_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        vault.executeWithdrawal(); // nonReentrant guard must trip
        return true;
    }
}

contract PR3HostileProbeV2Test is CoverageEvidenceTestBase {
    MockERC20 internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;
    CoverageManager internal manager;

    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal adapter = makeAddr("adapter");
    bytes32 internal constant MARKETPLACE = keccak256("OKX.AI");
    bytes32 internal constant FINGERPRINT = keccak256("probe2-service-v1");
    uint256 internal jobNonce;
    uint256 internal feeNonce;
    bytes32 internal policyId;

    function setUp() public {
        vm.warp(2_000_000);
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

    // AREA 1: LOW 1 fix, independently. Emergency settle honors the 24h challenge anchored on
    // the mined payoutDueAt even for a breach reported ~30 days late.
    function test_A1_EmergencySettleHonorsChallenge() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        uint256 delay = manager.EMERGENCY_EVIDENCE_DELAY();
        uint256 challenge = manager.SETTLEMENT_CHALLENGE_PERIOD();

        vm.warp(uint256(deadline) + delay - 12 hours);
        _breachAt(id, uint64(block.timestamp));
        uint64 payoutDueAt = manager.getCovenant(id).payoutDueAt;
        assertEq(payoutDueAt, uint64(block.timestamp), "payoutDueAt anchored to mined breach");

        vm.warp(uint256(deadline) + delay + 1); // past emergency delay, still inside challenge
        CoverageManager.SettlementEvidence memory ev = _settlement(id, 0, 0, true, "LATE");
        bytes[] memory sigs = _recoverySignatures(manager.emergencySettlementEvidenceDigest(ev));
        vm.expectRevert(CoverageManager.SettlementChallengeActive.selector);
        manager.emergencySettleNetLoss(ev, sigs);

        vm.warp(uint256(payoutDueAt) + challenge + 1);
        ev.observedAt = uint64(block.timestamp);
        uint256 payout =
            manager.emergencySettleNetLoss(ev, _recoverySignatures(manager.emergencySettlementEvidenceDigest(ev)));
        assertEq(payout, 500_000);
        console2.log("A1 FIXED: emergency settlement cannot skip the 24h challenge");
    }

    // AREA 1 residual: refund inside the 10-minute window with recoveryFinalized=true still double-pays.
    function test_A1_RefundInsideWindowIsOracleResidual() public {
        bytes32 id = _issueDefault();
        _breachAfterDeadline(id);
        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1);
        CoverageManager.SettlementEvidence memory ev = _settlement(id, 0, 0, true, "WRONG_FINAL");
        ev.observedAt = uint64(block.timestamp);
        bytes[] memory sigs = _signatures(manager.settlementEvidenceDigest(ev));
        asset.mint(buyer, 500_000); // out-of-band refund the chain cannot see
        uint256 payout = manager.settleNetLoss(ev, sigs);
        assertEq(payout, 500_000);
        assertEq(asset.balanceOf(buyer), 1_000_000);
        console2.log("A1 RESIDUAL: finality is oracle-trusted; 10-min freshness cannot detect a refund");
    }

    // AREA 2: held breach evidence, independently. payoutDueAt equals the mined transition.
    function test_A2_HeldBreachAnchorsChallengeToMinedTime() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(uint256(deadline) + 1);
        CoverageManager.BreachEvidence memory held = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("HELD")
        });
        bytes[] memory heldSigs = _signatures(manager.breachEvidenceDigest(held));

        vm.warp(block.timestamp + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1); // hold across a full window
        manager.markPayoutDue(held, heldSigs);
        assertEq(manager.getCovenant(id).payoutDueAt, uint64(block.timestamp), "anchor is mined time, not observedAt");

        CoverageManager.SettlementEvidence memory ev = _settlement(id, 0, 0, true, "FRESH");
        bytes[] memory sigs = _signatures(manager.settlementEvidenceDigest(ev));
        vm.expectRevert(CoverageManager.SettlementChallengeActive.selector);
        manager.settleNetLoss(ev, sigs);
        console2.log("A2 FIXED: a held breach signature cannot pre-consume the challenge window");
    }

    // AREA 3: taxed outbound transfer reverts on both slash and withdrawal, atomically.
    function test_A3_TaxedOutboundReverts() public {
        OutboundTaxToken taxed = new OutboundTaxToken(1);
        ProviderBondVault v = new ProviderBondVault(address(taxed), address(this), 8 days);
        v.initializeManager(address(this)); // this test acts as the manager
        taxed.mint(provider, 1_000_000);
        vm.prank(provider);
        taxed.approve(address(v), type(uint256).max);
        vm.prank(provider);
        v.deposit(1_000_000);
        v.lock(keccak256("cov"), provider, 500_000);

        vm.expectRevert(ProviderBondVault.FeeOnTransferUnsupported.selector);
        v.slash(keccak256("cov"), buyer, 500_000);

        vm.prank(provider);
        v.requestWithdrawal(400_000);
        vm.warp(block.timestamp + 8 days + 1);
        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.FeeOnTransferUnsupported.selector);
        v.executeWithdrawal();
        console2.log("A3 SAFE: taxed/short outbound transfer reverts on slash and withdrawal");
    }

    // AREA 3: malformed (false-return) token reverts, and reentrant token is blocked atomically.
    function test_A3_MalformedAndReentrantBlocked() public {
        FalseReturnToken bad = new FalseReturnToken();
        ProviderBondVault v1 = new ProviderBondVault(address(bad), address(this), 8 days);
        v1.initializeManager(address(this));
        bad.mint(provider, 1_000_000);
        vm.prank(provider);
        v1.deposit(1_000_000);
        v1.lock(keccak256("c1"), provider, 500_000);
        vm.expectRevert(ProviderBondVault.TokenTransferFailed.selector);
        v1.slash(keccak256("c1"), buyer, 500_000);

        ReentrantToken re = new ReentrantToken();
        ProviderBondVault v2 = new ProviderBondVault(address(re), address(this), 8 days);
        re.setVault(v2);
        v2.initializeManager(address(this));
        re.mint(provider, 1_000_000);
        vm.prank(provider);
        v2.deposit(1_000_000);
        v2.lock(keccak256("c2"), provider, 500_000);
        vm.expectRevert(); // nested executeWithdrawal trips nonReentrant, slash reverts atomically
        v2.slash(keccak256("c2"), buyer, 500_000);
        assertTrue(_lockActive(v2, keccak256("c2")), "lock untouched after atomic revert");
        console2.log("A3 SAFE: false-return reverts TokenTransferFailed; reentrant transfer reverts atomically");
    }

    // AREA 4: manager accepts only exact 3-of-5 quorums.
    function test_A4_ExactThreeOfFiveEnforced() public {
        address[] memory five = _addrs(0x5000, 5);
        address[] memory six = _addrs(0x6000, 6);
        CoverageEvidenceVerifier good = new CoverageEvidenceVerifier(five, 3);

        CoverageEvidenceVerifier fourOfFive = new CoverageEvidenceVerifier(_addrs(0x7000, 5), 4);
        vm.expectRevert(CoverageManager.EvidenceTopologyInvalid.selector);
        new CoverageManager(address(registry), address(vault), address(good), address(fourOfFive));

        CoverageEvidenceVerifier threeOfSix = new CoverageEvidenceVerifier(six, 3);
        vm.expectRevert(CoverageManager.EvidenceTopologyInvalid.selector);
        new CoverageManager(address(registry), address(vault), address(good), address(threeOfSix));

        // Overlap still rejected.
        address[] memory overlap = _addrs(0x8000, 5);
        overlap[0] = five[0];
        CoverageEvidenceVerifier overlapping = new CoverageEvidenceVerifier(overlap, 3);
        vm.expectRevert(CoverageManager.EvidenceSignerOverlap.selector);
        new CoverageManager(address(registry), address(vault), address(good), address(overlapping));
        console2.log("A4 SAFE: only exact disjoint 3-of-5 quorums accepted (4-of-5 and 3-of-6 rejected)");
    }

    // NEW SURFACE: cancelUnpaid guards.
    function test_CancelUnpaidGuards() public {
        bytes32 id = _issueDefault();
        CoverageManager.Covenant memory cov = manager.getCovenant(id);

        // Cannot cancel while the fee authorization is still valid (observedAt <= validBefore).
        CoverageManager.CancelUnpaidEvidence memory tooEarly = CoverageManager.CancelUnpaidEvidence({
            covenantId: id,
            observedAt: cov.feeAuthorizationValidBefore,
            feeAuthorizationHash: cov.feeAuthorizationHash,
            nonSettlementEvidenceHash: keccak256("UNPAID")
        });
        bytes[] memory earlySigs = _signatures(manager.cancelUnpaidEvidenceDigest(tooEarly));
        vm.warp(uint256(cov.feeAuthorizationValidBefore));
        vm.expectRevert(CoverageManager.PaymentAuthorizationActive.selector);
        manager.cancelUnpaid(tooEarly, earlySigs);

        // Wrong feeAuthorizationHash is rejected.
        vm.warp(uint256(cov.feeAuthorizationValidBefore) + 1);
        CoverageManager.CancelUnpaidEvidence memory mismatch = CoverageManager.CancelUnpaidEvidence({
            covenantId: id,
            observedAt: uint64(block.timestamp),
            feeAuthorizationHash: keccak256("WRONG"),
            nonSettlementEvidenceHash: keccak256("UNPAID")
        });
        bytes[] memory mmSigs = _signatures(manager.cancelUnpaidEvidenceDigest(mismatch));
        vm.expectRevert(CoverageManager.PaymentAuthorizationMismatch.selector);
        manager.cancelUnpaid(mismatch, mmSigs);

        // Stale cancel evidence (broadcast > 10 min after observedAt) is rejected.
        CoverageManager.CancelUnpaidEvidence memory stale = CoverageManager.CancelUnpaidEvidence({
            covenantId: id,
            observedAt: uint64(block.timestamp),
            feeAuthorizationHash: cov.feeAuthorizationHash,
            nonSettlementEvidenceHash: keccak256("UNPAID")
        });
        bytes[] memory staleSigs = _signatures(manager.cancelUnpaidEvidenceDigest(stale));
        vm.warp(block.timestamp + manager.CANCELLATION_EVIDENCE_MAX_AGE() + 1);
        vm.expectRevert(CoverageManager.EvidenceStale.selector);
        manager.cancelUnpaid(stale, staleSigs);
        console2.log("NEW: cancelUnpaid rejects active-auth, hash-mismatch, and stale evidence");
    }

    // NEW SURFACE residual: after the fee window, a quorum can cancel even a breached (PayoutDue)
    // covenant and release the bond, denying the buyer. This is oracle-gated (non-payment attestation),
    // not a code defect, but it widens the colluding-quorum denial surface.
    function test_CancelUnpaidCanReleasePayoutDue_OracleResidual() public {
        bytes32 id = _issueDefault();
        _breachAfterDeadline(id); // now PayoutDue, buyer would be owed a payout
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.PayoutDue));

        CoverageManager.Covenant memory cov = manager.getCovenant(id);
        vm.warp(uint256(cov.feeAuthorizationValidBefore) + 1); // past the fee authorization window
        CoverageManager.CancelUnpaidEvidence memory ev = CoverageManager.CancelUnpaidEvidence({
            covenantId: id,
            observedAt: uint64(block.timestamp),
            feeAuthorizationHash: cov.feeAuthorizationHash,
            nonSettlementEvidenceHash: keccak256("ATTESTED_NEVER_PAID")
        });
        _cancelUnpaid(manager, ev);
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.CancelledUnpaid));
        assertEq(vault.availableBond(provider), 5_000_000, "bond returned to provider");
        assertEq(asset.balanceOf(buyer), 0, "buyer denied");
        // Terminal: cannot then settle or release.
        CoverageManager.SettlementEvidence memory s = _settlement(id, 0, 0, true, "AFTER_CANCEL");
        bytes[] memory sSigs = _signatures(manager.settlementEvidenceDigest(s));
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.settleNetLoss(s, sSigs);
        console2.log("RESIDUAL: cancelUnpaid on PayoutDue is a new oracle-gated buyer-denial lever");
    }

    // NEW SURFACE: cancel clears job uniqueness so the same job can be re-covered exactly once more.
    function test_CancelUnpaidAllowsCleanReissueNoDoubleLock() public {
        bytes32 jobId = keccak256("reissue-job");
        bytes32 id = _issueJob(jobId);
        CoverageManager.Covenant memory cov = manager.getCovenant(id);
        vm.warp(uint256(cov.feeAuthorizationValidBefore) + 1);
        CoverageManager.CancelUnpaidEvidence memory ev = CoverageManager.CancelUnpaidEvidence({
            covenantId: id,
            observedAt: uint64(block.timestamp),
            feeAuthorizationHash: cov.feeAuthorizationHash,
            nonSettlementEvidenceHash: keccak256("UNPAID")
        });
        _cancelUnpaid(manager, ev);
        assertEq(manager.coveredJobCovenant(jobId), bytes32(0), "job uniqueness cleared");
        assertEq(vault.availableBond(provider), 5_000_000, "released once");

        bytes32 id2 = _issueJob(jobId); // clean retry allowed
        assertTrue(id2 != id, "distinct covenant on retry");
        assertEq(vault.availableBond(provider), 4_500_000, "locked once for the retry");
        console2.log("NEW: cancel enables exactly one clean re-issue, no double lock");
    }

    // PRIOR PROBE (ported): exact deadline boundaries, now with completedAt binding.
    function test_S3_DeadlineBoundaries() public {
        bytes32 id = _issueDefault();
        uint64 deadline = manager.getCovenant(id).deadline;
        vm.warp(deadline);
        CoverageManager.BreachEvidence memory atDl =
            CoverageManager.BreachEvidence({covenantId: id, observedAt: deadline, evidenceHash: keccak256("AT")});
        bytes[] memory atSigs = _signatures(manager.breachEvidenceDigest(atDl));
        vm.expectRevert(CoverageManager.DeadlineNotElapsed.selector);
        manager.markPayoutDue(atDl, atSigs);

        vm.warp(uint256(deadline) + 1);
        _release(
            manager,
            CoverageManager.ReleaseEvidence({
                covenantId: id,
                completedAt: deadline,
                observedAt: uint64(block.timestamp),
                evidenceHash: keccak256("EDGE")
            })
        );
        assertEq(uint256(manager.getCovenant(id).state), uint256(CoverageManager.CovenantState.Released));

        bytes32 id2 = _issueDefault();
        uint64 d2 = manager.getCovenant(id2).deadline;
        vm.warp(uint256(d2) + 5);
        CoverageManager.ReleaseEvidence memory over = CoverageManager.ReleaseEvidence({
            covenantId: id2,
            completedAt: uint64(d2 + 1),
            observedAt: uint64(block.timestamp),
            evidenceHash: keccak256("OVER")
        });
        bytes[] memory oSigs = _signatures(manager.releaseEvidenceDigest(over));
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.release(over, oSigs);
        console2.log("S3 SAFE: deadline boundary inclusive-on-time, exclusive-breach");
    }

    // PRIOR PROBE (ported): terminal states are final against emergency paths too.
    function test_S4_TerminalFinality() public {
        bytes32 id = _issueDefault();
        uint64 dl = manager.getCovenant(id).deadline;
        vm.warp(uint256(dl) + 1);
        _release(
            manager,
            CoverageManager.ReleaseEvidence({
                covenantId: id, completedAt: dl, observedAt: uint64(block.timestamp), evidenceHash: keccak256("R")
            })
        );
        vm.warp(uint256(dl) + manager.EMERGENCY_EVIDENCE_DELAY() + 1);
        CoverageManager.BreachEvidence memory br = CoverageManager.BreachEvidence({
            covenantId: id, observedAt: uint64(block.timestamp), evidenceHash: keccak256("X")
        });
        bytes[] memory brSigs = _recoverySignatures(manager.emergencyBreachEvidenceDigest(br));
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.emergencyMarkPayoutDue(br, brSigs);
        console2.log("S4 SAFE: Released is final against the emergency recovery quorum");
    }

    // PRIOR PROBE (ported): recovery liveness after primary failure, now also honoring the challenge.
    function test_S6_LivenessRecoveryAfterPrimaryFailure() public {
        bytes32 id = _issueDefault();
        _breachAfterDeadline(id);
        uint256 t = _emergencyReadyTimestamp(id);
        vm.warp(t);
        CoverageManager.SettlementEvidence memory ev = _settlement(id, 100_000, 0, true, "FIN");
        ev.observedAt = uint64(block.timestamp);
        uint256 payout =
            manager.emergencySettleNetLoss(ev, _recoverySignatures(manager.emergencySettlementEvidenceDigest(ev)));
        assertEq(payout, 400_000);
        assertEq(asset.balanceOf(buyer), 400_000);
        console2.log("S6 SAFE: recovery quorum finishes a normally-marked breach after primary failure");
    }

    // PRIOR PROBE (ported): cross-quorum digest separation blocks signature reuse.
    function test_S7_CrossQuorumDigestSeparation() public {
        bytes32 id = _issueDefault();
        _breachAfterDeadline(id);
        CoverageManager.SettlementEvidence memory ev = _settlement(id, 0, 0, true, "SEP");
        assertTrue(
            manager.settlementEvidenceDigest(ev) != manager.emergencySettlementEvidenceDigest(ev),
            "verifier-address-bound digests differ"
        );
        vm.warp(_emergencyReadyTimestamp(id));
        ev.observedAt = uint64(block.timestamp);
        bytes[] memory primarySigs = _signatures(manager.settlementEvidenceDigest(ev));
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        manager.emergencySettleNetLoss(ev, primarySigs);
        console2.log("S7 SAFE: primary signatures cannot be replayed on the recovery verifier");
    }

    function _emergencyReadyTimestamp(bytes32 id) internal view returns (uint256 t) {
        CoverageManager.Covenant memory c = manager.getCovenant(id);
        t = uint256(c.deadline) + manager.EMERGENCY_EVIDENCE_DELAY() + 1;
        uint256 challengeEnd = uint256(c.payoutDueAt) + manager.SETTLEMENT_CHALLENGE_PERIOD() + 1;
        if (t < challengeEnd) t = challengeEnd;
    }

    // ------------------------- helpers -------------------------

    function _issueDefault() internal returns (bytes32) {
        return _issueJob(keccak256(abi.encode("probe2-job", ++jobNonce)));
    }

    function _issueJob(bytes32 jobId) internal returns (bytes32) {
        return _issue(manager, _issueEvidence(jobId));
    }

    function _issueEvidence(bytes32 jobId) internal returns (CoverageManager.IssueEvidence memory) {
        return CoverageManager.IssueEvidence({
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
                authorizationHash: keccak256(abi.encode("FEE_AUTH", jobId, ++feeNonce)),
                validBefore: uint64(block.timestamp + 10 minutes)
            })
        });
    }

    function _breachAfterDeadline(bytes32 id) internal {
        vm.warp(uint256(manager.getCovenant(id).deadline) + 1);
        _breachAt(id, uint64(block.timestamp));
    }

    function _breachAt(bytes32 id, uint64 observedAt) internal {
        _markPayoutDue(
            manager,
            CoverageManager.BreachEvidence({covenantId: id, observedAt: observedAt, evidenceHash: keccak256("BREACH")})
        );
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

    function _addrs(uint160 base, uint256 n) internal pure returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = address(base + uint160(i) + 1);
        }
    }

    function _lockActive(ProviderBondVault v, bytes32 covId) internal view returns (bool active) {
        (,, active) = v.covenantLocks(covId);
    }

    function _terms() internal view returns (AgentPolicyRegistry.PolicyTerms memory) {
        return AgentPolicyRegistry.PolicyTerms({
            marketplace: MARKETPLACE,
            agentId: 3808,
            serviceId: 33461,
            serviceFingerprint: FINGERPRINT,
            scopeHash: keccak256("standard-audit"),
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
