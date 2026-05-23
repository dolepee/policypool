// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";
import {PolicyReasons, PolicyBlocked, InvalidPolicy, NotPolicyOwner, OnlyPoolManager} from "../src/PolicyTypes.sol";

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

contract PolicyPoolHookTest is Test {
    using PoolIdLibrary for PoolKey;

    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);

    address internal constant POOL_MANAGER = address(0xBEEF);
    address internal constant TRADER = address(0xCAFE);
    uint256 internal constant USDC = 1e6;

    PolicyPoolHook internal hook;
    PoolKey internal key;
    PoolId internal poolId;

    function setUp() public {
        hook = new PolicyPoolHook(POOL_MANAGER);
        key = PoolKey({
            currency0: Currency.wrap(address(0x1000)),
            currency1: Currency.wrap(address(0x2000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
    }

    function testSetPolicyStoresOwnerAndLimits() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        assertEq(hook.policyOwner(poolId), address(this));

        (uint256 maxSwapAmount, uint256 dailyCap, uint256 spentToday, uint64 lastResetTimestamp) = hook.policies(poolId);
        assertEq(maxSwapAmount, 1_000 * USDC);
        assertEq(dailyCap, 5_000 * USDC);
        assertEq(spentToday, 0);
        assertEq(lastResetTimestamp, uint64(block.timestamp));
    }

    function testHookPermissionsOnlyUseBeforeSwap() public view {
        Hooks.Permissions memory permissions = hook.getHookPermissions();

        assertTrue(permissions.beforeSwap);
        assertFalse(permissions.beforeInitialize);
        assertFalse(permissions.afterInitialize);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.afterAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
        assertFalse(permissions.afterRemoveLiquidity);
        assertFalse(permissions.afterSwap);
        assertFalse(permissions.beforeDonate);
        assertFalse(permissions.afterDonate);
        assertFalse(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwapReturnDelta);
        assertFalse(permissions.afterAddLiquidityReturnDelta);
        assertFalse(permissions.afterRemoveLiquidityReturnDelta);
    }

    function testRejectsInvalidPolicy() public {
        vm.expectRevert(InvalidPolicy.selector);
        hook.setPolicy(poolId, 0, 1);

        vm.expectRevert(InvalidPolicy.selector);
        hook.setPolicy(poolId, 2, 1);
    }

    function testOnlyPolicyOwnerCanUpdatePolicy() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        vm.prank(address(0xBAD));
        vm.expectRevert(NotPolicyOwner.selector);
        hook.setPolicy(poolId, 1_500 * USDC, 5_000 * USDC);
    }

    function testDirectBeforeSwapCallRejected() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        vm.expectRevert(OnlyPoolManager.selector);
        hook.beforeSwap(TRADER, key, _swapParams(500 * USDC), "");
    }

    function testBeforeSwapAcceptsBelowMaxAndIncrementsDailySpent() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        vm.expectEmit(true, true, false, true);
        emit SwapAccepted(poolId, TRADER, 500 * USDC);

        vm.prank(POOL_MANAGER);
        (bytes4 selector, BeforeSwapDelta delta, uint24 feeOverride) =
            hook.beforeSwap(TRADER, key, _swapParams(500 * USDC), "");

        assertEq(selector, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(delta), BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA));
        assertEq(feeOverride, 0);

        (,, uint256 spentToday,) = hook.policies(poolId);
        assertEq(spentToday, 500 * USDC);
    }

    function testBeforeSwapRejectsWhenPolicyMissing() public {
        vm.prank(POOL_MANAGER);
        vm.expectRevert(abi.encodeWithSelector(PolicyBlocked.selector, PolicyReasons.POLICY_NOT_SET, 0, 0));
        hook.beforeSwap(TRADER, key, _swapParams(500 * USDC), "");
    }

    function testBeforeSwapRejectsExactOutput() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        // casting is safe because the fixture amount is far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 exactOutputAmount = int256(500 * USDC);
        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: exactOutputAmount, sqrtPriceLimitX96: 0});

        vm.prank(POOL_MANAGER);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyBlocked.selector, PolicyReasons.EXACT_OUTPUT_NOT_SUPPORTED, 500 * USDC, 0)
        );
        hook.beforeSwap(TRADER, key, params, "");
    }

    function testBeforeSwapRejectsAboveMaxSwapAmount() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        vm.prank(POOL_MANAGER);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyBlocked.selector, PolicyReasons.MAX_SWAP_EXCEEDED, 5_000 * USDC, 1_000 * USDC)
        );
        hook.beforeSwap(TRADER, key, _swapParams(5_000 * USDC), "");
    }

    function testBeforeSwapAcceptsAtExactMaxSwapAmount() public {
        hook.setPolicy(poolId, 1_000 * USDC, 5_000 * USDC);

        vm.expectEmit(true, true, false, true);
        emit SwapAccepted(poolId, TRADER, 1_000 * USDC);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(1_000 * USDC), "");

        (,, uint256 spentToday,) = hook.policies(poolId);
        assertEq(spentToday, 1_000 * USDC);
    }

    function testBeforeSwapAcceptsAtExactDailyCap() public {
        hook.setPolicy(poolId, 1_000 * USDC, 1_200 * USDC);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(700 * USDC), "");

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(500 * USDC), "");

        (,, uint256 spentToday,) = hook.policies(poolId);
        assertEq(spentToday, 1_200 * USDC);
    }

    function testBeforeSwapRejectsDailyCapOverflow() public {
        hook.setPolicy(poolId, 1_000 * USDC, 1_200 * USDC);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(700 * USDC), "");

        vm.prank(POOL_MANAGER);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyBlocked.selector, PolicyReasons.DAILY_CAP_EXCEEDED, 1_300 * USDC, 1_200 * USDC)
        );
        hook.beforeSwap(TRADER, key, _swapParams(600 * USDC), "");
    }

    function testDailyCapResetsAfterOneDay() public {
        hook.setPolicy(poolId, 1_000 * USDC, 1_200 * USDC);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(1_000 * USDC), "");

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(1_000 * USDC), "");

        (,, uint256 spentToday, uint64 lastResetTimestamp) = hook.policies(poolId);
        assertEq(spentToday, 1_000 * USDC);
        assertEq(lastResetTimestamp, uint64(block.timestamp));
    }

    function testPolicyOwnerUpdateResetsWindow() public {
        hook.setPolicy(poolId, 1_000 * USDC, 1_200 * USDC);

        vm.prank(POOL_MANAGER);
        hook.beforeSwap(TRADER, key, _swapParams(700 * USDC), "");

        vm.warp(block.timestamp + 2 hours);
        hook.setPolicy(poolId, 900 * USDC, 1_500 * USDC);

        (uint256 maxSwapAmount, uint256 dailyCap, uint256 spentToday, uint64 lastResetTimestamp) = hook.policies(poolId);
        assertEq(maxSwapAmount, 900 * USDC);
        assertEq(dailyCap, 1_500 * USDC);
        assertEq(spentToday, 0);
        assertEq(lastResetTimestamp, uint64(block.timestamp));
    }

    function _swapParams(uint256 amountIn) internal pure returns (SwapParams memory) {
        // casting is safe in tests because all fixture amounts are far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        return SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: 0});
    }
}
