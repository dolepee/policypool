import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryProviderPolicyStore } from "../api/lib/provider-policy-store.js";
import {
  createProviderRelay,
  ProviderRelayError,
  verifyProviderRelayReceipt,
} from "../api/lib/provider-relay.js";

const signer = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca3a545d9ef0ad14f60a17bcaef0aee4170b4818c50675",
);
const relayVerifier = "0x9000000000000000000000000000000000000009";
const policy = {
  agentId: "3808",
  serviceIds: ["33461"],
  serviceType: "A2MCP",
  serviceEndpoint: "https://warden.example/audit",
  policyHash: `onchain:0x${"11".repeat(32)}`,
  slaSeconds: 300,
};
const resolver = { async resolve() { return structuredClone(policy); } };
const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
const store = new MemoryProviderPolicyStore();
const targetJobId = `0x${"44".repeat(32)}`;
const grant = {
  grantId: "pprg-test",
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
};
const grantService = { resolve(token) { assert.equal(token, "signed-relay-grant"); return grant; } };
let elapsed = 0;
let responseStatus = 402;
const fetchImpl = async (url, options) => {
  assert.equal(url, policy.serviceEndpoint);
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
  elapsed += 250;
  const headers = responseStatus === 402
    ? { "content-type": "application/json", "payment-required": "challenge" }
    : { "content-type": "application/json", "payment-response": "settled" };
  return new Response(JSON.stringify({ status: responseStatus === 402 ? "payment_required" : "audit_complete" }), {
    status: responseStatus,
    headers,
  });
};
const relay = createProviderRelay({
  policyResolver: resolver,
  store,
  fetchImpl,
  resolveHost,
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
  now: () => Date.parse("2026-07-16T12:00:00.000Z") + elapsed,
});

const challenge = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
}, {});
assert.equal(challenge.upstream.status, 402);
assert.equal(challenge.receipt.clock, null);
assert.equal(challenge.receipt.request.paymentAuthorizationPresent, false);
assert.equal(challenge.receipt.signer, signer.address);

responseStatus = 200;
const delivered = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  endpoint: policy.serviceEndpoint,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
}, { "payment-signature": "signed-provider-payment" });
assert.equal(delivered.upstream.status, 200);
assert.equal(delivered.receipt.clock.delivered, true);
assert.equal(delivered.receipt.clock.completedWithinSla, true);
assert.equal(delivered.receipt.request.paymentAuthorizationPresent, true);
assert.equal(delivered.receipt.provider.targetJobId, targetJobId);
assert.equal(await verifyProviderRelayReceipt(delivered.receipt, signer.address, relayVerifier), true);
assert.equal(
  await verifyProviderRelayReceipt(delivered.receipt, signer.address, "0x8000000000000000000000000000000000000008"),
  false,
);
assert.equal(await store.getRelayReceipt(delivered.receipt.receiptId) !== null, true);
assert.equal(
  (await store.getLatestRelayReceiptForJob(targetJobId)).receiptId,
  delivered.receipt.receiptId,
  "relay receipt must be indexed by target job for autonomous reconciliation",
);

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://different.example" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": "different-provider-payment" }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "one relay grant must never authorize two paid provider requests",
);

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": "replayed-provider-payment" }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "even an identical paid replay must fail closed instead of executing the provider twice",
);

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    endpoint: "https://attacker.example/audit",
    providerRequest: { target_url: "https://example.com" },
    relayGrant: "signed-relay-grant",
  }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_endpoint_does_not_match_enrollment",
);

const privateRelay = createProviderRelay({
  policyResolver: resolver,
  store: new MemoryProviderPolicyStore(),
  fetchImpl,
  resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
await assert.rejects(
  () => privateRelay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://example.com" },
    relayGrant: "signed-relay-grant",
  }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_endpoint_resolves_private",
);

console.log("PolicyPool provider relay passed: exact enrolled endpoint, SSRF guard, at-most-once paid grant, signed clock receipts, and job index.");
