import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COVERAGE_STATES,
  describeFailure,
  enrichCoverageResponse,
} from "../api/lib/coverage-state.js";

const correlationId = "test-correlation-id";
const enrich = (payload, options = {}) => enrichCoverageResponse(payload, { correlationId, ...options });

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

// Withdrawal of the public evidence is a different condition from latency. OKX
// stopped publishing the acceptance timeline and the on-chain task id on the
// anonymous task page, so advertising a retry here would loop a buyer agent
// forever against a page that will never carry the field again.
for (const error of ["okx_task_timeline_unavailable", "okx_task_onchain_id_unavailable"]) {
  const withdrawn = enrich({ ok: false, error, charged: false });
  assert.equal(withdrawn.code, "PUBLIC_TASK_EVIDENCE_UNAVAILABLE", error);
  assert.equal(withdrawn.retryable, false, `${error} must not advertise a retry`);
  assert.equal(withdrawn.retryAfterSeconds, undefined, `${error} must not carry a retry delay`);
  assert.equal(withdrawn.charged, false);
  assert.equal(withdrawn.covered, false);
  assert.equal(withdrawn.receiptIssued, false);
  assert.match(withdrawn.nextAction, /No payment was taken/);
  assert.match(withdrawn.nextAction, /no task should be recreated/);
  // A dead end would be honest but useless. The paid endpoint accepts resolved
  // on-chain evidence and never reads the public task page, so that path is
    // unaffected and is the one a caller should be sent to. Lead with the bounded
    // event resolver, while retaining exact transactions as the fallback.
    for (const field of [
      "targetAgent",
      "targetJobId",
      "targetCreatedAt",
      "jobDescription",
    ]) {
      assert.match(withdrawn.nextAction, new RegExp(field), `${error} must name ${field}`);
    }
    assert.match(withdrawn.nextAction, /exact creation and acceptance transactions/i);
    assert.match(withdrawn.nextAction, /free \/api\/coverage-preflight/);
  }

const incompleteEventHint = enrich({
  ok: false,
  error: "event_hint_evidence_incomplete",
  charged: false,
  required: ["targetAgent", "targetJobId", "targetCreatedAt", "jobDescription"],
});
assert.equal(incompleteEventHint.code, "EVENT_HINT_EVIDENCE_INCOMPLETE");
assert.equal(incompleteEventHint.retryable, false);
assert.match(incompleteEventHint.nextAction, /targetAcceptedAt/);

for (const [error, code, field] of [
  ["target_creation_time_hint_in_future", "CREATION_TIME_HINT_IN_FUTURE", "targetCreatedAt"],
  ["target_acceptance_time_hint_in_future", "ACCEPTANCE_TIME_HINT_IN_FUTURE", "targetAcceptedAt"],
  ["target_event_timestamp_invalid", "EVENT_TIME_HINT_INVALID", "ISO-8601"],
  ["target_event_timeline_invalid", "EVENT_TIMELINE_INVALID", "event-time hints"],
]) {
  const invalidHint = enrich({ ok: true, eligible: false, reason: error, charged: false });
  assert.equal(invalidHint.code, code);
  assert.equal(invalidHint.retryable, false);
  assert.match(invalidHint.nextAction, new RegExp(field));
}

const lateAcceptance = enrich({
  ok: true,
  eligible: false,
  reason: "target_acceptance_time_hint_required",
  charged: false,
});
assert.equal(lateAcceptance.code, "ACCEPTANCE_TIME_HINT_REQUIRED");
assert.equal(lateAcceptance.retryable, false);
assert.match(lateAcceptance.nextAction, /targetAcceptedAt/);

for (const [error, code] of [
  ["target_event_not_found", "TARGET_EVENT_NOT_FOUND"],
  ["target_event_ambiguous", "TARGET_EVENT_AMBIGUOUS"],
]) {
  const eventFailure = enrich({ ok: true, eligible: false, reason: error, charged: false });
  assert.equal(eventFailure.code, code);
  assert.equal(eventFailure.retryable, false);
}

for (const error of ["target_block_calibration_failed", "target_event_search_window_invalid"]) {
  const resolverOutage = enrich({ ok: false, error, charged: false }, { httpStatus: 503 });
  assert.equal(resolverOutage.code, "CHAIN_EVIDENCE_PENDING");
  assert.equal(resolverOutage.retryable, true);
  assert.equal(resolverOutage.retryAfterSeconds, 15);
  assert.match(resolverOutage.nextAction, /do not change the input/i);
}

