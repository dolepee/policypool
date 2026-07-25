// The pilot watcher decides whether it is safe to withhold delivery on a job a
// real buyer has paid for. Its single most important assertion is that the buyer
// is not PolicyPool's own wallet, because that is the whole claim the pilot
// makes. This checks the guard can actually reach that conclusion.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buyerAddress, marketplaceProblems, paymentRoute } from "./pilot-acceptance-watcher.mjs";

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

// Marketplace attribution. A receipt is identical whether the buyer used the
// listed service or paid /api/covered-job-receipt directly: same state, fee,
// buyer, job, policy and cap. Confirming instructs the provider to withhold
// delivery and labels the outcome a marketplace sale, so attribution has to be
// evidenced rather than assumed.
const ESCROW = "0x000000eb79a0c9cbeed4bd63372653e28f6bedbe";
const TARGET_JOB = `0x${"f8".repeat(32)}`;
const COVERAGE_TASK = `0x${"a1".repeat(32)}`;
const createdBy = (buyer, jobId = COVERAGE_TASK) => ({ jobId, buyer, block: 66140000, txHash: `0x${"e".repeat(64)}` });

// Verified against real transactions: the one external coverage purchase to date
// settled as an EIP-3009 transfer straight to the token contract and never
// touched the escrow, while the same buyer's marketplace purchase of the covered
// job emitted escrow logs.
assert.equal(
  paymentRoute([{ address: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }], ESCROW),
  "direct_endpoint_payment",
  "a settlement that never touches the escrow is a direct endpoint payment",
);
assert.equal(
  paymentRoute([{ address: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }, { address: ESCROW.toUpperCase() }], ESCROW),
  "okx_escrow_mediated",
  "escrow involvement must be recognised regardless of address casing",
);
assert.equal(paymentRoute(undefined, ESCROW), "direct_endpoint_payment", "missing logs must not throw");

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
  marketplaceProblems({ taskId: COVERAGE_TASK, targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null }).length > 0,
  "an unverifiable task id must refuse",
);
// A real task bought by somebody else is not this buyer's purchase.
assert.ok(
  marketplaceProblems({ taskId: COVERAGE_TASK, targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: createdBy(HOUSE) }).length > 0,
  "a marketplace task created by another wallet must refuse",
);
assert.ok(
  marketplaceProblems({ taskId: "not-a-task", targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: null }).length > 0,
  "a malformed task id must refuse",
);
assert.ok(
  marketplaceProblems({ taskId: COVERAGE_TASK, targetJobId: TARGET_JOB, receiptBuyer: "", created: createdBy(KEJI) }).length > 0,
  "a receipt with no buyer cannot be matched against a marketplace task",
);
// The one shape that passes: a distinct task, created on chain, by this buyer.
assert.deepEqual(
  marketplaceProblems({ taskId: COVERAGE_TASK, targetJobId: TARGET_JOB, receiptBuyer: KEJI, created: createdBy(KEJI) }),
  [],
  "a distinct task created on chain by the receipt buyer is the evidence this check wants",
);
// Casing must not decide the outcome either way.
assert.deepEqual(
  marketplaceProblems({
    taskId: COVERAGE_TASK.toUpperCase().replace("0X", "0x"),
    targetJobId: TARGET_JOB,
    receiptBuyer: KEJI.toUpperCase().replace("0X", "0x"),
    created: createdBy(KEJI.toUpperCase().replace("0X", "0x")),
  }),
  [],
  "attribution must be case-insensitive",
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
