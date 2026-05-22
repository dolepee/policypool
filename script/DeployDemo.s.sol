// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {PolicyHookDeployer} from "../src/PolicyHookDeployer.sol";
import {PolicyPoolHook} from "../src/PolicyPoolHook.sol";
import {PolicyPoolDemoRouter} from "../src/PolicyPoolDemoRouter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockETH} from "../src/mocks/MockETH.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract DeployDemo is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant X_LAYER_POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 internal constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    uint256 internal constant USDC = 1e6;
    uint256 internal constant DEMO_SWAP_AMOUNT = 5_000 * USDC;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address poolManagerAddress = vm.envOr("POOL_MANAGER", X_LAYER_POOL_MANAGER);

        vm.startBroadcast(deployerKey);
        PolicyHookDeployer hookDeployer = new PolicyHookDeployer();
        vm.stopBroadcast();

        (bytes32 salt, address hookAddress) = _mineSalt(address(hookDeployer), poolManagerAddress);

        vm.startBroadcast(deployerKey);
        PolicyPoolHook hook = hookDeployer.deploy(salt, poolManagerAddress);
        PolicyPoolDemoRouter router = new PolicyPoolDemoRouter(IPoolManager(poolManagerAddress));
        MockUSDC usdc = new MockUSDC();
        MockETH mockEth = new MockETH();

        usdc.mint(deployer, 100_000_000 * USDC);
        mockEth.mint(deployer, 100_000 ether);
        usdc.approve(address(router), type(uint256).max);
        mockEth.approve(address(router), type(uint256).max);

        (Currency currency0, Currency currency1) = _sort(address(usdc), address(mockEth));

        PoolKey memory looseKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        PoolKey memory strictKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 10000, tickSpacing: 200, hooks: IHooks(hookAddress)
        });

        router.initialize(looseKey, SQRT_PRICE_1_1);
        router.initialize(strictKey, SQRT_PRICE_1_1);

        router.modifyLiquidity(
            looseKey, ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e24, salt: 0}), ""
        );
        router.modifyLiquidity(
            strictKey, ModifyLiquidityParams({tickLower: -200, tickUpper: 200, liquidityDelta: 1e24, salt: 0}), ""
        );

        PoolId loosePoolId = looseKey.toId();
        PoolId strictPoolId = strictKey.toId();
        hook.setPolicy(loosePoolId, 10_000 * USDC, 50_000 * USDC);
        hook.setPolicy(strictPoolId, 1_000 * USDC, 2_000 * USDC);

        SwapParams memory demoSwap = _usdcExactInputSwap(address(usdc), looseKey);
        router.swap(looseKey, demoSwap, "");
        router.swapOrRecord(strictKey, _usdcExactInputSwap(address(usdc), strictKey), "");
        vm.stopBroadcast();

        console2.log("PolicyHookDeployer", address(hookDeployer));
        console2.log("PolicyPoolHook", address(hook));
        console2.log("PolicyPoolDemoRouter", address(router));
        console2.log("MockUSDC", address(usdc));
        console2.log("MockETH", address(mockEth));
        console2.log("Loose pool fee", looseKey.fee);
        console2.logInt(looseKey.tickSpacing);
        console2.log("Strict pool fee", strictKey.fee);
        console2.logInt(strictKey.tickSpacing);
        console2.log("Loose pool id");
        console2.logBytes32(PoolId.unwrap(loosePoolId));
        console2.log("Strict pool id");
        console2.logBytes32(PoolId.unwrap(strictPoolId));
        console2.log("Hook salt");
        console2.logBytes32(salt);
    }

    function _usdcExactInputSwap(address usdc, PoolKey memory key) internal pure returns (SwapParams memory) {
        bool zeroForOne = Currency.unwrap(key.currency0) == usdc;
        // casting is safe because DEMO_SWAP_AMOUNT is fixed far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amountSpecified = -int256(DEMO_SWAP_AMOUNT);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _sort(address a, address b) internal pure returns (Currency currency0, Currency currency1) {
        return a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    function _mineSalt(address create2Deployer, address poolManager)
        internal
        pure
        returns (bytes32 salt, address hook)
    {
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
