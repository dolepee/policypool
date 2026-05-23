# Deployment Plan

PolicyPool must deploy one valid Uniswap v4 Hook and at least one v4 pool on X Layer. The target demo uses two pools to prove the covenant moment: same pair, same trader, same swap, one accepts and one refuses.

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

## Captured Proof

Captured on X Layer mainnet, chain `196`:

- `PolicyPoolHook`: `0x7D676FA819D8CDF0A2BB73B944a3533870868080`
- `PolicyPoolDemoRouter`: `0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e`
- loose pool initialized: `0x969e4254336180c5bac71cb9851feacaed2f0fd7c2dabe63b748159909a245a7`
- strict pool initialized: `0x64793e514c6dd69102f3c4fb459391004bcf47c29fc527328f55afaff2014d46`
- loose pool accepted `5,000 mUSDC`: `0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396`
- strict pool recorded refusal: `0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a`
- all project contracts verified on Sourcify with exact matches

## Submission Claim

The deployment should support this claim:

> Pool-level covenants enforced inside Uniswap v4 swap execution.

The proof is the accepted/refused swap pair on X Layer: the same exact-input swap is accepted by the loose pool and refused by the strict pool.

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
