import assert from "node:assert/strict";
import { createChainService } from "../api/lib/chain.js";
import { PAYMENT } from "../api/lib/config.js";
import { describeFailure } from "../api/lib/coverage-state.js";
import { fetchOkxTaskPage, OkxTaskPageError } from "../api/lib/okx-task-page.js";
import { findPublishedPolicy } from "../api/lib/policy-registry.js";

const CLASSIFICATION_TX = `0x${"f".repeat(64)}`;
const CLASSIFICATION_PAYER = "0x1111111111111111111111111111111111111111";
const transferProbe = (client) => createChainService({ client }).verifySettlement({
  txHash: CLASSIFICATION_TX,
  payer: CLASSIFICATION_PAYER,
  amountAtomic: "1",
});

let missingHashPolls = 0;
await assert.rejects(
  transferProbe({
    async getTransactionReceipt() {
      throw { name: "TransactionReceiptNotFoundError" };
    },
    async getTransaction() {
      throw { name: "TransactionNotFoundError" };
    },
    async waitForTransactionReceipt() {
      missingHashPolls += 1;
      throw { name: "WaitForTransactionReceiptTimeoutError" };
    },
  }),
  (error) => error?.code === "transaction_not_found",
  "a hash absent after the polling grace period is caller evidence error, not pending",
);
assert.equal(missingHashPolls, 1, "an absent hash must receive the full receipt-polling grace period");
await assert.rejects(
  transferProbe({
    async getTransactionReceipt() {
      return null;
    },
    async getTransaction() {
      return null;
    },
    async waitForTransactionReceipt() {
      throw { name: "WaitForTransactionReceiptTimeoutError" };
    },
  }),
  (error) => error?.code === "transaction_not_found",
  "RPC clients that return null for an unknown hash must receive the same caller-error classification",
);
const missingContract = describeFailure("transaction_not_found", 200);
assert.equal(missingContract.code, "TRANSACTION_NOT_FOUND");
assert.equal(missingContract.retryable, false);
assert.match(missingContract.nextAction, /check the transaction hash and chain/i);

let propagationPolls = 0;
await assert.rejects(
  transferProbe({
    async getTransactionReceipt() {
      throw { name: "TransactionReceiptNotFoundError" };
    },
    async getTransaction() {
      throw { name: "TransactionNotFoundError" };
    },
    async waitForTransactionReceipt() {
      propagationPolls += 1;
      return { status: "success", logs: [] };
    },
  }),
  (error) => error?.code === "verified_transfer_event_missing",
  "a receipt that appears during the grace period must be verified rather than rejected as absent",
);
assert.equal(propagationPolls, 1);

await assert.rejects(
  transferProbe({
    async getTransactionReceipt() {
      throw { name: "TransactionReceiptNotFoundError" };
    },
    async getTransaction() {
      return { hash: CLASSIFICATION_TX };
    },
    async waitForTransactionReceipt() {
      throw { name: "WaitForTransactionReceiptTimeoutError" };
    },
  }),
  (error) => error?.code === "transaction_unconfirmed",
  "a transaction visible in the mempool but lacking a receipt remains retryable",
);
const pendingContract = describeFailure("transaction_unconfirmed", 503);
assert.equal(pendingContract.code, "CHAIN_EVIDENCE_PENDING");
assert.equal(pendingContract.retryable, true);

await assert.rejects(
  transferProbe({
    async getTransactionReceipt() {
      throw new Error("rpc unavailable");
    },
    async getTransaction() {
      throw new Error("must not run after a receipt lookup outage");
    },
  }),
  (error) => error?.code === "transaction_lookup_unavailable",
  "an RPC outage must not blame the caller's hash",
);
const outageContract = describeFailure("transaction_lookup_unavailable", 503);
assert.equal(outageContract.code, "CHAIN_LOOKUP_UNAVAILABLE");
assert.equal(outageContract.retryable, true);

const chain = createChainService();
const proof = await chain.verifyTargetOrder({
  jobId: "0x21eae51ceb84e2154b7d3ec67ffba7c6c001560f881d917888d5fb8d45bf66fd",
  creationTxHash: "0x7c735ea92c3a1aee821e27f4d428e0571ae7d06f4ba1218cfd78b0b34fc6c313",
  acceptanceTxHash: "0xcefec73ae88694b757a031a7d2e8be54ee476cf9b07053b86678c018d654e4b6",
  buyer: "0x8d295ff5d86f39e1a46eed220641f6151b520b8f",
  policy: findPublishedPolicy("GlassDesk#3465"),
  allowedStatuses: [6],
});

