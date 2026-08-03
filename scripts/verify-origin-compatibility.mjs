import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CURRENT_ISSUANCE_PUBLIC_ROUTE,
  CUSTOM_PUBLIC_ROUTE,
  LEGACY_VERCEL_PUBLIC_ROUTE,
  RENDER_ROLLBACK_PUBLIC_ROUTE,
  publicRouteForUrl,
} from "../api/lib/public-origin-contract.js";
import {
  DEFAULT_PUBLIC_ORIGIN,
  canonicalRequestPublicUrl,
} from "../api/lib/public-origin.js";
import {
  computeReceiptHash,
  verifyReceiptIntegrity,
} from "../api/lib/receipt-integrity.js";

assert.equal(CURRENT_ISSUANCE_PUBLIC_ROUTE, CUSTOM_PUBLIC_ROUTE);
assert.equal(DEFAULT_PUBLIC_ORIGIN, CURRENT_ISSUANCE_PUBLIC_ROUTE.origin);
assert.equal(
  canonicalRequestPublicUrl(
    { headers: { "x-forwarded-host": "okx-agent-review-relay.onrender.com" } },
    "/api/covered-job-receipt",
    {
      POLICYPOOL_PUBLIC_ORIGIN: CURRENT_ISSUANCE_PUBLIC_ROUTE.origin,
    },
  ).toString(),
  "https://policypool.dolepee.com/api/covered-job-receipt",
  "the upstream host must not replace configured custom-domain issuance",
);
assert.equal(
  canonicalRequestPublicUrl(
    { headers: { "x-forwarded-host": "policypool.dolepee.com" } },
    "/api/covered-job-receipt",
    {
      POLICYPOOL_PUBLIC_ORIGIN: RENDER_ROLLBACK_PUBLIC_ROUTE.origin,
      POLICYPOOL_PUBLIC_PATH_PREFIX: RENDER_ROLLBACK_PUBLIC_ROUTE.pathPrefix,
    },
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt",
  "an explicit rollback configuration must retain the exact Render mount",
);
assert.equal(
  publicRouteForUrl("https://policypool.dolepee.com/api/coverage-status?receiptId=ppc-test"),
  CUSTOM_PUBLIC_ROUTE,
);
assert.equal(
  publicRouteForUrl("https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt"),
  RENDER_ROLLBACK_PUBLIC_ROUTE,
);
assert.equal(
  publicRouteForUrl("https://policypool.vercel.app/proof/receipt?id=ppc-test"),
  LEGACY_VERCEL_PUBLIC_ROUTE,
);
assert.equal(
  publicRouteForUrl("https://okx-agent-review-relay.onrender.com/api/covered-job-receipt"),
  null,
  "the Render route is trusted only through its exact /policypool mount",
);

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/coverage-receipts.json", import.meta.url), "utf8"),
);
for (const fixture of Object.values(fixtures)) {
  const before = JSON.stringify(fixture.receipt);
  const verified = verifyReceiptIntegrity(fixture.receipt);
  assert.equal(verified.receiptHash, fixture.receipt.receiptHash);
  assert.equal(verified.publicRoute, LEGACY_VERCEL_PUBLIC_ROUTE);
  assert.equal(
    JSON.stringify(fixture.receipt),
    before,
    `${fixture.receiptId} must remain byte-for-byte unchanged after verification`,
  );
}

const [historical] = Object.values(fixtures);
const custom = structuredClone(historical.receipt);
custom.reserve.publicUrl = "https://policypool.dolepee.com/api/coverage-ledger#reserve";
custom.receiptHash = computeReceiptHash(custom);
assert.equal(verifyReceiptIntegrity(custom).publicRoute, CUSTOM_PUBLIC_ROUTE);

const render = structuredClone(historical.receipt);
render.reserve.publicUrl =
  "https://okx-agent-review-relay.onrender.com/policypool/api/coverage-ledger#reserve";
render.receiptHash = computeReceiptHash(render);
assert.equal(verifyReceiptIntegrity(render).publicRoute, RENDER_ROLLBACK_PUBLIC_ROUTE);

const tampered = structuredClone(historical.receipt);
tampered.reserve.publicUrl = custom.reserve.publicUrl;
assert.throws(
  () => verifyReceiptIntegrity(tampered),
  (error) => error?.code === "receipt_hash_mismatch",
  "changing a historical Vercel receipt to the custom origin must break its hash",
);

