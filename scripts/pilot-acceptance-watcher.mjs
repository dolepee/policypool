// Pre-staged acceptance watcher for the controlled provider-failure pilot.
//
// Foreman #4348 is registered with a truthful 300-second SLA and a 60-second
// enrollment window, and those numbers are not being widened to make this
// convenient. Sixty seconds is not enough for a human to notice an acceptance,
// find two transactions, and quote coverage. So this runs *before* the provider
// accepts, watches the escrow from the known creation block, and has the
// direct-evidence quote in hand the moment acceptance lands.
//
// What it deliberately does not do:
//   - It never pays. It prepares the listed marketplace purchase and stops.
//   - It never touches /api/covered-job-receipt. Paying that endpoint directly
//     settles a valid covenant that OKX never sees, so it would not be a
//     marketplace sale for agent #4674.
//   - It never confirms coverage without proving the buyer paid exactly the
//     listed fee, from the buyer's own wallet.
//
// Usage:
//   node scripts/pilot-acceptance-watcher.mjs watch \
//     --job-id 0x… --from-block 65123456 --buyer 0x… \
//     --job-description "…" [--cap 0.5] [--target-agent Foreman#4348]
//
//   node scripts/pilot-acceptance-watcher.mjs confirm --receipt-id ppc-…
//
// Every observation is appended to an evidence log. Nothing is ever rewritten.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MARKETPLACE, OKX_TASK, PAYMENT, XLAYER } from "../api/lib/config.js";
import { sha256 } from "../api/lib/utils.js";
import { validateServiceBinding } from "../api/lib/chain.js";

const API_BASE = process.env.POLICYPOOL_API_BASE || "https://policypool.vercel.app";
const RPC_URL = process.env.XLAYER_RPC_URL || XLAYER.rpcUrl;
const EVIDENCE_LOG = process.env.POLICYPOOL_PILOT_EVIDENCE
  || resolve(homedir(), ".config/policypool/pilot-evidence.jsonl");
const POLL_MS = Number(process.env.POLICYPOOL_PILOT_POLL_MS || 2000);
const HOUSE_WALLET = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[index + 1];
    args[key] = !next || next.startsWith("--") ? true : next;
  }
  return args;
}

// Append-only by construction: the log is opened for append and never read back
// for mutation. A pilot's evidence must not be quietly editable after the fact.
function record(event, payload) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...payload });
  mkdirSync(dirname(EVIDENCE_LOG), { recursive: true });
  appendFileSync(EVIDENCE_LOG, `${line}\n`, { mode: 0o600 });
  return line;
}

