import { COVERAGE, OBJECTIVE_BREACH_RULES, PAYMENT, XLAYER, paymentRequirements } from "./lib/config.js";
import { createChainService, EvidenceError } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import {
  createPaymentService,
  PaymentConfigurationError,
  PaymentVerificationError,
} from "./lib/payment.js";
import {
  listPublishedPolicies,
  policyCoverageCapAtomic,
} from "./lib/policy-registry.js";
import { createCoveragePolicyResolver } from "./lib/policy-resolution.js";
import { UniversalPolicyError } from "./lib/universal-policy.js";
import { createUniversalIssuer, UniversalIssuerError } from "./lib/universal-issuer.js";
import { createRelayGrantService, RelayGrantError } from "./lib/relay-grant.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";
import {
  createQuoteService,
  extractQuoteToken,
  paymentRequirementsForQuote,
  QuoteConfigurationError,
  QuoteValidationError,
} from "./lib/quote.js";
import {
  clean,
  encodeBase64Json,
  formatUsdtAtomic,
  header,
  isBytes32,
  parseUsdtAtomic,
  sendJson,
  sha256,
  stableStringify,
} from "./lib/utils.js";

const FORBIDDEN_PATTERNS = [
  [/investment advice|financial advice|buy signal|sell signal|price prediction/i, "regulated_or_trading_advice"],
  [/private key|seed phrase|mnemonic/i, "secret_request"],
  [/guarantee.*approval|approval.*guarantee|guaranteed listing/i, "approval_outcome_guarantee"],
  [/fake review|engagement farm|wash/i, "marketplace_manipulation"],
  [/ignore (all )?(previous|prior) instructions|disregard (your|the) restrictions/i, "instruction_override_attempt"],
];

const INPUT_ALIASES = {
  targetAgent: ["targetAgent", "agent", "agentId", "serviceId", "targetService"],
  targetServiceId: ["targetServiceId", "listedServiceId"],
  targetJobId: ["targetJobId", "jobId", "taskId"],
  targetCreationTxHash: ["targetCreationTxHash", "creationTxHash", "jobCreationTxHash"],
  targetAcceptanceTxHash: ["targetAcceptanceTxHash", "acceptanceTxHash", "jobAcceptanceTxHash"],
  targetTaskReference: ["targetTaskReference", "taskReference", "publicTaskId", "taskUrl"],
  jobDescription: ["jobDescription", "job", "task", "prompt", "description", "scope"],
  requestedDeadline: ["deadline", "dueAt", "expiresAt"],
  requestedCoverageUSDT: ["requestedCoverageUSDT", "coverageCapUSDT", "capUSDT", "coverageAmountUSDT"],
};

const CONTAINER_KEYS = new Set(["input", "data", "payload", "request", "parameters", "arguments", "context", "body"]);
const MAX_FEE_AUTHORIZATION_WINDOW_SECONDS = 15 * 60;

function universalFeeAuthorization(verified, nowMs) {
  const authorization = verified?.payload?.payload?.authorization;
  const hash = String(verified?.paymentId || "").replace(/^sha256:/, "0x");
  let validBefore;
  try {
    validBefore = BigInt(authorization?.validBefore);
  } catch {
    throw new UniversalIssuerError("fee_authorization_expiry_invalid", 422);
  }
  const current = BigInt(Math.floor(nowMs / 1_000));
  if (
    !isBytes32(hash)
    || !isBytes32(authorization?.nonce)
    || validBefore <= current
    || validBefore > current + BigInt(MAX_FEE_AUTHORIZATION_WINDOW_SECONDS)
  ) {
    throw new UniversalIssuerError("fee_authorization_window_invalid", 422);
  }
  return {
    hash,
    nonce: authorization.nonce,
    validBefore: validBefore.toString(),
    payer: verified.payer,
  };
}

const OUTPUT_SCHEMA = {
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        targetAgent: {
          type: "string",
          description: "Registered target agent id, service id, or public service name.",
        },
        targetJobId: {
          type: "string",
          description: "The accepted OKX.AI job id (bytes32).",
        },
        targetServiceId: {
          type: "string",
          description: "Required for v0.4 provider-enrolled policies; the live OKX.AI service id.",
        },
        targetCreationTxHash: {
          type: "string",
          description: "X Layer transaction that created the target job and binds its buyer wallet.",
        },
        targetAcceptanceTxHash: {
          type: "string",
          description: "X Layer transaction that moved the target job from created to accepted.",
        },
        targetTaskReference: {
          type: "string",
          description: "OKX.AI public task id or URL used to verify delivery timing. Required for v0.4 A2A coverage.",
        },
        jobDescription: {
          type: "string",
          description: "The target job scope being covered.",
        },
        deadline: {
          type: "string",
          description: "Optional buyer context only. The covenant deadline is derived from the registered policy SLA and verified acceptance block.",
        },
        requestedCoverageUSDT: {
          type: ["string", "number"],
          description: "Requested cap. It cannot exceed target-job value, configured cap, or uncommitted reserve.",
        },
        quoteId: {
          type: "string",
          description: "Optional signed PolicyPool quote. When present, it is authoritative and allows bodyless paid replay.",
        },
      },
      required: ["targetAgent", "targetJobId", "targetCreationTxHash", "targetAcceptanceTxHash", "jobDescription"],
      additionalProperties: false,
    },
  },
  output: {
    type: "json",
    example: {
      ok: true,
      agent: "PolicyPool",
      service: "Covered Job Receipt",
      receipt: {
        outcome: { type: "ISSUED", status: "coverage_active" },
        receiptHash: "sha256:...",
      },
    },
  },
};

