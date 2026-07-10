import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { header, sendJson, sha256 } from "./lib/utils.js";

const RELEASE_STATUSES = new Map([
  [5, "platform_job_admin_stopped"],
  [6, "platform_job_completed"],
  [7, "platform_job_closed_and_funds_returned"],
  [8, "platform_job_expired"],
  [9, "platform_arbitration_refunded_buyer"],
]);

function authorized(req) {
  const expected = process.env.POLICYPOOL_OPERATOR_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  return header(req, "authorization") === `Bearer ${expected}`;
}

export function createReconcileHandler(dependencies = {}) {
  let ledger = dependencies.ledger;
  let chain = dependencies.chain;
  const now = dependencies.now || (() => Date.now());
  return async function handler(req, res) {
    if (req.method !== "POST" && req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!dependencies.authorized && !authorized(req)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }
    try {
      ledger ||= createLedger();
      chain ||= createChainService();
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
            await ledger.markPayoutDue(updated);
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
            await ledger.markReleased(updated);
            changes.push({ receiptId: record.receiptId, from: "active", to: "released" });
          }
        } catch (error) {
          failures.push({
            receiptId: record.receiptId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return sendJson(res, 200, { ok: failures.length === 0, checked: records.length, changes, failures });
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