const mixed = structuredClone(custom);
mixed.providerRelay = {
  endpoint: "https://okx-agent-review-relay.onrender.com/policypool/api/provider-relay",
};
mixed.receiptHash = computeReceiptHash(mixed);
assert.throws(
  () => verifyReceiptIntegrity(mixed),
  (error) => error?.code === "receipt_public_origin_mismatch",
  "even a rehashed receipt cannot combine custom and Render PolicyPool routes",
);

const pendingRelay = structuredClone(custom);
pendingRelay.target.clockMode = "policypool_relay";
pendingRelay.providerRelay = {
  endpoint: "https://policypool.dolepee.com/api/provider-relay",
  grantId: "ppg-origin-compatibility",
  grantExpiresAt: "2026-08-04T00:00:00.000Z",
};
pendingRelay.receiptHash = computeReceiptHash(pendingRelay);
const renderedRelay = structuredClone(pendingRelay);
renderedRelay.providerRelay.grantToken = "ephemeral-recovery-token";
assert.equal(
  verifyReceiptIntegrity(renderedRelay).receiptHash,
  pendingRelay.receiptHash,
  "a refreshed relay token must not rewrite the durable receipt hash",
);
const changedRelayGrant = structuredClone(renderedRelay);
changedRelayGrant.providerRelay.grantId = "ppg-substituted";
assert.throws(
  () => verifyReceiptIntegrity(changedRelayGrant),
  (error) => error?.code === "receipt_hash_mismatch",
  "hash-committed relay grant metadata must remain substitution resistant",
);

for (const endpoint of [
  "https://policypool.dolepee.com/api/coverage-status",
  "https://policypool.dolepee.com/api/provider-relay/",
  "https://policypool.dolepee.com/api/provider-relay?probe=1",
  "https://policypool.dolepee.com/api/provider-relay#probe",
  "https://policypool.dolepee.com/wrong/api/provider-relay",
  "https://okx-agent-review-relay.onrender.com/api/provider-relay",
  "https://okx-agent-review-relay.onrender.com/policypool/api/coverage-status",
  "https://okx-agent-review-relay.onrender.com/policypool/api/provider-relay/",
  "https://policypool.vercel.app/api/coverage-status",
  "https://policypool.vercel.app/api/provider-relay/",
]) {
  const substituted = structuredClone(pendingRelay);
  substituted.providerRelay.endpoint = endpoint;
  substituted.receiptHash = computeReceiptHash(substituted);
  assert.throws(
    () => verifyReceiptIntegrity(substituted),
    (error) => error?.code === "receipt_public_origin_untrusted",
    `built-in relay validation must reject ${endpoint}`,
  );
}

for (const [endpoint, expectedRoute] of [
  [
    "https://okx-agent-review-relay.onrender.com/policypool/api/provider-relay",
    RENDER_ROLLBACK_PUBLIC_ROUTE,
  ],
  ["https://policypool.vercel.app/api/provider-relay", LEGACY_VERCEL_PUBLIC_ROUTE],
]) {
  const historicalRelay = structuredClone(historical.receipt);
  historicalRelay.reserve = null;
  historicalRelay.providerRelay = {
    endpoint,
    grantId: "ppg-historical-relay",
    grantExpiresAt: "2026-08-04T00:00:00.000Z",
  };
  historicalRelay.receiptHash = computeReceiptHash(historicalRelay);
  assert.equal(
    verifyReceiptIntegrity(historicalRelay).publicRoute,
    expectedRoute,
    `${endpoint} must remain available after the deployment migrates to another public route`,
  );
}

for (const providerRelay of [
  null,
  {},
  { endpoint: "" },
  { endpoint: null },
]) {
  const missingRelay = structuredClone(pendingRelay);
  missingRelay.providerRelay = providerRelay;
  missingRelay.receiptHash = computeReceiptHash(missingRelay);
  assert.throws(
    () => verifyReceiptIntegrity(missingRelay),
    (error) => error?.code === "receipt_provider_relay_missing",
    "relay-clock receipts must not verify without a nonempty provider relay endpoint",
  );
}