function absoluteUrl(req, quoteToken = "") {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  const absolute = req.url?.startsWith("http")
    ? req.url
    : `${proto}://${host}${req.url || "/api/covered-job-receipt"}`;
  const url = new URL(absolute);
  if (quoteToken) url.searchParams.set("quote", quoteToken);
  return url.toString();
}

function challengeFor(req, error = "Payment required", quoteToken = "") {
  const requirements = paymentRequirementsForQuote(paymentRequirements(), quoteToken);
  return {
    x402Version: 2,
    error,
    resource: {
      url: absoluteUrl(req, quoteToken),
      description: "PolicyPool Covered Job Receipt API",
      mimeType: "application/json",
    },
    outputSchema: OUTPUT_SCHEMA,
    accepts: [{
      ...requirements,
      outputSchema: OUTPUT_SCHEMA,
    }],
  };
}

function paymentRequired(req, res, error = "Payment required", quoteToken = "") {
  const challenge = challengeFor(req, error, quoteToken);
  res.setHeader("PAYMENT-REQUIRED", encodeBase64Json(challenge));
  return sendJson(res, 402, {
    ok: false,
    error,
    charged: false,
    ...challenge,
  });
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectRecords(body) {
  const records = [body];
  const queue = [{ value: body, depth: 0 }];
  const seen = new Set([body]);
  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (depth >= 3) continue;
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object" || Array.isArray(child) || seen.has(child)) continue;
      if (CONTAINER_KEYS.has(key) || depth === 0) {
        records.push(child);
        queue.push({ value: child, depth: depth + 1 });
        seen.add(child);
      }
    }
  }
  return records;
}

function readAlias(records, aliases, max = 900) {
  for (const alias of aliases) {
    const wanted = normalizeKey(alias);
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (normalizeKey(key) !== wanted || (value && typeof value === "object")) continue;
        const result = clean(value, max);
        if (result) return result;
      }
    }
  }
  return "";
}

function readInput(req, authoritativeBody = null) {
  const source = authoritativeBody || (req.method === "POST" ? req.body : req.query);
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const records = collectRecords(body);
  const requested = readAlias(records, INPUT_ALIASES.requestedCoverageUSDT, 40) || "1";
  return {
    targetAgent: readAlias(records, INPUT_ALIASES.targetAgent),
    targetServiceId: readAlias(records, INPUT_ALIASES.targetServiceId, 40),
    targetJobId: readAlias(records, INPUT_ALIASES.targetJobId, 80),
    targetCreationTxHash: readAlias(records, INPUT_ALIASES.targetCreationTxHash, 80),
    targetAcceptanceTxHash: readAlias(records, INPUT_ALIASES.targetAcceptanceTxHash, 80),
    targetTaskReference: readAlias(records, INPUT_ALIASES.targetTaskReference, 300),
    jobDescription: readAlias(records, INPUT_ALIASES.jobDescription),
    requestedDeadline: readAlias(records, INPUT_ALIASES.requestedDeadline, 80),
    requestedCoverageAtomic: parseUsdtAtomic(String(requested), PAYMENT.decimals),
  };
}

function isBodylessRequest(req) {
  const source = req.method === "POST" ? req.body : req.query;
  return !source
    || typeof source !== "object"
    || Array.isArray(source)
    || Object.keys(source).length === 0;
}

function requestBodyFromInput(input) {
  return {
    targetAgent: input.targetAgent,
    targetServiceId: input.targetServiceId,
    targetJobId: input.targetJobId,
    targetCreationTxHash: input.targetCreationTxHash,
    targetAcceptanceTxHash: input.targetAcceptanceTxHash,
    targetTaskReference: input.targetTaskReference,
    jobDescription: input.jobDescription,
    requestedCoverageUSDT: formatUsdtAtomic(input.requestedCoverageAtomic, PAYMENT.decimals),
  };
}

