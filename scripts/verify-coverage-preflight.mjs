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
const QUOTE_SECRET = "policypool-test-quote-secret-32-bytes-minimum";

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

const quotes = new Map();
const ledger = {
  async saveQuote(record) {
    quotes.set(record.id, structuredClone(record));
    return record;
  },
  async getQuote(id) {
    return quotes.has(id) ? structuredClone(quotes.get(id)) : null;
  },
  async findOpenQuotesByBuyer(buyer) {
    return [...quotes.values()]
      .filter((record) => String(record.buyer).toLowerCase() === String(buyer).toLowerCase())
      .map((record) => structuredClone(record));
  },
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
  quoteSecret: QUOTE_SECRET,
});

const discovery = await callHandler(handler, { method: "GET" });
assert.equal(discovery.statusCode, 200);
assert.equal(discovery.json().charged, false);
assert.equal(discovery.json().supportedTargets.length, 3);
const wardenTarget = discovery.json().supportedTargets.find((target) => target.agentId === "3808");
assert.ok(wardenTarget, "Warden opt-in must be published in discovery");
assert.equal(wardenTarget.serviceIds[0], "33461");
assert.equal(wardenTarget.maxCoverageAtomic, "500000");
assert.equal(wardenTarget.coverageStatus, "pending_clock_adapter");
assert.equal(wardenTarget.coverableNow, false);
assert.equal(wardenTarget.clockSource, "provider_endpoint_receipt");
assert.match(wardenTarget.processingStart, /funded request reaches/i);
assert.equal(wardenTarget.exclusions.length, 4);

let fetchedPendingPolicy = false;
const pendingWarden = await callHandler(createCoveragePreflightHandler({
  taskFetcher: async () => {
    fetchedPendingPolicy = true;
    return task;
  },
}), {
  method: "POST",
  body: {
    targetAgent: "Warden#3808",
    taskReference: task.publicUrl,
    requestedCoverageUSDT: "0.5",
  },
});
assert.equal(pendingWarden.statusCode, 200);
assert.equal(pendingWarden.json().eligible, false);
assert.equal(pendingWarden.json().charged, false);
assert.equal(pendingWarden.json().reason, "provider_clock_evidence_not_supported");
assert.equal(pendingWarden.json().policy.coverageStatus, "pending_clock_adapter");
assert.equal(fetchedPendingPolicy, false, "inactive policies must decline before task fetching");

const belowMinimum = await callHandler(handler, {
  method: "POST",
  body: {
    targetAgent: "GlassDesk#3465",
    taskReference: task.publicUrl,
    requestedCoverageUSDT: "0.49",
  },
});
assert.equal(belowMinimum.statusCode, 200);
assert.equal(belowMinimum.json().eligible, false);
assert.equal(belowMinimum.json().charged, false);
assert.equal(belowMinimum.json().reason, "requested_coverage_below_minimum");

const eligible = await callHandler(handler, {
  method: "POST",
  headers: { host: "policypool.test" },
  body: {
    targetAgent: "GlassDesk#3465",
    taskReference: task.publicUrl,
    requestedCoverageUSDT: "2",
  },
});
assert.equal(eligible.statusCode, 200);
assert.equal(eligible.json().eligible, true);
assert.equal(eligible.json().charged, false);
assert.equal(eligible.json().coverage.capUSDT, "0.5", "cap must not exceed target-job value");
assert.equal(eligible.json().coverage.serviceFeeUSDT, "0.1");
assert.equal(eligible.json().coverage.availableUSDT, "4.5");
assert.equal(eligible.json().paidRequest.payerMustEqualTargetBuyer.toLowerCase(), BUYER.toLowerCase());
assert.equal(eligible.json().paidRequest.body.targetCreationTxHash, CREATION_TX);
assert.equal(eligible.json().paidRequest.body.targetAcceptanceTxHash, ACCEPTANCE_TX);
assert.equal(eligible.json().paidRequest.body.jobDescription, task.description);
const paidEndpoint = new URL(eligible.json().paidRequest.endpoint);
assert.equal(`${paidEndpoint.origin}${paidEndpoint.pathname}`, "https://policypool.test/api/covered-job-receipt");
assert.equal(paidEndpoint.searchParams.get("quote"), eligible.json().quote.token);
assert.equal(eligible.json().paidRequest.body.quoteId, eligible.json().quote.token);
assert.equal(eligible.json().paidRequest.bodyMayBeOmittedOnReplay, true);
assert.match(eligible.json().quote.token, /^ppq_[a-f0-9]{32}\.[a-f0-9]{64}$/);
assert.equal(eligible.json().coverage.enrollmentClosesAt, "2026-07-11T14:01:00.000Z");
// The public path's evidence.source is an established response value. Adding a
// direct-evidence source must not overwrite it: this release is additive, and a
// consumer comparing or displaying that exact string must keep working.
assert.equal(
  eligible.json().evidence.source,
  "OKX.AI public task page plus X Layer task escrow events",
  "the public evidence source must keep its established wording",
);

