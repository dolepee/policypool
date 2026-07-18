const FEE = { funded: 1, captured: 2, refunded: 3 };

export class DirectPolicyFeeError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = "DirectPolicyFeeError";
    this.code = code;
    this.status = status;
  }
}

function currentSeconds(now) {
  const value = Math.floor(now() / 1_000);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DirectPolicyFeeError("direct_policy_fee_clock_invalid");
  }
  return value;
}

export function directPolicyFeeSettlementAction(fee, nowSeconds) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new DirectPolicyFeeError("direct_policy_fee_clock_invalid");
  }
  const state = Number(fee?.state);
  if (state === FEE.captured) return "already_captured";
  if (state === FEE.refunded) return "already_refunded";
  if (state !== FEE.funded) throw new DirectPolicyFeeError("direct_policy_fee_state_invalid");
  const refundAvailableAt = Number(fee?.refundAvailableAt);
  if (!Number.isSafeInteger(refundAvailableAt) || refundAvailableAt <= 0) {
    throw new DirectPolicyFeeError("direct_policy_fee_refund_boundary_invalid");
  }
  return nowSeconds >= refundAvailableAt ? "refund" : "capture";
}

function terminalResult(fee, recovered = false) {
  const state = Number(fee?.state);
  if (state === FEE.captured) {
    return { action: "already_captured", fee, recovered, write: null };
  }
  if (state === FEE.refunded) {
    return { action: "already_refunded", fee, recovered, write: null };
  }
  return null;
}

export async function finalizeDirectPolicyFee({
  feeEscrow,
  feeId,
  captureEvidence,
  context = {},
  now = () => Date.now(),
} = {}) {
  if (!feeEscrow?.getFee || !feeEscrow?.capture || !feeEscrow?.refund) {
    throw new DirectPolicyFeeError("direct_policy_fee_escrow_unavailable");
  }

  let fee = await feeEscrow.getFee(feeId);
  let action = directPolicyFeeSettlementAction(fee, currentSeconds(now));
  const terminal = terminalResult(fee);
  if (terminal) return terminal;

  let write;
  try {
    write = action === "capture"
      ? await feeEscrow.capture(captureEvidence, context)
      : await feeEscrow.refund(feeId);
  } catch (initialError) {
    fee = await feeEscrow.getFee(feeId);
    const concurrentTerminal = terminalResult(fee, true);
    if (concurrentTerminal) return concurrentTerminal;

    const currentAction = directPolicyFeeSettlementAction(fee, currentSeconds(now));
    if (action !== "capture" || currentAction !== "refund") throw initialError;

    action = "refund";
    try {
      write = await feeEscrow.refund(feeId);
    } catch (refundError) {
      fee = await feeEscrow.getFee(feeId);
      const racedTerminal = terminalResult(fee, true);
      if (racedTerminal) return racedTerminal;
      throw refundError;
    }
  }

  fee = await feeEscrow.getFee(feeId);
  const completed = terminalResult(fee);
  if (!completed) throw new DirectPolicyFeeError("direct_policy_fee_transition_not_terminal");
  return { ...completed, action, write };
}
