// The pilot watcher decides whether it is safe to withhold delivery on a job a
// real buyer has paid for. Its single most important assertion is that the buyer
// is not PolicyPool's own wallet, because that is the whole claim the pilot
// makes. This checks the guard can actually reach that conclusion.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buyerAddress, decodeAcceptedTask, marketplaceProblems, paymentRoute } from "./pilot-acceptance-watcher.mjs";

const HOUSE = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";
const KEJI = "0x52e19669d7b199531bf689f7ec943632bd211b75";

// Shape one, seen on all three live receipts: targetJob carries a plain address.
assert.equal(
  buyerAddress("0x52E19669d7b199531bF689f7ec943632Bd211B75", { address: KEJI }),
  KEJI,
  "a verified target job reports the buyer as a checksummed string",
);

// Shape two: an unverified target job falls back to a literal with no buyer at
// all, so the only remaining source is receipt.buyer, which is an object. This
// is the case that used to produce "[object Object]" — truthy, and therefore
// silently accepted by both the presence check and the house-wallet check.
assert.equal(
  buyerAddress(undefined, { address: "0x52E19669d7b199531bF689f7ec943632Bd211B75" }),
  KEJI,
  "an object-shaped buyer must resolve to its address, not to its stringification",
);
const stringified = String({ address: KEJI });
assert.notEqual(stringified, KEJI);
assert.notEqual(
  buyerAddress(undefined, { address: KEJI }),
  stringified,
  "the guard must never compare against a stringified object",
);

// The house wallet must still be recognised through either shape, or the pilot
// could confirm a receipt it paid to itself and report it as independent.
assert.equal(buyerAddress({ address: HOUSE }), HOUSE, "the house wallet must resolve through the object shape");
assert.equal(buyerAddress(HOUSE.toUpperCase().replace("0X", "0x")), HOUSE, "comparison must be case-insensitive");

// Anything that is not an address resolves to nothing, so the caller's
// `if (!buyer)` refusal fires instead of a comparison against a shape.
for (const bad of [undefined, null, "", {}, { address: null }, { address: "not-an-address" }, "0x1234", 42, []]) {
  assert.equal(buyerAddress(bad), "", `a buyer of ${JSON.stringify(bad) ?? "undefined"} must resolve to nothing`);
}
// A truncated or over-long address is not an address.
assert.equal(buyerAddress(`${KEJI}00`), "", "an over-long address must be rejected");
assert.equal(buyerAddress(KEJI.slice(0, -1)), "", "a truncated address must be rejected");

// Candidates are tried in order and the first usable one wins, so a present
// targetJob buyer is never overridden by the receipt-level fallback.
assert.equal(buyerAddress(KEJI, { address: HOUSE }), KEJI, "the first usable candidate must win");
assert.equal(buyerAddress(undefined, HOUSE), HOUSE, "an unusable candidate must not stop the search");

