// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CurrencySettlement} from "./libraries/CurrencySettlement.sol";

/// @notice Minimal demo router for v4 PoolManager calls used by deployment scripts and the one-page demo.
contract PolicyPoolDemoRouter is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencySettlement for *;
    using PoolIdLibrary for PoolKey;

    event SwapBlockedCaught(PoolId indexed poolId, address indexed trader, bytes revertData);

    enum Action {
        ModifyLiquidity,
        Swap
    }

    struct CallbackData {
        Action action;
        address payer;
        PoolKey key;
        ModifyLiquidityParams liquidityParams;
        SwapParams swapParams;
        bytes hookData;
    }

    IPoolManager public immutable MANAGER;

    constructor(IPoolManager manager_) {
        MANAGER = manager_;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick) {
        tick = MANAGER.initialize(key, sqrtPriceX96);
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes memory hookData)
        external
        payable
        returns (BalanceDelta delta)
    {
        bytes memory result = MANAGER.unlock(
            abi.encode(
                CallbackData({
                    action: Action.ModifyLiquidity,
                    payer: msg.sender,
                    key: key,
                    liquidityParams: params,
                    swapParams: SwapParams({zeroForOne: false, amountSpecified: 0, sqrtPriceLimitX96: 0}),
                    hookData: hookData
                })
            )
        );
        delta = abi.decode(result, (BalanceDelta));
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes memory hookData)
        external
        payable
        returns (BalanceDelta delta)
    {
        bytes memory result = MANAGER.unlock(_swapCallbackData(msg.sender, key, params, hookData));
        delta = abi.decode(result, (BalanceDelta));
    }

    function swapOrRecord(PoolKey memory key, SwapParams memory params, bytes memory hookData)
        external
        payable
        returns (bool ok, bytes memory result)
    {
        try MANAGER.unlock(_swapCallbackData(msg.sender, key, params, hookData)) returns (bytes memory data) {
            return (true, data);
        } catch (bytes memory reason) {
            emit SwapBlockedCaught(key.toId(), msg.sender, reason);
            return (false, reason);
        }
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(MANAGER)) revert("only manager");

        CallbackData memory data = abi.decode(rawData, (CallbackData));
        BalanceDelta delta;

        if (data.action == Action.ModifyLiquidity) {
            (delta,) = MANAGER.modifyLiquidity(data.key, data.liquidityParams, data.hookData);
        } else {
            delta = MANAGER.swap(data.key, data.swapParams, data.hookData);
        }

        _settleDelta(data.key, data.payer, delta);
        return abi.encode(delta);
    }

    function _settleDelta(PoolKey memory key, address payer, BalanceDelta delta) internal {
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();

        // BalanceDelta values are int128 in v4, so conversion back to uint128 is bounded.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount0 < 0) key.currency0.settle(MANAGER, payer, uint128(-amount0));
        // BalanceDelta values are int128 in v4, so conversion back to uint128 is bounded.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount1 < 0) key.currency1.settle(MANAGER, payer, uint128(-amount1));
        // BalanceDelta values are int128 in v4, so conversion back to uint128 is bounded.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount0 > 0) key.currency0.take(MANAGER, payer, uint128(amount0));
        // BalanceDelta values are int128 in v4, so conversion back to uint128 is bounded.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount1 > 0) key.currency1.take(MANAGER, payer, uint128(amount1));
    }

    function _swapCallbackData(address payer, PoolKey memory key, SwapParams memory params, bytes memory hookData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            CallbackData({
                action: Action.Swap,
                payer: payer,
                key: key,
                liquidityParams: ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: 0}),
                swapParams: params,
                hookData: hookData
            })
        );
    }
}
