import assert from "node:assert/strict";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createDirectA2mcpHandler } from "../api/direct-a2mcp.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import { MemoryRateLimiter } from "../api/lib/rate-limit.js";

const buyer = "0x3000000000000000000000000000000000000003";
const quoteToken = `ppd_${"11".repeat(16)}.${"22".repeat(32)}`;
const requirements = {
  scheme: "exact",
  network: XLAYER.network,
  asset: PAYMENT.asset,
  amount: "100000",
  payTo: "0x1000000000000000000000000000000000000001",
  maxTimeoutSeconds: 500,
  extra: {
    name: PAYMENT.name,
    version: PAYMENT.version,
    assetTransferMethod: "eip3009",
    policyPoolDirectQuote: quoteToken,
    policyPoolAuthorizationNonce: `0x${"33".repeat(32)}`,
  },
};
const providerChallenge = {
  x402Version: 2,
  resource: {
    url: "https://warden.example/audit",
    description: "audit",
    mimeType: "application/json",
  },
  accepts: [{ ...requirements, amount: "500000", payTo: "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51" }],
};

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = JSON.parse(value); return this; },
    end() { return this; },
  };
}

function request({ body = {}, headers = {}, method = "POST" } = {}) {
  return {
    method,
    body,
    headers: { host: "policypool.example", ...headers },
    socket: { remoteAddress: "203.0.113.10" },
  };
}

const calls = { bind: 0, execute: 0, quote: 0 };
const coordinator = {
  async quote() {
    calls.quote += 1;
    return {
      stage: "provider_authorization_required",
      quote: { token: quoteToken, id: "direct-quote" },
      paymentRequired: providerChallenge,
    };
  },
  async bind() {
    calls.bind += 1;
    return {
      stage: "policy_fee_authorization_required",
      quote: { id: "direct-quote", covenantId: `0x${"44".repeat(32)}` },
      requirements,
      authorization: {
        from: buyer,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: requirements.extra.policyPoolAuthorizationNonce,
      },
    };
  },
  async execute() {
    calls.execute += 1;
    return {
      ok: true,
      replay: false,
      feeState: 2,
      coverageState: 3,
      providerSettlementTransaction: `0x${"55".repeat(32)}`,
      providerResponse: { status: 200, bodyBase64: "e30=" },
    };
  },
};
const handler = createDirectA2mcpHandler({
  coordinator,
  configuration: { ready: true, directA2mcpEnabled: true, feeEscrow: requirements.payTo },
  limiter: new MemoryRateLimiter(),
});

const discovery = response();
await handler(request({ method: "GET" }), discovery);
assert.equal(discovery.statusCode, 200);
assert.equal(discovery.body.marketplaceTaskCompatible, false);

const quoted = response();
await handler(request({ body: { buyer, agentId: "3808", serviceId: "33461" } }), quoted);
assert.equal(quoted.statusCode, 402);
assert.equal(quoted.body.stage, "provider_authorization_required");
assert.equal(decodePaymentRequiredHeader(quoted.headers["payment-required"]).resource.url, providerChallenge.resource.url);
assert.match(quoted.headers["access-control-allow-headers"], /PROVIDER-PAYMENT-SIGNATURE/);

const missingProvider = response();
await handler(request({ body: { quoteToken } }), missingProvider);
assert.equal(missingProvider.statusCode, 422);
assert.equal(missingProvider.body.error, "provider_payment_signature_required");

const bound = response();
await handler(request({
  body: { quoteToken, providerRequest: { target_url: "https://policypool.example/api/covered-job-receipt" } },
  headers: {
    "provider-payment-signature": "provider-signature",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "http",
  },
}), bound);
assert.equal(bound.statusCode, 402);
assert.equal(bound.body.stage, "policy_fee_authorization_required");
const feeRequired = decodePaymentRequiredHeader(bound.headers["payment-required"]);
assert.equal(feeRequired.resource.url, "https://policypool.vercel.app/api/direct-a2mcp");
assert.deepEqual(feeRequired.accepts, [requirements]);

const executed = response();
await handler(request({
  body: { quoteToken, providerRequest: { target_url: "https://policypool.example/api/covered-job-receipt" } },
  headers: {
    "provider-payment-signature": "provider-signature",
    "payment-signature": "fee-signature",
  },
}), executed);
assert.equal(executed.statusCode, 200);
assert.equal(executed.body.providerPaymentStatus, "settled");
assert.equal(executed.body.policyFeeStatus, "captured");
assert.deepEqual(calls, { bind: 1, execute: 1, quote: 1 });

const disabled = createDirectA2mcpHandler({
  coordinator,
  configuration: { directA2mcpEnabled: false, feeEscrow: null },
  limiter: new MemoryRateLimiter(),
});
const disabledResponse = response();
await disabled(request(), disabledResponse);
assert.equal(disabledResponse.statusCode, 503);
assert.equal(disabledResponse.body.providerPaymentStatus, "not_authorized");

console.log("PolicyPool direct A2MCP handler passed: explicit transport discovery, separate provider/fee challenges, custom header CORS, and flag-off fail-closed behavior.");
