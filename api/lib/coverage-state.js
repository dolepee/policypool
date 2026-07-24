import { randomUUID } from "node:crypto";

// Buyer-facing lifecycle state and actionable error contract.
//
// Additive only. This module never removes, renames, or retypes an existing
// response field; it fills in explicit lifecycle and next-action fields that
// were previously implicit. External testing showed buyer agents could not
// distinguish "coverable" (eligible, nothing purchased) from "covered"
// (paid, receipt issued, protection in force), and that raw codes such as
// `target_job_not_accepted:6` were not interpretable without internal
// knowledge of OKX task status numbering.

export const COVERAGE_STATES = Object.freeze({
  NOT_CHECKED: "NOT_CHECKED",
  ELIGIBILITY_CHECKED: "ELIGIBILITY_CHECKED",
  NOT_COVERABLE: "NOT_COVERABLE",
  COVERABLE_NOT_PURCHASED: "COVERABLE_NOT_PURCHASED",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  COVERAGE_ACTIVE: "COVERAGE_ACTIVE",
  COVERAGE_RELEASED: "COVERAGE_RELEASED",
  PAYOUT_DUE: "PAYOUT_DUE",
  PAID_OUT: "PAID_OUT",
  COVERAGE_EXPIRED: "COVERAGE_EXPIRED",
  COVERAGE_CANCELLED: "COVERAGE_CANCELLED",
  RECONCILIATION_PENDING: "RECONCILIATION_PENDING",
  COVERAGE_STATE_UNRECOGNISED: "COVERAGE_STATE_UNRECOGNISED",
  REQUEST_FAILED: "REQUEST_FAILED",
});

const RECEIPT_STATE_TO_COVERAGE_STATE = Object.freeze({
  pending_start: COVERAGE_STATES.PAYMENT_PENDING,
  pending: COVERAGE_STATES.PAYMENT_PENDING,
  active: COVERAGE_STATES.COVERAGE_ACTIVE,
  released: COVERAGE_STATES.COVERAGE_RELEASED,
  payout_due: COVERAGE_STATES.PAYOUT_DUE,
  // Not a payout. `compensation_required` is the cleanup state written when
  // issuance aborts, its outcome is unconfirmed, or the fee never settled, so
  // the fee may not have been captured and no coverage may exist. Reporting it
  // as PAYOUT_DUE would tell a buyer money is owed for coverage never issued.
  compensation_required: COVERAGE_STATES.RECONCILIATION_PENDING,
  paid: COVERAGE_STATES.PAID_OUT,
  expired: COVERAGE_STATES.COVERAGE_EXPIRED,
  // The v0.4 universal reconciler persists these terminal outcomes. They must
  // be mapped explicitly; treating them as unrecognised, or worse as active,
  // would report a settled covenant as still protecting the buyer.
  recovered_without_payout: COVERAGE_STATES.COVERAGE_RELEASED,
  cancelled_unpaid: COVERAGE_STATES.COVERAGE_CANCELLED,
  cancelled: COVERAGE_STATES.COVERAGE_CANCELLED,
});

const NEXT_ACTION_BY_STATE = Object.freeze({
  [COVERAGE_STATES.NOT_CHECKED]: "RUN_ELIGIBILITY_CHECK",
  [COVERAGE_STATES.ELIGIBILITY_CHECKED]: "PURCHASE_COVERAGE",
  [COVERAGE_STATES.COVERABLE_NOT_PURCHASED]: "PURCHASE_COVERAGE",
  [COVERAGE_STATES.NOT_COVERABLE]: "CHOOSE_ANOTHER_TARGET_OR_RETRY",
  [COVERAGE_STATES.PAYMENT_PENDING]: "AWAIT_PAYMENT_SETTLEMENT",
  [COVERAGE_STATES.COVERAGE_ACTIVE]: "NONE_COVERAGE_IN_FORCE",
  [COVERAGE_STATES.COVERAGE_RELEASED]: "NONE_TARGET_DELIVERED_WITHIN_SLA",
  [COVERAGE_STATES.PAYOUT_DUE]: "AWAIT_PAYOUT",
  [COVERAGE_STATES.PAID_OUT]: "NONE_PAYOUT_COMPLETE",
  [COVERAGE_STATES.COVERAGE_EXPIRED]: "NONE_COVERAGE_ENDED",
  [COVERAGE_STATES.COVERAGE_CANCELLED]: "NONE_COVERAGE_CANCELLED",
  [COVERAGE_STATES.RECONCILIATION_PENDING]: "AWAIT_RECONCILIATION",
  [COVERAGE_STATES.COVERAGE_STATE_UNRECOGNISED]: "READ_THE_RECEIPT_DIRECTLY",
  [COVERAGE_STATES.REQUEST_FAILED]: "SEE_ERROR_NEXT_ACTION",
});

