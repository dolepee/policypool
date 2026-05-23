#!/usr/bin/env node

const RPC_URL = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";

const HOOK = "0x7d676fa819d8cdf0a2bb73b944a3533870868080";
const ROUTER = "0xcd46b2c1e6dd9d0fd3edd9b26f0137e02f3fc29e";
const STRICT_POOL_ID = "0x1c32ec3d512c6807ba73c5cd32bdf2fe6c3ab07dc3e820340378c728bb5711f7";
const LOOSE_POOL_ID = "0x1f03803fe744002a219a7d74646f3e355130b4afbd073c05afd3684bc70bbbf7";

const SWAP_ACCEPTED_TOPIC = "0x46d11b930555de97a168a00e6c96afe1919ffc8bdb5d5f6d49fee355947deea8";
const SWAP_BLOCKED_CAUGHT_TOPIC = "0x3c075ad93bcaa1d7d86980acf426d8c92c63a73307230d5dfa39c8c7a7a14589";
const POLICY_BLOCKED_SELECTOR = "6b072edb";
const MAX_SWAP_EXCEEDED = Buffer.from("MAX_SWAP_EXCEEDED").toString("hex");
const DAILY_CAP_EXCEEDED = Buffer.from("DAILY_CAP_EXCEEDED").toString("hex");

const proofs = [
  {
    label: "loose pool accepts 5,000 mUSDC",
    tx: "0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396",
    type: "accepted",
    poolId: LOOSE_POOL_ID,
  },
  {
    label: "strict pool refuses 5,000 mUSDC by max-swap covenant",
    tx: "0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a",
    type: "blocked",
    poolId: STRICT_POOL_ID,
    reasonHex: MAX_SWAP_EXCEEDED,
  },
  {
    label: "strict pool accepts first 1,000 mUSDC daily-cap fill",
    tx: "0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178",
    type: "accepted",
    poolId: STRICT_POOL_ID,
  },
  {
    label: "strict pool accepts second 1,000 mUSDC daily-cap fill",
    tx: "0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b",
    type: "accepted",
    poolId: STRICT_POOL_ID,
  },
  {
    label: "strict pool refuses third 1,000 mUSDC by daily-cap covenant",
    tx: "0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c",
    type: "blocked",
    poolId: STRICT_POOL_ID,
    reasonHex: DAILY_CAP_EXCEEDED,
  },
];

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function hasAcceptedLog(receipt, poolId) {
  return receipt.logs.some(
    (log) =>
      lower(log.address) === HOOK &&
      lower(log.topics?.[0]) === SWAP_ACCEPTED_TOPIC &&
      lower(log.topics?.[1]) === lower(poolId),
  );
}

function hasBlockedLog(receipt, poolId, reasonHex) {
  return receipt.logs.some(
    (log) =>
      lower(log.address) === ROUTER &&
      lower(log.topics?.[0]) === SWAP_BLOCKED_CAUGHT_TOPIC &&
      lower(log.topics?.[1]) === lower(poolId) &&
      lower(log.data).includes(POLICY_BLOCKED_SELECTOR) &&
      lower(log.data).includes(lower(reasonHex)),
  );
}

for (const proof of proofs) {
  const receipt = await rpc("eth_getTransactionReceipt", [proof.tx]);
  if (!receipt) throw new Error(`${proof.label}: missing receipt ${proof.tx}`);
  if (receipt.status !== "0x1") throw new Error(`${proof.label}: tx did not succeed`);

  const ok =
    proof.type === "accepted"
      ? hasAcceptedLog(receipt, proof.poolId)
      : hasBlockedLog(receipt, proof.poolId, proof.reasonHex);

  if (!ok) throw new Error(`${proof.label}: expected ${proof.type} proof log not found`);
  console.log(`✓ ${proof.label}`);
}

console.log("PolicyPool proof verified on X Layer.");
