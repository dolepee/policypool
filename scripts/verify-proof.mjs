#!/usr/bin/env node

const RPC_URL = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";

const HOOK = "0x7d676fa819d8cdf0a2bb73b944a3533870868080";
const ROUTER = "0xcd46b2c1e6dd9d0fd3edd9b26f0137e02f3fc29e";
const STRICT_POOL_ID = "0x1c32ec3d512c6807ba73c5cd32bdf2fe6c3ab07dc3e820340378c728bb5711f7";
const LOOSE_POOL_ID = "0x1f03803fe744002a219a7d74646f3e355130b4afbd073c05afd3684bc70bbbf7";

const SWAP_ACCEPTED_TOPIC = "0x46d11b930555de97a168a00e6c96afe1919ffc8bdb5d5f6d49fee355947deea8";
const SWAP_BLOCKED_CAUGHT_TOPIC = "0x3c075ad93bcaa1d7d86980acf426d8c92c63a73307230d5dfa39c8c7a7a14589";
const POLICY_BLOCKED_SELECTOR = "6b072edb";
const WRAPPED_ERROR_SELECTOR = "90bfb865";

const USDC = 1_000_000n;

const proofs = [
  {
    label: "loose pool accepts 5,000 mUSDC",
    tx: "0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396",
    type: "accepted",
    poolId: LOOSE_POOL_ID,
    amountIn: 5_000n * USDC,
  },
  {
    label: "strict pool refuses 5,000 mUSDC by max-swap covenant",
    tx: "0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a",
    type: "blocked",
    poolId: STRICT_POOL_ID,
    reason: "MAX_SWAP_EXCEEDED",
    attempted: 5_000n * USDC,
    limit: 1_000n * USDC,
  },
  {
    label: "strict pool accepts first 1,000 mUSDC daily-cap fill",
    tx: "0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178",
    type: "accepted",
    poolId: STRICT_POOL_ID,
    amountIn: 1_000n * USDC,
  },
  {
    label: "strict pool accepts second 1,000 mUSDC daily-cap fill",
    tx: "0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b",
    type: "accepted",
    poolId: STRICT_POOL_ID,
    amountIn: 1_000n * USDC,
  },
  {
    label: "strict pool refuses third 1,000 mUSDC by daily-cap covenant",
    tx: "0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c",
    type: "blocked",
    poolId: STRICT_POOL_ID,
    reason: "DAILY_CAP_EXCEEDED",
    attempted: 3_000n * USDC,
    limit: 2_000n * USDC,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
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

function lower(value) {
  return String(value || "").toLowerCase();
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function wordAt(hex, index) {
  const clean = strip0x(hex);
  return `0x${clean.slice(index * 64, (index + 1) * 64)}`;
}

function wordToBigInt(hex) {
  return BigInt(hex || "0x0");
}

function bytes32ToAscii(hex) {
  return Buffer.from(strip0x(hex), "hex").toString("utf8").replace(/\0+$/g, "");
}

function decodeAcceptedLog(log) {
  return { amountIn: wordToBigInt(log.data) };
}

function decodeBlockedLog(log) {
  const data = strip0x(log.data);
  const offset = Number(wordToBigInt(wordAt(data, 0)));
  const length = Number(wordToBigInt(`0x${data.slice(offset * 2, offset * 2 + 64)}`));
  const revertDataStart = offset * 2 + 64;
  const revertData = data.slice(revertDataStart, revertDataStart + length * 2);

  return decodePolicyBlocked(revertData);
}

function decodePolicyBlocked(revertData) {
  const clean = strip0x(revertData);
  const selector = clean.slice(0, 8).toLowerCase();

  // v4 wraps hook reverts as WrappedError(address target, bytes4 selector, bytes reason, bytes details).
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

function findAcceptedLog(receipt, poolId) {
  return receipt.logs.find(
    (log) =>
      lower(log.address) === HOOK &&
      lower(log.topics?.[0]) === SWAP_ACCEPTED_TOPIC &&
      lower(log.topics?.[1]) === lower(poolId),
  );
}

function findBlockedLog(receipt, poolId) {
  return receipt.logs.find(
    (log) =>
      lower(log.address) === ROUTER &&
      lower(log.topics?.[0]) === SWAP_BLOCKED_CAUGHT_TOPIC &&
      lower(log.topics?.[1]) === lower(poolId),
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

for (const proof of proofs) {
  const receipt = await rpc("eth_getTransactionReceipt", [proof.tx]);
  if (!receipt) throw new Error(`${proof.label}: missing receipt ${proof.tx}`);
  if (receipt.status !== "0x1") throw new Error(`${proof.label}: tx did not succeed`);

  if (proof.type === "accepted") {
    const log = findAcceptedLog(receipt, proof.poolId);
    if (!log) throw new Error(`${proof.label}: SwapAccepted log not found`);
    const decoded = decodeAcceptedLog(log);
    assertEqual(decoded.amountIn, proof.amountIn, `${proof.label} amountIn`);
    console.log(`✓ ${proof.label} (${decoded.amountIn / USDC} mUSDC)`);
  } else {
    const log = findBlockedLog(receipt, proof.poolId);
    if (!log) throw new Error(`${proof.label}: SwapBlockedCaught log not found`);
    const decoded = decodeBlockedLog(log);
    if (decoded.reason !== proof.reason) {
      throw new Error(`${proof.label}: expected ${proof.reason}, got ${decoded.reason}`);
    }
    assertEqual(decoded.attempted, proof.attempted, `${proof.label} attempted`);
    assertEqual(decoded.limit, proof.limit, `${proof.label} limit`);
    console.log(
      `✓ ${proof.label} (${decoded.reason}, attempted ${decoded.attempted / USDC} mUSDC, limit ${
        decoded.limit / USDC
      } mUSDC)`,
    );
  }
}

console.log("PolicyPool proof verified on X Layer.");