// Coverage is "in force" only while the obligation can still pay the buyer.
// Terminal states are deliberately excluded: a released or paid-out receipt
// proves coverage existed, not that the job is protected right now.
const IN_FORCE_STATES = new Set([
  COVERAGE_STATES.COVERAGE_ACTIVE,
  COVERAGE_STATES.PAYOUT_DUE,
]);

const PURCHASED_STATES = new Set([
  COVERAGE_STATES.PAYMENT_PENDING,
  COVERAGE_STATES.COVERAGE_ACTIVE,
  COVERAGE_STATES.COVERAGE_RELEASED,
  COVERAGE_STATES.PAYOUT_DUE,
  COVERAGE_STATES.PAID_OUT,
  COVERAGE_STATES.COVERAGE_EXPIRED,
]);

// OKX marketplace task status numbering, used to turn `target_job_not_accepted:N`
// into something a buyer can act on.
const TARGET_STATUS = Object.freeze({
  0: { label: "created", resolved: false },
  1: { label: "accepted", resolved: false },
  2: { label: "submitted", resolved: true },
  3: { label: "refused", resolved: true },
  4: { label: "disputed", resolved: true },
  5: { label: "admin_stopped", resolved: true },
  6: { label: "complete", resolved: true },
  7: { label: "closed_and_refunded", resolved: true },
  8: { label: "expired", resolved: true },
  9: { label: "arbitration_refunded", resolved: true },
});

