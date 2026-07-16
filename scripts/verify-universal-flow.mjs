import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createHandler } from "../api/covered-job-receipt.js";
import { PAYMENT, paymentRequirements } from "../api/lib/config.js";
import { MemoryLedger } from "../api/lib/ledger.js";
import { createPaymentService } from "../api/lib/payment.js";
import { createQuoteService } from "../api/lib/quote.js";
import { sha256 } from "../api/lib/utils.js";
import { callHandler, decodePaymentRequired } from "./lib/fake-vercel.mjs";

const now = Date.parse("2026-07-16T12:00:00.000Z");
const buyer = "0x1111111111111111111111111111111111111111";
const provider = "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51";
const jobId = `0x${"aa".repeat(32)}`;
const creationTx = `0x${"bb".repeat(32)}`;
const acceptanceTx = `0x${"cc".repeat(32)}`;
const policy = {
  agentId: "3808",
  agentName: "WARDEN",
  providerWallet: provider,
  serviceIds: ["33461"],
  serviceName: "Agent Endpoint Security Audit",
  serviceType: "A2MCP",
  serviceEndpoint: "https://warden.example/audit",
  serviceFingerprint: `0x${"dd".repeat(32)}`,
  publishedScope: ["deterministic endpoint security audit", "return result within 300 seconds"],
  requiredInputs: [],
  allowedKeywords: ["endpoint", "audit", "security"],
  slaSeconds: 300,
  enrollmentWindowSeconds: 60,
  maxCoverageAtomic: "500000",
  providerAvailableBondAtomic: "2000000",
  payoutBasis: "provider_bonded_sla_credit",
  clockMode: "policypool_relay",
  coverageStatus: "active",
  policyHash: `onchain:0x${"ee".repeat(32)}`,
  onchainPolicyId: `0x${"ee".repeat(32)}`,
  exclusions: [],
};
const body = {
  targetAgent: "3808",
  targetServiceId: "33461",
  targetJobId: jobId,
  targetCreationTxHash: creationTx,
  targetAcceptanceTxHash: acceptanceTx,
  jobDescription: "Run an endpoint security audit against the enrolled target.",
  requestedCoverageUSDT: "0.5",
};

