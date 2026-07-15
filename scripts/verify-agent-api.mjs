import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createHandler } from "../api/covered-job-receipt.js";
import { createCoverageStatusHandler } from "../api/coverage-status.js";
import { createReconcileHandler } from "../api/reconcile-coverage.js";
import { createRecordPayoutHandler } from "../api/record-payout.js";
import { EvidenceError, validateServiceBinding } from "../api/lib/chain.js";
import { PAYMENT, paymentRequirements } from "../api/lib/config.js";
import { MemoryLedger } from "../api/lib/ledger.js";
import { createPaymentService } from "../api/lib/payment.js";
import { findPublishedPolicy, policyCoverageCapAtomic } from "../api/lib/policy-registry.js";
import { createQuoteService } from "../api/lib/quote.js";
import { sha256 } from "../api/lib/utils.js";
import { callHandler, decodePaymentRequired } from "./lib/fake-vercel.mjs";

const FIXED_NOW = Date.parse("2026-07-10T10:00:00.000Z");
const QUOTE_SECRET = "policypool-test-quote-secret-32-bytes-minimum";
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
  targetAmountAtomic = "5000000",
  createdAt = "2026-07-10T09:57:00.000Z",
  acceptedAt = "2026-07-10T09:59:30.000Z",
  clock = () => FIXED_NOW,
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
        amountAtomic: targetAmountAtomic,
        serviceHash: `0x${"0".repeat(64)}`,
        serviceType: "A2MCP",
        serviceTypeVerified: true,
        listedServiceIdMapping: "manual_external_evidence_required",
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
  const quoteService = createQuoteService({ ledger, secret: QUOTE_SECRET, now: clock });
  const handler = createHandler({
    ledger,
    chain,
    payment,
    quoteService,
    now: clock,
  });
  return { calls, handler, ledger, quoteService };
}

const primary = makeRuntime();
const head = await callHandler(primary.handler, { method: "HEAD" });
assert.equal(head.statusCode, 200, "HEAD must return 200");

const unpaid = await callHandler(primary.handler, { method: "POST", body: sampleBody });
assert.equal(unpaid.statusCode, 402, "unpaid request must return 402");
const challenge = decodePaymentRequired(unpaid.headers["payment-required"]);
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].network, "eip155:196");
assert.equal(challenge.accepts[0].amount, "100000");
assert.equal(challenge.accepts[0].extra.name, "USD₮0");
assert.equal(challenge.accepts[0].extra.version, "1");
assert.ok(challenge.outputSchema.input.body.required.includes("targetAcceptanceTxHash"));
assert.ok(challenge.outputSchema.input.body.required.includes("targetCreationTxHash"));
assert.equal(challenge.outputSchema.input.body.required.includes("deadline"), false);
assert.match(challenge.accepts[0].extra.policyPoolQuote, /^ppq_[a-f0-9]{32}\.[a-f0-9]{64}$/);
assert.equal(new URL(challenge.resource.url).searchParams.get("quote"), challenge.accepts[0].extra.policyPoolQuote);

const explicitBodyless = makeRuntime();
const explicitUnpaid = await callHandler(explicitBodyless.handler, {
  method: "POST",
  body: { ...sampleBody, targetJobId: `0x${"1".repeat(64)}` },
});
const explicitChallenge = decodePaymentRequired(explicitUnpaid.headers["payment-required"]);
const explicitBodylessResponse = await callHandler(explicitBodyless.handler, {
  method: "POST",
  headers: {
    "payment-signature": makePaymentHeader("explicit-bodyless", explicitChallenge.accepts[0]),
  },
});
assert.equal(explicitBodylessResponse.statusCode, 200, "a signed quote must survive an empty paid replay body");
assert.equal(explicitBodylessResponse.json().receipt.targetJob.jobId, `0x${"1".repeat(64)}`);
assert.equal(explicitBodylessResponse.json().receipt.coverageQuote.canonicalRequestRecovered, true);
assert.equal(explicitBodyless.calls.settle, 1);

