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
  return {
    pending_start: 1,
    active: 2,
    released: 3,
    payout_due: 4,
    paid: 5,
    recovered_without_payout: 6,
    cancelled_unpaid: 7,
  }[state];
}

async function seed({
  id,
  state,
  clockMode,
  deadline,
  enrollmentClosedAt,
  publicTaskReference = null,
  payoutDueAt = null,
  payoutBasis = 0,
  jobIdOverride = null,
}) {
  const jobId = jobIdOverride || `0x${id.repeat(64).slice(0, 64)}`;
  const covenantId = `0x${(Number.parseInt(id, 16) + 8).toString(16).repeat(64).slice(0, 64)}`;
  const relayGrantPayload = clockMode === "policypool_relay" ? {
    grantId: `pprg-${id}`,
    covenantId,
    targetJobId: jobId,
    buyer: "0x3000000000000000000000000000000000000003",
    agentId: "3808",
    serviceId: "33461",
  } : null;
  const record = {
    receiptId: `ppc-${id}`,
    requestId: `request-${id}`,
    paymentId: `payment-${id}`,
    state: "pending",
    liabilityAtomic: "0",
    providerBondLiabilityAtomic: "500000",
    universalCovenant: { covenantId },
    relayGrantPayload,
    targetOrder: { jobId, publicTaskReference, amountAtomic: "500000" },
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
    payoutDueAt: payoutDueAt ? Math.floor(Date.parse(payoutDueAt) / 1000) : 0,
    payoutBasis,
    buyerPaidAtomic: "500000",
    coverageCapAtomic: "500000",
    payoutAtomic: "0",
    feeAuthorizationHash: `0x${id.repeat(64).slice(0, 64)}`,
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
  relayGrantId: relay.relayGrantPayload.grantId,
  covenantId: relay.covenantId,
  signer: "0x1000000000000000000000000000000000000001",
  signature: "0xsigned",
  provider: { agentId: "3808", serviceId: "33461", targetJobId: relay.jobId },
  request: { paymentVerified: true },
  settlement: {
    transaction: `0x${"12".repeat(32)}`,
    payer: relay.relayGrantPayload.buyer,
  },
  clock: {
    source: "policypool_relay_verified_x402_settlement",
    startedAt: "2026-07-16T12:59:00.000Z",
    completedAt: "2026-07-16T12:59:01.000Z",
    delivered: true,
    completedWithinSla: true,
  },
  requestId: `sha256:${"11".repeat(32)}`,
});

const replacementRelay = await seed({
  id: "d",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T13:02:00.000Z",
  jobIdOverride: relay.jobId,
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
  feeAuthorization: {
    hash: covenantStates.get(compensated.covenantId).feeAuthorizationHash,
    nonce: `0x${"55".repeat(32)}`,
    validBefore: String(Math.floor(Date.parse("2026-07-16T12:50:00.000Z") / 1_000)),
  },
  compensation: {
    reason: "coverage_fee_not_settled",
    feeAuthorization: {
      hash: covenantStates.get(compensated.covenantId).feeAuthorizationHash,
      nonce: `0x${"55".repeat(32)}`,
      validBefore: String(Math.floor(Date.parse("2026-07-16T12:50:00.000Z") / 1_000)),
    },
  },
}, ["pending_start"]);
covenantStates.get(compensated.covenantId).state = 1;

const correctedBreach = await seed({
  id: "6",
  state: "payout_due",
  clockMode: "verified_acceptance",
  deadline: "2026-07-16T12:59:00.000Z",
  enrollmentClosedAt: "2026-07-16T12:55:00.000Z",
  publicTaskReference: "405669",
});
tasks.set("405669", {
  publicTaskId: "405669",
  publicUrl: "https://www.okx.ai/tasks/405669",
  jobId: correctedBreach.jobId,
  status: 2,
  submittedAt: "2026-07-16T12:58:30.000Z",
  completedAt: null,
  stale: false,
});

const terminalRecovery = await seed({
  id: "7",
  state: "payout_due",
  clockMode: "verified_acceptance",
  deadline: "2026-07-15T11:59:00.000Z",
  payoutDueAt: "2026-07-15T12:00:00.000Z",
  enrollmentClosedAt: "2026-07-15T11:55:00.000Z",
  publicTaskReference: "405670",
});
tasks.set("405670", {
  publicTaskId: "405670",
  publicUrl: "https://www.okx.ai/tasks/405670",
  jobId: terminalRecovery.jobId,
  status: 9,
  submittedAt: null,
  completedAt: "2026-07-16T12:40:00.000Z",
  stale: false,
});

const challengeActive = await seed({
  id: "8",
  state: "payout_due",
  clockMode: "verified_acceptance",
  deadline: "2026-07-16T11:59:00.000Z",
  payoutDueAt: "2026-07-16T12:00:00.000Z",
  enrollmentClosedAt: "2026-07-16T11:55:00.000Z",
  publicTaskReference: "405671",
});
tasks.set("405671", {
  publicTaskId: "405671",
  publicUrl: "https://www.okx.ai/tasks/405671",
  jobId: challengeActive.jobId,
  status: 9,
  submittedAt: null,
  completedAt: "2026-07-16T12:40:00.000Z",
  stale: false,
});

