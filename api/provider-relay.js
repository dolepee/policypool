import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { createProviderRelay, ProviderRelayError } from "./lib/provider-relay.js";
import { createUniversalPolicyResolver } from "./lib/universal-policy.js";
import { createRelayGrantService } from "./lib/relay-grant.js";
import { header, sendJson } from "./lib/utils.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";

export function createProviderRelayHandler(dependencies = {}) {
  let runtimeStore = dependencies.store;
  let runtimeResolver = dependencies.policyResolver;
  let runtimeRelay = dependencies.relay;
  let runtimeGrantService = dependencies.grantService;
  const limiter = dependencies.limiter || createRateLimiter();
  const getStore = () => (runtimeStore ||= createProviderPolicyStore());
  const getResolver = () => (runtimeResolver ||= createUniversalPolicyResolver({
    ...dependencies,
    store: getStore(),
  }));
  const getRelay = () => (runtimeRelay ||= createProviderRelay({
    ...dependencies,
    store: getStore(),
    policyResolver: getResolver(),
    grantService: runtimeGrantService ||= createRelayGrantService(dependencies),
  }));

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        service: "PolicyPool Provider Relay",
        supportedServiceType: "A2MCP",
        endpointPolicy: "exact_live_enrolled_endpoint_only",
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", charged: false });
    }
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: "provider-relay",
      subject: `${req.body?.agentId || ""}:${req.body?.serviceId || ""}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);
    try {
      const result = await getRelay().execute(req.body, {
        accept: header(req, "accept"),
        "content-type": header(req, "content-type"),
        "payment-signature": header(req, "payment-signature"),
        "x-payment": header(req, "x-payment"),
      });
      for (const [name, value] of Object.entries(result.upstream.headers)) res.setHeader(name, value);
      return sendJson(res, result.upstream.status, {
        ok: result.upstream.status >= 200 && result.upstream.status < 300,
        relayReceipt: result.receipt,
        providerResponse: {
          status: result.upstream.status,
          contentType: result.upstream.contentType,
          bodyBase64: result.upstream.bodyBase64,
        },
      });
    } catch (error) {
      if (error instanceof ProviderRelayError) {
        return sendJson(res, error.status, { ok: false, error: error.code, charged: false });
      }
      return sendJson(res, 503, { ok: false, error: "provider_relay_unavailable", charged: false });
    }
  };
}

export default createProviderRelayHandler();
