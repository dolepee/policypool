#!/usr/bin/env node

import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const RPC_URL = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";

const CHAIN_ID = 196n;
const BEFORE_SWAP_FLAG = 1n << 7n;
const ALL_HOOK_MASK = (1n << 14n) - 1n;

const POOL_MANAGER = "0x360e68faccca8ca495c1b759fd9eee466db9fb32";
const SURGE_HOOK = "0xf44d9c1f9eff1231e53c60edb9a73761aa99c080";
const SURGE_ROUTER = "0xd05aad5b86f6ffcc10872803bedb5fa911e0e1fd";
const V1_DEMO_ROUTER = "0xcd46b2c1e6dd9d0fd3edd9b26f0137e02f3fc29e";
const SURGE_POOL_ID = "0x1a024c08b90a1c3534b790c9e6c3c128d54fc9a3703d4882398f27a2d2ac068b";

const SURGE_SUCCESS_TX = "0x18096b74138d43a6683f1c914e7aa83633c8ed0ba6a533cf6e7e939f5f7ea9a8";
const UNTRUSTED_FALLBACK_TX = "0x4877a6cf2214148d8ba0b3ca7d036da1cde7e35a33eeaaf79718f3e54ee4843a";

const SELECTORS = {
  poolManager: "0x62308e85",
  authorizedSurgeRouter: "0xe3490521",
  policies: "0xddbfd8ef",
};

const TOPICS = {
  donate: "0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb",
  swapAccepted: "0x46d11b930555de97a168a00e6c96afe1919ffc8bdb5d5f6d49fee355947deea8",
  surgeAccepted: "0x13df63dc5a57e4d9e5d0b1d32cd0e9d2bfcb7fac18caa5eea5d369977f7e1923",
  swapBlockedCaught: "0x3c075ad93bcaa1d7d86980acf426d8c92c63a73307230d5dfa39c8c7a7a14589",
};

const POLICY_BLOCKED_SELECTOR = "6b072edb";
const WRAPPED_ERROR_SELECTOR = "90bfb865";

const USDC = 1_000_000n;
const SURGE_SWAP_AMOUNT = 5_000n * USDC;
const SURGE_AMOUNT = 40n * USDC;

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

