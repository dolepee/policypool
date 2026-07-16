import assert from "node:assert/strict";
import { createManifestHandler } from "../api/manifest.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const response = await callHandler(createManifestHandler({
  now: () => Date.parse("2026-07-15T18:00:00.000Z"),
}), { method: "GET", url: "/api/manifest" });
assert.equal(response.statusCode, 200);
const manifest = response.json();
assert.equal(manifest.ok, true);
assert.equal(manifest.version, "0.3.0");
assert.equal(manifest.agent.id, "4674");
assert.equal(manifest.service.id, "33290");
assert.equal(manifest.service.priceAtomic, "100000");
assert.equal(manifest.quote.signed, true);
assert.equal(manifest.quote.fullEligibilityRecheckedAtSettlement, true);
assert.equal(manifest.quote.ambiguityBehavior, "fail_closed_without_settlement");
assert.equal(manifest.coverage.reserveSettlement, "operator_approved_and_independently_verified");
assert.equal(manifest.states.payoutExecution, "never_automatic_in_v0.3");
assert.equal(manifest.input.legacyFullBodyAccepted, true);
assert.equal(manifest.providers.length, 3);
assert.equal(manifest.providers.filter((provider) => provider.coverableNow).length, 2);
assert.equal(manifest.providers.find((provider) => provider.agentId === "3808")?.coverableNow, false);
assert.doesNotMatch(JSON.stringify(manifest), /private.key|seed phrase|fully autonomous/i);

const head = await callHandler(createManifestHandler(), { method: "HEAD", url: "/api/manifest" });
assert.equal(head.statusCode, 200);

let universalCalls = 0;
const universal = await callHandler(createManifestHandler({
  universalHandler: async (_req, res) => {
    universalCalls += 1;
    return res.status(200).send(JSON.stringify({ ok: true, version: "0.4.0", enabled: false }));
  },
}), {
  method: "GET",
  url: "/api/universal-manifest",
  query: { surface: "universal" },
});
assert.equal(universal.statusCode, 200);
assert.equal(universal.json().version, "0.4.0");
assert.equal(universalCalls, 1);

console.log("PolicyPool manifest gate passed: stable service contract, quote semantics, provider windows, and autonomy limits.");
