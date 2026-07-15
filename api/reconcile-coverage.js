import { Receiver } from "@upstash/qstash";
import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { createNotifier, reconciliationMessage } from "./lib/notifier.js";
import { header, sendJson, sha256 } from "./lib/utils.js";

const RELEASE_STATUSES = new Map([
  [5, "platform_job_admin_stopped"],
  [6, "platform_job_completed"],
  [7, "platform_job_closed_and_funds_returned"],
  [8, "platform_job_expired"],
  [9, "platform_arbitration_refunded_buyer"],
]);

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
  return `${proto}://${host}${req.url || "/api/reconcile-coverage"}`;
}

async function authorized(req, dependencies) {
  if (dependencies.authorized === true) return true;
  if (typeof dependencies.authorized === "function") return Boolean(await dependencies.authorized(req));
  const expected = process.env.POLICYPOOL_OPERATOR_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  if (header(req, "authorization") !== `Bearer ${expected}`) return false;

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

function requestedDryRun(req) {
  const value = req.query?.dryRun ?? req.body?.dryRun;
  return value === true || value === "true" || value === "1";
}

export function createReconcileHandler(dependencies = {}) {
  let ledger = dependencies.ledger;
  let chain = dependencies.chain;
  let notifier = dependencies.notifier;
  const now = dependencies.now || (() => Date.now());
  return async function handler(req, res) {
    if (req.method !== "POST" && req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!await authorized(req, dependencies)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }
    try {
      ledger ||= createLedger();
      chain ||= createChainService();
      notifier ||= createNotifier();
      const dryRun = requestedDryRun(req);
      const records = await ledger.list(100);
      const changes = [];
      const failures = [];
      for (const record of records) {
        if (record.state !== "active" || !record.targetOrder?.jobId) continue;
        try {
          const status = await chain.getJobStatus(record.targetOrder.jobId);
          const deadlineMs = Date.parse(record.receipt?.covenant?.deadline || "");
          if (status === 1 && Number.isFinite(deadlineMs) && now() > deadlineMs) {
            const observedAt = new Date(now()).toISOString();
            const transition = {
              from: "active",
              to: "payout_due",
              observedAt,
              reason: "accepted_job_still_undelivered_after_deadline",
              targetJobStatus: status,
              source: "OKX task escrow getJobStatus(bytes32)",
            };
            const updated = {
              ...record,
              state: "payout_due",
              reconciledAt: observedAt,
              breach: {
                ...transition,
              },
              transitions: [
                ...(record.transitions || []),
                { ...transition, transitionHash: `sha256:${sha256(transition)}` },
              ],
            };
            if (!dryRun) await ledger.markPayoutDue(updated);
            changes.push({ receiptId: record.receiptId, from: "active", to: "payout_due" });
            continue;
          }
          if (RELEASE_STATUSES.has(status)) {
            const observedAt = new Date(now()).toISOString();
            const transition = {
              from: "active",
              to: "released",
              observedAt,
              reason: RELEASE_STATUSES.get(status),
              targetJobStatus: status,
              source: "OKX task escrow getJobStatus(bytes32)",
            };
            const updated = {
              ...record,
              state: "released",
              reconciledAt: observedAt,
              release: {
                ...transition,
              },
              transitions: [
                ...(record.transitions || []),
                { ...transition, transitionHash: `sha256:${sha256(transition)}` },
              ],
            };
            if (!dryRun) await ledger.markReleased(updated);
            changes.push({ receiptId: record.receiptId, from: "active", to: "released" });
          }
        } catch (error) {
          failures.push({
            receiptId: record.receiptId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const generatedAt = new Date(now()).toISOString();
      let notification = { sent: false, reason: dryRun ? "dry_run" : "no_changes" };
      if (!dryRun && (changes.length > 0 || failures.length > 0)) {
        notification = await notifier.send(reconciliationMessage({
          dryRun,
          changes,
          failures,
          checked: records.length,
          generatedAt,
        }));
      }
      return sendJson(res, failures.length > 0 ? 503 : 200, {
        ok: failures.length === 0,
        version: "0.3.0",
        dryRun,
        generatedAt,
        checked: records.length,
        changes,
        failures,
        notification,
      });
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "coverage_reconciliation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createReconcileHandler();
