const DEFAULT_TIMEOUT_MS = 10_000;
const ACTIONS = new Set(["issue", "start_clock", "release", "breach", "settlement"]);

export class EvidenceAttestationError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = "EvidenceAttestationError";
    this.code = code;
    this.status = status;
  }
}

function serializable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  }
  return value;
}

function endpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new EvidenceAttestationError("evidence_attestation_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new EvidenceAttestationError("evidence_attestation_url_invalid");
  }
  return parsed.toString();
}

function attestationDomain(value) {
  const chainId = Number(value?.chainId);
  const manager = String(value?.manager || "");
  const verifier = String(value?.verifier || "");
  if (
    !Number.isSafeInteger(chainId)
    || chainId <= 0
    || !/^0x[a-fA-F0-9]{40}$/.test(manager)
    || !/^0x[a-fA-F0-9]{40}$/.test(verifier)
  ) {
    throw new EvidenceAttestationError("evidence_attestation_domain_invalid", 422);
  }
  return { chainId, manager, verifier };
}

export function createEvidenceAttestationClient({
  url,
  token,
  threshold,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const attestationUrl = endpoint(url);
  const authorization = String(token || "").trim();
  const required = Number(threshold);
  if (!authorization) throw new EvidenceAttestationError("evidence_attestation_token_missing");
  if (!Number.isSafeInteger(required) || required < 3) {
    throw new EvidenceAttestationError("evidence_attestation_threshold_invalid");
  }
  if (typeof fetchImpl !== "function") throw new EvidenceAttestationError("evidence_attestation_fetch_unavailable");

  async function attest({ action, digest, evidence, context, domain }) {
    if (!ACTIONS.has(action)) throw new EvidenceAttestationError("evidence_action_invalid", 422);
    if (!/^0x[a-fA-F0-9]{64}$/.test(String(digest || ""))) {
      throw new EvidenceAttestationError("evidence_digest_invalid", 422);
    }
    const verifiedDomain = attestationDomain(domain);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(attestationUrl, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "PolicyPool Coverage Evidence",
          version: "1",
          action,
          digest,
          domain: verifiedDomain,
          evidence: serializable(evidence),
          context: serializable(context || {}),
        }),
      });
    } catch (error) {
      const code = error?.name === "AbortError"
        ? "evidence_attestation_timeout"
        : "evidence_attestation_unreachable";
      throw new EvidenceAttestationError(code);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new EvidenceAttestationError(`evidence_attestation_rejected:${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new EvidenceAttestationError("evidence_attestation_response_invalid");
    }
    if (
      String(payload?.digest || "").toLowerCase() !== String(digest).toLowerCase()
      || !Array.isArray(payload?.signatures)
      || payload.signatures.length < required
      || payload.signatures.some((signature) => !/^0x[a-fA-F0-9]{130}$/.test(String(signature)))
    ) {
      throw new EvidenceAttestationError("evidence_attestation_response_invalid");
    }
    return payload.signatures;
  }

  return { attest };
}

export const __test = { serializable, attestationDomain };
