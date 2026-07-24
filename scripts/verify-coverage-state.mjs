import assert from "node:assert/strict";
import {
  COVERAGE_STATES,
  describeFailure,
  enrichCoverageResponse,
} from "../api/lib/coverage-state.js";

const correlationId = "test-correlation-id";
const enrich = (payload) => enrichCoverageResponse(payload, { correlationId });

// A free preflight that found the target coverable must never read as covered.
const eligible = enrich({
  ok: true,
  eligible: true,
  charged: false,
  coverage: { capUSDT: "0.5" },
});
assert.equal(eligible.coverageState, COVERAGE_STATES.COVERABLE_NOT_PURCHASED);
assert.equal(eligible.covered, false);
assert.equal(eligible.paymentMade, false);
assert.equal(eligible.receiptIssued, false);
assert.equal(eligible.nextAction, "PURCHASE_COVERAGE");
assert.deepEqual(eligible.coverage, { capUSDT: "0.5" });

// A resolved target must explain itself rather than emitting a bare status number.
const completed = enrich({ ok: true, eligible: false, charged: false, reason: "target_job_not_accepted:6" });
assert.equal(completed.coverageState, COVERAGE_STATES.NOT_COVERABLE);
assert.equal(completed.code, "TARGET_ALREADY_RESOLVED");
assert.equal(completed.targetState, "complete");
assert.equal(completed.retryable, false);
assert.equal(completed.charged, false);
assert.match(completed.message, /no longer be covered/);

// A target awaiting provider acceptance is retryable; a resolved one is not.
const notYet = enrich({ ok: false, error: "target_job_not_accepted:0", charged: false });
assert.equal(notYet.code, "TARGET_NOT_YET_ACCEPTED");
assert.equal(notYet.retryable, true);
assert.equal(notYet.retryAfterSeconds, 15);
assert.equal(notYet.targetState, "created");

// Public-index latency must be retryable and must not invite a duplicate task.
const indexing = enrich({ ok: false, error: "okx_task_acceptance_timestamp_missing", charged: false });
assert.equal(indexing.code, "ACCEPTANCE_EVIDENCE_PENDING");
assert.equal(indexing.retryable, true);
assert.equal(indexing.retryAfterSeconds, 10);
assert.match(indexing.nextAction, /Do not create another marketplace task/);

// Receipt lifecycle states.
const active = enrich({ ok: true, receiptId: "ppc-active", state: "active" });
assert.equal(active.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE);
assert.equal(active.covered, true);
assert.equal(active.paymentMade, true);
assert.equal(active.receiptIssued, true);

const released = enrich({ ok: true, receiptId: "ppc-released", state: "released" });
assert.equal(released.coverageState, COVERAGE_STATES.COVERAGE_RELEASED);
assert.equal(released.covered, false, "a released receipt is terminal, not in force");
assert.equal(released.paymentMade, true);

const paid = enrich({ ok: true, receiptId: "ppc-paid", state: "paid" });
assert.equal(paid.coverageState, COVERAGE_STATES.PAID_OUT);
assert.equal(paid.covered, false);
assert.equal(paid.paymentMade, true);
assert.equal(paid.nextAction, "NONE_PAYOUT_COMPLETE");

const payoutDue = enrich({ ok: true, receiptId: "ppc-due", state: "payout_due" });
assert.equal(payoutDue.coverageState, COVERAGE_STATES.PAYOUT_DUE);
assert.equal(payoutDue.covered, true, "an unpaid obligation is still in force");
assert.equal(payoutDue.nextAction, "AWAIT_PAYOUT");

// Nested receipt shape (coverage-status returns receipt.state).
const nested = enrich({ ok: true, receipt: { receiptId: "ppc-nested", state: "active" } });
assert.equal(nested.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE);
assert.equal(nested.receiptIssued, true);

// Additive only: existing fields are never overwritten.
const preserved = enrich({
  ok: false,
  error: "target_job_not_accepted:6",
  charged: true,
  code: "CALLER_SUPPLIED",
  message: "caller supplied",
  nextAction: "CALLER_SUPPLIED_ACTION",
  correlationId: "caller-supplied-id",
});
assert.equal(preserved.code, "CALLER_SUPPLIED");
assert.equal(preserved.message, "caller supplied");
assert.equal(preserved.nextAction, "CALLER_SUPPLIED_ACTION");
assert.equal(preserved.correlationId, "caller-supplied-id");
assert.equal(preserved.charged, true, "an existing charged flag must survive enrichment");

// Every original key must survive with an identical value.
const original = {
  ok: true,
  eligible: true,
  charged: false,
  task: { id: "414525", nested: { deep: true } },
  quote: { id: "q1", token: "t1" },
};
const enrichedOriginal = enrich(original);
for (const [key, value] of Object.entries(original)) {
  assert.deepEqual(enrichedOriginal[key], value, `key ${key} must be preserved`);
}
assert.deepEqual(original, {
  ok: true,
  eligible: true,
  charged: false,
  task: { id: "414525", nested: { deep: true } },
  quote: { id: "q1", token: "t1" },
}, "enrichment must not mutate the input payload");

// Unknown codes degrade safely instead of throwing.
const unknown = describeFailure("some_new_failure_mode");
assert.equal(unknown.code, "SOME_NEW_FAILURE_MODE");
assert.equal(unknown.retryable, false);

// Non-object and unrecognised payloads pass through untouched.
assert.equal(enrich(null), null);
assert.equal(enrich("string"), "string");
assert.deepEqual(enrich({ ok: true }), { ok: true }, "payloads with no lifecycle signal are untouched");

console.log("coverage state contract verified");
