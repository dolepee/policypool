import {
  COVERAGE,
  MARKETPLACE,
  ONCHAIN_EVIDENCE_LIMITATIONS,
  PAYMENT,
  XLAYER,
} from "./lib/config.js";
import { createChainService, EvidenceError } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { fetchOkxTaskPage, OkxTaskPageError } from "./lib/okx-task-page.js";
import {
  createQuoteService,
  QuoteConfigurationError,
  QuoteValidationError,
} from "./lib/quote.js";
import {
  listPublishedPolicies,
  policyCoverageCapAtomic,
} from "./lib/policy-registry.js";
import { coverageEconomics, resolveCoverageCap } from "./lib/coverage-economics.js";
import { createCoveragePolicyResolver } from "./lib/policy-resolution.js";
import { UniversalPolicyError } from "./lib/universal-policy.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";
import { evaluateGuard } from "./covered-job-receipt.js";
import { clean, formatUsdtAtomic, header, parseUsdtAtomic, sendJson as rawSendJson, sha256 } from "./lib/utils.js";
import { enrichCoverageResponse } from "./lib/coverage-state.js";

// Every response from this endpoint carries an explicit lifecycle state and
// next action, so a buyer agent can tell "coverable" from "covered".
function sendJson(res, status, payload) {
  return rawSendJson(res, status, enrichCoverageResponse(payload, { httpStatus: status }));
}

const INPUT_ALIASES = {
  targetAgent: ["targetAgent", "agent", "agentId", "serviceId", "targetService"],
  targetServiceId: ["targetServiceId", "listedServiceId"],
  taskReference: ["taskReference", "taskUrl", "okxTask", "publicTaskId", "jobUrl"],
  requestedCoverageUSDT: ["requestedCoverageUSDT", "coverageCapUSDT", "capUSDT", "coverageAmountUSDT"],
  // Direct on-chain evidence. The buyer supplies the exact transactions instead
  // of a public task reference; PolicyPool verifies them rather than trusting
  // them. Same alias names the paid endpoint already accepts, so a quote and a
  // purchase are written the same way.
  targetJobId: ["targetJobId", "jobId", "taskId"],
  targetCreationTxHash: ["targetCreationTxHash", "creationTxHash", "jobCreationTxHash"],
  targetAcceptanceTxHash: ["targetAcceptanceTxHash", "acceptanceTxHash", "jobAcceptanceTxHash"],
  targetBuyer: ["targetBuyer", "buyer", "buyerWallet", "coverageBuyer"],
  targetCreatedAt: ["targetCreatedAt", "jobCreatedAt", "taskCreatedAt", "creationTimeHint"],
  targetAcceptedAt: ["targetAcceptedAt", "jobAcceptedAt", "taskAcceptedAt", "acceptanceTimeHint"],
  jobDescription: ["jobDescription", "description", "jobSummary"],
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

function targetOptions() {
  const targets = supportedTargets();
  return {
    supportedTargets: targets,
    coverableTargets: targets.filter((target) => target.coverableNow),
  };
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
    targetServiceId: readAlias(INPUT_ALIASES.targetServiceId, 40),
    taskReference: readAlias(INPUT_ALIASES.taskReference, 300),
    requestedCoverageAtomic: parseUsdtAtomic(requested, PAYMENT.decimals),
    targetJobId: readAlias(INPUT_ALIASES.targetJobId, 80),
    targetCreationTxHash: readAlias(INPUT_ALIASES.targetCreationTxHash, 80),
    targetAcceptanceTxHash: readAlias(INPUT_ALIASES.targetAcceptanceTxHash, 80),
    targetBuyer: readAlias(INPUT_ALIASES.targetBuyer, 80),
    targetCreatedAt: readAlias(INPUT_ALIASES.targetCreatedAt, 80),
    targetAcceptedAt: readAlias(INPUT_ALIASES.targetAcceptedAt, 80),
    jobDescription: readAlias(INPUT_ALIASES.jobDescription),
  };
}

