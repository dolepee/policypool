import { createCoverageDemandService, CoverageDemandError } from "./lib/coverage-demand.js";
import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { sendJson } from "./lib/utils.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";

export function createCoverageDemandHandler(dependencies = {}) {
  let runtimeStore = dependencies.store;
  let runtimeService = dependencies.service;
  const limiter = dependencies.limiter || createRateLimiter();
  const getStore = () => (runtimeStore ||= createProviderPolicyStore());
  const getService = () => (runtimeService ||= createCoverageDemandService({
    ...dependencies,
    store: getStore(),
  }));

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        service: "PolicyPool Coverage Demand Signal",
        charged: false,
        description: "Record demand for an unenrolled OKX.AI service and return its provider enrollment link.",
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", charged: false });
    }
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: "coverage-demand",
      subject: `${req.body?.agentId || ""}:${req.body?.serviceId || ""}`,
      limit: 20,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);
    try {
      const result = await getService().record(req.body);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof CoverageDemandError) {
        return sendJson(res, error.status, { ok: false, error: error.code, charged: false });
      }
      return sendJson(res, 503, { ok: false, error: "coverage_demand_unavailable", charged: false });
    }
  };
}

export default createCoverageDemandHandler();
