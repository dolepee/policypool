// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PolicyReasons, PolicyBlocked, InvalidPolicy, NotPolicyOwner, OnlyPoolManager} from "./PolicyTypes.sol";

/// @notice PolicyPool v2: max-swap covenants can bend only through the trusted surge router.
contract PolicyPoolSurgeHook is IHooks {
    using PoolIdLibrary for PoolKey;

    struct SurgePolicy {
        uint256 maxSwapAmount;
        uint256 dailyCap;
        uint256 spentToday;
        uint64 lastResetTimestamp;
        uint16 surgeRateBps;
    }

    bytes32 internal constant SURGE_INSUFFICIENT = "SURGE_INSUFFICIENT";

    event PolicySet(
        PoolId indexed poolId, address indexed owner, uint256 maxSwapAmount, uint256 dailyCap, uint16 surgeRateBps
    );
    event SwapAccepted(PoolId indexed poolId, address indexed trader, uint256 amountIn);

    address public immutable POOL_MANAGER;
    address public immutable AUTHORIZED_SURGE_ROUTER;

    mapping(PoolId poolId => SurgePolicy policy) public policies;
    mapping(PoolId poolId => address owner) public policyOwner;

    constructor(address poolManager_, address authorizedSurgeRouter_) {
        POOL_MANAGER = poolManager_;
        AUTHORIZED_SURGE_ROUTER = authorizedSurgeRouter_;
    }

    function getHookPermissions() external pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function setPolicy(PoolId poolId, uint256 maxSwapAmount, uint256 dailyCap, uint16 surgeRateBps) external {
        if (maxSwapAmount == 0 || dailyCap == 0 || maxSwapAmount > dailyCap) revert InvalidPolicy();

        address owner = policyOwner[poolId];
        if (owner == address(0)) {
            policyOwner[poolId] = msg.sender;
        } else if (owner != msg.sender) {
            revert NotPolicyOwner();
        }

        policies[poolId] = SurgePolicy({
            maxSwapAmount: maxSwapAmount,
            dailyCap: dailyCap,
            spentToday: 0,
            lastResetTimestamp: uint64(block.timestamp),
            surgeRateBps: surgeRateBps
        });

        emit PolicySet(poolId, policyOwner[poolId], maxSwapAmount, dailyCap, surgeRateBps);
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != POOL_MANAGER) revert OnlyPoolManager();

        PoolId poolId = key.toId();
        SurgePolicy storage policy = policies[poolId];
        if (policy.maxSwapAmount == 0) revert PolicyBlocked(PolicyReasons.POLICY_NOT_SET, 0, 0);
        if (params.amountSpecified >= 0) {
            revert PolicyBlocked(PolicyReasons.EXACT_OUTPUT_NOT_SUPPORTED, uint256(params.amountSpecified), 0);
        }

        uint256 amountIn = uint256(-params.amountSpecified);
        if (amountIn > policy.maxSwapAmount) {
            uint256 surgeAmount = _trustedSurgeAmount(sender, hookData);
            uint256 requiredSurge = ((amountIn - policy.maxSwapAmount) * policy.surgeRateBps) / 10_000;
            if (surgeAmount == 0) {
                revert PolicyBlocked(PolicyReasons.MAX_SWAP_EXCEEDED, amountIn, policy.maxSwapAmount);
            }
            if (surgeAmount < requiredSurge) {
                revert PolicyBlocked(SURGE_INSUFFICIENT, surgeAmount, requiredSurge);
            }
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

    function _trustedSurgeAmount(address sender, bytes calldata hookData) internal view returns (uint256) {
        if (sender != AUTHORIZED_SURGE_ROUTER || hookData.length == 0) return 0;
        return abi.decode(hookData, (uint256));
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
