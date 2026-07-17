import assert from "node:assert/strict";
import { authorizationTypes } from "@x402/evm";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDirectA2mcpCoordinator, DirectA2mcpError } from "../api/lib/direct-a2mcp.js";
import { createDirectA2mcpState, MemoryDirectA2mcpStore } from "../api/lib/direct-a2mcp-store.js";
import { ProviderRelayError } from "../api/lib/provider-relay.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import { sha256 } from "../api/lib/utils.js";

const buyer = privateKeyToAccount(generatePrivateKey());
const wrongBuyer = privateKeyToAccount(generatePrivateKey());
const provider = "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51";
const providerRequest = { target_url: "https://policypool.vercel.app/api/covered-job-receipt" };
const feeEscrowAddress = "0x1000000000000000000000000000000000000001";
const policyId = `0x${"11".repeat(32)}`;
const requestHash = `sha256:${sha256(providerRequest)}`;
const requirementsHash = `sha256:${"33".repeat(32)}`;
const challengeHash = `sha256:${"44".repeat(32)}`;
const serviceFingerprint = `0x${"55".repeat(32)}`;
const covenantId = `0x${"66".repeat(32)}`;
const feeId = `0x${"77".repeat(32)}`;
const feeNonce = `0x${"88".repeat(32)}`;
const relayReceiptDigest = `0x${"99".repeat(32)}`;
const settlementTransaction = `0x${"aa".repeat(32)}`;
const providerPaymentSignature = "provider-payment-signature-one";

function policy(overrides = {}) {
  return {
    agentId: "3808",
    serviceIds: ["33461"],
    serviceType: "A2MCP",
    serviceEndpoint: "https://warden.example/audit",
    servicePriceAtomic: "500000",
    providerWallet: provider,
    policyHash: `onchain:${policyId}`,
    onchainPolicyId: policyId,
    serviceFingerprint,
    maxCoverageAtomic: "500000",
    providerAvailableBondAtomic: "500000",
    premiumBps: 2000,
    slaSeconds: 300,
    enrollmentWindowSeconds: 60,
    ...overrides,
  };
}

