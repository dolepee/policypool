import assert from "node:assert/strict";
import { createCoverageStatusHandler } from "../api/coverage-status.js";
import { callHandler } from "./lib/fake-vercel.mjs";

// v0.4 transitions record their outcome in `universalReconciliation` and never
// populate `record.release`; a started relay covenant's deadline also lives
// there rather than in the issued receipt. The status endpoint must present one
// authoritative shape regardless of which pipeline produced the record.

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const PAST_DEADLINE = "2026-07-25T10:00:00.000Z";
const FUTURE_DEADLINE = "2026-07-26T10:00:00.000Z";

function handlerFor(record, { jobStatus = null } = {}) {
  let chainCalls = 0;
  const handler = createCoverageStatusHandler({
    ledger: { async get() { return record; } },
    chain: {
      async getJobStatus() {
        chainCalls += 1;
        if (jobStatus === null) throw new Error("chain must not be consulted for this record");
        return jobStatus;
      },
    },
    now: () => NOW,
  });
  return { handler, chainCalls: () => chainCalls };
}

async function fetchStatus(record, options) {
  const { handler } = handlerFor(record, options);
  const response = await callHandler(handler, { method: "GET", query: { receiptId: record.receiptId } });
  assert.equal(response.statusCode, 200);
  return response.json();
}

// A universally released covenant must report its verified reason, not null.
const universallyReleased = await fetchStatus({
  receiptId: "ppc-universal-released",
  state: "released",
  liabilityAtomic: "0",
  receipt: { version: "0.4.0", covenant: {} },
  universalReconciliation: {
    from: "active",
    to: "released",
    reason: "service_delivered_within_sla",
    observedAt: "2026-07-25T09:59:00.000Z",
    deadline: PAST_DEADLINE,
  },
});
assert.ok(universallyReleased.release, "a universal release must surface as release evidence");
assert.equal(universallyReleased.release.reason, "service_delivered_within_sla");
assert.equal(universallyReleased.release.source, "universal_reconciliation");
assert.equal(universallyReleased.release.observedAt, "2026-07-25T09:59:00.000Z");
assert.equal(universallyReleased.reconciliation.deadline, PAST_DEADLINE);
assert.equal(universallyReleased.reconciliation.deadlineSource, "universal_reconciliation");
assert.ok(universallyReleased.universalReconciliation, "the raw universal event must be forwarded");
assert.equal(universallyReleased.coverageState, "COVERAGE_RELEASED");

// A started relay covenant's deadline governs deadlinePassed and
// payoutDueCandidate even though the issued receipt has no deadline. This was
// silently false before: the endpoint parsed only the receipt's deadline.
const startedRelay = await fetchStatus({
  receiptId: "ppc-relay-started",
  state: "active",
  liabilityAtomic: "500000",
  receipt: { version: "0.4.0", covenant: { deadline: null } },
  targetOrder: { jobId: `0x${"ab".repeat(32)}` },
  universalReconciliation: {
    from: "pending_start",
    to: "active",
    reason: "verified_funded_request_reached_provider_relay",
    observedAt: "2026-07-25T09:00:00.000Z",
    deadline: PAST_DEADLINE,
  },
}, { jobStatus: 1 });
assert.equal(startedRelay.reconciliation.deadline, PAST_DEADLINE);
assert.equal(startedRelay.reconciliation.deadlinePassed, true, "the reconciled deadline must drive deadlinePassed");
assert.equal(
  startedRelay.reconciliation.payoutDueCandidate,
  true,
  "an accepted job past the reconciled deadline is a payout-due candidate",
);
assert.equal(startedRelay.release, null, "an active covenant has no release");

// The issued receipt's own deadline still takes precedence when present.
const receiptDeadlineWins = await fetchStatus({
  receiptId: "ppc-receipt-deadline",
  state: "active",
  liabilityAtomic: "500000",
  receipt: { version: "0.4.0", covenant: { deadline: FUTURE_DEADLINE } },
  universalReconciliation: {
    from: "pending_start",
    to: "active",
    reason: "verified_funded_request_reached_provider_relay",
    observedAt: "2026-07-25T09:00:00.000Z",
    deadline: PAST_DEADLINE,
  },
});
assert.equal(receiptDeadlineWins.reconciliation.deadline, FUTURE_DEADLINE);
assert.equal(receiptDeadlineWins.reconciliation.deadlineSource, "issued_receipt");
assert.equal(receiptDeadlineWins.reconciliation.deadlinePassed, false);