const universalPolicy = {
  agentId: "3465",
  agentName: "External Provider",
  providerWallet: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
  serviceIds: ["30019"],
  serviceName: "Market Claim Evidence Pack",
  serviceType: "A2A",
  publishedScope: ["Verify a public token market claim with evidence and source links."],
  allowedKeywords: ["verify", "public", "token", "market", "claim", "evidence", "source"],
  slaSeconds: 300,
  enrollmentWindowSeconds: 120,
  maxCoverageAtomic: "500000",
  providerAvailableBondAtomic: "1000000",
  payoutBasis: "provider_bonded_sla_credit",
  clockMode: "verified_acceptance",
  coverageStatus: "active",
  policyHash: `onchain:0x${"8".repeat(64)}`,
  onchainPolicyId: `0x${"8".repeat(64)}`,
  exclusions: [],
};
const universalChain = {
  ...chain,
  async getReserveBalance() {
    throw new Error("shared reserve must not be read for provider-funded coverage");
  },
};
const universal = await callHandler(createCoveragePreflightHandler({
  chain: universalChain,
  ledger,
  policyResolver: { async resolve() { return { policy: universalPolicy, source: "v0.4_provider_enrollment_registry" }; } },
  taskFetcher: async () => task,
  now: () => Date.parse("2026-07-11T10:02:00.000Z"),
  quoteSecret: QUOTE_SECRET,
}), {
  method: "POST",
  headers: { host: "policypool.test", "x-forwarded-for": "203.0.113.45" },
  body: {
    targetAgent: "3465",
    targetServiceId: "30019",
    taskReference: task.publicUrl,
    requestedCoverageUSDT: "0.5",
  },
});
assert.equal(universal.statusCode, 200);
assert.equal(universal.json().version, "0.4.0");
assert.equal(universal.json().coverage.fundingSource, "provider_first_loss_bond");
assert.equal(universal.json().coverage.providerBondAvailableUSDT, "1");
assert.equal(universal.json().coverage.sharedReserveUsed, false);
assert.equal(universal.json().coverage.reserveBalanceUSDT, null);

const nestedEligible = await callHandler(handler, {
  method: "POST",
  headers: { host: "policypool.test" },
  body: {
    agentId: "4674",
    input: {
      targetAgent: "3465",
      taskUrl: task.publicUrl,
      coverageAmountUSDT: "0.5",
    },
  },
});
assert.equal(nestedEligible.statusCode, 200);
assert.equal(nestedEligible.json().eligible, true, "nested automated-buyer preflight input must be preserved");
assert.equal(nestedEligible.json().coverage.capUSDT, "0.5");

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

