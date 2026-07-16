import assert from "node:assert/strict";
import {
  fetchOkxAgentPage,
  findOkxAgentService,
  parseOkxAgentPage,
  parseOkxAgentReference,
} from "../api/lib/okx-agent-page.js";

function fixture({ price = "0.5", endpoint = "https://warden.example/audit" } = {}) {
  const state = {
    appContext: {
      initialProps: {
        AgentDetailPage: {
          overview: {
            agentId: "3808",
            name: "Warden",
            ownerAddress: "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51",
            onlineStatus: "online",
            network: "X Layer",
            chainIndex: 196,
            updatedAt: 123,
          },
          services: {
            list: [{
              serviceId: 33461,
              name: "Agent Endpoint Security Audit",
              price,
              description: "Runs a deterministic endpoint audit.",
              serviceType: "A2MCP",
              endpoint,
            }],
          },
        },
      },
    },
  };
  return `<html><script type="application/json" id="appState">${JSON.stringify(state)}</script></html>`;
}

assert.equal(parseOkxAgentReference("#3808"), "3808");
assert.equal(parseOkxAgentReference("https://www.okx.ai/agents/3808"), "3808");
assert.throws(() => parseOkxAgentReference("https://evil.example/agents/3808"));

const parsed = parseOkxAgentPage(fixture(), "3808");
assert.equal(parsed.ownerAddress, "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51");
assert.equal(findOkxAgentService(parsed, "33461").price, "0.5");
assert.match(findOkxAgentService(parsed, "33461").fingerprint, /^0x[a-f0-9]{64}$/);
assert.notEqual(
  findOkxAgentService(parsed, "33461").fingerprint,
  findOkxAgentService(parseOkxAgentPage(fixture({ price: "0.6" }), "3808"), "33461").fingerprint,
  "price churn must change the service fingerprint",
);

let calls = 0;
const cache = new Map();
const fetchImpl = async () => {
  calls += 1;
  return new Response(fixture(), { status: 200, headers: { "content-type": "text/html" } });
};
const first = await fetchOkxAgentPage("3808", { fetchImpl, cache });
const second = await fetchOkxAgentPage("3808", { fetchImpl, cache });
assert.equal(calls, 1, "fresh directory reads must use cache");
assert.deepEqual(second.services, first.services);

let clock = Date.now();
const staleCache = new Map();
await fetchOkxAgentPage("3808", {
  fetchImpl,
  cache: staleCache,
  cacheTtlMs: 10,
  staleTtlMs: 1000,
  now: () => clock,
});
clock += 20;
const stale = await fetchOkxAgentPage("3808", {
  fetchImpl: async () => { throw new Error("offline"); },
  attempts: 1,
  cache: staleCache,
  cacheTtlMs: 10,
  staleTtlMs: 1000,
  now: () => clock,
});
assert.equal(stale.stale, true, "temporary upstream failure should use bounded stale data");

assert.throws(() => parseOkxAgentPage(fixture(), "9999"));
console.log("PolicyPool OKX agent directory passed: strict parsing, service fingerprints, cache, and bounded stale fallback.");
