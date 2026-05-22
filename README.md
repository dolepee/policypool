# PolicyPool

PolicyPool is a Uniswap v4 Hook where each pool defines its own swap size and daily volume policy. Same trader, same intent, two pools: one accepts, one refuses, both verifiable on X Layer.

Built for the OKX X Layer Hook the Future hackathon.

## MVP Scope

PolicyPool keeps the first submission deliberately narrow:

- One Hook: `PolicyPoolHook.sol`
- One policy schema: `maxSwapAmount`, `dailyCap`, `spentToday`, `lastResetTimestamp`
- One callback: `beforeSwap`
- One pair for the demo: `MockUSDC / MockETH`
- Two v4 pools using the same Hook but different fee tiers, so they have different `PoolId`s
- One binary proof: a `5,000 mUSDC` exact-input swap passes the loose pool and fails the strict pool

Cut from v1: slippage caps, asset allowlists, per-LP policy aggregation, governance, oracle checks, Pyth, and frontend swap execution.

## Why This Is A Hook

Standard v4 pools accept any valid swap against available liquidity. PolicyPool moves one decision into the pool itself: before the swap executes, the pool checks whether the trader's requested input fits its own policy.

If the swap fits:

- `beforeSwap` returns successfully
- the Hook emits `SwapAccepted(poolId, trader, amountIn)`
- the v4 swap continues

If the swap breaks policy:

- `beforeSwap` reverts with `PolicyBlocked(reason, attempted, limit)`
- no `SwapAccepted` event is emitted
- the v4 swap does not execute

Reverted logs do not persist onchain, so `PolicyPoolDemoRouter.swapOrRecord` can catch a failed strict-pool swap and emit `SwapBlockedCaught`. The Hook still enforces the refusal inside `beforeSwap`; the router event only makes the demo/indexer proof cleaner.

## File Structure

```text
src/
  PolicyPoolHook.sol       # beforeSwap policy enforcement
  PolicyPoolDemoRouter.sol # minimal PoolManager adapter for demo liquidity/swaps
  PolicyHookDeployer.sol   # CREATE2 helper for valid v4 Hook address bits
  PolicyTypes.sol          # Policy struct, reasons, errors
  mocks/
    MockERC20.sol
    MockUSDC.sol
    MockETH.sol
script/
  DeployHook.s.sol         # mines BEFORE_SWAP hook address and deploys hook
  DeployDemo.s.sol         # deploys hook, router, mocks, pools, policies, demo swaps
test/
  PolicyPoolHook.t.sol     # policy unit tests
  PolicyPoolDemoRouter.t.sol # demo router tests
  PolicyPoolIntegration.t.sol # local v4 PoolManager integration tests
docs/
  POLICY_SCHEMA.md
  DEPLOYMENT_PLAN.md
web/
  index.html               # static judge/demo page shell
```

## Hook Callback Plan

`PolicyPoolHook` implements `IHooks` directly. This v4-periphery checkout does not include `BaseHook`, so the contract exposes every required callback and only mutates state in `beforeSwap`.

Callback used:

- `beforeSwap(address sender, PoolKey key, SwapParams params, bytes hookData)`

Callback behavior:

1. Require caller is the configured Uniswap v4 `PoolManager`.
2. Compute `poolId = key.toId()`.
3. Load policy for the pool.
4. Reject missing policy.
5. Reject exact-output swaps.
6. Convert negative `amountSpecified` into exact-input `amountIn`.
7. Reject if `amountIn > maxSwapAmount`.
8. Reset `spentToday` if the 24-hour window elapsed.
9. Reject if `spentToday + amountIn > dailyCap`.
10. Increment `spentToday`.
11. Emit `SwapAccepted`.
12. Return `IHooks.beforeSwap.selector`.

## X Layer v4 Deployment Plan

Official Uniswap v4 deployment docs list X Layer mainnet chain `196` with:

- `PoolManager`: `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`
- `PositionManager`: `0xCF1Eafc6928DC385A342E7C6491D371D2871458b`
- `StateView`: `0x76fd297E2D437cd7f76d50F01aFE6160f86e9990`
- `Permit2`: `0x000000000022D473030F116dDEE9F6B43aC78BA3`

Source: https://developers.uniswap.org/docs/protocols/v4/deployments

Deployment steps:

1. Deploy `PolicyHookDeployer`.
2. Mine a salt so the Hook address has only `BEFORE_SWAP_FLAG` set in the lower 14 bits.
3. Deploy `PolicyPoolHook` through `PolicyHookDeployer`.
4. Deploy `PolicyPoolDemoRouter`.
5. Deploy `MockUSDC` and `MockETH`.
6. Initialize two v4 pools against the same Hook:
   - Loose pool: fee `3000`, tick spacing `60`
   - Strict pool: fee `10000`, tick spacing `200`
7. Set policies:
   - Loose: `maxSwapAmount = 10,000 mUSDC`, `dailyCap = 50,000 mUSDC`
   - Strict: `maxSwapAmount = 1,000 mUSDC`, `dailyCap = 2,000 mUSDC`
8. Add small demo liquidity to both pools.
9. Run the same `5,000 mUSDC` exact-input swap against both.

## Commands

```bash
forge build
forge test -vv
```

Deploy Hook on X Layer mainnet:

```bash
POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 \
PRIVATE_KEY=... \
forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url https://rpc.xlayer.tech \
  --broadcast
```

Full demo deploy on X Layer:

```bash
POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 \
PRIVATE_KEY=... \
forge script script/DeployDemo.s.sol:DeployDemo \
  --rpc-url https://rpc.xlayer.tech \
  --broadcast
```

## Test Coverage

Current tests cover:

- policy storage and owner assignment
- invalid policy rejection
- owner-only policy update
- direct `beforeSwap` call protection
- missing policy rejection
- exact-output rejection
- max-swap rejection
- daily-cap rejection
- daily-cap reset after 24 hours
- local v4 PoolManager triggering `beforeSwap`
- loose pool accepted swap through v4 test router
- strict pool rejected swap through v4 test router
- demo router accepted swap
- demo router caught strict-pool refusal and emitted `SwapBlockedCaught`

## Demo Video Structure

This is the public structure, not a private recording script:

1. Show two pool cards: loose and strict.
2. Show the same `5,000 mUSDC` swap sent to the loose pool.
3. Show success tx and `SwapAccepted`.
4. Show the same swap sent to the strict pool.
5. Show `SwapBlockedCaught` after the Hook rejects with `PolicyBlocked("MAX_SWAP_EXCEEDED", 5000e6, 1000e6)`.
6. Close on X Layer explorer links and the 20-line `beforeSwap` policy check.

Target length: 90 to 120 seconds.

## Current Status

- Hook contract: implemented
- Mock tokens: implemented
- Policy unit tests: passing
- Local v4 integration tests: passing
- Hook deploy script: implemented
- Demo deploy script: implemented
- Pool initialization / liquidity scripts: implemented in `DeployDemo.s.sol`
- Static frontend shell: implemented
- X Layer deployment: pending
- Proof txs: pending
