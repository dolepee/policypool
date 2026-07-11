import assert from "node:assert/strict";
import { createCoveragePreflightHandler } from "../api/coverage-preflight.js";
import { EvidenceError } from "../api/lib/chain.js";
import { PAYMENT } from "../api/lib/config.js";
import {
  fetchOkxTaskPage,
  OkxTaskPageError,
  parseOkxTaskPage,
  parseOkxTaskReference,
} from "../api/lib/okx-task-page.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const JOB_ID = `0x${"1".repeat(64)}`;
const CREATION_TX = `0x${"2".repeat(64)}`;
const ACCEPTANCE_TX = `0x${"3".repeat(64)}`;
const BUYER = "0x1111111111111111111111111111111111111111";

const task = {
  publicTaskId: "401999",
  publicUrl: "https://www.okx.ai/tasks/401999",
  jobId: JOB_ID,
  title: "Market evidence job",
  description: "Verify a public token market claim with evidence and source links.",
  tokenSymbol: "USDT",
  tokenAmount: "0.5",
  status: 1,
  displayStatus: 1,
  openedAt: "2026-07-11T10:00:00.000Z",
  acceptedAt: "2026-07-11T10:01:00.000Z",
  plannedAt: "2026-07-18T10:01:00.000Z",
  buyerAgentName: "Coverage buyer",
};

const chain = {
  async resolveTargetOrderEvidence() {
    return {
      jobId: JOB_ID,
      buyer: BUYER,
      creationTxHash: CREATION_TX,
      acceptanceTxHash: ACCEPTANCE_TX,
      creationBlock: "100",
      acceptanceBlock: "101",
    };
  },
  async verifyTargetOrder() {
    return {
      jobId: JOB_ID,
      creationTxHash: CREATION_TX,
      acceptanceTxHash: ACCEPTANCE_TX,
      creationBlock: "100",
      acceptanceBlock: "101",
      createdAt: task.openedAt,
      acceptedAt: task.acceptedAt,
      buyer: BUYER,
      provider: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
      agentId: "3465",
      asset: PAYMENT.asset,
      amountAtomic: "500000",
      serviceHash: `0x${"4".repeat(64)}`,
      serviceType: "A2A",
      serviceTypeVerified: true,
      listedServiceIdMapping: "manual_external_evidence_required",
      status: 1,
      statusLabel: "accepted",
    };
  },
  async getReserveBalance() {
    return 5_000_000n;
  },
};

const ledger = {
  async stats() {
    return {
      activeAtomic: "500000",
      pendingAtomic: "0",
      payoutDueAtomic: "0",
      committedAtomic: "500000",
      recordCount: 1,
    };
  },
};

const handler = createCoveragePreflightHandler({
  chain,
  ledger,
  taskFetcher: async () => task,
  now: () => Date.parse("2026-07-11T10:02:00.000Z"),
});

const discovery = await callHandler(handler, { method: "GET" });
assert.equal(discovery.statusCode, 200);
assert.equal(discovery.json().charged, false);
assert.equal(discovery.json().supportedTargets.length, 2);

const eligible = await callHandler(handler, {
  method: "POST",
  headers: { host: "policypool.test" },
  body: {
    targetAgent: "GlassDesk#3465",
    taskReference: task.publicUrl,
    requestedCoverageUSDT: "1",
  },
});
assert.equal(eligible.statusCode, 200);
assert.equal(eligible.json().eligible, true);
assert.equal(eligible.json().charged, false);
assert.equal(eligible.json().coverage.capUSDT, "0.5", "cap must not exceed target-job value");
assert.equal(eligible.json().coverage.availableUSDT, "4.5");
assert.equal(eligible.json().paidRequest.payerMustEqualTargetBuyer.toLowerCase(), BUYER.toLowerCase());
assert.equal(eligible.json().paidRequest.body.targetCreationTxHash, CREATION_TX);
assert.equal(eligible.json().paidRequest.body.targetAcceptanceTxHash, ACCEPTANCE_TX);
assert.equal(eligible.json().paidRequest.body.jobDescription, task.description);
assert.equal(eligible.json().paidRequest.endpoint, "https://policypool.test/api/covered-job-receipt");

let fetchedUnknown = false;
const unknown = await callHandler(createCoveragePreflightHandler({
  taskFetcher: async () => {
    fetchedUnknown = true;
    return task;
  },
}), {
  method: "POST",
  body: { targetAgent: "Unknown#9999", taskReference: task.publicUrl },
});
assert.equal(unknown.statusCode, 422);
assert.equal(unknown.json().error, "target_policy_not_registered");
assert.equal(fetchedUnknown, false, "unknown targets must be rejected before external work");

const completed = await callHandler(createCoveragePreflightHandler({
  chain: {
    ...chain,
    async verifyTargetOrder() {
      throw new EvidenceError("target_job_not_accepted:6");
    },
  },
  taskFetcher: async () => ({ ...task, status: 6 }),
}), {
  method: "POST",
  body: { targetAgent: "GlassDesk#3465", taskReference: task.publicUrl },
});
assert.equal(completed.statusCode, 200);
assert.equal(completed.json().eligible, false);
assert.equal(completed.json().reason, "target_job_not_accepted:6");

assert.equal(parseOkxTaskReference("401277"), 401277);
assert.equal(parseOkxTaskReference("https://www.okx.ai/tasks/401277"), 401277);
assert.throws(
  () => parseOkxTaskReference("https://example.com/tasks/401277"),
  (error) => error instanceof OkxTaskPageError && error.code === "okx_task_host_not_allowed",
);

const appState = {
  appContext: {
    initialProps: {
      TaskDetailData: {
        taskId: 401277,
        title: "Covered proof",
        description: "Verify a public token claim.",
        tokenSymbol: "USDT",
        tokenAmount: "0.5",
        status: 1,
        displayStatus: 1,
        createTime: 1783750704000,
        plannedTime: 1784355623000,
        timeline: [
          { label: "Open", time: 1783750706000 },
          { label: "Accepted", time: 1783750823000 },
        ],
        acceptCommands: [`Task ID: ${JOB_ID}.`],
      },
    },
  },
};
const validTaskHtml = `<html><script type="application/json" id="appState">${JSON.stringify(appState)}</script></html>`;
const parsed = parseOkxTaskPage(validTaskHtml, 401277);
assert.equal(parsed.jobId, JOB_ID);
assert.equal(parsed.openedAt, "2026-07-11T06:18:26.000Z");
assert.equal(parsed.acceptedAt, "2026-07-11T06:20:23.000Z");

let fetchAttempts = 0;
const retried = await fetchOkxTaskPage(401277, {
  attempts: 2,
  fetchImpl: async () => {
    fetchAttempts += 1;
    const body = fetchAttempts === 1
      ? validTaskHtml.replace('"taskId":401277', '"taskId":999999')
      : validTaskHtml;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  },
});
assert.equal(fetchAttempts, 2, "transient SSR task mismatches must be retried");
assert.equal(retried.jobId, JOB_ID);

console.log("PolicyPool coverage preflight passed: strict task parsing, no-charge declines, evidence binding, cap calculation, and paid-request assembly.");
