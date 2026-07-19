import assert from "node:assert/strict";
import {
  directPolicyFeeSettlementAction,
  DirectPolicyFeeError,
  finalizeDirectPolicyFee,
} from "../api/lib/direct-policy-fee.js";
import { createPolicyFeeEscrowClient, PolicyFeeEscrowError } from "../api/lib/policy-fee-escrow.js";

const feeEscrow = "0x1000000000000000000000000000000000000001";
const evidenceVerifier = "0x2000000000000000000000000000000000000002";
const treasury = "0x3000000000000000000000000000000000000003";
const buyer = "0x4000000000000000000000000000000000000004";
const policyId = `0x${"11".repeat(32)}`;
const jobId = `0x${"22".repeat(32)}`;
const providerAuthorizationHash = `0x${"33".repeat(32)}`;
const feeId = `0x${"44".repeat(32)}`;
const nonce = `0x${"55".repeat(32)}`;
const covenantId = `0x${"66".repeat(32)}`;
const relayReceiptDigest = `0x${"77".repeat(32)}`;
const settlementTransaction = `0x${"88".repeat(32)}`;
const captureDigest = `0x${"99".repeat(32)}`;
const orphanedRefundDigest = `0x${"98".repeat(32)}`;
const orphanedPaymentTransaction = `0x${"97".repeat(32)}`;
const writes = [];
const attestations = [];
const orphanedSearches = [];

const publicClient = {
  async readContract({ functionName }) {
    if (functionName === "feeAmountAtomic") return 100000n;
    if (functionName === "treasury") return treasury;
    if (functionName === "authorizationNonce") return nonce;
    if (functionName === "authorizationId") return feeId;
    if (functionName === "captureEvidenceDigest") return captureDigest;
    if (functionName === "orphanedRefundEvidenceDigest") return orphanedRefundDigest;
    if (functionName === "getFee") {
      return {
        buyer,
        covenantId,
        providerAuthorizationHash,
        amountAtomic: 100000n,
        fundedAt: 100n,
        authorizationValidBefore: 700n,
        refundAvailableAt: 820n,
        state: 1,
      };
    }
    assert.fail(`unexpected read ${functionName}`);
  },
  async simulateContract(request) {
    return { request };
  },
  async waitForTransactionReceipt() {
    return { status: "success", blockNumber: 123n };
  },
};
const walletClient = {
  async writeContract(request) {
    writes.push(request);
    return `0x${String(writes.length).padStart(64, "0")}`;
  },
};
const evidenceProvider = {
  async attest(input) {
    attestations.push(input);
    return [`0x${"aa".repeat(65)}`, `0x${"bb".repeat(65)}`, `0x${"cc".repeat(65)}`];
  },
};
const chainService = {
  async findProviderSettlement(input) {
    orphanedSearches.push(input);
    return { txHash: orphanedPaymentTransaction, blockNumber: "122" };
  },
};
const client = createPolicyFeeEscrowClient({
  configuration: {
    ready: true,
    feeEscrow,
    evidenceVerifier,
    evidenceAttestationUrl: "https://evidence.example/attest",
    evidenceThreshold: 3,
  },
  account: { address: "0x5000000000000000000000000000000000000005" },
  publicClient,
  walletClient,
  evidenceProvider,
  chainService,
  now: () => 500_000,
});

assert.deepEqual(await client.terms(), { amountAtomic: 100000n, treasury });
assert.deepEqual(await client.previewAuthorization({
  policyId,
  jobId,
  buyer,
  providerAuthorizationHash,
  validAfter: 0,
  validBefore: 700,
  providerAuthorizationValidBefore: 650,
}), { feeId, nonce, buyer });
await client.fund({
  buyer,
  policyId,
  jobId,
  providerAuthorizationHash,
  validAfter: 0,
  validBefore: 700,
  nonce,
  providerAuthorizationValidBefore: 650,
}, `0x${"12".repeat(65)}`);
assert.equal(writes[0].functionName, "fund");
assert.equal((await client.getFee(feeId)).state, 1);
await client.capture({
  feeId,
  covenantId,
  providerAuthorizationHash,
  relayReceiptDigest,
  providerSettlementTransaction: settlementTransaction,
  observedAt: 500,
}, { source: "verified-provider-relay" });
assert.equal(attestations[0].action, "capture_fee");
assert.equal(attestations[0].domain.manager, feeEscrow);
assert.equal(writes[1].functionName, "capture");
await client.refund(feeId);
assert.equal(writes[2].functionName, "refund");
const orphaned = await client.findOrphanedPayment({
  buyer,
  authorizationNonce: nonce,
  notBeforeTimestamp: 100,
  notAfterTimestamp: 700,
});
assert.equal(orphaned.txHash, orphanedPaymentTransaction);
assert.equal(orphanedSearches[0].payer, buyer);
assert.equal(orphanedSearches[0].payTo, feeEscrow);
assert.equal(orphanedSearches[0].amountAtomic, 100000n);
assert.equal(orphanedSearches[0].authorizationNonce, nonce);
await client.refundOrphaned({
  buyer,
  policyId,
  jobId,
  providerAuthorizationHash,
  validAfter: 0,
  validBefore: 700,
  nonce,
  providerAuthorizationValidBefore: 650,
}, {
  feeId,
  covenantId,
  authorizationNonce: nonce,
  paymentTransaction: orphanedPaymentTransaction,
  observedAt: 500,
}, { source: "verified-direct-fee-transfer" });
assert.equal(attestations[1].action, "refund_orphaned_fee");
assert.equal(attestations[1].digest, orphanedRefundDigest);
assert.equal(attestations[1].domain.manager, feeEscrow);
assert.equal(writes[3].functionName, "refundOrphaned");
assert.equal(writes[3].args[0].validBefore, 700n);
assert.equal(writes[3].args[1].observedAt, 500n);

