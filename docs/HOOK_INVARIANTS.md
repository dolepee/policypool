# Hook Invariants

This file maps PolicyPool's v1 invariants to the code path, test coverage, and live X Layer proof. It is intentionally narrow: the deployed Hook proves pool-level max-swap and daily-cap covenants for exact-input swaps.

## Core Invariant

For any pool using `PolicyPoolHook`, a swap can only consume liquidity if the pool's covenant accepts the requested exact-input amount.

The covenant check happens in `PolicyPoolHook.beforeSwap` before Uniswap v4 continues swap execution.

## Invariant Matrix

| Invariant | Enforcement point | Local proof | Live proof |
| --- | --- | --- | --- |
| Only the configured v4 `PoolManager` can call `beforeSwap`. | `if (msg.sender != POOL_MANAGER) revert OnlyPoolManager();` | `testDirectBeforeSwapCallRejected` | `verify-deployment.mjs` confirms the deployed Hook is bound to X Layer `PoolManager`. |
| The deployed Hook advertises only `BEFORE_SWAP_FLAG`. | Hook address bits plus `getHookPermissions()` | `testHookPermissionsOnlyUseBeforeSwap` | `verify-deployment.mjs` checks address bits and `getHookPermissions()`. |
| Pools without a policy cannot consume liquidity through this Hook. | `POLICY_NOT_SET` branch in `beforeSwap` | `testBeforeSwapRejectsWhenPolicyMissing` | Covered locally; demo pools are proven to have policies onchain. |
| Exact-output swaps are not supported in v1. | `EXACT_OUTPUT_NOT_SUPPORTED` branch in `beforeSwap` | `testBeforeSwapRejectsExactOutput` | Not used in live demo; intentionally documented as a v1 limit. |
| Exact-input swaps above `maxSwapAmount` are refused. | `MAX_SWAP_EXCEEDED` branch in `beforeSwap` | `testBeforeSwapRejectsAboveMaxSwapAmount` and integration strict-pool rejection | Strict pool refused `5,000 mUSDC` against `1,000 mUSDC` max: `0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a`. |
| Exact-input swaps at `maxSwapAmount` are accepted. | `amountIn > maxSwapAmount`, not `>=` | `testBeforeSwapAcceptsAtExactMaxSwapAmount` | Loose pool accepted `5,000 mUSDC` under `10,000 mUSDC` max: `0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396`. |
| Swaps that push `spentToday + amountIn` above `dailyCap` are refused. | `DAILY_CAP_EXCEEDED` branch in `beforeSwap` | `testBeforeSwapRejectsDailyCapOverflow` | Strict pool refused third daily fill at `3,000 mUSDC` attempted against `2,000 mUSDC` cap: `0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c`. |
| Swaps exactly at `dailyCap` are accepted. | `nextSpent > dailyCap`, not `>=` | `testBeforeSwapAcceptsAtExactDailyCap` | Strict pool accepted first two `1,000 mUSDC` fills before refusing the third. |
| Accepted swaps increment `spentToday` before the swap continues. | `policy.spentToday = nextSpent` before returning selector | `testBeforeSwapAcceptsBelowMaxAndIncrementsDailySpent` | Daily-cap proof depends on the first two accepted fills carrying forward into the third refusal. |
| Refused swaps do not increment `spentToday`. | Revert before storage update | strict-pool rejection tests assert `spentToday == 0` after refusal | `verify-proof.mjs` decodes the caught refusal and asserts attempted amount and covenant limit. |
| Refused Hook logs do not need to persist. | Demo router catches the revert and emits `SwapBlockedCaught` | `testDemoRouterCanRecordStrictPoolBlock` | Refused proof txs are successful router transactions that record the original `PolicyBlocked` revert bytes. |

## What The Live Verifier Checks

`node scripts/verify-live.mjs` runs:

1. `scripts/verify-deployment.mjs`
   - chain id is X Layer mainnet `196`;
   - `PoolManager`, Hook, demo router, and mock token bytecode exist;
   - Hook address permission bits equal `BEFORE_SWAP_FLAG`;
   - Hook is bound to the official X Layer `PoolManager`;
   - `getHookPermissions()` exposes only `beforeSwap`;
   - loose and strict pool policies match the documented limits.
2. `scripts/verify-proof.mjs`
   - accepted swap receipts include `SwapAccepted`;
   - refused swap receipts include `SwapBlockedCaught`;
   - v4 `WrappedError` is unwrapped;
   - inner `PolicyBlocked` reason, attempted amount, and limit are decoded and asserted.

## Trust Boundary

PolicyPool v1 proves enforcement after a policy is set. Policy ownership is owner-managed in the hackathon deployment. A production version should bind policy setup to a factory, optionally add policy versioning, and support immutable or timelocked covenants.

## Non-Claims

PolicyPool v1 does not claim slippage covenants, oracle checks, KYC, compliance gating, per-LP aggregation, or production DEX readiness. Those are separate mechanisms. The primitive proven here is pool-level flow refusal inside Uniswap v4 swap execution.
