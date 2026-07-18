import directA2mcpHandler from "./direct-a2mcp.js";
import reconcileDirectA2mcpHandler from "./reconcile-direct-a2mcp.js";
import reconcileUniversalHandler from "./reconcile-universal.js";
import { sendJson } from "./lib/utils.js";

const SURFACES = {
  "direct-a2mcp": directA2mcpHandler,
  "reconcile-direct-a2mcp": reconcileDirectA2mcpHandler,
  "reconcile-universal": reconcileUniversalHandler,
};

function requestedSurface(req) {
  const value = Array.isArray(req.query?.surface) ? req.query.surface[0] : req.query?.surface;
  return String(value || "").trim();
}

function canonicalizeRequestUrl(req, surface) {
  const parsed = new URL(String(req.url || "/"), "https://policypool.invalid");
  parsed.pathname = `/api/${surface}`;
  parsed.searchParams.delete("surface");
  req.url = `${parsed.pathname}${parsed.search}`;
}

export function createV04RuntimeHandler(overrides = {}) {
  const handlers = { ...SURFACES, ...overrides };
  return async function handler(req, res) {
    const surface = requestedSurface(req);
    const selected = handlers[surface];
    if (typeof selected !== "function") {
      return sendJson(res, 404, { ok: false, error: "v04_runtime_surface_not_found" });
    }
    canonicalizeRequestUrl(req, surface);
    return selected(req, res);
  };
}

export default createV04RuntimeHandler();
