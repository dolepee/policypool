import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
} from "viem";
import { createChainService, EvidenceError } from "../api/lib/chain.js";
import { PAYMENT } from "../api/lib/config.js";

const payer = "0x3000000000000000000000000000000000000003";
const provider = "0x4000000000000000000000000000000000000004";
const nonce = `0x${"11".repeat(32)}`;
const transactionHash = `0x${"22".repeat(32)}`;
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const authorizationUsedEvent = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
);
let returnSettlement = true;
let observedRange;
const client = {
  async getBlockNumber() { return 200n; },
  async getBlock({ blockNumber } = {}) {
    if (blockNumber === undefined) return { number: 200n, timestamp: 2_000n };
    return { number: BigInt(blockNumber), timestamp: BigInt(blockNumber) * 10n };
  },
  async getLogs(input) {
    observedRange = { fromBlock: input.fromBlock, toBlock: input.toBlock };
    return returnSettlement
      ? [{ transactionHash, blockNumber: 105n }]
      : [];
  },
  async waitForTransactionReceipt() {
    return {
      status: "success",
      blockNumber: 105n,
      logs: [
        {
          address: PAYMENT.asset,
          topics: encodeEventTopics({
            abi: [transferEvent],
            eventName: "Transfer",
            args: { from: payer, to: provider },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [500000n]),
        },
        {
          address: PAYMENT.asset,
          topics: encodeEventTopics({
            abi: [authorizationUsedEvent],
            eventName: "AuthorizationUsed",
            args: { authorizer: payer, nonce },
          }),
          data: "0x",
        },
      ],
    };
  },
};
const chain = createChainService({ client });
const found = await chain.findProviderSettlement({
  payer,
  payTo: provider,
  asset: PAYMENT.asset,
  amountAtomic: "500000",
  authorizationNonce: nonce,
  notBeforeTimestamp: 1_000,
  notAfterTimestamp: 1_100,
});
assert.deepEqual(observedRange, { fromBlock: 100n, toBlock: 110n });
assert.equal(found.txHash, transactionHash);
assert.equal(found.settledAt, "1970-01-01T00:17:30.000Z");
assert.equal(found.from, getAddress(payer));
assert.equal(found.to, getAddress(provider));
returnSettlement = false;
assert.equal(await chain.findProviderSettlement({
  payer,
  payTo: provider,
  asset: PAYMENT.asset,
  amountAtomic: "500000",
  authorizationNonce: nonce,
  notBeforeTimestamp: 1_000,
  notAfterTimestamp: 1_100,
}), null);
await assert.rejects(
  () => chain.findProviderSettlement({
    payer,
    payTo: provider,
    asset: PAYMENT.asset,
    amountAtomic: "500000",
    authorizationNonce: nonce,
    notBeforeTimestamp: 1_000,
    notAfterTimestamp: 3_000,
  }),
  (error) => error instanceof EvidenceError && error.code === "provider_settlement_search_window_invalid",
);

console.log("PolicyPool direct settlement recovery passed: bounded indexed nonce scan, exact transfer verification, timestamp recovery, no-match handling, and oversized-window rejection.");