const payerFallback = makeRuntime();
const foremanPolicy = findPublishedPolicy("Foreman#4348");
const fallbackQuote = await payerFallback.quoteService.issue({
  requestBody: { ...sampleBody, targetJobId: `0x${"2".repeat(64)}` },
  buyer: "0x1111111111111111111111111111111111111111",
  policyHash: foremanPolicy.policyHash,
  source: "verified_preflight",
});
const payerFallbackResponse = await callHandler(payerFallback.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("payer-fallback") },
});
assert.equal(payerFallbackResponse.statusCode, 200, "one payer-bound quote must recover a bodyless generic replay");
assert.equal(payerFallbackResponse.json().receipt.targetJob.jobId, `0x${"2".repeat(64)}`);
assert.equal(payerFallbackResponse.json().receipt.coverageQuote.id, fallbackQuote.id);
assert.equal(payerFallback.calls.verify, 1, "payer recovery must reuse one verified authorization");
assert.equal(payerFallback.calls.settle, 1);

const ambiguousFallback = makeRuntime();
for (const digit of ["3", "4"]) {
  await ambiguousFallback.quoteService.issue({
    requestBody: { ...sampleBody, targetJobId: `0x${digit.repeat(64)}` },
    buyer: "0x1111111111111111111111111111111111111111",
    policyHash: foremanPolicy.policyHash,
    source: "verified_preflight",
  });
}
const ambiguousResponse = await callHandler(ambiguousFallback.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("ambiguous-fallback") },
});
assert.equal(ambiguousResponse.statusCode, 400);
assert.equal(ambiguousResponse.json().error, "coverage_quote_ambiguous_for_payer");
assert.equal(ambiguousResponse.json().charged, false);
assert.equal(ambiguousFallback.calls.verify, 1);
assert.equal(ambiguousFallback.calls.settle, 0, "ambiguous payer recovery must never settle");
assert.equal((await ambiguousFallback.ledger.stats()).recordCount, 0);

let dedupeNow = FIXED_NOW;
const deduplicatedFallback = makeRuntime({ clock: () => dedupeNow });
const duplicateRequestBody = { ...sampleBody, targetJobId: `0x${"7".repeat(64)}` };
await deduplicatedFallback.quoteService.issue({
  requestBody: duplicateRequestBody,
  buyer: "0x1111111111111111111111111111111111111111",
  policyHash: foremanPolicy.policyHash,
  source: "verified_preflight",
});
dedupeNow += 1;
const latestDuplicateQuote = await deduplicatedFallback.quoteService.issue({
  requestBody: duplicateRequestBody,
  buyer: "0x1111111111111111111111111111111111111111",
  policyHash: foremanPolicy.policyHash,
  source: "verified_preflight",
});
const deduplicatedResponse = await callHandler(deduplicatedFallback.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("deduplicated-fallback") },
});
assert.equal(deduplicatedResponse.statusCode, 200, "retried quotes for one canonical request must not become ambiguous");
assert.equal(deduplicatedResponse.json().receipt.coverageQuote.id, latestDuplicateQuote.id);
assert.equal(deduplicatedFallback.calls.settle, 1);

const buyerMismatch = makeRuntime();
const mismatchedQuote = await buyerMismatch.quoteService.issue({
  requestBody: { ...sampleBody, targetJobId: `0x${"5".repeat(64)}` },
  buyer: "0x2222222222222222222222222222222222222222",
  policyHash: foremanPolicy.policyHash,
  source: "verified_preflight",
});
const mismatchRequirements = {
  ...paymentRequirements(),
  extra: { ...paymentRequirements().extra, policyPoolQuote: mismatchedQuote.token },
};
const buyerMismatchResponse = await callHandler(buyerMismatch.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("buyer-mismatch", mismatchRequirements) },
});
assert.equal(buyerMismatchResponse.statusCode, 400);
assert.equal(buyerMismatchResponse.json().error, "coverage_quote_buyer_mismatch");
assert.equal(buyerMismatchResponse.json().charged, false);
assert.equal(buyerMismatch.calls.settle, 0);