function createHarness({
  loseProviderResponseOnce = false,
  failClockOnce = false,
  policyOverrides = {},
} = {}) {
  let nowMs = Date.parse("2026-07-17T12:00:00.000Z");
  let quoteSequence = 1;
  let covenant = { state: 0 };
  let fee = { state: 0 };
  let durableProviderResult = null;
  let loseResponse = loseProviderResponseOnce;
  let failClock = failClockOnce;
  let driftChallenge = false;
  let providerAuthorizationValidBefore = null;
  const currentPolicy = () => policy(policyOverrides);
  const calls = {
    capture: 0,
    executeProvider: 0,
    fund: 0,
    issue: 0,
    probe: 0,
    recover: 0,
    release: 0,
    startClock: 0,
  };
  const state = createDirectA2mcpState({
    store: new MemoryDirectA2mcpStore({ now: () => nowMs }),
    secret: "direct-a2mcp-coordinator-test-secret-at-least-thirty-two-bytes",
    now: () => nowMs,
    randomId: () => String(quoteSequence++).padStart(32, "0"),
  });
  const relay = {
    async probe() {
      calls.probe += 1;
      return {
        policy: currentPolicy(),
        endpoint: currentPolicy().serviceEndpoint,
        requestHash,
        providerChallengeHash: challengeHash,
        providerRequirementsHash: driftChallenge ? `sha256:${"ff".repeat(32)}` : requirementsHash,
        paymentRequired: {
          x402Version: 2,
          resource: { url: policy().serviceEndpoint, description: "audit", mimeType: "application/json" },
          accepts: [{
            scheme: "exact",
            network: XLAYER.network,
            asset: PAYMENT.asset,
            amount: currentPolicy().servicePriceAtomic,
            payTo: provider,
            maxTimeoutSeconds: 600,
            extra: { name: PAYMENT.name, version: PAYMENT.version },
          }],
        },
        accepted: {
          scheme: "exact",
          network: XLAYER.network,
          asset: PAYMENT.asset,
          amount: currentPolicy().servicePriceAtomic,
          payTo: provider,
          maxTimeoutSeconds: 600,
          extra: { name: PAYMENT.name, version: PAYMENT.version },
        },
      };
    },
    async verifyAuthorization({ raw, buyer: expectedBuyer, allowExpired = false }) {
      if (!raw) throw new ProviderRelayError("provider_payment_signature_required", 402);
      if (getAddress(expectedBuyer) !== buyer.address) throw new ProviderRelayError("provider_payment_payer_mismatch", 400);
      providerAuthorizationValidBefore ||= Math.floor(nowMs / 1_000) + 500;
      if (!allowExpired && providerAuthorizationValidBefore <= Math.floor(nowMs / 1_000)) {
        throw new ProviderRelayError("provider_payment_authorization_expired", 400);
      }
      return {
        id: `sha256:${sha256(raw)}`,
        hash: `0x${sha256(raw)}`,
        payer: buyer.address,
        validAfter: "0",
        validBefore: String(providerAuthorizationValidBefore),
        nonce: `0x${"ab".repeat(32)}`,
        requirementsHash,
      };
    },
    async recover() {
      calls.recover += 1;
      if (!durableProviderResult) throw new ProviderRelayError("provider_payment_settlement_not_found", 404);
      return { ...durableProviderResult, recovered: true };
    },
    async execute() {
      calls.executeProvider += 1;
      const startedAt = new Date(nowMs).toISOString();
      const receipt = {
        receiptId: "ppr-direct-coordinator",
        receiptDigest: relayReceiptDigest,
        requestId: `sha256:${"bc".repeat(32)}`,
        response: loseResponse
          ? { status: null, recovery: "provider_settlement_found_without_durable_upstream_response" }
          : { status: 200 },
        settlement: { transaction: settlementTransaction },
        clock: {
          startedAt,
          completedAt: new Date(nowMs + 1_000).toISOString(),
          delivered: true,
          completedWithinSla: true,
        },
      };
      durableProviderResult = {
        receipt,
        upstream: loseResponse ? null : {
          status: 200,
          headers: { "content-type": "application/json" },
          contentType: "application/json",
          bodyBase64: Buffer.from(JSON.stringify({ grade: "PASS" })).toString("base64"),
        },
      };
      if (loseResponse) {
        loseResponse = false;
        throw new ProviderRelayError("provider_relay_commit_failed", 503);
      }
      return durableProviderResult;
    },
  };
  const issuer = {
    previewCovenantId() { return covenantId; },
    async getCovenant() { return structuredClone(covenant); },
    async issue({ policy: suppliedPolicy, targetOrder, paymentAuthorization }) {
      calls.issue += 1;
      assert.equal(suppliedPolicy.onchainPolicyId, policyId);
      assert.match(targetOrder.acceptanceEvidenceHash, /^0x[a-f0-9]{64}$/);
      covenant = {
        id: covenantId,
        policyId,
        jobId: targetOrder.jobId,
        buyer: targetOrder.buyer,
        feeAuthorizationHash: paymentAuthorization.hash,
        feeAuthorizationValidBefore: paymentAuthorization.validBefore,
        state: 1,
      };
      return { covenantId, transactionHash: `0x${"01".repeat(32)}` };
    },
    async startClock() {
      calls.startClock += 1;
      if (failClock) {
        failClock = false;
        throw new Error("simulated clock RPC failure");
      }
      covenant.state = 2;
      return { transactionHash: `0x${"02".repeat(32)}` };
    },
    async release() {
      calls.release += 1;
      covenant.state = 3;
      return { transactionHash: `0x${"03".repeat(32)}` };
    },
  };
  const feeEscrow = {
    async terms() { return { amountAtomic: 100000n, treasury: "0x2000000000000000000000000000000000000002" }; },
    async previewAuthorization() { return { feeId, nonce: feeNonce, buyer: buyer.address }; },
    async getFee() { return structuredClone(fee); },
    async fund() {
      calls.fund += 1;
      fee = {
        buyer: buyer.address,
        covenantId,
        providerAuthorizationHash: `0x${sha256(providerPaymentSignature)}`,
        amountAtomic: "100000",
        state: 1,
      };
      return { transactionHash: `0x${"04".repeat(32)}` };
    },
    async capture() {
      calls.capture += 1;
      fee.state = 2;
      return { transactionHash: `0x${"05".repeat(32)}` };
    },
  };
  const chain = {
    async verifyProviderPaymentAuthorization(input) {
      return verifyTypedData({
        address: input.payer,
        domain: {
          name: input.name,
          version: input.version,
          chainId: XLAYER.id,
          verifyingContract: input.asset,
        },
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          ...input.authorization,
          value: BigInt(input.authorization.value),
          validAfter: BigInt(input.authorization.validAfter),
          validBefore: BigInt(input.authorization.validBefore),
        },
        signature: input.signature,
      });
    },
  };
  const grantService = {
    issue() {
      return { token: "signed-direct-relay-grant", payload: { grantId: "pprg-direct" } };
    },
  };
  const coordinator = createDirectA2mcpCoordinator({
    state,
    relay,
    feeEscrow,
    issuer,
    grantService,
    chain,
    configuration: { directA2mcpEnabled: true, feeEscrow: feeEscrowAddress },
    now: () => nowMs,
  });

  async function bindAndSign({ feeSigner = buyer, requestedCoverageUSDT = "0.5" } = {}) {
    const quoted = await coordinator.quote({
      buyer: buyer.address,
      agentId: "3808",
      serviceId: "33461",
      providerRequest,
      requestedCoverageUSDT,
    });
    const bound = await coordinator.bind({
      token: quoted.quote.token,
      providerRequest,
      providerPaymentSignature,
    });
    const authorization = bound.authorization;
    const signature = await feeSigner.signTypedData({
      domain: {
        name: PAYMENT.name,
        version: PAYMENT.version,
        chainId: XLAYER.id,
        verifyingContract: PAYMENT.asset,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
      },
    });
    const feePayment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: bound.requirements,
      payload: { authorization, signature },
    });
    return { bound, feePayment, quoted };
  }

  return {
    bindAndSign,
    calls,
    coordinator,
    drift() { driftChallenge = true; },
    now() { return nowMs; },
    setFeeState(value) { fee.state = value; },
    tick(milliseconds) { nowMs += milliseconds; },
  };
}

