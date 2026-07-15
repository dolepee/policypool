import { createChainService } from "./lib/chain.js";
import { PAYMENT, COVERAGE, XLAYER } from "./lib/config.js";
import { createLedger } from "./lib/ledger.js";
import { formatUsdtAtomic, sendJson } from "./lib/utils.js";

function publicRecord(record) {
  const latestTransition = record.transitions?.at(-1) || null;
  return {
    receiptId: record.receiptId,
    receiptHash: record.receipt?.receiptHash || null,
    state: record.state,
    createdAt: record.createdAt,
    finalizedAt: record.finalizedAt || null,
    targetAgentId: record.receipt?.target?.agentId || null,
    targetJobId: record.targetOrder?.jobId || null,
    targetServiceType: record.targetOrder?.serviceType || null,
    targetServiceHash: record.targetOrder?.serviceHash || null,
    targetServiceTypeVerified: Boolean(record.targetOrder?.serviceTypeVerified),
    deadline: record.receipt?.covenant?.deadline || null,
    liabilityAtomic: record.liabilityAtomic,
    liabilityUSDT: formatUsdtAtomic(record.liabilityAtomic, PAYMENT.decimals),
    servicePaymentTx: record.settlement?.transaction || null,
    payoutTx: record.payout?.transaction || null,
    releaseReason: record.release?.reason || null,
    latestTransitionHash: latestTransition?.transitionHash || null,
  };
}

export function createCoverageLedgerHandler(dependencies = {}) {
  let ledger = dependencies.ledger;
  let chain = dependencies.chain;
  return async function handler(req, res) {
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    try {
      ledger ||= createLedger();
      chain ||= createChainService();
      const [stats, records, reserveBalance] = await Promise.all([
        ledger.stats(),
        ledger.list(50),
        chain.getReserveBalance(),
      ]);
      const committed = BigInt(stats.committedAtomic);
      return sendJson(res, 200, {
        ok: true,
        protocol: "PolicyPool Agent Coverage",
        version: "0.3.0",
        generatedAt: new Date().toISOString(),
        chain: { id: XLAYER.id, name: XLAYER.name },
        asset: { address: PAYMENT.asset, symbol: PAYMENT.symbol, decimals: PAYMENT.decimals },
        reserve: {
          wallet: COVERAGE.reserveWallet,
          balanceAtomic: reserveBalance.toString(),
          balanceUSDT: formatUsdtAtomic(reserveBalance, PAYMENT.decimals),
          committedAtomic: committed.toString(),
          committedUSDT: formatUsdtAtomic(committed, PAYMENT.decimals),
          availableAtomic: (reserveBalance > committed ? reserveBalance - committed : 0n).toString(),
          solvent: committed <= reserveBalance,
        },
        liabilities: stats,
        records: records.map(publicRecord),
      });
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: "coverage_ledger_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export default createCoverageLedgerHandler();
