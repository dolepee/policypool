# Policy Schema

PolicyPool v1 uses a deliberately small pool-level policy. It is designed to be easy to verify in code, tests, and the demo.

## Policy Fields

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

PolicyPool uses `bytes32` reason constants so failed txs decode cleanly:

- `POLICY_NOT_SET`
- `EXACT_OUTPUT_NOT_SUPPORTED`
- `MAX_SWAP_EXCEEDED`
- `DAILY_CAP_EXCEEDED`

## Important Constraints

- V1 supports exact-input swaps only.
- V1 does not enforce slippage caps.
- V1 does not enforce asset allowlists.
- V1 policy is per pool, not per LP.
- Refused swaps revert; reverted hook logs do not persist. The refused proof is the failed tx and decoded custom error.
