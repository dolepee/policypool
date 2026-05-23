#!/usr/bin/env node

import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const RPC_URL = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";

const CHAIN_ID = 196n;
const BEFORE_SWAP_FLAG = 1n << 7n;
const ALL_HOOK_MASK = (1n << 14n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const POOL_MANAGER = "0x360e68faccca8ca495c1b759fd9eee466db9fb32";
const HOOK = "0x7d676fa819d8cdf0a2bb73b944a3533870868080";
const ROUTER = "0xcd46b2c1e6dd9d0fd3edd9b26f0137e02f3fc29e";
const MOCK_USDC = "0xbb856b7ce87315eabf1005861b1b321826a6d33c";
const MOCK_ETH = "0xea76c34e0d6d43326c9ab98088536d129242d181";

const LOOSE_POOL_ID = "0x1f03803fe744002a219a7d74646f3e355130b4afbd073c05afd3684bc70bbbf7";
const STRICT_POOL_ID = "0x1c32ec3d512c6807ba73c5cd32bdf2fe6c3ab07dc3e820340378c728bb5711f7";

const USDC = 1_000_000n;

const SELECTORS = {
  poolManager: "0x62308e85",
  hookPermissions: "0xc4e833ce",
  policies: "0xddbfd8ef",
  policyOwner: "0x54de327c",
};

const contracts = [
  ["Uniswap v4 PoolManager", POOL_MANAGER],
  ["PolicyPoolHook", HOOK],
  ["PolicyPoolDemoRouter", ROUTER],
  ["MockUSDC", MOCK_USDC],
  ["MockETH", MOCK_ETH],
];

const expectedPolicies = [
  {
    label: "loose pool policy",
    poolId: LOOSE_POOL_ID,
    maxSwapAmount: 10_000n * USDC,
    dailyCap: 50_000n * USDC,
  },
  {
    label: "strict pool policy",
    poolId: STRICT_POOL_ID,
    maxSwapAmount: 1_000n * USDC,
    dailyCap: 2_000n * USDC,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: attempt, method, params }),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
      return payload.result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(700 * attempt);
    }
  }

  throw lastError;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function wordAt(hex, index) {
  const clean = strip0x(hex);
  return `0x${clean.slice(index * 64, (index + 1) * 64)}`;
}

function wordToBigInt(hex) {
  return BigInt(hex || "0x0");
}

function wordToAddress(hex) {
  return `0x${strip0x(hex).slice(24)}`.toLowerCase();
}

function callData(selector, ...args) {
  return `${selector}${args.map(strip0x).join("")}`;
}

async function ethCall(to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

const chainId = wordToBigInt(await rpc("eth_chainId", []));
assertEqual(chainId, CHAIN_ID, "chain id");
console.log(`✓ connected to X Layer mainnet (${chainId})`);

for (const [label, address] of contracts) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  assert(code && code !== "0x", `${label}: no bytecode at ${address}`);
  console.log(`✓ ${label} bytecode exists at ${address}`);
}

const hookBits = BigInt(HOOK) & ALL_HOOK_MASK;
assertEqual(hookBits, BEFORE_SWAP_FLAG, "Hook address permission bits");
console.log("✓ Hook address bits enable BEFORE_SWAP only");

const configuredPoolManager = wordToAddress(await ethCall(HOOK, SELECTORS.poolManager));
assertEqual(configuredPoolManager, POOL_MANAGER, "PolicyPoolHook POOL_MANAGER");
console.log("✓ PolicyPoolHook is bound to official X Layer PoolManager");

const permissionsRaw = await ethCall(HOOK, SELECTORS.hookPermissions);
const permissions = Array.from({ length: 14 }, (_, index) => wordToBigInt(wordAt(permissionsRaw, index)) === 1n);
const expectedPermissions = [false, false, false, false, false, false, true, false, false, false, false, false, false, false];
assert(
  permissions.every((permission, index) => permission === expectedPermissions[index]),
  `unexpected Hook permissions: ${permissions.join(",")}`,
);
console.log("✓ getHookPermissions returns only beforeSwap=true");

for (const expected of expectedPolicies) {
  const ownerRaw = await ethCall(HOOK, callData(SELECTORS.policyOwner, expected.poolId));
  const owner = wordToAddress(ownerRaw);
  assert(owner !== ZERO_ADDRESS, `${expected.label}: missing owner`);

  const policyRaw = await ethCall(HOOK, callData(SELECTORS.policies, expected.poolId));
  const maxSwapAmount = wordToBigInt(wordAt(policyRaw, 0));
  const dailyCap = wordToBigInt(wordAt(policyRaw, 1));
  const lastResetTimestamp = wordToBigInt(wordAt(policyRaw, 3));

  assertEqual(maxSwapAmount, expected.maxSwapAmount, `${expected.label} maxSwapAmount`);
  assertEqual(dailyCap, expected.dailyCap, `${expected.label} dailyCap`);
  assert(lastResetTimestamp > 0n, `${expected.label}: lastResetTimestamp is zero`);
  console.log(`✓ ${expected.label} is set (${maxSwapAmount / USDC} / ${dailyCap / USDC} mUSDC)`);
}

console.log("PolicyPool deployment verified on X Layer.");
