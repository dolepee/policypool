import { encodePaymentRequiredHeader } from "@x402/core/http";
import { createChainService } from "./lib/chain.js";
import { createDirectA2mcpCoordinator, DirectA2mcpError } from "./lib/direct-a2mcp.js";
import { createDirectA2mcpState, DirectA2mcpStateError } from "./lib/direct-a2mcp-store.js";
import { createPolicyFeeEscrowClient, PolicyFeeEscrowError } from "./lib/policy-fee-escrow.js";
import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { createProviderRelay, ProviderRelayError } from "./lib/provider-relay.js";
import { createRelayGrantService } from "./lib/relay-grant.js";
import { createUniversalIssuer, UniversalIssuerError } from "./lib/universal-issuer.js";
import { universalConfiguration } from "./lib/universal-config.js";
import { createUniversalPolicyResolver } from "./lib/universal-policy.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";
import { header, sendJson } from "./lib/utils.js";

function directResourceUrl(configuration) {
  const origin = configuration.publicOrigin || "https://policypool.vercel.app";
  return new URL("/api/direct-a2mcp", origin).toString();
}

function feeChallenge(configuration, requirements) {
  return {
    x402Version: 2,
    resource: {
      url: directResourceUrl(configuration),
      description: "Refundable PolicyPool direct A2MCP coverage fee escrow",
      mimeType: "application/json",
    },
    accepts: [requirements],
  };
}

function errorStatus(error) {
  if (
    error instanceof DirectA2mcpError
    || error instanceof DirectA2mcpStateError
    || error instanceof ProviderRelayError
    || error instanceof PolicyFeeEscrowError
    || error instanceof UniversalIssuerError
  ) return error.status || 503;
  return 503;
}

export function createDirectA2mcpHandler(dependencies = {}) {
  const configuration = dependencies.configuration || universalConfiguration();
  const limiter = dependencies.limiter || createRateLimiter();
  let runtimeCoordinator = dependencies.coordinator;
  let runtimePolicyStore = dependencies.policyStore;
  let runtimeGrantService = dependencies.grantService;
  let runtimeChain = dependencies.chain;

  function coordinator() {
    if (runtimeCoordinator) return runtimeCoordinator;
    runtimePolicyStore ||= createProviderPolicyStore();
    runtimeGrantService ||= createRelayGrantService(dependencies);
    runtimeChain ||= createChainService();
    const policyResolver = dependencies.policyResolver || createUniversalPolicyResolver({
      ...dependencies,
      store: runtimePolicyStore,
    });
    const relay = dependencies.relay || createProviderRelay({
      ...dependencies,
      chain: runtimeChain,
      store: runtimePolicyStore,
      policyResolver,
      grantService: runtimeGrantService,
    });
    runtimeCoordinator = createDirectA2mcpCoordinator({
      state: dependencies.state || createDirectA2mcpState(dependencies),
      relay,
      feeEscrow: dependencies.feeEscrow || createPolicyFeeEscrowClient({
        ...dependencies,
        configuration,
      }),
      issuer: dependencies.issuer || createUniversalIssuer({ ...dependencies, configuration }),
      grantService: runtimeGrantService,
      chain: runtimeChain,
      configuration,
      now: dependencies.now,
    });
    return runtimeCoordinator;
  }

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        service: "PolicyPool Direct A2MCP Covered Checkout",
        enabled: configuration.ready === true
          && configuration.directA2mcpEnabled === true
          && Boolean(configuration.feeEscrow),
        transport: "direct_http_x402_only",
        marketplaceTaskCompatible: false,
        steps: [
          "probe_provider_and_quote_coverage",
          "authorize_provider_payment",
          "authorize_refundable_policy_fee",
          "execute_once_with_crash_safe_reconciliation",
        ],
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!configuration.ready || !configuration.directA2mcpEnabled || !configuration.feeEscrow) {
      return sendJson(res, 503, {
        ok: false,
        error: "direct_a2mcp_not_active",
        providerPaymentStatus: "not_authorized",
        policyFeeStatus: "not_authorized",
      });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const token = String(body.quoteToken || "").trim();
    const providerPaymentSignature = header(req, "provider-payment-signature");
    const policyFeePaymentSignature = header(req, "payment-signature") || header(req, "x-payment");
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: "direct-a2mcp",
      subject: token || body.buyer || `${body.agentId || ""}:${body.serviceId || ""}`,
      limit: 30,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);

    try {
      if (!token) {
        const result = await coordinator().quote(body);
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(result.paymentRequired));
        return sendJson(res, 402, {
          ok: false,
          stage: result.stage,
          quoteToken: result.quote.token,
          quote: result.quote,
          providerPaymentStatus: "authorization_required",
          policyFeeStatus: "not_authorized",
        });
      }
      if (!providerPaymentSignature) {
        return sendJson(res, 422, {
          ok: false,
          error: "provider_payment_signature_required",
          providerPaymentStatus: "authorization_required",
          policyFeeStatus: "not_authorized",
        });
      }
      if (!policyFeePaymentSignature) {
        const result = await coordinator().bind({
          token,
          providerRequest: body.providerRequest,
          providerPaymentSignature,
        });
        const challenge = feeChallenge(configuration, result.requirements);
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(challenge));
        return sendJson(res, 402, {
          ok: false,
          stage: result.stage,
          quoteToken: token,
          quote: result.quote,
          policyFeeAuthorization: result.authorization,
          providerPaymentStatus: "authorized_not_settled",
          policyFeeStatus: "authorization_required_refundable_escrow",
        });
      }
      const result = await coordinator().execute({
        token,
        providerRequest: body.providerRequest,
        providerPaymentSignature,
        policyFeePaymentSignature,
      });
      const status = result.lifecyclePending ? 202 : 200;
      return sendJson(res, status, {
        ...result,
        quoteToken: token,
        providerPaymentStatus: result.providerSettlementTransaction
          ? "settled"
          : "not_settled",
        policyFeeStatus: result.feeState === 2
          ? "captured"
          : result.feeState === 3
            ? "refunded_after_provider_settlement"
          : result.lifecyclePending
            ? "escrowed_or_reconciliation_pending"
            : "unknown",
      });
    } catch (error) {
      return sendJson(res, errorStatus(error), {
        ok: false,
        error: error?.code || "direct_a2mcp_unavailable",
        providerPaymentStatus: "not_confirmed",
        policyFeeStatus: "not_confirmed",
        retryRule: "retry_only_with_the_same_quote_and_both_original_signatures",
      });
    }
  };
}

export default createDirectA2mcpHandler();
