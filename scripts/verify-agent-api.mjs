import assert from "node:assert/strict";
import handler from "../api/covered-job-receipt.js";
import { callHandler, decodePaymentRequired } from "./lib/fake-vercel.mjs";

const sampleBody = {
  targetAgent: "Foreman#4348",
  serviceDescription: "Launch readiness API for agent builders.",
  jobDescription: "Create a scoped readiness pack for a funded launch task.",
  requestedAction: "issue_coverage",
  paymentStatus: "funded",
  deadline: "2026-07-17T00:00:00.000Z",
  requestedCoverageUSDT: 5,
};

const head = await callHandler(handler, { method: "HEAD" });
assert.equal(head.statusCode, 200, "HEAD must return 200");

const unpaid = await callHandler(handler, { method: "POST", body: sampleBody });
assert.equal(unpaid.statusCode, 402, "unpaid request must return 402");
assert.ok(unpaid.headers["payment-required"], "unpaid response must expose PAYMENT-REQUIRED");
const challenge = decodePaymentRequired(unpaid.headers["payment-required"]);
assert.equal(challenge.x402Version, 2, "challenge must be x402 v2");
assert.equal(challenge.accepts[0].network, "eip155:196", "challenge must target X Layer");
assert.equal(challenge.accepts[0].amount, "1000000", "challenge must charge 1 USDT atomic units");
assert.equal(challenge.accepts[0].scheme, "exact", "challenge must use exact payment");
assert.ok(challenge.accepts[0].payTo.startsWith("0x"), "challenge payTo must be an EVM address");
assert.equal(challenge.outputSchema.input.method, "POST", "challenge must declare POST input schema");
assert.ok(challenge.outputSchema.input.body.required.includes("jobDescription"), "input schema must require jobDescription");
assert.equal(challenge.accepts[0].outputSchema.output.type, "json", "accepted method must expose JSON output schema");

const paid = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "local-gate-test" },
  body: sampleBody,
});
assert.equal(paid.statusCode, 200, "paid request must return 200");
assert.ok(paid.headers["payment-response"], "paid response must expose PAYMENT-RESPONSE");
const paidBody = paid.json();
assert.equal(paidBody.ok, true, "paid body ok");
assert.equal(paidBody.receipt.outcome.type, "ISSUED", "funded valid task should issue coverage");
assert.equal(paidBody.receipt.policy.guard.verdict, "ALLOW", "guard must allow funded valid task");
assert.match(paidBody.receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);

const declined = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "local-gate-test" },
  body: {
    ...sampleBody,
    paymentStatus: "unfunded",
  },
});
assert.equal(declined.json().receipt.outcome.type, "DECLINED", "unfunded task should be declined");
assert.equal(declined.json().receipt.policy.guard.verdict, "NEEDS_ESCROW");

const payout = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "local-gate-test" },
  body: {
    ...sampleBody,
    deadline: "2026-01-01T00:00:00.000Z",
    now: "2026-01-02T00:00:00.000Z",
    breachType: "deadline_missed",
  },
});
assert.equal(payout.json().receipt.outcome.type, "PAYOUT", "objective breach should produce payout record");
assert.equal(payout.json().receipt.outcome.status, "payout_due", "no tx hash means payout due, not falsely paid");

console.log("PolicyPool Agent Coverage API gate passed: HEAD 200, unpaid 402, paid 200, DECLINED/ISSUED/PAYOUT receipts.");
