// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CurrencySettlement} from "./libraries/CurrencySettlement.sol";

/// @notice Trusted router that pays an LP donation before executing a surge swap.
contract PolicyPoolSurgeRouter is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencySettlement for *;
    using PoolIdLibrary for PoolKey;

    event SurgeAccepted(address indexed user, PoolId indexed poolId, uint256 surgeAmount);
    event SwapBlockedCaught(PoolId indexed poolId, address indexed trader, bytes revertData);

    enum Action {
        ModifyLiquidity,
        SwapWithSurge
    }

    struct CallbackData {
        Action action;
        address payer;
        PoolKey key;
        ModifyLiquidityParams liquidityParams;
        SwapParams swapParams;
        uint256 surgeAmount;
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
                    surgeAmount: 0,
                    hookData: hookData
                })
            )
        );
        delta = abi.decode(result, (BalanceDelta));
    }

    function swapWithSurge(PoolKey memory key, SwapParams memory params, uint256 surgeAmount)
        external
        payable
        returns (BalanceDelta delta)
    {
        bytes memory result = MANAGER.unlock(_surgeCallbackData(msg.sender, key, params, surgeAmount));
        delta = abi.decode(result, (BalanceDelta));
    }

    function swapWithSurgeOrRecord(PoolKey memory key, SwapParams memory params, uint256 surgeAmount)
        external
        payable
        returns (bool ok, bytes memory result)
    {
        try MANAGER.unlock(_surgeCallbackData(msg.sender, key, params, surgeAmount)) returns (bytes memory data) {
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
            if (data.surgeAmount > 0) {
                BalanceDelta donateDelta = MANAGER.donate(data.key, data.surgeAmount, 0, "");
                _settleDelta(data.key, data.payer, donateDelta);
            }

            delta = MANAGER.swap(data.key, data.swapParams, abi.encode(data.surgeAmount));
            _settleDelta(data.key, data.payer, delta);
            emit SurgeAccepted(data.payer, data.key.toId(), data.surgeAmount);
        }

        if (data.action == Action.ModifyLiquidity) {
            _settleDelta(data.key, data.payer, delta);
        }

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

    function _surgeCallbackData(address payer, PoolKey memory key, SwapParams memory params, uint256 surgeAmount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            CallbackData({
                action: Action.SwapWithSurge,
                payer: payer,
                key: key,
                liquidityParams: ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: 0}),
                swapParams: params,
                surgeAmount: surgeAmount,
                hookData: ""
            })
        );
    }
}
