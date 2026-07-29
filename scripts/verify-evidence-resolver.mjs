import assert from "node:assert/strict";
import { createChainService } from "../api/lib/chain.js";
import { EVIDENCE_RESOLVER, OKX_TASK } from "../api/lib/config.js";

const JOB_ID = `0x${"1".repeat(64)}`;
const CREATION_TX = `0x${"2".repeat(64)}`;
const ACCEPTANCE_TX = `0x${"3".repeat(64)}`;
const SECOND_ACCEPTANCE_TX = `0x${"4".repeat(64)}`;
const BUYER = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const LATEST_BLOCK = 5_000n;
const LATEST_TIMESTAMP = 200_000n;
const CREATION_BLOCK = 3_000n;
const ACCEPTANCE_BLOCK = 3_074n;
const CREATED_AT = new Date(Number(LATEST_TIMESTAMP - (LATEST_BLOCK - CREATION_BLOCK)) * 1_000).toISOString();
const CREATION_HINT_AT = new Date(Date.parse(CREATED_AT) + 90_000).toISOString();
const ACCEPTED_AT = new Date(Number(LATEST_TIMESTAMP - (LATEST_BLOCK - ACCEPTANCE_BLOCK)) * 1_000).toISOString();
const ACCEPTANCE_HINT_AT = new Date(Date.parse(ACCEPTED_AT) + 90_000).toISOString();

const addressTopic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const log = ({ topic, blockNumber, transactionHash, actor, removed = false }) => ({
  address: OKX_TASK.escrow,
  blockNumber: `0x${blockNumber.toString(16)}`,
  transactionHash,
  removed,
  topics: [topic, JOB_ID, addressTopic(actor)],
  data: "0x",
});
const creationLog = log({
  topic: OKX_TASK.createdTopic,
  blockNumber: CREATION_BLOCK,
  transactionHash: CREATION_TX,
  actor: BUYER,
});
const acceptanceLog = log({
  topic: OKX_TASK.acceptedTopic,
  blockNumber: ACCEPTANCE_BLOCK,
  transactionHash: ACCEPTANCE_TX,
  actor: PROVIDER,
});

function inside(blockNumber, fromBlock, toBlock) {
  return blockNumber >= BigInt(fromBlock) && blockNumber <= BigInt(toBlock);
}

function resolverClient({
  status = 1,
  acceptanceLogs = [acceptanceLog],
  latestBlock = LATEST_BLOCK,
  latestTimestamp = LATEST_TIMESTAMP,
  secondsPerBlock = 1n,
  failLogLookup = false,
  requestDelayMs = 0,
} = {}) {
  const requests = [];
  let statusReads = 0;
  let activeLogRequests = 0;
  let peakLogRequests = 0;
  return {
    requests,
    get statusReads() {
      return statusReads;
    },
    get peakLogRequests() {
      return peakLogRequests;
    },
    async getBlock(args) {
      if (!args) return { number: latestBlock, timestamp: latestTimestamp };
      const blockNumber = BigInt(args.blockNumber);
      return {
        number: blockNumber,
        timestamp: latestTimestamp - ((latestBlock - blockNumber) * secondsPerBlock),
      };
    },
    async getBlockNumber() {
      return latestBlock;
    },
    async request({ method, params }) {
      assert.equal(method, "eth_getLogs");
      const [filter] = params;
      requests.push(filter);
      activeLogRequests += 1;
      peakLogRequests = Math.max(peakLogRequests, activeLogRequests);
      try {
        if (requestDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
        }
        if (failLogLookup) throw new Error("rpc log lookup failed");
        const fromBlock = BigInt(filter.fromBlock);
        const toBlock = BigInt(filter.toBlock);
        assert.ok(toBlock >= fromBlock);
        assert.ok(
          toBlock - fromBlock + 1n <= 100n,
          `eth_getLogs range exceeded X Layer's 100-block limit: ${fromBlock}-${toBlock}`,
        );
        if (filter.topics[0] === OKX_TASK.createdTopic && inside(CREATION_BLOCK, fromBlock, toBlock)) {
          return [creationLog];
        }
        if (filter.topics[0] === OKX_TASK.acceptedTopic) {
          return acceptanceLogs.filter((entry) => inside(BigInt(entry.blockNumber), fromBlock, toBlock));
        }
        return [];
      } finally {
        activeLogRequests -= 1;
      }
    },
    async readContract() {
      statusReads += 1;
      return status;
    },
  };
}

const removedAcceptance = { ...acceptanceLog, removed: true };
const happyClient = resolverClient({ acceptanceLogs: [removedAcceptance, acceptanceLog] });
const happy = await createChainService({ client: happyClient }).resolveTargetOrderEvidenceFromHints({
  jobId: JOB_ID,
  createdAt: CREATION_HINT_AT,
});
assert.equal(happy.jobId, JOB_ID);
assert.equal(happy.buyer.toLowerCase(), BUYER.toLowerCase());
assert.equal(happy.creationTxHash, CREATION_TX);
assert.equal(happy.acceptanceTxHash, ACCEPTANCE_TX);
assert.equal(happy.creationBlock, CREATION_BLOCK.toString());
assert.equal(happy.acceptanceBlock, ACCEPTANCE_BLOCK.toString());
assert.equal(happyClient.statusReads, 1, "the current job status must be checked before the historical scan");

const automaticAcceptanceRequests = happyClient.requests.filter(
  (request) => request.topics[0] === OKX_TASK.acceptedTopic,
);
assert.equal(
  automaticAcceptanceRequests.length,
  1,
  "a typical acceptance in the first batch must not scan the remaining 30-minute window",
);
assert.equal(BigInt(automaticAcceptanceRequests[0].fromBlock), CREATION_BLOCK);

