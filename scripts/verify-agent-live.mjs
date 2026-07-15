import assert from "node:assert/strict";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbiItem,
} from "viem";
import { PAYMENT, XLAYER } from "../api/lib/config.js";

const baseUrl = process.env.POLICYPOOL_BASE_URL || "https://policypool.vercel.app";
const endpoint = `${baseUrl}/api/covered-job-receipt`;
const ledgerEndpoint = `${baseUrl}/api/coverage-ledger`;
const controlledReceiptId = process.env.POLICYPOOL_PROOF_RECEIPT_ID || "ppc-bd38c81112102af0";
const controlledStatusEndpoint = `${baseUrl}/api/coverage-status?receiptId=${controlledReceiptId}`;
const expectedReserve = getAddress("0xE2F0c858724A9a72310D7264400e04B37423FBBC");
const expectedBuyer = getAddress("0x4ABBAe03affF90F50d4F6B42b3E362f5228aD4C7");
const expectedPayoutAtomic = 500000n;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const sampleBody = {
  targetAgent: "Foreman#4348",
  targetJobId: `0x${"1".repeat(64)}`,
  targetCreationTxHash: `0x${"3".repeat(64)}`,
  targetAcceptanceTxHash: `0x${"2".repeat(64)}`,
  jobDescription: "Create a scoped readiness pack for a funded launch task.",
  requestedCoverageUSDT: "1",
};

const head = await fetch(endpoint, { method: "HEAD" });
assert.equal(head.status, 200, `HEAD expected 200, got ${head.status}`);

const unpaid = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(sampleBody),
});
assert.equal(unpaid.status, 402, `unpaid POST expected 402, got ${unpaid.status}`);
const required = unpaid.headers.get("payment-required");
assert.ok(required, "missing PAYMENT-REQUIRED header");
const challenge = JSON.parse(Buffer.from(required, "base64").toString("utf8"));
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].network, "eip155:196");
assert.equal(challenge.accepts[0].amount, "100000");
const maybeField = (name, expected) => {
  const v = challenge.accepts[0][name];
  if (typeof v !== "undefined") {
    assert.equal(v, expected, `unexpected ${name}: ${v}`);
  }
};

maybeField("maxAmountRequired", "100000");
maybeField("decimals", 6);
maybeField("symbol", "USDT");
assert.equal(
  ["USD₮0", "Tether USD"].includes(challenge.accepts[0].extra.name),
  true,
  `unexpected token name ${challenge.accepts[0].extra.name}`,
);
assert.equal(
  ["1", "2"].includes(challenge.accepts[0].extra.version),
  true,
  `unexpected payment version ${challenge.accepts[0].extra.version}`,
);
assert.equal(
  Array.isArray(challenge.outputSchema?.input?.body?.required),
  true,
  "missing challenge output schema body requirements",
);
assert.equal(challenge.outputSchema.input.body.required.includes("targetAgent"), true);

const genericAuth = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer invalid-payment-proof",
  },
  body: JSON.stringify(sampleBody),
});
assert.equal(genericAuth.status, 402, "generic Authorization must not unlock the paid endpoint");

const malformedPayment = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "payment-signature": "invalid-payment-proof",
  },
  body: JSON.stringify(sampleBody),
});
assert.equal(malformedPayment.status, 402, `malformed proof expected 402, got ${malformedPayment.status}`);
const malformedBody = await malformedPayment.json();
assert.equal(malformedBody.error, "payment_signature_malformed");

const ledger = await fetch(ledgerEndpoint, { cache: "no-store" });
assert.equal(ledger.status, 200, `coverage ledger expected 200, got ${ledger.status}`);
const ledgerBody = await ledger.json();
assert.equal(ledgerBody.ok, true);
assert.equal(ledgerBody.reserve.solvent, true, "committed coverage must not exceed live reserve");
assert.equal(
  BigInt(ledgerBody.reserve.committedAtomic) <= BigInt(ledgerBody.reserve.balanceAtomic),
  true,
  "ledger arithmetic must be solvent",
);

