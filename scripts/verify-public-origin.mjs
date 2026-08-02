import assert from "node:assert/strict";
import {
  configuredPublicOrigin,
  publicUrl,
  requestPublicOrigin,
  requestPublicPathUrl,
  requestPublicUrl,
  __test,
} from "../api/lib/public-origin.js";
import { universalPublicOrigin } from "../api/lib/universal-config.js";

const configured = { POLICYPOOL_PUBLIC_ORIGIN: "https://policy.example" };
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
  requestPublicUrl({ url: "/api/covered-job-receipt?quote=bound", headers: {} }, "/api/covered-job-receipt", relayed).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt?quote=bound",
);
assert.equal(
  requestPublicUrl(
    { url: "/policypool/api/covered-job-receipt?quote=bound", headers: {} },
    "/api/covered-job-receipt",
    relayed,
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt?quote=bound",
  "a prefix-preserving proxy path must not duplicate the configured prefix",
);
assert.equal(
  requestPublicPathUrl(
    { url: "/api/coverage-preflight?attacker=1", headers: {} },
    "/api/covered-job-receipt",
    relayed,
  ).toString(),
  "https://okx-agent-review-relay.onrender.com/policypool/api/covered-job-receipt",
  "an exact service link must never inherit the current handler path or query",
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
  requestPublicPathUrl(
    { headers: { "x-forwarded-host": "policypool-xlayer-api.onrender.com" } },
    "/api/covered-job-receipt",
    { POLICYPOOL_PUBLIC_PATH_PREFIX: "/policypool" },
  ).toString(),
  "https://policypool-xlayer-api.onrender.com/policypool/api/covered-job-receipt",
);
assert.equal(
  requestPublicUrl({
    url: "https://attacker.invalid/api/covered-job-receipt?quote=bound",
    headers: { "x-forwarded-host": "policypool-xlayer-api.onrender.com" },
  }, "/api/covered-job-receipt", {}).toString(),
  "https://policypool-xlayer-api.onrender.com/api/covered-job-receipt?quote=bound",
  "an absolute request URL must never override the selected public origin",
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
  "https://policypool.vercel.app",
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