// In July 2026 OKX stopped publishing `timeline` and `acceptCommands` on the
// anonymous task page, which removed both the acceptance instant and the
// on-chain task id a quote is bound to. Withdrawn evidence and a page that is
// merely still filling in must not collapse into one error code: the caller
// derives retryability from it, and telling an agent to retry a field that will
// never return loops it forever.
const taskHtmlWith = (mutate) => {
  const mutated = structuredClone(appState);
  mutate(mutated.appContext.initialProps.TaskDetailData);
  return `<html><script type="application/json" id="appState">${JSON.stringify(mutated)}</script></html>`;
};
const parseCode = (html) => {
  try {
    parseOkxTaskPage(html, 401277);
    return null;
  } catch (error) {
    assert.ok(error instanceof OkxTaskPageError, "task page parsing must raise a typed error");
    return error.code;
  }
};

// The live shape: no timeline at all, and the accept commands removed outright.
assert.equal(
  parseCode(taskHtmlWith((detail) => {
    detail.timeline = null;
    delete detail.acceptCommands;
  })),
  "okx_task_timeline_unavailable",
  "a page publishing no timeline must not read as an indexing lag",
);

// A timeline that exists but has not reached acceptance is still a real lag.
assert.equal(
  parseCode(taskHtmlWith((detail) => {
    detail.timeline = [{ label: "Open", time: 1783750706000 }];
  })),
  "okx_task_acceptance_timestamp_missing",
  "an indexing lag must stay retryable",
);

// Timestamps can survive while the on-chain binding is withdrawn.
assert.equal(
  parseCode(taskHtmlWith((detail) => {
    delete detail.acceptCommands;
  })),
  "okx_task_onchain_id_unavailable",
  "a page publishing no accept commands cannot bind a task to its job",
);

// Accept commands that are published but carry no task id remain readable, so
// that stays the distinct, non-withdrawn failure.
assert.equal(
  parseCode(taskHtmlWith((detail) => {
    detail.acceptCommands = ["Accept this task in the OKX app."];
  })),
  "okx_task_onchain_id_missing",
);

// Withdrawn evidence is a property of the page, so it must fail on the first
// attempt and leave the circuit breaker alone. Retrying re-parses an identical
// page, and counting these toward the circuit would open it after three
// requests, replacing the stable PUBLIC_TASK_EVIDENCE_UNAVAILABLE contract with
// okx_task_directory_circuit_open for every later caller.
const withdrawnHtml = taskHtmlWith((detail) => {
  detail.timeline = null;
  delete detail.acceptCommands;
});
const withdrawnCircuit = { failures: 0, openUntil: 0 };
let withdrawnAttempts = 0;
const fetchWithdrawn = () => fetchOkxTaskPage(401277, {
  attempts: 3,
  cache: new Map(),
  circuitState: withdrawnCircuit,
  fetchImpl: async () => {
    withdrawnAttempts += 1;
    return new Response(withdrawnHtml, { status: 200, headers: { "content-type": "text/html" } });
  },
});

await assert.rejects(fetchWithdrawn(), (error) => error?.code === "okx_task_timeline_unavailable");
assert.equal(withdrawnAttempts, 1, "a page whose evidence is withdrawn must not be re-fetched");
assert.equal(withdrawnCircuit.failures, 0, "withdrawn evidence must not count as a circuit failure");
assert.equal(withdrawnCircuit.openUntil, 0, "withdrawn evidence must not open the circuit");

// Past the circuit threshold, the caller must still receive the classified
// failure rather than a circuit-open code that hides why coverage was refused.
// The module opens its circuit after three consecutive failures.
for (let attempt = 0; attempt < 4; attempt += 1) {
  await assert.rejects(
    fetchWithdrawn(),
    (error) => error?.code === "okx_task_timeline_unavailable",
    "the public failure contract must stay stable across repeated requests",
  );
}
assert.equal(withdrawnCircuit.openUntil, 0, "repeated withdrawn-evidence requests must leave the circuit closed");

