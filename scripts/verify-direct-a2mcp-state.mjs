import assert from "node:assert/strict";
import {
  createDirectA2mcpState,
  DirectA2mcpStateError,
  MemoryDirectA2mcpStore,
  RedisDirectA2mcpStore,
} from "../api/lib/direct-a2mcp-store.js";

let now = Date.parse("2026-07-17T12:00:00.000Z");
let sequence = 1;
const store = new MemoryDirectA2mcpStore({ now: () => now });
const state = createDirectA2mcpState({
  store,
  secret: "direct-a2mcp-state-test-secret-at-least-thirty-two-bytes",
  now: () => now,
  randomId: () => String(sequence++).padStart(32, "0"),
  ttlSeconds: 600,
  leaseSeconds: 120,
});

const issued = await state.issue({
  buyer: "0x4000000000000000000000000000000000000004",
  agentId: "3808",
  serviceId: "33461",
  requestHash: `sha256:${"11".repeat(32)}`,
  providerRequirementsHash: `sha256:${"22".repeat(32)}`,
});
assert.match(issued.token, /^ppd_[a-f0-9]{32}\.[a-f0-9]{64}$/);
const binding = {
  providerAuthorizationHash: `0x${"33".repeat(32)}`,
  jobId: `0x${"44".repeat(32)}`,
};
const bound = await state.bind(issued.token, binding);
assert.equal(bound.state, "bound");
assert.equal((await state.bind(issued.token, binding)).bindingHash, bound.bindingHash);
await assert.rejects(
  () => state.bind(issued.token, { ...binding, jobId: `0x${"55".repeat(32)}` }),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_quote_bind_state_mismatch",
);

const executionId = `sha256:${"66".repeat(32)}`;
assert.equal((await state.claim(issued.token, executionId)).status, "claimed");
assert.deepEqual((await state.listExecuting()).map((record) => record.id), [issued.id]);
const recoveryContext = {
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  providerPaymentSignature: "provider-payment-signature-sensitive-test-value",
};
await state.retainRecovery(issued.token, executionId, recoveryContext);
assert.deepEqual(await state.recoveryContext(issued.id, executionId), recoveryContext);
const encryptedExecution = await store.get(issued.id);
assert.equal(JSON.stringify(encryptedExecution).includes(recoveryContext.providerPaymentSignature), false);
assert.equal(JSON.stringify(encryptedExecution).includes(recoveryContext.providerRequest.target_url), false);
await assert.rejects(
  () => state.retainRecovery(issued.token, executionId, {
    ...recoveryContext,
    providerPaymentSignature: "substituted-provider-payment-signature",
  }),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_recovery_context_mismatch",
);
await assert.rejects(
  () => state.claim(issued.token, executionId),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_execution_in_progress",
);
await state.checkpoint(issued.token, executionId, "covenantIssued", { transactionHash: `0x${"77".repeat(32)}` });
await assert.rejects(
  () => state.release(issued.token, executionId),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_execution_irreversible",
);
now += 121_000;
const reclaimed = await state.claim(issued.token, executionId);
assert.equal(reclaimed.status, "reclaimed");
assert.equal(reclaimed.record.execution.stages.covenantIssued.transactionHash, `0x${"77".repeat(32)}`);
await assert.rejects(
  () => state.claim(issued.token, `sha256:${"88".repeat(32)}`),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_execution_execution_mismatch",
);
const completed = await state.complete(issued.token, executionId, { receiptId: "ppr-direct-test" });
assert.equal(completed.state, "complete");
assert.equal(completed.execution.recovery, undefined, "terminal records must discard the recovery secret");
assert.deepEqual(await state.listExecuting(), []);
const replay = await state.claim(issued.token, executionId);
assert.equal(replay.status, "complete");
assert.equal(replay.record.result.receiptId, "ppr-direct-test");

const releasable = await state.issue({ buyer: issued.buyer, requestHash: `sha256:${"99".repeat(32)}` });
await state.bind(releasable.token, binding);
await state.claim(releasable.token, executionId);
assert.equal((await state.release(releasable.token, executionId)).state, "bound");
assert.deepEqual(await state.listExecuting(), []);