const configuredBuiltInEnvironment = {
  POLICYPOOL_PUBLIC_ORIGIN: CUSTOM_PUBLIC_ROUTE.origin,
  POLICYPOOL_PUBLIC_PATH_PREFIX: "/edge",
};
const configuredBuiltInRelay = structuredClone(pendingRelay);
configuredBuiltInRelay.reserve = null;
configuredBuiltInRelay.providerRelay.endpoint =
  "https://policypool.dolepee.com/edge/api/provider-relay";
configuredBuiltInRelay.receiptHash = computeReceiptHash(configuredBuiltInRelay);
const configuredBuiltInVerification = verifyReceiptIntegrity(configuredBuiltInRelay, {
  environment: configuredBuiltInEnvironment,
});
assert.equal(configuredBuiltInVerification.publicRoute.origin, CUSTOM_PUBLIC_ROUTE.origin);
assert.equal(configuredBuiltInVerification.publicRoute.pathPrefix, "/edge");

for (const endpoint of [
  "https://policypool.dolepee.com/wrong/api/provider-relay",
  "https://policypool.dolepee.com/edge/api/provider-relay/",
  "https://policypool.dolepee.com/edge/api/coverage-status",
  "https://policypool.dolepee.com/edge/api/provider-relay?probe=1",
  "https://policypool.dolepee.com/edge/api/provider-relay#probe",
]) {
  const substituted = structuredClone(configuredBuiltInRelay);
  substituted.providerRelay.endpoint = endpoint;
  substituted.receiptHash = computeReceiptHash(substituted);
  assert.throws(
    () => verifyReceiptIntegrity(substituted, {
      environment: configuredBuiltInEnvironment,
    }),
    (error) => error?.code === "receipt_public_origin_untrusted",
    `configured built-in relay validation must reject ${endpoint}`,
  );
}

const preMigrationBuiltInRelay = structuredClone(configuredBuiltInRelay);
preMigrationBuiltInRelay.providerRelay.endpoint =
  "https://policypool.dolepee.com/api/provider-relay";
preMigrationBuiltInRelay.receiptHash = computeReceiptHash(preMigrationBuiltInRelay);
assert.equal(
  verifyReceiptIntegrity(preMigrationBuiltInRelay, {
    environment: configuredBuiltInEnvironment,
  }).publicRoute,
  CUSTOM_PUBLIC_ROUTE,
  "a path-prefix migration must retain the exact pre-migration built-in relay endpoint",
);

const configuredEnvironment = {
  POLICYPOOL_PUBLIC_ORIGIN: "https://self-hosted-policy.example",
  POLICYPOOL_PUBLIC_PATH_PREFIX: "/policypool",
};
const configuredRelay = structuredClone(custom);
configuredRelay.reserve = null;
configuredRelay.providerRelay = {
  endpoint: "https://self-hosted-policy.example/policypool/api/provider-relay",
  grantId: "ppg-configured-origin",
  grantExpiresAt: "2026-08-04T00:00:00.000Z",
};
configuredRelay.receiptHash = computeReceiptHash(configuredRelay);
const configuredVerification = verifyReceiptIntegrity(configuredRelay, {
  environment: configuredEnvironment,
});
assert.equal(configuredVerification.publicRoute.origin, "https://self-hosted-policy.example");
assert.equal(configuredVerification.publicRoute.pathPrefix, "/policypool");
assert.throws(
  () => verifyReceiptIntegrity(configuredRelay),
  (error) => error?.code === "receipt_public_origin_untrusted",
  "a self-hosted relay is trusted only by the deployment that explicitly configured it",
);

for (const endpoint of [
  "https://self-hosted-policy.example/api/provider-relay",
  "https://self-hosted-policy.example/policypool/api/provider-relay/",
  "https://self-hosted-policy.example/policypool/api/coverage-status",
  "https://attacker.example/policypool/api/provider-relay",
]) {
  const substituted = structuredClone(configuredRelay);
  substituted.providerRelay.endpoint = endpoint;
  substituted.receiptHash = computeReceiptHash(substituted);
  assert.throws(
    () => verifyReceiptIntegrity(substituted, { environment: configuredEnvironment }),
    (error) => error?.code === "receipt_public_origin_untrusted",
    `configured relay validation must reject ${endpoint}`,
  );
}

console.log("PolicyPool origin-compatibility gate passed: configured self-hosting, custom issuance, Render rollback, and historical Vercel receipts remain exact.");
