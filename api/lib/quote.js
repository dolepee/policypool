import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { clean, header, sha256 } from "./utils.js";

const TOKEN_PATTERN = /^ppq_([a-f0-9]{32})\.([a-f0-9]{64})$/;
const DEFAULT_TTL_SECONDS = 600;
const MINIMUM_SECRET_LENGTH = 32;

export class QuoteConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuoteConfigurationError";
  }
}

export class QuoteValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "QuoteValidationError";
    this.code = code;
  }
}

function quoteSecret(override) {
  const value = String(override || process.env.POLICYPOOL_QUOTE_SECRET || "");
  if (value.length < MINIMUM_SECRET_LENGTH) {
    throw new QuoteConfigurationError("POLICYPOOL_QUOTE_SECRET must contain at least 32 characters");
  }
  return value;
}

function signatureFor(id, secret) {
  return createHmac("sha256", secret).update(`policypool-quote:v1:${id}`).digest("hex");
}

function tokenFor(id, secret) {
  return `ppq_${id}.${signatureFor(id, secret)}`;
}

function parseToken(token, secret) {
  const match = TOKEN_PATTERN.exec(clean(token, 140));
  if (!match) throw new QuoteValidationError("coverage_quote_invalid");
  const [, id, suppliedSignature] = match;
  const expectedSignature = signatureFor(id, secret);
  const supplied = Buffer.from(suppliedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new QuoteValidationError("coverage_quote_invalid");
  }
  return id;
}

function quoteFromPayment(req) {
  const raw = header(req, "payment-signature");
  if (!raw) return "";
  try {
    const decoded = decodePaymentSignatureHeader(raw);
    return clean(decoded?.accepted?.extra?.policyPoolQuote, 140);
  } catch {
    return "";
  }
}

export function extractQuoteToken(req) {
  const queryToken = clean(req.query?.quote || req.query?.quoteId, 140);
  if (queryToken) return queryToken;
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const bodyToken = clean(body.quoteId || body.quote || body.input?.quoteId || body.payload?.quoteId, 140);
  return bodyToken || quoteFromPayment(req);
}

export function paymentRequirementsForQuote(requirements, token) {
  if (!token) return requirements;
  return {
    ...requirements,
    extra: {
      ...(requirements.extra || {}),
      policyPoolQuote: token,
    },
  };
}

export function createQuoteService({
  ledger,
  secret,
  now = () => Date.now(),
  randomId = () => randomBytes(16).toString("hex"),
  ttlSeconds = Number(process.env.POLICYPOOL_QUOTE_TTL_SECONDS || DEFAULT_TTL_SECONDS),
} = {}) {
  if (!ledger?.saveQuote || !ledger?.getQuote) {
    throw new QuoteConfigurationError("quote storage is unavailable");
  }
  const resolvedSecret = quoteSecret(secret);
  const configuredTtl = Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds
    : DEFAULT_TTL_SECONDS;

  async function issue({
    requestBody,
    buyer = null,
    policyHash,
    source,
    deadline = null,
  }) {
    const issuedAtMs = now();
    const deadlineMs = Date.parse(deadline || "");
    const deadlineTtl = Number.isFinite(deadlineMs)
      ? Math.floor((deadlineMs - issuedAtMs) / 1000)
      : configuredTtl;
    const effectiveTtl = Math.min(configuredTtl, deadlineTtl);
    if (!Number.isSafeInteger(effectiveTtl) || effectiveTtl <= 0) {
      throw new QuoteValidationError("coverage_quote_window_elapsed");
    }
    const id = randomId();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new QuoteConfigurationError("quote id generator returned an invalid id");
    const token = tokenFor(id, resolvedSecret);
    const dedupeKey = `sha256:${sha256({
      buyer: String(buyer || "").toLowerCase(),
      policyHash,
      targetJobId: requestBody?.targetJobId,
      requestedCoverageUSDT: requestBody?.requestedCoverageUSDT,
    })}`;
    const record = {
      id,
      version: 1,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + effectiveTtl * 1000).toISOString(),
      source,
      buyer,
      policyHash,
      dedupeKey,
      requestBody,
    };
    await ledger.saveQuote(record, effectiveTtl);
    return { ...record, token };
  }

  async function resolve(token) {
    const id = parseToken(token, resolvedSecret);
    const record = await ledger.getQuote(id);
    if (!record) throw new QuoteValidationError("coverage_quote_not_found_or_expired");
    if (Date.parse(record.expiresAt || "") <= now()) {
      throw new QuoteValidationError("coverage_quote_expired");
    }
    return { ...record, token };
  }

  async function resolveForBuyer(buyer) {
    const records = await ledger.findOpenQuotesByBuyer(String(buyer || "").toLowerCase());
    const live = records.filter((record) => Date.parse(record.expiresAt || "") > now());
    const canonical = new Map();
    for (const record of live) {
      const key = record.dedupeKey || record.id;
      const existing = canonical.get(key);
      if (!existing || Date.parse(record.issuedAt) > Date.parse(existing.issuedAt)) canonical.set(key, record);
    }
    if (canonical.size === 0) throw new QuoteValidationError("coverage_quote_not_found_or_expired");
    if (canonical.size > 1) throw new QuoteValidationError("coverage_quote_ambiguous_for_payer");
    const [record] = canonical.values();
    return { ...record, token: tokenFor(record.id, resolvedSecret) };
  }

  return { issue, resolve, resolveForBuyer };
}

export const __test = { parseToken, tokenFor };