// The accepted event is decoded by byte offset, so the layout is pinned against
// a real log rather than against my reading of it: this is the acceptance of
// GlassDesk job 0xf8927c52…, which the live receipt independently reports as
// agent 3465 with a 0.5 USD~T0 value.
const REAL_ACCEPTED_LOG = {
  "topics": [
    "0x49c131ab4997b3c3791e5e208b585c027c75b36373559faece1d17bb38a1cac7",
    "0xf8927c523c426f87dae6a243ed38cbc0040b8532ef0dab1883fc990dca51d602",
    "0x0000000000000000000000004abbae03afff90f50d4f6b42b3e362f5228ad4c7"
  ],
  "data": "0x0000000000000000000000000000000000000000000000000000000000000d89000000000000000000000000779ded0c9e1022225f8e0630b35a9b54be713736000000000000000000000000000000000000000000000000000000000007a120fae86c32e8e42f693b2aaf96e6637d4db2d1caf5a08607b7cf88c9113fbc06c4"
};
const decoded = decodeAcceptedTask(REAL_ACCEPTED_LOG);
assert.equal(decoded.agentId, "3465", "agentId must decode from the first word");
assert.equal(decoded.provider, "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7", "the provider is topic 2");
assert.equal(decoded.asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736", "the asset is right-aligned in the second word");
assert.equal(decoded.amountAtomic, "500000", "the escrowed amount is the third word");
assert.equal(decodeAcceptedTask({ data: "0x", topics: [] }), null, "a log with no payload must not decode");
assert.equal(decodeAcceptedTask(undefined), null, "a missing log must not throw");

// Marketplace attribution. A receipt is identical whether the buyer used the
// listed service or paid /api/covered-job-receipt directly: same state, fee,
// buyer, job, policy and cap. Confirming instructs the provider to withhold
// delivery and labels the outcome a marketplace sale, so attribution has to be
// evidenced rather than assumed.
const ESCROW = "0x000000eb79a0c9cbeed4bd63372653e28f6bedbe";
const TARGET_JOB = `0x${"f8".repeat(32)}`;
const COVERAGE_TASK = `0x${"a1".repeat(32)}`;
const createdBy = (buyer, jobId = COVERAGE_TASK) => ({ jobId, buyer, block: 66140000, txHash: `0x${"e".repeat(64)}` });
const PP_AGENT = "4674";
const PP_WALLET = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";
const FEE = "100000";
const ZERO_HASH = `0x${"0".repeat(64)}`;
// PolicyPool's coverage listing is A2MCP, and the escrow records a zero service
// hash for that type. A non-zero hash here would be an A2A task.
const acceptedAs = (over = {}) => ({ agentId: PP_AGENT, provider: PP_WALLET, amountAtomic: FEE, asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736", serviceHash: ZERO_HASH, ...over });
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const bound = (over = {}) => ({
  taskId: COVERAGE_TASK, targetJobId: TARGET_JOB, receiptBuyer: KEJI,
  created: createdBy(KEJI), accepted: acceptedAs(),
  expectedAgentId: PP_AGENT, expectedProvider: PP_WALLET, expectedFeeAtomic: FEE,
  expectedAsset: USDT, expectedServiceType: "A2MCP",
  ...over,
});

// Verified against real transactions: the one external coverage purchase to date
// settled as an EIP-3009 transfer straight to the token contract and never
// touched the escrow, while the same buyer's marketplace purchase of the covered
// job emitted escrow logs.
const TOKEN_LOG = { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736" };
const escrowLogFor = (jobId, address = ESCROW) => ({ address, topics: [`0x${"5".repeat(64)}`, jobId] });
assert.equal(
  paymentRoute([TOKEN_LOG], ESCROW, COVERAGE_TASK),
  "direct_endpoint_payment",
  "a settlement that never touches the escrow is a direct endpoint payment",
);
assert.equal(
  paymentRoute([TOKEN_LOG, escrowLogFor(COVERAGE_TASK, ESCROW.toUpperCase())], ESCROW, COVERAGE_TASK),
  "okx_escrow_mediated",
  "escrow involvement must be recognised regardless of address casing",
);
// Touching the escrow is not the same as being this purchase. The marketplace
// task is validated by a separate historical scan that never reads these logs,
// so an unrelated escrow operation must not be able to stand in for one.
assert.equal(
  paymentRoute([TOKEN_LOG, escrowLogFor(TARGET_JOB)], ESCROW, COVERAGE_TASK),
  "escrow_unrelated_task",
  "escrow activity for a different task must not attribute this settlement",
);
assert.equal(
  paymentRoute([escrowLogFor(COVERAGE_TASK)], ESCROW, ""),
  "escrow_unrelated_task",
  "with no task to match against, escrow activity proves nothing",
);
assert.equal(
  paymentRoute([escrowLogFor(COVERAGE_TASK.toUpperCase().replace("0X", "0x"))], ESCROW, COVERAGE_TASK),
  "okx_escrow_mediated",
  "task matching must be case-insensitive",
);
assert.equal(paymentRoute(undefined, ESCROW, COVERAGE_TASK), "direct_endpoint_payment", "missing logs must not throw");

// Absent evidence refuses. This is the case Codex found: every other check
// passes and the pilot would proceed on a purchase that produced no OKX sale.
// Pinned to the reason, not merely to the count. Counting alone passed even
// with this branch deleted, because the malformed-id branch fired instead and
// one problem looked like the other.
const noEvidence = marketplaceProblems({ taskId: "", targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null });
assert.equal(noEvidence.length, 1, "a confirmation with no marketplace evidence must refuse, not pass");
assert.match(
  noEvidence[0],
  /no --marketplace-task supplied/,
  "the refusal must name the missing evidence, so an operator knows what to supply",
);
assert.match(
  noEvidence[0],
  /covered-job-receipt/,
  "the refusal must say why an ordinary receipt is not proof of a marketplace sale",
);
// The buyer's only escrow task in this pilot is the covered job itself, so
// passing that id must not satisfy the check.
assert.ok(
  marketplaceProblems({ taskId: TARGET_JOB, targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: createdBy(KEJI, TARGET_JOB) }).length > 0,
  "the covered job must not double as proof of how coverage was bought",
);
// A task nobody created on chain proves nothing.
assert.ok(
  marketplaceProblems(bound({ created: null })).length > 0,
  "an unverifiable task id must refuse",
);
// A real task bought by somebody else is not this buyer's purchase.
assert.ok(
  marketplaceProblems(bound({ created: createdBy(HOUSE) })).length > 0,
  "a marketplace task created by another wallet must refuse",
);
assert.ok(
  marketplaceProblems({ taskId: "not-a-task", targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null }).length > 0,
  "a malformed task id must refuse",
);
assert.ok(
  marketplaceProblems(bound({ receiptBuyer: "" })).length > 0,
  "a receipt with no buyer cannot be matched against a marketplace task",
);
// The one shape that passes: a distinct task, created on chain by this buyer,
// and accepted by PolicyPool's own listing for the coverage fee.
assert.deepEqual(marketplaceProblems(bound()), [],
  "a task bound to PolicyPool's listing is the evidence this check wants");

// Agent, wallet, asset and amount can all match on a task of the wrong kind.
// An A2A task sold by agent 4674 through the same wallet for the same 0.10 fee
// would otherwise be recorded as the A2MCP coverage listing. The escrow's
// service hash is what separates them, and the rule comes from
// validateServiceBinding rather than being restated here.
assert.ok(
  marketplaceProblems(bound({ accepted: acceptedAs({ serviceHash: `0x${"b".repeat(64)}` }) })).length > 0,
  "an A2A task must not pass as the A2MCP coverage listing",
);
// And the rule runs in the right direction: the same hash is required for A2A.
assert.ok(
  marketplaceProblems(bound({ expectedServiceType: "A2A" })).length > 0,
  "a zero service hash must not pass as an A2A listing",
);
assert.deepEqual(
  marketplaceProblems(bound({ expectedServiceType: "A2A", accepted: acceptedAs({ serviceHash: `0x${"b".repeat(64)}` }) })),
  [],
  "a non-zero hash is exactly what an A2A listing requires",
);
// An unsupported type must refuse rather than silently skip the check.
assert.ok(
  marketplaceProblems(bound({ expectedServiceType: "A2Z" })).length > 0,
  "an unrecognised listing type must refuse",
);

// The settlement route must NOT gate attribution. The coverage fee is an x402
// payment settled as a plain token transfer to PAYMENT.payTo, and any OKX task
// lives in its own escrow transaction, so a genuine marketplace purchase has no
// escrow log in its fee transaction. Requiring one rejected exactly the purchase
// this watcher exists to confirm.
assert.deepEqual(
  marketplaceProblems(bound({ route: "direct_endpoint_payment" })),
  [],
  "a genuine marketplace purchase settles its fee as a direct token transfer and must still verify",
);
assert.deepEqual(
  marketplaceProblems(bound({ route: "escrow_unrelated_task" })),
  [],
  "the fee transaction's escrow content cannot decide attribution in either direction",
);

// An amount without its denomination is not an amount.
assert.ok(
  marketplaceProblems(bound({ accepted: acceptedAs({ asset: `0x${"c".repeat(40)}` }) })).length > 0,
  "100000 units of another token is not the 0.10 USD~T0 coverage fee",
);

// Buyer identity alone is not attribution. Any escrow task this buyer happened
// to create after the covered job would otherwise satisfy every check above
// while saying nothing about PolicyPool, which is the hole Codex found.
assert.ok(
  marketplaceProblems(bound({ accepted: null })).length > 0,
  "an unaccepted task proves only that this buyer created some task",
);
assert.ok(
  marketplaceProblems(bound({ accepted: acceptedAs({ agentId: "3465" }) })).length > 0,
  "a task bought from a different agent is not a PolicyPool sale",
);
assert.ok(
  marketplaceProblems(bound({ accepted: acceptedAs({ provider: `0x${"9".repeat(40)}` }) })).length > 0,
  "a task accepted by another wallet is not PolicyPool's",
);
assert.ok(
  marketplaceProblems(bound({ accepted: acceptedAs({ amountAtomic: "500000" }) })).length > 0,
  "a task escrowing something other than the coverage fee is not this purchase",
);
// Casing must not decide the outcome either way.
assert.deepEqual(
  marketplaceProblems(bound({
    taskId: COVERAGE_TASK.toUpperCase().replace("0X", "0x"),
    receiptBuyer: KEJI.toUpperCase().replace("0X", "0x"),
    created: createdBy(KEJI.toUpperCase().replace("0X", "0x")),
    expectedProvider: PP_WALLET.toUpperCase().replace("0X", "0x"),
  })),
  [],
  "attribution must be case-insensitive",
);

// The escape exists because PolicyPool's own listing is A2MCP and it is not
// established that buying it produces an escrow task at all, so a hard block
// could strand the pilot at the one moment it cannot be restarted. It must stay
// explicit: silence still refuses, and only the flag proceeds.
assert.deepEqual(
  marketplaceProblems({ taskId: "", targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null, acceptUnproven: true }),
  [],
  "an operator who states the attribution is unproven may proceed",
);
assert.equal(
  marketplaceProblems({ taskId: "", targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null, acceptUnproven: false }).length,
  1,
  "the default must still refuse, so proceeding is always a deliberate act",
);
// The escape waives the missing evidence. It must not waive evidence that is
// present and wrong, or it becomes a way to launder a mismatched task.
assert.ok(
  marketplaceProblems(bound({ created: createdBy(HOUSE), acceptUnproven: true })).length > 0,
  "the escape must not suppress a marketplace task created by the wrong wallet",
);
assert.ok(
  marketplaceProblems(bound({ taskId: TARGET_JOB, created: createdBy(KEJI, TARGET_JOB), acceptUnproven: true })).length > 0,
  "the escape must not let the covered job stand in as its own proof",
);

// Proceeding unproven must be recorded as unproven wherever the run is written
// down, or the distinction is lost the moment anyone reads the evidence log.
const confirmSource = await readFile(new URL("./pilot-acceptance-watcher.mjs", import.meta.url), "utf8");
assert.match(
  confirmSource,
  /const attribution = attributionProven \? "okx_marketplace_task_verified" : "attribution_unproven"/,
  "the run must carry an explicit attribution verdict",
);
// The verdict must come from every binding holding, not from a task merely
// existing. Deriving it from createdTask alone was the defect: an unrelated
// task by the same buyer would have been reported as a verified sale.
assert.match(
  confirmSource,
  /attributionProven = Boolean\(createdTask && acceptedTask\)[\s\S]{0,600}?\.length === 0/,
  "attribution must be proven by the full binding, not by the presence of a task",
);
// Every binding the helper accepts must actually be supplied by confirm. A guard
// that is never fed its input is inert, and that is not hypothetical here: route
// was computed and then left out of the call, so the check existed and did
// nothing. Deleting any of these lines must fail rather than silently disarm.
const bindingsBlock = confirmSource.match(/const bindings = \{[\s\S]*?\n  \};/)?.[0] || "";
assert.ok(bindingsBlock, "confirm must assemble its bindings in one place");
for (const field of [
  "expectedAgentId",
  "expectedProvider",
  "expectedFeeAtomic",
  "expectedAsset",
  "expectedServiceType",
]) {
  assert.match(bindingsBlock, new RegExp(`${field}:`), `confirm must supply ${field} or that guard is inert`);
}
// Route is recorded, not required. It must still reach the evidence log.
assert.match(
  confirmSource,
  /record\("confirm_passed", \{[\s\S]*?route,/,
  "the settlement route must still be recorded even though it does not gate attribution",
);
// Supplying the field is not enough; it has to name the right listing. Declaring
// A2A here would invert the guard: A2A tasks would pass and genuine A2MCP
// coverage purchases would be refused. PolicyPool's listed coverage service is
// A2MCP, which is why the escrow records a zero service hash for it.
assert.match(
  bindingsBlock,
  /expectedServiceType:\s*"A2MCP"/,
  "confirm must declare PolicyPool's actual listing type, not merely some type",
);
// And the route must be classified against the task it is meant to attribute.
// Calling paymentRoute without the task id makes every escrow log look like
// this purchase, which is the guard failing open rather than closed.
assert.match(
  confirmSource,
  /paymentRoute\(settlement\?\.logs, OKX_TASK\.escrow, marketplaceTask\)/,
  "confirm must classify the settlement route against the supplied marketplace task",
);
assert.match(
  confirmSource,
  /record\("confirm_passed", \{[\s\S]*?attribution,/,
  "the attribution verdict must reach the append-only evidence log",
);
assert.match(
  confirmSource,
  /do not describe the result as an OKX marketplace sale/,
  "an unproven run must say so on the console, where the operator will actually read it",
);

// The helper above is only worth anything if confirm actually consults it. A
// correct guard that nothing calls is precisely the shape of the defect this
// check exists to prevent, and no unit test of the helper would notice.
const source = await readFile(new URL("./pilot-acceptance-watcher.mjs", import.meta.url), "utf8");
const confirmBody = source.slice(source.indexOf("async function confirm("));
assert.ok(confirmBody, "confirm must exist");
assert.match(
  confirmBody,
  /problems\.push\(\.\.\.marketplaceProblems\(/,
  "confirm must fold marketplace attribution into the problems that block a confirmation",
);
assert.match(
  confirmBody,
  /const marketplaceTask = String\(args\.marketplaceTask/,
  "confirm must read the marketplace task from its arguments",
);

console.log(
  "PolicyPool pilot watcher passed: buyer identity resolves from either receipt shape,"
  + " rejects non-addresses, cannot be satisfied by a stringified object,"
  + " and refuses to call a purchase a marketplace sale without on-chain evidence.",
);
