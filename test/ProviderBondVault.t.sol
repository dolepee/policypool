// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {MockAgentIdentityRegistry} from "../src/mocks/MockAgentIdentityRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract ProviderBondVaultTest is Test {
    MockERC20 internal asset;
    ProviderBondVault internal vault;
    MockAgentIdentityRegistry internal identity;
    AgentPolicyRegistry internal registry;

    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal adapter = makeAddr("wardenAdapter");
    uint256 internal providerKey;
    bytes32 internal constant COVENANT = keccak256("covenant-1");
    bytes32 internal constant MARKETPLACE = keccak256("OKX_AI_XLAYER");
    bytes32 internal constant FINGERPRINT = keccak256("service-v1");

    function setUp() public {
        (provider, providerKey) = makeAddrAndKey("provider");
        asset = new MockERC20("USD0", "USD0", 6);
        vault = new ProviderBondVault(address(asset), address(this), 8 days);
        identity = new MockAgentIdentityRegistry();
        registry = new AgentPolicyRegistry(address(identity), address(vault), address(this), 500_000, 7 days);
        identity.setOwner(3808, provider);
        asset.mint(provider, 10_000_000);
        vm.startPrank(provider);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(5_000_000);
        vm.stopPrank();
    }

    function testBondLockPreventsWithdrawalAndReleaseRestoresCapacity() public {
        vault.lock(COVENANT, provider, 2_000_000);
        assertEq(vault.availableBond(provider), 3_000_000);

        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.InsufficientAvailableBond.selector);
        vault.requestWithdrawal(3_000_001);

        vault.release(COVENANT);
        assertEq(vault.availableBond(provider), 5_000_000);
    }

    function testWithdrawalCooldownCannotConsumeLockedBond() public {
        vault.lock(COVENANT, provider, 1_000_000);
        vm.prank(provider);
        vault.requestWithdrawal(4_000_000);
        assertEq(vault.availableBond(provider), 0);

        vm.prank(provider);
        vm.expectRevert(ProviderBondVault.WithdrawalNotReady.selector);
        vault.executeWithdrawal();

        vm.warp(block.timestamp + 8 days);
        vm.prank(provider);
        vault.executeWithdrawal();
        assertEq(asset.balanceOf(provider), 9_000_000);
        assertEq(vault.availableBond(provider), 0);
    }

    function testSlashPaysOnlySpecifiedLossAndUnlocksRemainder() public {
        vault.lock(COVENANT, provider, 2_000_000);
        vault.slash(COVENANT, buyer, 750_000);

        assertEq(asset.balanceOf(buyer), 750_000);
        assertEq(vault.availableBond(provider), 4_250_000);
        vm.expectRevert(ProviderBondVault.CovenantNotActive.selector);
        vault.slash(COVENANT, buyer, 1);
    }

    function testPolicyRegistrationRequiresAgentOwnershipAndBond() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();

        vm.prank(buyer);
        vm.expectRevert(AgentPolicyRegistry.AgentOwnerMismatch.selector);
        registry.registerPolicy(terms);

        vm.prank(provider);
        bytes32 policyId = registry.registerPolicy(terms);
        assertTrue(registry.isCoverable(policyId, FINGERPRINT));
    }

    function testPolicyVersioningDoesNotMutatePriorPolicy() public {
        AgentPolicyRegistry.PolicyTerms memory first = _terms();
        vm.prank(provider);
        bytes32 firstId = registry.registerPolicy(first);

        AgentPolicyRegistry.PolicyTerms memory second = _terms();
        second.serviceFingerprint = keccak256("service-v2");
        vm.prank(provider);
        bytes32 secondId = registry.registerPolicy(second);

        assertNotEq(firstId, secondId);
        assertFalse(registry.isCoverable(firstId, FINGERPRINT));
        assertTrue(registry.isCoverable(secondId, second.serviceFingerprint));
        assertEq(registry.getPolicy(firstId).version, 1);
        assertEq(registry.getPolicy(secondId).version, 2);
    }

    function testFingerprintChangeSuspendsNewIssuance() public {
        vm.prank(provider);
        bytes32 policyId = registry.registerPolicy(_terms());

        bytes32 changed = keccak256("service-changed");
        registry.suspendForFingerprint(policyId, changed);
        assertFalse(registry.isCoverable(policyId, FINGERPRINT));
    }

    function testAgentOwnershipChangeFailsClosedOnchain() public {
        vm.prank(provider);
        bytes32 policyId = registry.registerPolicy(_terms());
        assertTrue(registry.isCoverable(policyId, FINGERPRINT));

        identity.setOwner(3808, buyer);
        assertFalse(registry.isCoverable(policyId, FINGERPRINT));
    }

    function testRelayedEnrollmentUsesNonceAndCannotReplay() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = registry.enrollmentDigest(provider, terms, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes32 policyId = registry.registerPolicyBySig(provider, terms, 0, deadline, signature);
        assertTrue(registry.isCoverable(policyId, FINGERPRINT));
        assertEq(registry.nonces(provider), 1);

        vm.expectRevert(AgentPolicyRegistry.InvalidNonce.selector);
        registry.registerPolicyBySig(provider, terms, 0, deadline, signature);
    }

    function testRelayedEnrollmentRejectsExpiredAndWrongSigner() public {
        AgentPolicyRegistry.PolicyTerms memory terms = _terms();
        uint256 deadline = block.timestamp + 1;
        bytes32 digest = registry.enrollmentDigest(provider, terms, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("wrong")), digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(AgentPolicyRegistry.InvalidSignature.selector);
        registry.registerPolicyBySig(provider, terms, 0, deadline, signature);

        vm.warp(deadline + 1);
        vm.expectRevert(AgentPolicyRegistry.SignatureExpired.selector);
        registry.registerPolicyBySig(provider, terms, 0, deadline, signature);
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
            premiumBps: 500,
            payoutBasis: 0,
            clockMode: 0,
            expiresAt: uint64(block.timestamp + 30 days),
            adapter: adapter
        });
    }
}
