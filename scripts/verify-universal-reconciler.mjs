import assert from "node:assert/strict";
import { MemoryLedger } from "../api/lib/ledger.js";
import { MemoryProviderPolicyStore } from "../api/lib/provider-policy-store.js";
import { createUniversalReconciler } from "../api/lib/universal-reconciler.js";

const now = Date.parse("2026-07-16T13:00:00.000Z");
const ledger = new MemoryLedger();
const store = new MemoryProviderPolicyStore();
const chainStates = new Map();
const covenantStates = new Map();
const tasks = new Map();
const writes = [];

function stateNumber(state) {
  return { pending_start: 1, active: 2, released: 3, payout_due: 4, paid: 5 }[state];
}

async function seed({ id, state, clockMode, deadline, enrollmentClosedAt, publicTaskReference = null }) {
  const jobId = `0x${id.repeat(64).slice(0, 64)}`;
  const covenantId = `0x${(Number.parseInt(id, 16) + 8).toString(16).repeat(64).slice(0, 64)}`;
  const record = {
    receiptId: `ppc-${id}`,
    requestId: `request-${id}`,
    paymentId: `payment-${id}`,
    state: "pending",
    liabilityAtomic: "0",
    providerBondLiabilityAtomic: "500000",
    universalCovenant: { covenantId },
    targetOrder: { jobId, publicTaskReference },
    receipt: {
      version: "0.4.0",
      target: { clockMode, slaSeconds: 300 },
      covenant: { deadline, enrollmentClosedAt, coverageCapAtomic: "500000" },
    },
  };
  await ledger.reserve(record, 0n);
  await ledger.finalize({ ...record, state });
  covenantStates.set(covenantId, {
    state: stateNumber(state),
    jobId,
    deadline: deadline ? Math.floor(Date.parse(deadline) / 1000) : 0,
  });
  chainStates.set(jobId, 1);
  return { ...record, state, jobId, covenantId };
}

const relay = await seed({
  id: "1",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T13:02:00.000Z",
});
await store.saveRelayReceipt({
  receiptId: "relay-one",
  signer: "0x1000000000000000000000000000000000000001",
  signature: "0xsigned",
  provider: { targetJobId: relay.jobId },
  clock: {
    startedAt: "2026-07-16T12:59:00.000Z",
    completedAt: "2026-07-16T12:59:01.000Z",
    delivered: true,
    completedWithinSla: true,
  },
  requestId: `sha256:${"11".repeat(32)}`,
});

const breach = await seed({
  id: "2",
  state: "active",
  clockMode: "verified_acceptance",
  deadline: "2026-07-16T12:59:00.000Z",
  enrollmentClosedAt: "2026-07-16T12:55:00.000Z",
});

const delivered = await seed({
  id: "3",
  state: "active",
  clockMode: "verified_acceptance",
  deadline: "2026-07-16T13:01:00.000Z",
  enrollmentClosedAt: "2026-07-16T12:55:00.000Z",
  publicTaskReference: "405668",
});
tasks.set("405668", {
  publicTaskId: "405668",
  publicUrl: "https://www.okx.ai/tasks/405668",
  jobId: delivered.jobId,
  status: 2,
  submittedAt: "2026-07-16T13:00:30.000Z",
  completedAt: null,
  stale: false,
});

const expired = await seed({
  id: "4",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T12:58:00.000Z",
});

const compensated = await seed({
  id: "5",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T13:02:00.000Z",
});
await ledger.transitionUniversal({
  ...(await ledger.get(compensated.receiptId)),
  state: "compensation_required",
  compensation: { reason: "coverage_fee_not_settled" },
}, ["pending_start"]);
covenantStates.get(compensated.covenantId).state = 1;

const issuer = {
  async getCovenant(covenantId) {
    const value = covenantStates.get(covenantId);
    return { id: covenantId, jobId: value.jobId, state: value.state, deadline: value.deadline };
  },
  async startClock(covenantId, startedAt, evidenceHash) {
    assert.match(evidenceHash, /^0x[a-f0-9]{64}$/);
    writes.push({ action: "start", covenantId, startedAt });
    covenantStates.get(covenantId).state = 2;
  },
  async release(covenantId) {
    writes.push({ action: "release", covenantId });
    covenantStates.get(covenantId).state = 3;
  },
  async markPayoutDue(covenantId) {
    writes.push({ action: "payout_due", covenantId });
    covenantStates.get(covenantId).state = 4;
  },
  async expireUnstarted(covenantId) {
    writes.push({ action: "expire", covenantId });
    covenantStates.get(covenantId).state = 3;
  },
};
const reconciler = createUniversalReconciler({
  ledger,
  store,
  issuer,
  chain: { async getJobStatus(jobId) { return chainStates.get(jobId); } },
  taskFetcher: async (reference) => structuredClone(tasks.get(String(reference))),
  relaySigner: "0x1000000000000000000000000000000000000001",
  relayVerifier: "0x2000000000000000000000000000000000000002",
  verifyRelayReceipt: async () => true,
  now: () => now,
});

const result = await reconciler.reconcile();
assert.equal(result.ok, true);
assert.equal(result.checked, 5);
assert.deepEqual(
  writes.map((write) => write.action).sort(),
  ["expire", "payout_due", "release", "release", "release", "start"],
);
assert.equal((await ledger.get(relay.receiptId)).state, "released");
assert.equal((await ledger.get(breach.receiptId)).state, "payout_due");
assert.equal((await ledger.get(delivered.receiptId)).state, "released");
assert.equal((await ledger.get(expired.receiptId)).state, "released");
assert.equal(await ledger.get(compensated.receiptId), null);

const before = writes.length;
const replay = await reconciler.reconcile();
assert.equal(replay.ok, true);
assert.equal(writes.length, before, "terminal reconciliation replay must not write again");

console.log("PolicyPool universal reconciler passed: relay start/release, A2A release/breach, expiry, and idempotent replay.");