const ERROR_CONTRACT = Object.freeze({
  target_job_not_accepted: {
    code: "TARGET_NOT_ACCEPTED",
    message: "The target job is not in an accepted state, so it cannot be covered.",
    retryable: false,
    nextAction: "Purchase coverage while the target job is accepted and before it resolves.",
  },
  okx_task_acceptance_timestamp_missing: {
    code: "ACCEPTANCE_EVIDENCE_PENDING",
    message: "The target job's acceptance is not yet visible in the public task index.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request. Do not create another marketplace task.",
  },
  requested_coverage_below_minimum: {
    code: "COVERAGE_BELOW_MINIMUM",
    message: "The requested coverage cap is below the minimum this service will underwrite.",
    retryable: false,
    nextAction: "Request a higher coverage cap, bounded by the target job value.",
  },
  registered_policy_not_active: {
    code: "POLICY_NOT_ACTIVE",
    message: "No active coverage policy is registered for this target agent and service.",
    retryable: false,
    nextAction: "Choose a target listed as coverable by the free eligibility check.",
  },
  registered_policy_sla_already_elapsed: {
    code: "TARGET_SLA_ALREADY_ELAPSED",
    message: "The target job's deadline has already passed, so coverage cannot begin.",
    retryable: false,
    nextAction: "Cover a job before its service deadline elapses.",
  },
  coverage_enrollment_window_closed: {
    code: "ENROLLMENT_WINDOW_CLOSED",
    message: "The enrollment window for this target job has closed.",
    retryable: false,
    nextAction: "Purchase coverage sooner after the target job is accepted.",
  },
  insufficient_uncommitted_reserve: {
    code: "RESERVE_CAPACITY_UNAVAILABLE",
    message: "The uncommitted reserve cannot currently back this coverage cap.",
    retryable: true,
    retryAfterSeconds: 60,
    nextAction: "Retry with a lower coverage cap, or retry later as covenants settle.",
  },
  insufficient_provider_bond_capacity: {
    code: "PROVIDER_BOND_CAPACITY_UNAVAILABLE",
    message: "The provider's first-loss bond cannot currently back this coverage cap.",
    retryable: true,
    retryAfterSeconds: 60,
    nextAction: "Retry with a lower coverage cap, or retry later as covenants settle.",
  },
  coverage_capacity_unavailable: {
    code: "CAPACITY_LOOKUP_UNAVAILABLE",
    message: "Coverage capacity could not be read while pricing this request.",
    retryable: true,
    retryAfterSeconds: 15,
    nextAction: "Retry the same request.",
  },
  coverage_policy_resolution_failed: {
    code: "POLICY_LOOKUP_UNAVAILABLE",
    message: "The coverage policy registry could not be read.",
    retryable: true,
    retryAfterSeconds: 15,
    nextAction: "Retry the same request.",
  },
  okx_task_fetch_failed: {
    code: "TARGET_LOOKUP_UNAVAILABLE",
    message: "The target job could not be read from OKX.",
    retryable: true,
    retryAfterSeconds: 15,
    nextAction: "Retry the same request.",
  },
  target_evidence_unavailable: {
    code: "TARGET_EVIDENCE_UNAVAILABLE",
    message: "On-chain evidence for the target job could not be read.",
    retryable: true,
    retryAfterSeconds: 15,
    nextAction: "Retry the same request.",
  },
  target_chain_head_unavailable: {
    code: "CHAIN_EVIDENCE_PENDING",
    message: "X Layer chain state could not be read while verifying the target job.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request.",
  },
  target_block_lookup_failed: {
    code: "CHAIN_EVIDENCE_PENDING",
    message: "The target job's acceptance block could not be read.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request.",
  },
  target_event_lookup_failed: {
    code: "CHAIN_EVIDENCE_PENDING",
    message: "The target job's on-chain acceptance event could not be read.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request.",
  },
  transaction_unconfirmed: {
    code: "CHAIN_EVIDENCE_PENDING",
    message: "The target job's acceptance transaction is not yet confirmed.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request.",
  },
  target_job_status_unavailable: {
    code: "TARGET_STATUS_UNAVAILABLE",
    message: "The target job's status could not be determined.",
    retryable: true,
    retryAfterSeconds: 10,
    nextAction: "Retry the same request.",
  },
  okx_task_reference_required: {
    code: "TARGET_REFERENCE_REQUIRED",
    message: "A target OKX.AI task reference is required.",
    retryable: false,
    nextAction: "Supply the target task URL or job ID.",
  },
  method_not_allowed: {
    code: "METHOD_NOT_ALLOWED",
    message: "This endpoint does not accept that HTTP method.",
    retryable: false,
    nextAction: "Use the documented HTTP method for this endpoint.",
  },
});

function setIfAbsent(target, key, value) {
  if (value === undefined) return;
  if (Object.prototype.hasOwnProperty.call(target, key)) return;
  target[key] = value;
}

function splitCode(raw) {
  const text = String(raw || "");
  const separator = text.indexOf(":");
  if (separator === -1) return { base: text, detail: null };
  return { base: text.slice(0, separator), detail: text.slice(separator + 1) };
}

// `target_job_not_accepted:6` carries the reason the buyer actually needs:
// the job already resolved, so no coverage can attach to it.
function refineTargetNotAccepted(detail) {
  const status = Number(detail);
  if (!Number.isInteger(status)) return null;
  const known = TARGET_STATUS[status];
  if (!known) return null;
  if (status === 0) {
    return {
      code: "TARGET_NOT_YET_ACCEPTED",
      message: "The target job has been created but no provider has accepted it yet.",
      retryable: true,
      retryAfterSeconds: 15,
      nextAction: "Wait for the provider to accept the job, then purchase coverage.",
      targetState: known.label,
    };
  }
  if (known.resolved) {
    return {
      code: "TARGET_ALREADY_RESOLVED",
      message: `The target job already reached "${known.label}", so it can no longer be covered.`,
      retryable: false,
      nextAction: "Purchase coverage while the target job is accepted and before it resolves.",
      targetState: known.label,
    };
  }
  return { targetState: known.label };
}

