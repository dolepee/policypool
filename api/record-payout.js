import { createChainService } from "./lib/chain.js";
import { createLedger } from "./lib/ledger.js";
import { clean, header, isBytes32, sendJson, sha256 } from "./lib/utils.js";

function authorized(req) {
  const expected = process.env.POLICYPOOL_OPERATOR_TOKEN;
  return Boolean(expected && header(req, "authorization") === `Bearer ${expected}`);
}

export function createRecordPayoutHandler(dependencies = {}) {
  let ledger = dependencies.ledger;
  let chain = dependencies.chain;
  const now = dependencies.now || (() => Date.now());
  return async function handler(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    if (!dependencies.authorized && !authorized(req)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }
    const receiptId = clean(req.body?.receiptId, 80);
    const transaction = clean(req.body?.transaction || req.body?.txHash, 80);
    if (!receiptId || !isBytes32(transaction)) {
      return sendJson(res, 400, { ok: false, error: "receipt_id_and_payout_transaction_required" });
    }
    try {
      ledger ||= createLedger();
      chain ||= createChainService();
      const record = await ledger.get(receiptId);
      if (!record) return sendJson(res, 404, { ok: false, error: "coverage_receipt_not_found" });
      if (record.state !== "payout_due") {
        return sendJson(res, 409, { ok: false, error: "coverage_is_not_payout_due" });
      }
      const proof = await chain.verifyPayout({
        txHash: transaction,
        buyer: record.payer,
        amountAtomic: record.liabilityAtomic,
      });
      const verifiedAt = new Date(now()).toISOString();
      const transition = {
        from: "payout_due",
        to: "paid",
        observedAt: verifiedAt,
        transaction,
        amountAtomic: record.liabilityAtomic,
        recipient: record.payer,
      };
      const updated = {
        ...record,
        state: "paid",
        payout: {
          transaction,
          amountAtomic: record.liabilityAtomic,
          recipient: record.payer,
          verifiedAt,
          proof,
        },
        transitions: [
          ...(record.transitions || []),
          { ...transition, transitionHash: `sha256:${sha256(transition)}` },
        ],
      };
      const persisted = await ledger.markPaid(updated);
      if (!persisted || persisted.state !== "paid" || persisted.payout?.transaction !== transaction) {
        return sendJson(res, 409, { ok: false, error: "payout_record_state_conflict" });
      }
      return sendJson(res, 200, { ok: true, receiptId, state: "paid", payout: updated.payout });
    } catch (error) {
      return sendJson(res, 422, {
        ok: false,
        error: "payout_transaction_not_verified",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createRecordPayoutHandler();
