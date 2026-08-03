import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PUBLIC_ORIGIN,
  canonicalRequestPublicUrl,
  configuredPublicOrigin,
  publicUrl,
  requestPublicOrigin,
  __test,
} from "../api/lib/public-origin.js";
import { universalPublicOrigin } from "../api/lib/universal-config.js";

const [keepwarmSource, responderSource, scheduleSource, reconcileSource, environmentExample] =
  await Promise.all([
    "./policypool_keepwarm.sh",
    "./policypool_fast_responder.py",
    "./setup-qstash-schedule.mjs",
    "../api/reconcile-coverage.js",
    "../.env.example",
  ].map((relative) => readFile(new URL(relative, import.meta.url), "utf8")));
assert.match(
  keepwarmSource,
  /PUBLIC_ORIGIN="\$\{PUBLIC_ORIGIN%\/\}"/,
  "keep-warm endpoint construction must normalize a valid trailing origin slash",
);
assert.match(
  keepwarmSource,
  /POLICYPOOL_PUBLIC_ORIGIN:-https:\/\/policypool\.dolepee\.com/,
  "keep-warm must default to the canonical custom front door",
);
assert.match(
  responderSource,
  /"https:\/\/policypool\.dolepee\.com"/,
  "the marketplace responder must default to the canonical custom front door",
);
assert.match(
  scheduleSource,
  /https:\/\/policypool\.dolepee\.com\/api\/reconcile-coverage/,
  "new v0.3 reconciliation schedules must target the canonical custom front door",
);
assert.match(
  reconcileSource,
  /\|\| "policypool\.dolepee\.com"/,
  "signed reconciliation must use the canonical host when proxy headers are absent",
);
assert.match(
  environmentExample,
  /^POLICYPOOL_PUBLIC_ORIGIN=https:\/\/policypool\.dolepee\.com$/m,
  "operator configuration must name the canonical custom front door",
);

const configured = { POLICYPOOL_PUBLIC_ORIGIN: "https://policy.example" };
assert.equal(DEFAULT_PUBLIC_ORIGIN, "https://policypool.dolepee.com");
assert.equal(configuredPublicOrigin({}), DEFAULT_PUBLIC_ORIGIN);
assert.equal(configuredPublicOrigin(configured), "https://policy.example");
assert.equal(publicUrl("/api/covered-job-receipt", configured), "https://policy.example/api/covered-job-receipt");
const relayed = {
  POLICYPOOL_PUBLIC_ORIGIN: "https://okx-agent-review-relay.onrender.com",
  POLICYPOOL_PUBLIC_PATH_PREFIX: "/policypool",
};
assert.equal(
  publicUrl("/api/covered-job-receipt", relayed),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt",
);
assert.equal(
  canonicalRequestPublicUrl(
    { url: "/api/coverage-preflight?attacker=1", headers: {} },
    "/api/covered-job-receipt?quote=bound",
    relayed,
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt?quote=bound",
  "an exact service link must never inherit the current handler path or query",
);
assert.equal(
  canonicalRequestPublicUrl(
    { url: "/policypool/api/coverage-preflight", headers: {} },
    "/api/covered-job-receipt",
    relayed,
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt",
  "a prefix-preserving proxy request must not affect the fixed service route",
);
const overlappingPrefix = {
  POLICYPOOL_PUBLIC_ORIGIN: "https://review-relay.example",
  POLICYPOOL_PUBLIC_PATH_PREFIX: "/api",
};
assert.equal(
  canonicalRequestPublicUrl(
    { url: "/api/covered-job-receipt", headers: {} },
    "/api/covered-job-receipt",
    overlappingPrefix,
  ).toString(),
  "https://review-relay.example/api/api/covered-job-receipt",
  "an overlapping mount prefix must still be applied to the canonical handler path",
);
assert.equal(
  publicUrl("/api/covered-job-receipt", overlappingPrefix),
  "https://review-relay.example/api/api/covered-job-receipt",
  "request-time and manifest URLs must agree for an overlapping mount prefix",
);
assert.equal(
  requestPublicOrigin({ headers: { "x-forwarded-host": "attacker.invalid" } }, configured),
  "https://policy.example",
  "the configured canonical origin must override forwarded-host input",
);

for (const invalidPrefix of [
  "/",
  "policypool",
  "/policypool/",
  "//policypool",
  "/./x",
  "/x/./y",
  "/../x",
  "/policy%2fpool",
  "/policy\\pool",
]) {
  assert.throws(
    () => __test.publicPathPrefix({ POLICYPOOL_PUBLIC_PATH_PREFIX: invalidPrefix }),
    /normalized absolute path prefix/,
  );
}
assert.equal(
  requestPublicOrigin({ headers: { "x-forwarded-host": "policypool-xlayer-api.onrender.com" } }, {}),
  "https://policypool-xlayer-api.onrender.com",
);
assert.equal(
  canonicalRequestPublicUrl(
    { headers: { "x-forwarded-host": "policypool-xlayer-api.onrender.com" } },
    "/api/covered-job-receipt",
    { POLICYPOOL_PUBLIC_PATH_PREFIX: "/policypool" },
  ).toString(),
  "https://policypool-xlayer-api.onrender.com/policypool/api/covered-job-receipt",
);
assert.equal(
  canonicalRequestPublicUrl({
    url: "https://attacker.invalid/foreign/path?quote=attacker",
    headers: { "x-forwarded-host": "policypool-xlayer-api.onrender.com" },
  }, "/api/covered-job-receipt?quote=bound", {}).toString(),
  "https://policypool-xlayer-api.onrender.com/api/covered-job-receipt?quote=bound",
  "an absolute request URL must never override the canonical service route",
);

for (const invalid of [
  "http://policy.example",
  "https://user:pass@policy.example",
  "https://policy.example/path",
  "https://policy.example/?query=1",
  "https://policy.example/#fragment",
]) {
  assert.throws(
    () => configuredPublicOrigin({ POLICYPOOL_PUBLIC_ORIGIN: invalid }),
    /credential-free HTTPS origin/,
  );
}

assert.equal(
  requestPublicOrigin({ headers: { "x-forwarded-host": "attacker.invalid/path" } }, {}),
  "https://policypool.dolepee.com",
  "an invalid forwarded host must fall back to the known production origin",
);
assert.equal(
  universalPublicOrigin({
    POLICYPOOL_PUBLIC_ORIGIN: "https://okx-agent-review-relay.onrender.com",
    POLICYPOOL_UNIVERSAL_PUBLIC_ORIGIN: "https://policypool.vercel.app",
  }),
  "https://policypool.vercel.app",
  "the fixed-path v0.3 relay must not rewrite the separate v0.4 origin",
);
assert.equal(
  universalPublicOrigin({ POLICYPOOL_PUBLIC_ORIGIN: "https://legacy-v04.example" }),
  "https://legacy-v04.example",
  "existing v0.4 deployments must retain the original public-origin fallback",
);
assert.equal(
  universalPublicOrigin({ POLICYPOOL_UNIVERSAL_PUBLIC_ORIGIN: "http://unsafe.example" }),
  null,
  "an invalid universal origin must fail closed",
);

console.log("PolicyPool public-origin gate passed: HTTPS-only canonical URLs and forwarded-host substitution resistance verified.");
