import { isEvmAddress, sha256, stableStringify } from "./utils.js";

const OKX_AGENT_ORIGIN = "https://www.okx.ai";
const MAX_AGENT_PAGE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 5 * 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30_000;

const memoryCache = new Map();
const circuit = { failures: 0, openUntil: 0 };

export class OkxAgentPageError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "OkxAgentPageError";
    this.code = code;
  }
}

export function parseOkxAgentReference(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new OkxAgentPageError("okx_agent_reference_required");
  let agentId = raw.replace(/^#/, "");
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new OkxAgentPageError("okx_agent_reference_invalid");
    }
    if (parsed.protocol !== "https:" || !["okx.ai", "www.okx.ai"].includes(parsed.hostname)) {
      throw new OkxAgentPageError("okx_agent_host_not_allowed");
    }
    const match = parsed.pathname.match(/^\/(?:[a-z-]+\/)?agents\/(\d+)\/?$/i);
    if (!match) throw new OkxAgentPageError("okx_agent_url_invalid");
    agentId = match[1];
  }
  if (!/^\d{1,12}$/.test(agentId) || Number(agentId) <= 0) {
    throw new OkxAgentPageError("okx_agent_id_invalid");
  }
  return agentId;
}

function extractAppState(html) {
  const match = String(html).match(/<script[^>]*\bid=["']appState["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new OkxAgentPageError("okx_agent_state_missing");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new OkxAgentPageError("okx_agent_state_invalid");
  }
}

function canonicalService(agentId, service) {
  const serviceId = String(service?.serviceId || "");
  if (!/^\d{1,12}$/.test(serviceId)) throw new OkxAgentPageError("okx_agent_service_id_invalid");
  const serviceType = String(service?.serviceType || "").trim().toUpperCase();
  if (!["A2A", "A2MCP"].includes(serviceType)) {
    throw new OkxAgentPageError("okx_agent_service_type_invalid");
  }
  const definition = {
    agentId: String(agentId),
    serviceId,
    name: String(service?.name || "").trim(),
    serviceType,
    endpoint: String(service?.endpoint || "").trim(),
    price: String(service?.price || "").trim(),
    description: String(service?.description || "").replace(/\s+/g, " ").trim(),
  };
  if (!definition.name || !definition.description) {
    throw new OkxAgentPageError("okx_agent_service_definition_incomplete");
  }
  if (serviceType === "A2MCP") {
    try {
      const endpoint = new URL(definition.endpoint);
      if (endpoint.protocol !== "https:") throw new Error("not https");
    } catch {
      throw new OkxAgentPageError("okx_agent_service_endpoint_invalid");
    }
  }
  return {
    ...definition,
    fingerprint: `0x${sha256(stableStringify(definition))}`,
  };
}

export function parseOkxAgentPage(html, expectedAgentId) {
  const state = extractAppState(html);
  const page = state?.appContext?.initialProps?.AgentDetailPage;
  const overview = page?.overview;
  if (!overview || String(overview.agentId) !== String(expectedAgentId)) {
    throw new OkxAgentPageError("okx_agent_detail_mismatch");
  }
  if (!isEvmAddress(overview.ownerAddress)) throw new OkxAgentPageError("okx_agent_owner_invalid");
  const services = (Array.isArray(page?.services?.list) ? page.services.list : [])
    .map((service) => canonicalService(expectedAgentId, service));
  if (services.length === 0) throw new OkxAgentPageError("okx_agent_services_missing");
  return {
    agentId: String(expectedAgentId),
    name: String(overview.name || "").trim(),
    ownerAddress: String(overview.ownerAddress).toLowerCase(),
    online: String(overview.onlineStatus || "").toLowerCase() === "online",
    network: String(overview.network || "").trim(),
    chainIndex: Number(overview.chainIndex),
    updatedAt: Number(overview.updatedAt) || null,
    publicUrl: `${OKX_AGENT_ORIGIN}/agents/${expectedAgentId}`,
    services,
    schemaHash: `sha256:${sha256({
      root: "AgentDetailPage",
      overview: ["agentId", "ownerAddress", "onlineStatus", "chainIndex"],
      service: ["serviceId", "name", "price", "description", "serviceType", "endpoint"],
    })}`,
  };
}

export function findOkxAgentService(snapshot, serviceId) {
  const wanted = String(serviceId || "").trim();
  return snapshot?.services?.find((service) => service.serviceId === wanted) || null;
}

export async function fetchOkxAgentPage(reference, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 3,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  staleTtlMs = DEFAULT_STALE_TTL_MS,
  cache = memoryCache,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new OkxAgentPageError("okx_agent_fetch_unavailable");
  const agentId = parseOkxAgentReference(reference);
  const cached = cache.get(agentId);
  if (cached && cached.expiresAt > now()) return structuredClone(cached.value);
  if (circuit.openUntil > now()) {
    if (cached && cached.staleUntil > now()) return { ...structuredClone(cached.value), stale: true };
    throw new OkxAgentPageError("okx_agent_directory_circuit_open");
  }

  const url = `${OKX_AGENT_ORIGIN}/agents/${agentId}`;
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "cache-control": "no-cache",
          "user-agent": "PolicyPool-Agent-Directory/0.4",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new OkxAgentPageError(`okx_agent_fetch_failed:${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_AGENT_PAGE_BYTES) throw new OkxAgentPageError("okx_agent_page_too_large");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_AGENT_PAGE_BYTES) throw new OkxAgentPageError("okx_agent_page_too_large");
      const value = parseOkxAgentPage(new TextDecoder().decode(buffer), agentId);
      const fetchedAt = now();
      cache.set(agentId, {
        value: { ...value, fetchedAt: new Date(fetchedAt).toISOString(), stale: false },
        expiresAt: fetchedAt + cacheTtlMs,
        staleUntil: fetchedAt + staleTtlMs,
      });
      circuit.failures = 0;
      circuit.openUntil = 0;
      return structuredClone(cache.get(agentId).value);
    } catch (error) {
      if (error instanceof OkxAgentPageError) lastError = error;
      else if (error?.name === "AbortError") lastError = new OkxAgentPageError("okx_agent_fetch_timeout");
      else lastError = new OkxAgentPageError(
        "okx_agent_fetch_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }

  circuit.failures += 1;
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) circuit.openUntil = now() + CIRCUIT_OPEN_MS;
  if (cached && cached.staleUntil > now()) return { ...structuredClone(cached.value), stale: true };
  throw lastError || new OkxAgentPageError("okx_agent_fetch_failed");
}
