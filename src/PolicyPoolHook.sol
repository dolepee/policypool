// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Policy, PolicyReasons, PolicyBlocked, InvalidPolicy, NotPolicyOwner, OnlyPoolManager} from "./PolicyTypes.sol";

/// @title PolicyPoolHook
/// @notice A Uniswap v4 beforeSwap hook that lets each pool define max-swap and daily-volume limits.
contract PolicyPoolHook is IHooks {
    using PoolIdLibrary for PoolKey;

    event PolicySet(PoolId indexed poolId, address indexed owner, uint256 maxSwapAmount, uint256 dailyCap);
    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);

    address public immutable POOL_MANAGER;

    mapping(PoolId poolId => Policy policy) public policies;
    mapping(PoolId poolId => address owner) public policyOwner;

    constructor(address poolManager_) {
        POOL_MANAGER = poolManager_;
    }

    /// @notice Human-readable permissions for scripts and README verification.
    function getHookPermissions() external pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    /// @notice Sets or updates policy for a pool. The first caller becomes the pool policy owner.
    /// @dev Deployment scripts should call this immediately after PoolManager.initialize.
    function setPolicy(PoolId poolId, uint256 maxSwapAmount, uint256 dailyCap) external {
        if (maxSwapAmount == 0 || dailyCap == 0 || maxSwapAmount > dailyCap) revert InvalidPolicy();

        address owner = policyOwner[poolId];
        if (owner == address(0)) {
            policyOwner[poolId] = msg.sender;
        } else if (owner != msg.sender) {
            revert NotPolicyOwner();
        }

        policies[poolId] = Policy({
            maxSwapAmount: maxSwapAmount, dailyCap: dailyCap, spentToday: 0, lastResetTimestamp: uint64(block.timestamp)
        });

        emit PolicySet(poolId, policyOwner[poolId], maxSwapAmount, dailyCap);
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != POOL_MANAGER) revert OnlyPoolManager();

        PoolId poolId = key.toId();
        Policy storage policy = policies[poolId];
        if (policy.maxSwapAmount == 0) revert PolicyBlocked(PolicyReasons.POLICY_NOT_SET, 0, 0);
        if (params.amountSpecified >= 0) {
            revert PolicyBlocked(PolicyReasons.EXACT_OUTPUT_NOT_SUPPORTED, uint256(params.amountSpecified), 0);
        }

        uint256 amountIn = uint256(-params.amountSpecified);
        if (amountIn > policy.maxSwapAmount) {
            revert PolicyBlocked(PolicyReasons.MAX_SWAP_EXCEEDED, amountIn, policy.maxSwapAmount);
        }

        uint256 spentToday = policy.spentToday;
        if (block.timestamp > uint256(policy.lastResetTimestamp) + 1 days) {
            spentToday = 0;
            policy.spentToday = 0;
            policy.lastResetTimestamp = uint64(block.timestamp);
        }

        uint256 nextSpent = spentToday + amountIn;
        if (nextSpent > policy.dailyCap) {
            revert PolicyBlocked(PolicyReasons.DAILY_CAP_EXCEEDED, nextSpent, policy.dailyCap);
        }

        policy.spentToday = nextSpent;
        emit SwapAccepted(poolId, sender, amountIn);

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }
}
