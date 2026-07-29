import { createChainService } from "./lib/chain.js";
import {
  COVERAGE,
  EVIDENCE_RESOLVER,
  MARKETPLACE,
  ONCHAIN_EVIDENCE_LIMITATIONS,
  PAYMENT,
  XLAYER,
} from "./lib/config.js";
import { createLedger } from "./lib/ledger.js";
import { listPublishedPolicies, policyCoverageCapAtomic } from "./lib/policy-registry.js";
import { formatUsdtAtomic, sendJson } from "./lib/utils.js";
import { createUniversalManifestHandler } from "./universal-manifest.js";

const CAPACITY_READ_TIMEOUT_MS = 2_500;

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("capacity_read_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// The advertised ceiling has to be a cap we would actually issue. The reserve
// solvency invariant refuses any quote where committed + cap exceeds the
// reserve, so publishing the configured maximum while the uncommitted reserve
// sits below it advertises a cap that declines on request. Publish the smaller
// of the two and keep the configured value visible beside it.
async function sellableCeilingAtomic({
  ledger,
  chain,
  configuredMinimumAtomic = COVERAGE.minAtomic,
  configuredMaximumAtomic = COVERAGE.maxAtomic,
  timeoutMs = CAPACITY_READ_TIMEOUT_MS,
}) {
  try {
    const minimum = BigInt(configuredMinimumAtomic);
    const configured = BigInt(configuredMaximumAtomic);
    if (minimum < 0n || configured < minimum) throw new Error("configured_capacity_invalid");
    const activeLedger = ledger || createLedger();
    const activeChain = chain || createChainService();
    const [stats, balance] = await withTimeout(Promise.all([
      activeLedger.stats(),
      activeChain.getReserveBalance(),
    ]), timeoutMs);
    const committed = BigInt(stats.committedAtomic);
    const reserve = BigInt(balance);
    if (committed < 0n || reserve < 0n) throw new Error("capacity_read_invalid");
    const available = reserve > committed ? reserve - committed : 0n;
    return {
      minimumAtomic: minimum,
      maximumAtomic: available < configured ? available : configured,
      status: "verified",
    };
  } catch {
    // Discovery must remain available during an RPC or ledger outage, but it
    // must not advertise unverified capacity. Quote issuance performs its own
    // authoritative solvency check and remains the final decision point.
    return {
      minimumAtomic: 0n,
      maximumAtomic: 0n,
      status: "unavailable",
    };
  }
}

function providerManifest(policy) {
  return {
    agentId: policy.agentId,
    agentName: policy.agentName,
    serviceIds: policy.serviceIds,
    serviceName: policy.serviceName,
    serviceType: policy.serviceType,
    coverageStatus: policy.coverageStatus || "active",
    coverableNow: !policy.coverageStatus || policy.coverageStatus === "active",
    policyHash: policy.policyHash,
    slaSeconds: policy.slaSeconds,
    enrollmentWindowSeconds: policy.enrollmentWindowSeconds,
    maxCoverageAtomic: policyCoverageCapAtomic(policy, COVERAGE.maxAtomic).toString(),
    clockSource: policy.clockSource || "verified_acceptance_block",
    processingStart: policy.processingStart || "verified target-job acceptance",
    exclusions: policy.exclusions || [],
  };
}

export function createManifestHandler({
  now = () => Date.now(),
  universalHandler = createUniversalManifestHandler(),
  ledger: injectedLedger,
  chain: injectedChain,
  configuredMinimumAtomic = COVERAGE.minAtomic,
  configuredMaximumAtomic = COVERAGE.maxAtomic,
  capacityReadTimeoutMs = CAPACITY_READ_TIMEOUT_MS,
} = {}) {
  return async function handler(req, res) {
    if (req.query?.surface === "universal") return universalHandler(req, res);
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const capacity = await sellableCeilingAtomic({
      ledger: injectedLedger,
      chain: injectedChain,
      configuredMinimumAtomic,
      configuredMaximumAtomic,
      timeoutMs: capacityReadTimeoutMs,
    });
    const acceptingNewCoverage = capacity.status === "verified"
      && capacity.maximumAtomic >= capacity.minimumAtomic;
    return sendJson(res, 200, {
      ok: true,
      protocol: "PolicyPool Agent Coverage",
      version: "0.3.0",
      generatedAt: new Date(now()).toISOString(),
      agent: {
        id: MARKETPLACE.agentId,
        name: "PolicyPool",
        marketplaceUrl: MARKETPLACE.agentUrl,
      },
      service: {
        id: MARKETPLACE.serviceId,
        name: "Covered Job Receipt",
        type: "A2MCP",
        priceAtomic: PAYMENT.amountAtomic,
        priceUSDT: formatUsdtAtomic(PAYMENT.amountAtomic, PAYMENT.decimals),
        endpoint: "https://policypool.vercel.app/api/covered-job-receipt",
        preflight: "https://policypool.vercel.app/api/coverage-preflight",
        ledger: "https://policypool.vercel.app/api/coverage-ledger",
        status: "https://policypool.vercel.app/api/coverage-status?receiptId={receiptId}",
      },
      payment: {
        protocol: "OKX Agent Payments Protocol",
        x402Version: 2,
        scheme: "exact",
        network: XLAYER.network,
        chainId: XLAYER.id,
        asset: PAYMENT.asset,
        symbol: PAYMENT.symbol,
        decimals: PAYMENT.decimals,
        payTo: PAYMENT.payTo,
      },
      coverage: {
        reserveWallet: COVERAGE.reserveWallet,
        minimumAtomic: capacity.minimumAtomic.toString(),
        maximumAtomic: capacity.maximumAtomic.toString(),
        maximumUSDT: formatUsdtAtomic(capacity.maximumAtomic, PAYMENT.decimals),
        minimumConfiguredAtomic: configuredMinimumAtomic,
        maximumConfiguredAtomic: configuredMaximumAtomic,
        maximumBasis: capacity.status === "verified"
          ? "lesser_of_configured_ceiling_and_uncommitted_reserve"
          : "unavailable_fail_closed",
        capacityStatus: capacity.status,
        acceptingNewCoverage,
        objectiveBreachRules: ["accepted_job_still_undelivered_after_deadline"],
        reserveSettlement: "operator_approved_and_independently_verified",
      },
      quote: {
        ttlSeconds: Number(process.env.POLICYPOOL_QUOTE_TTL_SECONDS || 600),
        signed: true,
        authoritativeAtSettlement: true,
        fullEligibilityRecheckedAtSettlement: true,
        transport: ["resource_url_query", "x402_accepted_requirements", "request_body"],
        bodylessFallback: "exactly_one_open_quote_bound_to_verified_payer",
        ambiguityBehavior: "fail_closed_without_settlement",
      },
      input: {
        appliesTo: "https://policypool.vercel.app/api/covered-job-receipt",
        required: [
          "targetAgent",
          "targetJobId",
          "targetCreationTxHash",
          "targetAcceptanceTxHash",
          "jobDescription",
        ],
        optional: ["requestedCoverageUSDT", "quoteId"],
        legacyFullBodyAccepted: true,
      },
      // The preflight is advertised as its own endpoint and does not share the
      // paid service's contract. It accepts a job by public marketplace
      // reference, exact transactions, or bounded event-hint resolution.
      preflightInput: {
        appliesTo: "https://policypool.vercel.app/api/coverage-preflight",
        modes: {
          publicReference: {
            required: ["targetAgent", "taskReference"],
            available: MARKETPLACE.publicTaskEvidenceAvailable,
            ...(MARKETPLACE.publicTaskEvidenceAvailable
              ? {}
              : { unavailableReason: MARKETPLACE.publicTaskEvidenceUnavailableReason }),
          },
          directEvidence: {
            available: true,
            notAvailableFor: ONCHAIN_EVIDENCE_LIMITATIONS,
            required: [
              "targetAgent",
              "targetJobId",
              "targetCreationTxHash",
              "targetAcceptanceTxHash",
              "targetBuyer",
              "jobDescription",
            ],
          },
          resolvedEventEvidence: {
            available: true,
            notAvailableFor: ONCHAIN_EVIDENCE_LIMITATIONS,
            required: [
              "targetAgent",
              "targetJobId",
              "targetCreatedAt",
              "jobDescription",
            ],
            optional: ["targetAcceptedAt", "targetBuyer"],
            trustModel: "time_values_are_search_hints_only; indexed_task_escrow_events_supply_the_buyer_and_transaction_hashes",
            creationHintRadiusBlocks: EVIDENCE_RESOLVER.creationHintRadiusBlocks,
            maximumAutomaticAcceptanceScanBlocks: EVIDENCE_RESOLVER.maxAutomaticAcceptanceScanBlocks,
          },
        },
        optional: ["requestedCoverageUSDT", "targetServiceId"],
        charged: false,
      },
      states: {
        coverage: ["active", "declined", "released", "payout_due", "paid"],
        terminal: ["declined", "released", "paid"],
        payoutExecution: "never_automatic_in_v0.3",
      },
      automation: {
        quoteAndIssuance: "automatic_after_verified_payment_authorization",
        reconciliation: "scheduled_with_idempotent_state_transitions",
        notifications: "operator_alerts_on_transitions_and_failures",
        reservePayout: "operator_approved",
      },
      providers: listPublishedPolicies().map(providerManifest),
    });
  };
}

export default createManifestHandler();
