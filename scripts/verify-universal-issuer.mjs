import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createUniversalIssuer, UniversalIssuerError } from "../api/lib/universal-issuer.js";

assert.throws(
  () => createUniversalIssuer({ configuration: { ready: false } }),
  (error) => error instanceof UniversalIssuerError && error.code === "universal_issuance_not_configured",
);

const account = privateKeyToAccount(
  "0x0f4b9f0c34b6d53088b7954f65427f99a9ed59daf4d8a9edff8f67fbb0231a0f",
);
const configuration = {
  ready: true,
  coverageManager: "0x4000000000000000000000000000000000000004",
  evidenceVerifier: "0x7000000000000000000000000000000000000007",
};
const writes = [];
const attestations = [];
const publicClient = {
  async simulateContract(request) {
    writes.push({ phase: "simulate", request });
    return { request };
  },
  async waitForTransactionReceipt({ hash }) {
    return { status: "success", transactionHash: hash, blockNumber: 123n };
  },
  async readContract(request) {
    if (request.functionName.endsWith("EvidenceDigest")) return `0x${"99".repeat(32)}`;
    return {
      id: `0x${"01".repeat(32)}`,
      policyId: `0x${"02".repeat(32)}`,
      jobId: `0x${"03".repeat(32)}`,
      provider: "0x5000000000000000000000000000000000000005",
      buyer: "0x6000000000000000000000000000000000000006",
      coverageCapAtomic: 500000n,
      buyerPaidAtomic: 500000n,
      issuedAt: 1n,
      startAt: 2n,
      deadline: 3n,
      enrollmentExpiresAt: 4n,
      payoutDueAt: 5n,
      slaSeconds: 300,
      payoutBasis: 1,
      clockMode: 1,
      state: 2,
      payoutAtomic: 0n,
      acceptanceEvidenceHash: `0x${"04".repeat(32)}`,
      breachEvidenceHash: `0x${"00".repeat(32)}`,
      recoveryEvidenceHash: `0x${"00".repeat(32)}`,
    };
  },
};
const walletClient = {
  async writeContract(request) {
    writes.push({ phase: "write", request });
    return `0x${String(writes.length).padStart(64, "0")}`;
  },
};
const evidenceProvider = {
  async attest(request) {
    attestations.push(request);
    return [`0x${"11".repeat(65)}`, `0x${"22".repeat(65)}`];
  },
};
const issuer = createUniversalIssuer({
  configuration,
  account,
  evidenceProvider,
  publicClient,
  walletClient,
  now: () => Date.parse("2026-07-16T12:10:00.000Z"),
});
const jobId = `0x${"11".repeat(32)}`;
const policyId = `0x${"22".repeat(32)}`;
const issued = await issuer.issue({
  policy: {
    onchainPolicyId: `onchain:${policyId}`,
    serviceFingerprint: `0x${"33".repeat(32)}`,
    providerWallet: "0x5000000000000000000000000000000000000005",
  },
  targetOrder: {
    jobId,
    buyer: "0x6000000000000000000000000000000000000006",
    amountAtomic: "500000",
    acceptedAt: "2026-07-16T12:00:00.000Z",
    creationTxHash: `0x${"44".repeat(32)}`,
    acceptanceTxHash: `0x${"55".repeat(32)}`,
  },
  coverageCapAtomic: "500000",
  enrollmentClosesAt: "2026-07-16T12:01:00.000Z",
});
assert.match(issued.covenantId, /^0x[a-f0-9]{64}$/);
assert.equal(issued.covenantId, issuer.previewCovenantId({
  policy: { onchainPolicyId: `onchain:${policyId}` },
  targetOrder: { jobId, buyer: "0x6000000000000000000000000000000000000006" },
}));
assert.equal(writes[0].request.functionName, "issue");
assert.equal(writes[0].request.args[0].policyId, policyId);
assert.equal(writes[0].request.args[0].coverageCapAtomic, 500000n);
assert.equal(writes[0].request.args[1].length, 2);

await issuer.startClock(issued.covenantId, "2026-07-16T12:00:10.000Z", `0x${"44".repeat(32)}`);
await issuer.expireUnstarted(issued.covenantId);
await issuer.markPayoutDue(issued.covenantId, `0x${"55".repeat(32)}`);
await issuer.settleNetLoss(issued.covenantId, 400000n, 0n, `0x${"66".repeat(32)}`);
await issuer.release(issued.covenantId, `0x${"77".repeat(32)}`);
assert.equal((await issuer.getCovenant(issued.covenantId)).state, 2);
assert.equal(attestations.length, 5);
assert.deepEqual(attestations.map((item) => item.action), ["issue", "start_clock", "breach", "settlement", "release"]);
for (const attestation of attestations) {
  assert.deepEqual(attestation.domain, {
    chainId: 196,
    manager: configuration.coverageManager,
    verifier: configuration.evidenceVerifier,
  });
}
assert.deepEqual(
  writes.filter((item) => item.phase === "simulate").map((item) => item.request.functionName),
  ["issue", "startClock", "expireUnstarted", "markPayoutDue", "settleNetLoss", "release"],
);

console.log("PolicyPool universal issuer passed: issue, clock start/expiry, release, breach, and net settlement transactions.");
