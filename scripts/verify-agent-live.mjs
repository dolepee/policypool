import assert from "node:assert/strict";

const baseUrl = process.env.POLICYPOOL_BASE_URL || "https://policypool.vercel.app";
const endpoint = `${baseUrl}/api/covered-job-receipt`;
const ledgerEndpoint = `${baseUrl}/api/coverage-ledger`;

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
assert.equal(challenge.accepts[0].amount, "1000000");
assert.equal(challenge.accepts[0].extra.name, "USD₮0");
assert.equal(challenge.accepts[0].extra.version, "1");
assert.equal(challenge.outputSchema.input.body.required.includes("deadline"), false);

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

console.log(`PolicyPool live fail-closed verifier passed: ${endpoint}`);
console.log("No payment was signed or spent by this no-secret verifier.");
