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

// The v0.4 universal reconciler persists terminal states beyond the v0.3 set.
// These must never be reported as coverage in force.
const recovered = enrich({ ok: true, receiptId: "ppc-recovered", state: "recovered_without_payout" });
assert.equal(recovered.coverageState, COVERAGE_STATES.COVERAGE_RELEASED);
assert.equal(recovered.covered, false, "a recovered covenant is settled, not in force");

const cancelledUnpaid = enrich({ ok: true, receiptId: "ppc-cancelled", state: "cancelled_unpaid" });
assert.equal(cancelledUnpaid.coverageState, COVERAGE_STATES.COVERAGE_CANCELLED);
assert.equal(cancelledUnpaid.covered, false);
assert.equal(cancelledUnpaid.paymentMade, false, "an unpaid cancellation never captured a fee");

// An unfamiliar ledger state must fail closed rather than inherit the receipt
// heuristic, which previously reported any unknown state as active.
for (const unknown of ["some_future_state", "constructor", "toString", "   "]) {
  const view = enrich({ ok: true, receiptId: "ppc-unknown", state: unknown });
  assert.equal(view.covered, false, `state "${unknown}" must never report coverage in force`);
  assert.notEqual(view.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE, `state "${unknown}" must not be active`);
}

// `compensation_required` is the cleanup state for aborted, unconfirmed, or
// unsettled issuance. It must never claim a payout is owed for coverage that
// may never have existed.
const compensation = enrich({ ok: true, receiptId: "ppc-compensation", state: "compensation_required" });
assert.equal(compensation.coverageState, COVERAGE_STATES.RECONCILIATION_PENDING);
assert.equal(compensation.covered, false, "an unresolved cleanup record is not coverage in force");
assert.equal(compensation.paymentMade, false, "the fee may never have been captured");
assert.notEqual(compensation.nextAction, "AWAIT_PAYOUT");

// A reserved receipt id is not an issued receipt. Several failure paths return
// one before any receipt document exists.
const reservedId = enrich({
  ok: false,
  error: "payment_settled_receipt_pending_reconciliation",
  receiptId: "ppc-reserved",
  charged: false,
});
assert.equal(reservedId.receiptIssued, false, "a bare receipt id must not report an issued receipt");
assert.equal(reservedId.covered, false);

// The paid endpoint carries its ledger state, so replays and relay covenants
// awaiting a clock are not described as coverage in force.
const relayPending = enrich({ ok: true, state: "pending_start", receipt: { receiptId: "ppc-relay" } });
assert.equal(relayPending.coverageState, COVERAGE_STATES.PAYMENT_PENDING);
assert.equal(relayPending.covered, false, "a relay covenant awaiting its clock is not yet in force");

for (const [ledgerState, expected] of [["released", COVERAGE_STATES.COVERAGE_RELEASED], ["paid", COVERAGE_STATES.PAID_OUT]]) {
  const replay = enrich({ ok: true, state: ledgerState, idempotentReplay: true, receipt: { receiptId: "ppc-replay" } });
  assert.equal(replay.coverageState, expected, `a replay of a ${ledgerState} record must report ${expected}`);
  assert.equal(replay.covered, false, `a replayed ${ledgerState} record is terminal, not in force`);
}

// A genuinely fresh issuance still reports active.
const freshIssue = enrich({ ok: true, state: "active", receipt: { receiptId: "ppc-fresh" } });
assert.equal(freshIssue.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE);
assert.equal(freshIssue.covered, true);

// Invariant: across every state this module can produce from a ledger value,
// only an active covenant or an unpaid obligation is ever "in force".
const inForce = new Set();
for (const ledgerState of [
  "pending_start", "pending", "active", "released", "payout_due", "compensation_required",
  "paid", "expired", "cancelled", "cancelled_unpaid", "recovered_without_payout", "mystery",
]) {
  const view = enrich({ ok: true, receiptId: "ppc-invariant", state: ledgerState });
  if (view.covered) inForce.add(view.coverageState);
}
assert.deepEqual(
  [...inForce].sort(),
  [COVERAGE_STATES.COVERAGE_ACTIVE, COVERAGE_STATES.PAYOUT_DUE].sort(),
  "only an active covenant or an owed payout may report coverage in force",
);

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
