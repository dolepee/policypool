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

console.log("PolicyPool universal coverage-status verified: unified release evidence, reconciled deadlines, and untouched legacy records.");
