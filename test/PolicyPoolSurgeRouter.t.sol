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

import {PolicyPoolDemoRouter} from "../src/PolicyPoolDemoRouter.sol";
import {PolicyPoolSurgeHook} from "../src/PolicyPoolSurgeHook.sol";
import {PolicyPoolSurgeRouter} from "../src/PolicyPoolSurgeRouter.sol";

contract PolicyPoolSurgeRouterTest is Deployers {
    using PoolIdLibrary for PoolKey;

    event Donate(PoolId indexed id, address indexed sender, uint256 amount0, uint256 amount1);
    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);
    event SurgeAccepted(address indexed user, PoolId indexed poolId, uint256 surgeAmount);

    PolicyPoolSurgeHook internal hook;
    PolicyPoolSurgeRouter internal surgeRouter;
    PolicyPoolDemoRouter internal untrustedRouter;
    PoolKey internal surgeKey;
    PoolId internal surgePoolId;

    function setUp() public {
        deployFreshManager();
        (currency0, currency1) = deployAndMint2Currencies();

        surgeRouter = new PolicyPoolSurgeRouter(manager);
        untrustedRouter = new PolicyPoolDemoRouter(manager);
        IERC20Minimal(Currency.unwrap(currency0)).approve(address(surgeRouter), type(uint256).max);
        IERC20Minimal(Currency.unwrap(currency1)).approve(address(surgeRouter), type(uint256).max);
        IERC20Minimal(Currency.unwrap(currency0)).approve(address(untrustedRouter), type(uint256).max);
        IERC20Minimal(Currency.unwrap(currency1)).approve(address(untrustedRouter), type(uint256).max);

        address hookAddress = address(uint160(Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "PolicyPoolSurgeHook.sol:PolicyPoolSurgeHook",
            abi.encode(address(manager), address(surgeRouter)),
            hookAddress
        );
        hook = PolicyPoolSurgeHook(hookAddress);

        surgeKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        surgePoolId = surgeKey.toId();

        surgeRouter.initialize(surgeKey, SQRT_PRICE_1_1);
        surgeRouter.modifyLiquidity(
            surgeKey,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e24, salt: 0}),
            ZERO_BYTES
        );
        hook.setPolicy(surgePoolId, 1_000 ether, 10_000 ether, 100);
    }

    function testSurgeRouterDonatesAndSwapsInOneUnlock() public {
        uint256 amountIn = 5_000 ether;
        uint256 surgeAmount = 40 ether;

        vm.expectEmit(true, true, false, true, address(manager));
        emit Donate(surgePoolId, address(surgeRouter), surgeAmount, 0);
        vm.expectEmit(true, true, false, true, address(hook));
        emit SwapAccepted(surgePoolId, address(surgeRouter), amountIn);
        vm.expectEmit(true, true, false, true, address(surgeRouter));
        emit SurgeAccepted(address(this), surgePoolId, surgeAmount);

        surgeRouter.swapWithSurge(surgeKey, _swapParams(amountIn), surgeAmount);

        (,, uint256 spentToday,,) = hook.policies(surgePoolId);
        assertEq(spentToday, amountIn);
    }

    function testTrustedRouterRejectsInsufficientSurge() public {
        (bool ok, bytes memory result) = surgeRouter.swapWithSurgeOrRecord(surgeKey, _swapParams(5_000 ether), 39 ether);

        assertFalse(ok);
        assertGt(result.length, 0);

        (,, uint256 spentToday,,) = hook.policies(surgePoolId);
        assertEq(spentToday, 0);
    }

    function testUntrustedRouterCannotActivateSurgeWithHookData() public {
        (bool ok, bytes memory result) =
            untrustedRouter.swapOrRecord(surgeKey, _swapParams(5_000 ether), abi.encode(40 ether));

        assertFalse(ok);
        assertGt(result.length, 0);

        (,, uint256 spentToday,,) = hook.policies(surgePoolId);
        assertEq(spentToday, 0);
    }

    function testDailyCapStillAppliesToSurgeSwap() public {
        hook.setPolicy(surgePoolId, 1_000 ether, 2_000 ether, 100);

        (bool ok, bytes memory result) = surgeRouter.swapWithSurgeOrRecord(surgeKey, _swapParams(5_000 ether), 40 ether);

        assertFalse(ok);
        assertGt(result.length, 0);

        (,, uint256 spentToday,,) = hook.policies(surgePoolId);
        assertEq(spentToday, 0);
    }

    function _swapParams(uint256 amountIn) internal pure returns (SwapParams memory) {
        // casting is safe in tests because all fixture amounts are far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        return SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT});
    }
}
