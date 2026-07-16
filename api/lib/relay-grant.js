import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress } from "viem";
import { clean, isBytes32, sha256, stableStringify } from "./utils.js";

export class RelayGrantError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "RelayGrantError";
    this.code = code;
    this.status = status;
  }
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new RelayGrantError("relay_grant_invalid");
  }
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value).digest();
}

function numericId(value, field) {
  const result = clean(value, 30).replace(/^#/, "");
  if (!/^\d{1,12}$/.test(result) || Number(result) <= 0) throw new RelayGrantError(`${field}_invalid`);
  return result;
}

export function createRelayGrantService({
  secret = process.env.POLICYPOOL_RELAY_GRANT_SECRET,
  now = () => Date.now(),
} = {}) {
  const key = String(secret || "").trim();
  if (Buffer.byteLength(key) < 32) throw new RelayGrantError("relay_grant_secret_not_configured", 503);

  function tokenForPayload(payload) {
    const body = stableStringify(payload);
    return `${encode(body)}.${hmac(key, body).toString("base64url")}`;
  }

  function issue(input) {
    if (!isBytes32(input?.covenantId)) throw new RelayGrantError("relay_grant_covenant_invalid");
    if (!isBytes32(input?.targetJobId)) throw new RelayGrantError("relay_grant_job_invalid");
    let buyer;
    try {
      buyer = getAddress(input?.buyer);
    } catch {
      throw new RelayGrantError("relay_grant_buyer_invalid");
    }
    const expiresAt = Date.parse(String(input?.expiresAt || ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new RelayGrantError("relay_grant_expiry_invalid");
    const payload = {
      version: "0.4.0",
      covenantId: input.covenantId.toLowerCase(),
      targetJobId: input.targetJobId.toLowerCase(),
      buyer,
      agentId: numericId(input.agentId, "relay_grant_agent_id"),
      serviceId: numericId(input.serviceId, "relay_grant_service_id"),
      issuedAt: new Date(now()).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    payload.grantId = `pprg-${sha256(payload).slice(0, 24)}`;
    return { token: tokenForPayload(payload), payload };
  }

  function resolve(token) {
    const [bodyToken, signatureToken, extra] = clean(token, 4_000).split(".");
    if (!bodyToken || !signatureToken || extra) throw new RelayGrantError("relay_grant_invalid");
    const body = decode(bodyToken);
    let supplied;
    try {
      supplied = Buffer.from(signatureToken, "base64url");
    } catch {
      throw new RelayGrantError("relay_grant_invalid");
    }
    const expected = hmac(key, body);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new RelayGrantError("relay_grant_invalid");
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new RelayGrantError("relay_grant_invalid");
    }
    if (payload.version !== "0.4.0" || !isBytes32(payload.covenantId) || !isBytes32(payload.targetJobId)) {
      throw new RelayGrantError("relay_grant_invalid");
    }
    if (Date.parse(payload.expiresAt) <= now()) throw new RelayGrantError("relay_grant_expired");
    return payload;
  }

  return { issue, resolve, tokenForPayload };
}