function paymentHeader(tag, accepted) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${sha256(tag).padEnd(130, "0").slice(0, 130)}`,
      authorization: { nonce: `0x${sha256(`nonce:${tag}`)}` },
    },
  });
}

function runtime({ settlementFails = false, releaseFails = false } = {}) {
  const ledger = new MemoryLedger();
  const calls = { issue: 0, release: 0, settle: 0 };
  const chain = {
    async getReserveBalance() { return 9_000_000n; },
    async getJobStatus() { return 1; },
    async verifyTargetOrder() {
      return {
        jobId,
        creationTxHash: creationTx,
        acceptanceTxHash: acceptanceTx,
        createdAt: "2026-07-16T11:59:00.000Z",
        acceptedAt: "2026-07-16T11:59:30.000Z",
        buyer,
        provider,
        agentId: "3808",
        asset: PAYMENT.asset,
        amountAtomic: "500000",
        serviceHash: `0x${"0".repeat(64)}`,
        serviceType: "A2MCP",
        serviceTypeVerified: true,
        status: 1,
        statusLabel: "accepted",
      };
    },
    async verifySettlement({ txHash, payer, amountAtomic }) {
      return {
        txHash,
        blockNumber: "123",
        asset: PAYMENT.asset,
        from: payer,
        to: PAYMENT.payTo,
        amountAtomic,
      };
    },
  };
  const facilitator = {
    async verify(payload) {
      return { isValid: true, payer: buyer, extra: { authorization: payload.payload.authorization } };
    },
    async settle() {
      calls.settle += 1;
      if (settlementFails) return { success: false, errorReason: "simulated_failure" };
      return {
        success: true,
        network: "eip155:196",
        transaction: `0x${"12".repeat(32)}`,
        payer: buyer,
      };
    },
  };
  const payment = createPaymentService({ facilitator, chain });
  const quoteService = createQuoteService({
    ledger,
    secret: "universal-flow-test-secret-at-least-32-characters",
    now: () => now,
  });
  const universalIssuer = {
    previewCovenantId() { return `0x${"34".repeat(32)}`; },
    async issue() {
      calls.issue += 1;
      return {
        covenantId: `0x${"34".repeat(32)}`,
        transactionHash: `0x${"56".repeat(32)}`,
        blockNumber: "124",
      };
    },
    async release() {
      calls.release += 1;
      if (releaseFails) throw new Error("simulated_release_failure");
      return { transactionHash: `0x${"78".repeat(32)}`, blockNumber: "125" };
    },
  };
  const relayGrantService = {
    issue(input) {
      return {
        token: "signed-relay-grant",
        payload: {
          version: "0.4.0",
          grantId: "pprg-universal-flow",
          covenantId: input.covenantId,
          targetJobId: input.targetJobId,
          buyer: input.buyer,
          agentId: input.agentId,
          serviceId: input.serviceId,
          issuedAt: "2026-07-16T12:00:00.000Z",
          expiresAt: input.expiresAt,
        },
      };
    },
    tokenForPayload() { return "signed-relay-grant"; },
  };
  const handler = createHandler({
    ledger,
    chain,
    payment,
    quoteService,
    universalIssuer,
    relayGrantService,
    policyResolver: { async resolve() { return { policy, source: "v0.4_provider_enrollment_registry" }; } },
    now: () => now,
  });
  return { calls, handler, ledger };
}

const success = runtime();
const challengeResponse = await callHandler(success.handler, { method: "POST", body });
assert.equal(challengeResponse.statusCode, 402);
const challenge = decodePaymentRequired(challengeResponse.headers["payment-required"]);
const paid = await callHandler(success.handler, {
  method: "POST",
  body,
  headers: { "payment-signature": paymentHeader("universal-success", challenge.accepts[0]) },
});
assert.equal(paid.statusCode, 200);
assert.equal(paid.json().receipt.version, "0.4.0");
assert.equal(paid.json().receipt.outcome.status, "coverage_pending_provider_clock");
assert.equal(paid.json().receipt.covenant.onchain.covenantId, `0x${"34".repeat(32)}`);
assert.equal(paid.json().receipt.providerRelay.grantToken, "signed-relay-grant");
assert.equal(paid.json().receipt.reserve, null);
assert.equal(paid.json().receipt.providerBond.sharedReserveUsed, false);
assert.equal(paid.json().receipt.providerBond.lockedAtomic, "500000");
assert.equal((await success.ledger.list())[0].receipt.providerRelay.grantToken, undefined);
assert.equal(success.calls.issue, 1);
assert.equal(success.calls.settle, 1);
assert.equal((await success.ledger.stats()).committedAtomic, "0");

const failed = runtime({ settlementFails: true });
const failedChallengeResponse = await callHandler(failed.handler, { method: "POST", body });
const failedChallenge = decodePaymentRequired(failedChallengeResponse.headers["payment-required"]);
const failedPaid = await callHandler(failed.handler, {
  method: "POST",
  body,
  headers: { "payment-signature": paymentHeader("universal-failed", failedChallenge.accepts[0]) },
});
assert.equal(failedPaid.statusCode, 402);
assert.equal(failed.calls.issue, 1);
assert.equal(failed.calls.release, 1);
assert.equal((await failed.ledger.stats()).recordCount, 0);

const compensation = runtime({ settlementFails: true, releaseFails: true });
const compensationChallengeResponse = await callHandler(compensation.handler, { method: "POST", body });
const compensationChallenge = decodePaymentRequired(compensationChallengeResponse.headers["payment-required"]);
const compensationPaid = await callHandler(compensation.handler, {
  method: "POST",
  body,
  headers: { "payment-signature": paymentHeader("universal-compensation", compensationChallenge.accepts[0]) },
});
assert.equal(compensationPaid.statusCode, 503);
assert.equal(compensationPaid.json().error, "provider_bond_release_pending_retry");
assert.equal(compensationPaid.json().charged, false);
assert.equal(compensation.calls.issue, 1);
assert.equal(compensation.calls.release, 1);
const [compensationRecord] = await compensation.ledger.list();
assert.equal(compensationRecord.state, "compensation_required");
assert.equal(compensationRecord.compensation.reason, "coverage_fee_not_settled");
assert.equal(compensationRecord.universalCovenant.covenantId, `0x${"34".repeat(32)}`);

assert.equal(paymentRequirements().amount, "100000");
console.log("PolicyPool universal flow passed: provider bond locks before charge, compensates failed settlement, and retains retry evidence if release fails.");
