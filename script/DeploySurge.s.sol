// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {PolicyPoolDemoRouter} from "../src/PolicyPoolDemoRouter.sol";
import {PolicyPoolSurgeHook} from "../src/PolicyPoolSurgeHook.sol";
import {PolicyPoolSurgeRouter} from "../src/PolicyPoolSurgeRouter.sol";
import {PolicySurgeHookDeployer} from "../src/PolicySurgeHookDeployer.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockETH} from "../src/mocks/MockETH.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract DeploySurge is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant X_LAYER_POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address internal constant V1_DEMO_ROUTER = 0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e;
    address internal constant MOCK_USDC = 0xBb856B7ce87315eaBF1005861B1b321826a6D33c;
    address internal constant MOCK_ETH = 0xEA76c34E0d6d43326c9AB98088536d129242d181;

    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 internal constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    uint256 internal constant USDC = 1e6;
    uint256 internal constant SURGE_SWAP_AMOUNT = 5_000 * USDC;
    uint256 internal constant SURGE_AMOUNT = 40 * USDC;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address poolManagerAddress = vm.envOr("POOL_MANAGER", X_LAYER_POOL_MANAGER);

        vm.startBroadcast(deployerKey);
        PolicyPoolSurgeRouter surgeRouter = new PolicyPoolSurgeRouter(IPoolManager(poolManagerAddress));
        PolicySurgeHookDeployer hookDeployer = new PolicySurgeHookDeployer();
        vm.stopBroadcast();

        (bytes32 salt, address hookAddress) = _mineSalt(address(hookDeployer), poolManagerAddress, address(surgeRouter));

        vm.startBroadcast(deployerKey);
        PolicyPoolSurgeHook hook = hookDeployer.deploy(salt, poolManagerAddress, address(surgeRouter));
        MockUSDC(MOCK_USDC).mint(deployer, 1_000_000 * USDC);
        MockETH(MOCK_ETH).mint(deployer, 1_000_000 ether);
        IERC20Minimal(MOCK_USDC).approve(address(surgeRouter), type(uint256).max);
        IERC20Minimal(MOCK_ETH).approve(address(surgeRouter), type(uint256).max);
        IERC20Minimal(MOCK_USDC).approve(V1_DEMO_ROUTER, type(uint256).max);
        IERC20Minimal(MOCK_ETH).approve(V1_DEMO_ROUTER, type(uint256).max);

        (Currency currency0, Currency currency1) = _sort(MOCK_USDC, MOCK_ETH);
        PoolKey memory surgeKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        PoolId surgePoolId = surgeKey.toId();

        surgeRouter.initialize(surgeKey, SQRT_PRICE_1_1);
        surgeRouter.modifyLiquidity(
            surgeKey, ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e24, salt: 0}), ""
        );
        hook.setPolicy(surgePoolId, 1_000 * USDC, 10_000 * USDC, 100);

        surgeRouter.swapWithSurge(surgeKey, _usdcExactInputSwap(surgeKey), SURGE_AMOUNT);
        PolicyPoolDemoRouter(V1_DEMO_ROUTER)
            .swapOrRecord(surgeKey, _usdcExactInputSwap(surgeKey), abi.encode(SURGE_AMOUNT));
        vm.stopBroadcast();

        require(address(hook) == hookAddress, "hook address mismatch");
        console2.log("PolicySurgeHookDeployer", address(hookDeployer));
        console2.log("PolicyPoolSurgeHook", address(hook));
        console2.log("PolicyPoolSurgeRouter", address(surgeRouter));
        console2.log("Surge pool id");
        console2.logBytes32(PoolId.unwrap(surgePoolId));
        console2.log("Hook salt");
        console2.logBytes32(salt);
    }

    function _usdcExactInputSwap(PoolKey memory key) internal pure returns (SwapParams memory) {
        bool zeroForOne = Currency.unwrap(key.currency0) == MOCK_USDC;
        // casting is safe because SURGE_SWAP_AMOUNT is fixed far below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amountSpecified = -int256(SURGE_SWAP_AMOUNT);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _sort(address a, address b) internal pure returns (Currency currency0, Currency currency1) {
        return a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    function _mineSalt(address create2Deployer, address poolManager, address surgeRouter)
        internal
        pure
        returns (bytes32 salt, address hook)
    {
        // forge-lint: disable-start(asm-keccak256)
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(PolicyPoolSurgeHook).creationCode, abi.encode(poolManager, surgeRouter)));
        // forge-lint: disable-end(asm-keccak256)

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
