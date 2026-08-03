import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const health = JSON.parse(
  await readFile(new URL("../web/health.json", import.meta.url), "utf8"),
);
assert.deepEqual(health, {
  ok: true,
  service: "PolicyPool",
  status: "ready",
  check: "shallow",
  dependenciesQueried: false,
});

const vercel = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);
const healthRoute = vercel.routes.find((route) => route.src === "/api/health");
assert.equal(
  healthRoute?.dest,
  "/web/health.json",
  "the public health route must resolve to the dependency-free static artifact",
);
assert.equal(healthRoute.headers?.["Cache-Control"], "no-store");
assert.equal(healthRoute.headers?.["Content-Type"], "application/json; charset=utf-8");
assert.ok(
  vercel.routes.indexOf(healthRoute)
    < vercel.routes.findIndex((route) => route.src === "/api/(.*)"),
  "the health route must win before the generic serverless API route",
);
assert.equal(
  vercel.builds.filter((build) => build.use === "@vercel/node").length,
  12,
  "shallow health must not consume another serverless function slot",
);

console.log("PolicyPool shallow health gate passed: static JSON is dependency-free and deployment-routed.");