const changedPolicy = makeRuntime();
const stalePolicyQuote = await changedPolicy.quoteService.issue({
  requestBody: { ...sampleBody, targetJobId: `0x${"8".repeat(64)}` },
  buyer: "0x1111111111111111111111111111111111111111",
  policyHash: `sha256:${"0".repeat(64)}`,
  source: "verified_preflight",
});
const changedPolicyRequirements = {
  ...paymentRequirements(),
  extra: { ...paymentRequirements().extra, policyPoolQuote: stalePolicyQuote.token },
};
const changedPolicyResponse = await callHandler(changedPolicy.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("changed-policy", changedPolicyRequirements) },
});
assert.equal(changedPolicyResponse.statusCode, 409);
assert.equal(changedPolicyResponse.json().error, "coverage_quote_policy_changed");
assert.equal(changedPolicyResponse.json().charged, false);
assert.equal(changedPolicy.calls.verify, 0);
assert.equal(changedPolicy.calls.settle, 0);

let expiringNow = FIXED_NOW;
const expiredQuoteRuntime = makeRuntime({ clock: () => expiringNow });
const expiringQuote = await expiredQuoteRuntime.quoteService.issue({
  requestBody: { ...sampleBody, targetJobId: `0x${"6".repeat(64)}` },
  buyer: "0x1111111111111111111111111111111111111111",
  policyHash: foremanPolicy.policyHash,
  source: "verified_preflight",
});
expiringNow += 601_000;
const expiredRequirements = {
  ...paymentRequirements(),
  extra: { ...paymentRequirements().extra, policyPoolQuote: expiringQuote.token },
};
const expiredQuoteResponse = await callHandler(expiredQuoteRuntime.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("expired-quote", expiredRequirements) },
});
assert.equal(expiredQuoteResponse.statusCode, 400);
assert.equal(expiredQuoteResponse.json().error, "coverage_quote_expired");
assert.equal(expiredQuoteRuntime.calls.verify, 0);
assert.equal(expiredQuoteRuntime.calls.settle, 0);

const originalToken = challenge.accepts[0].extra.policyPoolQuote;
const tamperedToken = `${originalToken.slice(0, -1)}${originalToken.endsWith("0") ? "1" : "0"}`;
const tamperedQuote = await callHandler(makeRuntime().handler, {
  method: "POST",
  query: { quote: tamperedToken },
});
assert.equal(tamperedQuote.statusCode, 400);
assert.equal(tamperedQuote.json().error, "coverage_quote_invalid");
assert.equal(tamperedQuote.json().charged, false);

const discovery = await callHandler(primary.handler, { method: "GET" });
assert.equal(discovery.statusCode, 402, "anonymous discovery must still return the payment challenge");

const missingTarget = await callHandler(primary.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("missing-target") },
  body: { jobDescription: "Missing a target agent." },
});
assert.equal(missingTarget.statusCode, 400, "a paid replay without a target must fail before payment verification");
assert.equal(missingTarget.json().error, "target_agent_required");
assert.equal(missingTarget.json().charged, false);
assert.equal(primary.calls.verify, 0);
assert.equal(primary.calls.settle, 0);

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

const belowMinimumPaid = makeRuntime();
const belowMinimumPaidResponse = await callHandler(belowMinimumPaid.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("below-minimum-paid") },
  body: {
    ...sampleBody,
    targetJobId: `0x${"8".repeat(64)}`,
    requestedCoverageUSDT: "0.49",
  },
});
assert.equal(belowMinimumPaidResponse.statusCode, 400);
assert.equal(belowMinimumPaidResponse.json().error, "requested_coverage_below_minimum");
assert.equal(belowMinimumPaidResponse.json().charged, false);
assert.equal(belowMinimumPaidResponse.json().minimumCoverageUSDT, "0.5");
assert.equal(belowMinimumPaid.calls.verify, 0, "static coverage errors must fail before payment verification");
assert.equal(belowMinimumPaid.calls.settle, 0, "below-minimum coverage must not settle payment");
assert.equal(belowMinimumPaid.calls.target, 0, "below-minimum coverage must not perform target verification");
assert.equal((await belowMinimumPaid.ledger.stats()).recordCount, 0, "below-minimum coverage must not write a receipt");

