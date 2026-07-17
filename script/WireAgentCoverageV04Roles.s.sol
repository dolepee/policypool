// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {PolicyFeeEscrow} from "../src/PolicyFeeEscrow.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {OkxA2AClockAdapter} from "../src/adapters/OkxA2AClockAdapter.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";

/// @notice Completes the post-deploy cold-owner role split and verifies all static wiring.
contract WireAgentCoverageV04Roles is Script {
    error OwnershipMismatch();
    error StaticWiringMismatch();
    error RoleWiringMismatch();
    error EvidenceSignerOverlap();
    error InvalidDeploymentChain();
    error RoleCollision();

    uint256 internal constant XLAYER_CHAIN_ID = 196;
    address internal constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant OKX_TASK_ESCROW = 0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE;
    address internal constant OKX_AGENT_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 internal constant V04_MINIMUM_BOND_ATOMIC = 500_000;
    uint32 internal constant V04_MAXIMUM_SLA_SECONDS = 7 days;
    uint256 internal constant V04_EVIDENCE_SIGNER_COUNT = 5;
    uint256 internal constant V04_EVIDENCE_THRESHOLD = 3;
    uint128 internal constant V04_DIRECT_FEE_ATOMIC = 100_000;

    struct RoleConfiguration {
        uint256 ownerKey;
        address coldOwner;
        address monitor;
        address relaySigner;
        address feeTreasury;
        address[] evidenceSigners;
        address[] recoveryEvidenceSigners;
        uint256 evidenceThreshold;
        uint256 recoveryEvidenceThreshold;
    }

    struct Deployment {
        ProviderBondVault vault;
        AgentPolicyRegistry registry;
        CoverageEvidenceVerifier evidenceVerifier;
        CoverageEvidenceVerifier recoveryEvidenceVerifier;
        CoverageManager manager;
        PolicyFeeEscrow feeEscrow;
        OkxA2AClockAdapter a2a;
        RelayReceiptVerifier relay;
    }

    function run() external {
        RoleConfiguration memory roles = _roleConfiguration();
        Deployment memory deployed = _deployment();
        _validateWiring(deployed, roles);

        vm.startBroadcast(roles.ownerKey);
        if (deployed.vault.owner() != roles.coldOwner) deployed.vault.acceptOwnership();
        if (deployed.registry.monitor() != roles.monitor) deployed.registry.setMonitor(roles.monitor);
        vm.stopBroadcast();

        if (deployed.vault.owner() != roles.coldOwner || deployed.registry.monitor() != roles.monitor) {
            revert RoleWiringMismatch();
        }
        _logWiring(deployed);
    }

    function _roleConfiguration() private view returns (RoleConfiguration memory roles) {
        roles.ownerKey = vm.envUint("POLICYPOOL_V04_OWNER_PRIVATE_KEY");
        roles.coldOwner = vm.addr(roles.ownerKey);
        roles.monitor = vm.envAddress("POLICYPOOL_V04_MONITOR");
        roles.relaySigner = vm.envAddress("POLICYPOOL_RELAY_SIGNER_ADDRESS");
        roles.feeTreasury = vm.envAddress("POLICYPOOL_FEE_TREASURY");
        roles.evidenceSigners = vm.envAddress("POLICYPOOL_EVIDENCE_SIGNERS", ",");
        roles.evidenceThreshold = vm.envUint("POLICYPOOL_EVIDENCE_THRESHOLD");
        roles.recoveryEvidenceSigners = vm.envAddress("POLICYPOOL_RECOVERY_EVIDENCE_SIGNERS", ",");
        roles.recoveryEvidenceThreshold = vm.envUint("POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD");
    }

    function _deployment() private view returns (Deployment memory deployed) {
        deployed.vault = ProviderBondVault(vm.envAddress("POLICYPOOL_BOND_VAULT_ADDRESS"));
        deployed.registry = AgentPolicyRegistry(vm.envAddress("POLICYPOOL_POLICY_REGISTRY_ADDRESS"));
        deployed.evidenceVerifier = CoverageEvidenceVerifier(vm.envAddress("POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS"));
        deployed.recoveryEvidenceVerifier =
            CoverageEvidenceVerifier(vm.envAddress("POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS"));
        deployed.manager = CoverageManager(vm.envAddress("POLICYPOOL_COVERAGE_MANAGER_ADDRESS"));
        deployed.feeEscrow = PolicyFeeEscrow(vm.envAddress("POLICYPOOL_FEE_ESCROW_ADDRESS"));
        deployed.a2a = OkxA2AClockAdapter(vm.envAddress("POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS"));
        deployed.relay = RelayReceiptVerifier(vm.envAddress("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS"));
    }

    function _validateWiring(Deployment memory deployed, RoleConfiguration memory roles) private view {
        if (block.chainid != XLAYER_CHAIN_ID) revert InvalidDeploymentChain();
        if (deployed.registry.owner() != roles.coldOwner || deployed.relay.owner() != roles.coldOwner) {
            revert OwnershipMismatch();
        }
        if (deployed.vault.owner() != roles.coldOwner && deployed.vault.pendingOwner() != roles.coldOwner) {
            revert OwnershipMismatch();
        }
        if (
            deployed.vault.manager() != address(deployed.manager)
                || address(deployed.registry.bondVault()) != address(deployed.vault)
                || address(deployed.manager.bondVault()) != address(deployed.vault)
                || address(deployed.manager.policyRegistry()) != address(deployed.registry)
                || address(deployed.manager.evidenceVerifier()) != address(deployed.evidenceVerifier)
                || address(deployed.manager.recoveryEvidenceVerifier()) != address(deployed.recoveryEvidenceVerifier)
                || address(deployed.feeEscrow.asset()) != XLAYER_USDT0
                || address(deployed.feeEscrow.evidenceVerifier()) != address(deployed.evidenceVerifier)
                || address(deployed.feeEscrow.coverageManager()) != address(deployed.manager)
                || deployed.feeEscrow.treasury() != roles.feeTreasury
                || deployed.feeEscrow.feeAmountAtomic() != V04_DIRECT_FEE_ATOMIC
                || address(deployed.vault.asset()) != XLAYER_USDT0 || deployed.vault.withdrawalDelay() != 8 days
                || !deployed.vault.managerInitialized()
                || address(deployed.registry.identityRegistry()) != OKX_AGENT_IDENTITY_REGISTRY
                || deployed.registry.minimumBondAtomic() != V04_MINIMUM_BOND_ATOMIC
                || deployed.registry.maximumSlaSeconds() != V04_MAXIMUM_SLA_SECONDS
                || address(deployed.a2a.taskEscrow()) != OKX_TASK_ESCROW
        ) revert StaticWiringMismatch();
        if (deployed.relay.trustedSigner() != roles.relaySigner) revert RoleWiringMismatch();
        _requireRoleSeparation(
            roles.coldOwner, roles.monitor, roles.relaySigner, roles.evidenceSigners, roles.recoveryEvidenceSigners
        );
        _validateEvidenceWiring(deployed, roles);
    }

    function _validateEvidenceWiring(Deployment memory deployed, RoleConfiguration memory roles) private view {
        if (
            roles.evidenceSigners.length != V04_EVIDENCE_SIGNER_COUNT
                || roles.recoveryEvidenceSigners.length != V04_EVIDENCE_SIGNER_COUNT
                || roles.evidenceThreshold != V04_EVIDENCE_THRESHOLD
                || roles.recoveryEvidenceThreshold != V04_EVIDENCE_THRESHOLD
                || deployed.evidenceVerifier.threshold() != roles.evidenceThreshold
                || deployed.evidenceVerifier.signerCount() != roles.evidenceSigners.length
        ) revert RoleWiringMismatch();
        for (uint256 index; index < roles.evidenceSigners.length; ++index) {
            if (deployed.evidenceVerifier.signerAt(index) != roles.evidenceSigners[index]) {
                revert RoleWiringMismatch();
            }
        }
        if (
            deployed.recoveryEvidenceVerifier.threshold() != roles.recoveryEvidenceThreshold
                || deployed.recoveryEvidenceVerifier.signerCount() != roles.recoveryEvidenceSigners.length
        ) revert RoleWiringMismatch();
        for (uint256 index; index < roles.recoveryEvidenceSigners.length; ++index) {
            if (deployed.recoveryEvidenceVerifier.signerAt(index) != roles.recoveryEvidenceSigners[index]) {
                revert RoleWiringMismatch();
            }
            for (uint256 primaryIndex; primaryIndex < roles.evidenceSigners.length; ++primaryIndex) {
                if (roles.recoveryEvidenceSigners[index] == roles.evidenceSigners[primaryIndex]) {
                    revert EvidenceSignerOverlap();
                }
            }
        }
    }

    function _logWiring(Deployment memory deployed) private view {
        console2.log("Bond vault owner", deployed.vault.owner());
        console2.log("Coverage evidence verifier", address(deployed.manager.evidenceVerifier()));
        console2.log("Evidence signer threshold", deployed.evidenceVerifier.threshold());
        console2.log("Evidence signer count", deployed.evidenceVerifier.signerCount());
        console2.log("Recovery evidence verifier", address(deployed.manager.recoveryEvidenceVerifier()));
        console2.log("Recovery evidence signer threshold", deployed.recoveryEvidenceVerifier.threshold());
        console2.log("Recovery evidence signer count", deployed.recoveryEvidenceVerifier.signerCount());
        console2.log("Policy registry owner", deployed.registry.owner());
        console2.log("Policy registry monitor", deployed.registry.monitor());
        console2.log("Relay verifier owner", deployed.relay.owner());
        console2.log("Relay signer", deployed.relay.trustedSigner());
        console2.log("Policy fee escrow", address(deployed.feeEscrow));
        console2.log("Policy fee treasury", deployed.feeEscrow.treasury());
    }

    function _requireRoleSeparation(
        address coldOwner,
        address monitor,
        address relaySigner,
        address[] memory primary,
        address[] memory recovery
    ) private pure {
        if (
            coldOwner == address(0) || monitor == address(0) || relaySigner == address(0) || coldOwner == monitor
                || coldOwner == relaySigner || monitor == relaySigner
        ) {
            revert RoleCollision();
        }
        for (uint256 index; index < primary.length; ++index) {
            if (primary[index] == coldOwner || primary[index] == monitor || primary[index] == relaySigner) {
                revert RoleCollision();
            }
        }
        for (uint256 index; index < recovery.length; ++index) {
            if (recovery[index] == coldOwner || recovery[index] == monitor || recovery[index] == relaySigner) {
                revert RoleCollision();
            }
        }
    }
}
