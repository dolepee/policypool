import { observeOkxA2AClock, observeRelayClock } from "./coverage-clock.js";
import { verifyProviderRelayReceipt } from "./provider-relay.js";
import { sha256 } from "./utils.js";

const ONCHAIN_STATES = new Map([
  [1, "pending_start"],
  [2, "active"],
  [3, "released"],
  [4, "payout_due"],
  [5, "paid"],
  [6, "recovered_without_payout"],
]);

function evidenceHash(value) {
  return `0x${sha256(value)}`;
}

function isoFromSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000).toISOString() : null;
}

function transition(record, to, reason, evidence, now) {
  const observedAt = new Date(now).toISOString();
  const event = {
    from: record.state,
    to,
    reason,
    observedAt,
    evidence,
  };
  return {
    ...record,
    state: to,
    reconciledAt: observedAt,
    universalReconciliation: event,
    transitions: [
      ...(record.transitions || []),
      { ...event, transitionHash: `sha256:${sha256(event)}` },
    ],
  };
}

function isUniversal(record) {
  return Boolean(
    record?.universalCovenant?.covenantId
      && (record?.receipt?.version === "0.4.0" || record?.state === "compensation_required"),
  );
}

function covenantDeadline(record) {
  return record.receipt?.covenant?.deadline || record.universalReconciliation?.deadline || null;
}

function enrollmentClose(record) {
  return record.receipt?.covenant?.enrollmentClosedAt || null;
}

async function syncOnchain(record, { issuer, ledger, dryRun, now }) {
  const covenantId = record.universalCovenant.covenantId;
  const onchain = await issuer.getCovenant(covenantId);
  if (String(onchain.id).toLowerCase() !== covenantId.toLowerCase()) throw new Error("covenant_identity_mismatch");
  if (String(onchain.jobId).toLowerCase() !== String(record.targetOrder?.jobId || "").toLowerCase()) {
    throw new Error("covenant_job_mismatch");
  }
  const chainState = ONCHAIN_STATES.get(Number(onchain.state));
  if (!chainState) throw new Error(`covenant_state_invalid:${onchain.state}`);
  if (chainState === record.state) return { record, onchain, change: null };

  let synced = transition(record, chainState, "onchain_state_recovered", {
    covenantId,
    state: Number(onchain.state),
  }, now);
  const deadline = isoFromSeconds(onchain.deadline);
  if (deadline) synced = { ...synced, universalReconciliation: { ...synced.universalReconciliation, deadline } };
  if (!dryRun) synced = await ledger.transitionUniversal(synced, [record.state]);
  return {
    record: synced,
    onchain,
    change: { receiptId: record.receiptId, from: record.state, to: chainState, reason: "onchain_state_recovered" },
  };
}

async function a2aObservation(record, { chain, taskFetcher }) {
  const reference = record.targetOrder?.publicTaskReference;
  if (reference) {
    const task = await taskFetcher(reference);
    if (task.stale) throw new Error("okx_task_evidence_stale");
    if (String(task.jobId).toLowerCase() !== String(record.targetOrder.jobId).toLowerCase()) {
      throw new Error("okx_task_job_mismatch");
    }
    return task;
  }
  return {
    status: await chain.getJobStatus(record.targetOrder.jobId),
    submittedAt: null,
    completedAt: null,
    evidenceLimitation: "public_task_reference_unavailable",
  };
}