// v0.3 records are untouched: release comes from record.release verbatim.
const legacyReleased = await fetchStatus({
  receiptId: "ppc-legacy-released",
  state: "released",
  liabilityAtomic: "0",
  receipt: { version: "0.2.0", covenant: { deadline: PAST_DEADLINE } },
  release: {
    from: "active",
    to: "released",
    reason: "platform_job_completed",
    observedAt: "2026-07-11T06:49:37.494Z",
  },
});
assert.equal(legacyReleased.release.reason, "platform_job_completed");
assert.equal(legacyReleased.release.source, undefined, "legacy release evidence is forwarded verbatim");
assert.equal(legacyReleased.universalReconciliation, null);
assert.equal(legacyReleased.reconciliation.deadlineSource, "issued_receipt");

// A paid universal record's last transition is to paid; no release may be
// fabricated from it.
const universallyPaid = await fetchStatus({
  receiptId: "ppc-universal-paid",
  state: "paid",
  liabilityAtomic: "0",
  receipt: { version: "0.4.0", covenant: { deadline: PAST_DEADLINE } },
  payout: { amountAtomic: "500000", transaction: `0x${"cd".repeat(32)}`, verifiedAt: "2026-07-25T11:00:00.000Z" },
  universalReconciliation: {
    from: "payout_due",
    to: "paid",
    reason: "verified_okx_a2a_deadline_breach_with_provider_bonded_sla_credit",
    observedAt: "2026-07-25T11:00:00.000Z",
  },
});
assert.equal(universallyPaid.release, null, "a paid record must not grow a fabricated release");
assert.equal(universallyPaid.coverageState, "PAID_OUT");

// A relay covenant that has moved past its start no longer carries the deadline
// on its latest reconciliation event: the reconciler's transition() builds a
// fresh event each time and only the start transition merged the deadline in.
// The start event's evidence survives in the retained transition log, so a
// released or paid relay record must still report an objective deadline rather
// than reading as a covenant that never had one. This is the shape the
// reconciler actually persists, not a hand-fed deadline.
const relayStartTransition = {
  from: "pending_start",
  to: "active",
  reason: "verified_funded_request_reached_provider_relay",
  observedAt: "2026-07-25T09:00:00.000Z",
  evidence: {
    relayReceiptId: "rly-1",
    startedAt: "2026-07-25T09:00:00.000Z",
    deadline: PAST_DEADLINE,
  },
  transitionHash: "sha256:start",
};

for (const [label, terminal] of [
  ["released", {
    state: "released",
    liabilityAtomic: "0",
    event: {
      from: "active",
      to: "released",
      reason: "provider_response_delivered_within_sla",
      observedAt: "2026-07-25T09:45:00.000Z",
      evidence: { relayReceiptId: "rly-1", deliveredAt: "2026-07-25T09:45:00.000Z" },
    },
  }],
  ["payout_due", {
    state: "payout_due",
    liabilityAtomic: "500000",
    event: {
      from: "active",
      to: "payout_due",
      reason: "verified_okx_a2a_deadline_breach_with_provider_bonded_sla_credit",
      observedAt: "2026-07-25T10:30:00.000Z",
      evidence: { relayReceiptId: "rly-1" },
    },
  }],
]) {
  const record = await fetchStatus({
    receiptId: `ppc-relay-${label}`,
    state: terminal.state,
    liabilityAtomic: terminal.liabilityAtomic,
    // A relay covenant's issued receipt carries no deadline of its own.
    receipt: { version: "0.4.0", covenant: {} },
    transitions: [relayStartTransition, { ...terminal.event, transitionHash: `sha256:${label}` }],
    universalReconciliation: terminal.event,
  });
  assert.equal(
    record.reconciliation.deadline,
    PAST_DEADLINE,
    `a ${label} relay covenant must keep the deadline its start transition recorded`,
  );
  assert.equal(record.reconciliation.deadlineSource, "universal_reconciliation", label);
  assert.equal(record.reconciliation.deadlinePassed, true, label);
}

// The released relay covenant above must still report its verified reason, so
// deadline recovery does not come at the cost of release evidence.
const relayReleased = await fetchStatus({
  receiptId: "ppc-relay-released-evidence",
  state: "released",
  liabilityAtomic: "0",
  receipt: { version: "0.4.0", covenant: {} },
  transitions: [relayStartTransition],
  universalReconciliation: {
    from: "active",
    to: "released",
    reason: "provider_response_delivered_within_sla",
    observedAt: "2026-07-25T09:45:00.000Z",
    evidence: { relayReceiptId: "rly-1" },
  },
});
assert.equal(relayReleased.release.reason, "provider_response_delivered_within_sla");
assert.equal(relayReleased.release.source, "universal_reconciliation");
assert.equal(relayReleased.reconciliation.deadline, PAST_DEADLINE);