function readEvidence() {
  if (!existsSync(EVIDENCE_LOG)) return [];
  return readFileSync(EVIDENCE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const topicAddress = (topic) => `0x${String(topic).slice(26)}`.toLowerCase();
const topicUint = (topic) => BigInt(topic);

// X Layer's public RPC rejects eth_getLogs ranges larger than 100 blocks, which
// is why api/lib/chain.js scans in chunks. A watcher that asked for
// creation-to-latest would start failing the moment the head drifted 100 blocks
// past creation, retry the same oversized query forever, and silently miss the
// acceptance it exists to catch.
const MAX_LOG_SCAN_BLOCKS = 100n;
// The coverage purchase necessarily happens after the covered job is created
// and inside its 60-second enrollment window, so the search starts at the target
// job's creation block. The bound is the fallback when the receipt does not
// report that block, and it caps the scan either way.
const MARKETPLACE_SCAN_BLOCKS = 3000n;

async function scanEscrow({ jobId, fromBlock, toBlock }) {
  const topic = jobId.toLowerCase();
  const found = [];
  for (let start = BigInt(fromBlock); start <= toBlock; start += MAX_LOG_SCAN_BLOCKS) {
    const end = start + MAX_LOG_SCAN_BLOCKS - 1n < toBlock ? start + MAX_LOG_SCAN_BLOCKS - 1n : toBlock;
    const chunk = await rpc("eth_getLogs", [{
      address: OKX_TASK.escrow,
      topics: [null, topic],
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
    }]);
    found.push(...chunk);
  }
  return found;
}

async function headBlock() {
  return BigInt(await rpc("eth_blockNumber", []));
}

// The two events a coverage quote binds to. Both are decoded here rather than
// pattern-matched loosely, so a log that merely mentions the job cannot be
// mistaken for its creation or its acceptance.
function decode(logs, { jobId, buyer }) {
  const job = jobId.toLowerCase();
  const forJob = logs.filter((log) => log.topics[1]?.toLowerCase() === job);

  const created = forJob.find((log) => log.topics[0]?.toLowerCase() === OKX_TASK.createdTopic);
  const accepted = forJob.find((log) => log.topics[0]?.toLowerCase() === OKX_TASK.acceptedTopic);
  const statusChanged = forJob.find((log) => (
    log.topics[0]?.toLowerCase() === OKX_TASK.statusChangedTopic
    && topicUint(log.topics[2]) === 0n
    && topicUint(log.topics[3]) === 1n
  ));

  const result = {
    creationTxHash: created?.transactionHash || null,
    creationBlock: created ? Number(BigInt(created.blockNumber)) : null,
    onChainBuyer: created ? topicAddress(created.topics[2]) : null,
    acceptanceTxHash: accepted?.transactionHash || null,
    acceptanceBlock: accepted ? Number(BigInt(accepted.blockNumber)) : null,
    provider: accepted ? topicAddress(accepted.topics[2]) : null,
    statusChangedTxHash: statusChanged?.transactionHash || null,
  };

  // The escrow moves the job to accepted and emits the accepted event; a quote
  // needs the transaction carrying the acceptance evidence. Requiring both to
  // agree stops a status flip in one transaction being paired with acceptance
  // details from another.
  result.acceptanceConsistent = Boolean(
    result.acceptanceTxHash
    && result.statusChangedTxHash
    && result.acceptanceTxHash.toLowerCase() === result.statusChangedTxHash.toLowerCase(),
  );
  result.buyerMatches = Boolean(
    result.onChainBuyer && buyer && result.onChainBuyer === buyer.toLowerCase(),
  );
  return result;
}

// A receipt reports the buyer in two shapes: `targetJob.buyer` is a plain
// address, `receipt.buyer` is `{ address }`. The fallback between them cannot be
// a bare String(): an unverified target job falls back to a literal that carries
// no buyer at all, and stringifying the object then yields "[object Object]",
// which is truthy. That would satisfy both the presence check and the
// house-wallet check below — the one assertion this pilot exists to make. Return
// an address or nothing, never a shape.
export function buyerAddress(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate : candidate?.address;
    if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)) return value.toLowerCase();
  }
  return "";
}

// A coverage payment and a marketplace purchase are distinguishable on chain,
// and this was verified against real transactions before it was relied on. The
// one external coverage purchase to date settled as an EIP-3009
// transferWithAuthorization straight to the USD~T0 contract and never touched the
// OKX escrow; the buyer's marketplace purchase of the covered job went through
// the ERC-4337 EntryPoint and emitted escrow created and statusChanged logs.
// A receipt records neither, so the receipt alone can never establish
// attribution: state, fee, buyer, job, policy and cap are identical either way.
export function paymentRoute(logs, escrow, taskId) {
  const escrowLogs = (logs || []).filter(
    (log) => String(log?.address || "").toLowerCase() === String(escrow).toLowerCase(),
  );
  if (escrowLogs.length === 0) return "direct_endpoint_payment";
  // Touching the escrow is not the same as being this purchase. A settlement can
  // carry escrow activity for some entirely different task, and the marketplace
  // task is validated by a separate historical scan that never looks at these
  // logs, so "an escrow address appeared" would let an unrelated escrow
  // operation plus an unrelated qualifying task pass a direct purchase off as a
  // verified sale. Require the settlement to name the task itself.
  const wanted = String(taskId || "").toLowerCase();
  if (!wanted) return "escrow_unrelated_task";
  const carriesTask = escrowLogs.some(
    (log) => String(log?.topics?.[1] || "").toLowerCase() === wanted,
  );
  return carriesTask ? "okx_escrow_mediated" : "escrow_unrelated_task";
}