const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("a") ? "b" : "a"}`;
await assert.rejects(
  () => state.resolve(tampered),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_quote_invalid",
);
const expiring = await state.issue({ buyer: issued.buyer, requestHash: `sha256:${"aa".repeat(32)}` });
const retained = await state.issue({ buyer: issued.buyer, requestHash: `sha256:${"bb".repeat(32)}` });
await state.bind(retained.token, binding);
await state.claim(retained.token, executionId);
now += 601_000;
await assert.rejects(
  () => state.resolve(expiring.token),
  (error) => error instanceof DirectA2mcpStateError && error.code === "direct_quote_not_found_or_expired",
);
assert.equal((await state.resolve(retained.token)).state, "executing");
assert.equal((await state.claim(retained.token, executionId)).status, "reclaimed");
assert.equal((await state.resolve(issued.token)).state, "complete");

let queueNow = Date.parse("2026-07-18T12:00:00.000Z");
let queueSequence = 1_000;
const queueStore = new MemoryDirectA2mcpStore({ now: () => queueNow });
const queueState = createDirectA2mcpState({
  store: queueStore,
  secret: "direct-a2mcp-fair-queue-secret-at-least-thirty-two-bytes",
  now: () => queueNow,
  randomId: () => String(queueSequence++).padStart(32, "0"),
  ttlSeconds: 600,
  leaseSeconds: 120,
});

async function createExecutingRecord(label) {
  const quote = await queueState.issue({ buyer: issued.buyer, requestHash: `sha256:${label.repeat(64)}` });
  await queueState.bind(quote.token, binding);
  await queueState.claim(quote.token, `sha256:${label.repeat(64)}`);
  queueNow += 1;
  return quote;
}

const oldestExecution = await createExecutingRecord("1");
for (let index = 0; index < 150; index += 1) {
  await queueState.issue({ buyer: issued.buyer, requestHash: `sha256:${"ab".repeat(32)}` });
}
assert.deepEqual(
  (await queueState.listExecuting(100)).map((record) => record.id),
  [oldestExecution.id],
  "newer probe-only quotes must never hide an executing record",
);

const secondExecution = await createExecutingRecord("2");
const thirdExecution = await createExecutingRecord("3");
assert.deepEqual(
  (await queueState.listExecuting(2)).map((record) => record.id),
  [oldestExecution.id, secondExecution.id],
);
queueNow += 10_000;
await queueState.markReconciled(oldestExecution.id);
await queueState.markReconciled(secondExecution.id);
assert.deepEqual(
  (await queueState.listExecuting(2)).map((record) => record.id),
  [thirdExecution.id, oldestExecution.id],
  "scanned holds must rotate behind an execution omitted by the batch limit",
);
await queueState.complete(
  thirdExecution.token,
  `sha256:${"3".repeat(64)}`,
  { receiptId: "ppr-direct-queue-test" },
);
assert.equal(
  (await queueState.listExecuting()).some((record) => record.id === thirdExecution.id),
  false,
  "completed executions must leave the executing index",
);

const redisMembers = ["missing", "terminal", "live-a", "live-b"];
const redisValues = new Map([
  ["test:quote:terminal", { id: "terminal", state: "complete" }],
  ["test:quote:live-a", { id: "live-a", state: "executing" }],
  ["test:quote:live-b", { id: "live-b", state: "executing" }],
]);
const redisQueueStore = new RedisDirectA2mcpStore({
  prefix: "test",
  redis: {
    async zrange(_key, start, end) { return redisMembers.slice(start, end + 1); },
    async mget(...keys) { return keys.map((key) => redisValues.get(key) || null); },
    async zrem(_key, ...ids) {
      for (const id of ids) {
        const index = redisMembers.indexOf(id);
        if (index >= 0) redisMembers.splice(index, 1);
      }
    },
  },
});
assert.deepEqual(
  (await redisQueueStore.listExecuting(2)).map((record) => record.id),
  ["live-a", "live-b"],
  "stale Redis index members must be removed without reducing the live batch",
);
assert.deepEqual(redisMembers, ["live-a", "live-b"]);

console.log("PolicyPool direct A2MCP state passed: signed quotes, retained execution recovery, idempotent completion, and a fair execution-only reconciliation queue immune to probe floods.");
