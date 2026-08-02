import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import { createHandler } from "../api/covered-job-receipt.js";
import { PAYMENT, paymentRequirements } from "../api/lib/config.js";
import { MemoryLedger, RedisLedger } from "../api/lib/ledger.js";
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
  targetTaskReference: "405668",
  jobDescription: "Run an endpoint security audit against the enrolled target.",
  requestedCoverageUSDT: "0.5",
};

function paymentHeader(tag, accepted) {
  const nonce = `0x${sha256(`nonce:${tag}`)}`;
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${sha256(tag).padEnd(130, "0").slice(0, 130)}`,
      authorization: {
        from: buyer,
        to: PAYMENT.payTo,
        value: PAYMENT.amountAtomic,
        validAfter: "0",
        validBefore: String(Math.floor(now / 1_000) + 600),
        nonce,
      },
    },
  });
}

function runtime({
  settlementFails = false,
  settlementThrows = false,
  recoveredSettlementStatus = "pending",
  issuanceFails = false,
  transitionUniversalFailsOnCall = 0,
} = {}) {
  const ledger = new MemoryLedger();
  const calls = { issue: 0, cancel: 0, settle: 0, reconcile: 0, recoveryNonces: [] };
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
    async findProviderSettlement({ payer, payTo, asset, amountAtomic, authorizationNonce }) {
      calls.reconcile += 1;
      calls.recoveryNonces.push(authorizationNonce || null);
      if (recoveredSettlementStatus === "pending") {
        const error = new Error("provider_settlement_search_window_incomplete");
        error.code = "provider_settlement_search_window_incomplete";
        throw error;
      }
      if (recoveredSettlementStatus === "not_found") return null;
      return {
        txHash: `0x${"90".repeat(32)}`,
        blockNumber: "126",
        asset,
        from: payer,
        to: payTo,
        amountAtomic,
        authorizationNonce,
      };
    },
  };
  const facilitator = {
    async verify(payload) {
      return { isValid: true, payer: buyer, extra: { authorization: payload.payload.authorization } };
    },
    async settle() {
      calls.settle += 1;
      if (settlementThrows) throw new Error("simulated_settlement_transport_failure");
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
  if (transitionUniversalFailsOnCall > 0) {
    const transitionUniversal = ledger.transitionUniversal.bind(ledger);
    let transitions = 0;
    ledger.transitionUniversal = async (...args) => {
      transitions += 1;
      if (transitions === transitionUniversalFailsOnCall) {
        throw new Error("simulated_universal_transition_failure");
      }
      return transitionUniversal(...args);
    };
  }
  const universalIssuer = {
    previewCovenantId() { return `0x${"34".repeat(32)}`; },
    async issue({ paymentAuthorization }) {
      assert.match(paymentAuthorization.hash, /^0x[a-f0-9]{64}$/);
      assert.equal(paymentAuthorization.validBefore, String(Math.floor(now / 1_000) + 600));
      calls.issue += 1;
      if (issuanceFails) throw new Error("simulated_receipt_wait_failure");
      return {
        covenantId: `0x${"34".repeat(32)}`,
        transactionHash: `0x${"56".repeat(32)}`,
        blockNumber: "124",
      };
    },
    async cancelUnpaid() {
      calls.cancel += 1;
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
assert.equal(failed.calls.issue, 1);
assert.equal(failedPaid.statusCode, 503);
assert.equal(failedPaid.headers["payment-required"], undefined);
assert.equal(failedPaid.headers["payment-response"], undefined);
assert.equal(failedPaid.headers["x-payment-response"], undefined);
assert.equal(failedPaid.json().error, "payment_settlement_outcome_unknown");
assert.equal(failedPaid.json().charged, null);
assert.equal(failedPaid.json().settlement, "unknown");
assert.equal(failed.calls.cancel, 0);
const [failedPending] = await failed.ledger.list();
assert.equal(failedPending.state, "pending");
assert.equal(failedPending.settlement.status, "unknown");
assert.equal(failedPending.compensation, undefined);
assert.equal(failedPending.universalCovenant.covenantId, `0x${"34".repeat(32)}`);
assert.equal(failedPending.providerBondLiabilityAtomic, "500000");

const lateMined = runtime({ settlementFails: true, recoveredSettlementStatus: "settled" });
const lateMinedChallengeResponse = await callHandler(lateMined.handler, { method: "POST", body });
const lateMinedChallenge = decodePaymentRequired(lateMinedChallengeResponse.headers["payment-required"]);
const lateMinedRequest = {
  method: "POST",
  body,
  headers: {
    "payment-signature": paymentHeader("universal-late-mined", lateMinedChallenge.accepts[0]),
  },
};
const lateMinedFirst = await callHandler(lateMined.handler, lateMinedRequest);
assert.equal(lateMinedFirst.statusCode, 503);
assert.equal(lateMinedFirst.headers["payment-required"], undefined);
assert.equal(lateMinedFirst.headers["payment-response"], undefined);
assert.equal(lateMinedFirst.headers["x-payment-response"], undefined);
assert.equal(lateMinedFirst.json().error, "payment_settlement_outcome_unknown");
assert.equal(lateMinedFirst.json().charged, null);
assert.equal((await lateMined.ledger.list())[0].state, "pending");
assert.equal((await lateMined.ledger.list())[0].settlement.status, "unknown");
const lateMinedRecovered = await callHandler(lateMined.handler, lateMinedRequest);
assert.equal(lateMinedRecovered.statusCode, 200);
assert.equal(lateMinedRecovered.json().receipt.version, "0.4.0");
assert.equal(lateMinedRecovered.json().state, "pending_start");
assert.equal((await lateMined.ledger.list())[0].state, "pending_start");
assert.ok((await lateMined.ledger.list())[0].receipt);
assert.equal(lateMined.calls.settle, 1, "a recovered late-mined fee must never settle twice");
assert.equal(lateMined.calls.reconcile, 1);
assert.deepEqual(lateMined.calls.recoveryNonces, [
  `0x${sha256("nonce:universal-late-mined")}`,
]);

const compensationRecord = {
  receiptId: "redis-compensation",
  state: "compensation_required",
  liabilityAtomic: "0",
  settlement: { status: "submitting" },
};
let redisStored = JSON.stringify(compensationRecord);
const redis = {
  async eval(script, keys, argv) {
    assert.match(
      script,
      /decoded\.state ~= 'pending' and decoded\.state ~= 'compensation_required'/,
      "the Redis finalizer must atomically admit a compensated recovery",
    );
    assert.equal(keys[0], "test:receipt:redis-compensation");
    const current = JSON.parse(redisStored);
    if (!["pending", "compensation_required"].includes(current.state)) {
      return ["existing", redisStored];
    }
    redisStored = argv[0];
    return ["finalized", redisStored];
  },
};
const redisLedger = new RedisLedger({ redis, prefix: "test" });
const redisFinal = await redisLedger.finalize({
  ...compensationRecord,
  receiptId: "redis-compensation",
  state: "pending_start",
  settlement: { transaction: `0x${"91".repeat(32)}` },
  receipt: { receiptId: "redis-compensation" },
});
assert.equal(redisFinal.state, "pending_start");
assert.equal(redisFinal.receipt.receiptId, "redis-compensation");

const failedCompensationWrite = runtime({
  settlementThrows: true,
  recoveredSettlementStatus: "not_found",
  transitionUniversalFailsOnCall: 2,
});
const failedCompensationChallengeResponse = await callHandler(
  failedCompensationWrite.handler,
  { method: "POST", body },
);
const failedCompensationChallenge = decodePaymentRequired(
  failedCompensationChallengeResponse.headers["payment-required"],
);
const failedCompensationResponse = await callHandler(failedCompensationWrite.handler, {
  method: "POST",
  body,
  headers: {
    "payment-signature": paymentHeader(
      "universal-compensation-write-failure",
      failedCompensationChallenge.accepts[0],
    ),
  },
});
assert.equal(failedCompensationResponse.statusCode, 503);
assert.equal(failedCompensationResponse.headers["payment-required"], undefined);
assert.equal(failedCompensationResponse.json().error, "payment_settlement_outcome_unknown");
assert.equal(failedCompensationResponse.json().charged, null);
const failedCompensationRecovery = await callHandler(
  failedCompensationWrite.handler,
  {
    method: "POST",
    body,
    headers: {
      "payment-signature": paymentHeader(
        "universal-compensation-write-failure",
        failedCompensationChallenge.accepts[0],
      ),
    },
  },
);
assert.equal(failedCompensationRecovery.statusCode, 503);
assert.equal(failedCompensationRecovery.headers["payment-required"], undefined);
assert.equal(
  failedCompensationRecovery.json().error,
  "durable_settlement_reconciliation_unavailable",
);
assert.equal(failedCompensationRecovery.json().charged, null);
assert.equal(failedCompensationRecovery.json().settlement, "unknown");
assert.equal(failedCompensationRecovery.json().retryable, false);
assert.equal(
  failedCompensationRecovery.json().nextAction,
  "MANUAL_PAYMENT_RECONCILIATION_REQUIRED",
);
const [failedCompensationRecord] = await failedCompensationWrite.ledger.list();
assert.equal(failedCompensationRecord.state, "pending");
assert.equal(failedCompensationRecord.settlement.status, "unknown");
assert.equal(failedCompensationWrite.calls.settle, 1);
assert.equal(failedCompensationWrite.calls.reconcile, 1);

const ambiguous = runtime({ settlementThrows: true, recoveredSettlementStatus: "settled" });
const ambiguousChallengeResponse = await callHandler(ambiguous.handler, { method: "POST", body });
const ambiguousChallenge = decodePaymentRequired(ambiguousChallengeResponse.headers["payment-required"]);
const ambiguousHeader = paymentHeader("universal-ambiguous", ambiguousChallenge.accepts[0]);
const ambiguousRequest = {
  method: "POST",
  body,
  headers: { "payment-signature": ambiguousHeader },
};
const ambiguousFirst = await callHandler(ambiguous.handler, ambiguousRequest);
assert.equal(ambiguousFirst.statusCode, 503);
assert.equal(ambiguousFirst.json().error, "payment_settlement_outcome_unknown");
assert.equal(ambiguousFirst.json().charged, null);
const [ambiguousPending] = await ambiguous.ledger.list();
assert.equal(ambiguousPending.state, "pending");
assert.equal(ambiguousPending.settlement.status, "unknown");
assert.equal(ambiguousPending.compensation, undefined);
assert.equal(ambiguousPending.universalCovenant.covenantId, `0x${"34".repeat(32)}`);
assert.equal(ambiguousPending.relayGrantPayload.grantId, "pprg-universal-flow");

const ambiguousRecovered = await callHandler(ambiguous.handler, ambiguousRequest);
assert.equal(ambiguousRecovered.statusCode, 200);
assert.equal(ambiguousRecovered.json().receipt.version, "0.4.0");
assert.equal(ambiguousRecovered.json().receipt.covenant.onchain.covenantId, `0x${"34".repeat(32)}`);
assert.equal(ambiguousRecovered.json().receipt.providerRelay.grantToken, "signed-relay-grant");
assert.equal(ambiguous.calls.settle, 1, "universal recovery must never settle twice");
assert.equal(ambiguous.calls.reconcile, 1);
assert.equal((await ambiguous.ledger.list())[0].state, "pending_start");

const universalNoMatch = runtime({ settlementFails: true, recoveredSettlementStatus: "not_found" });
const universalNoMatchChallengeResponse = await callHandler(
  universalNoMatch.handler,
  { method: "POST", body },
);
const universalNoMatchChallenge = decodePaymentRequired(
  universalNoMatchChallengeResponse.headers["payment-required"],
);
const universalNoMatchRequest = {
  method: "POST",
  body,
  headers: {
    "payment-signature": paymentHeader("universal-no-match", universalNoMatchChallenge.accepts[0]),
  },
};
const universalNoMatchUnknown = await callHandler(
  universalNoMatch.handler,
  universalNoMatchRequest,
);
assert.equal(universalNoMatchUnknown.statusCode, 503);
assert.equal(universalNoMatchUnknown.headers["payment-required"], undefined);
assert.equal(universalNoMatchUnknown.headers["payment-response"], undefined);
assert.equal(universalNoMatchUnknown.headers["x-payment-response"], undefined);
assert.equal(universalNoMatchUnknown.json().charged, null);
assert.equal(universalNoMatchUnknown.json().settlement, "unknown");
assert.equal((await universalNoMatch.ledger.list())[0].state, "pending");
assert.equal((await universalNoMatch.ledger.list())[0].settlement.status, "unknown");
assert.equal((await universalNoMatch.ledger.list())[0].compensation, undefined);
const universalNoMatchRecovered = await callHandler(
  universalNoMatch.handler,
  universalNoMatchRequest,
);
assert.equal(universalNoMatchRecovered.statusCode, 503);
assert.equal(
  universalNoMatchRecovered.json().error,
  "provider_bond_cancellation_pending_authorization_expiry",
);
assert.equal(universalNoMatchRecovered.json().charged, false);
assert.equal((await universalNoMatch.ledger.list())[0].state, "compensation_required");
assert.equal(universalNoMatch.calls.settle, 1);
assert.equal(universalNoMatch.calls.reconcile, 1);

const uncertain = runtime({ issuanceFails: true });
const uncertainChallengeResponse = await callHandler(uncertain.handler, { method: "POST", body });
const uncertainChallenge = decodePaymentRequired(uncertainChallengeResponse.headers["payment-required"]);
const uncertainPaid = await callHandler(uncertain.handler, {
  method: "POST",
  body,
  headers: { "payment-signature": paymentHeader("universal-uncertain", uncertainChallenge.accepts[0]) },
});
assert.equal(uncertainPaid.statusCode, 503);
assert.equal(uncertain.calls.issue, 1);
assert.equal(uncertain.calls.settle, 0);
const [uncertainRecord] = await uncertain.ledger.list();
assert.equal(uncertainRecord.state, "compensation_required");
assert.equal(uncertainRecord.compensation.reason, "coverage_issuance_outcome_unconfirmed");
assert.equal(uncertainRecord.universalCovenant.covenantId, `0x${"34".repeat(32)}`);

assert.equal(paymentRequirements().amount, "100000");
console.log("PolicyPool universal flow passed: provider bond locks before charge, every post-submit uncertainty remains nonce-recoverable, and only a complete no-match enters compensation.");