// The accepted event carries the listing behind a task: agentId, asset, amount
// and service hash, in that order, with the provider in topic 2. Decoded by
// offset rather than through viem to keep this script dependency free; the
// layout is the same one api/lib/chain.js decodes.
export function decodeAcceptedTask(log) {
  const data = String(log?.data || "").replace(/^0x/, "");
  if (data.length < 256 || !log?.topics?.[2]) return null;
  const word = (index) => data.slice(index * 64, (index + 1) * 64);
  return {
    agentId: BigInt(`0x${word(0)}`).toString(),
    asset: `0x${word(1).slice(24)}`.toLowerCase(),
    amountAtomic: BigInt(`0x${word(2)}`).toString(),
    serviceHash: `0x${word(3)}`,
    provider: `0x${String(log.topics[2]).slice(26)}`.toLowerCase(),
  };
}

// Attribution has to come from evidence the operator supplies and this script
// verifies, not from inference. Absent that evidence the answer is "unproven",
// which must refuse: confirming tells the provider to withhold delivery and
// labels the result a marketplace sale.
export function marketplaceProblems({
  taskId, targetJobId, receiptBuyer, created, accepted,
  expectedAgentId, expectedProvider, expectedFeeAtomic, expectedAsset, expectedServiceType,
  acceptUnproven = false,
}) {
  const problems = [];
  if (!taskId) {
    // PolicyPool's own listing is A2MCP and the one external coverage purchase
    // to date left no escrow task, so it is not yet established that buying this
    // service produces one at all. Blocking outright could strand the pilot at
    // the moment it cannot be restarted. The operator may proceed without the
    // evidence, but only by saying so, and the result is then labelled unproven
    // everywhere it is recorded rather than passing quietly as a sale.
    if (acceptUnproven) return problems;
    problems.push(
      "no --marketplace-task supplied, so nothing shows this purchase used the listed service."
      + " A payment made straight to /api/covered-job-receipt produces an identical receipt."
      + " Pass --attribution-unproven to continue without it; the run is then recorded as"
      + " attribution_unproven and must not be described as an OKX marketplace sale.",
    );
    return problems;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(taskId)) {
    problems.push(`--marketplace-task ${taskId} is not a task id`);
    return problems;
  }
  // The buyer's only escrow task in the pilot is the covered job itself, so
  // passing that id would otherwise satisfy this check while proving nothing
  // about how the coverage was bought.
  if (targetJobId && taskId.toLowerCase() === String(targetJobId).toLowerCase()) {
    problems.push("the marketplace task is the covered job itself, which says nothing about how coverage was bought");
    return problems;
  }
  if (!created?.jobId) {
    problems.push(`no OKX task creation found on chain for ${taskId}`);
    return problems;
  }
  const createdBuyer = String(created.buyer || "").toLowerCase();
  const expected = String(receiptBuyer || "").toLowerCase();
  if (!expected) problems.push("the receipt names no buyer to match the marketplace task against");
  else if (createdBuyer !== expected) {
    problems.push(`marketplace task ${taskId} was created by ${createdBuyer || "nobody"}, not the receipt buyer ${expected}`);
  }
  // The buyer matching is not enough on its own. Any escrow task this buyer
  // happened to create after the covered job would otherwise satisfy every check
  // above while saying nothing about PolicyPool. Bind the task to the listing:
  // its accepted event names the agent it was bought from and the wallet that
  // accepted it, and the escrowed amount is the coverage fee.
  if (!accepted) {
    problems.push(
      `marketplace task ${taskId} has no acceptance on chain, so nothing binds it to PolicyPool's listing.`
      + " An unaccepted task proves only that this buyer created some task.",
    );
    return problems;
  }
  if (accepted.agentId !== String(expectedAgentId)) {
    problems.push(`marketplace task ${taskId} belongs to agent ${accepted.agentId}, not PolicyPool's agent ${expectedAgentId}`);
  }
  if (expectedProvider && accepted.provider !== String(expectedProvider).toLowerCase()) {
    problems.push(`marketplace task ${taskId} was accepted by ${accepted.provider}, not PolicyPool's wallet ${String(expectedProvider).toLowerCase()}`);
  }
  if (expectedFeeAtomic && accepted.amountAtomic !== String(expectedFeeAtomic)) {
    problems.push(`marketplace task ${taskId} escrowed ${accepted.amountAtomic} atomic, not the ${expectedFeeAtomic} coverage fee`);
  }
  // An amount without its denomination is not an amount. 100000 units of some
  // other token is not the 0.10 USD~T0 fee, and the escrow records which asset
  // it held, so there is no reason to infer it.
  if (expectedAsset && accepted.asset !== String(expectedAsset).toLowerCase()) {
    problems.push(`marketplace task ${taskId} escrowed ${accepted.asset}, not the coverage asset ${String(expectedAsset).toLowerCase()}`);
  }
  // Agent, wallet, asset and amount can all match on a task of the wrong kind.
  // The escrow records a service hash, and the listing type determines what it
  // must be: zero for A2MCP, non-zero for A2A. Without this, an A2A task sold by
  // the same agent through the same wallet for the same fee satisfies every
  // check above and is recorded as the A2MCP coverage listing.
  //
  // The rule is not restated here. validateServiceBinding is the definition
  // used when a covenant is actually issued, so calling it is what keeps this
  // from drifting away from the thing it is supposed to mirror.
  if (expectedServiceType) {
    try {
      validateServiceBinding({ serviceType: expectedServiceType }, accepted.serviceHash);
    } catch (error) {
      problems.push(
        `marketplace task ${taskId} is not a ${expectedServiceType} listing (${error?.code || error?.message || "service binding failed"})`,
      );
    }
  }
  // The settlement route deliberately does not gate this, and must not be
  // re-added. The coverage fee is an x402 payment: payment.settle goes through
  // the facilitator and produces a plain token transfer from the payer to
  // PAYMENT.payTo, which chain.verifySettlement verifies as exactly that. Any
  // OKX task lives in its own escrow transaction. So the fee transaction
  // carries no escrow log even for a genuine marketplace purchase, and
  // requiring one rejected precisely the purchase this watcher exists to
  // confirm.
  //
  // Route is still classified and written to the evidence log, because it is
  // worth knowing, but it cannot attribute a payment in either direction. What
  // binds a task to this purchase is the listing binding above: same buyer,
  // PolicyPool's agent, PolicyPool's wallet, the exact fee, the coverage asset,
  // and the service type the escrow recorded.
  return problems;
}

