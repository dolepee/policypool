// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyHookDeployer} from "../src/PolicyHookDeployer.sol";
import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";

contract DeployHook is Script {
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 internal constant ALL_HOOK_MASK = (1 << 14) - 1;

    // Official Uniswap v4 PoolManager for X Layer mainnet, chain 196.
    address internal constant X_LAYER_POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;

    function run() external {
        address poolManager = vm.envOr("POOL_MANAGER", X_LAYER_POOL_MANAGER);
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        PolicyHookDeployer hookDeployer = new PolicyHookDeployer();
        vm.stopBroadcast();

        (bytes32 salt, address hookAddress) = _mineSalt(address(hookDeployer), poolManager);

        vm.startBroadcast(deployerKey);
        PolicyPoolHook hook = hookDeployer.deploy(salt, poolManager);
        vm.stopBroadcast();

        require(address(hook) == hookAddress, "hook address mismatch");
        console2.log("PolicyHookDeployer", address(hookDeployer));
        console2.log("PolicyPoolHook", address(hook));
        console2.logBytes32(salt);
    }

    function _mineSalt(address create2Deployer, address poolManager)
        internal
        pure
        returns (bytes32 salt, address hook)
    {
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(PolicyPoolHook).creationCode, abi.encode(poolManager)));

        for (uint256 i = 0; i < 5_000_000; ++i) {
            salt = bytes32(i);
            hook = _computeCreate2Address(create2Deployer, salt, initCodeHash);
            if ((uint160(hook) & ALL_HOOK_MASK) == BEFORE_SWAP_FLAG) return (salt, hook);
        }

        revert("no hook salt found");
    }

    function _computeCreate2Address(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
