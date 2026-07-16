import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { universalConfiguration } from "./lib/universal-config.js";
import { sendJson } from "./lib/utils.js";

function publicPolicy(record) {
  return {
    enrollmentId: record.policyId,
    onchainPolicyId: record.onchainPolicyId || null,
    status: record.status,
    providerWallet: record.providerWallet,
    agentId: record.agentId,
    agentName: record.agentName,
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    serviceType: record.serviceType,
    serviceFingerprint: record.serviceFingerprint,
    servicePublicUrl: record.servicePublicUrl,
    scope: record.scope,
    terms: record.terms,
    registrationTransactionHash: record.registrationTransactionHash || null,
    activatedAt: record.activatedAt || null,
    coverability: "requires_live_quote_time_owner_fingerprint_policy_and_bond_revalidation",
  };
}

export function createUniversalManifestHandler(dependencies = {}) {
  const configuration = dependencies.configuration || universalConfiguration();
  let runtimeStore = dependencies.store;
  const getStore = () => (runtimeStore ||= createProviderPolicyStore());
  const now = dependencies.now || (() => Date.now());

  return async function handler(req, res) {
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    if (!configuration.ready) {
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        enabled: false,
        productionVersion: "0.3.0",
        state: "feature_gated",
        missing: configuration.missing || [],
      });
    }
    const [policies, demand] = await Promise.all([
      getStore().listPolicies(250),
      getStore().listDemand(250),
    ]);
    return sendJson(res, 200, {
      ok: true,
      version: "0.4.0",
      enabled: true,
      generatedAt: new Date(now()).toISOString(),
      definition: "Any OKX.AI provider can opt in by publishing objective terms and bonding first-loss capital.",
      contracts: {
        policyRegistry: configuration.policyRegistry,
        providerBondVault: configuration.bondVault,
        coverageManager: configuration.coverageManager,
      },
      endpoints: {
        enrollment: "/api/provider-enrollment",
        providerBond: "/api/provider-bond",
        demandSignal: "/api/coverage-demand",
        preflight: "/api/coverage-preflight",
        issuance: "/api/covered-job-receipt",
        providerRelay: "/api/provider-relay",
        reconciliation: "/api/reconcile-universal",
      },
      safety: {
        unknownProviders: "record_demand_without_charge",
        firstLoss: "provider_bond",
        sharedReserveForNewProviders: false,
        listingFingerprintChange: "fail_closed_until_provider_reenrolls",
        payoutBases: ["net_loss", "provider_bonded_sla_credit"],
        clocks: ["verified_acceptance", "policypool_relay"],
        relayAuthorization: "short_lived_covenant_bound_single_request_grant",
        publicEndpoints: "redis_rate_limited_with_fail_closed_scope_validation",
        providerProjection: "last_confirmed_enrollment_not_a_live_coverability_guarantee",
        quoteTimeRevalidation: ["agent_owner", "service_fingerprint", "policy_state", "policy_expiry", "available_bond"],
        reservePayout: "operator_approved_until_settlement_contract_audit",
      },
      providers: policies.filter((record) => record.status === "active").map(publicPolicy),
      enrollment: {
        signedPolicies: policies.length,
        activePolicies: policies.filter((record) => record.status === "active").length,
        recordedDemandSignals: demand.length,
      },
      operations: {
        reconciliation: "managed_minute_scheduler_with_idempotent_onchain_state_recovery",
        automaticTransitions: ["relay_clock_start", "release", "payout_due", "unstarted_expiry"],
        payoutSettlement: "operator_approved_with_independent_recovery_evidence",
      },
      okxListing: {
        endpointUnchanged: true,
        listingFieldUpdateRequired: false,
      },
    });
  };
}

export default createUniversalManifestHandler();