// The attempt key the plan asks for: buyer, target job, policy hash, cap. A
// restart recomputes the same key and resumes the same attempt rather than
// opening a second one.
function attemptKey({ buyer, jobId, policyHash, capAtomic }) {
  return `ppa-${sha256([
    String(buyer).toLowerCase(),
    String(jobId).toLowerCase(),
    String(policyHash),
    String(capAtomic),
  ].join("|")).slice(0, 24)}`;
}

async function preflight(body) {
  const response = await fetch(`${API_BASE}/api/coverage-preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function usdt(atomic) {
  const raw = BigInt(atomic);
  const unit = 10n ** BigInt(PAYMENT.decimals);
  const fraction = (raw % unit).toString().padStart(PAYMENT.decimals, "0").replace(/0+$/, "");
  return `${raw / unit}.${fraction.padEnd(2, "0")}`;
}

async function watch(args) {
  const jobId = String(args.jobId || "").toLowerCase();
  const buyer = String(args.buyer || "").toLowerCase();
  const fromBlock = args.fromBlock;
  const jobDescription = String(args.jobDescription || "");
  const cap = String(args.cap || "0.5");
  if (!/^\d+(\.\d{1,6})?$/.test(cap)) {
    throw new Error(`--cap must be a USD₮0 amount with at most six decimals, got ${cap}`);
  }
  const targetAgent = String(args.targetAgent || "Foreman#4348");

  if (!/^0x[a-f0-9]{64}$/.test(jobId)) throw new Error("--job-id must be a bytes32 hash");
  if (!/^0x[a-f0-9]{40}$/.test(buyer)) throw new Error("--buyer must be an address");
  if (!fromBlock || fromBlock === true) throw new Error("--from-block is required");
  // Parsed here rather than inside the loop. BigInt("abc") throws, the loop
  // treats a throw as a transient RPC failure, and the watcher would retry a
  // permanently broken query until the enrollment window closed.
  if (!/^\d+$/.test(String(fromBlock))) {
    throw new Error(`--from-block must be a nonnegative integer, got ${fromBlock}`);
  }
  const startBlock = BigInt(fromBlock);
  if (!jobDescription) throw new Error("--job-description is required");
  if (buyer === HOUSE_WALLET) {
    throw new Error("--buyer is the PolicyPool owner wallet; this pilot exists to pay someone else");
  }

  console.log(`watching escrow ${OKX_TASK.escrow} for job ${jobId} from block ${fromBlock}`);
  console.log(`buyer ${buyer} (confirmed not the house wallet)`);
  console.log(`evidence log: ${EVIDENCE_LOG}\n`);
  record("watch_started", { jobId, buyer, fromBlock: String(fromBlock), targetAgent, cap });

  let announcedCreation = false;
  for (;;) {
    let events;
    try {
      // Rescan from creation every pass rather than advancing a cursor past it:
      // the creation and acceptance events must both be in hand to build a
      // quote, and a cursor that had already moved beyond creation could not
      // produce one. The range is bounded, so the cost is a few chunked calls.
      events = decode(await scanEscrow({ jobId, fromBlock: startBlock, toBlock: await headBlock() }), { jobId, buyer });
    } catch (error) {
      // A transient RPC failure must not end a watch that may have one minute
      // of enrollment window left.
      console.error(`rpc error, retrying: ${error.message}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    if (events.creationTxHash && !announcedCreation) {
      announcedCreation = true;
      console.log(`creation seen  block ${events.creationBlock}  tx ${events.creationTxHash}`);
      if (!events.buyerMatches) {
        record("buyer_mismatch", { jobId, expected: buyer, onChain: events.onChainBuyer });
        throw new Error(
          `the job was created by ${events.onChainBuyer}, not ${buyer}; coverage would be refused`,
        );
      }
      record("creation_observed", {
        jobId,
        creationTxHash: events.creationTxHash,
        creationBlock: events.creationBlock,
        onChainBuyer: events.onChainBuyer,
      });
    }

    if (events.acceptanceTxHash && events.acceptanceConsistent) {
      console.log(`ACCEPTED       block ${events.acceptanceBlock}  tx ${events.acceptanceTxHash}`);
      console.log(`provider       ${events.provider}\n`);
      record("acceptance_observed", {
        jobId,
        acceptanceTxHash: events.acceptanceTxHash,
        acceptanceBlock: events.acceptanceBlock,
        provider: events.provider,
      });

      const body = {
        targetAgent,
        targetJobId: jobId,
        targetCreationTxHash: events.creationTxHash,
        targetAcceptanceTxHash: events.acceptanceTxHash,
        targetBuyer: buyer,
        jobDescription,
        requestedCoverageUSDT: cap,
      };
      const { status, payload } = await preflight(body);
      record("preflight_result", { status, eligible: payload.eligible === true, payload });

      if (payload.eligible !== true) {
        console.error(`preflight refused: ${payload.reason || payload.error}`);
        console.error(payload.message || "");
        console.error(payload.nextAction || "");
        console.error("\nnothing was charged and no receipt exists. abort and restart with a fresh job.");
        process.exitCode = 1;
        return;
      }

      const key = attemptKey({
        buyer,
        jobId,
        policyHash: payload.policy?.policyHash,
        capAtomic: payload.coverage?.approvedCoverageCapAtomic,
      });
      const priorAttempt = readEvidence().find(
        (entry) => entry.event === "purchase_prepared" && entry.attemptKey === key,
      );
      record("purchase_prepared", {
        attemptKey: key,
        serverAttemptId: payload.coverageAttemptId || null,
        resumed: Boolean(priorAttempt),
        deadline: payload.coverage?.deadline,
        enrollmentClosesAt: payload.coverage?.enrollmentClosesAt,
        body,
        paidRequestBody: payload.paidRequest?.body || null,
        quoteId: payload.paidRequest?.body?.quoteId || null,
      });

      console.log("=".repeat(72));
      console.log(priorAttempt
        ? `RESUMING attempt ${key} (already prepared at ${priorAttempt.at})`
        : `attempt ${key}`);
      if (payload.coverageAttemptId && payload.coverageAttemptId !== key) {
        console.log(`note: server attempt id ${payload.coverageAttemptId} differs from local key`);
      }
      console.log("=".repeat(72));
      console.log(`cap approved   ${usdt(payload.coverage.approvedCoverageCapAtomic)} ${PAYMENT.symbol}`);
      console.log(`fee to pay     ${usdt(payload.coverage.coverageServiceFeeAtomic)} ${PAYMENT.symbol}`);
      console.log(`bound by       ${payload.coverage.capBoundReason}`);
      console.log(`deadline       ${payload.coverage.deadline}`);
      console.log(`enrol closes   ${payload.coverage.enrollmentClosesAt}`);
      console.log(`\n${payload.coverage.summary}\n`);
      console.log(`BUY THROUGH THE LISTED SERVICE, not the HTTP endpoint:`);
      console.log(`  agent    #${MARKETPLACE.agentId}   ${MARKETPLACE.agentUrl}`);
      console.log(`  service  #${MARKETPLACE.serviceId}`);
      console.log(`  payer    ${payload.paidRequest?.payerMustEqualTargetBuyer || buyer}`);
      // The quote-bound body, not the preflight request. It carries quoteId,
      // which ties the purchase to this signed quote. Without it the paid
      // endpoint falls back to recovering the one open quote for the payer, and
      // a second preflight run leaves two, at which point that recovery refuses
      // and the enrollment window is gone.
      if (!payload.paidRequest?.body?.quoteId) {
        console.error("\nWARNING: the quote did not return a bound paid request. Do not purchase.");
        record("paid_request_missing_quote", { attemptKey: key, paidRequest: payload.paidRequest || null });
        process.exitCode = 1;
        return;
      }
      console.log(`\ntask payload (quote-bound, use exactly this):\n${JSON.stringify(payload.paidRequest.body, null, 2)}\n`);
      console.log(`endpoint the marketplace task must call:\n  ${payload.paidRequest.endpoint}\n`);
      console.log(`A direct payment to /api/covered-job-receipt would settle a valid`);
      console.log(`covenant that OKX never records as a sale for agent #${MARKETPLACE.agentId}.\n`);
      console.log(`once purchased:  node scripts/pilot-acceptance-watcher.mjs confirm --receipt-id ppc-…`);
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Coverage is only treated as live once the buyer has demonstrably paid the
// listed fee, exactly, from their own wallet. A receipt that exists is not the
// same as a receipt the external buyer paid for.
async function confirm(args) {
  const receiptId = String(args.receiptId || "");
  if (!/^ppc-[a-f0-9]{16}$/.test(receiptId)) throw new Error("--receipt-id must look like ppc-<16 hex>");

  const response = await fetch(`${API_BASE}/api/coverage-status?receiptId=${encodeURIComponent(receiptId)}`);
  const payload = await response.json();
  record("confirm_status", { receiptId, status: response.status, payload });

  const receipt = payload.receipt || {};
  const fee = receipt.servicePayment || {};
  const buyer = buyerAddress(receipt.targetJob?.buyer, receipt.buyer);
  const feeAtomic = String(fee.amountAtomic ?? "");
  const problems = [];

  // Confirming any active receipt paid by some non-house wallet would green-light
  // withholding delivery on a job this pilot never watched. The prepared attempt
  // is the authority on which job, buyer and agent are in scope.
  // Several attempts can sit in the log: restarts, aborted runs, or a re-quote
  // after changing the cap. Selecting by job alone picks the oldest of those and
  // then fails its own key comparison against a receipt a later attempt matches
  // exactly. Compute the receipt's key first and select by that, so a valid
  // receipt is recognised whichever attempt produced it.
  const preparedAttempts = readEvidence().filter((entry) => entry.event === "purchase_prepared");
  const receiptJobForMatch = String(
    payload.receipt?.targetJob?.jobId || payload.receipt?.target?.jobId || "",
  ).toLowerCase();
  const receiptAttemptKey = attemptKey({
    buyer: buyerAddress(payload.receipt?.targetJob?.buyer, payload.receipt?.buyer),
    jobId: receiptJobForMatch,
    policyHash: payload.receipt?.target?.policyHash,
    capAtomic: payload.receipt?.covenant?.coverageCapAtomic,
  });
  const prepared = preparedAttempts.find((entry) => entry.attemptKey === receiptAttemptKey)
    // No exact match: fall back to a same-job attempt purely so the refusal can
    // say which covenant differs, rather than reporting nothing to compare.
    || preparedAttempts.find(
      (entry) => String(entry.body?.targetJobId || "").toLowerCase() === receiptJobForMatch,
    )
    || preparedAttempts.at(-1);
  if (!prepared) {
    problems.push("no watched attempt found in the evidence log; run `watch` first");
  } else {
    const expectedJob = String(prepared.body?.targetJobId || "").toLowerCase();
    const expectedBuyer = String(prepared.body?.targetBuyer || "").toLowerCase();
    const expectedAgent = String(prepared.body?.targetAgent || "");
    const receiptJob = String(receipt.targetJob?.jobId || receipt.target?.jobId || "").toLowerCase();
    const receiptAgent = receipt.target?.agentId ? `${receipt.target.agentName}#${receipt.target.agentId}` : "";
    if (expectedJob && receiptJob && receiptJob !== expectedJob) {
      problems.push(`receipt covers job ${receiptJob}, the watched attempt was ${expectedJob}`);
    }
    if (expectedJob && !receiptJob) problems.push("the receipt does not name a target job to compare");
    if (expectedBuyer && buyer && buyer !== expectedBuyer) {
      problems.push(`receipt buyer ${buyer} is not the watched buyer ${expectedBuyer}`);
    }
    if (expectedAgent && receiptAgent && receiptAgent !== expectedAgent) {
      problems.push(`receipt covers ${receiptAgent}, the watched attempt was ${expectedAgent}`);
    }
    // Job, buyer and agent can all match while the covenant differs: a different
    // approved cap, or a policy revised between the quote and the purchase, is a
    // different covenant than the one prepared. The attempt key already spans
    // exactly those four things, so recompute it from the receipt and require
    // equality rather than comparing a subset.
    if (prepared.attemptKey) {
      const receiptKey = receiptAttemptKey;
      if (receiptKey !== prepared.attemptKey) {
        problems.push(
          `receipt attempt ${receiptKey} is not the prepared attempt ${prepared.attemptKey}`
          + ` (policy ${receipt.target?.policyHash || "unknown"}, cap ${receipt.covenant?.coverageCapAtomic || "unknown"})`,
        );
      }
    }
  }

  if (payload.state !== "active") problems.push(`state is ${payload.state}, expected active`);
  if (payload.coverageState !== "COVERAGE_ACTIVE") {
    problems.push(`coverageState is ${payload.coverageState}, expected COVERAGE_ACTIVE`);
  }
  if (feeAtomic !== String(PAYMENT.amountAtomic)) {
    problems.push(`fee paid was ${feeAtomic || "unknown"} atomic, expected exactly ${PAYMENT.amountAtomic}`);
  }
  if (!buyer) problems.push("the receipt does not name a buyer wallet");
  else if (buyer === HOUSE_WALLET) problems.push(`buyer is the house wallet ${HOUSE_WALLET}`);

  // Everything above is identical whether the buyer used the listed service or
  // paid the endpoint directly, so none of it can establish that this became an
  // OKX sale. Verify that separately, against chain.
  const targetJobId = receipt.targetJob?.jobId || receipt.target?.jobId || null;
  const marketplaceTask = String(args.marketplaceTask || "");
  let createdTask = null;
  let acceptedTask = null;
  if (/^0x[a-fA-F0-9]{64}$/.test(marketplaceTask)
    && marketplaceTask.toLowerCase() !== String(targetJobId || "").toLowerCase()) {
    const head = await headBlock();
    const floor = head > MARKETPLACE_SCAN_BLOCKS ? head - MARKETPLACE_SCAN_BLOCKS : 0n;
    const created = receipt.targetJob?.creationBlock;
    const start = created && BigInt(created) > floor ? BigInt(created) : floor;
    const logs = await scanEscrow({ jobId: marketplaceTask, fromBlock: start, toBlock: head });
    const acceptance = logs.find((log) => log.topics[0]?.toLowerCase() === OKX_TASK.acceptedTopic);
    acceptedTask = acceptance ? decodeAcceptedTask(acceptance) : null;
    const creation = logs.find((log) => log.topics[0]?.toLowerCase() === OKX_TASK.createdTopic);
    if (creation) {
      createdTask = {
        jobId: creation.topics[1],
        buyer: topicAddress(creation.topics[2]),
        block: Number(BigInt(creation.blockNumber)),
        txHash: creation.transactionHash,
      };
    }
  }
  const acceptUnproven = args.attributionUnproven === true || args.attributionUnproven === "true";

  // Classified before the verdict, not after. Computing the route and then not
  // consulting it was the whole defect: a fee that settled as a direct transfer
  // was still reported as a verified marketplace sale whenever the buyer
  // happened to have some other qualifying task.
  let route = "unknown";
  if (fee.transaction) {
    const settlement = await rpc("eth_getTransactionReceipt", [fee.transaction]);
    route = paymentRoute(settlement?.logs, OKX_TASK.escrow, marketplaceTask);
  }

  const bindings = {
    taskId: marketplaceTask,
    targetJobId,
    receiptBuyer: buyer,
    created: createdTask,
    accepted: acceptedTask,
    expectedAgentId: MARKETPLACE.agentId,
    expectedProvider: receipt.target?.providerWallet || null,
    expectedFeeAtomic: PAYMENT.amountAtomic,
    expectedAsset: PAYMENT.asset,
    expectedServiceType: "A2MCP",
  };
  // Verified means every binding held with no waiver applied, which is why this
  // is evaluated separately from what blocks the confirmation below.
  const attributionProven = Boolean(createdTask && acceptedTask)
    && marketplaceProblems(bindings).length === 0;
  const attribution = attributionProven ? "okx_marketplace_task_verified" : "attribution_unproven";
  problems.push(...marketplaceProblems({ ...bindings, acceptUnproven }));

  console.log(`receipt        ${receiptId}`);
  console.log(`state          ${payload.state} / ${payload.coverageState}`);
  console.log(`buyer          ${buyer || "(absent)"}`);
  console.log(`fee paid       ${feeAtomic ? `${usdt(feeAtomic)} ${PAYMENT.symbol}` : "(absent)"}`);
  console.log(`liability      ${payload.liabilityAtomic ? usdt(payload.liabilityAtomic) : "(absent)"} ${PAYMENT.symbol}`);
  console.log(`deadline       ${payload.reconciliation?.deadline || "(absent)"}`);
  console.log(`fee settled as ${route}`);
  console.log(`marketplace    ${createdTask ? `task ${createdTask.jobId.slice(0, 10)}… created by ${createdTask.buyer} at block ${createdTask.block}` : "(unproven)"}`);
  console.log(`attribution    ${attribution}`);

  if (problems.length > 0) {
    record("confirm_failed", { receiptId, problems, route, marketplaceTask });
    console.error(`\nNOT CONFIRMED:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\nDo not withhold delivery until this passes.`);
    process.exitCode = 1;
    return;
  }

  record("confirm_passed", {
    receiptId, buyer, feeAtomic, route, attribution, marketplaceTask, createdTask, acceptedTask,
    deadline: payload.reconciliation?.deadline,
  });
  console.log(`\nCONFIRMED. An independent buyer paid exactly ${usdt(feeAtomic)} ${PAYMENT.symbol} and coverage is live.`);
  if (!attributionProven) {
    console.log("\nAttribution is UNPROVEN. Nothing here shows the purchase went through the listed");
    console.log("service, so do not describe the result as an OKX marketplace sale. The payout claim");
    console.log("is unaffected: buyer independence and the settlement are both verified above.");
  }
  console.log(`Public verifier: ${API_BASE}/proof/receipt?id=${receiptId}`);
  console.log(`\nNow withhold Foreman delivery. After the deadline:`);
  console.log(`  npm run ops:breach:check  -- --receipt-id ${receiptId}`);
  console.log(`  npm run ops:breach:settle -- --receipt-id ${receiptId}`);
  console.log(`\nThen decode the payout Transfer log and check the recipient is ${buyer},`);
  console.log(`not ${HOUSE_WALLET}.`);
}

// Guarded so a test can import the guards above without running the CLI.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] || "").href;
const [command, ...rest] = process.argv.slice(2);
if (invokedDirectly) {
const args = parseArgs(rest);
try {
  if (command === "watch") await watch(args);
  else if (command === "confirm") await confirm(args);
  else {
    console.error("usage: pilot-acceptance-watcher.mjs <watch|confirm> [options]");
    console.error("  watch   --job-id 0x… --from-block N --buyer 0x… --job-description \"…\" [--cap 0.5]");
    console.error("  confirm --receipt-id ppc-… --marketplace-task 0x… | --attribution-unproven");
    process.exitCode = 2;
  }
} catch (error) {
  record("fatal", { command, message: error instanceof Error ? error.message : String(error) });
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
}
