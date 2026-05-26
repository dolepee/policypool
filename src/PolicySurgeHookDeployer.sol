// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PolicyPoolSurgeHook} from "./PolicyPoolSurgeHook.sol";

/// @notice CREATE2 helper for deploying PolicyPoolSurgeHook at a valid v4 hook address.
contract PolicySurgeHookDeployer {
    event HookDeployed(address indexed hook, bytes32 indexed salt, address indexed poolManager, address surgeRouter);

    function deploy(bytes32 salt, address poolManager, address surgeRouter)
        external
        returns (PolicyPoolSurgeHook hook)
    {
        hook = new PolicyPoolSurgeHook{salt: salt}(poolManager, surgeRouter);
        emit HookDeployed(address(hook), salt, poolManager, surgeRouter);
    }

    function computeAddress(bytes32 salt, address poolManager, address surgeRouter) external view returns (address) {
        // forge-lint: disable-start(asm-keccak256)
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(PolicyPoolSurgeHook).creationCode, abi.encode(poolManager, surgeRouter)));
        // forge-lint: disable-end(asm-keccak256)
        return _computeCreate2Address(address(this), salt, initCodeHash);
    }

    function _computeCreate2Address(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
