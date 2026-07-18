import { createHash, timingSafeEqual } from "node:crypto";
import {
  createEvidenceAttester,
  EvidenceAttesterError,
} from "../api/lib/evidence-attester.js";
import { header, sendJson } from "../api/lib/utils.js";

const MAX_REQUEST_BYTES = 512_000;
let runtimeAttester;

function authorized(req) {
  const expected = String(process.env.POLICYPOOL_ATTESTER_TOKEN || "").trim();
  const supplied = header(req, "authorization").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !supplied) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function requestBytes(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.byteLength;
  if (typeof req.rawBody === "string") return Buffer.byteLength(req.rawBody);
  if (typeof req.body === "string") return Buffer.byteLength(req.body);
  return Buffer.byteLength(JSON.stringify(req.body || {}));
}

function parsedBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (typeof req.body !== "string") throw new EvidenceAttesterError("attestation_body_invalid", 400);
  try {
    const value = JSON.parse(req.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
    return value;
  } catch {
    throw new EvidenceAttesterError("attestation_body_invalid", 400);
  }
}

export function createEvidenceAttestHandler({ attester } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    if (requestBytes(req) > MAX_REQUEST_BYTES) {
      return sendJson(res, 413, { ok: false, error: "attestation_body_too_large" });
    }
    try {
      runtimeAttester ||= attester || createEvidenceAttester();
      const result = await runtimeAttester.attest(parsedBody(req));
      return sendJson(res, 200, result);
    } catch (error) {
      const known = error instanceof EvidenceAttesterError;
      return sendJson(res, known ? error.status : 503, {
        ok: false,
        error: known ? error.code : "attestation_failed",
      });
    }
  };
}

export default createEvidenceAttestHandler();
