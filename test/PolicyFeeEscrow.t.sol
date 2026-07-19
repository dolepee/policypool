// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {PolicyFeeEscrow} from "../src/PolicyFeeEscrow.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {CoverageEvidenceTestBase} from "./helpers/CoverageEvidenceTestBase.sol";

contract MockFeeAuthorizationToken {
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;
    mapping(bytes32 authorization => bool allowed) public authorizations;
    mapping(bytes32 nonce => bool used) public usedNonce;

    uint256 public authorizationTaxAtomic;
    uint256 public transferTaxAtomic;
    bool public returnFalseOnTransfer;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentryEnabled;
    bool public lastReentrySucceeded;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalseOnTransfer) return false;
        if (reentryEnabled) {
            (lastReentrySucceeded,) = reentryTarget.call(reentryData);
        }
        _move(msg.sender, to, amount, transferTaxAtomic);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount, 0);
        return true;
    }

    function allowAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external {
        authorizations[_authorizationKey(from, to, value, validAfter, validBefore, nonce)] = true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata
    ) external {
        bytes32 key = _authorizationKey(from, to, value, validAfter, validBefore, nonce);
        require(authorizations[key] && !usedNonce[nonce], "authorization invalid");
        require(block.timestamp >= validAfter && block.timestamp < validBefore, "authorization expired");
        if (reentryEnabled) {
            (lastReentrySucceeded,) = reentryTarget.call(reentryData);
        }
        usedNonce[nonce] = true;
        _move(from, to, value, authorizationTaxAtomic);
    }

    function authorizationState(address, bytes32 nonce) external view returns (bool) {
        return usedNonce[nonce];
    }

    function consumeWithoutTransfer(bytes32 nonce) external {
        usedNonce[nonce] = true;
    }

    function setTaxes(uint256 authorizationTaxAtomic_, uint256 transferTaxAtomic_) external {
        authorizationTaxAtomic = authorizationTaxAtomic_;
        transferTaxAtomic = transferTaxAtomic_;
    }

    function setReturnFalseOnTransfer(bool enabled) external {
        returnFalseOnTransfer = enabled;
    }

    function setReentry(address target, bytes calldata data, bool enabled) external {
        reentryTarget = target;
        reentryData = data;
        reentryEnabled = enabled;
        lastReentrySucceeded = false;
    }

    function _move(address from, address to, uint256 amount, uint256 tax) private {
        require(tax <= amount, "tax too high");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - tax;
    }

    function _authorizationKey(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(from, to, value, validAfter, validBefore, nonce));
    }
}

