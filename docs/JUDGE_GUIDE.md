# PolicyPool Judge Guide

PolicyPool is a Uniswap v4 Hook on X Layer mainnet that gives each pool a small, public execution covenant. Before a swap executes, the Hook checks whether the order fits that pool's `maxSwapAmount` and `dailyCap`.

The demo question is simple:

> Same trader, same exact-input swap, same Hook. Can two pools enforce different rules?

The live proof answers yes.

## Fast Path

1. Open the app: https://policypool.vercel.app
2. Read the first fold: `Pools that can say no.`
3. Inspect `Proof 01`: loose pool accepts `5,000 mUSDC`; strict pool refuses the same amount.
4. Inspect `Proof 02`: strict pool accepts two `1,000 mUSDC` fills; the third fill is refused by `DAILY_CAP_EXCEEDED`.
5. Run the one-command verifier:

```bash
node scripts/verify-all.mjs
```

It runs formatting, contract build, contract tests, web build, deployment-state verification, and proof-receipt verification.

The same command runs in GitHub Actions, so the public CI badge is also a live-proof signal, not only a local unit-test signal.

6. For a shorter live-only check, run:

```bash
node scripts/verify-live.mjs
```

That command verifies deployed Hook state and the live proof receipts without printing the local Forge build-size table.

7. Or inspect the live checks separately. Verify deployment state:

```bash
node scripts/verify-deployment.mjs
```

8. Verify proof receipts:

```bash
node scripts/verify-proof.mjs
```

Expected result:

```text
✓ loose pool accepts 5,000 mUSDC (5000 mUSDC)
✓ strict pool refuses 5,000 mUSDC by max-swap covenant (MAX_SWAP_EXCEEDED, attempted 5000 mUSDC, limit 1000 mUSDC)
✓ strict pool accepts first 1,000 mUSDC daily-cap fill (1000 mUSDC)
✓ strict pool accepts second 1,000 mUSDC daily-cap fill (1000 mUSDC)
✓ strict pool refuses third 1,000 mUSDC by daily-cap covenant (DAILY_CAP_EXCEEDED, attempted 3000 mUSDC, limit 2000 mUSDC)
PolicyPool proof verified on X Layer.
```

## Scoring Map

| Criterion | What to inspect |
| --- | --- |
| Hook innovation | `PolicyPoolHook.beforeSwap` changes the permission boundary of execution. It does not adjust fees; it lets a pool refuse flow before liquidity is consumed. |
| Market potential | Pool covenants are useful for bounded-flow liquidity: new asset launches, treasuries, market makers, and protocols that want public liquidity constraints instead of private monitoring. See [ADOPTION_PATH.md](ADOPTION_PATH.md). |
| Completion | Hook, router, mock tokens, two v4 pools, policies, accepted/refused swaps, verified contracts, live app, verifier, tests, and CI are all present. |
| X Layer integration | The proof is on X Layer mainnet chain `196` using the official Uniswap v4 `PoolManager` at `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`. |
| Onchain verifiability | `verify-all.mjs` runs local checks and live checks. `verify-deployment.mjs` checks bytecode, Hook permission bits, PoolManager binding, and policy values. `verify-proof.mjs` reads X Layer receipts, decodes accepted events, unwraps v4 `WrappedError`, decodes inner `PolicyBlocked`, and asserts attempted amount versus covenant limit. |
| Code quality | The MVP uses one Hook callback, a narrow policy schema, custom errors, unit tests, local v4 integration tests, and CI that runs the same one-command verifier judges can run locally. |

## Live Addresses

