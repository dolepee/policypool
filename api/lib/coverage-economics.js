// Canonical coverage economics.
//
// External testers repeatedly misread the money: three different amounts appear
// in a coverage response (the job's value, the fee paid, the maximum payout) and
// nothing named their roles or said which one bounded the others. The numbers
// were never wrong; they were unexplained.
//
// This module is the single place that decides the approved cap, names which
// bound produced it, and renders the buyer-facing sentence. Preflight, the paid
// endpoint, and the receipt verifier all read it from here so the three surfaces
// cannot drift apart.

// Ordered deliberately: the first bound whose value equals the approved cap is
// the one reported. A buyer's first question is "why is my cap not what I asked
// for", so `requested_cap` is checked first (nothing cut them down), and the
// remaining bounds run most-specific to most-generic so a tie names the bound
// that actually explains the number rather than an incidental match.
export const CAP_BOUNDS = Object.freeze({
  REQUESTED: "requested_cap",
  TARGET_JOB_VALUE: "target_job_value",
  POLICY_CAP: "provider_policy_cap",
  PROVIDER_BOND_CAPACITY: "provider_bond_capacity",
  RESERVE_CAPACITY: "uncommitted_reserve_capacity",
  GLOBAL_MAXIMUM: "global_maximum",
});

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch {
    return fallback;
  }
}

// Money for humans. `formatUsdtAtomic` strips trailing zeros, which is right for
// a data field and wrong in a sentence: "Pay 0.1 USD₮0" reads like a truncation.
// Amounts in prose keep at least two decimal places.
export function formatMoney(atomic, decimals = 6) {
  const raw = toBigInt(atomic);
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

export function resolveCoverageCap({
  requestedAtomic,
  targetJobValueAtomic,
  policyCapAtomic,
  capacityAtomic,
  globalMaxAtomic,
  providerFunded = false,
}) {
  const bounds = [
    [CAP_BOUNDS.REQUESTED, toBigInt(requestedAtomic)],
    [CAP_BOUNDS.TARGET_JOB_VALUE, toBigInt(targetJobValueAtomic)],
    [CAP_BOUNDS.POLICY_CAP, toBigInt(policyCapAtomic)],
    [
      providerFunded ? CAP_BOUNDS.PROVIDER_BOND_CAPACITY : CAP_BOUNDS.RESERVE_CAPACITY,
      toBigInt(capacityAtomic),
    ],
    [CAP_BOUNDS.GLOBAL_MAXIMUM, toBigInt(globalMaxAtomic)],
  ];
  const approvedCapAtomic = bounds.reduce(
    (lowest, [, value]) => (value < lowest ? value : lowest),
    bounds[0][1],
  );
  const capBoundReason = bounds.find(([, value]) => value === approvedCapAtomic)?.[0]
    || CAP_BOUNDS.GLOBAL_MAXIMUM;
  return { approvedCapAtomic, capBoundReason };
}

// The approved cap and the maximum potential payout are the same number by
// construction. They are both named because a buyer reading one field should not
// have to infer that the other follows from it: the whole point of this module
// is that the relationship between the amounts is stated rather than implied.
export function coverageEconomics({
  requestedAtomic,
  targetJobValueAtomic,
  approvedCapAtomic,
  capBoundReason,
  serviceFeeAtomic,
  decimals = 6,
  symbol = "USD₮0",
}) {
  const approved = toBigInt(approvedCapAtomic);
  const fee = toBigInt(serviceFeeAtomic);
  return {
    targetJobValueAtomic: toBigInt(targetJobValueAtomic).toString(),
    coverageServiceFeeAtomic: fee.toString(),
    requestedCoverageCapAtomic: toBigInt(requestedAtomic).toString(),
    approvedCoverageCapAtomic: approved.toString(),
    maximumPotentialPayoutAtomic: approved.toString(),
    capBoundReason,
    summary: `Pay ${formatMoney(fee, decimals)} ${symbol} for a coverage receipt with a maximum potential payout of ${formatMoney(approved, decimals)} ${symbol}.`,
  };
}
