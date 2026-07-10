import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createHandler } from "../api/covered-job-receipt.js";
import { createCoverageStatusHandler } from "../api/coverage-status.js";
import { createReconcileHandler } from "../api/reconcile-coverage.js";
import { createRecordPayoutHandler } from "../api/record-payout.js";
import { EvidenceError } from "../api/lib/chain.js";
import { PAYMENT, paymentRequirements } from "../api/lib/config.js";
import { MemoryLedger } from "../api/lib/ledger.js";
import { createPaymentService } from "../api/lib/payment.js";
import { sha256 } from "../api/lib/utils.js";
import { callHandler, decodePaymentRequired } from "./lib/fake-vercel.mjs";

const FIXED_NOW = Date.parse("2026-07-10T10:00:00.000Z");
const CREATION_TX = `0x${"9".repeat(64)}`;
const ACCEPTANCE_TX = `0x${"a".repeat(64)}`;
const TARGET_JOB = `0x${"b".repeat(64)}`;

const sampleBody = {
  targetAgent: "Foreman#4348",
  targetJobId: TARGET_JOB,
  targetCreationTxHash: CREATION_TX,
  targetAcceptanceTxHash: ACCEPTANCE_TX,
  jobDescription: "Create a scoped readiness pack for a funded launch task.",
  deadline: "2026-07-17T00:00:00.000Z",
  requestedCoverageUSDT: "1",
};

