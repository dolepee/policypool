// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract CoverageManagerTest is Test {
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
        asset = new MockERC20("USD0", "USD0", 6);
        vault = new ProviderBondVault(address(asset), address(this), 8 days);
        identity = new MockAgentIdentityRegistry();
        registry = new AgentPolicyRegistry(address(identity), address(vault), address(this), 500_000, 7 days);
        manager = new CoverageManager(address(registry), address(vault), address(this));
        vault.setManager(address(manager));

        identity.setOwner(3808, provider);
        asset.mint(provider, 5_000_000);
        vm.startPrank(provider);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(5_000_000);
        policyId = registry.registerPolicy(_terms());
        vm.stopPrank();
    }

    function testIssueLocksProviderFirstLossAndReleaseRestoresIt() public {
        bytes32 covenantId = _issue();
        assertEq(vault.availableBond(provider), 4_500_000);
        assertEq(uint256(manager.getCovenant(covenantId).state), uint256(CoverageManager.CovenantState.Active));

        manager.release(covenantId, keccak256("JOB_COMPLETED"));
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(uint256(manager.getCovenant(covenantId).state), uint256(CoverageManager.CovenantState.Released));
    }

    function testFullEscrowRefundCannotStackWithCoveragePayout() public {
        bytes32 covenantId = _issue();
        vm.warp(block.timestamp + 301);
        manager.markPayoutDue(covenantId, keccak256("DEADLINE_MISSED"));
        uint256 payout = manager.settleNetLoss(covenantId, 500_000, 0, keccak256("ESCROW_REFUND_FINAL"));

        assertEq(payout, 0);
        assertEq(asset.balanceOf(buyer), 0);
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(
            uint256(manager.getCovenant(covenantId).state),
            uint256(CoverageManager.CovenantState.RecoveredWithoutPayout)
        );
    }

    function testOnlyUnrecoveredLossIsPaid() public {
        bytes32 covenantId = _issue();
        vm.warp(block.timestamp + 301);
        manager.markPayoutDue(covenantId, keccak256("DEADLINE_MISSED"));
        uint256 payout = manager.settleNetLoss(covenantId, 350_000, 25_000, keccak256("RECOVERY_FINAL"));

        assertEq(payout, 125_000);
        assertEq(asset.balanceOf(buyer), 125_000);
        assertEq(vault.availableBond(provider), 4_875_000);
        assertEq(manager.getCovenant(covenantId).payoutAtomic, 125_000);
    }

    function testProviderFundedSlaCreditDoesNotDependOnEscrowRefund() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33462;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.payoutBasis = 1;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 slaPolicyId = registry.registerPolicy(terms);
        bytes32 slaJob = keccak256("sla-job");
        bytes32 covenantId = manager.issue(
            slaPolicyId,
            SLA_FINGERPRINT,
            slaJob,
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
        assertEq(uint256(manager.getCovenant(covenantId).state), uint256(CoverageManager.CovenantState.PendingStart));
        manager.startClock(covenantId, uint64(block.timestamp), keccak256("RELAY_RECEIPT"));
        vm.warp(block.timestamp + 301);
        manager.markPayoutDue(covenantId, keccak256("SLA_MISSED"));
        uint256 payout = manager.settleNetLoss(covenantId, 500_000, 0, keccak256("REFUND_FINAL"));

        assertEq(payout, 500_000);
        assertEq(asset.balanceOf(buyer), 500_000);
        assertEq(vault.availableBond(provider), 4_500_000);
    }

    function testCannotMarkBreachBeforeDeadlineOrSettleWithoutEvidence() public {
        bytes32 covenantId = _issue();
        vm.expectRevert(CoverageManager.DeadlineNotElapsed.selector);
        manager.markPayoutDue(covenantId, keccak256("EARLY"));

        vm.warp(block.timestamp + 301);
        manager.markPayoutDue(covenantId, keccak256("DEADLINE_MISSED"));
        vm.expectRevert(CoverageManager.RecoveryEvidenceRequired.selector);
        manager.settleNetLoss(covenantId, 0, 0, bytes32(0));
    }

    function testCannotIssueForWrongProviderOrAboveBuyerLoss() public {
        vm.expectRevert(CoverageManager.ProviderMismatch.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            makeAddr("wrong-provider"),
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            500_001,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            600_000,
            600_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 61)
        );
    }

    function testOnlyOperatorCanIssueOrReleaseAndCovenantsCannotReplay() public {
        vm.prank(buyer);
        vm.expectRevert(CoverageManager.Unauthorized.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        bytes32 covenantId = _issue();
        vm.expectRevert(CoverageManager.CovenantAlreadyExists.selector);
        _issue();

        vm.prank(buyer);
        vm.expectRevert(CoverageManager.Unauthorized.selector);
        manager.release(covenantId, keccak256("UNAUTHORIZED"));
    }

    function testRelayClockRejectsMissingEvidenceAndLateStart() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33464;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(terms);
        bytes32 covenantId = manager.issue(
            relayPolicyId,
            SLA_FINGERPRINT,
            keccak256("relay-validation-job"),
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(covenantId, uint64(block.timestamp), bytes32(0));

        vm.warp(block.timestamp + 61);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.startClock(covenantId, uint64(block.timestamp), keccak256("LATE_RELAY_RECEIPT"));
    }

    function testUnstartedRelayClockExpiresAndUnlocksBond() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33463;
        terms.serviceFingerprint = SLA_FINGERPRINT;
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 relayPolicyId = registry.registerPolicy(terms);
        bytes32 covenantId = manager.issue(
            relayPolicyId,
            SLA_FINGERPRINT,
            keccak256("unstarted-job"),
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
        assertEq(vault.availableBond(provider), 4_500_000);
        vm.warp(block.timestamp + 61);
        manager.expireUnstarted(covenantId);
        assertEq(vault.availableBond(provider), 5_000_000);
        assertEq(uint256(manager.getCovenant(covenantId).state), uint256(CoverageManager.CovenantState.Released));
    }

    function testRegistryOwnershipTransferIsTwoStep() public {
        address nextOwner = makeAddr("next-owner");
        registry.transferOwnership(nextOwner);
        assertEq(registry.owner(), address(this));
        vm.prank(nextOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), nextOwner);
    }

    function _issue() internal returns (bytes32) {
        return manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
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
