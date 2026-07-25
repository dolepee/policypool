import assert from "node:assert/strict";
import {
  CAP_BOUNDS,
  coverageEconomics,
  formatMoney,
  resolveCoverageCap,
} from "../api/lib/coverage-economics.js";

// The cap has always been correct. What was missing is the explanation: which of
// the five bounds actually produced this number. Each bound is exercised as the
// sole binding one, so a wrong reason cannot hide behind a right amount.
const base = {
  requestedAtomic: "5000000",
  targetJobValueAtomic: "5000000",
  policyCapAtomic: "5000000",
  capacityAtomic: "5000000",
  globalMaxAtomic: "5000000",
};

for (const [field, reason] of [
  ["requestedAtomic", CAP_BOUNDS.REQUESTED],
  ["targetJobValueAtomic", CAP_BOUNDS.TARGET_JOB_VALUE],
  ["policyCapAtomic", CAP_BOUNDS.POLICY_CAP],
  ["capacityAtomic", CAP_BOUNDS.RESERVE_CAPACITY],
  ["globalMaxAtomic", CAP_BOUNDS.GLOBAL_MAXIMUM],
]) {
  const resolved = resolveCoverageCap({ ...base, [field]: "500000" });
  assert.equal(resolved.approvedCapAtomic, 500000n, `${field} must bound the cap`);
  assert.equal(resolved.capBoundReason, reason, `${field} must be named as the binding reason`);
}

// Capacity is named for the pool that actually backs the covenant, since telling
// a provider-funded buyer their cap was cut by the shared reserve would be false.
assert.equal(
  resolveCoverageCap({ ...base, capacityAtomic: "500000", providerFunded: true }).capBoundReason,
  CAP_BOUNDS.PROVIDER_BOND_CAPACITY,
);
assert.equal(
  resolveCoverageCap({ ...base, capacityAtomic: "500000", providerFunded: false }).capBoundReason,
  CAP_BOUNDS.RESERVE_CAPACITY,
);

// Ties are resolved by declared precedence, not by argument order accident. A
// buyer who got exactly what they asked for is told so, even when an external
// bound happens to sit at the same number.
assert.equal(
  resolveCoverageCap({ ...base, requestedAtomic: "500000", targetJobValueAtomic: "500000" }).capBoundReason,
  CAP_BOUNDS.REQUESTED,
  "asking for exactly the job value is not a job-value restriction",
);
// When the buyer did not get what they asked for, the tie names the most
// specific external bound rather than the global maximum.
assert.equal(
  resolveCoverageCap({
    ...base,
    requestedAtomic: "5000000",
    targetJobValueAtomic: "500000",
    policyCapAtomic: "500000",
    globalMaxAtomic: "500000",
  }).capBoundReason,
  CAP_BOUNDS.TARGET_JOB_VALUE,
);

// Malformed or absent inputs must not throw or silently approve a cap.
assert.equal(resolveCoverageCap({}).approvedCapAtomic, 0n);
assert.equal(resolveCoverageCap({ ...base, capacityAtomic: null }).approvedCapAtomic, 0n);
assert.equal(resolveCoverageCap({ ...base, policyCapAtomic: "not-a-number" }).approvedCapAtomic, 0n);

// Money in prose keeps two decimals. formatUsdtAtomic strips trailing zeros,
// which is right for a data field and reads like truncation in a sentence.
assert.equal(formatMoney("100000"), "0.10");
assert.equal(formatMoney("500000"), "0.50");
assert.equal(formatMoney("1000000"), "1.00");
assert.equal(formatMoney("1500000"), "1.50");
assert.equal(formatMoney("1234567"), "1.234567");
assert.equal(formatMoney("0"), "0.00");

const economics = coverageEconomics({
  requestedAtomic: "5000000",
  targetJobValueAtomic: "1000000",
  approvedCapAtomic: "500000",
  capBoundReason: CAP_BOUNDS.POLICY_CAP,
  serviceFeeAtomic: "100000",
});
assert.equal(economics.targetJobValueAtomic, "1000000");
assert.equal(economics.coverageServiceFeeAtomic, "100000");
assert.equal(economics.requestedCoverageCapAtomic, "5000000");
assert.equal(economics.approvedCoverageCapAtomic, "500000");
assert.equal(economics.capBoundReason, CAP_BOUNDS.POLICY_CAP);
// The maximum potential payout is the approved cap by construction. Naming both
// is the point: the relationship is stated rather than left to be inferred.
assert.equal(
  economics.maximumPotentialPayoutAtomic,
  economics.approvedCoverageCapAtomic,
  "the maximum payout is the approved cap",
);
assert.equal(
  economics.summary,
  "Pay 0.10 USD₮0 for a coverage receipt with a maximum potential payout of 0.50 USD₮0.",
);

// Every atomic field is a decimal string, never a BigInt or a number, so JSON
// serialisation cannot throw and a large cap cannot lose precision.
for (const [key, value] of Object.entries(economics)) {
  if (!key.endsWith("Atomic")) continue;
  assert.equal(typeof value, "string", `${key} must serialise as a string`);
  assert.match(value, /^\d+$/, `${key} must be a plain decimal string`);
}

console.log("PolicyPool coverage economics verified: every bound names itself, ties follow declared precedence, and the buyer sentence states fee against maximum payout.");
