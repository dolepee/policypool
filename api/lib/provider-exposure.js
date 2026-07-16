function nonNegative(value, field) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${field}_invalid`);
  }
  if (parsed < 0n) throw new RangeError(`${field}_negative`);
  return parsed;
}

function minBigInt(...values) {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

export function computeProviderCoverageCapacity({
  requestedAtomic,
  jobValueAtomic,
  policyCapAtomic,
  providerBondAtomic,
  providerAvailableBondAtomic,
  providerOutstandingAtomic = 0,
  sharedReserveAvailableAtomic = 0,
  providerSharedOutstandingAtomic = 0,
  sharedExposureMultiplierBps = 0,
  sharedCoverageEnabled = false,
}) {
  const requested = nonNegative(requestedAtomic, "requested");
  const jobValue = nonNegative(jobValueAtomic, "job_value");
  const policyCap = nonNegative(policyCapAtomic, "policy_cap");
  const providerBond = nonNegative(providerBondAtomic, "provider_bond");
  const availableBond = nonNegative(providerAvailableBondAtomic, "provider_available_bond");
  const providerOutstanding = nonNegative(providerOutstandingAtomic, "provider_outstanding");
  const sharedAvailable = nonNegative(sharedReserveAvailableAtomic, "shared_reserve_available");
  const sharedOutstanding = nonNegative(providerSharedOutstandingAtomic, "provider_shared_outstanding");
  const multiplierBps = nonNegative(sharedExposureMultiplierBps, "shared_exposure_multiplier_bps");

  const requestedBound = minBigInt(requested, jobValue, policyCap);
  const aggregateProviderRoom = providerBond > providerOutstanding
    ? providerBond - providerOutstanding
    : 0n;
  const providerRoom = minBigInt(availableBond, aggregateProviderRoom);
  const providerFirstLossAtomic = minBigInt(requestedBound, providerRoom);

  let sharedCoverageAtomic = 0n;
  if (sharedCoverageEnabled && multiplierBps > 0n && requestedBound > providerFirstLossAtomic) {
    const grossSharedLimit = (providerBond * multiplierBps) / 10_000n;
    const providerSharedRoom = grossSharedLimit > sharedOutstanding
      ? grossSharedLimit - sharedOutstanding
      : 0n;
    sharedCoverageAtomic = minBigInt(
      requestedBound - providerFirstLossAtomic,
      sharedAvailable,
      providerSharedRoom,
    );
  }

  const capAtomic = providerFirstLossAtomic + sharedCoverageAtomic;
  return {
    eligible: capAtomic > 0n,
    capAtomic,
    providerFirstLossAtomic,
    sharedCoverageAtomic,
    requestedBoundAtomic: requestedBound,
    providerAggregateRoomAtomic: aggregateProviderRoom,
    sharedCoverageEnabled: Boolean(sharedCoverageEnabled),
    reason: capAtomic > 0n ? null : "provider_bond_capacity_unavailable",
  };
}

export function computeNetLossPayout({
  coverageCapAtomic,
  buyerPaidAtomic,
  escrowRefundAtomic = 0,
  otherRecoveryAtomic = 0,
}) {
  const cap = nonNegative(coverageCapAtomic, "coverage_cap");
  const paid = nonNegative(buyerPaidAtomic, "buyer_paid");
  const escrowRefund = nonNegative(escrowRefundAtomic, "escrow_refund");
  const otherRecovery = nonNegative(otherRecoveryAtomic, "other_recovery");
  const totalRecovery = escrowRefund + otherRecovery;
  const netLossAtomic = paid > totalRecovery ? paid - totalRecovery : 0n;
  const payoutAtomic = minBigInt(cap, netLossAtomic);
  return {
    payoutAtomic,
    netLossAtomic,
    totalRecoveryAtomic: totalRecovery,
    fullyRecovered: netLossAtomic === 0n,
  };
}
