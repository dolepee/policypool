// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PolicyPoolHook} from "./PolicyPoolHook.sol";

/// @notice CREATE2 helper for deploying PolicyPoolHook at an address with v4 hook permission bits.
contract PolicyHookDeployer {
    event HookDeployed(address indexed hook, bytes32 indexed salt, address indexed poolManager);

    function deploy(bytes32 salt, address poolManager) external returns (PolicyPoolHook hook) {
        hook = new PolicyPoolHook{salt: salt}(poolManager);
        emit HookDeployed(address(hook), salt, poolManager);
    }

    function computeAddress(bytes32 salt, address poolManager) external view returns (address) {
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(PolicyPoolHook).creationCode, abi.encode(poolManager)));
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