const variableCap = createHarness({
  policyOverrides: {
    servicePriceAtomic: "1000000",
    maxCoverageAtomic: "1000000",
    providerAvailableBondAtomic: "1000000",
    premiumBps: 1000,
  },
});
await assert.rejects(
  () => variableCap.bindAndSign({ requestedCoverageUSDT: "0.5" }),
  (error) => error instanceof DirectA2mcpError
    && error.code === "direct_coverage_cap_must_equal_policy_cap",
  "a fixed-fee direct policy must reject partial coverage before either payment is requested",
);
assert.equal(variableCap.calls.issue, 0);
assert.equal(variableCap.calls.fund, 0);
const variableFullCap = await variableCap.bindAndSign({ requestedCoverageUSDT: "1" });
assert.equal(variableFullCap.quoted.quote.coverageCapAtomic, "1000000");
assert.equal(variableFullCap.quoted.quote.feeAmountAtomic, "100000");

const happy = createHarness();
const happyFlow = await happy.bindAndSign();
happy.tick(2_000);
const completed = await happy.coordinator.execute({
  token: happyFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: happyFlow.feePayment,
});
assert.equal(completed.ok, true);
assert.equal(completed.feeState, 2);
assert.equal(completed.coverageState, 3);
assert.equal(completed.providerDeliveryStatus, "response_available");
assert.equal(happy.calls.issue, 1);
assert.equal(happy.calls.fund, 1);
assert.equal(happy.calls.executeProvider, 1);
assert.equal(happy.calls.capture, 1);
assert.equal(happy.calls.release, 1);
const replayed = await happy.coordinator.execute({
  token: happyFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: happyFlow.feePayment,
});
assert.equal(replayed.replay, true);
assert.equal(replayed.providerResponse.status, 200);
happy.tick(600_000);
const replayedAfterExpiry = await happy.coordinator.execute({
  token: happyFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: happyFlow.feePayment,
});
assert.equal(replayedAfterExpiry.replay, true);
assert.equal(replayedAfterExpiry.providerResponse.status, 200);
assert.equal(happy.calls.executeProvider, 1, "expired exact replay must not call the provider again");
assert.equal(happy.calls.fund, 1, "expired exact replay must not fund the fee again");
await assert.rejects(
  () => happy.coordinator.execute({
    token: happyFlow.quoted.quote.token,
    providerRequest,
    providerPaymentSignature: "substituted-provider-payment-signature",
    policyFeePaymentSignature: happyFlow.feePayment,
  }),
  (error) => error instanceof DirectA2mcpError && error.code === "provider_authorization_changed",
);
await assert.rejects(
  () => happy.coordinator.execute({
    token: happyFlow.quoted.quote.token,
    providerRequest,
    providerPaymentSignature,
    policyFeePaymentSignature: "substituted-policy-fee-signature",
  }),
  (error) => error instanceof DirectA2mcpError && error.code === "policy_fee_signature_malformed",
);

const refundedAfterSettlement = createHarness({ failClockOnce: true });
const refundedFlow = await refundedAfterSettlement.bindAndSign();
const interruptedAfterSettlement = await refundedAfterSettlement.coordinator.execute({
  token: refundedFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: refundedFlow.feePayment,
});
assert.equal(interruptedAfterSettlement.lifecyclePending, true);
refundedAfterSettlement.setFeeState(3);
const recoveredAfterRefund = await refundedAfterSettlement.coordinator.execute({
  token: refundedFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: refundedFlow.feePayment,
});
assert.equal(recoveredAfterRefund.ok, true);
assert.equal(recoveredAfterRefund.feeState, 3);
assert.equal(recoveredAfterRefund.feeOutcome, "refunded_after_provider_settlement");
assert.equal(recoveredAfterRefund.coverageState, 3);
assert.equal(refundedAfterSettlement.calls.executeProvider, 1);
assert.equal(refundedAfterSettlement.calls.capture, 0);
assert.equal(refundedAfterSettlement.calls.release, 1);
assert.equal(happy.calls.executeProvider, 1, "replay must never call or charge the provider twice");
assert.equal(happy.calls.fund, 1, "replay must never fund the fee twice");

