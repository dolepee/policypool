// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";

contract PolicyPoolIntegrationTest is Deployers {
    using PoolIdLibrary for PoolKey;

    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);

    PolicyPoolHook internal hook;
    PoolKey internal looseKey;
    PoolKey internal strictKey;
    PoolId internal loosePoolId;
    PoolId internal strictPoolId;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address hookAddress = address(uint160(Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("PolicyPoolHook.sol:PolicyPoolHook", abi.encode(address(manager)), hookAddress);
        hook = PolicyPoolHook(hookAddress);

        (looseKey, loosePoolId) = initPool(currency0, currency1, IHooks(hookAddress), 3000, 60, SQRT_PRICE_1_1);
        (strictKey, strictPoolId) = initPool(currency0, currency1, IHooks(hookAddress), 10000, 200, SQRT_PRICE_1_1);

        _addLiquidity(looseKey, -120, 120);
        _addLiquidity(strictKey, -200, 200);

        hook.setPolicy(loosePoolId, 10_000 ether, 50_000 ether);
        hook.setPolicy(strictPoolId, 1_000 ether, 2_000 ether);
    }

    function testPoolManagerTriggersHookAndAcceptsLoosePoolSwap() public {
        vm.expectEmit(true, true, false, true, address(hook));
        emit SwapAccepted(loosePoolId, address(swapRouter), 5_000 ether);

        swap(looseKey, true, -int256(5_000 ether), ZERO_BYTES);

        (,, uint256 spentToday,) = hook.policies(loosePoolId);
        assertEq(spentToday, 5_000 ether);
    }

    function testPoolManagerTriggersHookAndRejectsStrictPoolSwap() public {
        vm.expectRevert();
        swap(strictKey, true, -int256(5_000 ether), ZERO_BYTES);

        (,, uint256 spentToday,) = hook.policies(strictPoolId);
        assertEq(spentToday, 0);
    }

    function _addLiquidity(PoolKey memory poolKey, int24 tickLower, int24 tickUpper) internal {
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 1e24, salt: 0}),
            ZERO_BYTES
        );
    }
}