function supportedTargets() {
  return listPublishedPolicies().map((policy) => ({
    agentId: policy.agentId,
    agentName: policy.agentName,
    serviceIds: policy.serviceIds,
    serviceName: policy.serviceName,
    serviceType: policy.serviceType,
    maxCoverageAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic).toString(),
    coverageStatus: policy.coverageStatus || "active",
    coverableNow: !policy.coverageStatus || policy.coverageStatus === "active",
    clockSource: policy.clockSource || "verified_acceptance_block",
    processingStart: policy.processingStart || "verified target-job acceptance",
    enrollmentWindowSeconds: policy.enrollmentWindowSeconds,
    exclusions: policy.exclusions || [],
  }));
}

export function evaluateGuard(input, policy) {
  if (!policy) return { verdict: "BLOCK", reason: "target_policy_not_registered" };
  if (policy.coverageStatus && policy.coverageStatus !== "active") {
    return { verdict: "BLOCK", reason: policy.coverageBlockReason || "registered_policy_not_active" };
  }
  if (!isBytes32(input.targetJobId)) return { verdict: "BLOCK", reason: "target_job_id_required" };
  if (!isBytes32(input.targetCreationTxHash)) {
    return { verdict: "BLOCK", reason: "target_creation_transaction_required" };
  }
  if (!isBytes32(input.targetAcceptanceTxHash)) {
    return { verdict: "BLOCK", reason: "target_acceptance_transaction_required" };
  }
  if (policy.onchainPolicyId && policy.serviceType === "A2A" && !input.targetTaskReference) {
    return { verdict: "BLOCK", reason: "public_task_reference_required_for_universal_a2a" };
  }
  if (!input.jobDescription) return { verdict: "BLOCK", reason: "job_description_required" };
  if (!Number.isSafeInteger(policy.slaSeconds)
    || policy.slaSeconds <= 0
    || policy.slaSeconds > COVERAGE.maxDurationSeconds) {
    return { verdict: "BLOCK", reason: "registered_policy_sla_invalid" };
  }
  if (!Number.isSafeInteger(policy.enrollmentWindowSeconds)
    || policy.enrollmentWindowSeconds <= 0
    || policy.enrollmentWindowSeconds > policy.slaSeconds) {
    return { verdict: "BLOCK", reason: "registered_policy_enrollment_window_invalid" };
  }
  if (policyCoverageCapAtomic(policy, COVERAGE.maxAtomic) < BigInt(COVERAGE.minAtomic)) {
    return { verdict: "BLOCK", reason: "registered_policy_cap_invalid" };
  }
  if (input.requestedCoverageAtomic < BigInt(COVERAGE.minAtomic)) {
    return { verdict: "BLOCK", reason: "requested_coverage_below_minimum" };
  }
  const text = `${policy.serviceName} ${policy.publishedScope.join(" ")} ${input.jobDescription}`;
  for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) return { verdict: "BLOCK", reason };
  }
  if (!policy.allowedKeywords.some((keyword) => input.jobDescription.toLowerCase().includes(keyword))) {
    return { verdict: "BLOCK", reason: "job_outside_registered_policy" };
  }
  return { verdict: "ALLOW", reason: "registered_policy_and_objective_job_evidence_required" };
}