const bodyDrift = createHarness();
const bodyDriftFlow = await bodyDrift.bindAndSign();
await assert.rejects(
  () => bodyDrift.coordinator.execute({
    token: bodyDriftFlow.quoted.quote.token,
    providerRequest: { ...providerRequest, target_url: "https://example.com/substituted" },
    providerPaymentSignature,
    policyFeePaymentSignature: bodyDriftFlow.feePayment,
  }),
  (error) => error instanceof DirectA2mcpError && error.code === "provider_request_changed",
);
assert.equal(bodyDrift.calls.issue, 0);
assert.equal(bodyDrift.calls.fund, 0);

const challengeDrift = createHarness();
const challengeDriftFlow = await challengeDrift.bindAndSign();
challengeDrift.drift();
await assert.rejects(
  () => challengeDrift.coordinator.execute({
    token: challengeDriftFlow.quoted.quote.token,
    providerRequest,
    providerPaymentSignature,
    policyFeePaymentSignature: challengeDriftFlow.feePayment,
  }),
  (error) => error instanceof DirectA2mcpError && error.code === "direct_quote_policy_or_challenge_changed",
);
assert.equal(challengeDrift.calls.issue, 0, "challenge drift must fail before covenant issue");
assert.equal(challengeDrift.calls.fund, 0, "challenge drift must fail before fee escrow funding");

const wrongPayer = createHarness();
const wrongPayerFlow = await wrongPayer.bindAndSign({ feeSigner: wrongBuyer });
await assert.rejects(
  () => wrongPayer.coordinator.execute({
    token: wrongPayerFlow.quoted.quote.token,
    providerRequest,
    providerPaymentSignature,
    policyFeePaymentSignature: wrongPayerFlow.feePayment,
  }),
  (error) => error instanceof DirectA2mcpError && error.code === "policy_fee_signature_invalid",
);
assert.equal(wrongPayer.calls.issue, 0);

const clockCrash = createHarness({ failClockOnce: true });
const clockCrashFlow = await clockCrash.bindAndSign();
const pending = await clockCrash.coordinator.execute({
  token: clockCrashFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: clockCrashFlow.feePayment,
});
assert.equal(pending.lifecyclePending, true);
assert.equal(pending.providerResponse.status, 200, "a paid provider response must not be hidden by a clock RPC failure");
const resumed = await clockCrash.coordinator.execute({
  token: clockCrashFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: clockCrashFlow.feePayment,
});
assert.equal(resumed.coverageState, 3);
assert.equal(clockCrash.calls.executeProvider, 1);
assert.equal(clockCrash.calls.issue, 1);
assert.equal(clockCrash.calls.fund, 1);

const lostResponse = createHarness({ loseProviderResponseOnce: true });
const lostResponseFlow = await lostResponse.bindAndSign();
await assert.rejects(
  () => lostResponse.coordinator.execute({
    token: lostResponseFlow.quoted.quote.token,
    providerRequest,
    providerPaymentSignature,
    policyFeePaymentSignature: lostResponseFlow.feePayment,
  }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_relay_commit_failed",
);
const recovered = await lostResponse.coordinator.execute({
  token: lostResponseFlow.quoted.quote.token,
  providerRequest,
  providerPaymentSignature,
  policyFeePaymentSignature: lostResponseFlow.feePayment,
});
assert.equal(recovered.ok, true);
assert.equal(recovered.lifecyclePending, true);
assert.equal(recovered.pendingReason, "provider_delivery_indeterminate_manual_resolution");
assert.equal(recovered.providerResponse, null);
assert.equal(recovered.providerDeliveryStatus, "settled_response_unavailable_coverage_remains_active");
assert.equal(lostResponse.calls.executeProvider, 1, "an uncertain settled provider call must never be replayed");
assert.equal(lostResponse.calls.issue, 1);
assert.equal(lostResponse.calls.fund, 1);

console.log("PolicyPool direct A2MCP coordinator passed: immutable two-payment binding, pre-fund drift rejection, one-time provider settlement, durable deliverable replay, crash resume, and no duplicate issue/fund/capture.");