const unregistered = enrich({
  ok: false,
  error: "target_policy_not_registered",
  charged: false,
  coverableTargets: [{ agentId: "3465" }],
}, { httpStatus: 422 });
assert.equal(unregistered.code, "TARGET_POLICY_NOT_REGISTERED");
assert.equal(unregistered.retryable, false);
assert.match(unregistered.message, /no published coverage policy/i);
assert.match(unregistered.nextAction, /coverableTargets/);
assert.deepEqual(unregistered.coverableTargets, [{ agentId: "3465" }]);

const missingTransaction = enrich({
  ok: true,
  eligible: false,
  reason: "transaction_not_found",
  charged: false,
});
assert.equal(missingTransaction.code, "TRANSACTION_NOT_FOUND");
assert.equal(missingTransaction.retryable, false);
assert.match(missingTransaction.nextAction, /check the transaction hash and chain/i);

const pendingTransaction = enrich(
  { ok: false, error: "transaction_unconfirmed", charged: false },
  { httpStatus: 503 },
);
assert.equal(pendingTransaction.code, "CHAIN_EVIDENCE_PENDING");
assert.equal(pendingTransaction.retryable, true);
assert.equal(pendingTransaction.retryAfterSeconds, 15);

const transactionLookupDown = enrich(
  { ok: false, error: "transaction_lookup_unavailable", charged: false },
  { httpStatus: 503 },
);
assert.equal(transactionLookupDown.code, "CHAIN_LOOKUP_UNAVAILABLE");
assert.equal(transactionLookupDown.retryable, true);
assert.match(transactionLookupDown.nextAction, /do not change the input/i);

// Receipt lifecycle states.
const active = enrich({ ok: true, receiptId: "ppc-active", state: "active", receipt: { receiptId: "ppc-active" } });
assert.equal(active.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE);
assert.equal(active.covered, true);
assert.equal(active.paymentMade, true);
assert.equal(active.receiptIssued, true);

const declined = enrich({
  ok: true,
  receiptId: "ppc-declined",
  state: "declined",
  receipt: { receiptId: "ppc-declined" },
});
assert.equal(declined.coverageState, COVERAGE_STATES.COVERAGE_DECLINED);
assert.equal(declined.covered, false, "a declined receipt creates no coverage liability");
assert.equal(declined.paymentMade, true, "the decline receipt is produced after service-fee settlement");
assert.equal(declined.receiptIssued, true);
assert.equal(declined.nextAction, "NONE_COVERAGE_NOT_ISSUED");

// Finalisation can fail after settlement, leaving a record whose state is later
// synchronised to a purchased value while it still carries no receipt document.
// The state must not manufacture a receipt an agent would then go looking for.
const purchasedWithoutDocument = enrich({ ok: true, receiptId: "ppc-nodoc", state: "active" });
assert.equal(purchasedWithoutDocument.covered, true, "the ledger state still governs coverage");
assert.equal(
  purchasedWithoutDocument.receiptIssued,
  false,
  "a purchased state must not imply a receipt document that does not exist",
);

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
assert.equal(relayPending.coverageState, COVERAGE_STATES.AWAITING_CLOCK_START);
assert.equal(relayPending.covered, false, "a relay covenant awaiting its clock is not yet in force");
assert.equal(relayPending.paymentMade, true, "pending_start is written only after the fee settles");

// The pre-settlement ledger reservation is a different thing entirely: nothing
// has been paid and no receipt exists, so it must claim neither.
const reserved = enrich({ ok: true, receiptId: "ppc-reserved-record", state: "pending" });
assert.equal(reserved.coverageState, COVERAGE_STATES.PAYMENT_NOT_SETTLED);
assert.equal(reserved.covered, false);
assert.equal(reserved.paymentMade, false, "a reservation before settlement has not been paid");
assert.equal(reserved.receiptIssued, false, "no receipt exists before settlement");
assert.equal(reserved.nextAction, "COMPLETE_PAYMENT");

for (const [ledgerState, expected] of [["released", COVERAGE_STATES.COVERAGE_RELEASED], ["paid", COVERAGE_STATES.PAID_OUT]]) {
  const replay = enrich({ ok: true, state: ledgerState, idempotentReplay: true, receipt: { receiptId: "ppc-replay" } });
  assert.equal(replay.coverageState, expected, `a replay of a ${ledgerState} record must report ${expected}`);
  assert.equal(replay.covered, false, `a replayed ${ledgerState} record is terminal, not in force`);
}

