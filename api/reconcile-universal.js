import { Receiver } from "@upstash/qstash";
import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { createNotifier, reconciliationMessage } from "./lib/notifier.js";
import { fetchOkxTaskPage } from "./lib/okx-task-page.js";
import { createProviderPolicyStore } from "./lib/provider-policy-store.js";
import { createUniversalIssuer } from "./lib/universal-issuer.js";
import { universalConfiguration } from "./lib/universal-config.js";
import { createUniversalReconciler } from "./lib/universal-reconciler.js";
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
  return `${proto}://${host}${req.url || "/api/reconcile-universal"}`;
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

export function createUniversalReconcileHandler(dependencies = {}) {
  let runtimeReconciler = dependencies.reconciler;
  let runtimeNotifier = dependencies.notifier;
  const configuration = dependencies.configuration || universalConfiguration();
  const now = dependencies.now || (() => Date.now());

  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!await authorized(req, dependencies)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }
    if (!configuration.ready) {
      return sendJson(res, 503, {
        ok: false,
        error: "universal_reconciliation_not_active",
        missing: configuration.missing || [],
      });
    }
    try {
      runtimeReconciler ||= createUniversalReconciler({
        ledger: dependencies.ledger || createLedger(),
        store: dependencies.store || createProviderPolicyStore(),
        issuer: dependencies.issuer || createUniversalIssuer(dependencies),
        chain: dependencies.chain || createChainService(),
        taskFetcher: dependencies.taskFetcher || fetchOkxTaskPage,
        relaySigner: configuration.relaySigner,
        now,
      });
      const result = await runtimeReconciler.reconcile({ dryRun: dryRunRequested(req) });
      let notification = { sent: false, reason: result.dryRun ? "dry_run" : "no_changes" };
      if (!result.dryRun && (result.changes.length > 0 || result.failures.length > 0)) {
        runtimeNotifier ||= dependencies.notifier || createNotifier();
        notification = await runtimeNotifier.send(reconciliationMessage(result));
      }
      return sendJson(res, result.ok ? 200 : 503, { ...result, notification });
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "universal_reconciliation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createUniversalReconcileHandler();
