import { COVERAGE, OBJECTIVE_BREACH_RULES, PAYMENT, XLAYER, paymentRequirements } from "./lib/config.js";
import { createChainService, EvidenceError } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import {
  createPaymentService,
  PaymentConfigurationError,
  PaymentVerificationError,
} from "./lib/payment.js";
import { findPublishedPolicy, listPublishedPolicies } from "./lib/policy-registry.js";
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
        targetCreationTxHash: {
          type: "string",
          description: "X Layer transaction that created the target job and binds its buyer wallet.",
        },
        targetAcceptanceTxHash: {
          type: "string",
          description: "X Layer transaction that moved the target job from created to accepted.",
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

function absoluteUrl(req) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  return req.url?.startsWith("http") ? req.url : `${proto}://${host}${req.url || "/api/covered-job-receipt"}`;
}

function challengeFor(req, error = "Payment required") {
  return {
    x402Version: 2,
    error,
    resource: {
      url: absoluteUrl(req),
      description: "PolicyPool Covered Job Receipt API",
      mimeType: "application/json",
    },
    outputSchema: OUTPUT_SCHEMA,
    accepts: [{
      ...paymentRequirements(),
      outputSchema: OUTPUT_SCHEMA,
    }],
  };
}

function paymentRequired(req, res, error = "Payment required") {
  const challenge = challengeFor(req, error);
  res.setHeader("PAYMENT-REQUIRED", encodeBase64Json(challenge));
  return sendJson(res, 402, {
    ok: false,
    error,
    charged: false,
    ...challenge,
  });
}

function readInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const requested = body.requestedCoverageUSDT ?? body.coverageCapUSDT ?? body.capUSDT ?? "1";
  return {
    targetAgent: clean(body.targetAgent || body.agent || body.agentId || body.serviceId),
    targetJobId: clean(body.targetJobId || body.jobId, 80),
    targetCreationTxHash: clean(body.targetCreationTxHash || body.creationTxHash, 80),
    targetAcceptanceTxHash: clean(body.targetAcceptanceTxHash || body.acceptanceTxHash, 80),
    jobDescription: clean(body.jobDescription || body.job || body.task || body.prompt),
    requestedDeadline: clean(body.deadline || body.dueAt || body.expiresAt, 80),
    requestedCoverageAtomic: parseUsdtAtomic(String(requested), PAYMENT.decimals),
  };
}

function readTargetAgent(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return clean(body.targetAgent || body.agent || body.agentId || body.serviceId);
}

function supportedTargets() {
  return listPublishedPolicies().map((policy) => ({
    agentId: policy.agentId,
    agentName: policy.agentName,
    serviceIds: policy.serviceIds,
    serviceType: policy.serviceType,
  }));
}

