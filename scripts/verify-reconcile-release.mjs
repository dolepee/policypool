import assert from "node:assert/strict";
import { createReconcileHandler } from "../api/reconcile-coverage.js";
import {
  buildReceiptIntegrityAnchor,
  computeReceiptHash,
} from "../api/lib/receipt-integrity.js";
import { callHandler } from "./lib/fake-vercel.mjs";

// A submitted job (status 2) means the provider delivered and the buyer has not
// yet completed the task. That status is not platform-terminal, so it used to
// match neither the payout-due branch (which requires status 1) nor the
// platform-terminal release map, leaving delivered covenants active forever.

const DEADLINE = "2026-07-25T16:34:29.000Z";
const BEFORE_DEADLINE = Date.parse("2026-07-24T21:00:00.000Z");
const AFTER_DEADLINE = Date.parse("2026-07-26T09:00:00.000Z");

function record(overrides = {}) {
  const {
    receipt: receiptOverrides,
    receiptIntegrityAnchor: _ignoredAnchor,
    ...recordOverrides
  } = overrides;
  const receiptId = recordOverrides.receiptId || "ppc-test";
  const receipt = {
    receiptId,
    ...(receiptOverrides || {}),
    covenant: receiptOverrides && Object.hasOwn(receiptOverrides, "covenant")
      ? receiptOverrides.covenant
      : { deadline: DEADLINE },
  };
  delete receipt.receiptHash;
  receipt.receiptHash = computeReceiptHash(receipt);
  return {
    receiptId,
    state: "active",
    targetOrder: { jobId: `0x${"ab".repeat(32)}` },
    ...recordOverrides,
    receipt,
    receiptIntegrityAnchor: buildReceiptIntegrityAnchor(receipt),
  };
}

function harness({ status, now, records = [record()] }) {
  const released = [];
  const payoutDue = [];
  let chainReads = 0;
  const ledger = {
    async list() { return records; },
    async markReleased(updated) { released.push(updated); },
    async markPayoutDue(updated) { payoutDue.push(updated); },
  };
  const handler = createReconcileHandler({
    ledger,
    chain: { async getJobStatus() { chainReads += 1; return status; } },
    notifier: { async send() {} },
    authorized: true,
    now: () => now,
  });
  return { handler, released, payoutDue, get chainReads() { return chainReads; } };
}

async function run(options) {
  const runtime = harness(options);
  const { handler, released, payoutDue } = runtime;
  const response = await callHandler(handler, { method: "POST" });
  return {
    statusCode: response.statusCode,
    body: response.json(),
    released,
    payoutDue,
    chainReads: runtime.chainReads,
  };
}

// The regression: delivered, observed while the deadline is still ahead.
const deliveredEarly = await run({ status: 2, now: BEFORE_DEADLINE });
assert.equal(deliveredEarly.released.length, 1, "a delivered covenant must be released");
assert.equal(deliveredEarly.released[0].state, "released");
assert.equal(deliveredEarly.released[0].release.reason, "service_delivered_within_sla");
assert.equal(deliveredEarly.payoutDue.length, 0, "delivery on time must never mark a payout due");
assert.equal(deliveredEarly.body.changes[0].to, "released");

// Observed after the deadline, status alone cannot prove when delivery happened.
// It must not be released optimistically, and must not be treated as a breach.
const deliveredLateObservation = await run({ status: 2, now: AFTER_DEADLINE });
assert.equal(deliveredLateObservation.released.length, 0, "ambiguous timing must not auto-release");
assert.equal(deliveredLateObservation.payoutDue.length, 0, "a delivered job is not an undelivered breach");

// A covenant with no usable deadline must fail closed rather than release.
const noDeadline = await run({
  status: 2,
  now: BEFORE_DEADLINE,
  records: [record({ receipt: { covenant: {} } })],
});
assert.equal(noDeadline.released.length, 0, "an unparseable deadline must not release a covenant");

// Existing behaviour must be unchanged.
const stillAccepted = await run({ status: 1, now: BEFORE_DEADLINE });
assert.equal(stillAccepted.released.length, 0);
assert.equal(stillAccepted.payoutDue.length, 0, "an accepted job inside its SLA is simply held");

const undeliveredPastDeadline = await run({ status: 1, now: AFTER_DEADLINE });
assert.equal(undeliveredPastDeadline.payoutDue.length, 1, "an undelivered job past deadline is payout due");
assert.equal(undeliveredPastDeadline.payoutDue[0].state, "payout_due");
assert.equal(undeliveredPastDeadline.released.length, 0);

for (const [status, reason] of [
  [5, "platform_job_admin_stopped"],
  [6, "platform_job_completed"],
  [7, "platform_job_closed_and_funds_returned"],
  [8, "platform_job_expired"],
  [9, "platform_arbitration_refunded_buyer"],
]) {
  const terminal = await run({ status, now: AFTER_DEADLINE });
  assert.equal(terminal.released.length, 1, `status ${status} must still release`);
  assert.equal(terminal.released[0].release.reason, reason, `status ${status} must keep its reason`);
}

// Statuses that are neither delivered nor platform-terminal stay untouched.
for (const status of [0, 3, 4]) {
  const untouched = await run({ status, now: BEFORE_DEADLINE });
  assert.equal(untouched.released.length, 0, `status ${status} must not release`);
  assert.equal(untouched.payoutDue.length, 0, `status ${status} must not mark a payout due`);
}

const alteredReceipt = record({ receiptId: "ppc-altered-reconcile" });
alteredReceipt.receipt.covenant.deadline = "2026-07-20T00:00:00.000Z";
const rejectedAlteration = await run({
  status: 1,
  now: AFTER_DEADLINE,
  records: [alteredReceipt],
});
assert.equal(rejectedAlteration.statusCode, 503);
assert.equal(rejectedAlteration.body.failures[0].error, "receipt_hash_mismatch");
assert.equal(rejectedAlteration.chainReads, 0, "an altered receipt must fail before any chain read");
assert.equal(rejectedAlteration.released.length, 0);
assert.equal(rejectedAlteration.payoutDue.length, 0);

console.log("PolicyPool reconciler release path verified: delivered covenants release, ambiguous timing holds, breach path unchanged.");