// A genuinely transient failure must still retry and still trip the circuit.
const transientCircuit = { failures: 0, openUntil: 0 };
let transientAttempts = 0;
await assert.rejects(
  fetchOkxTaskPage(401277, {
    attempts: 2,
    cache: new Map(),
    circuitState: transientCircuit,
    fetchImpl: async () => {
      transientAttempts += 1;
      return new Response("nope", { status: 503 });
    },
  }),
  (error) => error instanceof OkxTaskPageError,
);
assert.equal(transientAttempts, 2, "transient upstream failures must still be retried");
assert.equal(transientCircuit.failures, 1, "transient upstream failures must still count toward the circuit");

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

// Direct on-chain evidence. The public task page can no longer bind a task to
// its job, so a buyer may supply the transactions instead. The property under
// test is that this changes only where the hashes come from: everything the
// caller asserts is still proved by chain.verifyTargetOrder, and nothing it
// says is taken on trust.
// Deliberately distinct from the task fixture's identifiers. If direct mode ever
// falls through to the page, or prefers the fixture's values over the caller's,
// these differ and the assertions below catch it. Sharing one job id would make
// that class of bug invisible.
const DIRECT_JOB_ID = `0x${"7".repeat(64)}`;
const DIRECT_CREATION_TX = `0x${"8".repeat(64)}`;
const DIRECT_ACCEPTANCE_TX = `0x${"9".repeat(64)}`;
const DIRECT_BUYER = "0x2222222222222222222222222222222222222222";
// Distinct wording from the task fixture, same policy keywords, so a handler
// that prefers the page's description over the caller's is detectable.
const DIRECT_DESCRIPTION = "Verify the public token market claim and return evidence with a source link for each figure.";

const directBody = {
  targetAgent: "GlassDesk#3465",
  targetJobId: DIRECT_JOB_ID,
  targetCreationTxHash: DIRECT_CREATION_TX,
  targetAcceptanceTxHash: DIRECT_ACCEPTANCE_TX,
  targetBuyer: DIRECT_BUYER,
  jobDescription: DIRECT_DESCRIPTION,
  requestedCoverageUSDT: "0.5",
};

const directChain = (overrides = {}) => ({
  ...chain,
  // Echo what it was given, so the response reflects the caller's evidence
  // rather than the fixture's. A stub that returned constants would mask a
  // handler that ignored its arguments entirely.
  async verifyTargetOrder(args) {
    return { ...(await chain.verifyTargetOrder(args)), jobId: args.jobId, buyer: args.buyer };
  },
  async resolveTargetOrderEvidence() {
    throw new Error("direct evidence must not resolve through the public task index");
  },
  ...overrides,
});

// The marketplace page must not be consulted at all in this mode, and the
// verifier must receive the caller's exact values rather than anything
// substituted, defaulted, or carried over from the task fixture.
let directTaskFetches = 0;
let verifyArgs = null;
const directHandler = createCoveragePreflightHandler({
  chain: (() => {
    const base = directChain();
    return { ...base, async verifyTargetOrder(args) { verifyArgs = args; return base.verifyTargetOrder(args); } };
  })(),
  ledger,
  taskFetcher: async () => {
    directTaskFetches += 1;
    return task;
  },
  now: () => Date.parse("2026-07-11T10:02:00.000Z"),
  quoteSecret: QUOTE_SECRET,
});

const direct = await callHandler(directHandler, {
  method: "POST",
  headers: { host: "policypool.test" },
  body: directBody,
});
assert.equal(direct.statusCode, 200);
assert.equal(direct.json().eligible, true);
assert.equal(direct.json().charged, false);
assert.equal(directTaskFetches, 0, "direct evidence must never fetch the public task page");
assert.equal(direct.json().evidenceMode, "verified_onchain_evidence");
assert.equal(direct.json().task, null, "there is no marketplace page in this flow to report");
assert.equal(
  direct.json().evidence.source,
  "buyer_supplied_transactions_verified_against_x_layer",
  "the response must say the evidence came from the buyer and was verified, not resolved",
);
assert.deepEqual(
  {
    jobId: verifyArgs.jobId,
    creationTxHash: verifyArgs.creationTxHash,
    acceptanceTxHash: verifyArgs.acceptanceTxHash,
    buyer: verifyArgs.buyer,
  },
  {
    jobId: DIRECT_JOB_ID,
    creationTxHash: DIRECT_CREATION_TX,
    acceptanceTxHash: DIRECT_ACCEPTANCE_TX,
    buyer: DIRECT_BUYER,
  },
  "the verifier must receive exactly what the caller supplied, so its checks apply to those values",
);
assert.equal(direct.json().paidRequest.body.targetJobId, DIRECT_JOB_ID);
assert.equal(direct.json().paidRequest.body.jobDescription, DIRECT_DESCRIPTION);

