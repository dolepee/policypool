import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CURRENT_ISSUANCE_PUBLIC_ROUTE,
  CURRENT_RENDER_PUBLIC_ROUTE,
  CUSTOM_PUBLIC_ROUTE,
  LEGACY_VERCEL_PUBLIC_ROUTE,
  publicRouteForUrl,
} from "../api/lib/public-origin-contract.js";
import { canonicalRequestPublicUrl } from "../api/lib/public-origin.js";
import {
  computeReceiptHash,
  verifyReceiptIntegrity,
} from "../api/lib/receipt-integrity.js";

assert.equal(CURRENT_ISSUANCE_PUBLIC_ROUTE, CURRENT_RENDER_PUBLIC_ROUTE);
assert.equal(
  canonicalRequestPublicUrl(
    { headers: { "x-forwarded-host": "policypool.dolepee.com" } },
    "/api/covered-job-receipt",
    {
      POLICYPOOL_PUBLIC_ORIGIN: CURRENT_RENDER_PUBLIC_ROUTE.origin,
      POLICYPOOL_PUBLIC_PATH_PREFIX: CURRENT_RENDER_PUBLIC_ROUTE.pathPrefix,
    },
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt",
  "the custom verification host must not replace configured Render issuance",
);
assert.equal(
  publicRouteForUrl("https://policypool.dolepee.com/api/coverage-status?receiptId=ppc-test"),
  CUSTOM_PUBLIC_ROUTE,
);
assert.equal(
  publicRouteForUrl("https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt"),
  CURRENT_RENDER_PUBLIC_ROUTE,
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
assert.equal(verifyReceiptIntegrity(render).publicRoute, CURRENT_RENDER_PUBLIC_ROUTE);

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

console.log("PolicyPool origin-compatibility gate passed: Render issuance, custom verification, and historical Vercel receipts remain exact.");
