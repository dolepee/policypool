// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {OkxA2AClockAdapter} from "../src/adapters/OkxA2AClockAdapter.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOkxTaskStatus} from "../src/mocks/MockOkxTaskStatus.sol";

contract ConfigurableBondAsset {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

    bool public failTransfer;
    bool public failTransferFrom;
    bool public reenterTransferFrom;
    uint256 public transferFee;
    ProviderBondVault public reentryVault;
    address public reentryProvider;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function configureTransfer(bool fail, uint256 fee) external {
        failTransfer = fail;
        transferFee = fee;
    }

    function configureTransferFrom(bool fail, uint256 fee) external {
        failTransferFrom = fail;
        transferFee = fee;
    }

    function configureReentry(ProviderBondVault vault, address provider) external {
        reentryVault = vault;
        reentryProvider = provider;
        reenterTransferFrom = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransferFrom) return false;
        if (reenterTransferFrom) reentryVault.depositFor(reentryProvider, 1);
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount - transferFee;
    }
}

contract V04AdversarialBranchesTest is Test {
    MockERC20 internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;
    CoverageManager internal manager;

    address internal provider;
    uint256 internal providerKey;
    address internal buyer = makeAddr("buyer");
    address internal outsider = makeAddr("outsider");
    address internal adapter = makeAddr("adapter");

    bytes32 internal constant MARKETPLACE = keccak256("OKX.AI");
    bytes32 internal constant FINGERPRINT = keccak256("service-v1");
    bytes32 internal constant JOB_ID = keccak256("job-v04-adversarial");

    function setUp() public {
        (provider, providerKey) = makeAddrAndKey("provider");
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
        vm.stopPrank();
    }

    function testVaultRejectsInvalidConstructionAndOwnerActions() public {
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        new ProviderBondVault(address(0), address(this), 8 days);
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        new ProviderBondVault(address(asset), address(0), 8 days);
        vm.expectRevert(ProviderBondVault.WithdrawalDelayTooShort.selector);
        new ProviderBondVault(address(asset), address(this), 8 days - 1);

        vm.prank(outsider);
        vm.expectRevert(ProviderBondVault.Unauthorized.selector);
        vault.setManager(outsider);
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        vault.setManager(address(0));
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        vault.transferOwnership(address(0));
        vm.prank(outsider);
        vm.expectRevert(ProviderBondVault.Unauthorized.selector);
        vault.acceptOwnership();
    }

    function testVaultRejectsInvalidDepositsAndUnsafeAssets() public {
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        vault.depositFor(address(0), 1);
        vm.expectRevert(ProviderBondVault.ZeroAmount.selector);
        vault.depositFor(provider, 0);

        ConfigurableBondAsset badAsset = new ConfigurableBondAsset();
        ProviderBondVault badVault = new ProviderBondVault(address(badAsset), address(this), 8 days);
        badAsset.mint(address(this), 1_000_000);
        badAsset.approve(address(badVault), type(uint256).max);

        badAsset.configureTransferFrom(true, 0);
        vm.expectRevert(ProviderBondVault.TokenTransferFailed.selector);
        badVault.deposit(500_000);

        badAsset.configureTransferFrom(false, 1);
        vm.expectRevert(ProviderBondVault.FeeOnTransferUnsupported.selector);
        badVault.deposit(500_000);

        badAsset.configureTransferFrom(false, 0);
        badAsset.configureReentry(badVault, address(this));
        vm.expectRevert(ProviderBondVault.TokenTransferFailed.selector);
        badVault.deposit(500_000);
    }

    function testVaultRejectsInvalidWithdrawalLockAndSlashTransitions() public {
        bytes32 covenant = keccak256("vault-invalid-covenant");

        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.ZeroAmount.selector);
        vault.requestWithdrawal(0);
        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.WithdrawalNotQueued.selector);
        vault.executeWithdrawal();

        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        managerVaultLock(covenant, address(0), 1);
        vm.expectRevert(ProviderBondVault.ZeroAmount.selector);
        managerVaultLock(covenant, provider, 0);
        vm.expectRevert(ProviderBondVault.InsufficientAvailableBond.selector);
        managerVaultLock(covenant, provider, 5_000_001);
        vm.expectRevert(ProviderBondVault.CovenantNotActive.selector);
        managerVaultRelease(covenant);

        managerVaultLock(covenant, provider, 500_000);
        vm.expectRevert(ProviderBondVault.ZeroAddress.selector);
        managerVaultSlash(covenant, address(0), 1);
        vm.expectRevert(ProviderBondVault.InvalidSlashAmount.selector);
        managerVaultSlash(covenant, buyer, 0);
        vm.expectRevert(ProviderBondVault.InvalidSlashAmount.selector);
        managerVaultSlash(covenant, buyer, 500_001);
    }

    function testVaultRollsBackWhenOutboundTokenTransferFails() public {
        ConfigurableBondAsset badAsset = new ConfigurableBondAsset();
        ProviderBondVault badVault = new ProviderBondVault(address(badAsset), address(this), 8 days);
        badAsset.mint(provider, 1_000_000);
        vm.startPrank(provider);
        badAsset.approve(address(badVault), type(uint256).max);
        badVault.deposit(1_000_000);
        badVault.requestWithdrawal(500_000);
        vm.stopPrank();
        vm.warp(block.timestamp + 8 days);
        badAsset.configureTransfer(true, 0);

        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.TokenTransferFailed.selector);
        badVault.executeWithdrawal();
        assertEq(badVault.account(provider).balance, 1_000_000);
        assertEq(badVault.account(provider).queuedWithdrawal, 500_000);
    }

    function testRegistryRejectsInvalidConstructionAndCapitalBounds() public {
        vm.expectRevert(AgentPolicyRegistry.ZeroAddress.selector);
        new AgentPolicyRegistry(address(0), address(vault), address(this), 500_000, 7 days);
        vm.expectRevert(AgentPolicyRegistry.ZeroAddress.selector);
        new AgentPolicyRegistry(address(identity), address(0), address(this), 500_000, 7 days);
        vm.expectRevert(AgentPolicyRegistry.ZeroAddress.selector);
        new AgentPolicyRegistry(address(identity), address(vault), address(0), 500_000, 7 days);
        vm.expectRevert(AgentPolicyRegistry.InvalidPolicy.selector);
        new AgentPolicyRegistry(address(identity), address(vault), address(this), 0, 7 days);
        vm.expectRevert(AgentPolicyRegistry.InvalidPolicy.selector);
        new AgentPolicyRegistry(address(identity), address(vault), address(this), 500_000, 0);

        address unbonded = makeAddr("unbonded-provider");
        identity.setOwner(4000, unbonded);
        AgentPolicyRegistry.PolicyTerms memory unbondedTerms = _terms();
        unbondedTerms.agentId = 4000;
        vm.prank(unbonded);
        vm.expectRevert(AgentPolicyRegistry.InsufficientProviderBond.selector);
        registry.registerPolicy(unbondedTerms);

        AgentPolicyRegistry.PolicyTerms memory oversized = _terms();
        oversized.maxCapAtomic = 5_000_001;
        vm.prank(provider);
        vm.expectRevert(AgentPolicyRegistry.InsufficientProviderBond.selector);
        registry.registerPolicy(oversized);
    }

    function testRegistryRejectsEveryInvalidPolicyDimension() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();

        terms.marketplace = bytes32(0);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.agentId = 0;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.serviceId = 0;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.serviceFingerprint = bytes32(0);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.scopeHash = bytes32(0);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.adapter = address(0);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.maxCapAtomic = 0;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.expiresAt = uint64(block.timestamp);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.slaSeconds = 0;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.slaSeconds = 7 days + 1;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.enrollmentWindowSeconds = 0;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.enrollmentWindowSeconds = terms.slaSeconds + 1;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.expiresAt = uint64(block.timestamp + terms.slaSeconds);
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.premiumBps = 10_001;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.payoutBasis = 2;
        _expectInvalidPolicy(terms);
        terms = _terms();
        terms.clockMode = 2;
        _expectInvalidPolicy(terms);
    }

    function testRegistryRejectsUnauthorizedLifecycleAndInvalidSignatures() public {
        vm.expectRevert(AgentPolicyRegistry.PolicyNotActive.selector);
        registry.pausePolicy(keccak256("unknown-policy"), keccak256("pause"));
        vm.prank(outsider);
        vm.expectRevert(AgentPolicyRegistry.Unauthorized.selector);
        registry.suspendForFingerprint(keccak256("unknown-policy"), FINGERPRINT);
        vm.prank(outsider);
        vm.expectRevert(AgentPolicyRegistry.Unauthorized.selector);
        registry.setMonitor(outsider);
        vm.expectRevert(AgentPolicyRegistry.ZeroAddress.selector);
        registry.setMonitor(address(0));
        vm.expectRevert(AgentPolicyRegistry.ZeroAddress.selector);
        registry.transferOwnership(address(0));
        vm.prank(outsider);
        vm.expectRevert(AgentPolicyRegistry.Unauthorized.selector);
        registry.acceptOwnership();

        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        bytes memory zeroSigner = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        vm.expectRevert(AgentPolicyRegistry.InvalidSignature.selector);
        registry.registerPolicyBySig(provider, terms, 0, block.timestamp + 10 minutes, zeroSigner);
        bytes memory highS = abi.encodePacked(bytes32(0), bytes32(type(uint256).max), uint8(27));
        vm.expectRevert(AgentPolicyRegistry.InvalidSignature.selector);
        registry.registerPolicyBySig(provider, terms, 0, block.timestamp + 10 minutes, highS);
    }

    function testManagerRejectsInvalidConstructionAndOwnershipChanges() public {
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        new CoverageManager(address(0), address(vault), address(this));
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        new CoverageManager(address(registry), address(0), address(this));
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        new CoverageManager(address(registry), address(vault), address(0));

        vm.prank(outsider);
        vm.expectRevert(CoverageManager.Unauthorized.selector);
        manager.setOperator(outsider);
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        manager.setOperator(address(0));
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        manager.transferOwnership(address(0));
        vm.prank(outsider);
        vm.expectRevert(CoverageManager.Unauthorized.selector);
        manager.acceptOwnership();
    }

    function testManagerRejectsInvalidIssueAndLifecycleTransitions() public {
        bytes32 policyId = _registerPolicy();
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            address(0),
            buyer,
            1,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
        vm.expectRevert(CoverageManager.ZeroAddress.selector);
        manager.issue(
            policyId,
            FINGERPRINT,
            JOB_ID,
            provider,
            address(0),
            1,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.issue(
            bytes32(0),
            FINGERPRINT,
            JOB_ID,
            provider,
            buyer,
            1,
            1,
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
            1,
            1,
            uint64(block.timestamp + 1),
            uint64(block.timestamp + 60)
        );
        vm.expectRevert(CoverageManager.PolicyNotCoverable.selector);
        manager.issue(
            policyId,
            keccak256("wrong-fingerprint"),
            JOB_ID,
            provider,
            buyer,
            1,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        bytes32 covenantId = _issue(policyId, JOB_ID);
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.startClock(covenantId, uint64(block.timestamp), keccak256("not-relay"));
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.expireUnstarted(covenantId);
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.settleNetLoss(covenantId, 0, 0, keccak256("not-due"));

        vm.warp(block.timestamp + 301);
        vm.expectRevert(CoverageManager.InvalidCovenant.selector);
        manager.markPayoutDue(covenantId, bytes32(0));
        manager.markPayoutDue(covenantId, keccak256("deadline-missed"));
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.markPayoutDue(covenantId, keccak256("duplicate"));
        manager.settleNetLoss(covenantId, 500_000, 0, keccak256("full-recovery"));
        vm.expectRevert(CoverageManager.CovenantNotActive.selector);
        manager.release(covenantId, keccak256("already-final"));
    }

    function testManagerRejectsEarlyRelayExpiry() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        terms.serviceId = 33462;
        terms.serviceFingerprint = keccak256("relay-service");
        terms.clockMode = 1;
        vm.prank(provider);
        bytes32 policyId = registry.registerPolicy(terms);
        bytes32 covenantId = manager.issue(
            policyId,
            terms.serviceFingerprint,
            keccak256("relay-job"),
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );

        vm.expectRevert(CoverageManager.DeadlineNotElapsed.selector);
        manager.expireUnstarted(covenantId);
    }

    function testAdaptersRejectInvalidConfigurationAndCoverHoldBranches() public {
        vm.expectRevert(bytes("task escrow required"));
        new OkxA2AClockAdapter(address(0));

        MockOkxTaskStatus status = new MockOkxTaskStatus();
        OkxA2AClockAdapter clock = new OkxA2AClockAdapter(address(status));
        (, OkxA2AClockAdapter.Action missing) = clock.observe(JOB_ID, uint64(block.timestamp));
        assertEq(uint256(missing), uint256(OkxA2AClockAdapter.Action.Hold));
        status.setJobStatus(JOB_ID, 10);
        (, OkxA2AClockAdapter.Action unknown) = clock.observe(JOB_ID, uint64(block.timestamp));
        assertEq(uint256(unknown), uint256(OkxA2AClockAdapter.Action.Hold));

        vm.expectRevert(RelayReceiptVerifier.ZeroAddress.selector);
        new RelayReceiptVerifier(address(0), provider);
        vm.expectRevert(RelayReceiptVerifier.ZeroAddress.selector);
        new RelayReceiptVerifier(address(this), address(0));
    }

    function testRelayVerifierRejectsInvalidAdminAndSignatureBranches() public {
        RelayReceiptVerifier verifier = new RelayReceiptVerifier(address(this), provider);
        vm.expectRevert(RelayReceiptVerifier.ZeroAddress.selector);
        verifier.setTrustedSigner(address(0));
        vm.expectRevert(RelayReceiptVerifier.ZeroAddress.selector);
        verifier.transferOwnership(address(0));
        vm.prank(outsider);
        vm.expectRevert(RelayReceiptVerifier.Unauthorized.selector);
        verifier.acceptOwnership();

        bytes memory zeroSigner = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        vm.expectRevert(RelayReceiptVerifier.InvalidSignature.selector);
        verifier.verify(keccak256("receipt"), zeroSigner);
        bytes memory highS = abi.encodePacked(bytes32(0), bytes32(type(uint256).max), uint8(27));
        vm.expectRevert(RelayReceiptVerifier.InvalidSignature.selector);
        verifier.verify(keccak256("receipt"), highS);
    }

    function managerVaultLock(bytes32 covenantId, address targetProvider, uint256 amount) internal {
        vm.prank(address(manager));
        vault.lock(covenantId, targetProvider, amount);
    }

    function managerVaultRelease(bytes32 covenantId) internal {
        vm.prank(address(manager));
        vault.release(covenantId);
    }

    function managerVaultSlash(bytes32 covenantId, address recipient, uint256 amount) internal {
        vm.prank(address(manager));
        vault.slash(covenantId, recipient, amount);
    }

    function _registerPolicy() internal returns (bytes32 policyId) {
        vm.prank(provider);
        policyId = registry.registerPolicy(_terms());
    }

    function _issue(bytes32 policyId, bytes32 jobId) internal returns (bytes32 covenantId) {
        covenantId = manager.issue(
            policyId,
            FINGERPRINT,
            jobId,
            provider,
            buyer,
            500_000,
            500_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
    }

    function _expectInvalidPolicy(AgentPolicyRegistry.PolicyTerms memory terms) internal {
        vm.prank(provider);
        vm.expectRevert(AgentPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(terms);
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
            expiresAt: uint64(block.timestamp + 30 days),
            adapter: adapter
        });
    }
}
