# Deployment Plan

PolicyPool must deploy one valid Uniswap v4 Hook and at least one v4 pool on X Layer. The target demo uses two V1 pools to prove the covenant moment and one V2 Surge pool to prove trusted-router LP capture.

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
6. `PolicyPoolSurgeRouter`
7. `PolicySurgeHookDeployer`
8. `PolicyPoolSurgeHook`

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

Surge pool:

- hook: `PolicyPoolSurgeHook`
- router: `PolicyPoolSurgeRouter`
- fee: `3000`
- tick spacing: `60`
- max swap: `1,000 mUSDC`
- daily cap: `10,000 mUSDC`
- surge rate: `100` bps of overage

## Captured Proof

Captured on X Layer mainnet, chain `196`:

- `PolicyPoolHook`: `0x7D676FA819D8CDF0A2BB73B944a3533870868080`
- `PolicyPoolDemoRouter`: `0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e`
- `PolicySurgeHookDeployer`: `0x10B48e541bC8eD94aC0106F1CA69Ffe255479dCB` (Sourcify exact match)
- `PolicyPoolSurgeHook`: `0xf44d9C1f9efF1231E53C60EDB9A73761aa99c080` (Sourcify exact match)
- `PolicyPoolSurgeRouter`: `0xd05AAD5b86f6FFCc10872803bEdb5fa911e0E1fD` (Sourcify exact match)
- loose pool initialized: `0x969e4254336180c5bac71cb9851feacaed2f0fd7c2dabe63b748159909a245a7`
- strict pool initialized: `0x64793e514c6dd69102f3c4fb459391004bcf47c29fc527328f55afaff2014d46`
- loose pool accepted `5,000 mUSDC`: `0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396`
- strict pool recorded refusal: `0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a`
- strict pool accepted first `1,000 mUSDC` daily-cap fill: `0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178`
- strict pool accepted second `1,000 mUSDC` daily-cap fill: `0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b`
- strict pool recorded `DAILY_CAP_EXCEEDED`: `0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c`
- surge router donated `40 mUSDC` and executed `5,000 mUSDC`: `0x18096b74138d43a6683f1c914e7aa83633c8ed0ba6a533cf6e7e939f5f7ea9a8`
- untrusted router failed to activate surge with hookData: `0x4877a6cf2214148d8ba0b3ca7d036da1cde7e35a33eeaaf79718f3e54ee4843a`
- V1 and Surge contracts verified on Sourcify with exact matches; Surge receipts checked by `scripts/verify-surge.mjs`

## Submission Claim

The deployment should support this claim:

> Pool-level covenants enforced inside Uniswap v4 swap execution, with trusted-router surge overrides that pay LPs.

The proof is the accepted/refused swap pair on X Layer plus a daily-cap sequence and a Surge sequence: the same exact-input swap is accepted by the loose pool and refused by the strict pool, the strict pool accepts two smaller fills and refuses the third once its daily cap is reached, and the Surge pool accepts an over-cap swap only when the trusted router donates to LPs in the same unlock.

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

Surge deploy:

```bash
POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 \
PRIVATE_KEY=... \
forge script script/DeploySurge.s.sol:DeploySurge \
  --rpc-url $XLAYER_RPC_URL \
  --broadcast
```

`DeploySurge.s.sol` deploys the trusted surge router, mines and deploys a new surge Hook, initializes a surge pool, sets policy, executes the donated surge swap, and records the untrusted-router spoof attempt.
