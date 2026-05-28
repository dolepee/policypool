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

- Policy ownership is owner-managed. The first address to call `setPolicy(poolId, ...)` becomes that pool's policy owner. The deployer EOA that won this race for the live pools is the address visible in each pool's `PolicySet` event on X Layer; `verify-deployment.mjs` and `verify-surge.mjs` log the resolved owner so judges can cross-reference it against the deployment tx history.
- Policy updates are immediate. In v1, updating a policy resets `spentToday` and `lastResetTimestamp`. Owners can therefore refresh the daily counter mid-window. This is documented as an owner-trusted behavior in v1; a production version should require timelocked changes or distinguish between cap-raises and counter-resets.
- The demo pools are initialized by the deployer for hackathon proof. A production version should bind policy ownership to a factory, governance process, or timelocked pool owner.
- Refused Hook logs do not persist after a revert. `PolicyPoolDemoRouter.swapOrRecord` catches the revert and emits `SwapBlockedCaught` so indexers can display the refusal. The Hook itself still enforces the block inside `beforeSwap`.
- Mock assets are used to isolate Hook behavior from liquidity and token-list risk.
- `PolicyPoolSurgeRouter.SurgeAccepted` is emitted for any `swapWithSurge` action, including calls with `surgeAmount = 0`. Indexers should filter by non-zero `surgeAmount` to count actual surge overrides; the `PoolManager.Donate` log is the canonical signal that a surge fee was paid.

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

For the invariant-by-invariant test and live-proof map, see [HOOK_INVARIANTS.md](HOOK_INVARIANTS.md).

## Future Hardening

- Factory-owned pool creation so policy ownership is bound at initialization.
- Optional timelock or freeze for policy updates.
- Event-indexed policy versions, so traders can verify which covenant version applied to each swap.
- Separate immutable pool class for teams that want covenants that cannot change after launch.
