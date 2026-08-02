import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
const independentProofBaseUrl = process.env.POLICYPOOL_INDEPENDENT_PROOF_BASE_URL
  || "https://policypool.vercel.app";
const independentReceiptId = process.env.POLICYPOOL_INDEPENDENT_PROOF_RECEIPT_ID
  || "ppc-2de02877d7c0d080";
const independentStatusEndpoint =
  `${independentProofBaseUrl}/api/coverage-status?receiptId=${independentReceiptId}`;
const independentLedgerEndpoint = `${independentProofBaseUrl}/api/coverage-ledger`;
const expectedReserve = getAddress("0xE2F0c858724A9a72310D7264400e04B37423FBBC");
const expectedBuyer = getAddress("0x4ABBAe03affF90F50d4F6B42b3E362f5228aD4C7");
const expectedIndependentBuyer = getAddress(
  process.env.POLICYPOOL_INDEPENDENT_PROOF_BUYER
    || "0x52E19669d7b199531bF689f7ec943632Bd211B75",
);
const expectedServiceFeeRecipient = expectedReserve;
const expectedServiceFeeAtomic = 100000n;
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

function strictHeaderProbe(url, body) {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requestImpl(target, {
      method: "POST",
      maxHeaderSize: 2_048,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let headerBytes = Buffer.byteLength(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n\r\n`,
        );
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headerBytes += Buffer.byteLength(
            `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
          );
        }
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          headerBytes,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("strict_probe_timeout")));
    request.once("error", reject);
    request.end(payload);
  });
}

const head = await fetch(endpoint, { method: "HEAD" });
assert.equal(head.status, 200, `HEAD expected 200, got ${head.status}`);

const unpaid = await fetch(endpoint, { cache: "no-store" });
assert.equal(unpaid.status, 402, `anonymous discovery expected 402, got ${unpaid.status}`);
const required = unpaid.headers.get("payment-required");
assert.ok(required, "missing PAYMENT-REQUIRED header");
const challenge = JSON.parse(Buffer.from(required, "base64").toString("utf8"));
const unpaidBody = await unpaid.json();
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].network, "eip155:196");
assert.equal(challenge.accepts[0].amount, "100000");
assert.deepEqual(
  Object.keys(challenge.accepts[0]).sort(),
  ["amount", "asset", "extra", "maxTimeoutSeconds", "network", "payTo", "scheme"].sort(),
  "live payment requirements must contain only the canonical x402 v2 fields",
);
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
assert.equal(challenge.resource.description, "PolicyPool Covered Job Receipt API");
assert.equal(challenge.resource.mimeType, "application/json");
assert.equal(
  challenge.outputSchema,
  undefined,
  "PAYMENT-REQUIRED must stay compact",
);
assert.equal(
  Array.isArray(unpaidBody.outputSchema?.input?.body?.required),
  true,
  "402 body is missing request schema requirements",
);
assert.equal(unpaidBody.outputSchema.input.body.required.includes("targetAgent"), true);
assert.deepEqual(unpaidBody.accepts, challenge.accepts);

const barePost = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  cache: "no-store",
});
assert.equal(barePost.status, 402, `bare marketplace POST expected 402, got ${barePost.status}`);
const barePostRequired = barePost.headers.get("payment-required");
assert.ok(barePostRequired, "bare marketplace POST is missing PAYMENT-REQUIRED");
const barePostChallenge = JSON.parse(Buffer.from(barePostRequired, "base64").toString("utf8"));
assert.equal(barePostChallenge.x402Version, 2);
assert.equal(barePostChallenge.accepts[0].network, "eip155:196");
assert.equal(barePostChallenge.accepts[0].amount, "100000");

const unknownProbe = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ zzz: 1 }),
  cache: "no-store",
});
assert.equal(unknownProbe.status, 402, `unknown-field probe expected 402, got ${unknownProbe.status}`);
assert.ok(unknownProbe.headers.get("payment-required"), "unknown-field probe is missing PAYMENT-REQUIRED");

const realisticProbe = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(sampleBody),
  cache: "no-store",
});
assert.equal(realisticProbe.status, 402, `realistic probe expected 402, got ${realisticProbe.status}`);
assert.ok(realisticProbe.headers.get("payment-required"), "realistic probe is missing PAYMENT-REQUIRED");

