// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";
import {PolicyPoolDemoRouter} from "../src/PolicyPoolDemoRouter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Produces the second PolicyPool proof: strict pool accepts up to its daily cap, then refuses the next swap.
contract RunDailyCapProof is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant POLICY_HOOK = 0x7D676FA819D8CDF0A2BB73B944a3533870868080;
    address internal constant DEMO_ROUTER = 0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e;
    address internal constant MOCK_USDC = 0xBb856B7ce87315eaBF1005861B1b321826a6D33c;
    address internal constant MOCK_ETH = 0xEA76c34E0d6d43326c9AB98088536d129242d181;

    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;
    uint256 internal constant USDC = 1e6;
    uint256 internal constant STRICT_SWAP_AMOUNT = 1_000 * USDC;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        PolicyPoolHook hook = PolicyPoolHook(POLICY_HOOK);
        PolicyPoolDemoRouter router = PolicyPoolDemoRouter(DEMO_ROUTER);
        MockUSDC usdc = MockUSDC(MOCK_USDC);
        PoolKey memory strictKey = _strictKey();
        PoolId strictPoolId = strictKey.toId();

        vm.startBroadcast(deployerKey);
        usdc.mint(deployer, 20_000 * USDC);
        usdc.approve(address(router), type(uint256).max);

        // Reset the strict pool window to a known state before proving the daily cap.
        hook.setPolicy(strictPoolId, 1_000 * USDC, 2_000 * USDC);

        router.swap(strictKey, _usdcExactInputSwap(strictKey, STRICT_SWAP_AMOUNT), "");
        router.swap(strictKey, _usdcExactInputSwap(strictKey, STRICT_SWAP_AMOUNT), "");
        (bool thirdOk,) = router.swapOrRecord(strictKey, _usdcExactInputSwap(strictKey, STRICT_SWAP_AMOUNT), "");
        vm.stopBroadcast();

        require(!thirdOk, "third strict-pool swap should be blocked by daily cap");

        console2.log("Daily cap proof complete");
        console2.log("PolicyPoolHook", POLICY_HOOK);
        console2.log("PolicyPoolDemoRouter", DEMO_ROUTER);
        console2.log("Strict pool id");
        console2.logBytes32(PoolId.unwrap(strictPoolId));
    }

    function _strictKey() internal pure returns (PoolKey memory key) {
        (Currency currency0, Currency currency1) = _sort(MOCK_USDC, MOCK_ETH);
        key = PoolKey({
            currency0: currency0, currency1: currency1, fee: 10000, tickSpacing: 200, hooks: IHooks(POLICY_HOOK)
        });
    }

    function _usdcExactInputSwap(PoolKey memory key, uint256 amountIn) internal pure returns (SwapParams memory) {
        bool zeroForOne = Currency.unwrap(key.currency0) == MOCK_USDC;
        // casting is safe because the proof amount is fixed far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amountSpecified = -int256(amountIn);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _sort(address a, address b) internal pure returns (Currency currency0, Currency currency1) {
        return a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }
}
