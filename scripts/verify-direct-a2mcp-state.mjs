import assert from "node:assert/strict";
import {
  createDirectA2mcpState,
  DirectA2mcpStateError,
  MemoryDirectA2mcpStore,
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
const replay = await state.claim(issued.token, executionId);
assert.equal(replay.status, "complete");
assert.equal(replay.record.result.receiptId, "ppr-direct-test");

const releasable = await state.issue({ buyer: issued.buyer, requestHash: `sha256:${"99".repeat(32)}` });
await state.bind(releasable.token, binding);
await state.claim(releasable.token, executionId);
assert.equal((await state.release(releasable.token, executionId)).state, "bound");

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

console.log("PolicyPool direct A2MCP state passed: signed quotes, short quote TTL, retained execution recovery, exclusive leases, crash reclaim, irreversible checkpoints, and idempotent completion.");