function makePaymentHeader(tag, accepted = paymentRequirements()) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${sha256(tag).padEnd(130, "0").slice(0, 130)}`,
      authorization: { nonce: `0x${sha256(`nonce:${tag}`)}` },
    },
  });
}

function makeRuntime({
  reserveAtomic = 5_000_000n,
  targetError,
  settlementFails = false,
  jobStatus = 1,
  createdAt = "2026-07-10T09:57:00.000Z",
  acceptedAt = "2026-07-10T09:58:00.000Z",
} = {}) {
  const ledger = new MemoryLedger();
  const calls = { verify: 0, settle: 0, target: 0, transfer: 0 };
  const chain = {
    async getReserveBalance() {
      return reserveAtomic;
    },
    async getJobStatus() {
      return jobStatus;
    },
    async verifyTargetOrder({ jobId, creationTxHash, acceptanceTxHash }) {
      calls.target += 1;
      if (targetError) throw new EvidenceError(targetError);
      return {
        jobId,
        creationTxHash,
        acceptanceTxHash,
        creationBlock: "99",
        acceptanceBlock: "100",
        createdAt,
        acceptedAt,
        buyer: "0x1111111111111111111111111111111111111111",
        provider: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
        agentId: "4348",
        asset: PAYMENT.asset,
        amountAtomic: "5000000",
        serviceHash: `0x${"c".repeat(64)}`,
        status: 1,
        statusLabel: "accepted",
      };
    },
    async verifySettlement({ txHash, payer, amountAtomic }) {
      calls.transfer += 1;
      return {
        txHash,
        blockNumber: "101",
        asset: PAYMENT.asset,
        from: payer,
        to: PAYMENT.payTo,
        amountAtomic,
      };
    },
    async verifyPayout({ txHash, buyer, amountAtomic }) {
      return {
        txHash,
        blockNumber: "102",
        asset: PAYMENT.asset,
        from: PAYMENT.payTo,
        to: buyer,
        amountAtomic,
      };
    },
  };
  const facilitator = {
    async verify(payload) {
      calls.verify += 1;
      return {
        isValid: true,
        payer: "0x1111111111111111111111111111111111111111",
        extra: { authorization: payload.payload.authorization },
      };
    },
    async settle(payload) {
      calls.settle += 1;
      if (settlementFails) return { success: false, errorReason: "simulated_settlement_failure" };
      return {
        success: true,
        network: "eip155:196",
        transaction: `0x${sha256(payload.payload).slice(0, 64)}`,
        payer: "0x1111111111111111111111111111111111111111",
      };
    },
  };
  const payment = createPaymentService({ facilitator, chain });
  const handler = createHandler({ ledger, chain, payment, now: () => FIXED_NOW });
  return { calls, handler, ledger };
}

const primary = makeRuntime();
const head = await callHandler(primary.handler, { method: "HEAD" });
assert.equal(head.statusCode, 200, "HEAD must return 200");

const unpaid = await callHandler(primary.handler, { method: "POST", body: sampleBody });
assert.equal(unpaid.statusCode, 402, "unpaid request must return 402");
const challenge = decodePaymentRequired(unpaid.headers["payment-required"]);
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].network, "eip155:196");
assert.equal(challenge.accepts[0].amount, "1000000");
assert.equal(challenge.accepts[0].extra.name, "USD₮0");
assert.equal(challenge.accepts[0].extra.version, "1");
assert.ok(challenge.outputSchema.input.body.required.includes("targetAcceptanceTxHash"));
assert.ok(challenge.outputSchema.input.body.required.includes("targetCreationTxHash"));
assert.equal(challenge.outputSchema.input.body.required.includes("deadline"), false);

const genericAuthorization = await callHandler(primary.handler, {
  method: "POST",
  headers: { authorization: "Bearer not-a-payment" },
  body: sampleBody,
});
assert.equal(genericAuthorization.statusCode, 402, "generic Authorization must never count as payment");

const malformed = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": "not-base64-json" },
  body: sampleBody,
});
assert.equal(malformed.statusCode, 402, "malformed payment proof must return 402");
assert.equal(malformed.json().error, "payment_signature_malformed");

const wrongAmountHeader = makePaymentHeader("wrong-amount", {
  ...paymentRequirements(),
  amount: "1",
});
const wrongAmount = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": wrongAmountHeader },
  body: sampleBody,
});
assert.equal(wrongAmount.statusCode, 402, "mismatched accepted requirements must return 402");
assert.equal(wrongAmount.json().error, "payment_amount_mismatch");

const paidHeader = makePaymentHeader("issued");
const paid = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": paidHeader },
  body: {
    ...sampleBody,
    policy: { forbiddenActions: [] },
    breachType: "deadline_missed",
    now: "2099-01-01T00:00:00.000Z",
    payoutTxHash: `0x${"d".repeat(64)}`,
  },
});
assert.equal(paid.statusCode, 200, "valid settled payment must return 200");
assert.ok(paid.headers["payment-response"], "settled response must include PAYMENT-RESPONSE");
const paidBody = paid.json();
assert.equal(paidBody.receipt.outcome.type, "ISSUED");
assert.equal(paidBody.receipt.guard.callerSuppliedPolicyIgnored, true);
assert.equal(paidBody.receipt.guard.callerSuppliedDeadlineIgnored, true);
assert.equal(paidBody.receipt.guard.callerSuppliedBreachAndPayoutFieldsIgnored, true);
assert.equal(paidBody.receipt.guard.derivedCoverageDeadline, "2026-07-10T10:03:00.000Z");
assert.equal(paidBody.receipt.servicePayment.settled, true);
assert.equal(paidBody.receipt.target.slaSeconds, 300);
assert.equal(paidBody.receipt.covenant.deadline, "2026-07-10T10:03:00.000Z");
assert.equal(paidBody.receipt.covenant.coverageCapUSDT, "1");
assert.match(paidBody.receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(primary.calls.settle, 1);
assert.equal((await primary.ledger.stats()).activeAtomic, "1000000");
assert.doesNotThrow(
  () => JSON.stringify(primary.ledger.records.get(paidBody.receipt.receiptId)),
  "the durable record must be JSON serializable before Redis storage",
);

const replay = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": paidHeader },
  body: { ...sampleBody, jobDescription: "Attempt to mutate the paid request." },
});
assert.equal(replay.statusCode, 200, "same payment proof should replay its original receipt");
assert.equal(replay.json().idempotentReplay, true);
assert.equal(replay.json().receipt.receiptHash, paidBody.receipt.receiptHash);
assert.equal(primary.calls.settle, 1, "replay must not settle twice");

const duplicateRequest = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("duplicate-request") },
  body: sampleBody,
});
assert.equal(duplicateRequest.statusCode, 409, "same request with a new payment must be rejected before settlement");
assert.equal(primary.calls.settle, 1);

const unregistered = makeRuntime();
const unregisteredResponse = await callHandler(unregistered.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("unregistered") },
  body: { ...sampleBody, targetAgent: "Unknown#9999", targetJobId: `0x${"e".repeat(64)}` },
});
assert.equal(unregisteredResponse.statusCode, 200);
assert.equal(unregisteredResponse.json().receipt.outcome.type, "DECLINED");
assert.equal(unregisteredResponse.json().receipt.outcome.reason, "target_policy_not_registered");
assert.equal(unregistered.calls.target, 0, "unknown policy must not reach target verifier");

const outsideScope = makeRuntime();
const outsideScopeResponse = await callHandler(outsideScope.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("outside-scope") },
  body: {
    ...sampleBody,
    targetJobId: `0x${"f".repeat(64)}`,
    jobDescription: "Prepare an unrelated restaurant reservation.",
  },
});
assert.equal(outsideScopeResponse.statusCode, 200);
assert.equal(outsideScopeResponse.json().receipt.outcome.reason, "job_outside_registered_policy");
assert.equal(outsideScope.calls.target, 0, "out-of-policy jobs must not reach target verifier");

const invalidEvidence = makeRuntime({ targetError: "target_job_not_accepted:2" });
const invalidEvidenceResponse = await callHandler(invalidEvidence.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("invalid-evidence") },
  body: { ...sampleBody, targetJobId: `0x${"1".repeat(64)}` },
});
assert.equal(invalidEvidenceResponse.statusCode, 200);
assert.equal(invalidEvidenceResponse.json().receipt.outcome.type, "DECLINED");
assert.equal(invalidEvidenceResponse.json().receipt.outcome.reason, "target_job_not_accepted:2");
assert.equal((await invalidEvidence.ledger.stats()).activeAtomic, "0");

const elapsedSla = makeRuntime({ acceptedAt: "2026-07-10T09:50:00.000Z" });
const elapsedSlaResponse = await callHandler(elapsedSla.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("elapsed-sla") },
  body: {
    ...sampleBody,
    targetJobId: `0x${"6".repeat(64)}`,
    deadline: "2099-01-01T00:00:00.000Z",
  },
});
assert.equal(elapsedSlaResponse.statusCode, 200);
assert.equal(elapsedSlaResponse.json().receipt.outcome.type, "DECLINED");
assert.equal(elapsedSlaResponse.json().receipt.outcome.reason, "registered_policy_sla_already_elapsed");
assert.equal(elapsedSlaResponse.json().receipt.guard.callerSuppliedDeadlineIgnored, true);
assert.equal(elapsedSlaResponse.json().receipt.guard.derivedCoverageDeadline, "2026-07-10T09:55:00.000Z");
assert.equal((await elapsedSla.ledger.stats()).committedAtomic, "0");

const noReserve = makeRuntime({ reserveAtomic: 0n });
const noReserveResponse = await callHandler(noReserve.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("no-reserve") },
  body: { ...sampleBody, targetJobId: `0x${"2".repeat(64)}` },
});
assert.equal(noReserveResponse.statusCode, 200);
assert.equal(noReserveResponse.json().receipt.outcome.reason, "insufficient_uncommitted_reserve");
assert.equal((await noReserve.ledger.stats()).committedAtomic, "0");

const failedSettlement = makeRuntime({ settlementFails: true });
const failedSettlementResponse = await callHandler(failedSettlement.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("settlement-fails") },
  body: { ...sampleBody, targetJobId: `0x${"3".repeat(64)}` },
});
assert.equal(failedSettlementResponse.statusCode, 402);
assert.equal((await failedSettlement.ledger.stats()).pendingAtomic, "0", "failed settlement must release pending liability");
assert.equal((await failedSettlement.ledger.stats()).recordCount, 0);

const adminStopped = makeRuntime();
const adminStoppedIssued = await callHandler(adminStopped.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("admin-stopped") },
  body: { ...sampleBody, targetJobId: `0x${"7".repeat(64)}` },
});
assert.equal(adminStoppedIssued.statusCode, 200);
assert.equal(adminStoppedIssued.json().receipt.outcome.type, "ISSUED");
const adminStoppedReceiptId = adminStoppedIssued.json().receipt.receiptId;
const adminStoppedReconcile = await callHandler(createReconcileHandler({
  ledger: adminStopped.ledger,
  chain: { async getJobStatus() { return 5; } },
  authorized: true,
  now: () => FIXED_NOW,
}), { method: "POST" });
assert.equal(adminStoppedReconcile.statusCode, 200);
assert.deepEqual(adminStoppedReconcile.json().changes, [{
  receiptId: adminStoppedReceiptId,
  from: "active",
  to: "released",
}]);
assert.equal((await adminStopped.ledger.stats()).committedAtomic, "0");
assert.equal((await adminStopped.ledger.get(adminStoppedReceiptId)).release.reason, "platform_job_admin_stopped");

const issuedReceiptId = paidBody.receipt.receiptId;
const statusBeforeDeadline = await callHandler(createCoverageStatusHandler({
  ledger: primary.ledger,
  chain: primary.handler ? {
    async getJobStatus() { return 1; },
  } : null,
  now: () => FIXED_NOW,
}), {
  method: "GET",
  query: { receiptId: issuedReceiptId },
});
assert.equal(statusBeforeDeadline.statusCode, 200);
assert.equal(statusBeforeDeadline.json().state, "active");
assert.equal(statusBeforeDeadline.json().reconciliation.payoutDueCandidate, false);

const payoutChain = {
  async getJobStatus() { return 1; },
  async verifyPayout({ txHash, buyer, amountAtomic }) {
    return { txHash, blockNumber: "102", asset: PAYMENT.asset, from: PAYMENT.payTo, to: buyer, amountAtomic };
  },
};
const reconcile = await callHandler(createReconcileHandler({
  ledger: primary.ledger,
  chain: payoutChain,
  authorized: true,
  now: () => Date.parse("2026-07-18T00:00:00.000Z"),
}), { method: "POST" });
assert.equal(reconcile.statusCode, 200);
assert.equal(reconcile.json().changes[0].to, "payout_due");
assert.equal((await primary.ledger.stats()).activeAtomic, "0");
assert.equal((await primary.ledger.stats()).payoutDueAtomic, "1000000");

const payoutTx = `0x${"4".repeat(64)}`;
const recordPayout = await callHandler(createRecordPayoutHandler({
  ledger: primary.ledger,
  chain: payoutChain,
  authorized: true,
  now: () => Date.parse("2026-07-18T00:01:00.000Z"),
}), {
  method: "POST",
  body: { receiptId: issuedReceiptId, transaction: payoutTx },
});
assert.equal(recordPayout.statusCode, 200);
assert.equal(recordPayout.json().state, "paid");
assert.equal((await primary.ledger.stats()).payoutDueAtomic, "0");

const payoutReplayLedger = new MemoryLedger();
for (const suffix of ["a", "b"]) {
  const pendingRecord = {
    receiptId: `receipt-${suffix}`,
    requestId: `request-${suffix}`,
    paymentId: `payment-${suffix}`,
    state: "pending",
    createdAt: "2026-07-10T10:00:00.000Z",
    liabilityAtomic: "100000",
  };
  assert.equal((await payoutReplayLedger.reserve(pendingRecord, 1_000_000n)).status, "reserved");
  await payoutReplayLedger.finalize({ ...pendingRecord, state: "active" });
  await payoutReplayLedger.markPayoutDue({ ...pendingRecord, state: "payout_due" });
}
const reusedPayoutTx = `0x${"5".repeat(64)}`;
await payoutReplayLedger.markPaid({
  ...(await payoutReplayLedger.get("receipt-a")),
  state: "paid",
  payout: { transaction: reusedPayoutTx },
});
await assert.rejects(
  payoutReplayLedger.markPaid({
    ...(await payoutReplayLedger.get("receipt-b")),
    state: "paid",
    payout: { transaction: reusedPayoutTx },
  }),
  /payout_transaction_exists/,
  "one payout transaction must not satisfy two receipts",
);

console.log("PolicyPool hardened API gate passed: payment, replay, target evidence, solvency, breach reconciliation, and verified payout.");
