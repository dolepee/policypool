import assert from "node:assert/strict";
import { createDirectA2mcpReconciler } from "../api/lib/direct-a2mcp-reconciler.js";
import { PAYMENT } from "../api/lib/config.js";
import { ProviderRelayError } from "../api/lib/provider-relay.js";

const buyer = "0x3000000000000000000000000000000000000003";
const provider = "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51";
const covenantId = `0x${"11".repeat(32)}`;
const jobId = `0x${"22".repeat(32)}`;
const feeId = `0x${"33".repeat(32)}`;
const authorizationNonce = `0x${"44".repeat(32)}`;
const authorizationId = `sha256:${"55".repeat(32)}`;
const receiptDigest = `0x${"66".repeat(32)}`;
const settlementTransaction = `0x${"77".repeat(32)}`;

function directRecord() {
  return {
    id: "00000000000000000000000000000001",
    state: "executing",
    issuedAt: "2026-07-17T12:00:00.000Z",
    buyer,
    agentId: "3808",
    serviceId: "33461",
    endpoint: "https://warden.example/audit",
    servicePriceAtomic: "500000",
    providerAccepted: { payTo: provider, asset: PAYMENT.asset },
    providerAuthorizationId: authorizationId,
    providerAuthorizationNonce: authorizationNonce,
    providerAuthorizationValidBefore: 1784290200,
    providerAuthorizationHash: `0x${"88".repeat(32)}`,
    covenantId,
    jobId,
    feeId,
    execution: {
      id: `sha256:${"99".repeat(32)}`,
      stages: { relayGrant: { token: "signed-direct-relay-grant" } },
    },
  };
}

function relayReceipt({ delivered = true, recovered = false } = {}) {
  return {
    receiptId: "ppr-direct-reconcile",
    receiptDigest,
    covenantId,
    provider: { targetJobId: jobId },
    request: { paymentVerified: true, paymentAuthorizationId: authorizationId },
    response: recovered
      ? { status: null, hash: null, recovery: "provider_settlement_found_without_durable_upstream_response" }
      : { status: delivered ? 200 : 500, hash: `sha256:${"aa".repeat(32)}` },
    settlement: {
      transaction: settlementTransaction,
      authorizationNonce,
      payer: buyer,
      payTo: provider,
      asset: PAYMENT.asset,
      amountAtomic: "500000",
    },
    clock: {
      startedAt: "2026-07-17T12:00:02.000Z",
      completedAt: delivered ? "2026-07-17T12:00:03.000Z" : "2026-07-17T12:05:03.000Z",
      delivered,
      completedWithinSla: delivered,
    },
  };
}