assert.equal(proof.agentId, "3465");
assert.equal(proof.provider.toLowerCase(), "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7");
assert.equal(proof.buyer.toLowerCase(), "0x8d295ff5d86f39e1a46eed220641f6151b520b8f");
assert.equal(proof.asset.toLowerCase(), PAYMENT.asset.toLowerCase());
assert.equal(proof.amountAtomic, "1000000");
assert.equal(proof.serviceHash, "0xaf5c67042babb4ef501331231013f82575dab215a7a45794c6ccaf6ce9dd3b63");
assert.equal(proof.serviceType, "A2A");
assert.equal(proof.serviceTypeVerified, true);
assert.equal(proof.listedServiceIdMapping, "manual_external_evidence_required");
assert.equal(proof.status, 6);
assert.equal(proof.acceptanceBlock, "64898927");
assert.equal(proof.creationBlock, "64898853");
assert.match(proof.createdAt, /^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
assert.match(proof.acceptedAt, /^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
assert.ok(Date.parse(proof.acceptedAt) >= Date.parse(proof.createdAt));

const resolvedFromCreationHint = await chain.resolveTargetOrderEvidenceFromHints({
  jobId: proof.jobId,
  createdAt: "2026-07-10T07:18:09.000Z",
});
assert.equal(resolvedFromCreationHint.creationTxHash, proof.creationTxHash);
assert.equal(resolvedFromCreationHint.acceptanceTxHash, proof.acceptanceTxHash);
assert.equal(resolvedFromCreationHint.buyer.toLowerCase(), proof.buyer.toLowerCase());
assert.equal(resolvedFromCreationHint.creationBlock, proof.creationBlock);
assert.equal(resolvedFromCreationHint.acceptanceBlock, proof.acceptanceBlock);

await assert.rejects(
  chain.verifyTargetOrder({
    jobId: proof.jobId,
    creationTxHash: proof.creationTxHash,
    acceptanceTxHash: proof.acceptanceTxHash,
    buyer: "0x1111111111111111111111111111111111111111",
    policy: findPublishedPolicy("GlassDesk#3465"),
    allowedStatuses: [6],
  }),
  (error) => error?.code === "coverage_buyer_does_not_own_target_job",
  "a different wallet must not obtain coverage for someone else's job",
);

// Public task 401277, as recorded on X Layer. These are chain facts, so they
// hold whatever the marketplace chooses to render on its own page.
const PUBLIC_TASK_ID = 401277;
const PUBLIC_TASK_JOB_ID = "0x567044bcd533567a6d874044accdffd06b8901bc9988e700b29741cd9d1070a1";
const PUBLIC_TASK_OPENED_AT = "2026-07-11T06:18:26.000Z";
const PUBLIC_TASK_ACCEPTED_AT = "2026-07-11T06:20:23.000Z";

const resolved = await chain.resolveTargetOrderEvidence({
  jobId: PUBLIC_TASK_JOB_ID,
  createdAt: PUBLIC_TASK_OPENED_AT,
  acceptedAt: PUBLIC_TASK_ACCEPTED_AT,
});
assert.equal(resolved.creationTxHash, "0xb09188606430acf7b8ca1c02b9ff8ad335937aef31b3b93c9c41abeadf750214");
assert.equal(resolved.acceptanceTxHash, "0x9f2970429e0f57b0ba59173e2ca5d5fb6040f47c5937ff35f560a8be8675a213");
assert.equal(resolved.creationBlock, "64981670");
assert.equal(resolved.acceptanceBlock, "64981787");

// The public task page is an external dependency we do not control. On
// 2026-07-25 OKX stopped publishing `timeline` and `acceptCommands` on the
// anonymous page, which withdrew both the acceptance instant and the on-chain
// task id a quote binds to. The invariant that has to hold in either world is
// that a page we cannot fully bind never yields a quote, and that the refusal
// does not invite a retry that can never succeed.
let publicTask = null;
try {
  publicTask = await fetchOkxTaskPage(`https://www.okx.ai/tasks/${PUBLIC_TASK_ID}`);
} catch (error) {
  assert.ok(error instanceof OkxTaskPageError, "public task failures must stay typed");
  const contract = describeFailure(error.code);
  assert.equal(
    contract.code,
    "PUBLIC_TASK_EVIDENCE_UNAVAILABLE",
    `unrecognised public task failure ${error.code}: classify it before shipping`,
  );
  assert.equal(contract.retryable, false, "withdrawn public evidence must not advertise a retry");
  console.log(`  note: public task evidence withdrawn upstream (${error.code}); on-chain binding asserted directly.`);
}

// If the marketplace restores the fields, the page must still agree exactly with
// the chain rather than quietly drifting from it.
if (publicTask) {
  assert.equal(publicTask.jobId, PUBLIC_TASK_JOB_ID);
  assert.equal(publicTask.openedAt, PUBLIC_TASK_OPENED_AT);
  assert.equal(publicTask.acceptedAt, PUBLIC_TASK_ACCEPTED_AT);
}

console.log("PolicyPool OKX task proof passed: on-chain evidence binds buyer, job, provider, agent id, asset, amount, service type/hash, and status; the public task page either agrees with it exactly or refuses without inviting a retry.");