// Public references, exact transaction evidence, and bounded event-hint
// resolution all end at the same `chain.verifyTargetOrder`, which is what
// actually establishes eligibility.
// What direct evidence requires.
const DIRECT_EVIDENCE_FIELDS = Object.freeze([
  "targetJobId",
  "targetCreationTxHash",
  "targetAcceptanceTxHash",
  "targetBuyer",
  "jobDescription",
]);

// What signals the caller meant to use it: on-chain identity only, never a field
// whose aliases are ordinary request metadata.
//
// jobDescription is excluded because it is descriptive text and its
// `description` alias appears in unrelated envelopes. targetBuyer is excluded
// for the same reason, and it is the sharper case: its aliases include plain
// `buyer` and `buyerWallet`, so a perfectly good public-reference request that
// happened to name its buyer was rerouted into direct mode and refused
// direct_evidence_incomplete for hashes it never needed to send, with its
// taskReference sitting unread.
//
// Both stay required by DIRECT_EVIDENCE_FIELDS. Requiring a field and inferring
// intent from it are different jobs. Transaction mode is selected only by an
// actual transaction hash; a job id without hashes belongs to the event-hint
// resolver below.
const DIRECT_EVIDENCE_SIGNALS = Object.freeze([
  "targetCreationTxHash",
  "targetAcceptanceTxHash",
]);

function directEvidenceIntent(input) {
  return DIRECT_EVIDENCE_SIGNALS.some((field) => Boolean(input[field]));
}

const EVENT_HINT_FIELDS = Object.freeze([
  "targetJobId",
  "targetCreatedAt",
  "jobDescription",
]);
const EVENT_HINT_SIGNALS = Object.freeze([
  "targetJobId",
  "targetCreatedAt",
  "targetAcceptedAt",
]);

function eventHintEvidenceIntent(input) {
  return EVENT_HINT_SIGNALS.some((field) => Boolean(input[field]));
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
    "target_block_calibration_failed",
    "target_block_lookup_failed",
    "target_event_lookup_failed",
    "target_event_search_window_invalid",
    "transaction_unconfirmed",
    "transaction_lookup_unavailable",
    "target_job_status_unavailable",
  ].includes(error?.code);
}

