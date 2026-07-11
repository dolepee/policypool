import { COVERAGE, PAYMENT, XLAYER } from "./lib/config.js";
import { createChainService, EvidenceError } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { fetchOkxTaskPage, OkxTaskPageError } from "./lib/okx-task-page.js";
import { findPublishedPolicy, listPublishedPolicies } from "./lib/policy-registry.js";
import { evaluateGuard } from "./covered-job-receipt.js";
import { clean, formatUsdtAtomic, header, parseUsdtAtomic, sendJson } from "./lib/utils.js";

function supportedTargets() {
  return listPublishedPolicies().map((policy) => ({
    agentId: policy.agentId,
    agentName: policy.agentName,
    serviceIds: policy.serviceIds,
    serviceName: policy.serviceName,
    serviceType: policy.serviceType,
    slaSeconds: policy.slaSeconds,
  }));
}

function readInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    targetAgent: clean(body.targetAgent || body.agent || body.agentId || body.serviceId),
    taskReference: clean(body.taskReference || body.taskUrl || body.okxTask || body.publicTaskId, 300),
    requestedCoverageAtomic: parseUsdtAtomic(
      String(body.requestedCoverageUSDT ?? body.coverageCapUSDT ?? body.capUSDT ?? "1"),
      PAYMENT.decimals,
    ),
  };
}

function paidEndpoint(req) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  return `${proto}://${host}/api/covered-job-receipt`;
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
  const taskFetcher = dependencies.taskFetcher || fetchOkxTaskPage;
  const now = dependencies.now || (() => Date.now());
  const getChain = () => (runtimeChain ||= createChainService());
  const getLedger = () => (runtimeLedger ||= createLedger());

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

    const requestBody = {
      targetAgent: `${policy.agentName}#${policy.agentId}`,
      targetJobId: task.jobId,
      targetCreationTxHash: evidence.creationTxHash,
      targetAcceptanceTxHash: evidence.acceptanceTxHash,
      jobDescription: task.description,
      requestedCoverageUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
    };

    return sendJson(res, 200, {
      ok: true,
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
      },
      evidence: {
        source: "OKX.AI public task page plus X Layer task escrow events",
        ...evidence,
        verifiedTargetOrder: targetOrder,
      },
      coverage: {
        deadline: new Date(deadlineMs).toISOString(),
        capAtomic: coverageCapAtomic.toString(),
        capUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
        serviceFeeUSDT: formatUsdtAtomic(PAYMENT.amountAtomic, PAYMENT.decimals),
        reserveBalanceUSDT: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
        committedUSDT: formatUsdtAtomic(committedAtomic, PAYMENT.decimals),
        availableUSDT: formatUsdtAtomic(availableAtomic, PAYMENT.decimals),
        finalReservationRecheckedAtSettlement: true,
      },
      paidRequest: {
        protocol: "OKX Agent Payments Protocol",
        network: XLAYER.network,
        endpoint: paidEndpoint(req),
        method: "POST",
        payerMustEqualTargetBuyer: targetOrder.buyer,
        body: requestBody,
      },
    });
  };
}

const handler = createCoveragePreflightHandler();
export default handler;

export const __test = { readInput };
