import assert from "node:assert/strict";
import { createChainService } from "../api/lib/chain.js";
import { PAYMENT } from "../api/lib/config.js";
import { fetchOkxTaskPage } from "../api/lib/okx-task-page.js";
import { findPublishedPolicy } from "../api/lib/policy-registry.js";

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

const publicTask = await fetchOkxTaskPage("https://www.okx.ai/tasks/401277");
const resolved = await chain.resolveTargetOrderEvidence({
  jobId: publicTask.jobId,
  createdAt: publicTask.openedAt,
  acceptedAt: publicTask.acceptedAt,
});
assert.equal(publicTask.jobId, "0x567044bcd533567a6d874044accdffd06b8901bc9988e700b29741cd9d1070a1");
assert.equal(resolved.creationTxHash, "0xb09188606430acf7b8ca1c02b9ff8ad335937aef31b3b93c9c41abeadf750214");
assert.equal(resolved.acceptanceTxHash, "0x9f2970429e0f57b0ba59173e2ca5d5fb6040f47c5937ff35f560a8be8675a213");
assert.equal(resolved.creationBlock, "64981670");
assert.equal(resolved.acceptanceBlock, "64981787");

console.log("PolicyPool OKX task proof passed: public task URL resolves exact creation/acceptance evidence and binds buyer, job, provider, agent id, asset, amount, service type/hash, and status.");