| Artifact | Address |
| --- | --- |
| Uniswap v4 `PoolManager` | [`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`](https://www.oklink.com/x-layer/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32) |
| `PolicyPoolHook` | [`0x7D676FA819D8CDF0A2BB73B944a3533870868080`](https://sourcify.dev/#/lookup/0x7D676FA819D8CDF0A2BB73B944a3533870868080) |
| `PolicyPoolDemoRouter` | [`0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e`](https://sourcify.dev/#/lookup/0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e) |
| `MockUSDC` | [`0xBb856B7ce87315eaBF1005861B1b321826a6D33c`](https://sourcify.dev/#/lookup/0xBb856B7ce87315eaBF1005861B1b321826a6D33c) |
| `MockETH` | [`0xEA76c34E0d6d43326c9AB98088536d129242d181`](https://sourcify.dev/#/lookup/0xEA76c34E0d6d43326c9AB98088536d129242d181) |

All project contracts above are verified on Sourcify with exact matches.

## Live Proof Transactions

| Proof | Tx |
| --- | --- |
| Loose pool accepted `5,000 mUSDC` | [`0x1ee4...3396`](https://www.oklink.com/x-layer/tx/0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396) |
| Strict pool refused same `5,000 mUSDC` with `MAX_SWAP_EXCEEDED` | [`0xbc20...435a`](https://www.oklink.com/x-layer/tx/0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a) |
| Strict pool accepted first `1,000 mUSDC` daily-cap fill | [`0x2a26...f178`](https://www.oklink.com/x-layer/tx/0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178) |
| Strict pool accepted second `1,000 mUSDC` daily-cap fill | [`0xc608...292b`](https://www.oklink.com/x-layer/tx/0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b) |
| Strict pool refused third `1,000 mUSDC` fill with `DAILY_CAP_EXCEEDED` | [`0x7113...771c`](https://www.oklink.com/x-layer/tx/0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c) |

## Fresh Clone Verification

```bash
git clone --recurse-submodules https://github.com/dolepee/policypool.git
cd policypool
git submodule update --init --recursive
forge build
forge test -vv
node scripts/verify-all.mjs
node scripts/verify-live.mjs
node scripts/verify-deployment.mjs
node scripts/verify-proof.mjs
npm run build --prefix web
```

## What Is Intentionally Not Claimed

- No slippage covenant in v1.
- No oracle dependency.
- No KYC or compliance layer.
- No per-LP policy aggregation.
- No governance or DAO voting.
- No production DEX claim.
- No claim that reverted Hook logs persist. Refused swaps revert in `beforeSwap`; the demo router catches the revert and emits `SwapBlockedCaught` so the refusal is easy to index.

## Reviewer Questions

### Is this only a router-level block?

No. The Hook rejects inside `beforeSwap` before the v4 pool consumes liquidity. The demo router only catches the revert and emits `SwapBlockedCaught` because logs emitted during a reverted Hook call do not persist onchain.

### Can another router bypass the policy?

Not for these pools. Any swap routed through the v4 `PoolManager` for a pool using this Hook must pass the Hook's `beforeSwap` callback. A different router can choose whether to send flow, but it cannot make this pool ignore its covenant.

### Why use mock assets?

The hackathon asks for a v4 Pool and Hook on X Layer with Hook behavior triggered by real transactions. Mock assets isolate the Hook mechanism from liquidity sourcing and token-market noise. The proof is about whether the pool covenant is enforced before execution.

### Is this a dynamic fee Hook?

No. Dynamic fee Hooks still let the swap execute at a different price. PolicyPool changes the execution boundary: a pool can refuse flow entirely before liquidity is consumed.

### What would need hardening after the hackathon?

Factory-owned policy setup, optional immutable or timelocked covenants, real asset pools, and a production deployment process. Those are adoption hardening steps, not requirements for proving the Hook primitive.

## Why The Demo Uses Mock Assets

The hackathon requirement is a deployed Uniswap v4 Pool and Hook on X Layer with Hook behavior triggered by real transactions. PolicyPool uses mock assets so the proof focuses on Hook semantics, not asset liquidity. The pool covenant logic is independent of the token pair.

## Core Takeaway

PolicyPool is not another dynamic fee Hook. It is a pool-level covenant primitive: liquidity can publish what flow it will accept, and the Hook enforces that promise before execution.