contract PolicyFeeEscrowTest is CoverageEvidenceTestBase {
    uint128 internal constant FEE = 100_000;
    uint128 internal constant COVERAGE_CAP = 500_000;
    bytes32 internal constant MARKETPLACE = keccak256("OKX.AI_DIRECT_A2MCP");
    bytes32 internal constant FINGERPRINT = keccak256("warden-audit-v1");
    bytes32 internal constant JOB_ID = keccak256("direct-job-1");
    bytes32 internal constant PROVIDER_AUTHORIZATION_HASH = keccak256("provider-payment-authorization");

    MockFeeAuthorizationToken internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;
    CoverageManager internal manager;
    PolicyFeeEscrow internal escrow;

    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal treasury = makeAddr("treasury");
    address internal adapter = makeAddr("relay-adapter");
    bytes32 internal policyId;

    function setUp() public {
        _setUpEvidenceVerifier();
        asset = new MockFeeAuthorizationToken();
        vault = new ProviderBondVault(address(asset), address(this), 8 days);
        identity = new MockAgentIdentityRegistry();
        registry = new AgentPolicyRegistry(address(identity), address(vault), address(this), COVERAGE_CAP, 7 days);
        manager = new CoverageManager(
            address(registry), address(vault), address(evidenceVerifier), address(recoveryEvidenceVerifier)
        );
        vault.initializeManager(address(manager));
        escrow = new PolicyFeeEscrow(address(asset), treasury, address(evidenceVerifier), address(manager), FEE);

        identity.setOwner(3808, provider);
        asset.mint(provider, 5_000_000);
        asset.mint(buyer, 1_000_000);
        vm.startPrank(provider);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(5_000_000);
        policyId = registry.registerPolicy(_terms());
        vm.stopPrank();
    }

    function testFundRequiresExactBoundPendingCovenant() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);

        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.fund(authorization, hex"01");

        bytes32 feeId = _issueFor(authorization);
        bytes32 originalNonce = authorization.nonce;
        authorization.nonce = keccak256("substituted-job");
        vm.expectRevert(PolicyFeeEscrow.InvalidCaptureEvidence.selector);
        escrow.fund(authorization, hex"01");
        authorization.nonce = originalNonce;

        assertEq(escrow.fund(authorization, hex"01"), feeId);
        PolicyFeeEscrow.FeeRecord memory record = escrow.getFee(feeId);
        assertEq(record.buyer, buyer);
        assertEq(record.covenantId, manager.covenantId(policyId, JOB_ID, buyer, feeId));
        assertEq(record.providerAuthorizationHash, PROVIDER_AUTHORIZATION_HASH);
        assertEq(record.amountAtomic, FEE);
        assertEq(uint256(record.state), uint256(PolicyFeeEscrow.FeeState.Funded));
        assertEq(escrow.totalEscrowedAtomic(), FEE);
    }

    function testCapturePaysOnlyTreasuryAfterCoverageClockStarts() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        bytes[] memory signatures = _signatures(escrow.captureEvidenceDigest(evidence));

        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.capture(evidence, signatures);

        _start(covenantId);
        bytes32 digest = escrow.captureEvidenceDigest(evidence);
        escrow.capture(evidence, _signatures(digest));

        assertEq(asset.balanceOf(treasury), FEE);
        assertEq(asset.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowedAtomic(), 0);
        assertTrue(escrow.consumedEvidence(digest));
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Captured));
        vm.expectRevert(PolicyFeeEscrow.FeeNotFunded.selector);
        escrow.refund(feeId);
    }

    function testTimeoutRefundReturnsOnlyToBuyerAndIsTerminal() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        bytes[] memory signatures = _signatures(escrow.captureEvidenceDigest(evidence));
        uint256 buyerAfterFunding = asset.balanceOf(buyer);
        PolicyFeeEscrow.FeeRecord memory record = escrow.getFee(feeId);
        vm.expectRevert(PolicyFeeEscrow.RefundNotReady.selector);
        escrow.refund(feeId);

        vm.warp(record.refundAvailableAt);
        vm.prank(makeAddr("permissionless-refunder"));
        escrow.refund(feeId);
        assertEq(asset.balanceOf(buyer), buyerAfterFunding + FEE);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Refunded));

        vm.expectRevert(PolicyFeeEscrow.FeeNotFunded.selector);
        escrow.capture(evidence, signatures);
    }

    function testCaptureRejectsInsufficientWrongAndStaleEvidence() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 14 minutes);
        _start(covenantId);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        bytes[] memory signatures = _signatures(escrow.captureEvidenceDigest(evidence));
        bytes[] memory oneSignature = new bytes[](1);
        oneSignature[0] = signatures[0];
        vm.expectRevert();
        escrow.capture(evidence, oneSignature);

        evidence.providerAuthorizationHash = keccak256("wrong-provider-authorization");
        vm.expectRevert(PolicyFeeEscrow.InvalidCaptureEvidence.selector);
        escrow.capture(evidence, signatures);
        evidence.providerAuthorizationHash = authorization.providerAuthorizationHash;

        vm.warp(block.timestamp + 10 minutes + 1);
        vm.expectRevert(PolicyFeeEscrow.EvidenceStale.selector);
        escrow.capture(evidence, signatures);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));
    }

    function testRefundBoundaryWinsAndCaptureCannotRaceIt() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        _start(covenantId);
        PolicyFeeEscrow.FeeRecord memory record = escrow.getFee(feeId);
        vm.warp(record.refundAvailableAt);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        bytes[] memory signatures = _signatures(escrow.captureEvidenceDigest(evidence));
        vm.expectRevert(PolicyFeeEscrow.FeeRefundWindowElapsed.selector);
        escrow.capture(evidence, signatures);
        escrow.refund(feeId);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Refunded));
    }

    function testInboundTaxRevertsAtomicallyAndAuthorizationCanRetry() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);
        bytes32 feeId = _issueFor(authorization);
        asset.setTaxes(1, 0);
        vm.expectRevert(PolicyFeeEscrow.FeeOnTransferUnsupported.selector);
        escrow.fund(authorization, hex"01");
        assertFalse(asset.usedNonce(authorization.nonce));
        assertEq(asset.balanceOf(buyer), 1_000_000);

        asset.setTaxes(0, 0);
        escrow.fund(authorization, hex"01");
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));
    }

    function testOutboundTaxAndFalseReturnRollbackThenRetry() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        _start(covenantId);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        bytes32 digest = escrow.captureEvidenceDigest(evidence);
        bytes[] memory signatures = _signatures(digest);

        asset.setTaxes(0, 1);
        vm.expectRevert(PolicyFeeEscrow.FeeOnTransferUnsupported.selector);
        escrow.capture(evidence, signatures);
        assertFalse(escrow.consumedEvidence(digest));
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));

        asset.setTaxes(0, 0);
        asset.setReturnFalseOnTransfer(true);
        vm.expectRevert(PolicyFeeEscrow.TokenTransferFailed.selector);
        escrow.capture(evidence, signatures);
        asset.setReturnFalseOnTransfer(false);
        escrow.capture(evidence, signatures);
        assertEq(asset.balanceOf(treasury), FEE);
    }

    function testTaxedRefundRollsBackAndCanRetry() public {
        (, bytes32 feeId,) = _funded(JOB_ID, 5 minutes);
        PolicyFeeEscrow.FeeRecord memory record = escrow.getFee(feeId);
        vm.warp(record.refundAvailableAt);
        asset.setTaxes(0, 1);
        vm.expectRevert(PolicyFeeEscrow.FeeOnTransferUnsupported.selector);
        escrow.refund(feeId);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));

        asset.setTaxes(0, 0);
        escrow.refund(feeId);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Refunded));
    }

    function testReentryCannotChangeTerminalRecipient() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        _start(covenantId);
        asset.setReentry(address(escrow), abi.encodeCall(PolicyFeeEscrow.refund, (feeId)), true);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        escrow.capture(evidence, _signatures(escrow.captureEvidenceDigest(evidence)));
        assertFalse(asset.lastReentrySucceeded());
        assertEq(asset.balanceOf(treasury), FEE);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Captured));
    }

    function testInboundAuthorizationReentryCannotDuplicateFee() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);
        bytes32 feeId = _issueFor(authorization);
        asset.setReentry(address(escrow), abi.encodeCall(PolicyFeeEscrow.fund, (authorization, bytes(hex"01"))), true);

        escrow.fund(authorization, hex"01");

        assertFalse(asset.lastReentrySucceeded());
        assertEq(asset.balanceOf(address(escrow)), FEE);
        assertEq(escrow.totalEscrowedAtomic(), FEE);
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));
    }

    function testUnsolicitedTokenCannotBeCapturedOrSwept() public {
        (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId) =
            _funded(JOB_ID, 5 minutes);
        asset.mint(address(escrow), 55_000);
        assertEq(escrow.totalEscrowedAtomic(), FEE);
        _start(covenantId);
        PolicyFeeEscrow.CaptureEvidence memory evidence = _captureEvidence(feeId, covenantId, authorization);
        escrow.capture(evidence, _signatures(escrow.captureEvidenceDigest(evidence)));
        assertEq(asset.balanceOf(address(escrow)), 55_000);
        assertEq(asset.balanceOf(treasury), FEE);
        assertEq(escrow.totalEscrowedAtomic(), 0);
    }

    function testDirectlyConsumedAuthorizationIsQuorumRecoveredAndRefunded() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);
        bytes32 feeId = _issueFor(authorization);
        bytes32 covenantId = manager.covenantId(policyId, JOB_ID, buyer, feeId);

        asset.transferWithAuthorization(
            authorization.buyer,
            address(escrow),
            FEE,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            hex"01"
        );
        assertEq(uint256(escrow.getFee(feeId).state), uint256(PolicyFeeEscrow.FeeState.None));
        assertEq(asset.balanceOf(address(escrow)), FEE);
        assertEq(escrow.totalEscrowedAtomic(), 0);

        uint256 refundAvailableAt = authorization.providerAuthorizationValidBefore + escrow.REFUND_GRACE_PERIOD();
        vm.warp(refundAvailableAt);
        PolicyFeeEscrow.OrphanedRefundEvidence memory evidence =
            _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);
        bytes32 digest = escrow.orphanedRefundEvidenceDigest(evidence);
        bytes[] memory signatures = _signatures(digest);
        vm.prank(makeAddr("permissionless-orphan-refunder"));
        escrow.refundOrphaned(authorization, evidence, signatures);

        PolicyFeeEscrow.FeeRecord memory record = escrow.getFee(feeId);
        assertEq(uint256(record.state), uint256(PolicyFeeEscrow.FeeState.Refunded));
        assertEq(record.covenantId, covenantId);
        assertEq(record.buyer, buyer);
        assertEq(record.providerAuthorizationHash, PROVIDER_AUTHORIZATION_HASH);
        assertEq(record.refundAvailableAt, refundAvailableAt);
        assertEq(asset.balanceOf(buyer), 1_000_000);
        assertEq(asset.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowedAtomic(), 0);
        assertTrue(escrow.consumedEvidence(digest));

        vm.expectRevert(PolicyFeeEscrow.FeeAlreadyExists.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);
    }

    function testOrphanRefundRejectsUnconsumedMissingSurplusAndSubstitution() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        bytes32 feeId = _issueFor(authorization);
        bytes32 covenantId = manager.covenantId(policyId, JOB_ID, buyer, feeId);
        uint256 refundAvailableAt = authorization.providerAuthorizationValidBefore + escrow.REFUND_GRACE_PERIOD();
        vm.warp(refundAvailableAt);
        PolicyFeeEscrow.OrphanedRefundEvidence memory evidence =
            _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);
        bytes32 digest = escrow.orphanedRefundEvidenceDigest(evidence);
        bytes[] memory signatures = _signatures(digest);

        asset.mint(address(escrow), FEE);
        vm.expectRevert(PolicyFeeEscrow.AuthorizationNotConsumed.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);

        vm.prank(address(escrow));
        asset.transfer(makeAddr("surplus-sink"), FEE);
        asset.consumeWithoutTransfer(authorization.nonce);
        PolicyFeeEscrow.OrphanedRefundEvidence memory substituted = evidence;
        substituted.paymentTransaction = bytes32(0);
        bytes32 substitutedDigest = escrow.orphanedRefundEvidenceDigest(substituted);
        bytes[] memory substitutedSignatures = _signatures(substitutedDigest);
        vm.expectRevert(PolicyFeeEscrow.InvalidCaptureEvidence.selector);
        escrow.refundOrphaned(authorization, substituted, substitutedSignatures);

        evidence = _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);
        vm.expectRevert(PolicyFeeEscrow.UnaccountedFeeUnavailable.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);
    }

    function testFundThenOrphanThenRefundOrphanedPreservesAccountedFee() public {
        (, bytes32 fundedFeeId,) = _funded(keccak256("normally-funded"), 5 minutes);
        PolicyFeeEscrow.FundAuthorization memory orphan = _authorization(JOB_ID, 5 minutes);
        _allow(orphan);
        bytes32 orphanFeeId = _issueFor(orphan);
        bytes32 orphanCovenantId = manager.covenantId(policyId, JOB_ID, buyer, orphanFeeId);
        asset.transferWithAuthorization(
            orphan.buyer, address(escrow), FEE, orphan.validAfter, orphan.validBefore, orphan.nonce, hex"01"
        );
        vm.warp(orphan.providerAuthorizationValidBefore + escrow.REFUND_GRACE_PERIOD());
        PolicyFeeEscrow.OrphanedRefundEvidence memory evidence =
            _orphanedRefundEvidence(orphanFeeId, orphanCovenantId, orphan.nonce);
        bytes32 digest = escrow.orphanedRefundEvidenceDigest(evidence);
        bytes[] memory signatures = _signatures(digest);

        assertEq(asset.balanceOf(address(escrow)), FEE * 2);
        assertEq(escrow.totalEscrowedAtomic(), FEE);
        escrow.refundOrphaned(orphan, evidence, signatures);

        assertEq(asset.balanceOf(address(escrow)), FEE);
        assertEq(escrow.totalEscrowedAtomic(), FEE);
        assertEq(uint256(escrow.getFee(fundedFeeId).state), uint256(PolicyFeeEscrow.FeeState.Funded));
        assertEq(uint256(escrow.getFee(orphanFeeId).state), uint256(PolicyFeeEscrow.FeeState.Refunded));

        escrow.refund(fundedFeeId);
        assertEq(asset.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowedAtomic(), 0);
        assertEq(uint256(escrow.getFee(fundedFeeId).state), uint256(PolicyFeeEscrow.FeeState.Refunded));
        assertEq(asset.balanceOf(buyer), 1_000_000);
    }

    function testOrphanRefundRequiresBoundaryFreshEvidenceAndQuorum() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);
        bytes32 feeId = _issueFor(authorization);
        bytes32 covenantId = manager.covenantId(policyId, JOB_ID, buyer, feeId);
        asset.transferWithAuthorization(
            authorization.buyer,
            address(escrow),
            FEE,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            hex"01"
        );
        PolicyFeeEscrow.OrphanedRefundEvidence memory evidence =
            _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);

        bytes[] memory signatures = _signatures(escrow.orphanedRefundEvidenceDigest(evidence));
        vm.expectRevert(PolicyFeeEscrow.RefundNotReady.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);

        uint256 refundAvailableAt = authorization.providerAuthorizationValidBefore + escrow.REFUND_GRACE_PERIOD();
        vm.warp(refundAvailableAt + escrow.CAPTURE_EVIDENCE_MAX_AGE() + 1);
        evidence = _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);
        evidence.observedAt = uint64(refundAvailableAt);
        signatures = _signatures(escrow.orphanedRefundEvidenceDigest(evidence));
        vm.expectRevert(PolicyFeeEscrow.EvidenceStale.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);

        evidence = _orphanedRefundEvidence(feeId, covenantId, authorization.nonce);
        bytes[] memory noSignatures = new bytes[](0);
        vm.expectRevert(CoverageEvidenceVerifier.InsufficientSignatures.selector);
        escrow.refundOrphaned(authorization, evidence, noSignatures);

        evidence.covenantId = keccak256("substituted-covenant");
        signatures = _signatures(escrow.orphanedRefundEvidenceDigest(evidence));
        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.refundOrphaned(authorization, evidence, signatures);
    }

    function testConstructorRejectsManagerVerifierOrAssetMismatch() public {
        vm.expectRevert(PolicyFeeEscrow.ZeroAddress.selector);
        new PolicyFeeEscrow(address(0), treasury, address(evidenceVerifier), address(manager), FEE);
        vm.expectRevert(PolicyFeeEscrow.ZeroAddress.selector);
        new PolicyFeeEscrow(address(asset), address(0), address(evidenceVerifier), address(manager), FEE);
        vm.expectRevert(PolicyFeeEscrow.ZeroAddress.selector);
        new PolicyFeeEscrow(address(asset), treasury, address(0), address(manager), FEE);
        vm.expectRevert(PolicyFeeEscrow.ZeroAddress.selector);
        new PolicyFeeEscrow(address(asset), treasury, address(evidenceVerifier), address(0), FEE);
        vm.expectRevert(PolicyFeeEscrow.ZeroAmount.selector);
        new PolicyFeeEscrow(address(asset), treasury, address(evidenceVerifier), address(manager), 0);

        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        new PolicyFeeEscrow(address(asset), treasury, address(recoveryEvidenceVerifier), address(manager), FEE);

        MockFeeAuthorizationToken otherAsset = new MockFeeAuthorizationToken();
        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        new PolicyFeeEscrow(address(otherAsset), treasury, address(evidenceVerifier), address(manager), FEE);
    }

    function testFundRejectsDuplicateFailedTransferAndMalformedAuthorization() public {
        PolicyFeeEscrow.FundAuthorization memory authorization = _authorization(JOB_ID, 5 minutes);
        _allow(authorization);
        _issueFor(authorization);
        escrow.fund(authorization, hex"01");
        vm.expectRevert(PolicyFeeEscrow.FeeAlreadyExists.selector);
        escrow.fund(authorization, hex"01");

        PolicyFeeEscrow.FundAuthorization memory failedTransfer =
            _authorization(keccak256("failed-transfer"), 5 minutes);
        _issueFor(failedTransfer);
        vm.expectRevert(PolicyFeeEscrow.TokenTransferFailed.selector);
        escrow.fund(failedTransfer, hex"01");

        PolicyFeeEscrow.FundAuthorization memory malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.buyer = address(0);
        vm.expectRevert(PolicyFeeEscrow.ZeroAddress.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.policyId = bytes32(0);
        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.jobId = bytes32(0);
        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.providerAuthorizationHash = bytes32(0);
        vm.expectRevert(PolicyFeeEscrow.InvalidCovenant.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.validAfter = block.timestamp + 1;
        vm.expectRevert(PolicyFeeEscrow.InvalidAuthorizationWindow.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.validBefore = block.timestamp;
        vm.expectRevert(PolicyFeeEscrow.InvalidAuthorizationWindow.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.validBefore = block.timestamp + 15 minutes + 1;
        vm.expectRevert(PolicyFeeEscrow.InvalidAuthorizationWindow.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.providerAuthorizationValidBefore = block.timestamp;
        vm.expectRevert(PolicyFeeEscrow.InvalidAuthorizationWindow.selector);
        escrow.fund(malformed, hex"01");

        malformed = _authorization(keccak256("malformed"), 5 minutes);
        malformed.providerAuthorizationValidBefore = block.timestamp + 15 minutes + 1;
        vm.expectRevert(PolicyFeeEscrow.InvalidAuthorizationWindow.selector);
        escrow.fund(malformed, hex"01");
    }

    function _funded(bytes32 jobId, uint256 authorizationLifetime)
        private
        returns (PolicyFeeEscrow.FundAuthorization memory authorization, bytes32 feeId, bytes32 covenantId)
    {
        authorization = _authorization(jobId, authorizationLifetime);
        _allow(authorization);
        feeId = _issueFor(authorization);
        covenantId = manager.covenantId(policyId, jobId, buyer, feeId);
        assertEq(escrow.fund(authorization, hex"01"), feeId);
    }

    function _authorization(bytes32 jobId, uint256 lifetime)
        private
        view
        returns (PolicyFeeEscrow.FundAuthorization memory authorization)
    {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + lifetime;
        uint256 providerValidBefore = block.timestamp + lifetime + 30 seconds;
        bytes32 nonce = escrow.authorizationNonce(
            policyId, jobId, buyer, PROVIDER_AUTHORIZATION_HASH, validAfter, validBefore, providerValidBefore
        );
        authorization = PolicyFeeEscrow.FundAuthorization({
            buyer: buyer,
            policyId: policyId,
            jobId: jobId,
            providerAuthorizationHash: PROVIDER_AUTHORIZATION_HASH,
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: nonce,
            providerAuthorizationValidBefore: providerValidBefore
        });
    }

    function _allow(PolicyFeeEscrow.FundAuthorization memory authorization) private {
        asset.allowAuthorization(
            authorization.buyer,
            address(escrow),
            FEE,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce
        );
    }

    function _issueFor(PolicyFeeEscrow.FundAuthorization memory authorization) private returns (bytes32 feeId) {
        feeId = escrow.authorizationId(
            authorization.buyer, authorization.validAfter, authorization.validBefore, authorization.nonce
        );
        uint64 acceptedAt = uint64(block.timestamp);
        CoverageManager.IssueEvidence memory evidence = CoverageManager.IssueEvidence({
            policyId: policyId,
            observedFingerprint: FINGERPRINT,
            jobId: authorization.jobId,
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: COVERAGE_CAP,
            buyerPaidAtomic: COVERAGE_CAP,
            verifiedAcceptanceAt: acceptedAt,
            enrollmentExpiresAt: acceptedAt + 60,
            acceptanceEvidenceHash: keccak256(
                abi.encode(authorization.jobId, authorization.providerAuthorizationHash, buyer)
            ),
            feeAuthorization: CoverageManager.FeeAuthorization({
                authorizationHash: feeId, validBefore: uint64(authorization.validBefore)
            })
        });
        assertEq(_issue(manager, evidence), manager.covenantId(policyId, authorization.jobId, buyer, feeId));
    }

    function _start(bytes32 covenantId) private {
        _startClock(
            manager,
            CoverageManager.ClockEvidence({
                covenantId: covenantId,
                startedAt: uint64(block.timestamp),
                evidenceHash: keccak256("verified-provider-payment-and-request-arrival")
            })
        );
    }

    function _captureEvidence(bytes32 feeId, bytes32 covenantId, PolicyFeeEscrow.FundAuthorization memory authorization)
        private
        view
        returns (PolicyFeeEscrow.CaptureEvidence memory evidence)
    {
        evidence = PolicyFeeEscrow.CaptureEvidence({
            feeId: feeId,
            covenantId: covenantId,
            providerAuthorizationHash: authorization.providerAuthorizationHash,
            relayReceiptDigest: keccak256("signed-relay-receipt"),
            providerSettlementTransaction: keccak256("provider-settlement-transaction"),
            observedAt: uint64(block.timestamp)
        });
    }

    function _orphanedRefundEvidence(bytes32 feeId, bytes32 covenantId, bytes32 nonce)
        private
        view
        returns (PolicyFeeEscrow.OrphanedRefundEvidence memory evidence)
    {
        evidence = PolicyFeeEscrow.OrphanedRefundEvidence({
            feeId: feeId,
            covenantId: covenantId,
            authorizationNonce: nonce,
            paymentTransaction: keccak256("direct-policy-fee-transfer"),
            observedAt: uint64(block.timestamp)
        });
    }

    function _terms() private view returns (AgentPolicyRegistry.PolicyTerms memory) {
        return AgentPolicyRegistry.PolicyTerms({
            marketplace: MARKETPLACE,
            agentId: 3808,
            serviceId: 33461,
            serviceFingerprint: FINGERPRINT,
            scopeHash: keccak256("standard-20-payload-audit"),
            slaSeconds: 300,
            enrollmentWindowSeconds: 60,
            maxCapAtomic: COVERAGE_CAP,
            premiumBps: 2000,
            payoutBasis: 0,
            clockMode: 1,
            expiresAt: uint64(block.timestamp + 30 days),
            adapter: adapter
        });
    }
}
