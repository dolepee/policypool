# PolicyPool Judge Guide

PolicyPool is a Uniswap v4 Hook on X Layer mainnet that gives each pool a small, public execution covenant. Before a swap executes, the Hook checks whether the order fits that pool's `maxSwapAmount` and `dailyCap`. PolicyPool Surge adds a trusted router that can bend the max-swap covenant only by donating a surge fee to LPs inside the same v4 unlock.

The proof question is simple:

> Same exact-input order, different pool policy. Can the pool enforce a different onchain outcome before swap execution?

The live proof answers yes.

The Surge proof adds the LP-capture question:

> If a trader wants past the cap, can the pool get paid in the same v4 transaction?

The live proof answers yes through `PoolManager.Donate` plus `SurgeAccepted` in one tx.

## Fast Path

1. Open the app: https://policypool.vercel.app
2. Read the first fold: `Policy bends. LPs get paid.`
3. Inspect the featured Surge proof: the trusted router donates `40 mUSDC` to LPs, then executes the `5,000 mUSDC` swap in the same v4 unlock.
4. Inspect the spoof-guard proof: the old router cannot activate Surge with fake `hookData`.
5. Inspect the V1 covenant proofs: loose pool accepts `5,000 mUSDC`; strict pool refuses the same exact-input amount; strict pool accepts two `1,000 mUSDC` fills and refuses the third with `DAILY_CAP_EXCEEDED`.
6. Run the one-command verifier:

```bash
node scripts/verify-all.mjs
```

It runs formatting, contract build, contract tests, web build, deployment-state verification, and proof-receipt verification.

The same command runs in GitHub Actions, so the public CI badge is also a live-proof signal, not only a local unit-test signal.

7. For a shorter live-only check, run:

```bash
node scripts/verify-live.mjs
```

That command verifies deployed Hook state and the live proof receipts without printing the local Forge build-size table.

8. Or inspect the live checks separately. Verify deployment state:

```bash
node scripts/verify-deployment.mjs
```

9. Verify proof receipts:

```bash
node scripts/verify-proof.mjs
node scripts/verify-surge.mjs
```

Expected result:

```text
✓ loose pool accepts 5,000 mUSDC (5000 mUSDC)
✓ strict pool refuses 5,000 mUSDC by max-swap covenant (MAX_SWAP_EXCEEDED, attempted 5000 mUSDC, limit 1000 mUSDC)
✓ strict pool accepts first 1,000 mUSDC daily-cap fill (1000 mUSDC)
✓ strict pool accepts second 1,000 mUSDC daily-cap fill (1000 mUSDC)
✓ strict pool refuses third 1,000 mUSDC by daily-cap covenant (DAILY_CAP_EXCEEDED, attempted 3000 mUSDC, limit 2000 mUSDC)
PolicyPool proof verified on X Layer.
✓ surge hook deployment and policy verified
✓ surge swap donated 40 mUSDC and executed 5,000 mUSDC in one tx
✓ untrusted router hookData falls back to V1 max-swap refusal
PolicyPool Surge proof verified on X Layer.
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

For an invariant-by-invariant review path, see [HOOK_INVARIANTS.md](HOOK_INVARIANTS.md).

## Live Addresses

| Artifact | Address |
| --- | --- |
| Uniswap v4 `PoolManager` | [`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`](https://www.oklink.com/x-layer/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32) |
| `PolicyPoolHook` | [`0x7D676FA819D8CDF0A2BB73B944a3533870868080`](https://sourcify.dev/#/lookup/0x7D676FA819D8CDF0A2BB73B944a3533870868080) |
| `PolicyPoolDemoRouter` | [`0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e`](https://sourcify.dev/#/lookup/0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e) |
| `MockUSDC` | [`0xBb856B7ce87315eaBF1005861B1b321826a6D33c`](https://sourcify.dev/#/lookup/0xBb856B7ce87315eaBF1005861B1b321826a6D33c) |
| `MockETH` | [`0xEA76c34E0d6d43326c9AB98088536d129242d181`](https://sourcify.dev/#/lookup/0xEA76c34E0d6d43326c9AB98088536d129242d181) |
| `PolicyPoolSurgeHook` | [`0xf44d9C1f9efF1231E53C60EDB9A73761aa99c080`](https://sourcify.dev/#/lookup/0xf44d9C1f9efF1231E53C60EDB9A73761aa99c080) |
| `PolicyPoolSurgeRouter` | [`0xd05AAD5b86f6FFCc10872803bEdb5fa911e0E1fD`](https://sourcify.dev/#/lookup/0xd05AAD5b86f6FFCc10872803bEdb5fa911e0E1fD) |

The V1 and Surge contracts are verified on Sourcify with exact matches. The live Surge receipts are also checked by `scripts/verify-surge.mjs`.

## Live Proof Transactions

| Proof | Tx |
| --- | --- |
| Loose pool accepted `5,000 mUSDC` | [`0x1ee4...3396`](https://www.oklink.com/x-layer/tx/0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396) |
| Strict pool refused same `5,000 mUSDC` with `MAX_SWAP_EXCEEDED` | [`0xbc20...435a`](https://www.oklink.com/x-layer/tx/0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a) |
| Strict pool accepted first `1,000 mUSDC` daily-cap fill | [`0x2a26...f178`](https://www.oklink.com/x-layer/tx/0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178) |
| Strict pool accepted second `1,000 mUSDC` daily-cap fill | [`0xc608...292b`](https://www.oklink.com/x-layer/tx/0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b) |
| Strict pool refused third `1,000 mUSDC` fill with `DAILY_CAP_EXCEEDED` | [`0x7113...771c`](https://www.oklink.com/x-layer/tx/0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c) |
| Surge router donated `40 mUSDC` and executed `5,000 mUSDC` | [`0x1809...a9a8`](https://www.oklink.com/x-layer/tx/0x18096b74138d43a6683f1c914e7aa83633c8ed0ba6a533cf6e7e939f5f7ea9a8) |
| Old router could not spoof Surge with hookData | [`0x4877...843a`](https://www.oklink.com/x-layer/tx/0x4877a6cf2214148d8ba0b3ca7d036da1cde7e35a33eeaaf79718f3e54ee4843a) |

## Fresh Clone Verification

```bash
git clone https://github.com/dolepee/policypool.git
cd policypool
git submodule update --init --depth=1 lib/forge-std lib/v4-core
git -C lib/v4-core submodule update --init --depth=1 lib/solmate lib/openzeppelin-contracts
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

## Why The Proof Uses Mock Assets

The hackathon requirement is a deployed Uniswap v4 Pool and Hook on X Layer with Hook behavior triggered by real transactions. PolicyPool uses mock assets so the proof focuses on Hook semantics, not asset liquidity. The pool covenant logic is independent of the token pair.

## Core Takeaway

PolicyPool is not another dynamic fee Hook. It is a pool-level covenant primitive: liquidity can publish what flow it will accept, and the Hook enforces that promise before execution.