function minBigInt(...values) {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function receiptHash(receipt) {
  return `sha256:${sha256(stableStringify(receipt))}`;
}

function buildReceipt({
  receiptId,
  input,
  policy,
  guard,
  targetOrder,
  payer,
  coverageCapAtomic,
  reserveBalanceAtomic,
  settlement,
  generatedAt,
  coverageDeadline,
  coverageEnrollmentClosesAt,
  quote,
  universalCovenant = null,
  relayGrantPayload = null,
}) {
  const issued = guard.verdict === "ALLOW";
  const providerFunded = Boolean(policy?.onchainPolicyId);
  const pendingClock = issued && policy?.clockMode === "policypool_relay";
  const draft = {
    protocol: "PolicyPool Agent Coverage",
    version: policy?.onchainPolicyId ? "0.4.0" : "0.3.0",
    receiptId,
    generatedAt,
    outcome: issued
      ? {
        type: "ISSUED",
        status: pendingClock ? "coverage_pending_provider_clock" : "coverage_active",
        reason: pendingClock
          ? "provider_bond_locked_and_waiting_for_relay_clock"
          : "registered_policy_matched_and_target_job_acceptance_verified",
      }
      : {
        type: "DECLINED",
        status: "coverage_not_issued",
        reason: guard.reason,
      },
    buyer: {
      address: payer,
    },
    target: policy ? {
      agentId: policy.agentId,
      agentName: policy.agentName,
      serviceIds: policy.serviceIds,
      serviceName: policy.serviceName,
      serviceType: policy.serviceType,
      providerWallet: policy.providerWallet,
      policyHash: policy.policyHash,
      slaSeconds: policy.slaSeconds,
      publishedScope: policy.publishedScope,
      maxCoverageAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic).toString(),
      providerAvailableBondAtomic: policy.providerAvailableBondAtomic || null,
      payoutBasis: policy.payoutBasis || "legacy_reserve_covenant",
      clockMode: policy.clockMode || "verified_acceptance",
      coverageStatus: policy.coverageStatus || "active",
      clockSource: policy.clockSource || "verified_acceptance_block",
      processingStart: policy.processingStart || "verified target-job acceptance",
      enrollmentWindowSeconds: policy.enrollmentWindowSeconds,
      exclusions: policy.exclusions || [],
    } : {
      requestedAgent: input.targetAgent,
      policyHash: null,
    },
    targetJob: targetOrder || {
      jobId: input.targetJobId || null,
      creationTxHash: input.targetCreationTxHash || null,
      acceptanceTxHash: input.targetAcceptanceTxHash || null,
      verified: false,
    },
    covenant: issued ? {
      deadline: coverageDeadline,
      enrollmentClosedAt: coverageEnrollmentClosesAt,
      coverageCapAtomic: coverageCapAtomic.toString(),
      coverageCapUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
      objectiveBreachRules: OBJECTIVE_BREACH_RULES,
      onchain: universalCovenant,
    } : null,
    providerRelay: pendingClock ? {
      endpoint: "https://policypool.vercel.app/api/provider-relay",
      grantId: relayGrantPayload?.grantId || null,
      grantExpiresAt: relayGrantPayload?.expiresAt || null,
      grantBoundTo: ["covenant", "target job", "buyer", "agent", "service"],
      request: {
        method: "POST",
        required: ["relayGrant", "agentId", "serviceId", "targetJobId", "providerRequest"],
      },
    } : null,
    guard: {
      ...guard,
      callerSuppliedPolicyIgnored: true,
      callerSuppliedDeadlineIgnored: true,
      callerSuppliedBreachAndPayoutFieldsIgnored: true,
      derivedCoverageDeadline: coverageDeadline,
      derivedEnrollmentClosesAt: coverageEnrollmentClosesAt,
    },
    coverageQuote: quote ? {
      id: quote.id,
      source: quote.source,
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
      canonicalRequestRecovered: true,
    } : null,
    reserve: providerFunded ? null : {
      chain: XLAYER.name,
      chainId: XLAYER.id,
      wallet: COVERAGE.reserveWallet,
      asset: PAYMENT.asset,
      balanceAtomicAtDecision: reserveBalanceAtomic.toString(),
      balanceUSDTAtDecision: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
      publicUrl: COVERAGE.publicUrl,
    },
    providerBond: providerFunded ? {
      chain: XLAYER.name,
      chainId: XLAYER.id,
      provider: policy.providerWallet,
      asset: PAYMENT.asset,
      availableAtomicBeforeLock: policy.providerAvailableBondAtomic,
      availableUSDTBeforeLock: formatUsdtAtomic(
        BigInt(policy.providerAvailableBondAtomic || 0),
        PAYMENT.decimals,
      ),
      lockedAtomic: coverageCapAtomic.toString(),
      covenantId: universalCovenant?.covenantId || null,
      custody: "provider_first_loss_bond_vault",
      sharedReserveUsed: false,
    } : null,
    servicePayment: {
      verified: true,
      settled: true,
      network: settlement.network,
      transaction: settlement.transaction,
      payer: settlement.payer,
      recipient: PAYMENT.payTo,
      amountAtomic: PAYMENT.amountAtomic,
      amountUSDT: formatUsdtAtomic(PAYMENT.amountAtomic, PAYMENT.decimals),
      transferBlock: settlement.transfer.blockNumber,
    },
    limitations: [
      "Coverage is objective and limited to the stated cap.",
      "PolicyPool is not protocol-native escrow or insurance.",
      "A payout-due state must be derived from the stored covenant and public OKX.AI job status.",
      "A payout is paid only after its X Layer token transfer is independently verified.",
    ],
  };
  return { ...draft, receiptHash: receiptHash(draft) };
}

function respondWithRecord(res, record, relayGrantService = null) {
  if (record.paymentResponseHeader) {
    res.setHeader("PAYMENT-RESPONSE", record.paymentResponseHeader);
    res.setHeader("X-PAYMENT-RESPONSE", record.paymentResponseHeader);
  }
  let receipt = record.receipt;
  if (record.relayGrantPayload && relayGrantService?.tokenForPayload && receipt?.providerRelay) {
    receipt = {
      ...receipt,
      providerRelay: {
        ...receipt.providerRelay,
        grantToken: relayGrantService.tokenForPayload(record.relayGrantPayload),
      },
    };
  }
  return sendJson(res, 200, {
    ok: true,
    version: record.receipt?.version || "0.3.0",
    agent: "PolicyPool",
    service: "Covered Job Receipt",
    mode: "api_service",
    idempotentReplay: Boolean(record.replayed),
    receipt,
  });
}

