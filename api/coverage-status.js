import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { clean, sendJson } from "./lib/utils.js";

export function createCoverageStatusHandler(dependencies = {}) {
  let ledger = dependencies.ledger;
  let chain = dependencies.chain;
  const now = dependencies.now || (() => Date.now());
  return async function handler(req, res) {
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const receiptId = clean(req.query?.receiptId || req.query?.id, 80);
    if (!receiptId) return sendJson(res, 400, { ok: false, error: "receipt_id_required" });
    try {
      ledger ||= createLedger();
      chain ||= createChainService();
      const record = await ledger.get(receiptId);
      if (!record) return sendJson(res, 404, { ok: false, error: "coverage_receipt_not_found" });
      const jobStatus = record.targetOrder?.jobId
        ? await chain.getJobStatus(record.targetOrder.jobId)
        : null;
      const deadlineMs = Date.parse(record.receipt?.covenant?.deadline || "");
      return sendJson(res, 200, {
        ok: true,
        receiptId,
        state: record.state,
        receipt: record.receipt,
        targetJobStatus: jobStatus,
        reconciliation: {
          deadlinePassed: Number.isFinite(deadlineMs) && now() > deadlineMs,
          payoutDueCandidate: record.state === "active"
            && jobStatus === 1
            && Number.isFinite(deadlineMs)
            && now() > deadlineMs,
          note: "State changes only after the reconciler reads the public job status and updates the durable ledger.",
        },
        payout: record.payout || null,
        release: record.release || null,
      });
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "coverage_status_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createCoverageStatusHandler();
