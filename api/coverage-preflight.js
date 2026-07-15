import { COVERAGE, PAYMENT, XLAYER } from "./lib/config.js";
import { createChainService, EvidenceError } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { fetchOkxTaskPage, OkxTaskPageError } from "./lib/okx-task-page.js";
import {
  createQuoteService,
  QuoteConfigurationError,
  QuoteValidationError,
} from "./lib/quote.js";
import {
  findPublishedPolicy,
  listPublishedPolicies,
  policyCoverageCapAtomic,
} from "./lib/policy-registry.js";
import { evaluateGuard } from "./covered-job-receipt.js";
import { clean, formatUsdtAtomic, header, parseUsdtAtomic, sendJson } from "./lib/utils.js";

const INPUT_ALIASES = {
  targetAgent: ["targetAgent", "agent", "agentId", "serviceId", "targetService"],
  taskReference: ["taskReference", "taskUrl", "okxTask", "publicTaskId", "jobUrl"],
  requestedCoverageUSDT: ["requestedCoverageUSDT", "coverageCapUSDT", "capUSDT", "coverageAmountUSDT"],
};
const CONTAINER_KEYS = new Set(["input", "data", "payload", "request", "parameters", "arguments", "context", "body"]);

function supportedTargets() {
  return listPublishedPolicies().map((policy) => ({
    agentId: policy.agentId,
    agentName: policy.agentName,
    serviceIds: policy.serviceIds,
    serviceName: policy.serviceName,
    serviceType: policy.serviceType,
    slaSeconds: policy.slaSeconds,
    maxCoverageAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic).toString(),
    coverageStatus: policy.coverageStatus || "active",
    coverableNow: !policy.coverageStatus || policy.coverageStatus === "active",
    clockSource: policy.clockSource || "verified_acceptance_block",
    processingStart: policy.processingStart || "verified target-job acceptance",
    enrollmentWindowSeconds: policy.enrollmentWindowSeconds,
    exclusions: policy.exclusions || [],
  }));
}

function readInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
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
  const readAlias = (aliases, max = 900) => {
    for (const alias of aliases) {
      const wanted = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
          if (key.toLowerCase().replace(/[^a-z0-9]/g, "") !== wanted || (value && typeof value === "object")) continue;
          const result = clean(value, max);
          if (result) return result;
        }
      }
    }
    return "";
  };
  const requested = readAlias(INPUT_ALIASES.requestedCoverageUSDT, 40) || "1";
  return {
    targetAgent: readAlias(INPUT_ALIASES.targetAgent),
    taskReference: readAlias(INPUT_ALIASES.taskReference, 300),
    requestedCoverageAtomic: parseUsdtAtomic(requested, PAYMENT.decimals),
  };
}

function paidEndpoint(req, quoteToken) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  const endpoint = new URL(`${proto}://${host}/api/covered-job-receipt`);
  if (quoteToken) endpoint.searchParams.set("quote", quoteToken);
  return endpoint.toString();
}

