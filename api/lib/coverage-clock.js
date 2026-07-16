const RECOVERY_STATUSES = new Map([
  [5, "platform_job_admin_stopped"],
  [7, "platform_job_closed_and_funds_returned"],
  [8, "platform_job_expired"],
  [9, "platform_arbitration_refunded_buyer"],
]);

function timestamp(value, field) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new TypeError(`${field}_invalid`);
  return parsed;
}

export function observeOkxA2AClock({ task, deadline, now = Date.now() }) {
  const status = Number(task?.status);
  const deadlineMs = timestamp(deadline, "coverage_deadline");
  if (!Number.isSafeInteger(status)) return { action: "hold", reason: "target_status_unavailable" };
  if (status === 0) return { action: "hold", reason: "target_job_not_accepted" };
  if (status === 1) {
    return now > deadlineMs
      ? { action: "mark_payout_due", reason: "accepted_job_still_undelivered_after_deadline" }
      : { action: "hold", reason: "accepted_job_within_sla" };
  }
  if (RECOVERY_STATUSES.has(status)) {
    return {
      action: "release",
      reason: RECOVERY_STATUSES.get(status),
      recoveryFinalized: [7, 9].includes(status),
    };
  }
  if ([2, 3, 4, 6].includes(status)) {
    const deliveredAt = task.submittedAt || task.completedAt;
    if (!deliveredAt) return { action: "hold", reason: "delivery_timestamp_unavailable" };
    const deliveredAtMs = timestamp(deliveredAt, "delivery_timestamp");
    return deliveredAtMs <= deadlineMs
      ? { action: "release", reason: "service_delivered_within_sla", deliveredAt }
      : { action: "mark_payout_due", reason: "service_delivered_after_deadline", deliveredAt };
  }
  return { action: "hold", reason: `target_status_unsupported:${status}` };
}

export function observeRelayClock({ covenant, relayReceipt, now = Date.now() }) {
  if (covenant?.state === "pending_start") {
    if (!relayReceipt?.clock?.startedAt) return { action: "hold", reason: "relay_clock_not_started" };
    if (relayReceipt.provider?.targetJobId?.toLowerCase() !== covenant.targetJobId?.toLowerCase()) {
      return { action: "hold", reason: "relay_receipt_job_mismatch" };
    }
    return {
      action: "start_clock",
      reason: "verified_funded_request_reached_provider_relay",
      startedAt: relayReceipt.clock.startedAt,
      evidenceHash: relayReceipt.requestId,
    };
  }
  if (covenant?.state !== "active") return { action: "hold", reason: "covenant_not_active" };
  if (relayReceipt?.clock?.delivered && relayReceipt.clock.completedWithinSla) {
    return {
      action: "release",
      reason: "provider_response_delivered_within_sla",
      deliveredAt: relayReceipt.clock.completedAt,
    };
  }
  const deadlineMs = timestamp(covenant.deadline, "coverage_deadline");
  return now > deadlineMs
    ? { action: "mark_payout_due", reason: "provider_response_not_delivered_before_deadline" }
    : { action: "hold", reason: "provider_response_within_sla_window" };
}