assert.throws(
  () => createPolicyFeeEscrowClient({ configuration: { ready: true, evidenceVerifier } }),
  (error) => error instanceof PolicyFeeEscrowError && error.code === "policy_fee_escrow_not_configured",
);

function feeResolutionHarness({
  state = 1,
  nowSeconds = 819,
  refundAvailableAt = 820,
  captureRace = null,
  refundRace = null,
} = {}) {
  let nowMs = nowSeconds * 1_000;
  let fee = { state, refundAvailableAt };
  const calls = { capture: 0, refund: 0 };
  const escrow = {
    async getFee() { return structuredClone(fee); },
    async capture() {
      calls.capture += 1;
      if (captureRace === "boundary") {
        nowMs = refundAvailableAt * 1_000;
        throw new Error("capture crossed refund boundary");
      }
      if (captureRace === "captured") {
        fee.state = 2;
        throw new Error("concurrent capture won");
      }
      fee.state = 2;
      return { transactionHash: `0x${"91".repeat(32)}` };
    },
    async refund() {
      calls.refund += 1;
      if (refundRace === "refunded") {
        fee.state = 3;
        throw new Error("concurrent refund won");
      }
      fee.state = 3;
      return { transactionHash: `0x${"92".repeat(32)}` };
    },
  };
  return {
    calls,
    resolve: () => finalizeDirectPolicyFee({
      feeEscrow: escrow,
      feeId,
      captureEvidence: {
        feeId,
        covenantId,
        providerAuthorizationHash,
        relayReceiptDigest,
        providerSettlementTransaction: settlementTransaction,
        observedAt: nowSeconds,
      },
      now: () => nowMs,
    }),
  };
}

assert.equal(directPolicyFeeSettlementAction({ state: 1, refundAvailableAt: 820 }, 819), "capture");
assert.equal(directPolicyFeeSettlementAction({ state: 1, refundAvailableAt: 820 }, 820), "refund");
assert.equal(directPolicyFeeSettlementAction({ state: 1, refundAvailableAt: 820 }, 821), "refund");
assert.throws(
  () => directPolicyFeeSettlementAction({ state: 1, refundAvailableAt: 820 }, Number.NaN),
  (error) => error instanceof DirectPolicyFeeError
    && error.code === "direct_policy_fee_clock_invalid",
);

const beforeBoundary = feeResolutionHarness();
assert.equal((await beforeBoundary.resolve()).action, "capture");
assert.deepEqual(beforeBoundary.calls, { capture: 1, refund: 0 });

for (const nowSeconds of [820, 821]) {
  const atOrAfterBoundary = feeResolutionHarness({ nowSeconds });
  assert.equal((await atOrAfterBoundary.resolve()).action, "refund");
  assert.deepEqual(atOrAfterBoundary.calls, { capture: 0, refund: 1 });
}

for (const [state, action] of [[2, "already_captured"], [3, "already_refunded"]]) {
  const terminal = feeResolutionHarness({ state });
  assert.equal((await terminal.resolve()).action, action);
  assert.deepEqual(terminal.calls, { capture: 0, refund: 0 });
}

const crossedBoundary = feeResolutionHarness({ captureRace: "boundary" });
assert.equal((await crossedBoundary.resolve()).action, "refund");
assert.deepEqual(crossedBoundary.calls, { capture: 1, refund: 1 });

const concurrentCapture = feeResolutionHarness({ captureRace: "captured" });
const concurrentCaptureResult = await concurrentCapture.resolve();
assert.equal(concurrentCaptureResult.action, "already_captured");
assert.equal(concurrentCaptureResult.recovered, true);
assert.deepEqual(concurrentCapture.calls, { capture: 1, refund: 0 });

const concurrentRefund = feeResolutionHarness({ nowSeconds: 820, refundRace: "refunded" });
const concurrentRefundResult = await concurrentRefund.resolve();
assert.equal(concurrentRefundResult.action, "already_refunded");
assert.equal(concurrentRefundResult.recovered, true);
assert.deepEqual(concurrentRefund.calls, { capture: 0, refund: 1 });

await assert.rejects(
  () => feeResolutionHarness({ state: 0 }).resolve(),
  (error) => error instanceof DirectPolicyFeeError
    && error.code === "direct_policy_fee_state_invalid",
);

console.log("PolicyPool fee escrow client passed: canonical authorization preview, nonce-indexed orphan recovery, quorum refund, and one boundary-safe idempotent post-settlement transition.");
