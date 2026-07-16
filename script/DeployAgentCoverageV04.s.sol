// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {CoverageManager} from "../src/CoverageManager.sol";
import {ProviderBondVault} from "../src/ProviderBondVault.sol";
import {OkxA2AClockAdapter} from "../src/adapters/OkxA2AClockAdapter.sol";
import {RelayReceiptVerifier} from "../src/adapters/RelayReceiptVerifier.sol";

contract DeployAgentCoverageV04 is Script {
    address internal constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant OKX_TASK_ESCROW = 0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("POLICYPOOL_V04_OWNER", deployer);
        address identityRegistry = vm.envAddress("OKX_AGENT_IDENTITY_REGISTRY");
        address paymentAsset = vm.envOr("POLICYPOOL_PAYMENT_ASSET", XLAYER_USDT0);
        address taskEscrow = vm.envOr("POLICYPOOL_OKX_TASK_ESCROW", OKX_TASK_ESCROW);
        address relaySigner = vm.envAddress("POLICYPOOL_RELAY_SIGNER_ADDRESS");
        uint256 minimumBondAtomic = vm.envOr("POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC", uint256(500_000));
        uint32 maximumSlaSeconds = uint32(vm.envOr("POLICYPOOL_V04_MAX_SLA_SECONDS", uint256(7 days)));

        vm.startBroadcast(deployerKey);
        ProviderBondVault vault = new ProviderBondVault(paymentAsset, deployer, 8 days);
        AgentPolicyRegistry registry =
            new AgentPolicyRegistry(identityRegistry, address(vault), owner, minimumBondAtomic, maximumSlaSeconds);
        CoverageManager manager = new CoverageManager(address(registry), address(vault), owner);
        OkxA2AClockAdapter a2aAdapter = new OkxA2AClockAdapter(taskEscrow);
        RelayReceiptVerifier relayAdapter = new RelayReceiptVerifier(owner, relaySigner);
        vault.initializeManager(address(manager));
        if (owner != deployer) vault.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("POLICYPOOL_POLICY_REGISTRY_ADDRESS", address(registry));
        console2.log("POLICYPOOL_BOND_VAULT_ADDRESS", address(vault));
        console2.log("POLICYPOOL_COVERAGE_MANAGER_ADDRESS", address(manager));
        console2.log("POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS", address(a2aAdapter));
        console2.log("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS", address(relayAdapter));
        console2.log("Owner", owner);
        if (owner != deployer) console2.log("Bond vault ownership pending acceptance by", owner);
        console2.log("Relay signer", relaySigner);
    }
}