const driftedCadenceClient = resolverClient({ secondsPerBlock: 2n });
const driftedCadenceCreatedAt = new Date(
  Number(LATEST_TIMESTAMP - ((LATEST_BLOCK - CREATION_BLOCK) * 2n)) * 1_000,
).toISOString();
const drifted = await createChainService({ client: driftedCadenceClient }).resolveTargetOrderEvidenceFromHints({
  jobId: JOB_ID,
  createdAt: driftedCadenceCreatedAt,
});
assert.equal(drifted.creationBlock, CREATION_BLOCK.toString());
assert.equal(drifted.acceptanceBlock, ACCEPTANCE_BLOCK.toString());
assert.ok(
  driftedCadenceClient.requests.filter((request) => request.topics[0] === OKX_TASK.createdTopic).length > 3,
  "a changed block cadence must fall back to timestamp binary search instead of widening the log scan",
);

const ambiguousClient = resolverClient({
  acceptanceLogs: [
    acceptanceLog,
    {
      ...acceptanceLog,
      blockNumber: `0x${(ACCEPTANCE_BLOCK + 1n).toString(16)}`,
      transactionHash: SECOND_ACCEPTANCE_TX,
    },
  ],
});
await assert.rejects(
  createChainService({ client: ambiguousClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: CREATION_HINT_AT,
  }),
  (error) => error?.code === "target_event_ambiguous",
  "multiple indexed acceptance events must fail closed",
);

const unacceptedClient = resolverClient({ status: 0, acceptanceLogs: [] });
await assert.rejects(
  createChainService({ client: unacceptedClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: CREATION_HINT_AT,
  }),
  (error) => error?.code === "target_job_not_accepted:0",
  "a created but unaccepted job must remain retryable rather than ask for invented evidence",
);
assert.equal(unacceptedClient.statusReads, 1);
assert.equal(
  unacceptedClient.requests.filter((request) => request.topics[0] === OKX_TASK.acceptedTopic).length,
  0,
  "a job still in created state must not consume the 30-minute acceptance scan",
);

const lateAcceptanceClient = resolverClient({ status: 1, acceptanceLogs: [] });
await assert.rejects(
  createChainService({ client: lateAcceptanceClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: CREATION_HINT_AT,
  }),
  (error) => error?.code === "target_acceptance_time_hint_required",
  "an accepted job outside the bounded scan must ask for an acceptance-time hint",
);
assert.equal(lateAcceptanceClient.statusReads, 1);
const exhaustedAcceptanceRequests = lateAcceptanceClient.requests.filter(
  (request) => request.topics[0] === OKX_TASK.acceptedTopic,
);
assert.equal(
  exhaustedAcceptanceRequests.length,
  EVIDENCE_RESOLVER.maxAutomaticAcceptanceScanBlocks / 100,
  "a no-match search must scan the complete configured window, but no further",
);
assert.equal(
  BigInt(exhaustedAcceptanceRequests.at(-1).toBlock),
  CREATION_BLOCK + BigInt(EVIDENCE_RESOLVER.maxAutomaticAcceptanceScanBlocks) - 1n,
);

const futureClient = resolverClient();
await assert.rejects(
  createChainService({ client: futureClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: new Date(Number(LATEST_TIMESTAMP + 121n) * 1_000).toISOString(),
  }),
  (error) => error?.code === "target_creation_time_hint_in_future",
  "future search hints must not expand or distort the event scan",
);
assert.equal(futureClient.requests.length, 0);

const futureAcceptanceClient = resolverClient();
await assert.rejects(
  createChainService({ client: futureAcceptanceClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: CREATED_AT,
    acceptedAt: new Date(Number(LATEST_TIMESTAMP + 121n) * 1_000).toISOString(),
  }),
  (error) => error?.code === "target_acceptance_time_hint_in_future",
  "a future acceptance hint must be rejected before any event lookup",
);
assert.equal(futureAcceptanceClient.requests.length, 0);

const explicitHintClient = resolverClient({ requestDelayMs: 2 });
const explicit = await createChainService({ client: explicitHintClient }).resolveTargetOrderEvidenceFromHints({
  jobId: JOB_ID,
  createdAt: CREATION_HINT_AT,
  acceptedAt: ACCEPTANCE_HINT_AT,
});
assert.equal(explicit.creationTxHash, CREATION_TX);
assert.equal(explicit.acceptanceTxHash, ACCEPTANCE_TX);
assert.equal(explicitHintClient.statusReads, 0);
const explicitAcceptanceRequests = explicitHintClient.requests.filter(
  (request) => request.topics[0] === OKX_TASK.acceptedTopic,
);
assert.ok(
  explicitAcceptanceRequests.length <= 3,
  "an acceptance hint must use only the bounded ±120-block search rather than the 1,800-block scan",
);
assert.ok(
  explicitAcceptanceRequests.some((request) => (
    inside(ACCEPTANCE_BLOCK, request.fromBlock, request.toBlock)
  )),
);
assert.equal(
  explicitHintClient.peakLogRequests,
  1,
  "creation and late-acceptance hint scans must remain serial on the rate-limited public RPC",
);

const outageClient = resolverClient({ failLogLookup: true });
await assert.rejects(
  createChainService({ client: outageClient }).resolveTargetOrderEvidenceFromHints({
    jobId: JOB_ID,
    createdAt: CREATION_HINT_AT,
  }),
  (error) => error?.code === "target_event_lookup_failed",
  "RPC lookup failures must remain retryable infrastructure errors",
);

console.log("PolicyPool evidence resolver passed: untrusted time hints locate unique escrow events in bounded 100-block RPC chunks, derive buyer and transaction hashes, ignore removed logs, and fail closed on ambiguity, late acceptance, future hints, or RPC failure.");
