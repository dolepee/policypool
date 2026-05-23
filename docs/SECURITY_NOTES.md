# Security Notes

PolicyPool is a focused Hook submission, not a production risk engine. These notes define the v1 trust boundaries and the checks covered by the current test suite.

## Enforced In V1

- Only the configured Uniswap v4 `PoolManager` can call `beforeSwap`.
- The deployed Hook only advertises `BEFORE_SWAP_FLAG`.
- Exact-output swaps are refused.
- Exact-input swaps above `maxSwapAmount` are refused.
- Exact-input swaps that push `spentToday + amountIn` above `dailyCap` are refused.
- Accepted swaps increment `spentToday` before the swap continues.
- Accepted swaps emit `SwapAccepted(poolId, trader, amountIn)`.
- Refused swaps revert with `PolicyBlocked(reason, attempted, limit)`.

## V1 Trust Boundaries

- Policy ownership is owner-managed. The first address to call `setPolicy(poolId, ...)` becomes that pool's policy owner.
- Policy updates are immediate. In v1, updating a policy resets `spentToday` and `lastResetTimestamp`.
- The demo pools are initialized by the deployer for hackathon proof. A production version should bind policy ownership to a factory, governance process, or timelocked pool owner.
- Refused Hook logs do not persist after a revert. `PolicyPoolDemoRouter.swapOrRecord` catches the revert and emits `SwapBlockedCaught` so indexers can display the refusal. The Hook itself still enforces the block inside `beforeSwap`.
- Mock assets are used to isolate Hook behavior from liquidity and token-list risk.

## Not In Scope For V1

- Slippage covenants.
- Oracle checks.
- KYC or compliance lists.
- Per-LP policy aggregation.
- Dynamic fees.
- Production liquidity routing.
- Immutable policy commitments.

## Main Security Assumption

PolicyPool v1 assumes the pool policy owner is trusted to publish and maintain the covenant honestly. The live proof demonstrates Hook enforcement once the covenant is set; it does not claim decentralized governance over policy changes.

## Future Hardening

- Factory-owned pool creation so policy ownership is bound at initialization.
- Optional timelock or freeze for policy updates.
- Event-indexed policy versions, so traders can verify which covenant version applied to each swap.
- Separate immutable pool class for teams that want covenants that cannot change after launch.