function minBigInt(...values) {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function evidenceUnavailable(error) {
  return [
    "target_chain_head_unavailable",
    "target_block_lookup_failed",
    "target_event_lookup_failed",
    "transaction_unconfirmed",
    "target_job_status_unavailable",
  ].includes(error?.code);
}

function decline(res, reason, extra = {}) {
  return sendJson(res, 200, {
    ok: true,
    eligible: false,
    charged: false,
    reason,
    ...extra,
  });
}

export function createCoveragePreflightHandler(dependencies = {}) {
  let runtimeChain = dependencies.chain;
  let runtimeLedger = dependencies.ledger;
  let runtimeQuoteService = dependencies.quoteService;
  const taskFetcher = dependencies.taskFetcher || fetchOkxTaskPage;
  const now = dependencies.now || (() => Date.now());
  const getChain = () => (runtimeChain ||= createChainService());
  const getLedger = () => (runtimeLedger ||= createLedger());
  const getQuoteService = () => (runtimeQuoteService ||= createQuoteService({
    ledger: getLedger(),
    secret: dependencies.quoteSecret,
    now,
    randomId: dependencies.quoteRandomId,
    ttlSeconds: dependencies.quoteTtlSeconds,
  }));

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.status(200).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", charged: false });
    }

    const input = readInput(req);
    if (!input.targetAgent && !input.taskReference) {
      return sendJson(res, 200, {
        ok: true,
        service: "PolicyPool Coverage Preflight",
        charged: false,
        description: "Resolve an OKX.AI task URL into a verified, coverage-ready paid request.",
        required: ["targetAgent", "taskReference"],
        supportedTargets: supportedTargets(),
      });
    }
    if (!input.targetAgent) {
      return sendJson(res, 400, {
        ok: false,
        error: "target_agent_required",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }
    if (!input.taskReference) {
      return sendJson(res, 400, { ok: false, error: "okx_task_reference_required", charged: false });
    }
    if (input.requestedCoverageAtomic < BigInt(COVERAGE.minAtomic)) {
      return decline(res, "requested_coverage_below_minimum");
    }

    const policy = findPublishedPolicy(input.targetAgent);
    if (!policy) {
      return sendJson(res, 422, {
        ok: false,
        error: "target_policy_not_registered",
        charged: false,
        supportedTargets: supportedTargets(),
      });
    }
    if (policy.coverageStatus && policy.coverageStatus !== "active") {
      return decline(res, policy.coverageBlockReason || "registered_policy_not_active", {
        policy: {
          agentId: policy.agentId,
          agentName: policy.agentName,
          serviceIds: policy.serviceIds,
          serviceName: policy.serviceName,
          coverageStatus: policy.coverageStatus,
          coverableNow: false,
          clockSource: policy.clockSource,
          processingStart: policy.processingStart,
          exclusions: policy.exclusions || [],
        },
      });
    }

    let task;
    try {
      task = await taskFetcher(input.taskReference);
    } catch (error) {
      if (error instanceof OkxTaskPageError) {
        return sendJson(res, 422, { ok: false, error: error.code, charged: false });
      }
      return sendJson(res, 502, { ok: false, error: "okx_task_fetch_failed", charged: false });
    }

    let evidence;
    let targetOrder;
    try {
      evidence = await getChain().resolveTargetOrderEvidence({
        jobId: task.jobId,
        createdAt: task.openedAt,
        acceptedAt: task.acceptedAt,
      });
      targetOrder = await getChain().verifyTargetOrder({
        jobId: task.jobId,
        creationTxHash: evidence.creationTxHash,
        acceptanceTxHash: evidence.acceptanceTxHash,
        buyer: evidence.buyer,
        policy,
      });
    } catch (error) {
      if (error instanceof EvidenceError) {
        if (evidenceUnavailable(error)) {
          return sendJson(res, 503, { ok: false, error: error.code, charged: false });
        }
        return decline(res, error.code, { task });
      }
      return sendJson(res, 503, { ok: false, error: "target_evidence_unavailable", charged: false });
    }

    const guardInput = {
      targetAgent: `${policy.agentName}#${policy.agentId}`,
      targetJobId: task.jobId,
      targetCreationTxHash: evidence.creationTxHash,
      targetAcceptanceTxHash: evidence.acceptanceTxHash,
      jobDescription: task.description,
      requestedCoverageAtomic: input.requestedCoverageAtomic,
    };
    const guard = evaluateGuard(guardInput, policy);
    if (guard.verdict !== "ALLOW") return decline(res, guard.reason, { task, targetOrder });

    let reserveBalanceAtomic;
    let liabilityStats;
    try {
      [reserveBalanceAtomic, liabilityStats] = await Promise.all([
        getChain().getReserveBalance(),
        getLedger().stats(),
      ]);
    } catch {
      return sendJson(res, 503, { ok: false, error: "coverage_capacity_unavailable", charged: false });
    }

    const committedAtomic = BigInt(liabilityStats.committedAtomic);
    const availableAtomic = reserveBalanceAtomic > committedAtomic
      ? reserveBalanceAtomic - committedAtomic
      : 0n;
    const coverageCapAtomic = minBigInt(
      input.requestedCoverageAtomic,
      BigInt(targetOrder.amountAtomic),
      policyCoverageCapAtomic(policy, COVERAGE.maxAtomic),
      BigInt(COVERAGE.maxAtomic),
      availableAtomic,
    );
    if (coverageCapAtomic < BigInt(COVERAGE.minAtomic)) {
      return decline(res, "insufficient_uncommitted_reserve", {
        task,
        reserve: {
          balanceUSDT: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
          committedUSDT: formatUsdtAtomic(committedAtomic, PAYMENT.decimals),
          availableUSDT: formatUsdtAtomic(availableAtomic, PAYMENT.decimals),
        },
      });
    }

    const deadlineMs = Date.parse(targetOrder.acceptedAt) + policy.slaSeconds * 1000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now()) {
      return decline(res, "registered_policy_sla_already_elapsed", { task, targetOrder });
    }
    const enrollmentDeadlineMs = Date.parse(targetOrder.acceptedAt) + policy.enrollmentWindowSeconds * 1000;
    if (!Number.isFinite(enrollmentDeadlineMs) || enrollmentDeadlineMs <= now()) {
      return decline(res, "coverage_enrollment_window_closed", { task, targetOrder });
    }

    const requestBody = {
      targetAgent: `${policy.agentName}#${policy.agentId}`,
      targetJobId: task.jobId,
      targetCreationTxHash: evidence.creationTxHash,
      targetAcceptanceTxHash: evidence.acceptanceTxHash,
      jobDescription: task.description,
      requestedCoverageUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
    };

    let quote;
    try {
      quote = await getQuoteService().issue({
        requestBody,
        buyer: targetOrder.buyer,
        policyHash: policy.policyHash,
        source: "verified_preflight",
        deadline: new Date(Math.min(deadlineMs, enrollmentDeadlineMs)).toISOString(),
      });
    } catch (error) {
      if (error instanceof QuoteValidationError) {
        return decline(res, error.code, { task, targetOrder });
      }
      const code = error instanceof QuoteConfigurationError
        ? "coverage_quote_not_configured"
        : "coverage_quote_unavailable";
      return sendJson(res, 503, { ok: false, error: code, charged: false });
    }

    return sendJson(res, 200, {
      ok: true,
      version: "0.3.0",
      eligible: true,
      charged: false,
      generatedAt: new Date(now()).toISOString(),
      task,
      policy: {
        agentId: policy.agentId,
        agentName: policy.agentName,
        serviceName: policy.serviceName,
        serviceType: policy.serviceType,
        policyHash: policy.policyHash,
        slaSeconds: policy.slaSeconds,
        maxCoverageAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic).toString(),
        coverageStatus: policy.coverageStatus || "active",
        clockSource: policy.clockSource || "verified_acceptance_block",
        processingStart: policy.processingStart || "verified target-job acceptance",
        enrollmentWindowSeconds: policy.enrollmentWindowSeconds,
        exclusions: policy.exclusions || [],
      },
      evidence: {
        source: "OKX.AI public task page plus X Layer task escrow events",
        ...evidence,
        verifiedTargetOrder: targetOrder,
      },
      coverage: {
        deadline: new Date(deadlineMs).toISOString(),
        enrollmentClosesAt: new Date(enrollmentDeadlineMs).toISOString(),
        capAtomic: coverageCapAtomic.toString(),
        capUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
        serviceFeeUSDT: formatUsdtAtomic(PAYMENT.amountAtomic, PAYMENT.decimals),
        reserveBalanceUSDT: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
        committedUSDT: formatUsdtAtomic(committedAtomic, PAYMENT.decimals),
        availableUSDT: formatUsdtAtomic(availableAtomic, PAYMENT.decimals),
        finalReservationRecheckedAtSettlement: true,
      },
      quote: {
        id: quote.id,
        token: quote.token,
        issuedAt: quote.issuedAt,
        expiresAt: quote.expiresAt,
        source: quote.source,
        signed: true,
        singleJob: true,
      },
      paidRequest: {
        protocol: "OKX Agent Payments Protocol",
        network: XLAYER.network,
        endpoint: paidEndpoint(req, quote.token),
        method: "POST",
        payerMustEqualTargetBuyer: targetOrder.buyer,
        body: {
          ...requestBody,
          quoteId: quote.token,
        },
        bodyMayBeOmittedOnReplay: true,
      },
    });
  };
}

const handler = createCoveragePreflightHandler();
export default handler;

export const __test = { readInput };