function declineWith(res, reason, extra = {}) {
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
  let runtimePolicyResolver = dependencies.policyResolver;
  const taskFetcher = dependencies.taskFetcher || fetchOkxTaskPage;
  const publicTaskEvidenceAvailable = dependencies.publicTaskEvidenceAvailable
    ?? MARKETPLACE.publicTaskEvidenceAvailable;
  const limiter = dependencies.limiter || createRateLimiter();
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
  const getPolicyResolver = () => (runtimePolicyResolver ||= createCoveragePolicyResolver(dependencies));

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

    const limited = await enforceRateLimit(req, res, limiter, {
      scope: "coverage-preflight",
      subject: req.body?.targetAgent || req.query?.targetAgent || "",
      limit: 30,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);

    const input = readInput(req);
    const directEvidence = directEvidenceIntent(input);
    const eventHintEvidence = !directEvidence && eventHintEvidenceIntent(input);
    const onchainEvidence = directEvidence || eventHintEvidence;
    const evidenceMode = directEvidence
      ? "verified_onchain_evidence"
      : eventHintEvidence
        ? "resolved_onchain_events"
        : "public_task_reference";
    // Declines carry the mode too. A caller debugging a refusal otherwise cannot
    // tell whether the evidence they supplied was the evidence that was used.
    const decline = (response, reason, extra = {}) => declineWith(response, reason, { evidenceMode, ...extra });
    if (!input.targetAgent && !input.taskReference && !onchainEvidence) {
      return sendJson(res, 200, {
        ok: true,
        service: "PolicyPool Coverage Preflight",
        charged: false,
        description: "Resolve an accepted OKX.AI job into a verified, coverage-ready paid request, from a public task reference or from on-chain evidence you supply.",
        modes: [
          {
            mode: "public_task_reference",
            required: ["targetAgent", "taskReference"],
            available: publicTaskEvidenceAvailable,
            ...(publicTaskEvidenceAvailable
              ? {}
              : { unavailableReason: MARKETPLACE.publicTaskEvidenceUnavailableReason }),
            note: "OKX.AI stopped publishing the acceptance timeline and on-chain task id on the public task page, so a task URL or bare task id can no longer be bound to its job.",
          },
          {
            mode: "verified_onchain_evidence",
            required: ["targetAgent", ...DIRECT_EVIDENCE_FIELDS],
            // Reconciliation for an enrolled v0.4 A2A covenant reads the public
            // task page, which is withdrawn, so such a covenant could be sold and
            // then never settle. The mode is refused there rather than quoted.
            notAvailableFor: ONCHAIN_EVIDENCE_LIMITATIONS,
            available: true,
            note: "You supply the exact X Layer transactions; PolicyPool verifies them against the task escrow rather than trusting them. targetBuyer must be the wallet that created the target job, and must be the payer on the paid call. The job description is checked against the policy's published scope but is not proved on chain.",
          },
          {
            mode: "resolved_onchain_events",
            required: ["targetAgent", ...EVENT_HINT_FIELDS],
            optional: ["targetAcceptedAt", "targetBuyer"],
            notAvailableFor: ONCHAIN_EVIDENCE_LIMITATIONS,
            available: true,
            note: "You supply the job id and an approximate creation time. PolicyPool treats the time as an untrusted search hint, derives both transaction hashes and the buyer from indexed X Layer escrow events, and then runs the same verifier. Add targetAcceptedAt only when the provider accepted more than 30 minutes after creation.",
          },
        ],
        ...targetOptions(),
      });
    }
    if (!input.targetAgent) {
      return sendJson(res, 400, {
        ok: false,
        error: "target_agent_required",
        charged: false,
        ...targetOptions(),
      });
    }
    // A partially filled direct request must say which field is missing rather
    // than fall through to a generic refusal the caller cannot act on.
    if (directEvidence) {
      const missing = DIRECT_EVIDENCE_FIELDS.filter((field) => !input[field]);
      if (missing.length > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: "direct_evidence_incomplete",
          charged: false,
          missing,
          required: ["targetAgent", ...DIRECT_EVIDENCE_FIELDS],
        });
      }
    }
    if (eventHintEvidence) {
      const missing = EVENT_HINT_FIELDS.filter((field) => !input[field]);
      if (missing.length > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: "event_hint_evidence_incomplete",
          charged: false,
          missing,
          required: ["targetAgent", ...EVENT_HINT_FIELDS],
          optional: ["targetAcceptedAt", "targetBuyer"],
        });
      }
    }
    if (input.requestedCoverageAtomic < BigInt(COVERAGE.minAtomic)) {
      return decline(res, "requested_coverage_below_minimum");
    }

    let policy;
    let policySource;
    try {
      ({ policy, source: policySource } = await getPolicyResolver().resolve(
        input.targetAgent,
        input.targetServiceId,
      ));
    } catch (error) {
      if (error instanceof UniversalPolicyError) {
        return sendJson(res, error.status, { ok: false, error: error.code, charged: false });
      }
      return sendJson(res, 503, { ok: false, error: "coverage_policy_resolution_failed", charged: false });
    }
    if (!policy) {
      return sendJson(res, 422, {
        ok: false,
        error: "target_policy_not_registered",
        charged: false,
        ...targetOptions(),
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
    if (!onchainEvidence && !publicTaskEvidenceAvailable) {
      return sendJson(res, 422, {
        ok: false,
        error: "okx_task_timeline_unavailable",
        charged: false,
        evidenceMode,
        requiredDirectEvidence: ["targetAgent", ...DIRECT_EVIDENCE_FIELDS],
        resolvedEventEvidence: {
          required: ["targetAgent", ...EVENT_HINT_FIELDS],
          optional: ["targetAcceptedAt", "targetBuyer"],
        },
        ...targetOptions(),
      });
    }
    if (!input.taskReference && !onchainEvidence) {
      return sendJson(res, 400, { ok: false, error: "okx_task_reference_required", charged: false });
    }

    // An enrolled v0.4 A2A covenant is reconciled through a2aObservation, which
    // fetches the public task page whenever the covenant carries a reference and
    // otherwise falls back to chain. evaluateGuard requires that reference for
    // these policies, so a direct-evidence purchase would either be refused at
    // the guard or, if the reference were supplied, store the field that forces
    // a page fetch which now always throws. The covenant would be paid for and
    // then never release or advance to payout. Refuse to sell what cannot be
    // settled, rather than quote it and discover this after the money moves.
    if (onchainEvidence && policy.onchainPolicyId && policy.serviceType === "A2A") {
      return decline(res, "direct_evidence_unavailable_for_universal_a2a", {
        policy: {
          agentId: policy.agentId,
          agentName: policy.agentName,
          serviceType: policy.serviceType,
          coverableNow: false,
        },
      });
    }

    let task = null;
    if (!onchainEvidence) {
      try {
        task = await taskFetcher(input.taskReference);
      } catch (error) {
        if (error instanceof OkxTaskPageError) {
          return sendJson(res, 422, { ok: false, error: error.code, charged: false });
        }
        return sendJson(res, 502, { ok: false, error: "okx_task_fetch_failed", charged: false });
      }
    }

    // On-chain evidence modes change only where the transaction hashes come
    // from, never what is done with them. Every mode ends at the same verifier,
    // which reads the escrow logs and binds buyer, job, provider wallet, agent
    // id, asset, amount, service type and accepted-service hash. Nothing the
    // caller asserts is taken on trust: a wrong buyer wallet, a forged hash, a
    // reverted transaction, or a job that is not accepted all fail there.
    // Never carried in either on-chain mode. Storing a reference on the covenant
    // is what makes a2aObservation fetch the withdrawn page instead of falling
    // back to chain, so these covenants deliberately have none.
    const publicTaskReference = task?.publicTaskId || null;
    const jobId = onchainEvidence ? input.targetJobId : task.jobId;
    const jobDescription = onchainEvidence ? input.jobDescription : task.description;
    let evidence;
    let targetOrder;
    try {
      evidence = directEvidence
        ? {
          source: "buyer_supplied_transactions_verified_against_x_layer",
          creationTxHash: input.targetCreationTxHash,
          acceptanceTxHash: input.targetAcceptanceTxHash,
          buyer: input.targetBuyer,
        }
        : eventHintEvidence
          ? {
            source: "x_layer_task_escrow_events_resolved_from_untrusted_time_hints",
            ...await getChain().resolveTargetOrderEvidenceFromHints({
              jobId,
              createdAt: input.targetCreatedAt,
              acceptedAt: input.targetAcceptedAt,
            }),
          }
        // No `source` here on purpose. The response below already sets a
        // human-readable one before spreading this object, so adding a key would
        // overwrite an established field value rather than add to it. Only
        // on-chain modes need to say something different.
        : await getChain().resolveTargetOrderEvidence({
          jobId,
          createdAt: task.openedAt,
          acceptedAt: task.acceptedAt,
        });
      targetOrder = await getChain().verifyTargetOrder({
        jobId,
        creationTxHash: evidence.creationTxHash,
        acceptanceTxHash: evidence.acceptanceTxHash,
        buyer: eventHintEvidence && input.targetBuyer ? input.targetBuyer : evidence.buyer,
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
      targetJobId: jobId,
      targetCreationTxHash: evidence.creationTxHash,
      targetAcceptanceTxHash: evidence.acceptanceTxHash,
      jobDescription,
      requestedCoverageAtomic: input.requestedCoverageAtomic,
      targetServiceId: input.targetServiceId,
      targetTaskReference: publicTaskReference,
    };
    const guard = evaluateGuard(guardInput, policy);
    if (guard.verdict !== "ALLOW") return decline(res, guard.reason, { task, targetOrder });

    const providerFunded = Boolean(policy.onchainPolicyId);
    let reserveBalanceAtomic = 0n;
    let committedAtomic = 0n;
    let availableAtomic = 0n;
    if (!providerFunded) {
      try {
        const [reserveBalance, liabilityStats] = await Promise.all([
          getChain().getReserveBalance(),
          getLedger().stats(),
        ]);
        reserveBalanceAtomic = reserveBalance;
        committedAtomic = BigInt(liabilityStats.committedAtomic);
        availableAtomic = reserveBalanceAtomic > committedAtomic
          ? reserveBalanceAtomic - committedAtomic
          : 0n;
      } catch {
        return sendJson(res, 503, { ok: false, error: "coverage_capacity_unavailable", charged: false });
      }
    }
    const policyCapacityAtomic = providerFunded
      ? BigInt(policy.providerAvailableBondAtomic || 0)
      : availableAtomic;
    // Same five bounds and the same minimum as before; the resolver additionally
    // reports which of them produced the number, which is what a buyer needs to
    // understand why their requested cap was or was not honoured.
    const { approvedCapAtomic: coverageCapAtomic, capBoundReason } = resolveCoverageCap({
      requestedAtomic: input.requestedCoverageAtomic,
      targetJobValueAtomic: targetOrder.amountAtomic,
      policyCapAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic),
      capacityAtomic: policyCapacityAtomic,
      globalMaxAtomic: COVERAGE.maxAtomic,
      providerFunded,
    });
    if (coverageCapAtomic < BigInt(COVERAGE.minAtomic)) {
      return decline(res, policy.providerAvailableBondAtomic
        ? "insufficient_provider_bond_capacity"
        : "insufficient_uncommitted_reserve", {
        task,
        reserve: {
          balanceUSDT: formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
          committedUSDT: formatUsdtAtomic(committedAtomic, PAYMENT.decimals),
          availableUSDT: formatUsdtAtomic(availableAtomic, PAYMENT.decimals),
        },
      });
    }

    const acceptanceMs = Date.parse(targetOrder.acceptedAt);
    const deadlineMs = policy.clockMode === "policypool_relay"
      ? null
      : acceptanceMs + policy.slaSeconds * 1000;
    if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs <= now())) {
      return decline(res, "registered_policy_sla_already_elapsed", { task, targetOrder });
    }
    const enrollmentDeadlineMs = acceptanceMs + policy.enrollmentWindowSeconds * 1000;
    if (!Number.isFinite(enrollmentDeadlineMs) || enrollmentDeadlineMs <= now()) {
      return decline(res, "coverage_enrollment_window_closed", { task, targetOrder });
    }

    const requestBody = {
      targetAgent: `${policy.agentName}#${policy.agentId}`,
      targetServiceId: policy.serviceIds[0],
      targetJobId: jobId,
      targetCreationTxHash: evidence.creationTxHash,
      targetAcceptanceTxHash: evidence.acceptanceTxHash,
      // Omitted entirely in on-chain modes rather than sent empty: there is no
      // public task reference to record, and a blank one would read as a lookup
      // that was attempted and returned nothing.
      ...(publicTaskReference ? { targetTaskReference: publicTaskReference } : {}),
      jobDescription,
      requestedCoverageUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
    };

    let quote;
    try {
      quote = await getQuoteService().issue({
        requestBody,
        buyer: targetOrder.buyer,
        policyHash: policy.policyHash,
        source: "verified_preflight",
        deadline: new Date(deadlineMs === null
          ? enrollmentDeadlineMs
          : Math.min(deadlineMs, enrollmentDeadlineMs)).toISOString(),
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
      version: providerFunded ? "0.4.0" : "0.3.0",
      eligible: true,
      charged: false,
      generatedAt: new Date(now()).toISOString(),
      // Null in either on-chain mode rather than a synthesised stand-in: there
      // was no marketplace page in these flows, and inventing one would
      // misrepresent where the evidence came from. `evidenceMode` says which
      // path ran.
      task,
      evidenceMode,
      // Where the description that satisfied the policy's scope keywords came
      // from. On the public path it is the marketplace page's own text. In
      // either on-chain mode the buyer writes it, and the marketplace publishes
      // no authenticated mapping from an accepted order to a listed service id,
      // so nothing here proves the covered work is the work the policy describes.
      // The paid endpoint has always accepted a caller-written description on
      // this path; stating the difference is the honest response to that, and
      // claiming a service binding that does not exist would not be.
      scopeEvidence: onchainEvidence
        ? "buyer_declared_description_matched_registered_policy"
        : "public_task_description_matched_registered_policy",
      ...(onchainEvidence
        ? {
          scopeLimitation: "The job description is supplied by you, not read from the marketplace. OKX publishes no authenticated mapping from an accepted order to a listed service id, so this quote binds the buyer, job, provider, agent, asset, amount and service type on chain, but takes the described work on trust.",
        }
        : {}),
      // Same target, buyer, policy and cap always produce the same id, so a
      // client that retries after a timeout can tell it is looking at one
      // attempt rather than two. An identity, not a lock: idempotent settlement
      // is a separate change and is not claimed here.
      coverageAttemptId: `ppa-${sha256([
        String(targetOrder.buyer).toLowerCase(),
        String(jobId).toLowerCase(),
        String(policy.policyHash),
        coverageCapAtomic.toString(),
      ].join("|")).slice(0, 24)}`,
      // Paying this fee straight to the HTTP endpoint settles correctly but is
      // invisible to OKX, so it never becomes a sale for the listed agent.
      // Buyers were finding that out only after paying.
      marketplace: {
        requiredForMarketplaceAttribution: true,
        agentId: MARKETPLACE.agentId,
        serviceId: MARKETPLACE.serviceId,
        agentUrl: MARKETPLACE.agentUrl,
        paymentRoute: "OKX_MARKETPLACE_TASK",
        genericEndpointPaymentCountsAsMarketplaceSale: false,
        note: "Coverage bought directly from this endpoint is a valid covenant but is not recorded as an OKX marketplace sale. Buy through the listed service to attribute it.",
      },
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
        registrySource: policySource,
      },
      evidence: {
        source: "OKX.AI public task page plus X Layer task escrow events",
        ...evidence,
        verifiedTargetOrder: targetOrder,
      },
      coverage: {
        deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
        clockState: deadlineMs === null ? "pending_provider_relay_start" : "started_at_verified_acceptance",
        enrollmentClosesAt: new Date(enrollmentDeadlineMs).toISOString(),
        capAtomic: coverageCapAtomic.toString(),
        capUSDT: formatUsdtAtomic(coverageCapAtomic, PAYMENT.decimals),
        serviceFeeUSDT: formatUsdtAtomic(PAYMENT.amountAtomic, PAYMENT.decimals),
        // Three different amounts appear in this response and testers read them
        // as interchangeable. These name each one's role, say which bound
        // produced the cap, and state the fee against the maximum payout in a
        // sentence. Existing fields above are unchanged.
        ...coverageEconomics({
          requestedAtomic: input.requestedCoverageAtomic,
          targetJobValueAtomic: targetOrder.amountAtomic,
          approvedCapAtomic: coverageCapAtomic,
          capBoundReason,
          serviceFeeAtomic: PAYMENT.amountAtomic,
          decimals: PAYMENT.decimals,
          symbol: PAYMENT.symbol,
        }),
        fundingSource: providerFunded ? "provider_first_loss_bond" : "shared_reserve",
        providerBondAvailableUSDT: providerFunded
          ? formatUsdtAtomic(policyCapacityAtomic, PAYMENT.decimals)
          : null,
        reserveBalanceUSDT: providerFunded
          ? null
          : formatUsdtAtomic(reserveBalanceAtomic, PAYMENT.decimals),
        committedUSDT: providerFunded ? null : formatUsdtAtomic(committedAtomic, PAYMENT.decimals),
        availableUSDT: providerFunded ? null : formatUsdtAtomic(availableAtomic, PAYMENT.decimals),
        sharedReserveUsed: !providerFunded,
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