const lateA2aSlaCredit = await seed({
  id: "b",
  state: "payout_due",
  clockMode: "verified_acceptance",
  deadline: "2026-07-15T11:59:00.000Z",
  payoutDueAt: "2026-07-15T12:00:00.000Z",
  enrollmentClosedAt: "2026-07-15T11:55:00.000Z",
  publicTaskReference: "405672",
  payoutBasis: 1,
});
tasks.set("405672", {
  publicTaskId: "405672",
  publicUrl: "https://www.okx.ai/tasks/405672",
  jobId: lateA2aSlaCredit.jobId,
  status: 2,
  submittedAt: "2026-07-15T12:00:30.000Z",
  completedAt: null,
  fetchedAt: "2026-07-16T13:00:00.000Z",
  stale: false,
});

const lateA2aNetLoss = await seed({
  id: "c",
  state: "payout_due",
  clockMode: "verified_acceptance",
  deadline: "2026-07-15T11:59:00.000Z",
  payoutDueAt: "2026-07-15T12:00:00.000Z",
  enrollmentClosedAt: "2026-07-15T11:55:00.000Z",
  publicTaskReference: "405673",
  payoutBasis: 0,
});
tasks.set("405673", {
  publicTaskId: "405673",
  publicUrl: "https://www.okx.ai/tasks/405673",
  jobId: lateA2aNetLoss.jobId,
  status: 2,
  submittedAt: "2026-07-15T12:00:30.000Z",
  completedAt: null,
  fetchedAt: "2026-07-16T13:00:00.000Z",
  stale: false,
});

const issuancePending = await seed({
  id: "9",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T13:02:00.000Z",
});
await ledger.transitionUniversal({
  ...(await ledger.get(issuancePending.receiptId)),
  state: "compensation_required",
  compensation: {
    reason: "coverage_issuance_outcome_unconfirmed",
    feeAuthorization: {
      hash: covenantStates.get(issuancePending.covenantId).feeAuthorizationHash,
      nonce: `0x${"99".repeat(32)}`,
      validBefore: String(Math.floor(Date.parse("2026-07-16T13:05:00.000Z") / 1_000)),
    },
  },
}, ["pending_start"]);
covenantStates.get(issuancePending.covenantId).state = 0;

const issuanceAbsent = await seed({
  id: "a",
  state: "pending_start",
  clockMode: "policypool_relay",
  deadline: null,
  enrollmentClosedAt: "2026-07-16T13:02:00.000Z",
});
await ledger.transitionUniversal({
  ...(await ledger.get(issuanceAbsent.receiptId)),
  state: "compensation_required",
  compensation: {
    reason: "coverage_issuance_outcome_unconfirmed",
    feeAuthorization: {
      hash: covenantStates.get(issuanceAbsent.covenantId).feeAuthorizationHash,
      nonce: `0x${"aa".repeat(32)}`,
      validBefore: String(Math.floor(Date.parse("2026-07-16T12:50:00.000Z") / 1_000)),
    },
  },
}, ["pending_start"]);
covenantStates.get(issuanceAbsent.covenantId).state = 0;

const interruptedJobId = `0x${"bb".repeat(32)}`;
const interruptedCovenantId = `0x${"fe".repeat(32)}`;
const interruptedFeeAuthorization = {
  hash: `0x${"dd".repeat(32)}`,
  nonce: `0x${"ee".repeat(32)}`,
  validBefore: String(Math.floor(Date.parse("2026-07-16T12:50:00.000Z") / 1_000)),
};
const interruptedPending = {
  receiptId: "ppc-interrupted-pending",
  requestId: "request-interrupted-pending",
  paymentId: "payment-interrupted-pending",
  state: "pending",
  liabilityAtomic: "0",
  providerBondLiabilityAtomic: "500000",
  feeAuthorization: interruptedFeeAuthorization,
  universalCovenant: { covenantId: interruptedCovenantId, state: "planned" },
  targetOrder: { jobId: interruptedJobId, amountAtomic: "500000" },
};
await ledger.reserve(interruptedPending, 0n);
covenantStates.set(interruptedCovenantId, {
  state: 2,
  jobId: interruptedJobId,
  deadline: Math.floor(Date.parse("2026-07-16T13:05:00.000Z") / 1_000),
  payoutDueAt: 0,
  payoutBasis: 0,
  buyerPaidAtomic: "500000",
  coverageCapAtomic: "500000",
  payoutAtomic: "0",
  feeAuthorizationHash: interruptedFeeAuthorization.hash,
});