const strictProbe = await strictHeaderProbe(endpoint, { zzz: 1 });
assert.equal(strictProbe.statusCode, 402, "2 KiB Node client did not receive 402");
assert.ok(strictProbe.headerBytes < 2_048, `response headers are ${strictProbe.headerBytes} bytes`);
assert.ok(strictProbe.headers["payment-required"], "strict probe is missing PAYMENT-REQUIRED");
const strictBody = JSON.parse(strictProbe.body);
assert.equal(strictBody.x402Version, 2);
assert.ok(strictBody.outputSchema?.input?.body, "strict probe body is missing its request schema");

const genericAuth = await fetch(endpoint, {
  headers: {
    authorization: "Bearer invalid-payment-proof",
  },
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

const independentStatus = await fetch(independentStatusEndpoint, { cache: "no-store" });
assert.equal(independentStatus.status, 200, `independent payout status expected 200, got ${independentStatus.status}`);
const independent = await independentStatus.json();
assert.equal(independent.ok, true);
assert.equal(independent.state, "paid", "independent-buyer breach must end in paid state");
assert.equal(independent.receiptId, independentReceiptId);
assert.equal(BigInt(independent.liabilityAtomic), expectedPayoutAtomic);
assert.equal(BigInt(independent.payout.amountAtomic), expectedPayoutAtomic);
assert.equal(getAddress(independent.receipt.buyer.address), expectedIndependentBuyer);
assert.equal(getAddress(independent.receipt.servicePayment.payer), expectedIndependentBuyer);
assert.equal(getAddress(independent.payout.recipient), expectedIndependentBuyer);
assert.equal(getAddress(independent.payout.proof.from), expectedReserve);
assert.equal(getAddress(independent.payout.proof.to), expectedIndependentBuyer);
assert.equal(getAddress(independent.payout.proof.asset), PAYMENT.asset);
assert.equal(independent.reconciliation.deadlinePassed, true);

const independentServicePaymentTransaction = independent.receipt.servicePayment.transaction;
const independentServicePaymentReceipt = await publicClient.getTransactionReceipt({
  hash: independentServicePaymentTransaction,
});
assert.equal(independentServicePaymentReceipt.status, "success", "independent service-payment transaction must succeed");
assert.equal(
  independentServicePaymentReceipt.blockNumber.toString(),
  independent.receipt.servicePayment.transferBlock,
);
const independentServicePaymentTransfer = independentServicePaymentReceipt.logs.find((log) => {
  if (log.address.toLowerCase() !== PAYMENT.asset.toLowerCase()) return false;
  try {
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    return decoded.eventName === "Transfer"
      && getAddress(decoded.args.from) === expectedIndependentBuyer
      && getAddress(decoded.args.to) === expectedServiceFeeRecipient
      && decoded.args.value === expectedServiceFeeAtomic;
  } catch {
    return false;
  }
});
assert.ok(
  independentServicePaymentTransfer,
  "X Layer receipt must contain the exact independent-buyer coverage-fee transfer",
);

const independentPayoutTransaction = independent.payout.transaction;
const independentPayoutReceipt = await publicClient.getTransactionReceipt({ hash: independentPayoutTransaction });
assert.equal(independentPayoutReceipt.status, "success", "independent payout transaction must succeed");
assert.equal(independentPayoutReceipt.blockNumber.toString(), independent.payout.proof.blockNumber);
const independentPayoutTransfer = independentPayoutReceipt.logs.find((log) => {
  if (log.address.toLowerCase() !== PAYMENT.asset.toLowerCase()) return false;
  try {
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    return decoded.eventName === "Transfer"
      && getAddress(decoded.args.from) === expectedReserve
      && getAddress(decoded.args.to) === expectedIndependentBuyer
      && decoded.args.value === expectedPayoutAtomic;
  } catch {
    return false;
  }
});
assert.ok(independentPayoutTransfer, "X Layer receipt must contain the exact reserve-to-independent-buyer USDt0 transfer");

const independentLedger = await fetch(independentLedgerEndpoint, { cache: "no-store" });
assert.equal(
  independentLedger.status,
  200,
  `independent proof ledger expected 200, got ${independentLedger.status}`,
);
const independentLedgerBody = await independentLedger.json();
assert.equal(independentLedgerBody.ok, true);
const independentLedgerRecord = independentLedgerBody.records.find(
  (record) => record.receiptId === independentReceiptId,
);
assert.ok(independentLedgerRecord, "independent payout receipt must appear in the public ledger");
assert.equal(independentLedgerRecord.state, "paid");
assert.equal(independentLedgerRecord.payoutTx, independentPayoutTransaction);

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
console.log(`PolicyPool independent-buyer payout verified on X Layer: ${independentPayoutTransaction}`);
console.log("No payment was signed or spent by this no-secret verifier.");
