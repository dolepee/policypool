import assert from "node:assert/strict";
import { createPolicyFeeEscrowClient, PolicyFeeEscrowError } from "../api/lib/policy-fee-escrow.js";

const feeEscrow = "0x1000000000000000000000000000000000000001";
const evidenceVerifier = "0x2000000000000000000000000000000000000002";
const treasury = "0x3000000000000000000000000000000000000003";
const buyer = "0x4000000000000000000000000000000000000004";
const policyId = `0x${"11".repeat(32)}`;
const jobId = `0x${"22".repeat(32)}`;
const providerAuthorizationHash = `0x${"33".repeat(32)}`;
const feeId = `0x${"44".repeat(32)}`;
const nonce = `0x${"55".repeat(32)}`;
const covenantId = `0x${"66".repeat(32)}`;
const relayReceiptDigest = `0x${"77".repeat(32)}`;
const settlementTransaction = `0x${"88".repeat(32)}`;
const captureDigest = `0x${"99".repeat(32)}`;
const writes = [];
const attestations = [];

const publicClient = {
  async readContract({ functionName }) {
    if (functionName === "feeAmountAtomic") return 100000n;
    if (functionName === "treasury") return treasury;
    if (functionName === "authorizationNonce") return nonce;
    if (functionName === "authorizationId") return feeId;
    if (functionName === "captureEvidenceDigest") return captureDigest;
    if (functionName === "getFee") {
      return {
        buyer,
        covenantId,
        providerAuthorizationHash,
        amountAtomic: 100000n,
        fundedAt: 100n,
        authorizationValidBefore: 700n,
        refundAvailableAt: 820n,
        state: 1,
      };
    }
    assert.fail(`unexpected read ${functionName}`);
  },
  async simulateContract(request) {
    return { request };
  },
  async waitForTransactionReceipt() {
    return { status: "success", blockNumber: 123n };
  },
};
const walletClient = {
  async writeContract(request) {
    writes.push(request);
    return `0x${String(writes.length).padStart(64, "0")}`;
  },
};
const evidenceProvider = {
  async attest(input) {
    attestations.push(input);
    return [`0x${"aa".repeat(65)}`, `0x${"bb".repeat(65)}`, `0x${"cc".repeat(65)}`];
  },
};
const client = createPolicyFeeEscrowClient({
  configuration: {
    ready: true,
    feeEscrow,
    evidenceVerifier,
    evidenceAttestationUrl: "https://evidence.example/attest",
    evidenceThreshold: 3,
  },
  account: { address: "0x5000000000000000000000000000000000000005" },
  publicClient,
  walletClient,
  evidenceProvider,
  now: () => 500_000,
});

assert.deepEqual(await client.terms(), { amountAtomic: 100000n, treasury });
assert.deepEqual(await client.previewAuthorization({
  policyId,
  jobId,
  buyer,
  providerAuthorizationHash,
  validAfter: 0,
  validBefore: 700,
  providerAuthorizationValidBefore: 650,
}), { feeId, nonce, buyer });
await client.fund({
  buyer,
  policyId,
  jobId,
  providerAuthorizationHash,
  validAfter: 0,
  validBefore: 700,
  nonce,
  providerAuthorizationValidBefore: 650,
}, `0x${"12".repeat(65)}`);
assert.equal(writes[0].functionName, "fund");
assert.equal((await client.getFee(feeId)).state, 1);
await client.capture({
  feeId,
  covenantId,
  providerAuthorizationHash,
  relayReceiptDigest,
  providerSettlementTransaction: settlementTransaction,
  observedAt: 500,
}, { source: "verified-provider-relay" });
assert.equal(attestations[0].action, "capture_fee");
assert.equal(attestations[0].domain.manager, feeEscrow);
assert.equal(writes[1].functionName, "capture");
await client.refund(feeId);
assert.equal(writes[2].functionName, "refund");

assert.throws(
  () => createPolicyFeeEscrowClient({ configuration: { ready: true, evidenceVerifier } }),
  (error) => error instanceof PolicyFeeEscrowError && error.code === "policy_fee_escrow_not_configured",
);

console.log("PolicyPool fee escrow client passed: canonical authorization preview, simulated writes, quorum capture, reads, and refund.");
