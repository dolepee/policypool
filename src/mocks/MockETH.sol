// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "./MockERC20.sol";

contract MockETH is MockERC20 {
    constructor() MockERC20("Mock ETH", "mETH", 18) {}
}
