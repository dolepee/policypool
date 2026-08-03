import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { clean, sendJson as rawSendJson } from "./lib/utils.js";
import { enrichCoverageResponse } from "./lib/coverage-state.js";
import {
  ReceiptIntegrityError,
  verifyReceiptIntegrity,
} from "./lib/receipt-integrity.js";

// Receipt lookups report the lifecycle state explicitly, so a reader never has
// to infer whether coverage is still in force from the raw receipt shape.
function sendJson(res, status, payload) {
  return rawSendJson(res, status, enrichCoverageResponse(payload, { httpStatus: status }));
}

// The reconciler writes a fresh event on every transition, so the convenience
// `deadline` it copies onto `universalReconciliation` when a relay clock starts
// is overwritten by the next release, payout-due, or settlement transition. The
// start event's own evidence survives in the retained transition log, so a relay
// covenant past its start still has an objective deadline: read it from there
// rather than reporting a covenant that never had one.
function reconciledDeadline(record) {
  const latest = record.universalReconciliation;
  if (latest?.deadline) return latest.deadline;
  if (latest?.evidence?.deadline) return latest.evidence.deadline;
  const transitions = Array.isArray(record.transitions) ? record.transitions : [];
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const entry = transitions[index];
    const deadline = entry?.deadline || entry?.evidence?.deadline;
    if (deadline) return deadline;
  }
  return null;
}

// Which reconciler owns a record decides what this endpoint can infer from a
// job status, and the two pipelines genuinely differ. A v0.4 covenant runs
// through observeOkxA2AClock, which compares the job's own resolution timestamp
// against the deadline. A v0.3 record runs through reconcile-coverage.js, which
// acts on status alone. Treating them alike either invents certainty or throws
// away certainty the record actually has.
function isUniversalRecord(record) {
  return Boolean(record?.universalCovenant?.covenantId && record?.receipt?.version === "0.4.0");
}

const DELIVERED_STATUS = 2;
// observeOkxA2AClock resolves every one of these by timestamp comparison.
const UNIVERSAL_TERMINAL_STATUSES = new Set([2, 3, 4, 5, 6, 7, 8, 9]);
// reconcile-coverage.js releases these from status alone, so a legacy record in
// one of them can only be released and never becomes payable.
const LEGACY_RELEASE_STATUSES = new Set([5, 6, 7, 8, 9]);

// A hint, never a verdict: the reconciler owns the transition. Its one
// obligation is to avoid asserting an answer it cannot actually reach, in
// either direction.
function candidacy({ record, clockMode, deadlinePassed, jobStatus }) {
  if (record.state !== "active") return false;
  const status = Number(jobStatus);

  // A relay covenant is clocked by the provider relay receipt, which this
  // endpoint never reads. observeRelayClock releases it outright when that
  // receipt shows delivery inside the SLA, so a record still sitting active
  // past its deadline may be awaiting that release rather than a payout, and
  // the ledger state alone cannot tell which.
  if (clockMode === "policypool_relay") return deadlinePassed ? null : false;

  if (isUniversalRecord(record)) {
    if (status === 1) return deadlinePassed;
    // Observing a job already terminal while its deadline is still ahead dates
    // the resolution before that deadline, so observeOkxA2AClock can only
    // release it. The timestamp is only genuinely needed once the deadline has
    // passed, where the resolution could fall on either side of it.
    if (UNIVERSAL_TERMINAL_STATUSES.has(status)) return deadlinePassed ? null : false;
    return false;
  }

  if (status === 1) return deadlinePassed;
  if (LEGACY_RELEASE_STATUSES.has(status)) return false;
  // A delivered job observed before its deadline is released, since observing
  // it there proves the delivery landed inside the SLA. Observed after it, the
  // legacy reconciler deliberately declines to guess and leaves the record for
  // evidence-based reconciliation, so this endpoint must not guess either.
  if (status === DELIVERED_STATUS) return deadlinePassed ? null : false;
  return false;
}

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
      // Reconciliation can persist a deliberately partial receipt projection
      // while a covenant transitions. Only a hash-bearing issued document is
      // a portable receipt and therefore subject to cross-origin integrity
      // verification here; paid replay remains strict for every receipt.
      if (record.receipt?.receiptHash) {
        try {
          verifyReceiptIntegrity(record.receipt);
        } catch (error) {
          if (!(error instanceof ReceiptIntegrityError)) throw error;
          return sendJson(res, 409, {
            ok: false,
            error: error.code,
            receiptId,
          });
        }
      }
      const jobStatus = record.targetOrder?.jobId
        ? await chain.getJobStatus(record.targetOrder.jobId)
        : null;
      // A started v0.4 relay covenant has its authoritative deadline computed
      // by the universal reconciler, not in the originally issued receipt, so
      // the receipt document alone under-reports it. Same precedence as the
      // reconciler's own covenantDeadline helper. The issued receipt is never
      // edited here: it is hash-committed, so the computed deadline travels
      // beside it rather than inside it.
      const receiptDeadline = record.receipt?.covenant?.deadline || null;
      const effectiveDeadline = receiptDeadline || reconciledDeadline(record);
      const deadlineMs = Date.parse(effectiveDeadline || "");
      const deadlinePassed = Number.isFinite(deadlineMs) && now() > deadlineMs;
      // A relay covenant is clocked by PolicyPool's own provider relay, and
      // observeRelayClock marks it payout due purely on non-delivery by that
      // deadline without ever reading marketplace job status. Applying the
      // legacy accepted-job predicate to it would report a covenant the
      // reconciler is about to pay out as not a candidate.
      const clockMode = record.receipt?.target?.clockMode || "verified_acceptance";
      const payoutDueCandidate = candidacy({ record, clockMode, deadlinePassed, jobStatus });
      // v0.4 transitions record their reason and evidence in
      // universalReconciliation and never populate record.release, so a
      // universally released covenant would otherwise report release: null and
      // lose its verified reason. Present one release shape regardless of
      // which pipeline produced it.
      const universal = record.universalReconciliation || null;
      const release = record.release
        || (record.state === "released" && universal?.to === "released"
          ? {
            from: universal.from,
            to: universal.to,
            reason: universal.reason,
            observedAt: universal.observedAt,
            source: "universal_reconciliation",
          }
          : null);
      return sendJson(res, 200, {
        ok: true,
        receiptId,
        state: record.state,
        receipt: record.receipt,
        liabilityAtomic: record.liabilityAtomic,
        targetJobStatus: jobStatus,
        reconciliation: {
          deadline: effectiveDeadline,
          deadlineSource: receiptDeadline
            ? "issued_receipt"
            : (effectiveDeadline ? "universal_reconciliation" : null),
          deadlinePassed,
          payoutDueCandidate,
          clockMode,
          note: "State changes only after the reconciler reads the covenant's own clock and updates the durable ledger. A null payoutDueCandidate means this endpoint cannot decide from what it reads, because the outcome turns on evidence it does not fetch: the marketplace's own resolution timestamp for a terminal job, or the provider relay receipt for a relay covenant.",
        },
        payout: record.payout || null,
        release,
        universalReconciliation: universal,
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