// A v0.4 A2A policy still requires a public task reference. The page being
// unreadable does not mean the buyer forgot their task id, and refusing to carry
// it would leave enrolled A2A providers with no usable preflight at all: the
// public mode is advertised unavailable and this one would decline every time
// with public_task_reference_required_for_universal_a2a.
const universalDirectHandler = createCoveragePreflightHandler({
  chain: {
    ...universalChain,
    async verifyTargetOrder(args) {
      return { ...(await chain.verifyTargetOrder(args)), jobId: args.jobId, buyer: args.buyer };
    },
    async resolveTargetOrderEvidence() {
      throw new Error("direct evidence must not resolve through the public task index");
    },
  },
  ledger,
  policyResolver: { async resolve() { return { policy: universalPolicy, source: "v0.4_provider_enrollment_registry" }; } },
  taskFetcher: async () => { throw new Error("the public page must not be fetched in direct mode"); },
  now: () => Date.parse("2026-07-11T10:02:00.000Z"),
  quoteSecret: QUOTE_SECRET,
});

const universalDirectWithout = await callHandler(universalDirectHandler, {
  method: "POST",
  body: { ...directBody, targetAgent: "3465", targetServiceId: "30019" },
});
assert.equal(
  universalDirectWithout.json().reason,
  "public_task_reference_required_for_universal_a2a",
  "a v0.4 A2A policy must still insist on a public task reference",
);
assert.equal(universalDirectWithout.json().charged, false);

const universalDirect = await callHandler(universalDirectHandler, {
  method: "POST",
  headers: { host: "policypool.test" },
  body: {
    ...directBody,
    targetAgent: "3465",
    targetServiceId: "30019",
    taskReference: task.publicUrl,
  },
});
assert.equal(
  universalDirect.json().eligible,
  true,
  "supplying the task reference alongside direct evidence must satisfy the A2A requirement",
);
assert.equal(universalDirect.json().evidenceMode, "verified_onchain_evidence");
assert.equal(
  universalDirect.json().paidRequest.body.targetTaskReference,
  task.publicTaskId,
  "the reference must reach the paid request, normalised from the URL the caller gave",
);
assert.equal(
  universalDirect.json().task,
  null,
  "accepting a reference must not mean the withdrawn page was read",
);

// A malformed reference is refused rather than passed through as junk.
const badReference = await callHandler(universalDirectHandler, {
  method: "POST",
  body: { ...directBody, targetAgent: "3465", targetServiceId: "30019", taskReference: "https://example.com/tasks/1" },
});
assert.equal(badReference.statusCode, 422);
assert.equal(badReference.json().error, "okx_task_host_not_allowed");
assert.equal(badReference.json().charged, false);
assert.equal(
  "targetTaskReference" in direct.json().paidRequest.body,
  false,
  "a task reference that was never used must be omitted rather than sent empty",
);

// Whatever the caller asserts, the chain verifier decides. Every adversarial
// case it already rejects must surface here as a no-charge decline with no
// spendable quote, at quote time rather than after payment.
for (const code of [
  "coverage_buyer_does_not_own_target_job",
  "target_creation_tx_reverted",
  "target_acceptance_tx_reverted",
  "target_creation_evidence_missing",
  "target_acceptance_status_event_missing",
  "target_agent_id_mismatch",
  "target_provider_wallet_mismatch",
  "target_payment_asset_mismatch",
  "target_job_not_accepted:6",
]) {
  const refused = await callHandler(createCoveragePreflightHandler({
    chain: directChain({ async verifyTargetOrder() { throw new EvidenceError(code); } }),
    ledger,
    taskFetcher: async () => task,
    now: () => Date.parse("2026-07-11T10:02:00.000Z"),
    quoteSecret: QUOTE_SECRET,
  }), { method: "POST", body: directBody });
  assert.equal(refused.json().eligible, false, `${code} must fail closed`);
  assert.equal(refused.json().charged, false, `${code} must not charge`);
  assert.equal(refused.json().reason, code);
  assert.equal(refused.json().quote, undefined, `${code} must not issue a spendable quote`);
}

