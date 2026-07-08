import assert from "node:assert/strict";

const endpoint = process.env.POLICYPOOL_AGENT_ENDPOINT || "https://policypool.vercel.app/api/covered-job-receipt";

const sampleBody = {
  targetAgent: "LiveProbe#1",
  serviceDescription: "Software utility that returns policy receipts for funded agent jobs.",
  jobDescription: "Create a scoped covered-job receipt for a funded software task.",
  requestedAction: "issue_coverage",
  paymentStatus: "funded",
  deadline: "2026-07-17T00:00:00.000Z",
  requestedCoverageUSDT: 5,
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
assert.equal(challenge.accepts[0].amount, "1000000");
assert.equal(challenge.outputSchema.input.method, "POST");

const paid = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "payment-signature": "live-verifier-dummy-paid-replay",
  },
  body: JSON.stringify(sampleBody),
});
assert.equal(paid.status, 200, `paid replay expected 200, got ${paid.status}`);
const paidJson = await paid.json();
assert.equal(paidJson.receipt.outcome.type, "ISSUED");
assert.equal(paidJson.receipt.policy.guard.verdict, "ALLOW");
assert.match(paidJson.receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);

console.log(`PolicyPool live agent verifier passed: ${endpoint}`);
