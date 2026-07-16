import assert from "node:assert/strict";
import { observeOkxA2AClock, observeRelayClock } from "../api/lib/coverage-clock.js";

const deadline = "2026-07-16T12:05:00.000Z";
assert.deepEqual(observeOkxA2AClock({
  task: { status: 1 },
  deadline,
  now: Date.parse("2026-07-16T12:04:59.000Z"),
}), { action: "hold", reason: "accepted_job_within_sla" });
assert.equal(observeOkxA2AClock({
  task: { status: 1 },
  deadline,
  now: Date.parse("2026-07-16T12:05:01.000Z"),
}).action, "mark_payout_due");
assert.equal(observeOkxA2AClock({
  task: { status: 2, submittedAt: "2026-07-16T12:04:00.000Z" },
  deadline,
}).action, "release");
assert.equal(observeOkxA2AClock({
  task: { status: 2, submittedAt: "2026-07-16T12:06:00.000Z" },
  deadline,
}).reason, "service_delivered_after_deadline");
assert.equal(observeOkxA2AClock({ task: { status: 2 }, deadline }).reason, "delivery_timestamp_unavailable");
assert.equal(observeOkxA2AClock({ task: { status: 9 }, deadline }).recoveryFinalized, true);

const jobId = `0x${"44".repeat(32)}`;
const relayReceipt = {
  requestId: `sha256:${"55".repeat(32)}`,
  provider: { targetJobId: jobId },
  clock: {
    startedAt: "2026-07-16T12:00:00.000Z",
    completedAt: "2026-07-16T12:01:40.000Z",
    delivered: true,
    completedWithinSla: true,
  },
};
assert.equal(observeRelayClock({
  covenant: { state: "pending_start", targetJobId: jobId },
  relayReceipt,
}).action, "start_clock");
assert.equal(observeRelayClock({
  covenant: { state: "active", targetJobId: jobId, deadline },
  relayReceipt,
}).action, "release");
assert.equal(observeRelayClock({
  covenant: { state: "active", targetJobId: jobId, deadline },
  relayReceipt: { ...relayReceipt, clock: { ...relayReceipt.clock, delivered: false, completedWithinSla: false } },
  now: Date.parse("2026-07-16T12:06:00.000Z"),
}).action, "mark_payout_due");

console.log("PolicyPool coverage clocks passed: A2A delivery timestamps, relay start, release, and breach transitions.");