export function describeFailure(rawCode) {
  const { base, detail } = splitCode(rawCode);
  const contract = ERROR_CONTRACT[base];
  const refinement = base === "target_job_not_accepted" ? refineTargetNotAccepted(detail) : null;
  if (!contract && !refinement) {
    return {
      code: base ? base.toUpperCase() : "REQUEST_FAILED",
      message: "The request could not be completed.",
      retryable: false,
      nextAction: "Review the error code and retry with corrected input.",
    };
  }
  return { ...(contract || {}), ...(refinement || {}) };
}

// Several failure paths reserve a receipt id before any receipt exists, so a
// bare id is not evidence of issuance. Require the receipt document itself.
function hasIssuedReceipt(payload) {
  const receipt = payload?.receipt;
  return Boolean(receipt && typeof receipt === "object" && !Array.isArray(receipt));
}

function deriveState(payload) {
  const receiptState = payload?.state ?? payload?.receipt?.state;
  // Any string state at all, including blank, is answered from this branch. A
  // ledger value that is present but unreadable is unrecognised, never active.
  if (typeof receiptState === "string") {
    const key = receiptState.trim().toLowerCase();
    // Own-property lookup only: an inherited key such as "constructor" would
    // otherwise resolve to a truthy value and be treated as a real state.
    const mapped = key && Object.prototype.hasOwnProperty.call(RECEIPT_STATE_TO_COVERAGE_STATE, key)
      ? RECEIPT_STATE_TO_COVERAGE_STATE[key]
      : null;
    // A ledger state this module does not recognise must never fall through to
    // the receipt heuristic below, which would report it as coverage in force.
    // Fail closed to an explicit unrecognised state instead.
    return mapped || COVERAGE_STATES.COVERAGE_STATE_UNRECOGNISED;
  }
  if (payload?.ok === false) return COVERAGE_STATES.REQUEST_FAILED;
  if (payload?.eligible === false) return COVERAGE_STATES.NOT_COVERABLE;
  if (payload?.charged === true || hasIssuedReceipt(payload)) return COVERAGE_STATES.COVERAGE_ACTIVE;
  if (payload?.eligible === true) return COVERAGE_STATES.COVERABLE_NOT_PURCHASED;
  return null;
}

export function enrichCoverageResponse(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const state = deriveState(payload);
  if (!state) return payload;

  const enriched = { ...payload };
  const hasReceipt = hasIssuedReceipt(payload);

  setIfAbsent(enriched, "coverageState", state);
  setIfAbsent(enriched, "covered", IN_FORCE_STATES.has(state));
  setIfAbsent(enriched, "paymentMade", PURCHASED_STATES.has(state) || payload.charged === true);
  setIfAbsent(enriched, "receiptIssued", hasReceipt || PURCHASED_STATES.has(state));

  if (state === COVERAGE_STATES.REQUEST_FAILED || state === COVERAGE_STATES.NOT_COVERABLE) {
    const failure = describeFailure(payload.error ?? payload.reason);
    setIfAbsent(enriched, "code", failure.code);
    setIfAbsent(enriched, "message", failure.message);
    setIfAbsent(enriched, "retryable", Boolean(failure.retryable));
    setIfAbsent(enriched, "retryAfterSeconds", failure.retryAfterSeconds);
    setIfAbsent(enriched, "targetState", failure.targetState);
    setIfAbsent(enriched, "nextAction", failure.nextAction ?? NEXT_ACTION_BY_STATE[state]);
    setIfAbsent(enriched, "charged", false);
  } else {
    setIfAbsent(enriched, "nextAction", NEXT_ACTION_BY_STATE[state]);
  }

  setIfAbsent(enriched, "correlationId", options.correlationId ?? randomUUID());
  return enriched;
}
