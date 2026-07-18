import assert from "node:assert/strict";
import { createV04RuntimeHandler } from "../api/v04-runtime.js";

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {},
    send(value) {
      this.body = JSON.parse(value);
      return this;
    },
  };
}

const calls = [];
const routed = createV04RuntimeHandler({
  "direct-a2mcp": async (req, res) => calls.push(["direct", req, res]),
  "reconcile-direct-a2mcp": async (req, res) => calls.push(["direct-reconcile", req, res]),
  "reconcile-universal": async (req, res) => calls.push(["universal-reconcile", req, res]),
});

for (const [surface, expected] of [
  ["direct-a2mcp", "direct"],
  ["reconcile-direct-a2mcp", "direct-reconcile"],
  ["reconcile-universal", "universal-reconcile"],
]) {
  const req = {
    query: { surface, dryRun: "true" },
    url: `/api/v04-runtime.js?surface=${surface}&dryRun=true`,
  };
  const res = response();
  await routed(req, res);
  assert.equal(calls.at(-1)[0], expected);
  assert.equal(calls.at(-1)[1], req);
  assert.equal(calls.at(-1)[2], res);
  assert.equal(req.url, `/api/${surface}?dryRun=true`);
}

const arraySurface = {
  query: { surface: ["direct-a2mcp", "reconcile-universal"] },
  url: "/api/v04-runtime.js?surface=direct-a2mcp",
};
await routed(arraySurface, response());
assert.equal(calls.at(-1)[0], "direct");
assert.equal(arraySurface.url, "/api/direct-a2mcp");

const missing = response();
await routed({ query: {} }, missing);
assert.equal(missing.statusCode, 404);
assert.deepEqual(missing.body, { ok: false, error: "v04_runtime_surface_not_found" });

const unknown = response();
await routed({ query: { surface: "unknown" } }, unknown);
assert.equal(unknown.statusCode, 404);
assert.deepEqual(unknown.body, { ok: false, error: "v04_runtime_surface_not_found" });

console.log("PolicyPool v0.4 runtime router passed: all three public URLs dispatch through one bounded serverless function.");
