# Adoption Path

PolicyPool is not trying to replace open Uniswap v4 pools. It creates a second pool class: liquidity with public flow limits that are enforced before swap execution.

## Who Uses This

### New asset launchers

Small teams launching an X Layer asset can seed early liquidity without letting one large exact-input swap consume the whole pool. A covenant can publish:

- maximum swap size;
- rolling daily flow cap;
- the exact Hook that enforces both.

### Treasuries and protocol-owned liquidity

DAOs and protocols can expose liquidity with a public operating envelope instead of relying on private monitoring. Traders see the limits before execution, and the pool enforces them in `beforeSwap`.

### Market makers

Market makers can run strict and loose pools side by side for the same pair. Strict pools can protect shallow inventory; loose pools can serve larger flow. The policy is attached to the pool, not to a hidden backend.

## Why A Hook Is Load-Bearing

A router can choose not to send a trade, but another router can ignore that rule. PolicyPool puts the rule at the pool boundary:

1. A swap reaches the v4 `PoolManager`.
2. `beforeSwap` calls the PolicyPool Hook.
3. The Hook checks the pool covenant.
4. The swap either continues or reverts before liquidity is consumed.

The current proof shows this on X Layer mainnet with two covenants:

- `MAX_SWAP_EXCEEDED`: `5,000 mUSDC` attempted against a `1,000 mUSDC` max-swap covenant.
- `DAILY_CAP_EXCEEDED`: `3,000 mUSDC` attempted against a `2,000 mUSDC` daily-cap covenant.

## Why X Layer

PolicyPool benefits from X Layer because covenant checks are cheap enough to run on every swap, and the network already has the official Uniswap v4 deployment required for real Hook behavior. The proof is not a fork-only demo: it uses X Layer mainnet receipts and a public CI verifier.

## Honest V1 Limits

The hackathon version proves the primitive, not a production deployment process:

- demo assets are mocks so the proof isolates Hook behavior;
- policy ownership is owner-managed;
- there is no slippage covenant, oracle, KYC layer, or per-LP aggregation;
- production pools should use factory-owned policy setup, policy versioning, and optional timelocks or immutable covenants.

Those are implementation hardening steps. The core primitive is already live: pool-level covenants enforced inside Uniswap v4 swap execution.
