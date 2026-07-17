import { Receiver } from "@upstash/qstash";
import { createChainService } from "./lib/chain.js";
import { createDirectA2mcpReconciler } from "./lib/direct-a2mcp-reconciler.js";
import { createDirectA2mcpState } from "./lib/direct-a2mcp-store.js";
import { createPolicyFeeEscrowClient } from "./lib/policy-fee-escrow.js";
import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { createProviderRelay } from "./lib/provider-relay.js";
import { createRelayGrantService } from "./lib/relay-grant.js";
import { createUniversalIssuer } from "./lib/universal-issuer.js";
import { universalConfiguration } from "./lib/universal-config.js";
import { createUniversalPolicyResolver } from "./lib/universal-policy.js";
import { header, sendJson } from "./lib/utils.js";

function rawRequestBody(req) {
  if (typeof req.rawBody === "string") return req.rawBody;
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return "";
}

function requestUrl(req) {
  if (req.url?.startsWith("http")) return req.url;
  const proto = header(req, "x-forwarded-proto") || "https";
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  return `${proto}://${host}${req.url || "/api/reconcile-direct-a2mcp"}`;
}

async function authorized(req, dependencies) {
  if (dependencies.authorized === true) return true;
  if (typeof dependencies.authorized === "function") return Boolean(await dependencies.authorized(req));
  const expected = process.env.POLICYPOOL_OPERATOR_TOKEN || process.env.CRON_SECRET;
  if (!expected || header(req, "authorization") !== `Bearer ${expected}`) return false;
  const signature = header(req, "upstash-signature");
  if (!signature) return true;
  const currentSigningKey = dependencies.qstashCurrentSigningKey || process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = dependencies.qstashNextSigningKey || process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return false;
  const receiver = dependencies.qstashReceiver || new Receiver({ currentSigningKey, nextSigningKey });
  try {
    return await receiver.verify({
      signature,
      body: rawRequestBody(req),
      url: requestUrl(req),
      upstashRegion: header(req, "upstash-region") || undefined,
    });
  } catch {
    return false;
  }
}

function dryRunRequested(req) {
  const value = req.query?.dryRun ?? req.body?.dryRun;
  return value === true || value === "true" || value === "1";
}

export function createDirectA2mcpReconcileHandler(dependencies = {}) {
  const configuration = dependencies.configuration || universalConfiguration();
  let runtimeReconciler = dependencies.reconciler;
  let runtimePolicyStore = dependencies.relayStore;
  let runtimeGrantService = dependencies.grantService;
  let runtimePolicyResolver = dependencies.policyResolver;
  let runtimeRelay = dependencies.relay;
  let runtimeChain = dependencies.chain;

  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!await authorized(req, dependencies)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }
    if (!configuration.ready || !configuration.directA2mcpEnabled || !configuration.feeEscrow) {
      return sendJson(res, 503, { ok: false, error: "direct_a2mcp_not_active" });
    }
    try {
      if (!runtimeReconciler) {
        const chain = runtimeChain ||= createChainService();
        const relayStore = runtimePolicyStore ||= createProviderPolicyStore();
        const grantService = runtimeGrantService ||= createRelayGrantService(dependencies);
        const policyResolver = runtimePolicyResolver ||= createUniversalPolicyResolver({
          ...dependencies,
          store: relayStore,
        });
        const relay = runtimeRelay ||= createProviderRelay({
          ...dependencies,
          chain,
          store: relayStore,
          policyResolver,
          grantService,
          receiptVerifierAddress: configuration.relayAdapter,
        });
        runtimeReconciler = createDirectA2mcpReconciler({
          state: dependencies.state || createDirectA2mcpState(dependencies),
          relayStore,
          relay,
          issuer: dependencies.issuer || createUniversalIssuer({ ...dependencies, configuration }),
          feeEscrow: dependencies.feeEscrow || createPolicyFeeEscrowClient({
            ...dependencies,
            configuration,
          }),
          relaySigner: configuration.relaySigner,
          relayVerifier: configuration.relayAdapter,
          now: dependencies.now,
        });
      }
      const result = await runtimeReconciler.reconcile({ dryRun: dryRunRequested(req) });
      return sendJson(res, result.ok ? 200 : 503, result);
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "direct_a2mcp_reconciliation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createDirectA2mcpReconcileHandler();
