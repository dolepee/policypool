import assert from "node:assert/strict";
import { createUniversalManifestHandler } from "../api/universal-manifest.js";
import { MemoryProviderPolicyStore } from "../api/lib/provider-policy-store.js";
import { PolicyPoolClient } from "../sdk/policypool-client.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const configuration = {
  ready: true,
  policyRegistry: "0x1000000000000000000000000000000000000001",
  bondVault: "0x2000000000000000000000000000000000000002",
  evidenceVerifier: "0x2500000000000000000000000000000000000002",
  recoveryEvidenceVerifier: "0x2600000000000000000000000000000000000002",
  coverageManager: "0x3000000000000000000000000000000000000003",
  evidenceThreshold: 3,
  recoveryEvidenceThreshold: 3,
};
const store = new MemoryProviderPolicyStore();
const policy = await store.savePolicy({
  status: "active",
  createdAt: "2026-07-16T12:00:00.000Z",
  activatedAt: "2026-07-16T12:01:00.000Z",
  providerWallet: "0x4000000000000000000000000000000000000004",
  agentId: "3808",
  agentName: "WARDEN",
  serviceId: "33461",
  serviceName: "Agent Endpoint Security Audit",
  serviceType: "A2MCP",
  serviceFingerprint: `0x${"11".repeat(32)}`,
  servicePublicUrl: "https://www.okx.ai/agents/3808",
  scope: { deliveryPromise: "Audit", objectiveBreach: "No result in 300 seconds", coveredKeywords: ["audit"] },
  terms: { maxCapAtomic: "500000", payoutBasis: 1, clockMode: 1 },
  onchainPolicyId: `0x${"22".repeat(32)}`,
  registrationTransactionHash: `0x${"33".repeat(32)}`,
});
await store.updatePolicy(policy.policyId, { status: "active" });
await store.recordDemand({
  createdAt: "2026-07-16T12:02:00.000Z",
  agentId: "9999",
  serviceId: "8888",
  status: "provider_enrollment_required",
});
const handler = createUniversalManifestHandler({
  configuration,
  store,
  now: () => Date.parse("2026-07-16T13:00:00.000Z"),
});
const response = await callHandler(handler, { method: "GET", url: "/api/universal-manifest" });
assert.equal(response.statusCode, 200);
assert.equal(response.json().enabled, true);
assert.equal(response.json().providers.length, 1);
assert.equal(response.json().providers[0].signature, undefined);
assert.equal(
  response.json().providers[0].coverability,
  "requires_live_quote_time_owner_fingerprint_policy_and_bond_revalidation",
);
assert.equal(response.json().enrollment.recordedDemandSignals, 1);
assert.equal(response.json().safety.sharedReserveForNewProviders, false);
assert.equal(response.json().safety.evidenceThreshold, 3);
assert.equal(response.json().safety.recoveryEvidenceThreshold, 3);
assert.equal(response.json().safety.settlementEvidenceMaxAgeSeconds, 600);
assert.equal(response.json().safety.settlementRequiresTerminalRecovery, true);
assert.equal(response.json().safety.settlementChallengePeriodSeconds, 86_400);
assert.equal(response.json().safety.provisionalBreachCanBeCorrectedByOnTimeCompletion, true);
assert.equal(response.json().safety.singleRelayerAuthority, false);
assert.equal(response.json().safety.relayAuthorization, "short_lived_covenant_bound_single_request_grant");
assert.ok(response.json().operations.automaticTransitions.includes("payout_due"));

const requests = [];
const client = new PolicyPoolClient({
  origin: "https://policy.test",
  fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
await client.preflight({
  agentId: 3808,
  serviceId: 33461,
  taskReference: "https://www.okx.ai/tasks/405668",
  requestedCoverageUSDT: "0.5",
});
assert.equal(requests[0].url, "https://policy.test/api/coverage-preflight");
assert.equal(requests[0].body.targetServiceId, "33461");

console.log("PolicyPool universal manifest passed: public contract, safe provider projection, demand totals, and SDK request shape.");
