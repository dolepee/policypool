# Policy Covenant Schema

PolicyPool v1 uses a deliberately small pool-level covenant. It is designed to be easy to verify in code, tests, and the demo.

## Covenant Fields

```solidity
struct Policy {
    uint256 maxSwapAmount;
    uint256 dailyCap;
    uint256 spentToday;
    uint64 lastResetTimestamp;
}
```

## Field Meanings

- `maxSwapAmount`: maximum exact-input amount allowed for one swap.
- `dailyCap`: maximum exact-input amount the pool allows across a rolling 24-hour policy window.
- `spentToday`: amount already accepted during the current policy window.
- `lastResetTimestamp`: timestamp used to reset `spentToday` after one day.

## Reasons

PolicyPool uses `bytes32` reason constants so the Hook revert and router-caught proof event decode cleanly:

- `POLICY_NOT_SET`
- `EXACT_OUTPUT_NOT_SUPPORTED`
- `MAX_SWAP_EXCEEDED`
- `DAILY_CAP_EXCEEDED`

## Important Constraints

- V1 supports exact-input swaps only.
- V1 does not enforce slippage caps.
- V1 does not enforce asset allowlists.
- V1 covenant is per pool, not per LP.
- Refused swaps revert inside the Hook; reverted Hook logs do not persist. The live demo proof uses `PolicyPoolDemoRouter.swapOrRecord` to catch the `PolicyBlocked` revert and emit `SwapBlockedCaught` with the original revert bytes, which the verifier decodes.

## Scope

The covenant belongs to the pool. It tells traders what exact-input flow this pool's liquidity will accept before the swap executes.
