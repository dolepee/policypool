import assert from "node:assert/strict";
import { createManifestHandler } from "../api/manifest.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const fixedNow = () => Date.parse("2026-07-15T18:00:00.000Z");
const ledger = (committedAtomic) => ({
  stats: async () => ({ committedAtomic: String(committedAtomic) }),
});
const chain = (reserveAtomic) => ({
  getReserveBalance: async () => BigInt(reserveAtomic),
});
const getManifest = async ({
  committedAtomic = 0,
  reserveAtomic = 4_700_000,
  injectedLedger = ledger(committedAtomic),
  injectedChain = chain(reserveAtomic),
  configuredMaximumAtomic,
  capacityReadTimeoutMs,
} = {}) => {
  const response = await callHandler(createManifestHandler({
    now: fixedNow,
    ledger: injectedLedger,
    chain: injectedChain,
    configuredMaximumAtomic,
    capacityReadTimeoutMs,
  }), { method: "GET", url: "/api/manifest" });
  assert.equal(response.statusCode, 200);
  return response.json();
};

const manifest = await getManifest();
assert.equal(manifest.ok, true);
assert.equal(manifest.version, "0.3.0");
assert.equal(manifest.agent.id, "4674");
assert.equal(manifest.service.id, "33290");
assert.equal(manifest.service.priceAtomic, "100000");
assert.equal(manifest.quote.signed, true);
assert.equal(manifest.quote.fullEligibilityRecheckedAtSettlement, true);
assert.equal(manifest.quote.ambiguityBehavior, "fail_closed_without_settlement");
assert.equal(manifest.coverage.reserveSettlement, "operator_approved_and_independently_verified");
assert.equal(manifest.coverage.maximumAtomic, "4700000");
assert.equal(manifest.coverage.maximumConfiguredAtomic, "5000000");
assert.equal(manifest.coverage.maximumBasis, "lesser_of_configured_ceiling_and_uncommitted_reserve");
assert.equal(manifest.coverage.capacityStatus, "verified");
assert.equal(manifest.coverage.acceptingNewCoverage, true);
assert.equal(manifest.states.payoutExecution, "never_automatic_in_v0.3");
assert.equal(manifest.input.legacyFullBodyAccepted, true);
assert.equal(manifest.input.appliesTo, manifest.service.endpoint);
assert.deepEqual(manifest.preflightInput.modes.publicReference.required, [
  "targetAgent",
  "taskReference",
]);
assert.deepEqual(manifest.preflightInput.modes.directEvidence.required, [
  "targetAgent",
  "targetJobId",
  "targetCreationTxHash",
  "targetAcceptanceTxHash",
  "targetBuyer",
  "jobDescription",
]);
assert.equal(manifest.providers.length, 3);
assert.equal(manifest.providers.filter((provider) => provider.coverableNow).length, 2);
assert.equal(manifest.providers.find((provider) => provider.agentId === "3808")?.coverableNow, false);
assert.doesNotMatch(JSON.stringify(manifest), /private.key|seed phrase|fully autonomous/i);

const configuredCap = await getManifest({ reserveAtomic: 9_000_000 });
assert.equal(configuredCap.coverage.maximumAtomic, "5000000");

const liabilitiesReduceCapacity = await getManifest({
  committedAtomic: 1_200_000,
  reserveAtomic: 4_700_000,
});
assert.equal(liabilitiesReduceCapacity.coverage.maximumAtomic, "3500000");

const exhausted = await getManifest({
  committedAtomic: 4_700_000,
  reserveAtomic: 4_700_000,
});
assert.equal(exhausted.coverage.maximumAtomic, "0");
assert.equal(exhausted.coverage.acceptingNewCoverage, false);

const unavailable = await getManifest({
  injectedChain: {
    getReserveBalance: async () => {
      throw new Error("rpc unavailable");
    },
  },
});
assert.equal(unavailable.coverage.maximumAtomic, "0");
assert.equal(unavailable.coverage.maximumUSDT, "0");
assert.equal(unavailable.coverage.maximumBasis, "unavailable_fail_closed");
assert.equal(unavailable.coverage.capacityStatus, "unavailable");
assert.equal(unavailable.coverage.acceptingNewCoverage, false);

const timedOut = await getManifest({
  injectedChain: {
    getReserveBalance: async () => new Promise(() => {}),
  },
  capacityReadTimeoutMs: 5,
});
assert.equal(timedOut.coverage.maximumAtomic, "0");
assert.equal(timedOut.coverage.capacityStatus, "unavailable");
assert.equal(timedOut.coverage.acceptingNewCoverage, false);

for (const configuredMaximumAtomic of ["not-an-amount", "-1"]) {
  const invalidConfiguration = await getManifest({ configuredMaximumAtomic });
  assert.equal(invalidConfiguration.coverage.maximumAtomic, "0");
  assert.equal(invalidConfiguration.coverage.maximumBasis, "unavailable_fail_closed");
  assert.equal(invalidConfiguration.coverage.capacityStatus, "unavailable");
  assert.equal(invalidConfiguration.coverage.acceptingNewCoverage, false);
}

let probeDependencyCalls = 0;
const unusedLedger = {
  stats: async () => {
    probeDependencyCalls += 1;
    return { committedAtomic: "0" };
  },
};
const unusedChain = {
  getReserveBalance: async () => {
    probeDependencyCalls += 1;
    return 5_000_000n;
  },
};
const head = await callHandler(createManifestHandler({
  ledger: unusedLedger,
  chain: unusedChain,
}), { method: "HEAD", url: "/api/manifest" });
assert.equal(head.statusCode, 200);
assert.equal(probeDependencyCalls, 0);

let universalCalls = 0;
const universal = await callHandler(createManifestHandler({
  ledger: unusedLedger,
  chain: unusedChain,
  universalHandler: async (_req, res) => {
    universalCalls += 1;
    return res.status(200).send(JSON.stringify({ ok: true, version: "0.4.0", enabled: false }));
  },
}), {
  method: "GET",
  url: "/api/universal-manifest",
  query: { surface: "universal" },
});
assert.equal(universal.statusCode, 200);
assert.equal(universal.json().version, "0.4.0");
assert.equal(universalCalls, 1);
assert.equal(probeDependencyCalls, 0);

console.log("PolicyPool manifest gate passed: live capacity, fail-closed discovery, endpoint schemas, provider windows, and autonomy limits.");