const issuer = {
  async getCovenant(covenantId) {
    const value = covenantStates.get(covenantId);
    return { id: covenantId, ...value };
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
  async cancelUnpaid(covenantId, feeAuthorizationHash, nonSettlementEvidenceHash) {
    assert.equal(feeAuthorizationHash, covenantStates.get(covenantId).feeAuthorizationHash);
    assert.match(nonSettlementEvidenceHash, /^0x[a-f0-9]{64}$/);
    writes.push({ action: "cancel", covenantId });
    covenantStates.get(covenantId).state = 7;
  },
  async settleNetLoss(
    covenantId,
    escrowRefundAtomic,
    otherRecoveryAtomic,
    recoveryFinalized,
    recoveryEvidenceHash,
  ) {
    const covenant = covenantStates.get(covenantId);
    const providerBondedSlaCredit = Number(covenant.payoutBasis) === 1;
    assert.equal(escrowRefundAtomic, providerBondedSlaCredit ? "0" : "500000");
    assert.equal(otherRecoveryAtomic, "0");
    assert.equal(recoveryFinalized, true);
    assert.match(recoveryEvidenceHash, /^0x[a-f0-9]{64}$/);
    writes.push({ action: "settle", covenantId, payoutBasis: covenant.payoutBasis });
    covenant.state = providerBondedSlaCredit ? 5 : 6;
    covenant.payoutAtomic = providerBondedSlaCredit ? "500000" : "0";
    return { transactionHash: `0x${"99".repeat(32)}` };
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

const misindexedReconciler = createUniversalReconciler({
  ledger,
  store: {
    async getRelayReceiptForCovenant() {
      return store.getRelayReceiptForCovenant(relay.covenantId);
    },
  },
  issuer,
  chain: { async getJobStatus(jobId) { return chainStates.get(jobId); } },
  taskFetcher: async (reference) => structuredClone(tasks.get(String(reference))),
  relaySigner: "0x1000000000000000000000000000000000000001",
  relayVerifier: "0x2000000000000000000000000000000000000002",
  verifyRelayReceipt: async () => true,
  now: () => now,
});
const replacementRecord = await ledger.get(replacementRelay.receiptId);
await assert.rejects(
  () => misindexedReconciler.reconcileRecord(replacementRecord, false),
  /relay_receipt_covenant_binding_invalid/,
  "a corrupt covenant index must not let an old grant receipt drive a replacement covenant",
);

const result = await reconciler.reconcile();
assert.equal(result.ok, true);
assert.equal(result.checked, 14);
assert.deepEqual(
  writes.map((write) => write.action).sort(),
  ["cancel", "cancel", "expire", "payout_due", "release", "release", "release", "settle", "settle", "start"],
);
assert.equal((await ledger.get(relay.receiptId)).state, "released");
assert.equal((await ledger.get(replacementRelay.receiptId)).state, "pending_start");
assert.equal(await store.getRelayReceiptForCovenant(replacementRelay.covenantId), null);
assert.equal((await ledger.get(breach.receiptId)).state, "payout_due");
assert.equal((await ledger.get(delivered.receiptId)).state, "released");
assert.equal((await ledger.get(expired.receiptId)).state, "released");
assert.equal(await ledger.get(compensated.receiptId), null);
assert.equal((await ledger.get(correctedBreach.receiptId)).state, "released");
assert.equal((await ledger.get(terminalRecovery.receiptId)).state, "recovered_without_payout");
assert.equal((await ledger.get(challengeActive.receiptId)).state, "payout_due");
assert.equal((await ledger.get(lateA2aSlaCredit.receiptId)).state, "paid");
assert.equal((await ledger.get(lateA2aSlaCredit.receiptId)).payout.amountAtomic, "500000");
assert.equal((await ledger.get(lateA2aNetLoss.receiptId)).state, "payout_due");
assert.equal((await ledger.get(issuancePending.receiptId)).state, "compensation_required");
assert.equal(await ledger.get(issuanceAbsent.receiptId), null);
assert.equal(await ledger.get(interruptedPending.receiptId), null);
assert.ok(result.holds.some((hold) => (
  hold.receiptId === challengeActive.receiptId && hold.reason === "payout_due_challenge_period_active"
)));
assert.ok(result.holds.some((hold) => (
  hold.receiptId === replacementRelay.receiptId && hold.reason === "relay_clock_not_started"
)));
assert.ok(result.holds.some((hold) => (
  hold.receiptId === lateA2aNetLoss.receiptId && hold.reason === "marketplace_recovery_not_terminal"
)));
assert.ok(result.holds.some((hold) => (
  hold.receiptId === issuancePending.receiptId && hold.reason === "coverage_issuance_outcome_pending"
)));

const before = writes.length;
const replay = await reconciler.reconcile();
assert.equal(replay.ok, true);
assert.equal(writes.length, before, "terminal reconciliation replay must not write again");

console.log("PolicyPool universal reconciler passed: clocks, release/breach, unpaid cancellation, uncertain issuance, net-loss finality, A2A SLA-credit settlement, challenge hold, and idempotent replay.");
