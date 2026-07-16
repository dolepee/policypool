// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {OkxA2AClockAdapter} from "../src/adapters/OkxA2AClockAdapter.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";

contract DeployAgentCoverageV04 is Script {
    error EvidenceSignerOverlap();
    error InvalidDeploymentChain();
    error InvalidDeploymentConfiguration();
    error RoleCollision();

    uint256 internal constant XLAYER_CHAIN_ID = 196;
    address internal constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant OKX_TASK_ESCROW = 0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE;
    address internal constant OKX_AGENT_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 internal constant V04_MINIMUM_BOND_ATOMIC = 500_000;
    uint32 internal constant V04_MAXIMUM_SLA_SECONDS = 7 days;
    uint256 internal constant V04_EVIDENCE_SIGNER_COUNT = 5;
    uint8 internal constant V04_EVIDENCE_THRESHOLD = 3;

    struct DeploymentConfig {
        address owner;
        address identityRegistry;
        address paymentAsset;
        address taskEscrow;
        address relaySigner;
        address[] evidenceSigners;
        address[] recoveryEvidenceSigners;
        uint256 minimumBondAtomic;
        uint32 maximumSlaSeconds;
        uint8 evidenceThreshold;
        uint8 recoveryEvidenceThreshold;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        DeploymentConfig memory config = _configuration();
        _validateConfiguration(config, deployer);
        _requireDisjointEvidenceQuorums(config.evidenceSigners, config.recoveryEvidenceSigners);

        vm.startBroadcast(deployerKey);
        ProviderBondVault vault = new ProviderBondVault(config.paymentAsset, deployer, 8 days);
        AgentPolicyRegistry registry = new AgentPolicyRegistry(
            config.identityRegistry, address(vault), config.owner, config.minimumBondAtomic, config.maximumSlaSeconds
        );
        CoverageEvidenceVerifier evidenceVerifier =
            new CoverageEvidenceVerifier(config.evidenceSigners, config.evidenceThreshold);
        CoverageEvidenceVerifier recoveryEvidenceVerifier =
            new CoverageEvidenceVerifier(config.recoveryEvidenceSigners, config.recoveryEvidenceThreshold);
        CoverageManager manager = new CoverageManager(
            address(registry), address(vault), address(evidenceVerifier), address(recoveryEvidenceVerifier)
        );
        OkxA2AClockAdapter a2aAdapter = new OkxA2AClockAdapter(config.taskEscrow);
        RelayReceiptVerifier relayAdapter = new RelayReceiptVerifier(config.owner, config.relaySigner);
        vault.initializeManager(address(manager));
        if (config.owner != deployer) vault.transferOwnership(config.owner);
        vm.stopBroadcast();

        console2.log("POLICYPOOL_POLICY_REGISTRY_ADDRESS", address(registry));
        console2.log("POLICYPOOL_BOND_VAULT_ADDRESS", address(vault));
        console2.log("POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS", address(evidenceVerifier));
        console2.log("POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS", address(recoveryEvidenceVerifier));
        console2.log("POLICYPOOL_COVERAGE_MANAGER_ADDRESS", address(manager));
        console2.log("POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS", address(a2aAdapter));
        console2.log("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS", address(relayAdapter));
        console2.log("Owner", config.owner);
        if (config.owner != deployer) console2.log("Bond vault ownership pending acceptance by", config.owner);
        console2.log("Relay signer", config.relaySigner);
        console2.log("Evidence signer threshold", config.evidenceThreshold);
        console2.log("Recovery evidence signer threshold", config.recoveryEvidenceThreshold);
    }

    function _configuration() private view returns (DeploymentConfig memory config) {
        config.owner = vm.envAddress("POLICYPOOL_V04_OWNER");
        config.identityRegistry = vm.envAddress("OKX_AGENT_IDENTITY_REGISTRY");
        config.paymentAsset = vm.envOr("POLICYPOOL_PAYMENT_ASSET", XLAYER_USDT0);
        config.taskEscrow = vm.envOr("POLICYPOOL_OKX_TASK_ESCROW", OKX_TASK_ESCROW);
        config.relaySigner = vm.envAddress("POLICYPOOL_RELAY_SIGNER_ADDRESS");
        config.evidenceSigners = vm.envAddress("POLICYPOOL_EVIDENCE_SIGNERS", ",");
        uint256 evidenceThreshold = vm.envUint("POLICYPOOL_EVIDENCE_THRESHOLD");
        config.recoveryEvidenceSigners = vm.envAddress("POLICYPOOL_RECOVERY_EVIDENCE_SIGNERS", ",");
        uint256 recoveryEvidenceThreshold = vm.envUint("POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD");
        uint256 maximumSlaSeconds = vm.envOr("POLICYPOOL_V04_MAX_SLA_SECONDS", uint256(7 days));
        if (
            evidenceThreshold > type(uint8).max || recoveryEvidenceThreshold > type(uint8).max
                || maximumSlaSeconds > type(uint32).max
        ) revert InvalidDeploymentConfiguration();
        config.evidenceThreshold = uint8(evidenceThreshold);
        config.recoveryEvidenceThreshold = uint8(recoveryEvidenceThreshold);
        config.minimumBondAtomic = vm.envOr("POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC", V04_MINIMUM_BOND_ATOMIC);
        config.maximumSlaSeconds = uint32(maximumSlaSeconds);
    }

    function _validateConfiguration(DeploymentConfig memory config, address deployer) private view {
        if (block.chainid != XLAYER_CHAIN_ID) revert InvalidDeploymentChain();
        if (
            config.identityRegistry != OKX_AGENT_IDENTITY_REGISTRY || config.paymentAsset != XLAYER_USDT0
                || config.taskEscrow != OKX_TASK_ESCROW || config.minimumBondAtomic != V04_MINIMUM_BOND_ATOMIC
                || config.maximumSlaSeconds != V04_MAXIMUM_SLA_SECONDS
                || config.evidenceSigners.length != V04_EVIDENCE_SIGNER_COUNT
                || config.recoveryEvidenceSigners.length != V04_EVIDENCE_SIGNER_COUNT
                || config.evidenceThreshold != V04_EVIDENCE_THRESHOLD
                || config.recoveryEvidenceThreshold != V04_EVIDENCE_THRESHOLD
        ) revert InvalidDeploymentConfiguration();
        if (
            config.owner == address(0) || config.relaySigner == address(0) || deployer == address(0)
                || config.owner == config.relaySigner || config.owner == deployer || config.relaySigner == deployer
        ) revert RoleCollision();
        _validateEvidenceQuorum(config.evidenceSigners);
        _validateEvidenceQuorum(config.recoveryEvidenceSigners);
        _requireRoleOutsideQuorums(config.owner, config.evidenceSigners, config.recoveryEvidenceSigners);
        _requireRoleOutsideQuorums(config.relaySigner, config.evidenceSigners, config.recoveryEvidenceSigners);
        _requireRoleOutsideQuorums(deployer, config.evidenceSigners, config.recoveryEvidenceSigners);
    }

    function _validateEvidenceQuorum(address[] memory signers) private pure {
        for (uint256 index; index < signers.length; ++index) {
            if (signers[index] == address(0)) revert InvalidDeploymentConfiguration();
            for (uint256 prior; prior < index; ++prior) {
                if (signers[index] == signers[prior]) revert InvalidDeploymentConfiguration();
            }
        }
    }

    function _requireRoleOutsideQuorums(address role, address[] memory primary, address[] memory recovery)
        private
        pure
    {
        for (uint256 index; index < primary.length; ++index) {
            if (role == primary[index]) revert RoleCollision();
        }
        for (uint256 index; index < recovery.length; ++index) {
            if (role == recovery[index]) revert RoleCollision();
        }
    }

    function _requireDisjointEvidenceQuorums(address[] memory primary, address[] memory recovery) private pure {
        for (uint256 primaryIndex; primaryIndex < primary.length; ++primaryIndex) {
            for (uint256 recoveryIndex; recoveryIndex < recovery.length; ++recoveryIndex) {
                if (primary[primaryIndex] == recovery[recoveryIndex]) revert EvidenceSignerOverlap();
            }
        }
    }
}