function harness({
  receipt = relayReceipt(),
  covenantState = 1,
  feeState = 1,
  nowSeconds = 1784289700,
  relayGrant = true,
} = {}) {
  let record = directRecord();
  if (!relayGrant) delete record.execution.stages.relayGrant;
  let currentReceipt = receipt;
  let nowMs = nowSeconds * 1_000;
  let covenant = {
    id: covenantId,
    state: covenantState,
    deadline: nowSeconds - 1,
    payoutDueAt: 0,
    enrollmentExpiresAt: Math.floor(Date.parse("2026-07-17T12:01:00.000Z") / 1_000),
    feeAuthorizationValidBefore: directRecord().providerAuthorizationValidBefore,
  };
  let fee = {
    state: feeState,
    refundAvailableAt: directRecord().providerAuthorizationValidBefore + 120,
  };
  let recoveredProviderResult = null;
  let recoveryContextReads = 0;
  let recoveries = 0;
  let expiries = 0;
  let rotations = 0;
  const calls = { cancel: 0, capture: 0, mark: 0, refund: 0, release: 0, settle: 0, start: 0 };
  const state = {
    async listExecuting() { return record.state === "executing" ? [structuredClone(record)] : []; },
    async markReconciled() { rotations += 1; return record.state === "executing"; },
    async recoveryContext() {
      recoveryContextReads += 1;
      return {
        providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
        providerPaymentSignature: "provider-payment-signature",
      };
    },
    async reconcileCheckpoint(_id, _executionId, stage, value) {
      record.execution.stages[stage] = structuredClone(value);
      return structuredClone(record);
    },
    async reconcileComplete(_id, _executionId, result) {
      record.state = "complete";
      record.result = structuredClone(result);
      return structuredClone(record);
    },
  };
  const issuer = {
    async getCovenant() { return structuredClone(covenant); },
    async startClock(_covenantId, startedAt) {
      const startedAtSeconds = Math.floor(Date.parse(startedAt) / 1_000);
      assert.ok(startedAtSeconds <= covenant.enrollmentExpiresAt);
      assert.ok(Math.floor(nowMs / 1_000) <= covenant.feeAuthorizationValidBefore + 10 * 60);
      calls.start += 1;
      covenant.state = 2;
      return { transactionHash: `0x${"01".repeat(32)}` };
    },
    async expireUnstarted() {
      assert.ok(Math.floor(nowMs / 1_000) > covenant.feeAuthorizationValidBefore + 10 * 60);
      expiries += 1;
      covenant.state = 3;
      return { transactionHash: `0x${"08".repeat(32)}` };
    },
    async release() { calls.release += 1; covenant.state = 3; return { transactionHash: `0x${"02".repeat(32)}` }; },
    async markPayoutDue() {
      calls.mark += 1;
      covenant.state = 4;
      covenant.payoutDueAt = Math.floor(nowMs / 1_000);
      return { transactionHash: `0x${"03".repeat(32)}` };
    },
    async settleNetLoss() { calls.settle += 1; covenant.state = 5; return { transactionHash: `0x${"04".repeat(32)}` }; },
    async cancelUnpaid() { calls.cancel += 1; covenant.state = 7; return { transactionHash: `0x${"05".repeat(32)}` }; },
  };
  const feeEscrow = {
    async getFee() { return structuredClone(fee); },
    async capture() { calls.capture += 1; fee.state = 2; return { transactionHash: `0x${"06".repeat(32)}` }; },
    async refund() { calls.refund += 1; fee.state = 3; return { transactionHash: `0x${"07".repeat(32)}` }; },
  };
  const reconciler = createDirectA2mcpReconciler({
    state,
    relayStore: { async getRelayReceiptForCovenant() { return structuredClone(currentReceipt); } },
    relay: {
      async recover(input, headers) {
        recoveries += 1;
        assert.equal(input.relayGrant, "signed-direct-relay-grant");
        assert.equal(headers["payment-signature"], "provider-payment-signature");
        if (!recoveredProviderResult) {
          throw new ProviderRelayError("provider_payment_settlement_not_found", 404);
        }
        currentReceipt = structuredClone(recoveredProviderResult.receipt);
        return structuredClone(recoveredProviderResult);
      },
    },
    issuer,
    feeEscrow,
    relaySigner: "0x4000000000000000000000000000000000000004",
    relayVerifier: "0x5000000000000000000000000000000000000005",
    verifyReceipt: async () => true,
    now: () => nowMs,
  });
  return {
    calls,
    getRecord: () => structuredClone(record),
    getExpiries: () => expiries,
    getRecoveryContextReads: () => recoveryContextReads,
    getRecoveries: () => recoveries,
    getRotations: () => rotations,
    reconcile: (input) => reconciler.reconcile(input),
    setReceipt(value) { currentReceipt = value; },
    setRecoveredProviderResult(value) { recoveredProviderResult = value; },
    tick(seconds) { nowMs += seconds * 1_000; },
  };
}

const happy = harness();
const happyResult = await happy.reconcile();
assert.equal(happyResult.ok, true);
assert.deepEqual(happy.calls, { cancel: 0, capture: 1, mark: 0, refund: 0, release: 1, settle: 0, start: 1 });
assert.ok(1784289700 > Math.floor(Date.parse("2026-07-17T12:01:00.000Z") / 1_000));
assert.equal(happy.getRecord().state, "complete");
assert.equal(happy.getRecord().result.coverageState, 3);
assert.equal(happy.getRotations(), 1);

const unsettled = harness({
  receipt: null,
  nowSeconds: directRecord().providerAuthorizationValidBefore + 121,
});
const unsettledResult = await unsettled.reconcile();
assert.equal(unsettledResult.ok, true);
assert.deepEqual(unsettled.calls, { cancel: 1, capture: 0, mark: 0, refund: 1, release: 0, settle: 0, start: 0 });
assert.equal(unsettled.getRecord().state, "complete");
assert.equal(unsettled.getRecord().result.outcome, "cancelled_without_charge");
assert.equal(unsettled.getRotations(), 1);

const missingGrant = harness({
  receipt: null,
  nowSeconds: directRecord().providerAuthorizationValidBefore + 121,
  relayGrant: false,
});
const missingGrantResult = await missingGrant.reconcile();
assert.equal(missingGrantResult.ok, true);
assert.deepEqual(
  missingGrant.calls,
  { cancel: 1, capture: 0, mark: 0, refund: 1, release: 0, settle: 0, start: 0 },
);
assert.equal(missingGrant.getRecoveries(), 0);
assert.equal(missingGrant.getRecoveryContextReads(), 0);
assert.equal(missingGrant.getRecord().state, "complete");
assert.equal(missingGrant.getRecord().result.outcome, "cancelled_without_charge");

