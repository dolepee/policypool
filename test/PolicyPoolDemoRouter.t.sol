// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";
import {PolicyPoolDemoRouter} from "../src/PolicyPoolDemoRouter.sol";

contract PolicyPoolDemoRouterTest is Deployers {
    using PoolIdLibrary for PoolKey;

    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);
    event SwapBlockedCaught(PoolId indexed poolId, address indexed trader, bytes revertData);

    PolicyPoolHook internal hook;
    PolicyPoolDemoRouter internal demoRouter;
    PoolKey internal looseKey;
    PoolKey internal strictKey;
    PoolId internal loosePoolId;
    PoolId internal strictPoolId;

    function setUp() public {
        deployFreshManager();
        (currency0, currency1) = deployAndMint2Currencies();

        demoRouter = new PolicyPoolDemoRouter(manager);
        IERC20Minimal(Currency.unwrap(currency0)).approve(address(demoRouter), type(uint256).max);
        IERC20Minimal(Currency.unwrap(currency1)).approve(address(demoRouter), type(uint256).max);

        address hookAddress = address(uint160(Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("PolicyPoolHook.sol:PolicyPoolHook", abi.encode(address(manager)), hookAddress);
        hook = PolicyPoolHook(hookAddress);

        looseKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        strictKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 10000, tickSpacing: 200, hooks: IHooks(hookAddress)
        });
        loosePoolId = looseKey.toId();
        strictPoolId = strictKey.toId();

        demoRouter.initialize(looseKey, SQRT_PRICE_1_1);
        demoRouter.initialize(strictKey, SQRT_PRICE_1_1);

        _addLiquidity(looseKey, -120, 120);
        _addLiquidity(strictKey, -200, 200);

        hook.setPolicy(loosePoolId, 10_000 ether, 50_000 ether);
        hook.setPolicy(strictPoolId, 1_000 ether, 2_000 ether);
    }

    function testDemoRouterAcceptsLoosePoolSwap() public {
        vm.expectEmit(true, true, false, true, address(hook));
        emit SwapAccepted(loosePoolId, address(demoRouter), 5_000 ether);

        demoRouter.swap(
            looseKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(5_000 ether), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            ZERO_BYTES
        );

        (,, uint256 spentToday,) = hook.policies(loosePoolId);
        assertEq(spentToday, 5_000 ether);
    }

    function testDemoRouterRejectsStrictPoolSwap() public {
        vm.expectRevert();
        demoRouter.swap(
            strictKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(5_000 ether), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            ZERO_BYTES
        );

        (,, uint256 spentToday,) = hook.policies(strictPoolId);
        assertEq(spentToday, 0);
    }

    function testDemoRouterCanRecordStrictPoolBlock() public {
        vm.expectEmit(true, true, false, false, address(demoRouter));
        emit SwapBlockedCaught(strictPoolId, address(this), "");

        (bool ok, bytes memory result) = demoRouter.swapOrRecord(
            strictKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(5_000 ether), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            ZERO_BYTES
        );

        assertFalse(ok);
        assertGt(result.length, 0);

        (,, uint256 spentToday,) = hook.policies(strictPoolId);
        assertEq(spentToday, 0);
    }

    function _addLiquidity(PoolKey memory poolKey, int24 tickLower, int24 tickUpper) internal {
        demoRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 1e24, salt: 0}),
            ZERO_BYTES
        );
    }
}