const halfDollarTarget = makeRuntime({ targetAmountAtomic: "500000" });
const halfDollarTargetResponse = await callHandler(halfDollarTarget.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("half-dollar-target") },
  body: {
    ...sampleBody,
    targetJobId: `0x${"5".repeat(64)}`,
    requestedCoverageUSDT: "0.5",
  },
});
assert.equal(halfDollarTargetResponse.statusCode, 200);
assert.equal(halfDollarTargetResponse.json().receipt.outcome.type, "ISSUED");
assert.equal(halfDollarTargetResponse.json().receipt.covenant.coverageCapUSDT, "0.5");
assert.equal((await halfDollarTarget.ledger.stats()).activeAtomic, "500000");
assert.equal(halfDollarTarget.calls.settle, 1);

const nestedBuyer = makeRuntime({ targetAmountAtomic: "500000" });
const nestedBuyerResponse = await callHandler(nestedBuyer.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("nested-buyer") },
  body: {
    agentId: "4674",
    request: {
      targetAgent: "4348",
      taskId: `0x${"6".repeat(64)}`,
      jobCreationTxHash: CREATION_TX,
      jobAcceptanceTxHash: ACCEPTANCE_TX,
      scope: "Create a launch readiness verdict and proof checklist for AgentForge.",
      coverageAmountUSDT: "0.5",
    },
  },
});
assert.equal(nestedBuyerResponse.statusCode, 200, "nested automated-buyer input must be preserved");
assert.equal(nestedBuyerResponse.json().receipt.target.agentName, "Foreman");
assert.equal(nestedBuyerResponse.json().receipt.targetJob.jobId, `0x${"6".repeat(64)}`);
assert.equal(nestedBuyerResponse.json().receipt.covenant.coverageCapUSDT, "0.5");
assert.equal(nestedBuyer.calls.verify, 1);
assert.equal(nestedBuyer.calls.settle, 1);

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
assert.equal(paidBody.receipt.guard.derivedCoverageDeadline, "2026-07-10T10:04:30.000Z");
assert.equal(paidBody.receipt.servicePayment.settled, true);
assert.equal(paidBody.receipt.target.slaSeconds, 300);
assert.equal(paidBody.receipt.target.serviceType, "A2MCP");
assert.equal(paidBody.receipt.targetJob.serviceTypeVerified, true);
assert.equal(paidBody.receipt.targetJob.listedServiceIdMapping, "manual_external_evidence_required");
assert.equal(paidBody.receipt.covenant.deadline, "2026-07-10T10:04:30.000Z");
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
assert.equal(unregisteredResponse.statusCode, 422);
assert.equal(unregisteredResponse.json().error, "target_policy_not_registered");
assert.equal(unregisteredResponse.json().charged, false);
assert.equal(unregistered.calls.verify, 0, "unknown policy must not reach payment verification");
assert.equal(unregistered.calls.settle, 0, "unknown policy must not settle payment");
assert.equal(unregistered.calls.target, 0, "unknown policy must not reach target verifier");

const wardenPolicy = findPublishedPolicy("Warden#3808");
assert.ok(wardenPolicy, "Warden provider opt-in must be registered");
assert.equal(wardenPolicy.serviceIds[0], "33461");
assert.equal(policyCoverageCapAtomic(wardenPolicy, "5000000"), 500000n);
const pendingWardenRuntime = makeRuntime();
const pendingWardenResponse = await callHandler(pendingWardenRuntime.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("pending-warden-clock") },
  body: {
    ...sampleBody,
    targetAgent: "Warden#3808",
    targetJobId: `0x${"d".repeat(64)}`,
    jobDescription: "Run the standard 20-payload endpoint security audit battery.",
    requestedCoverageUSDT: "0.5",
  },
});
assert.equal(pendingWardenResponse.statusCode, 400);
assert.equal(pendingWardenResponse.json().error, "provider_clock_evidence_not_supported");
assert.equal(pendingWardenResponse.json().charged, false);
assert.equal(pendingWardenRuntime.calls.verify, 0, "pending clock policies must not verify payment");
assert.equal(pendingWardenRuntime.calls.settle, 0, "pending clock policies must not settle payment");
assert.equal(pendingWardenRuntime.calls.target, 0, "pending clock policies must not verify a target job");
assert.equal((await pendingWardenRuntime.ledger.stats()).recordCount, 0);

