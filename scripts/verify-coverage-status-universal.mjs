import assert from "node:assert/strict";
import { createCoverageStatusHandler } from "../api/coverage-status.js";
import {
  buildReceiptIntegrityAnchor,
  computeReceiptHash,
  STORED_RECEIPT_SHAPES,
} from "../api/lib/receipt-integrity.js";
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
  let stored = structuredClone(record);
  if (stored.receipt && !stored.receipt.receiptHash) {
    stored.receipt.receiptHash = computeReceiptHash(stored.receipt);
    stored.receiptDocumentKind = STORED_RECEIPT_SHAPES.issued;
  }
  if (stored.receipt && !stored.receiptIntegrityAnchor) {
    stored.receiptIntegrityAnchor = buildReceiptIntegrityAnchor(stored.receipt);
  }
  const { handler } = handlerFor(stored, options);
  const response = await callHandler(handler, { method: "GET", query: { receiptId: stored.receiptId } });
  assert.equal(response.statusCode, 200);
  return response.json();
}

// Reconciliation is exposed as a separate projection derived only after the
// issued receipt passes its integrity check. It is never a hashless receipt.
const explicitProjection = await fetchStatus({
  receiptId: "ppc-explicit-reconciliation-projection",
  state: "released",
  liabilityAtomic: "0",
  receipt: {
    version: "0.4.0",
    covenant: { deadline: PAST_DEADLINE },
    target: { clockMode: "verified_acceptance" },
  },
  universalCovenant: { covenantId: `0x${"ef".repeat(32)}` },
  universalReconciliation: {
    from: "active",
    to: "released",
    reason: "service_delivered_within_sla",
    observedAt: "2026-07-25T09:59:00.000Z",
    deadline: PAST_DEADLINE,
  },
});
assert.equal(explicitProjection.coverageState, "COVERAGE_RELEASED");
assert.equal(explicitProjection.receiptDocumentKind, STORED_RECEIPT_SHAPES.issued);
assert.match(explicitProjection.receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(explicitProjection.reconciliationProjection.version, "0.4.0");
assert.equal(explicitProjection.reconciliationProjection.deadline, PAST_DEADLINE);

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
const activeRecord = ({ receiptId, universal, clockMode, deadline = PAST_DEADLINE }) => ({
  receiptId,
  state: "active",
  liabilityAtomic: "500000",
  receipt: {
    version: universal ? "0.4.0" : "0.2.0",
    covenant: { deadline },
    target: { clockMode },
    ...(clockMode === "policypool_relay"
      ? { providerRelay: { endpoint: "https://policypool.dolepee.com/api/provider-relay" } }
      : {}),
  },
  ...(universal ? { universalCovenant: { covenantId: `0x${"cc".repeat(32)}` } } : {}),
  targetOrder: { jobId: `0x${"ab".repeat(32)}` },
});

// A relay covenant is clocked by the provider relay receipt, which this endpoint
// never reads. observeRelayClock releases it outright when that receipt shows
// delivery inside the SLA, so a record still active past its deadline may be
// awaiting release rather than payout. Claiming a candidate here would be a
// guess from stale ledger state.
const relayPastDeadline = await fetchStatus(
  activeRecord({ receiptId: "ppc-relay-terminal-job", universal: true, clockMode: "policypool_relay" }),
  { jobStatus: 6 },
);
assert.equal(relayPastDeadline.reconciliation.clockMode, "policypool_relay");
assert.equal(relayPastDeadline.reconciliation.deadlinePassed, true);
assert.equal(
  relayPastDeadline.reconciliation.payoutDueCandidate,
  null,
  "a relay covenant's outcome needs the relay receipt, which this endpoint does not read",
);

const relayBeforeDeadline = await fetchStatus(
  activeRecord({
    receiptId: "ppc-relay-in-sla",
    universal: true,
    clockMode: "policypool_relay",
    deadline: FUTURE_DEADLINE,
  }),
  { jobStatus: 1 },
);
assert.equal(relayBeforeDeadline.reconciliation.payoutDueCandidate, false, "cover still running is not a candidate");

// A v0.4 covenant runs through observeOkxA2AClock, which separates release from
// payout for every terminal status by comparing the job's own resolution
// timestamp to the deadline. Past the deadline that timestamp could fall on
// either side of it and is not read here, so the answer is undecidable.
for (const jobStatus of [2, 3, 4, 5, 6, 7, 8, 9]) {
  const universalTerminal = await fetchStatus(
    activeRecord({ receiptId: `ppc-universal-terminal-${jobStatus}`, universal: true, clockMode: "verified_acceptance" }),
    { jobStatus },
  );
  assert.equal(
    universalTerminal.reconciliation.payoutDueCandidate,
    null,
    `a universal covenant on terminal status ${jobStatus} needs a resolution timestamp to decide`,
  );

  // Observing that same terminal status while the deadline is still ahead dates
  // the resolution before it, so the clock can only release and no timestamp is
  // needed. Reporting undecidable here would withhold an answer we do have.
  const beforeDeadline = await fetchStatus(
    activeRecord({
      receiptId: `ppc-universal-terminal-early-${jobStatus}`,
      universal: true,
      clockMode: "verified_acceptance",
      deadline: FUTURE_DEADLINE,
    }),
    { jobStatus },
  );
  assert.equal(
    beforeDeadline.reconciliation.payoutDueCandidate,
    false,
    `status ${jobStatus} observed before the deadline resolved before it, so release is certain`,
  );
}

// A v0.3 record does not use that clock at all. reconcile-coverage.js releases
// statuses 5 through 9 from status alone, so those are knowably not candidates
// and must not be reported as undecidable.
for (const jobStatus of [5, 6, 7, 8, 9]) {
  const legacyTerminal = await fetchStatus(
    activeRecord({ receiptId: `ppc-legacy-terminal-${jobStatus}`, universal: false, clockMode: "verified_acceptance" }),
    { jobStatus },
  );
  assert.equal(
    legacyTerminal.reconciliation.payoutDueCandidate,
    false,
    `the legacy reconciler can only release status ${jobStatus}, so candidacy is knowable`,
  );
}

// A delivered legacy job observed before its deadline is released, which is
// knowable. Observed after it, the legacy reconciler deliberately declines to
// guess and leaves it for evidence-based reconciliation, so neither can this.
const legacyDeliveredInSla = await fetchStatus(
  activeRecord({ receiptId: "ppc-legacy-delivered-in-sla", universal: false, clockMode: "verified_acceptance", deadline: FUTURE_DEADLINE }),
  { jobStatus: 2 },
);
assert.equal(legacyDeliveredInSla.reconciliation.payoutDueCandidate, false);
const legacyDeliveredLate = await fetchStatus(
  activeRecord({ receiptId: "ppc-legacy-delivered-late", universal: false, clockMode: "verified_acceptance" }),
  { jobStatus: 2 },
);
assert.equal(
  legacyDeliveredLate.reconciliation.payoutDueCandidate,
  null,
  "the legacy reconciler calls this ambiguous from status alone, so the endpoint must too",
);

// An accepted job past its deadline is a candidate under both reconcilers.
for (const universal of [true, false]) {
  const accepted = await fetchStatus(
    activeRecord({ receiptId: `ppc-accepted-${universal}`, universal, clockMode: "verified_acceptance" }),
    { jobStatus: 1 },
  );
  assert.equal(accepted.reconciliation.payoutDueCandidate, true);
}

// A job that was never accepted is not a candidate, and that is knowable.
const neverAccepted = await fetchStatus(
  activeRecord({ receiptId: "ppc-never-accepted", universal: true, clockMode: "verified_acceptance" }),
  { jobStatus: 0 },
);
assert.equal(neverAccepted.reconciliation.payoutDueCandidate, false);

// The indeterminate case must be explained rather than left as a bare null.
assert.match(
  relayPastDeadline.reconciliation.note,
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