function topicAddress(address) {
  return `0x${strip0x(address).toLowerCase().padStart(64, "0")}`;
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

function bytes32ToAscii(hex) {
  return Buffer.from(strip0x(hex), "hex").toString("utf8").replace(/\0+$/g, "");
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

function findLog(receipt, address, topic, poolId) {
  return receipt.logs.find(
    (log) =>
      lower(log.address) === lower(address) &&
      lower(log.topics?.[0]) === lower(topic) &&
      (!poolId || lower(log.topics?.[1]) === lower(poolId)),
  );
}

function decodePolicyBlocked(revertData) {
  const clean = strip0x(revertData);
  const selector = clean.slice(0, 8).toLowerCase();

  if (selector === WRAPPED_ERROR_SELECTOR) {
    const args = clean.slice(8);
    const reasonOffset = Number(wordToBigInt(wordAt(args, 2)));
    const reasonLength = Number(wordToBigInt(`0x${args.slice(reasonOffset * 2, reasonOffset * 2 + 64)}`));
    const reasonStart = reasonOffset * 2 + 64;
    return decodePolicyBlocked(args.slice(reasonStart, reasonStart + reasonLength * 2));
  }

  if (selector !== POLICY_BLOCKED_SELECTOR) {
    throw new Error(`unexpected custom error selector 0x${selector}`);
  }

  return {
    reason: bytes32ToAscii(clean.slice(8, 72)),
    attempted: wordToBigInt(`0x${clean.slice(72, 136)}`),
    limit: wordToBigInt(`0x${clean.slice(136, 200)}`),
  };
}

function decodeBlockedLog(log) {
  const data = strip0x(log.data);
  const offset = Number(wordToBigInt(wordAt(data, 0)));
  const length = Number(wordToBigInt(`0x${data.slice(offset * 2, offset * 2 + 64)}`));
  const revertDataStart = offset * 2 + 64;
  return decodePolicyBlocked(data.slice(revertDataStart, revertDataStart + length * 2));
}

const chainId = wordToBigInt(await rpc("eth_chainId", []));
assertEqual(chainId, CHAIN_ID, "chain id");

for (const [label, address] of [
  ["PolicyPoolSurgeHook", SURGE_HOOK],
  ["PolicyPoolSurgeRouter", SURGE_ROUTER],
]) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  assert(code && code !== "0x", `${label}: no bytecode at ${address}`);
}

const hookBits = BigInt(SURGE_HOOK) & ALL_HOOK_MASK;
assertEqual(hookBits, BEFORE_SWAP_FLAG, "surge hook address permission bits");

const configuredPoolManager = wordToAddress(await ethCall(SURGE_HOOK, SELECTORS.poolManager));
assertEqual(configuredPoolManager, POOL_MANAGER, "PolicyPoolSurgeHook POOL_MANAGER");

const authorizedRouter = wordToAddress(await ethCall(SURGE_HOOK, SELECTORS.authorizedSurgeRouter));
assertEqual(authorizedRouter, SURGE_ROUTER, "PolicyPoolSurgeHook AUTHORIZED_SURGE_ROUTER");

const policyRaw = await ethCall(SURGE_HOOK, callData(SELECTORS.policies, SURGE_POOL_ID));
assertEqual(wordToBigInt(wordAt(policyRaw, 0)), 1_000n * USDC, "surge policy maxSwapAmount");
assertEqual(wordToBigInt(wordAt(policyRaw, 1)), 10_000n * USDC, "surge policy dailyCap");
assertEqual(wordToBigInt(wordAt(policyRaw, 4)), 100n, "surge policy surgeRateBps");
console.log("✓ surge hook deployment and policy verified");

const surgeReceipt = await rpc("eth_getTransactionReceipt", [SURGE_SUCCESS_TX]);
assert(surgeReceipt && surgeReceipt.status === "0x1", "surge success tx missing or failed");

const donateLog = findLog(surgeReceipt, POOL_MANAGER, TOPICS.donate, SURGE_POOL_ID);
assert(donateLog, "surge success tx: PoolManager Donate log missing");
assertEqual(lower(donateLog.topics[2]), lower(topicAddress(SURGE_ROUTER)), "Donate sender");
assertEqual(wordToBigInt(wordAt(donateLog.data, 0)), SURGE_AMOUNT, "Donate amount0");
assertEqual(wordToBigInt(wordAt(donateLog.data, 1)), 0n, "Donate amount1");

const swapAcceptedLog = findLog(surgeReceipt, SURGE_HOOK, TOPICS.swapAccepted, SURGE_POOL_ID);
assert(swapAcceptedLog, "surge success tx: SwapAccepted log missing");
assertEqual(lower(swapAcceptedLog.topics[2]), lower(topicAddress(SURGE_ROUTER)), "SwapAccepted trader");
assertEqual(wordToBigInt(swapAcceptedLog.data), SURGE_SWAP_AMOUNT, "SwapAccepted amountIn");

const surgeAcceptedLog = findLog(surgeReceipt, SURGE_ROUTER, TOPICS.surgeAccepted);
assert(surgeAcceptedLog, "surge success tx: SurgeAccepted log missing");
assertEqual(lower(surgeAcceptedLog.topics[2]), lower(SURGE_POOL_ID), "SurgeAccepted poolId");
assertEqual(wordToBigInt(surgeAcceptedLog.data), SURGE_AMOUNT, "SurgeAccepted amount");
console.log("✓ surge swap donated 40 mUSDC and executed 5,000 mUSDC in one tx");

const untrustedReceipt = await rpc("eth_getTransactionReceipt", [UNTRUSTED_FALLBACK_TX]);
assert(untrustedReceipt && untrustedReceipt.status === "0x1", "untrusted fallback tx missing or failed");
const blockedLog = findLog(untrustedReceipt, V1_DEMO_ROUTER, TOPICS.swapBlockedCaught, SURGE_POOL_ID);
assert(blockedLog, "untrusted fallback tx: SwapBlockedCaught log missing");
const blocked = decodeBlockedLog(blockedLog);
assertEqual(blocked.reason, "MAX_SWAP_EXCEEDED", "untrusted fallback reason");
assertEqual(blocked.attempted, SURGE_SWAP_AMOUNT, "untrusted fallback attempted");
assertEqual(blocked.limit, 1_000n * USDC, "untrusted fallback limit");
assert(!findLog(untrustedReceipt, POOL_MANAGER, TOPICS.donate, SURGE_POOL_ID), "untrusted fallback unexpectedly donated");
assert(!findLog(untrustedReceipt, SURGE_ROUTER, TOPICS.surgeAccepted), "untrusted fallback unexpectedly emitted surge");
console.log("✓ untrusted router hookData falls back to V1 max-swap refusal");

console.log("PolicyPool Surge proof verified on X Layer.");
