import { createProviderEnrollmentService, ProviderEnrollmentError } from "./lib/provider-enrollment.js";
import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { sendJson } from "./lib/utils.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";

export function createProviderEnrollmentHandler(dependencies = {}) {
  let runtimeStore = dependencies.store;
  let runtimeService = dependencies.service;
  const limiter = dependencies.limiter || createRateLimiter();
  const getStore = () => (runtimeStore ||= createProviderPolicyStore());
  const getService = () => (runtimeService ||= createProviderEnrollmentService({
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
        service: "PolicyPool Provider Enrollment",
        state: "feature_gated",
        actions: ["prepare", "submit", "confirm"],
        custody: "provider_bond_vault",
        activation: "onchain_registration_required",
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", charged: false });
    }
    const action = String(req.body?.action || "prepare").trim().toLowerCase();
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: `provider-enrollment-${action}`,
      subject: req.body?.provider || req.body?.enrollmentId,
      limit: action === "confirm" ? 30 : 10,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);
    try {
      if (action === "prepare") {
        const result = await getService().prepare(req.body);
        return sendJson(res, 200, { ok: true, action, ...result });
      }
      if (action === "submit") {
        const result = await getService().submit(req.body);
        return sendJson(res, 200, result);
      }
      if (action === "confirm") {
        const result = await getService().confirm(req.body);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 400, { ok: false, error: "enrollment_action_invalid", charged: false });
    } catch (error) {
      if (error instanceof ProviderEnrollmentError) {
        return sendJson(res, error.status, { ok: false, error: error.code, charged: false });
      }
      return sendJson(res, 503, { ok: false, error: "provider_enrollment_unavailable", charged: false });
    }
  };
}

export default createProviderEnrollmentHandler();