export function evaluateGuard(input, policy) {
  if (!policy) return { verdict: "BLOCK", reason: "target_policy_not_registered" };
  if (!isBytes32(input.targetJobId)) return { verdict: "BLOCK", reason: "target_job_id_required" };
  if (!isBytes32(input.targetCreationTxHash)) {
    return { verdict: "BLOCK", reason: "target_creation_transaction_required" };
  }
  if (!isBytes32(input.targetAcceptanceTxHash)) {
    return { verdict: "BLOCK", reason: "target_acceptance_transaction_required" };
  }
  if (!input.jobDescription) return { verdict: "BLOCK", reason: "job_description_required" };
  if (!Number.isSafeInteger(policy.slaSeconds)
    || policy.slaSeconds <= 0
    || policy.slaSeconds > COVERAGE.maxDurationSeconds) {
    return { verdict: "BLOCK", reason: "registered_policy_sla_invalid" };
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
}) {
  const issued = guard.verdict === "ALLOW";
  const draft = {
    protocol: "PolicyPool Agent Coverage",
    version: "0.2.0",
    receiptId,
    generatedAt,
    outcome: issued
      ? {
        type: "ISSUED",
        status: "coverage_active",
        reason: "registered_policy_matched_and_target_job_acceptance_verified",
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
      coverageCapAtomic: coverageCapAtomic.toString(),
      coverageCapUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
      objectiveBreachRules: OBJECTIVE_BREACH_RULES,
    } : null,
    guard: {
      ...guard,
      callerSuppliedPolicyIgnored: true,
      callerSuppliedDeadlineIgnored: true,
      callerSuppliedBreachAndPayoutFieldsIgnored: true,
      derivedCoverageDeadline: coverageDeadline,
    },
    reserve: {
      chain: XLAYER.name,
      chainId: XLAYER.id,
      wallet: COVERAGE.reserveWallet,
      asset: PAYMENT.asset,
      balanceAtomicAtDecision: reserveBalanceAtomic.toString(),
      balanceUSDTAtDecision: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
      publicUrl: COVERAGE.publicUrl,
    },
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

function respondWithRecord(res, record) {
  if (record.paymentResponseHeader) {
    res.setHeader("PAYMENT-RESPONSE", record.paymentResponseHeader);
    res.setHeader("X-PAYMENT-RESPONSE", record.paymentResponseHeader);
  }
  return sendJson(res, 200, {
    ok: true,
    agent: "PolicyPool",
    service: "Covered Job Receipt",
    mode: "api_service",
    idempotentReplay: Boolean(record.replayed),
    receipt: record.receipt,
  });
}

export function createHandler(dependencies = {}) {
  let runtimeChain = dependencies.chain;
  let runtimeLedger = dependencies.ledger;
  let runtimePayment = dependencies.payment;
  const now = dependencies.now || (() => Date.now());
  const getChain = () => (runtimeChain ||= createChainService());
  const getLedger = () => (runtimeLedger ||= createLedger());
  const getPayment = () => (runtimePayment ||= createPaymentService({ chain: getChain() }));

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

    const targetAgent = readTargetAgent(req);
    const policy = targetAgent ? findPublishedPolicy(targetAgent) : null;
    if (targetAgent && !policy) {
      return sendJson(res, 422, {
        ok: false,
        error: "target_policy_not_registered",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }

    const paymentSignature = header(req, "payment-signature");
    if (!paymentSignature) return paymentRequired(req, res);
    if (!targetAgent) {
      return sendJson(res, 400, {
        ok: false,
        error: "target_agent_required",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }

    let ledger;
    let payment;
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

    const paymentId = payment.fingerprint(req);
    try {
      const existingPayment = await ledger.findByPaymentId(paymentId);
      if (existingPayment?.receipt) {
        return respondWithRecord(res, { ...existingPayment, replayed: true });
      }
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "durable_ledger_unavailable",
        detail: error instanceof Error ? error.message : String(error),
        charged: false,
      });
    }

    const requirements = paymentRequirements();
    let verified;
    try {
      verified = await payment.verify(req, requirements);
    } catch (error) {
      if (error instanceof PaymentConfigurationError) {
        return sendJson(res, 503, { ok: false, error: "payment_service_not_ready", charged: false });
      }
      if (error instanceof PaymentVerificationError) {
        return paymentRequired(req, res, error.code);
      }
      return paymentRequired(req, res, "payment_verification_failed");
    }

    const input = readInput(req);
    let guard = evaluateGuard(input, policy);
    if (guard.verdict === "BLOCK" && guard.reason === "requested_coverage_below_minimum") {
      return sendJson(res, 400, {
        ok: false,
        error: guard.reason,
        charged: false,
        minimumCoverageUSDT: formatUsdtAtomic(BigInt(COVERAGE.minAtomic), PAYMENT.decimals),
      });
    }
    let targetOrder = null;
    let reserveBalanceAtomic;
    let coverageCapAtomic = 0n;
    let coverageDeadline = null;

    try {
      reserveBalanceAtomic = await getChain().getReserveBalance();
    } catch {
      return sendJson(res, 503, {
        ok: false,
        error: "reserve_balance_unavailable",
        charged: false,
      });
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
        const acceptedAtMs = Date.parse(targetOrder.acceptedAt);
        if (!Number.isFinite(acceptedAtMs)) {
          guard = { verdict: "BLOCK", reason: "target_acceptance_timestamp_invalid" };
        } else {
          const coverageDeadlineMs = acceptedAtMs + policy.slaSeconds * 1000;
          coverageDeadline = new Date(coverageDeadlineMs).toISOString();
          if (coverageDeadlineMs <= now()) {
            guard = { verdict: "BLOCK", reason: "registered_policy_sla_already_elapsed" };
          }
        }
        if (guard.verdict === "ALLOW") {
          coverageCapAtomic = minBigInt(
            input.requestedCoverageAtomic,
            BigInt(targetOrder.amountAtomic),
            BigInt(COVERAGE.maxAtomic),
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

    const requestId = `sha256:${sha256({
      targetAgentId: policy?.agentId || input.targetAgent,
      targetJobId: input.targetJobId,
    })}`;
    const receiptId = `ppc-${requestId.slice(7, 23)}`;
    const createdAt = new Date(now()).toISOString();
    const storedInput = {
      ...input,
      requestedCoverageAtomic: input.requestedCoverageAtomic.toString(),
    };
    let pending = {
      receiptId,
      requestId,
      paymentId: verified.paymentId,
      state: "pending",
      createdAt,
      liabilityAtomic: coverageCapAtomic.toString(),
      input: storedInput,
      guard,
      targetOrder,
      payer: verified.payer,
    };

    let reservation;
    try {
      reservation = await ledger.reserve(pending, reserveBalanceAtomic);
      if (reservation.status === "insufficient_reserve" && coverageCapAtomic > 0n) {
        guard = { verdict: "BLOCK", reason: "insufficient_uncommitted_reserve" };
        coverageCapAtomic = 0n;
        pending = { ...pending, liabilityAtomic: "0", guard };
        reservation = await ledger.reserve(pending, reserveBalanceAtomic);
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
      if (existing?.receipt) return respondWithRecord(res, { ...existing, replayed: true });
      return sendJson(res, 409, { ok: false, error: "payment_is_already_processing", charged: false });
    }
    if (reservation.status === "request_exists") {
      return sendJson(res, 409, { ok: false, error: "request_already_has_a_receipt", charged: false });
    }
    if (reservation.status !== "reserved") {
      return sendJson(res, 503, { ok: false, error: "coverage_reservation_failed", charged: false });
    }

    let settlement;
    try {
      settlement = await payment.settle(verified, requirements);
    } catch (error) {
      await ledger.release(pending).catch(() => undefined);
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
    });
    const finalRecord = {
      ...pending,
      state: guard.verdict === "ALLOW" ? "active" : "declined",
      finalizedAt: new Date(now()).toISOString(),
      liabilityAtomic: coverageCapAtomic.toString(),
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
    return respondWithRecord(res, finalRecord);
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
