// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockAgentIdentityRegistry {
    mapping(uint256 agentId => address owner) public ownerOf;

    function setOwner(uint256 agentId, address owner) external {
        ownerOf[agentId] = owner;
    }
}