const nonzeroServiceHash = `0x${"c".repeat(64)}`;
const zeroServiceHash = `0x${"0".repeat(64)}`;
assert.equal(
  validateServiceBinding({ serviceType: "A2A" }, nonzeroServiceHash).serviceTypeVerified,
  true,
);
assert.equal(
  validateServiceBinding({ serviceType: "A2MCP" }, zeroServiceHash).serviceTypeVerified,
  true,
);
assert.throws(
  () => validateServiceBinding({ serviceType: "A2A" }, zeroServiceHash),
  (error) => error?.code === "target_service_hash_missing_for_a2a",
);
assert.throws(
  () => validateServiceBinding({ serviceType: "A2MCP" }, nonzeroServiceHash),
  (error) => error?.code === "target_service_hash_unexpected_for_a2mcp",
);

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
assert.equal(outsideScopeResponse.statusCode, 400);
assert.equal(outsideScopeResponse.json().error, "job_outside_registered_policy");
assert.equal(outsideScopeResponse.json().charged, false);
assert.equal(outsideScope.calls.verify, 0, "out-of-policy jobs must fail before payment verification");
assert.equal(outsideScope.calls.settle, 0, "out-of-policy jobs must never settle");
assert.equal(outsideScope.calls.target, 0, "out-of-policy jobs must not reach target verifier");
assert.equal((await outsideScope.ledger.stats()).recordCount, 0, "out-of-policy jobs must not write a receipt");

const missingEvidence = makeRuntime();
const missingEvidenceResponse = await callHandler(missingEvidence.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("missing-evidence") },
  body: {
    targetAgent: "Foreman#4348",
    jobDescription: "Create a launch readiness verdict and proof checklist.",
    requestedCoverageUSDT: "0.5",
  },
});
assert.equal(missingEvidenceResponse.statusCode, 400);
assert.equal(missingEvidenceResponse.json().error, "target_job_id_required");
assert.equal(missingEvidenceResponse.json().charged, false);
assert.equal(missingEvidence.calls.verify, 0);
assert.equal(missingEvidence.calls.settle, 0);
assert.equal((await missingEvidence.ledger.stats()).recordCount, 0);

const invalidEvidence = makeRuntime({ targetError: "target_job_not_accepted:2" });
const invalidEvidenceResponse = await callHandler(invalidEvidence.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("invalid-evidence") },
  body: { ...sampleBody, targetJobId: `0x${"1".repeat(64)}` },
});
assert.equal(invalidEvidenceResponse.statusCode, 400);
assert.equal(invalidEvidenceResponse.json().error, "target_job_not_accepted:2");
assert.equal(invalidEvidenceResponse.json().charged, false);
assert.equal(invalidEvidence.calls.verify, 1, "chain evidence requires a verified payer but must not settle on failure");
assert.equal(invalidEvidence.calls.settle, 0);
assert.equal((await invalidEvidence.ledger.stats()).recordCount, 0);

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
assert.equal(elapsedSlaResponse.statusCode, 400);
assert.equal(elapsedSlaResponse.json().error, "registered_policy_sla_already_elapsed");
assert.equal(elapsedSlaResponse.json().charged, false);
assert.equal(elapsedSla.calls.settle, 0);
assert.equal((await elapsedSla.ledger.stats()).recordCount, 0);

const closedEnrollment = makeRuntime({ acceptedAt: "2026-07-10T09:58:30.000Z" });
const closedEnrollmentResponse = await callHandler(closedEnrollment.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("closed-enrollment") },
  body: { ...sampleBody, targetJobId: `0x${"c".repeat(64)}` },
});
assert.equal(closedEnrollmentResponse.statusCode, 400);
assert.equal(closedEnrollmentResponse.json().error, "coverage_enrollment_window_closed");
assert.equal(closedEnrollmentResponse.json().charged, false);
assert.equal(closedEnrollment.calls.settle, 0);
assert.equal((await closedEnrollment.ledger.stats()).recordCount, 0);

