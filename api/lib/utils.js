import { createHash } from "node:crypto";
import { formatUnits, isAddress, parseUnits } from "viem";

export function clean(value, max = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function header(req, name) {
  const key = name.toLowerCase();
  const direct = req.headers?.[key] ?? req.headers?.[name] ?? req.headers?.[name.toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct || "";
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value
    : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function parseUsdtAtomic(value, decimals = 6) {
  const normalized = clean(value ?? "", 40);
  if (!normalized) return 0n;
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) return 0n;
  try {
    return parseUnits(normalized, decimals);
  } catch {
    return 0n;
  }
}

export function formatUsdtAtomic(value, decimals = 6) {
  return formatUnits(BigInt(value), decimals);
}

export function isBytes32(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || ""));
}

export function isEvmAddress(value) {
  return isAddress(String(value || ""));
}

export function sendJson(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, PAYMENT-SIGNATURE, PROVIDER-PAYMENT-SIGNATURE, X-PAYMENT",
  );
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(payload, null, 2));
}
