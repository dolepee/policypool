# Deployment Plan

PolicyPool must deploy one valid Uniswap v4 Hook and at least one v4 pool on X Layer. The target demo uses two pools to create the binary moment.

## Network

Primary network:

- X Layer mainnet, chain `196`
- PoolManager: `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`

Fallback:

- If mainnet funding or verification blocks progress, deploy the same contracts on the X Layer network accepted by the hackathon form, then document that choice explicitly.

## Contracts

1. `PolicyHookDeployer`
2. `PolicyPoolHook`
3. `PolicyPoolDemoRouter`
4. `MockUSDC`
5. `MockETH`

## Hook Address Requirement

Uniswap v4 decides which callbacks to invoke by reading the Hook contract address bits. PolicyPool uses only `BEFORE_SWAP_FLAG`, so the deployed Hook address must satisfy:

```text
uint160(hook) & ((1 << 14) - 1) == (1 << 7)
```

`script/DeployHook.s.sol` deploys `PolicyHookDeployer`, mines a salt, then deploys `PolicyPoolHook` through CREATE2.

## Pool Plan

Both pools use:

- pair: `MockUSDC / MockETH`
- hook: `PolicyPoolHook`

Loose pool:

- fee: `3000`
- tick spacing: `60`
- max swap: `10,000 mUSDC`
- daily cap: `50,000 mUSDC`

Strict pool:

- fee: `10000`
- tick spacing: `200`
- max swap: `1,000 mUSDC`
- daily cap: `2,000 mUSDC`

Different fee and tick spacing produce different `PoolId`s for the same pair and Hook.

## Proof Targets

The submission needs these proof links:

- verified `PolicyPoolHook` contract
- verified `PolicyHookDeployer` contract
- two PoolManager `Initialize` txs
- one accepted swap tx against the loose pool
- one `swapOrRecord` tx against the strict pool that emits `SwapBlockedCaught` after `PolicyBlocked`

## Commands

```bash
forge build
forge test -vv
cp .env.example .env
```

Hook deploy:

```bash
POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 \
PRIVATE_KEY=... \
forge script script/DeployHook.s.sol:DeployHook \
  --rpc-url $XLAYER_RPC_URL \
  --broadcast
```

Full demo deploy:

```bash
POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 \
PRIVATE_KEY=... \
forge script script/DeployDemo.s.sol:DeployDemo \
  --rpc-url $XLAYER_RPC_URL \
  --broadcast
```

`DeployDemo.s.sol` deploys the Hook, demo router, mock tokens, initializes loose and strict pools, sets policies, adds liquidity, runs one accepted swap, and records one strict-pool refusal via `SwapBlockedCaught`.