export function createUniversalReconciler({
  ledger,
  store,
  issuer,
  chain,
  taskFetcher,
  relaySigner,
  verifyRelayReceipt = verifyProviderRelayReceipt,
  now = () => Date.now(),
} = {}) {
  if (!ledger?.list || !ledger?.transitionUniversal) throw new Error("universal_reconciler_ledger_unavailable");
  if (!store?.getLatestRelayReceiptForJob) throw new Error("universal_reconciler_relay_store_unavailable");
  if (!issuer?.getCovenant) throw new Error("universal_reconciler_issuer_unavailable");
  if (!chain?.getJobStatus) throw new Error("universal_reconciler_chain_unavailable");
  if (typeof taskFetcher !== "function") throw new Error("universal_reconciler_task_fetcher_unavailable");
  if (!relaySigner) throw new Error("universal_reconciler_relay_signer_unavailable");

  async function apply(record, action, details, dryRun) {
    const covenantId = record.universalCovenant.covenantId;
    if (action === "release") {
      const reasonHash = evidenceHash({ action, receiptId: record.receiptId, ...details });
      if (!dryRun) await issuer.release(covenantId, reasonHash);
      const updated = transition(record, "released", details.reason, { ...details, reasonHash }, now());
      if (!dryRun) await ledger.transitionUniversal(updated, [record.state]);
      return { receiptId: record.receiptId, from: record.state, to: "released", reason: details.reason };
    }
    if (action === "mark_payout_due") {
      const breachEvidenceHash = evidenceHash({ action, receiptId: record.receiptId, ...details });
      if (!dryRun) await issuer.markPayoutDue(covenantId, breachEvidenceHash);
      const updated = transition(record, "payout_due", details.reason, { ...details, breachEvidenceHash }, now());
      if (!dryRun) await ledger.transitionUniversal(updated, [record.state]);
      return { receiptId: record.receiptId, from: record.state, to: "payout_due", reason: details.reason };
    }
    if (action === "expire_unstarted") {
      if (!dryRun) await issuer.expireUnstarted(covenantId);
      const updated = transition(record, "released", details.reason, details, now());
      if (!dryRun) await ledger.transitionUniversal(updated, [record.state]);
      return { receiptId: record.receiptId, from: record.state, to: "released", reason: details.reason };
    }
    throw new Error(`universal_reconciliation_action_unsupported:${action}`);
  }

  async function reconcileRecord(original, dryRun) {
    if (original.state === "compensation_required") {
      const covenantId = original.universalCovenant.covenantId;
      const onchain = await issuer.getCovenant(covenantId);
      if (Number(onchain.state) === 1 || Number(onchain.state) === 2) {
        if (!dryRun) await issuer.release(covenantId, evidenceHash({
          action: "abort_unsettled_coverage",
          receiptId: original.receiptId,
          reason: original.compensation?.reason || "coverage_fee_not_settled",
        }));
      } else if (![0, 3].includes(Number(onchain.state))) {
        throw new Error(`compensation_covenant_state_unsafe:${onchain.state}`);
      }
      if (!dryRun) await ledger.release(original);
      return {
        changes: [{
          receiptId: original.receiptId,
          from: "compensation_required",
          to: "aborted_without_charge",
          reason: original.compensation?.reason || "coverage_fee_not_settled",
        }],
        hold: null,
      };
    }
    const synced = await syncOnchain(original, { issuer, ledger, dryRun, now: now() });
    let record = synced.record;
    const changes = synced.change ? [synced.change] : [];
    if (!["pending_start", "active"].includes(record.state)) return { changes, hold: "terminal_or_inactive" };

    if (record.state === "pending_start") {
      const relayReceipt = await store.getLatestRelayReceiptForJob(record.targetOrder.jobId);
      if (!relayReceipt) {
        const closeMs = Date.parse(enrollmentClose(record) || "");
        if (Number.isFinite(closeMs) && now() > closeMs) {
          changes.push(await apply(record, "expire_unstarted", {
            reason: "coverage_clock_not_started_before_enrollment_close",
            enrollmentClosedAt: enrollmentClose(record),
          }, dryRun));
          return { changes, hold: null };
        }
        return { changes, hold: "relay_clock_not_started" };
      }
      if (!await verifyRelayReceipt(relayReceipt, relaySigner)) throw new Error("relay_receipt_signature_invalid");
      const observed = observeRelayClock({
        covenant: { ...record, targetJobId: record.targetOrder.jobId },
        relayReceipt,
        now: now(),
      });
      if (observed.action !== "start_clock") return { changes, hold: observed.reason };
      const deadline = new Date(
        Date.parse(observed.startedAt) + Number(record.receipt.target.slaSeconds) * 1_000,
      ).toISOString();
      if (!dryRun) {
        await issuer.startClock(
          record.universalCovenant.covenantId,
          observed.startedAt,
          evidenceHash({ relayReceiptId: relayReceipt.receiptId, requestId: observed.evidenceHash }),
        );
      }
      const started = transition(record, "active", observed.reason, {
        relayReceiptId: relayReceipt.receiptId,
        startedAt: observed.startedAt,
        deadline,
      }, now());
      record = { ...started, universalReconciliation: { ...started.universalReconciliation, deadline } };
      if (!dryRun) await ledger.transitionUniversal(record, ["pending_start"]);
      changes.push({ receiptId: record.receiptId, from: "pending_start", to: "active", reason: observed.reason });
      if (relayReceipt.clock?.delivered && relayReceipt.clock?.completedWithinSla) {
        changes.push(await apply(record, "release", {
          reason: "provider_response_delivered_within_sla",
          relayReceiptId: relayReceipt.receiptId,
          deliveredAt: relayReceipt.clock.completedAt,
        }, dryRun));
      }
      return { changes, hold: null };
    }

    const clockMode = record.receipt?.target?.clockMode || "verified_acceptance";
    let observed;
    let evidence;
    if (clockMode === "policypool_relay") {
      const relayReceipt = await store.getLatestRelayReceiptForJob(record.targetOrder.jobId);
      if (relayReceipt && !await verifyRelayReceipt(relayReceipt, relaySigner)) {
        throw new Error("relay_receipt_signature_invalid");
      }
      observed = observeRelayClock({
        covenant: { ...record, deadline: covenantDeadline(record) },
        relayReceipt,
        now: now(),
      });
      evidence = { relayReceiptId: relayReceipt?.receiptId || null };
    } else {
      const task = await a2aObservation(record, { chain, taskFetcher });
      observed = observeOkxA2AClock({ task, deadline: covenantDeadline(record), now: now() });
      evidence = {
        publicTaskId: task.publicTaskId || null,
        targetJobStatus: task.status,
        deliveredAt: task.submittedAt || task.completedAt || null,
        source: task.publicUrl || "X Layer task escrow current status",
      };
    }
    if (observed.action === "release" || observed.action === "mark_payout_due") {
      changes.push(await apply(record, observed.action, { ...evidence, ...observed }, dryRun));
      return { changes, hold: null };
    }
    return { changes, hold: observed.reason };
  }

  async function reconcile({ dryRun = false, limit = 250 } = {}) {
    const records = (await ledger.list(limit)).filter(isUniversal);
    const changes = [];
    const holds = [];
    const failures = [];
    for (const record of records) {
      try {
        const result = await reconcileRecord(record, dryRun);
        changes.push(...result.changes);
        if (result.hold && result.hold !== "terminal_or_inactive") {
          holds.push({ receiptId: record.receiptId, reason: result.hold });
        }
      } catch (error) {
        failures.push({
          receiptId: record.receiptId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: failures.length === 0,
      version: "0.4.0",
      dryRun,
      generatedAt: new Date(now()).toISOString(),
      checked: records.length,
      changes,
      holds,
      failures,
    };
  }

  return { reconcile, reconcileRecord };
}
