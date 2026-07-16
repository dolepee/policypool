// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";

/// @notice Completes the post-deploy cold-owner role split and verifies all static wiring.
contract WireAgentCoverageV04Roles is Script {
    error OwnershipMismatch();
    error StaticWiringMismatch();
    error RoleWiringMismatch();

    function run() external {
        uint256 ownerKey = vm.envUint("POLICYPOOL_V04_OWNER_PRIVATE_KEY");
        address coldOwner = vm.addr(ownerKey);
        address monitor = vm.envAddress("POLICYPOOL_V04_MONITOR");
        address relaySigner = vm.envAddress("POLICYPOOL_RELAY_SIGNER_ADDRESS");
        address[] memory evidenceSigners = vm.envAddress("POLICYPOOL_EVIDENCE_SIGNERS", ",");
        uint256 evidenceThreshold = vm.envUint("POLICYPOOL_EVIDENCE_THRESHOLD");

        ProviderBondVault vault = ProviderBondVault(vm.envAddress("POLICYPOOL_BOND_VAULT_ADDRESS"));
        AgentPolicyRegistry registry = AgentPolicyRegistry(vm.envAddress("POLICYPOOL_POLICY_REGISTRY_ADDRESS"));
        CoverageEvidenceVerifier evidenceVerifier =
            CoverageEvidenceVerifier(vm.envAddress("POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS"));
        CoverageManager manager = CoverageManager(vm.envAddress("POLICYPOOL_COVERAGE_MANAGER_ADDRESS"));
        RelayReceiptVerifier relay = RelayReceiptVerifier(vm.envAddress("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS"));

        if (registry.owner() != coldOwner || relay.owner() != coldOwner) {
            revert OwnershipMismatch();
        }
        if (vault.owner() != coldOwner && vault.pendingOwner() != coldOwner) revert OwnershipMismatch();
        if (
            vault.manager() != address(manager) || address(registry.bondVault()) != address(vault)
                || address(manager.bondVault()) != address(vault)
                || address(manager.policyRegistry()) != address(registry)
                || address(manager.evidenceVerifier()) != address(evidenceVerifier)
        ) revert StaticWiringMismatch();
        if (relay.trustedSigner() != relaySigner) revert RoleWiringMismatch();
        if (
            evidenceVerifier.threshold() != evidenceThreshold
                || evidenceVerifier.signerCount() != evidenceSigners.length
        ) revert RoleWiringMismatch();
        for (uint256 index; index < evidenceSigners.length; ++index) {
            if (evidenceVerifier.signerAt(index) != evidenceSigners[index]) revert RoleWiringMismatch();
        }

        vm.startBroadcast(ownerKey);
        if (vault.owner() != coldOwner) vault.acceptOwnership();
        if (registry.monitor() != monitor) registry.setMonitor(monitor);
        vm.stopBroadcast();

        if (vault.owner() != coldOwner || registry.monitor() != monitor) {
            revert RoleWiringMismatch();
        }

        console2.log("Bond vault owner", vault.owner());
        console2.log("Coverage evidence verifier", address(manager.evidenceVerifier()));
        console2.log("Evidence signer threshold", evidenceVerifier.threshold());
        console2.log("Evidence signer count", evidenceVerifier.signerCount());
        console2.log("Policy registry owner", registry.owner());
        console2.log("Policy registry monitor", registry.monitor());
        console2.log("Relay verifier owner", relay.owner());
        console2.log("Relay signer", relay.trustedSigner());
    }
}
