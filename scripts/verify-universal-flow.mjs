import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import { createHandler } from "../api/covered-job-receipt.js";
import { createCoverageStatusHandler } from "../api/coverage-status.js";
import { PAYMENT, paymentRequirements } from "../api/lib/config.js";
import { MemoryLedger, RedisLedger } from "../api/lib/ledger.js";
import { createPaymentService } from "../api/lib/payment.js";
import { createQuoteService } from "../api/lib/quote.js";
import { computeReceiptHash } from "../api/lib/receipt-integrity.js";
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
const [storedSuccess] = await success.ledger.list();
assert.equal(storedSuccess.receipt.providerRelay.grantToken, undefined);
assert.equal(storedSuccess.receiptIntegrityAnchor.receiptHash, storedSuccess.receipt.receiptHash);
assert.equal(
  storedSuccess.receiptIntegrityAnchor.providerRelayEndpoint,
  "https://policypool.dolepee.com/api/provider-relay",
);
assert.equal(success.calls.issue, 1);
assert.equal(success.calls.settle, 1);
assert.equal((await success.ledger.stats()).committedAtomic, "0");

const savedPublicOrigin = process.env.POLICYPOOL_PUBLIC_ORIGIN;
const savedPublicPathPrefix = process.env.POLICYPOOL_PUBLIC_PATH_PREFIX;
const savedReceiptIntegrityMigrations = process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS;
const approveReceiptMigration = (record) => {
  process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS = JSON.stringify([{
    receiptId: record.receiptId,
    receiptHash: record.receipt.receiptHash,
    providerRelayEndpoint: record.receipt.providerRelay.endpoint,
  }]);
};
try {
  delete process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS;
  const productionFixtures = JSON.parse(
    await readFile(new URL("./fixtures/coverage-receipts.json", import.meta.url), "utf8"),
  );
  const historicalNonRelay = structuredClone(
    productionFixtures["ppc-0b0e52828eb26727"],
  );
  const historicalNonRelayLedger = new MemoryLedger();
  historicalNonRelayLedger.records.set(historicalNonRelay.receiptId, historicalNonRelay);
  const historicalNonRelayStatus = await callHandler(createCoverageStatusHandler({
    ledger: historicalNonRelayLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: historicalNonRelay.receiptId },
  });
  assert.equal(historicalNonRelayStatus.statusCode, 200);
  assert.equal(
    (await historicalNonRelayLedger.get(historicalNonRelay.receiptId))
      .receiptIntegrityAnchor.receiptHash,
    historicalNonRelay.receipt.receiptHash,
  );

  process.env.POLICYPOOL_PUBLIC_ORIGIN = "https://policypool.vercel.app";
  delete process.env.POLICYPOOL_PUBLIC_PATH_PREFIX;
  const legacy = runtime();
  const legacyChallengeResponse = await callHandler(legacy.handler, { method: "POST", body });
  const legacyChallenge = decodePaymentRequired(
    legacyChallengeResponse.headers["payment-required"],
  );
  const legacyRequest = {
    method: "POST",
    body,
    headers: {
      "payment-signature": paymentHeader("universal-legacy-anchor", legacyChallenge.accepts[0]),
    },
  };
  const legacyPaid = await callHandler(legacy.handler, legacyRequest);
  assert.equal(legacyPaid.statusCode, 200);
  assert.equal(
    legacyPaid.json().receipt.providerRelay.endpoint,
    "https://policypool.vercel.app/api/provider-relay",
  );
  const legacyStored = await legacy.ledger.get(legacyPaid.json().receipt.receiptId);
  const preAnchorRecord = structuredClone(legacyStored);
  delete preAnchorRecord.receiptIntegrityAnchor;
  delete preAnchorRecord.receiptDocumentKind;
  legacy.ledger.records.set(preAnchorRecord.receiptId, preAnchorRecord);
  legacy.ledger.receiptIntegrityAnchors.delete(preAnchorRecord.receiptId);

  process.env.POLICYPOOL_PUBLIC_ORIGIN = "https://policypool.dolepee.com";
  delete process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS;
  const unmappedLegacyLedger = new MemoryLedger();
  unmappedLegacyLedger.records.set(preAnchorRecord.receiptId, preAnchorRecord);
  const unmappedLegacyStatus = await callHandler(createCoverageStatusHandler({
    ledger: unmappedLegacyLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: preAnchorRecord.receiptId },
  });
  assert.equal(unmappedLegacyStatus.statusCode, 409);
  assert.equal(
    unmappedLegacyStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  approveReceiptMigration(preAnchorRecord);
  const ineligibleLegacy = structuredClone(preAnchorRecord);
  delete ineligibleLegacy.settlement.transaction;
  const ineligibleLedger = new MemoryLedger();
  ineligibleLedger.records.set(ineligibleLegacy.receiptId, ineligibleLegacy);
  const ineligibleStatus = await callHandler(createCoverageStatusHandler({
    ledger: ineligibleLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: ineligibleLegacy.receiptId },
  });
  assert.equal(ineligibleStatus.statusCode, 409);
  assert.equal(
    ineligibleStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );
  assert.equal(
    (await ineligibleLedger.get(ineligibleLegacy.receiptId)).receiptIntegrityAnchor,
    undefined,
  );

  const missingGrant = structuredClone(preAnchorRecord);
  delete missingGrant.relayGrantPayload.grantId;
  delete missingGrant.receipt.providerRelay.grantId;
  missingGrant.receipt.receiptHash = computeReceiptHash(missingGrant.receipt);
  approveReceiptMigration(missingGrant);
  const missingGrantLedger = new MemoryLedger();
  missingGrantLedger.records.set(missingGrant.receiptId, missingGrant);
  const missingGrantStatus = await callHandler(createCoverageStatusHandler({
    ledger: missingGrantLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: missingGrant.receiptId },
  });
  assert.equal(missingGrantStatus.statusCode, 409);
  assert.equal(
    missingGrantStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  const caseChangedGrant = structuredClone(preAnchorRecord);
  caseChangedGrant.receipt.providerRelay.grantId = caseChangedGrant.receipt
    .providerRelay.grantId.toUpperCase();
  caseChangedGrant.receipt.receiptHash = computeReceiptHash(caseChangedGrant.receipt);
  approveReceiptMigration(caseChangedGrant);
  const caseChangedGrantLedger = new MemoryLedger();
  caseChangedGrantLedger.records.set(caseChangedGrant.receiptId, caseChangedGrant);
  const caseChangedGrantStatus = await callHandler(createCoverageStatusHandler({
    ledger: caseChangedGrantLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: caseChangedGrant.receiptId },
  });
  assert.equal(caseChangedGrantStatus.statusCode, 409);
  assert.equal(
    caseChangedGrantStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  const changedClockMode = structuredClone(preAnchorRecord);
  changedClockMode.receipt.target.clockMode = "verified_acceptance";
  changedClockMode.receipt.receiptHash = computeReceiptHash(changedClockMode.receipt);
  approveReceiptMigration(changedClockMode);
  const changedClockModeLedger = new MemoryLedger();
  changedClockModeLedger.records.set(changedClockMode.receiptId, changedClockMode);
  const changedClockModeStatus = await callHandler(createCoverageStatusHandler({
    ledger: changedClockModeLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: changedClockMode.receiptId },
  });
  assert.equal(changedClockModeStatus.statusCode, 409);
  assert.equal(
    changedClockModeStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  process.env.POLICYPOOL_PUBLIC_ORIGIN = "https://self-hosted-policy.example";
  process.env.POLICYPOOL_PUBLIC_PATH_PREFIX = "/policypool";
  const configuredLegacy = structuredClone(preAnchorRecord);
  configuredLegacy.receipt.providerRelay.endpoint =
    "https://self-hosted-policy.example/policypool/api/provider-relay";
  configuredLegacy.receipt.receiptHash = computeReceiptHash(configuredLegacy.receipt);
  approveReceiptMigration(configuredLegacy);
  const configuredLegacyLedger = new MemoryLedger();
  configuredLegacyLedger.records.set(configuredLegacy.receiptId, configuredLegacy);
  const configuredLegacyStatus = await callHandler(createCoverageStatusHandler({
    ledger: configuredLegacyLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: configuredLegacy.receiptId },
  });
  assert.equal(
    configuredLegacyStatus.statusCode,
    200,
    JSON.stringify(configuredLegacyStatus.json()),
  );
  assert.equal(
    (await configuredLegacyLedger.get(configuredLegacy.receiptId))
      .receiptIntegrityAnchor.providerRelayEndpoint,
    configuredLegacy.receipt.providerRelay.endpoint,
  );

  const wrongConfiguredRoute = structuredClone(configuredLegacy);
  delete wrongConfiguredRoute.receiptIntegrityAnchor;
  wrongConfiguredRoute.receipt.providerRelay.endpoint =
    "https://self-hosted-policy.example/wrong/api/provider-relay";
  wrongConfiguredRoute.receipt.receiptHash = computeReceiptHash(wrongConfiguredRoute.receipt);
  const wrongConfiguredLedger = new MemoryLedger();
  wrongConfiguredLedger.records.set(wrongConfiguredRoute.receiptId, wrongConfiguredRoute);
  const wrongConfiguredStatus = await callHandler(createCoverageStatusHandler({
    ledger: wrongConfiguredLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: wrongConfiguredRoute.receiptId },
  });
  assert.equal(wrongConfiguredStatus.statusCode, 409);
  assert.equal(
    wrongConfiguredStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  const substitutedHistoricalRoute = structuredClone(configuredLegacy);
  substitutedHistoricalRoute.receipt.providerRelay.endpoint =
    "https://policypool.vercel.app/api/provider-relay";
  substitutedHistoricalRoute.receipt.receiptHash = computeReceiptHash(
    substitutedHistoricalRoute.receipt,
  );
  const substitutedHistoricalLedger = new MemoryLedger();
  substitutedHistoricalLedger.records.set(
    substitutedHistoricalRoute.receiptId,
    substitutedHistoricalRoute,
  );
  const substitutedHistoricalStatus = await callHandler(createCoverageStatusHandler({
    ledger: substitutedHistoricalLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: substitutedHistoricalRoute.receiptId },
  });
  assert.equal(substitutedHistoricalStatus.statusCode, 409);
  assert.equal(
    substitutedHistoricalStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  const changedCoverageCap = structuredClone(preAnchorRecord);
  changedCoverageCap.receipt.covenant.coverageCapAtomic = "600000";
  changedCoverageCap.receipt.covenant.coverageCapUSDT = "0.6";
  changedCoverageCap.receipt.providerBond.lockedAtomic = "600000";
  changedCoverageCap.receipt.receiptHash = computeReceiptHash(changedCoverageCap.receipt);
  approveReceiptMigration(changedCoverageCap);
  const changedCoverageCapLedger = new MemoryLedger();
  changedCoverageCapLedger.records.set(changedCoverageCap.receiptId, changedCoverageCap);
  const changedCoverageCapStatus = await callHandler(createCoverageStatusHandler({
    ledger: changedCoverageCapLedger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: changedCoverageCap.receiptId },
  });
  assert.equal(changedCoverageCapStatus.statusCode, 409);
  assert.equal(
    changedCoverageCapStatus.json().error,
    "receipt_integrity_anchor_backfill_ineligible",
  );

  process.env.POLICYPOOL_PUBLIC_ORIGIN = "https://policypool.dolepee.com";
  delete process.env.POLICYPOOL_PUBLIC_PATH_PREFIX;
  approveReceiptMigration(preAnchorRecord);

  const migratedStatus = await callHandler(createCoverageStatusHandler({
    ledger: legacy.ledger,
    chain: { async getJobStatus() { return 1; } },
    now: () => now,
  }), {
    method: "GET",
    query: { receiptId: preAnchorRecord.receiptId },
  });
  assert.equal(migratedStatus.statusCode, 200);
  assert.equal(
    migratedStatus.json().receipt.providerRelay.endpoint,
    "https://policypool.vercel.app/api/provider-relay",
  );
  const migratedReplay = await callHandler(legacy.handler, legacyRequest);
  assert.equal(migratedReplay.statusCode, 200);
  assert.equal(migratedReplay.json().idempotentReplay, true);
  assert.equal(
    migratedReplay.json().receipt.providerRelay.endpoint,
    "https://policypool.vercel.app/api/provider-relay",
  );
  const migratedStored = await legacy.ledger.get(preAnchorRecord.receiptId);
  assert.equal(
    migratedStored.receiptIntegrityAnchor.receiptHash,
    preAnchorRecord.receipt.receiptHash,
  );
  assert.equal(
    migratedStored.receiptIntegrityAnchor.providerRelayEndpoint,
    "https://policypool.vercel.app/api/provider-relay",
  );
  const staleTransition = await legacy.ledger.transitionUniversal(
    { ...preAnchorRecord, state: "active" },
    ["pending_start"],
  );
  assert.deepEqual(
    staleTransition.receiptIntegrityAnchor,
    migratedStored.receiptIntegrityAnchor,
    "a stale transition must retain the sidecar anchor",
  );
  assert.deepEqual(
    (await legacy.ledger.get(preAnchorRecord.receiptId)).receiptIntegrityAnchor,
    migratedStored.receiptIntegrityAnchor,
  );
  const conflictingTransition = await legacy.ledger.transitionUniversal(
    {
      ...staleTransition,
      state: "released",
      receiptIntegrityAnchor: {
        ...migratedStored.receiptIntegrityAnchor,
        providerRelayEndpoint: "https://wrong.example/api/provider-relay",
      },
    },
    ["active"],
  );
  assert.deepEqual(
    conflictingTransition.receiptIntegrityAnchor,
    migratedStored.receiptIntegrityAnchor,
    "an existing sidecar anchor must be immutable",
  );
  assert.equal(legacy.calls.settle, 1, "anchor backfill must not settle twice");
} finally {
  if (savedPublicOrigin === undefined) delete process.env.POLICYPOOL_PUBLIC_ORIGIN;
  else process.env.POLICYPOOL_PUBLIC_ORIGIN = savedPublicOrigin;
  if (savedPublicPathPrefix === undefined) delete process.env.POLICYPOOL_PUBLIC_PATH_PREFIX;
  else process.env.POLICYPOOL_PUBLIC_PATH_PREFIX = savedPublicPathPrefix;
  if (savedReceiptIntegrityMigrations === undefined) {
    delete process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS;
  } else {
    process.env.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS = savedReceiptIntegrityMigrations;
  }
}

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
  async get() { return null; },
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

const redisAnchorRecord = {
  receiptId: "redis-anchor",
  state: "pending_start",
  universalCovenant: { covenantId: `0x${"cd".repeat(32)}` },
  receipt: {
    receiptHash: `sha256:${"ab".repeat(32)}`,
    target: { exclusions: [] },
  },
};
let redisAnchorStored = JSON.stringify(redisAnchorRecord);
const redisAnchorStoredBefore = redisAnchorStored;
let redisAnchorSidecar = null;
const redisAnchor = {
  receiptHash: redisAnchorRecord.receipt.receiptHash,
  providerRelayEndpoint: "https://policypool.vercel.app/api/provider-relay",
};
const redisAnchorLedger = new RedisLedger({
  prefix: "test",
  redis: {
    async get(key) {
      return key === "test:receipt-anchor:redis-anchor" ? redisAnchorSidecar : null;
    },
    async eval(script, keys, argv) {
      if (script.includes("local allowed = false")) {
        assert.equal(keys[0], "test:receipt:redis-anchor");
        const current = JSON.parse(redisAnchorStored);
        if (!argv.slice(1).includes(current.state)) {
          return ["state_mismatch", redisAnchorStored];
        }
        redisAnchorStored = argv[0];
        return ["updated", redisAnchorStored];
      }
      assert.match(script, /local existing = redis\.call\('GET', KEYS\[2\]\)/);
      assert.match(script, /redis\.call\('SET', KEYS\[2\], ARGV\[2\], 'NX'\)/);
      assert.match(script, /decoded\.receipt\.receiptHash ~= ARGV\[1\]/);
      assert.equal(keys[0], "test:receipt:redis-anchor");
      assert.equal(keys[1], "test:receipt-anchor:redis-anchor");
      assert.equal(argv[0], redisAnchor.receiptHash);
      const current = JSON.parse(redisAnchorStored);
      if (redisAnchorSidecar) return ["existing", redisAnchorStored, redisAnchorSidecar];
      if (current.receipt?.receiptHash !== argv[0]) {
        return ["receipt_mismatch", redisAnchorStored];
      }
      redisAnchorSidecar = argv[1];
      return ["backfilled", redisAnchorStored, redisAnchorSidecar];
    },
  },
});
const redisAnchored = await redisAnchorLedger.backfillReceiptIntegrityAnchor(
  redisAnchorRecord.receiptId,
  redisAnchorRecord.receipt.receiptHash,
  redisAnchor,
);
assert.deepEqual(redisAnchored.receiptIntegrityAnchor, redisAnchor);
assert.equal(redisAnchorStored, redisAnchorStoredBefore);
assert.deepEqual(JSON.parse(redisAnchorStored).receipt.target.exclusions, []);
const redisAnchorReplay = await redisAnchorLedger.backfillReceiptIntegrityAnchor(
  redisAnchorRecord.receiptId,
  redisAnchorRecord.receipt.receiptHash,
  { ...redisAnchor, providerRelayEndpoint: "https://wrong.example/api/provider-relay" },
);
assert.deepEqual(redisAnchorReplay.receiptIntegrityAnchor, redisAnchor);
const redisStaleTransition = await redisAnchorLedger.transitionUniversal(
  { ...redisAnchorRecord, state: "active" },
  ["pending_start"],
);
assert.deepEqual(redisStaleTransition.receiptIntegrityAnchor, redisAnchor);
assert.deepEqual(JSON.parse(redisAnchorStored).receipt.target.exclusions, []);

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