const expiredClockRecovery = harness({
  nowSeconds: directRecord().providerAuthorizationValidBefore + 10 * 60 + 1,
});
const expiredClockRecoveryResult = await expiredClockRecovery.reconcile();
assert.equal(expiredClockRecoveryResult.ok, true);
assert.equal(expiredClockRecovery.getExpiries(), 1);
assert.deepEqual(
  expiredClockRecovery.calls,
  { cancel: 0, capture: 0, mark: 0, refund: 1, release: 0, settle: 0, start: 0 },
);
assert.equal(expiredClockRecovery.getRecord().state, "complete");
assert.equal(expiredClockRecovery.getRecord().result.outcome, "coverage_clock_recovery_expired");

const settlementFound = harness({
  receipt: null,
  nowSeconds: directRecord().providerAuthorizationValidBefore + 121,
});
settlementFound.setRecoveredProviderResult({
  receipt: relayReceipt({ delivered: false, recovered: true }),
  upstream: null,
  recovered: true,
});
const settlementFoundResult = await settlementFound.reconcile();
assert.equal(settlementFoundResult.holds[0].reason, "provider_delivery_indeterminate_manual_resolution");
assert.deepEqual(
  settlementFound.calls,
  { cancel: 0, capture: 1, mark: 0, refund: 0, release: 0, settle: 0, start: 1 },
);
assert.equal(settlementFound.getRecoveries(), 1);
assert.equal(settlementFound.getRecord().state, "executing");
assert.equal(settlementFound.getRecord().execution.stages.clockStarted !== undefined, true);
assert.equal(settlementFound.getRecord().execution.stages.feeCaptured !== undefined, true);
assert.equal(settlementFound.getRotations(), 1, "persistent holds must rotate behind unscanned executions");

const indeterminate = harness({ receipt: relayReceipt({ delivered: false, recovered: true }), covenantState: 2 });
const indeterminateResult = await indeterminate.reconcile();
assert.equal(indeterminateResult.holds[0].reason, "provider_delivery_indeterminate_manual_resolution");
assert.equal(indeterminate.calls.mark, 0, "PolicyPool infrastructure loss must not slash the provider");
assert.equal(indeterminate.getRotations(), 1);

const refundedAfterSettlement = harness({ covenantState: 1, feeState: 3 });
const refundedAfterSettlementResult = await refundedAfterSettlement.reconcile();
assert.equal(refundedAfterSettlementResult.ok, true);
assert.equal(refundedAfterSettlement.calls.start, 1);
assert.equal(refundedAfterSettlement.calls.capture, 0);
assert.equal(refundedAfterSettlement.calls.release, 1);
assert.equal(refundedAfterSettlement.getRecord().state, "complete");
assert.equal(refundedAfterSettlement.getRecord().result.feeOutcome, "refunded_after_provider_settlement");
assert.equal(refundedAfterSettlement.getRotations(), 1);

const settledAfterCancellation = harness({ covenantState: 7, feeState: 3 });
const settledAfterCancellationResult = await settledAfterCancellation.reconcile();
assert.equal(settledAfterCancellationResult.holds[0].reason, "provider_settled_after_unpaid_cancellation_manual_resolution");
assert.equal(settledAfterCancellation.getRecord().state, "executing");
assert.equal(settledAfterCancellation.getRotations(), 1);

const breach = harness({ receipt: relayReceipt({ delivered: false }), covenantState: 2, nowSeconds: 1784289700 });
const marked = await breach.reconcile();
assert.equal(marked.ok, true);
assert.equal(breach.calls.mark, 1);
assert.equal(breach.calls.capture, 1);
assert.equal(breach.getRecord().state, "executing");
assert.equal(breach.getRotations(), 1);
breach.tick(24 * 60 * 60 + 1);
const settled = await breach.reconcile();
assert.equal(settled.ok, true);
assert.equal(breach.calls.settle, 1);
assert.equal(breach.getRecord().state, "complete");
assert.equal(breach.getRecord().result.coverageState, 5);
assert.equal(breach.getRotations(), 2);

const dryRun = harness();
assert.equal((await dryRun.reconcile({ dryRun: true })).ok, true);
assert.equal(dryRun.getRotations(), 0, "dry-run reconciliation must remain read-only");

const dryRunMissingReceipt = harness({ receipt: null });
const dryRunMissingResult = await dryRunMissingReceipt.reconcile({ dryRun: true });
assert.equal(dryRunMissingResult.holds[0].reason, "provider_recovery_not_run_in_dry_run");
assert.equal(dryRunMissingReceipt.getRecoveries(), 0, "dry runs must not persist a recovered receipt");

const invalidReceipt = harness({ receipt: { receiptId: "malformed" } });
const invalidReceiptResult = await invalidReceipt.reconcile();
assert.equal(invalidReceiptResult.ok, false);
assert.equal(invalidReceipt.getRotations(), 1, "failed executions must rotate instead of starving the queue");

console.log("PolicyPool direct A2MCP reconciler passed: unattended lifecycle handling plus fair rotation for holds and failures.");