const controlledStatus = await fetch(controlledStatusEndpoint, { cache: "no-store" });
assert.equal(controlledStatus.status, 200, `controlled payout status expected 200, got ${controlledStatus.status}`);
const controlled = await controlledStatus.json();
assert.equal(controlled.ok, true);
assert.equal(controlled.state, "paid", "controlled breach must end in paid state");
assert.equal(controlled.receiptId, controlledReceiptId);
assert.equal(BigInt(controlled.liabilityAtomic), expectedPayoutAtomic);
assert.equal(BigInt(controlled.payout.amountAtomic), expectedPayoutAtomic);
assert.equal(getAddress(controlled.payout.recipient), expectedBuyer);
assert.equal(getAddress(controlled.payout.proof.from), expectedReserve);
assert.equal(getAddress(controlled.payout.proof.to), expectedBuyer);
assert.equal(getAddress(controlled.payout.proof.asset), PAYMENT.asset);
assert.equal(controlled.reconciliation.deadlinePassed, true);

const chain = defineChain({
  id: XLAYER.id,
  name: XLAYER.name,
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(XLAYER.rpcUrl) });
const payoutTransaction = controlled.payout.transaction;
const payoutReceipt = await publicClient.getTransactionReceipt({ hash: payoutTransaction });
assert.equal(payoutReceipt.status, "success", "controlled payout transaction must succeed");
assert.equal(payoutReceipt.blockNumber.toString(), controlled.payout.proof.blockNumber);
const payoutTransfer = payoutReceipt.logs.find((log) => {
  if (log.address.toLowerCase() !== PAYMENT.asset.toLowerCase()) return false;
  try {
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    return decoded.eventName === "Transfer"
      && getAddress(decoded.args.from) === expectedReserve
      && getAddress(decoded.args.to) === expectedBuyer
      && decoded.args.value === expectedPayoutAtomic;
  } catch {
    return false;
  }
});
assert.ok(payoutTransfer, "X Layer receipt must contain the exact reserve-to-buyer USDt0 transfer");

const controlledLedgerRecord = ledgerBody.records.find((record) => record.receiptId === controlledReceiptId);
assert.ok(controlledLedgerRecord, "controlled payout receipt must appear in the public ledger");
assert.equal(controlledLedgerRecord.state, "paid");
assert.equal(controlledLedgerRecord.payoutTx, payoutTransaction);

const liabilityForState = (state) => ledgerBody.records
  .filter((record) => record.state === state)
  .reduce((total, record) => total + BigInt(record.liabilityAtomic), 0n);
const activeAtomic = liabilityForState("active");
const pendingAtomic = liabilityForState("pending");
const payoutDueAtomic = liabilityForState("payout_due");
const committedAtomic = activeAtomic + pendingAtomic + payoutDueAtomic;

assert.equal(BigInt(ledgerBody.liabilities.activeAtomic), activeAtomic);
assert.equal(BigInt(ledgerBody.liabilities.pendingAtomic), pendingAtomic);
assert.equal(BigInt(ledgerBody.liabilities.payoutDueAtomic), payoutDueAtomic);
assert.equal(BigInt(ledgerBody.liabilities.committedAtomic), committedAtomic);
assert.equal(BigInt(ledgerBody.reserve.committedAtomic), committedAtomic);
assert.equal(
  BigInt(ledgerBody.reserve.availableAtomic),
  BigInt(ledgerBody.reserve.balanceAtomic) - committedAtomic,
  "available reserve must equal live balance minus current commitments",
);
assert.equal(ledgerBody.liabilities.recordCount, ledgerBody.records.length);
assert.equal(
  ["pending", "active", "payout_due"].includes(controlledLedgerRecord.state),
  false,
  "the paid controlled proof must not remain a committed liability",
);

console.log(`PolicyPool live fail-closed verifier passed: ${endpoint}`);
console.log(`PolicyPool controlled payout verified independently on X Layer: ${payoutTransaction}`);
console.log("No payment was signed or spent by this no-secret verifier.");
