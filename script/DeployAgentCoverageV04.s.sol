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

    address internal constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant OKX_TASK_ESCROW = 0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE;

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
        DeploymentConfig memory config = _configuration(deployer);
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

    function _configuration(address deployer) private view returns (DeploymentConfig memory config) {
        config.owner = vm.envOr("POLICYPOOL_V04_OWNER", deployer);
        config.identityRegistry = vm.envAddress("OKX_AGENT_IDENTITY_REGISTRY");
        config.paymentAsset = vm.envOr("POLICYPOOL_PAYMENT_ASSET", XLAYER_USDT0);
        config.taskEscrow = vm.envOr("POLICYPOOL_OKX_TASK_ESCROW", OKX_TASK_ESCROW);
        config.relaySigner = vm.envAddress("POLICYPOOL_RELAY_SIGNER_ADDRESS");
        config.evidenceSigners = vm.envAddress("POLICYPOOL_EVIDENCE_SIGNERS", ",");
        config.evidenceThreshold = uint8(vm.envUint("POLICYPOOL_EVIDENCE_THRESHOLD"));
        config.recoveryEvidenceSigners = vm.envAddress("POLICYPOOL_RECOVERY_EVIDENCE_SIGNERS", ",");
        config.recoveryEvidenceThreshold = uint8(vm.envUint("POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD"));
        config.minimumBondAtomic = vm.envOr("POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC", uint256(500_000));
        config.maximumSlaSeconds = uint32(vm.envOr("POLICYPOOL_V04_MAX_SLA_SECONDS", uint256(7 days)));
    }

    function _requireDisjointEvidenceQuorums(address[] memory primary, address[] memory recovery) private pure {
        for (uint256 primaryIndex; primaryIndex < primary.length; ++primaryIndex) {
            for (uint256 recoveryIndex; recoveryIndex < recovery.length; ++recoveryIndex) {
                if (primary[primaryIndex] == recovery[recoveryIndex]) revert EvidenceSignerOverlap();
            }
        }
    }
}
