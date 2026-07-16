import { COVERAGE, PAYMENT, XLAYER } from "./lib/config.js";
import { listPublishedPolicies, policyCoverageCapAtomic } from "./lib/policy-registry.js";
import { formatUsdtAtomic, sendJson } from "./lib/utils.js";
import { createUniversalManifestHandler } from "./universal-manifest.js";

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
} = {}) {
  return async function handler(req, res) {
    if (req.query?.surface === "universal") return universalHandler(req, res);
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return sendJson(res, 200, {
      ok: true,
      protocol: "PolicyPool Agent Coverage",
      version: "0.3.0",
      generatedAt: new Date(now()).toISOString(),
      agent: {
        id: "4674",
        name: "PolicyPool",
        marketplaceUrl: "https://www.okx.ai/agents/4674",
      },
      service: {
        id: "33290",
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
        minimumAtomic: COVERAGE.minAtomic,
        maximumAtomic: COVERAGE.maxAtomic,
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
      states: {
        coverage: ["active", "released", "payout_due", "paid"],
        terminal: ["released", "paid"],
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