const noReserve = makeRuntime({ reserveAtomic: 0n });
const noReserveResponse = await callHandler(noReserve.handler, {
  method: "POST",
  headers: { "payment-signature": makePaymentHeader("no-reserve") },
  body: { ...sampleBody, targetJobId: `0x${"2".repeat(64)}` },
});
assert.equal(noReserveResponse.statusCode, 409);
assert.equal(noReserveResponse.json().error, "insufficient_uncommitted_reserve");
assert.equal(noReserveResponse.json().charged, false);
assert.equal(noReserve.calls.settle, 0);
assert.equal((await noReserve.ledger.stats()).recordCount, 0);

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
const adminStoppedDryRun = await callHandler(createReconcileHandler({
  ledger: adminStopped.ledger,
  chain: { async getJobStatus() { return 5; } },
  authorized: true,
  now: () => FIXED_NOW,
}), { method: "POST", body: { dryRun: true } });
assert.equal(adminStoppedDryRun.statusCode, 200);
assert.equal(adminStoppedDryRun.json().dryRun, true);
assert.deepEqual(adminStoppedDryRun.json().changes, [{
  receiptId: adminStoppedReceiptId,
  from: "active",
  to: "released",
}]);
assert.equal((await adminStopped.ledger.get(adminStoppedReceiptId)).state, "active", "dry-run must not mutate a receipt");
assert.equal((await adminStopped.ledger.stats()).committedAtomic, "1000000", "dry-run must not release reserve");

const reconciliationNotifications = [];
const adminStoppedReconcile = await callHandler(createReconcileHandler({
  ledger: adminStopped.ledger,
  chain: { async getJobStatus() { return 5; } },
  authorized: true,
  now: () => FIXED_NOW,
  notifier: {
    async send(message) {
      reconciliationNotifications.push(message);
      return { sent: true };
    },
  },
}), { method: "POST" });
assert.equal(adminStoppedReconcile.statusCode, 200);
assert.deepEqual(adminStoppedReconcile.json().changes, [{
  receiptId: adminStoppedReceiptId,
  from: "active",
  to: "released",
}]);
assert.equal((await adminStopped.ledger.stats()).committedAtomic, "0");
assert.equal((await adminStopped.ledger.get(adminStoppedReceiptId)).release.reason, "platform_job_admin_stopped");
assert.equal(adminStoppedReconcile.json().notification.sent, true);
assert.match(reconciliationNotifications[0], /active -> released/);

const previousOperatorToken = process.env.POLICYPOOL_OPERATOR_TOKEN;
process.env.POLICYPOOL_OPERATOR_TOKEN = "test-reconcile-token";
let qstashVerified = false;
const qstashAuthorized = await callHandler(createReconcileHandler({
  ledger: new MemoryLedger(),
  chain: { async getJobStatus() { return 1; } },
  qstashCurrentSigningKey: "current-key",
  qstashNextSigningKey: "next-key",
  qstashReceiver: {
    async verify({ signature, body, url }) {
      qstashVerified = signature === "valid-signature" && body === "" && url.endsWith("/api/reconcile-coverage");
      return qstashVerified;
    },
  },
}), {
  method: "GET",
  url: "/api/reconcile-coverage",
  headers: {
    authorization: "Bearer test-reconcile-token",
    host: "policypool.test",
    "upstash-signature": "valid-signature",
  },
});
assert.equal(qstashAuthorized.statusCode, 200);
assert.equal(qstashVerified, true, "QStash requests must verify their signed body and destination URL");
if (typeof previousOperatorToken === "undefined") delete process.env.POLICYPOOL_OPERATOR_TOKEN;
else process.env.POLICYPOOL_OPERATOR_TOKEN = previousOperatorToken;

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
assert.equal(statusBeforeDeadline.json().liabilityAtomic, "1000000");
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