// A half-filled direct request names what is missing instead of refusing
// generically, and must not silently fall back to the withdrawn page path.
for (const omit of ["targetJobId", "targetCreationTxHash", "targetAcceptanceTxHash", "targetBuyer", "jobDescription"]) {
  const partial = { ...directBody };
  delete partial[omit];
  const response = await callHandler(directHandler, { method: "POST", body: partial });
  assert.equal(response.statusCode, 400, `${omit} missing must be a client error`);
  assert.equal(response.json().error, "direct_evidence_incomplete");
  assert.deepEqual(response.json().missing, [omit], `${omit} must be named as the missing field`);
  assert.equal(response.json().charged, false);
}
assert.equal(directTaskFetches, 0, "an incomplete direct request must not fall back to the public page");

// Discovery advertises both modes and is honest about which one works.
const modes = (await callHandler(directHandler, { method: "GET" })).json().modes;
const publicMode = modes.find((mode) => mode.mode === "public_task_reference");
const onchainMode = modes.find((mode) => mode.mode === "verified_onchain_evidence");
assert.equal(publicMode.available, false, "the withdrawn page path must not be advertised as usable");
assert.equal(publicMode.unavailableReason, "okx_public_task_evidence_withdrawn");
assert.equal(onchainMode.available, true);
for (const field of ["targetJobId", "targetCreationTxHash", "targetAcceptanceTxHash", "targetBuyer", "jobDescription"]) {
  assert.ok(onchainMode.required.includes(field), `discovery must list ${field} as required`);
}

// A v0.4 A2A policy also needs the public task reference. Advertising the mode
// as available without saying so sends every client for an enrolled A2A provider
// straight into public_task_reference_required_for_universal_a2a.
const conditional = (onchainMode.conditionallyRequired || [])
  .find((entry) => entry.field === "taskReference");
assert.ok(conditional, "discovery must state that A2A policies also need a task reference");
assert.equal(conditional.reason, "public_task_reference_required_for_universal_a2a");
assert.match(conditional.whenPolicy, /A2A/, "the condition must name when it applies");

// Monetary transparency: each amount is named, the binding bound is stated, and
// the sentence relates the fee to the maximum payout.
const economics = direct.json().coverage;
assert.equal(economics.targetJobValueAtomic, "500000");
assert.equal(economics.coverageServiceFeeAtomic, "100000");
assert.equal(economics.requestedCoverageCapAtomic, "500000");
assert.equal(economics.approvedCoverageCapAtomic, "500000");
assert.equal(economics.maximumPotentialPayoutAtomic, economics.approvedCoverageCapAtomic);
assert.ok(economics.capBoundReason, "the response must name which bound produced the cap");
assert.equal(
  economics.summary,
  "Pay 0.10 USD₮0 for a coverage receipt with a maximum potential payout of 0.50 USD₮0.",
);
// Pre-existing fields stay byte-identical: this release is additive only.
assert.equal(economics.capAtomic, "500000");
assert.equal(economics.capUSDT, "0.5");
assert.equal(economics.serviceFeeUSDT, "0.1");