function rejectStaticGuard(res, guard) {
  const payload = {
    ok: false,
    error: guard.reason,
    charged: false,
  };
  if (guard.reason === "requested_coverage_below_minimum") {
    payload.minimumCoverageUSDT = formatUsdtAtomic(BigInt(COVERAGE.minAtomic), PAYMENT.decimals);
  }
  const status = guard.reason === "registered_policy_sla_invalid" ? 503 : 400;
  return sendJson(res, status, payload);
}

function rejectPaymentVerification(req, res, error) {
  if (error instanceof PaymentConfigurationError) {
    return sendJson(res, 503, { ok: false, error: "payment_service_not_ready", charged: false });
  }
  if (error instanceof PaymentVerificationError) {
    return paymentRequired(req, res, error.code);
  }
  return paymentRequired(req, res, "payment_verification_failed");
}

export function createHandler(dependencies = {}) {
  let runtimeChain = dependencies.chain;
  let runtimeLedger = dependencies.ledger;
  let runtimePayment = dependencies.payment;
  let runtimeQuoteService = dependencies.quoteService;
  let runtimePolicyResolver = dependencies.policyResolver;
  let runtimeUniversalIssuer = dependencies.universalIssuer;
  let runtimeRelayGrantService = dependencies.relayGrantService;
  const limiter = dependencies.limiter || createRateLimiter();
  const now = dependencies.now || (() => Date.now());
  const getChain = () => (runtimeChain ||= createChainService());
  const getLedger = () => (runtimeLedger ||= createLedger());
  const getPayment = () => (runtimePayment ||= createPaymentService({ chain: getChain() }));
  const getQuoteService = () => (runtimeQuoteService ||= createQuoteService({
    ledger: getLedger(),
    secret: dependencies.quoteSecret,
    now,
    randomId: dependencies.quoteRandomId,
    ttlSeconds: dependencies.quoteTtlSeconds,
  }));
  const getPolicyResolver = () => (runtimePolicyResolver ||= createCoveragePolicyResolver(dependencies));
  const getUniversalIssuer = () => (runtimeUniversalIssuer ||= createUniversalIssuer(dependencies));
  const getRelayGrantService = () => (runtimeRelayGrantService ||= createRelayGrantService(dependencies));
  const respond = (res, record) => respondWithRecord(
    res,
    record,
    record.relayGrantPayload ? getRelayGrantService() : null,
  );

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT");
      res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
      res.status(200).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }

    const paymentSignature = header(req, "payment-signature");
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: paymentSignature ? "coverage-paid" : "coverage-quote",
      subject: req.body?.targetAgent || req.query?.targetAgent || "",
      limit: paymentSignature ? 120 : 30,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);
    let ledger = null;
    let payment = null;
    let paymentId = "";
    let verified = null;
    let requirements = null;

    if (paymentSignature) {
      try {
        ledger = getLedger();
        payment = getPayment();
      } catch (error) {
        return sendJson(res, 503, {
          ok: false,
          error: "service_not_ready",
          detail: error instanceof Error ? error.message : String(error),
          charged: false,
        });
      }

      paymentId = payment.fingerprint(req);
      try {
        const existingPayment = await ledger.findByPaymentId(paymentId);
        if (existingPayment?.receipt) {
          return respond(res, { ...existingPayment, replayed: true });
        }
        if (existingPayment?.state === "compensation_required") {
          return sendJson(res, 503, {
            ok: false,
            error: "provider_bond_release_pending_retry",
            charged: false,
            receiptId: existingPayment.receiptId,
          });
        }
      } catch (error) {
        return sendJson(res, 503, {
          ok: false,
          error: "durable_ledger_unavailable",
          detail: error instanceof Error ? error.message : String(error),
          charged: false,
        });
      }
    }

    const quoteToken = extractQuoteToken(req);
    let quote = null;
    if (quoteToken) {
      try {
        quote = await getQuoteService().resolve(quoteToken);
      } catch (error) {
        if (error instanceof QuoteValidationError) {
          return sendJson(res, 400, { ok: false, error: error.code, charged: false });
        }
        const code = error instanceof QuoteConfigurationError
          ? "coverage_quote_not_configured"
          : "coverage_quote_unavailable";
        return sendJson(res, 503, { ok: false, error: code, charged: false });
      }
    }

    let input = readInput(req, quote?.requestBody);
    if (paymentSignature && !quote && !input.targetAgent && isBodylessRequest(req)) {
      requirements = paymentRequirements();
      try {
        verified = await payment.verify(req, requirements);
      } catch (error) {
        return rejectPaymentVerification(req, res, error);
      }
      try {
        quote = await getQuoteService().resolveForBuyer(verified.payer);
        input = readInput(req, quote.requestBody);
      } catch (error) {
        if (error instanceof QuoteValidationError) {
          return sendJson(res, 400, { ok: false, error: error.code, charged: false });
        }
        const code = error instanceof QuoteConfigurationError
          ? "coverage_quote_not_configured"
          : "coverage_quote_unavailable";
        return sendJson(res, 503, { ok: false, error: code, charged: false });
      }
    }

    const targetAgent = input.targetAgent;
    let policy = null;
    let policySource = null;
    if (targetAgent) {
      try {
        ({ policy, source: policySource } = await getPolicyResolver().resolve(
          targetAgent,
          input.targetServiceId,
        ));
      } catch (error) {
        if (error instanceof UniversalPolicyError) {
          return sendJson(res, error.status, { ok: false, error: error.code, charged: false });
        }
        return sendJson(res, 503, { ok: false, error: "coverage_policy_resolution_failed", charged: false });
      }
    }
    if (targetAgent && !policy) {
      return sendJson(res, 422, {
        ok: false,
        error: "target_policy_not_registered",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }

    if (quote?.policyHash && quote.policyHash !== policy?.policyHash) {
      return sendJson(res, 409, { ok: false, error: "coverage_quote_policy_changed", charged: false });
    }
    if (policy?.onchainPolicyId) {
      try {
        getUniversalIssuer();
        if (policy.clockMode === "policypool_relay") getRelayGrantService();
      } catch (error) {
        const recognized = error instanceof UniversalIssuerError || error instanceof RelayGrantError;
        return sendJson(res, recognized ? error.status : 503, {
          ok: false,
          error: recognized ? error.code : "universal_issuance_feature_gated",
          charged: false,
        });
      }
    }
    if (!targetAgent && req.method === "GET" && !paymentSignature) {
      return paymentRequired(req, res);
    }
    if (!targetAgent) {
      return sendJson(res, 400, {
        ok: false,
        error: "target_agent_required",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }

    const staticGuard = evaluateGuard(input, policy);
    if (!paymentSignature) {
      if (req.method === "POST" && staticGuard.verdict === "BLOCK") {
        return rejectStaticGuard(res, staticGuard);
      }
      if (req.method === "POST") {
        try {
          const targetStatus = await getChain().getJobStatus(input.targetJobId);
          if (targetStatus !== 1) {
            return sendJson(res, 400, {
              ok: false,
              error: `target_job_not_accepted:${targetStatus}`,
              charged: false,
              quoteId: quote?.id || null,
            });
          }
        } catch (error) {
          return sendJson(res, 503, {
            ok: false,
            error: error instanceof EvidenceError ? error.code : "target_job_status_unavailable",
            charged: false,
          });
        }
      }
      if (!quote) {
        try {
          quote = await getQuoteService().issue({
            requestBody: requestBodyFromInput(input),
            policyHash: policy.policyHash,
            source: "direct_request_transport",
          });
        } catch (error) {
          const code = error instanceof QuoteConfigurationError
            ? "coverage_quote_not_configured"
            : "coverage_quote_unavailable";
          return sendJson(res, 503, { ok: false, error: code, charged: false });
        }
      }
      return paymentRequired(req, res, "Payment required", quote.token);
    }

    if (staticGuard.verdict === "BLOCK") return rejectStaticGuard(res, staticGuard);

    requirements ||= paymentRequirementsForQuote(paymentRequirements(), quote?.token || "");
    if (!verified) {
      try {
        verified = await payment.verify(req, requirements);
      } catch (error) {
        return rejectPaymentVerification(req, res, error);
      }
    }

    if (quote?.buyer && verified.payer.toLowerCase() !== String(quote.buyer).toLowerCase()) {
      return sendJson(res, 400, {
        ok: false,
        error: "coverage_quote_buyer_mismatch",
        charged: false,
      });
    }

    let guard = staticGuard;
    let targetOrder = null;
    let reserveBalanceAtomic;
    let coverageCapAtomic = 0n;
    let coverageDeadline = null;
    let coverageEnrollmentClosesAt = null;

    if (policy.onchainPolicyId) {
      reserveBalanceAtomic = 0n;
    } else {
      try {
        reserveBalanceAtomic = await getChain().getReserveBalance();
      } catch {
        return sendJson(res, 503, {
          ok: false,
          error: "reserve_balance_unavailable",
          charged: false,
        });
      }
    }

    if (guard.verdict === "ALLOW") {
      try {
        targetOrder = await getChain().verifyTargetOrder({
          jobId: input.targetJobId,
          creationTxHash: input.targetCreationTxHash,
          acceptanceTxHash: input.targetAcceptanceTxHash,
          buyer: verified.payer,
          policy,
        });
        if (input.targetTaskReference) {
          targetOrder = { ...targetOrder, publicTaskReference: input.targetTaskReference };
        }
        const acceptedAtMs = Date.parse(targetOrder.acceptedAt);
        if (!Number.isFinite(acceptedAtMs)) {
          guard = { verdict: "BLOCK", reason: "target_acceptance_timestamp_invalid" };
        } else {
          const coverageDeadlineMs = policy.clockMode === "policypool_relay"
            ? null
            : acceptedAtMs + policy.slaSeconds * 1000;
          const enrollmentDeadlineMs = acceptedAtMs + policy.enrollmentWindowSeconds * 1000;
          coverageDeadline = coverageDeadlineMs === null ? null : new Date(coverageDeadlineMs).toISOString();
          coverageEnrollmentClosesAt = new Date(enrollmentDeadlineMs).toISOString();
          if (coverageDeadlineMs !== null && coverageDeadlineMs <= now()) {
            guard = { verdict: "BLOCK", reason: "registered_policy_sla_already_elapsed" };
          } else if (enrollmentDeadlineMs <= now()) {
            guard = { verdict: "BLOCK", reason: "coverage_enrollment_window_closed" };
          }
        }
        if (guard.verdict === "ALLOW") {
          coverageCapAtomic = minBigInt(
            input.requestedCoverageAtomic,
            BigInt(targetOrder.amountAtomic),
            policyCoverageCapAtomic(policy, COVERAGE.maxAtomic),
            BigInt(COVERAGE.maxAtomic),
            policy.providerAvailableBondAtomic
              ? BigInt(policy.providerAvailableBondAtomic)
              : BigInt(COVERAGE.maxAtomic),
          );
          if (coverageCapAtomic < BigInt(COVERAGE.minAtomic)) {
            guard = { verdict: "BLOCK", reason: "verified_coverage_cap_below_minimum" };
            coverageCapAtomic = 0n;
          }
        }
      } catch (error) {
        if (error instanceof EvidenceError) {
          guard = { verdict: "BLOCK", reason: error.code };
          coverageCapAtomic = 0n;
        } else {
          return sendJson(res, 503, {
            ok: false,
            error: "target_or_reserve_verifier_unavailable",
            charged: false,
          });
        }
      }
    }

    if (guard.verdict === "BLOCK") {
      return sendJson(res, 400, {
        ok: false,
        error: guard.reason,
        charged: false,
        quoteId: quote?.id || null,
      });
    }

    const requestId = `sha256:${sha256({
      targetAgentId: policy?.agentId || input.targetAgent,
      targetServiceId: input.targetServiceId || policy?.serviceIds?.[0] || null,
      targetJobId: input.targetJobId,
    })}`;
    const receiptId = `ppc-${requestId.slice(7, 23)}`;
    const createdAt = new Date(now()).toISOString();
    const storedInput = {
      ...input,
      requestedCoverageAtomic: input.requestedCoverageAtomic.toString(),
    };
    let plannedUniversalCovenant = null;
    let feeAuthorization = null;
    if (policy.onchainPolicyId) {
      try {
        feeAuthorization = universalFeeAuthorization(verified, now());
        plannedUniversalCovenant = {
          covenantId: getUniversalIssuer().previewCovenantId({ policy, targetOrder, paymentAuthorization: feeAuthorization }),
          state: "planned",
        };
      } catch (error) {
        return sendJson(res, error instanceof UniversalIssuerError ? error.status : 422, {
          ok: false,
          error: error instanceof UniversalIssuerError ? error.code : "fee_authorization_invalid",
          charged: false,
        });
      }
    }
    let pending = {
      receiptId,
      requestId,
      paymentId: verified.paymentId,
      state: "pending",
      createdAt,
      liabilityAtomic: policy.onchainPolicyId ? "0" : coverageCapAtomic.toString(),
      providerBondLiabilityAtomic: policy.onchainPolicyId ? coverageCapAtomic.toString() : "0",
      input: storedInput,
      guard,
      targetOrder,
      payer: verified.payer,
      quoteId: quote?.id || null,
      feeAuthorization,
      universalCovenant: plannedUniversalCovenant,
    };

    let reservation;
    try {
      reservation = await ledger.reserve(pending, reserveBalanceAtomic);
      if (reservation.status === "insufficient_reserve" && coverageCapAtomic > 0n) {
        return sendJson(res, 409, {
          ok: false,
          error: "insufficient_uncommitted_reserve",
          charged: false,
        });
      }
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "durable_ledger_unavailable",
        detail: error instanceof Error ? error.message : String(error),
        charged: false,
      });
    }

    if (reservation.status === "payment_exists") {
      const existing = await ledger.get(reservation.receiptId);
      if (existing?.receipt) return respond(res, { ...existing, replayed: true });
      return sendJson(res, 409, { ok: false, error: "payment_is_already_processing", charged: false });
    }
    if (reservation.status === "request_exists") {
      return sendJson(res, 409, { ok: false, error: "request_already_has_a_receipt", charged: false });
    }
    if (reservation.status !== "reserved") {
      return sendJson(res, 503, { ok: false, error: "coverage_reservation_failed", charged: false });
    }

    let universalCovenant = null;
    let relayGrantPayload = null;
    if (policy.onchainPolicyId) {
      try {
        universalCovenant = await getUniversalIssuer().issue({
          policy,
          targetOrder,
          coverageCapAtomic,
          enrollmentClosesAt: coverageEnrollmentClosesAt,
          paymentAuthorization: feeAuthorization,
        });
        if (universalCovenant.covenantId.toLowerCase() !== plannedUniversalCovenant.covenantId.toLowerCase()) {
          throw new UniversalIssuerError("coverage_manager_covenant_id_mismatch");
        }
        if (policy.clockMode === "policypool_relay") {
          ({ payload: relayGrantPayload } = getRelayGrantService().issue({
            covenantId: universalCovenant.covenantId,
            targetJobId: targetOrder.jobId,
            buyer: verified.payer,
            agentId: policy.agentId,
            serviceId: policy.serviceIds[0],
            expiresAt: coverageEnrollmentClosesAt,
          }));
        }
        pending = { ...pending, universalCovenant };
        const attached = await ledger.transitionUniversal(pending, ["pending"]);
        if (attached?.universalCovenant?.transactionHash !== universalCovenant.transactionHash) {
          throw new UniversalIssuerError("coverage_manager_outbox_update_failed");
        }
      } catch (error) {
        const covenantToReconcile = universalCovenant || plannedUniversalCovenant;
        if (covenantToReconcile?.covenantId) {
          const compensationPending = {
            ...pending,
            universalCovenant: covenantToReconcile,
            state: "compensation_required",
            compensation: {
              reason: universalCovenant
                ? "coverage_issuance_aborted"
                : "coverage_issuance_outcome_unconfirmed",
              createdAt: new Date(now()).toISOString(),
              feeAuthorization,
            },
          };
          await ledger.transitionUniversal(compensationPending, ["pending"]).catch(() => undefined);
          return sendJson(res, 503, {
            ok: false,
            error: "provider_bond_cancellation_pending_authorization_expiry",
            charged: false,
            receiptId,
            retryAfter: new Date(Number(feeAuthorization.validBefore) * 1_000).toISOString(),
          });
        } else {
          await ledger.release(pending).catch(() => undefined);
        }
        return sendJson(res, error instanceof UniversalIssuerError ? error.status : 503, {
          ok: false,
          error: error instanceof UniversalIssuerError ? error.code : "provider_bond_lock_failed",
          charged: false,
        });
      }
    }

    let settlement;
    try {
      settlement = await payment.settle(verified, requirements);
    } catch (error) {
      let compensationPending = pending;
      if (universalCovenant?.covenantId) {
        compensationPending = {
          ...pending,
          state: "compensation_required",
          compensation: {
            reason: "coverage_fee_not_settled",
            createdAt: new Date(now()).toISOString(),
            feeAuthorization,
          },
        };
        await ledger.transitionUniversal(compensationPending, ["pending"]).catch(() => undefined);
        return sendJson(res, 503, {
          ok: false,
          error: "provider_bond_cancellation_pending_authorization_expiry",
          charged: false,
          receiptId,
          retryAfter: new Date(Number(feeAuthorization.validBefore) * 1_000).toISOString(),
        });
      } else {
        await ledger.release(pending).catch(() => undefined);
      }
      if (error instanceof PaymentVerificationError) return paymentRequired(req, res, error.code);
      return paymentRequired(req, res, "payment_settlement_failed");
    }

    const receipt = buildReceipt({
      receiptId,
      input,
      policy,
      guard,
      targetOrder,
      payer: verified.payer,
      coverageCapAtomic,
      reserveBalanceAtomic,
      settlement,
      generatedAt: new Date(now()).toISOString(),
      coverageDeadline,
      coverageEnrollmentClosesAt,
      quote,
      universalCovenant,
      relayGrantPayload,
    });
    const finalRecord = {
      ...pending,
      state: guard.verdict === "ALLOW"
        ? policy.clockMode === "policypool_relay" ? "pending_start" : "active"
        : "declined",
      finalizedAt: new Date(now()).toISOString(),
      liabilityAtomic: policy.onchainPolicyId ? "0" : coverageCapAtomic.toString(),
      providerBondLiabilityAtomic: policy.onchainPolicyId ? coverageCapAtomic.toString() : "0",
      universalCovenant,
      relayGrantPayload,
      guard,
      settlement: {
        network: settlement.network,
        transaction: settlement.transaction,
        payer: settlement.payer,
        amountAtomic: settlement.amount,
        transfer: settlement.transfer,
      },
      paymentResponseHeader: settlement.responseHeader,
      receipt,
    };

    try {
      await ledger.finalize(finalRecord);
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "payment_settled_receipt_pending_reconciliation",
        charged: true,
        paymentTransaction: settlement.transaction,
        receiptId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return respond(res, finalRecord);
  };
}

const handler = createHandler();
export default handler;

export const __test = {
  buildReceipt,
  challengeFor,
  evaluateGuard,
  readInput,
};