// A genuinely fresh issuance still reports active.
const freshIssue = enrich({ ok: true, state: "active", receipt: { receiptId: "ppc-fresh" } });
assert.equal(freshIssue.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE);
assert.equal(freshIssue.covered, true);

// Architectural rule: coverage is claimed only from an authoritative ledger
// state. A receipt-shaped payload, or a charged flag, is not evidence that
// cover is in force. Inferring it is what repeatedly reported cleanup records,
// replays, reservations, and terminal covenants as active.
for (const shape of [
  { ok: true, receipt: { receiptId: "ppc-shaped" } },
  { ok: true, charged: true },
  { ok: true, receiptId: "ppc-bare", charged: true },
]) {
  const view = enrich(shape);
  assert.notEqual(view.coverageState, COVERAGE_STATES.COVERAGE_ACTIVE, "coverage must not be inferred");
  assert.equal(view.covered, false, "a payload without a ledger state must never claim cover");
}

// The preflight discovery reply is a real lifecycle stage, not an absence of
// one, so it must carry an explicit state rather than silently omitting it.
const discovery = enrich({ ok: true, service: "PolicyPool Coverage Preflight", charged: false });
assert.equal(discovery.coverageState, COVERAGE_STATES.NOT_CHECKED);
assert.equal(discovery.covered, false);
assert.equal(discovery.nextAction, "RUN_ELIGIBILITY_CHECK");

// Transient infrastructure and throttling failures must stay retryable even
// when the specific code is absent from the contract, or an agent will
// permanently abandon a valid request during a 503 or a 429.
const throttled = enrich({ ok: false, error: "rate_limit_exceeded", charged: false }, { httpStatus: 429 });
assert.equal(throttled.retryable, true, "a 429 must be retryable");
assert.equal(throttled.retryAfterSeconds, 30);

const serviceDown = enrich({ ok: false, error: "coverage_status_unavailable", charged: false }, { httpStatus: 503 });
assert.equal(serviceDown.retryable, true, "a 503 must be retryable");
assert.match(serviceDown.nextAction, /do not change the input/i);

// A caller error stays non-retryable: the transport says the input was wrong.
const badInput = enrich({ ok: false, error: "okx_task_reference_required", charged: false }, { httpStatus: 400 });
assert.equal(badInput.retryable, false, "a 4xx input error must not invite blind retries");

// Release is also reached by expiry and by recovery without payout, so the
// shared next action must not assert the service was delivered on time.
const releasedAction = enrich({ ok: true, receiptId: "ppc-rel", state: "released" });
assert.equal(releasedAction.coverageState, COVERAGE_STATES.COVERAGE_RELEASED);
assert.doesNotMatch(releasedAction.nextAction, /DELIVERED/i, "release must not claim delivery happened");

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
// A bare success carries no eligibility verdict, state, or receipt, so it is
// the discovery stage rather than an unlabelled response.
const bareOk = enrich({ ok: true });
assert.equal(bareOk.ok, true, "the original payload is preserved");
assert.equal(bareOk.coverageState, COVERAGE_STATES.NOT_CHECKED);
assert.equal(bareOk.covered, false);

// PolicyPool is a rule based bounded service guarantee, not a regulated
// insurance product, and the standing terminology rule follows from that. These
// strings are the ones a buyer actually reads when a request is refused, so the
// vocabulary is enforced here rather than left to review. It was wrong once: a
// declined quote told the buyer their cap was below the minimum this service
// would "underwrite", which is the one thing the positioning denies.
//
// Scanned over the source because the catalogues are module private. "policy" is
// deliberately absent from the list; it is load bearing throughout the registry
// and means something else here.
const stateSource = await readFile(new URL("../api/lib/coverage-state.js", import.meta.url), "utf8");
const catalogues = [...stateSource.matchAll(/(?:ERROR_CONTRACT|NEXT_ACTION_BY_STATE) = Object\.freeze\(\{[\s\S]*?\n\}\);/g)]
  .map((match) => match[0]);
assert.equal(catalogues.length, 2, "both buyer-facing catalogues must be found, or this check scans nothing");
for (const catalogue of catalogues) {
  for (const banned of ["insurance", "insurer", "insured", "underwrit", "premium", "policyholder", "actuarial"]) {
    assert.doesNotMatch(
      catalogue,
      new RegExp(banned, "i"),
      `buyer-facing copy must not use "${banned}": this is a bounded service guarantee, not a regulated insurance product`,
    );
  }
}

console.log("coverage state contract verified");
