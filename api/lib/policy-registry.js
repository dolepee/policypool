import { sha256 } from "./utils.js";

const FOREMAN_POLICY = {
  agentId: "4348",
  agentName: "Foreman",
  providerWallet: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
  serviceIds: ["33357"],
  serviceName: "Launch Readiness Pack",
  serviceType: "A2MCP",
  publishedScope: [
    "launch readiness verdict",
    "listing mismatch check",
    "90-second demo shotlist",
    "X post draft",
    "proof checklist",
  ],
  requiredInputs: [
    "project name",
    "category",
    "summary",
    "target user",
    "listing draft",
    "live URL",
    "notes",
    "deadline",
  ],
  allowedKeywords: ["launch", "listing", "demo", "announcement", "readiness", "proof"],
  slaSeconds: 300,
  coverageStatus: "active",
  clockSource: "verified_acceptance_block",
  source: {
    kind: "OKX.AI listed service snapshot",
    capturedAt: "2026-07-14T00:00:00.000Z",
  },
};

const GLASSDESK_POLICY = {
  agentId: "3465",
  agentName: "GlassDesk",
  providerWallet: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
  serviceIds: ["30019", "30020", "30021"],
  serviceName: "Evidence Pack Services",
  serviceType: "A2A",
  publishedScope: [
    "verify a specific public market-data claim",
    "source appendix",
    "confidence labels",
    "receipt hashes",
    "unavailable-data disclosure",
  ],
  requiredInputs: [
    "token or contract",
    "chain",
    "claim or question to verify",
  ],
  allowedKeywords: ["market", "token", "contract", "wallet", "holder", "claim", "evidence", "liquidity", "source"],
  slaSeconds: 86_400,
  coverageStatus: "active",
  clockSource: "verified_acceptance_block",
  source: {
    kind: "OKX.AI listed service snapshot",
    capturedAt: "2026-07-10T10:45:00.000Z",
  },
};

const WARDEN_POLICY = {
  agentId: "3808",
  agentName: "Warden",
  providerWallet: "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51",
  serviceIds: ["33461"],
  serviceName: "Agent Endpoint Security Audit",
  serviceType: "A2MCP",
  publishedScope: [
    "run the standard 20-payload endpoint security audit battery",
    "return a deterministic point-in-time audit result",
    "report the observed findings without claiming security certification",
  ],
  requiredInputs: ["target endpoint URL"],
  allowedKeywords: [
    "endpoint",
    "audit",
    "security",
    "payload",
    "prompt",
    "injection",
    "tool",
    "drain",
    "exfiltration",
  ],
  slaSeconds: 300,
  maxCoverageAtomic: "500000",
  coverageStatus: "pending_clock_adapter",
  coverageBlockReason: "provider_clock_evidence_not_supported",
  clockSource: "provider_endpoint_receipt",
  processingStart: "funded request reaches the listed endpoint with its payload",
  exclusions: [
    "OKX task-routing or auto-replay delay before the funded payload reaches the endpoint",
    "custom audit batteries of approximately 40 or more payloads",
    "security certification or any guarantee of the returned grade",
    "audit grade or quality; coverage applies only to timely delivery of the result",
  ],
  source: {
    kind: "OKX.AI listed service snapshot plus provider opt-in",
    capturedAt: "2026-07-15T16:11:36.000Z",
  },
};

const policies = [FOREMAN_POLICY, GLASSDESK_POLICY, WARDEN_POLICY];
const registry = new Map();
for (const policy of policies) {
  registry.set(policy.agentId, policy);
  registry.set(policy.agentName.toLowerCase(), policy);
  registry.set(`${policy.agentName.toLowerCase()}#${policy.agentId}`, policy);
  for (const serviceId of policy.serviceIds) registry.set(serviceId, policy);
}

export function findPublishedPolicy(value) {
  const key = String(value || "").trim().toLowerCase();
  const policy = registry.get(key);
  if (!policy) return null;
  const snapshot = JSON.parse(JSON.stringify(policy));
  return {
    ...snapshot,
    policyHash: `sha256:${sha256(snapshot)}`,
  };
}

export function listPublishedPolicies() {
  return policies.map((policy) => findPublishedPolicy(policy.agentId));
}

export function policyCoverageCapAtomic(policy, fallbackAtomic) {
  const value = policy?.maxCoverageAtomic ?? fallbackAtomic;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