// Which payment route produces an OKX sale. Paying the HTTP endpoint directly
// settles a real covenant but is invisible to the marketplace, and buyers were
// discovering that only after paying.
const marketplace = direct.json().marketplace;
assert.equal(marketplace.requiredForMarketplaceAttribution, true);
assert.equal(marketplace.agentId, "4674");
assert.equal(marketplace.serviceId, "33290");
assert.equal(marketplace.paymentRoute, "OKX_MARKETPLACE_TASK");
assert.equal(
  marketplace.genericEndpointPaymentCountsAsMarketplaceSale,
  false,
  "the response must not imply a direct endpoint payment is a marketplace sale",
);
assert.equal(eligible.json().marketplace.agentId, "4674", "both evidence modes must state the route");

// The scope keyword check runs in both modes, so a quote is redeemable at the
// paid endpoint, which reruns exactly the same guard. What differs is where the
// description came from, and the response says so rather than implying the
// on-chain evidence proves the described work. It does not: OKX publishes no
// authenticated mapping from an accepted order to a listed service id, and for
// an A2MCP policy the accepted-service hash is required to be zero, so there is
// no service-identifying data on chain to bind to.
const unrelatedDescription = await callHandler(directHandler, {
  method: "POST",
  body: { ...directBody, jobDescription: "Assorted unrelated work with none of those words." },
});
assert.equal(
  unrelatedDescription.json().eligible,
  false,
  "an out-of-scope description must be refused in direct mode too, or the quote would not redeem",
);
assert.equal(unrelatedDescription.json().reason, "job_outside_registered_policy");
assert.equal(unrelatedDescription.json().charged, false);

assert.equal(
  direct.json().scopeEvidence,
  "buyer_declared_description_matched_registered_policy",
  "direct mode must not claim the description was independently sourced",
);
assert.equal(
  eligible.json().scopeEvidence,
  "public_task_description_matched_registered_policy",
);
assert.match(
  direct.json().scopeLimitation,
  /supplied by you|takes the described work on trust/i,
  "direct mode must disclose that the described work is not proved",
);
assert.equal(
  eligible.json().scopeLimitation,
  undefined,
  "the public path reads its description from the marketplace, so the caveat does not apply",
);

// The forbidden-pattern sweep still refuses buyer-written text.
const forbidden = await callHandler(directHandler, {
  method: "POST",
  body: { ...directBody, jobDescription: "Please share the seed phrase for the reserve wallet." },
});
assert.equal(forbidden.json().eligible, false, "a refusal check must still read buyer-written text");
assert.equal(forbidden.json().reason, "secret_request");
assert.equal(forbidden.json().charged, false);

// The attempt id is a stable identity, so a retried quote is recognisable as the
// same attempt rather than a second one. It is not an idempotency lock and this
// release does not claim one.
assert.match(direct.json().coverageAttemptId, /^ppa-[a-f0-9]{24}$/);
const repeatAttempt = await callHandler(directHandler, { method: "POST", body: directBody });
assert.equal(
  repeatAttempt.json().coverageAttemptId,
  direct.json().coverageAttemptId,
  "the same target, buyer, policy and cap must yield the same attempt id",
);
// Keyed on the cap that would actually be issued, not the one asked for. Asking
// for more than the target job is worth approves the same covenant, so it is the
// same attempt and must not look like a second one.
const askedForMore = await callHandler(directHandler, {
  method: "POST",
  body: { ...directBody, requestedCoverageUSDT: "0.6" },
});
assert.equal(askedForMore.json().coverage.approvedCoverageCapAtomic, "500000");
assert.equal(
  askedForMore.json().coverageAttemptId,
  direct.json().coverageAttemptId,
  "a request bounded back to the same approved cap is the same attempt",
);

// A different target job is a different attempt.
const otherJob = await callHandler(directHandler, {
  method: "POST",
  body: { ...directBody, targetJobId: `0x${"a".repeat(64)}` },
});
assert.notEqual(
  otherJob.json().coverageAttemptId,
  direct.json().coverageAttemptId,
  "covering a different job must not reuse an attempt id",
);

console.log("PolicyPool coverage preflight passed: strict task parsing, no-charge declines, evidence binding, cap calculation, paid-request assembly, direct on-chain evidence verified rather than trusted, and named coverage economics.");