// Payout candidacy has to follow the covenant's own clock. observeRelayClock
// marks a relay covenant payout-due purely on non-delivery by its deadline and
// never reads marketplace job status, so a terminal job must not suppress
// candidacy for a relay covenant the reconciler is about to pay out. The legacy
// accepted-job predicate still governs verified_acceptance covenants.
const relayPastDeadlineTerminalJob = await fetchStatus({
  receiptId: "ppc-relay-terminal-job",
  state: "active",
  liabilityAtomic: "500000",
  receipt: {
    version: "0.4.0",
    covenant: { deadline: PAST_DEADLINE },
    target: { clockMode: "policypool_relay" },
  },
  targetOrder: { jobId: `0x${"ab".repeat(32)}` },
}, { jobStatus: 6 });
assert.equal(relayPastDeadlineTerminalJob.reconciliation.clockMode, "policypool_relay");
assert.equal(relayPastDeadlineTerminalJob.reconciliation.deadlinePassed, true);
assert.equal(
  relayPastDeadlineTerminalJob.reconciliation.payoutDueCandidate,
  true,
  "a relay covenant past its deadline stays a candidate even once the job is terminal",
);

const legacyPastDeadlineTerminalJob = await fetchStatus({
  receiptId: "ppc-legacy-terminal-job",
  state: "active",
  liabilityAtomic: "500000",
  receipt: {
    version: "0.4.0",
    covenant: { deadline: PAST_DEADLINE },
    target: { clockMode: "verified_acceptance" },
  },
  targetOrder: { jobId: `0x${"ab".repeat(32)}` },
}, { jobStatus: 6 });
assert.equal(legacyPastDeadlineTerminalJob.reconciliation.clockMode, "verified_acceptance");
// observeOkxA2AClock separates a terminal job that resolved after the deadline
// (payout due) from one that resolved before it (released) using the job's own
// resolution timestamp, which this endpoint does not read. Reporting false here
// would deny a claim the reconciler is about to allow, so it must report that
// it cannot tell rather than guessing.
assert.equal(
  legacyPastDeadlineTerminalJob.reconciliation.payoutDueCandidate,
  null,
  "a terminal job's candidacy turns on a resolution timestamp this endpoint has no access to",
);

for (const jobStatus of [2, 3, 4, 5, 6, 7, 8, 9]) {
  const terminal = await fetchStatus({
    receiptId: `ppc-terminal-${jobStatus}`,
    state: "active",
    liabilityAtomic: "500000",
    receipt: {
      version: "0.4.0",
      covenant: { deadline: PAST_DEADLINE },
      target: { clockMode: "verified_acceptance" },
    },
    targetOrder: { jobId: `0x${"ab".repeat(32)}` },
  }, { jobStatus });
  assert.equal(
    terminal.reconciliation.payoutDueCandidate,
    null,
    `status ${jobStatus} is terminal, so candidacy cannot be decided from status alone`,
  );
}

// A job that was never accepted is not a candidate, and that is knowable.
const neverAccepted = await fetchStatus({
  receiptId: "ppc-never-accepted",
  state: "active",
  liabilityAtomic: "500000",
  receipt: {
    version: "0.4.0",
    covenant: { deadline: PAST_DEADLINE },
    target: { clockMode: "verified_acceptance" },
  },
  targetOrder: { jobId: `0x${"ab".repeat(32)}` },
}, { jobStatus: 0 });
assert.equal(neverAccepted.reconciliation.payoutDueCandidate, false);

// The indeterminate case must be explained rather than left as a bare null.
assert.match(
  legacyPastDeadlineTerminalJob.reconciliation.note,
  /null payoutDueCandidate/,
  "a null candidacy must be documented in the response itself",
);

// A record whose history genuinely never recorded a deadline must report none
// rather than inventing one from an unrelated transition.
const noDeadlineAnywhere = await fetchStatus({
  receiptId: "ppc-relay-no-deadline",
  state: "released",
  liabilityAtomic: "0",
  receipt: { version: "0.4.0", covenant: {} },
  transitions: [{
    from: "pending_start",
    to: "cancelled_unpaid",
    reason: "fee_never_settled",
    observedAt: "2026-07-25T09:00:00.000Z",
    evidence: { relayReceiptId: "rly-2" },
    transitionHash: "sha256:cancel",
  }],
  universalReconciliation: {
    from: "pending_start",
    to: "released",
    reason: "unstarted_relay_clock_expired",
    observedAt: "2026-07-25T09:30:00.000Z",
    evidence: {},
  },
});
assert.equal(noDeadlineAnywhere.reconciliation.deadline, null);
assert.equal(noDeadlineAnywhere.reconciliation.deadlineSource, null);
assert.equal(noDeadlineAnywhere.reconciliation.deadlinePassed, false);
assert.equal(noDeadlineAnywhere.reconciliation.payoutDueCandidate, false);

console.log("PolicyPool universal coverage-status verified: unified release evidence, reconciled deadlines surviving later transitions, and untouched legacy records.");
