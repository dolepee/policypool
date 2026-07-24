import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReceiptView } from "../web/receipt.js";

// Fixtures are verbatim production responses for the three real receipts that
// cover every terminal and non-terminal state the verifier can render.
const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/coverage-receipts.json", import.meta.url), "utf8"),
);

const active = buildReceiptView(fixtures["ppc-0b0e52828eb26727"]);
assert.equal(active.found, true);
assert.equal(active.state, "active");
assert.equal(active.stateLabel, "COVERAGE ACTIVE");
assert.match(active.plain, /Coverage is in force/);
assert.match(active.plain, /0\.5 USD₮0/, "an active receipt must state the maximum payout");

const released = buildReceiptView(fixtures["ppc-d99d7f72895d70ab"]);
assert.equal(released.state, "released");
assert.equal(released.stateLabel, "RELEASED");
assert.match(released.plain, /delivered within the agreed deadline/);
assert.ok(
  released.values.some(([label]) => label === "Released because"),
  "a released receipt must show why it was released",
);

const paid = buildReceiptView(fixtures["ppc-bd38c81112102af0"]);
assert.equal(paid.state, "paid");
assert.equal(paid.stateLabel, "PAID OUT");
assert.match(paid.plain, /paid the buyer 0\.5 USD₮0/, "a paid receipt must state the amount paid");
assert.ok(
  paid.evidence.some((item) => item.label === "Payout to buyer"),
  "a paid receipt must link the payout transaction",
);
assert.ok(
  paid.evidence.some((item) => item.href.includes("0x492a8e5effbbf9fc2b064c3da0435d797fc2f498967439a970e97439908adffa")),
  "the payout link must point at the real payout transaction",
);

// The fee shown must be the fee this receipt actually recorded. Older receipts
// were priced differently from the current listing, so a default would print a
// number nobody paid.
const feeRow = paid.values.find(([label]) => label === "Service fee paid");
assert.deepEqual(feeRow, ["Service fee paid", "1 USD₮0"], "the fee must come from the receipt, not a default");
const feeless = buildReceiptView({
  ok: true,
  receiptId: "ppc-feeless",
  state: "active",
  receipt: { covenant: { coverageCapUSDT: "0.5" }, servicePayment: {} },
});
assert.ok(
  !feeless.values.some(([label]) => label === "Service fee paid"),
  "an unknown fee must be omitted rather than invented",
);

// Timestamps render uniformly, with no leaked millisecond ISO tails.
for (const view of [active, released, paid]) {
  for (const [label, value] of view.values) {
    assert.ok(!/\.\d{3}Z/.test(String(value)), `${label} must not leak a raw ISO timestamp`);
  }
}

// Every state must expose the evidence a reader needs to check the claim.
for (const [id, view] of [["active", active], ["released", released], ["paid", paid]]) {
  assert.ok(view.values.length >= 6, `${id} must render a substantive fact table`);
  for (const label of ["Target job created", "Target job accepted", "Coverage paid for"]) {
    assert.ok(view.evidence.some((item) => item.label === label), `${id} must link "${label}"`);
  }
  for (const item of view.evidence) {
    assert.match(item.href, /^https:\/\/www\.oklink\.com\/x-layer\//, `${id} evidence must link to the public explorer`);
  }
}

// Controlled-provider disclosure must be present, never silently omitted.
assert.ok(paid.disclosure, "a house-provider receipt must disclose that it is a controlled test");
assert.match(paid.disclosure, /Controlled/);

// Unknown or malformed receipts fail visibly rather than rendering a blank page.
const missing = buildReceiptView({ ok: false, error: "receipt_not_found" });
assert.equal(missing.found, false);
assert.equal(missing.stateLabel, "NOT FOUND");
assert.equal(missing.evidence.length, 0);
assert.equal(buildReceiptView(null).found, false);
assert.equal(buildReceiptView({ ok: true }).found, false, "a payload without a receipt is not a receipt");

// A service outage must not be presented as a missing receipt, or a judge
// checking a valid ID during a chain-lookup blip is told it does not exist.
for (const outage of [
  { payload: { ok: false, error: "coverage_status_unavailable" }, options: {} },
  { payload: { ok: false, error: "rpc_error" }, options: {} },
  { payload: { ok: false, error: "anything" }, options: { httpStatus: 503 } },
  { payload: null, options: { httpStatus: 502 } },
]) {
  const view = buildReceiptView(outage.payload, outage.options);
  assert.equal(view.unavailable, true, "an outage must be reported as unavailable");
  assert.equal(view.stateLabel, "TEMPORARILY UNAVAILABLE");
  assert.match(view.plain, /does not mean the receipt is missing/);
}
assert.equal(
  buildReceiptView({ ok: false, error: "receipt_not_found" }, { httpStatus: 404 }).unavailable,
  false,
  "a genuine 404 is still reported as not found",
);

// A cleanup record must never be rendered as an owed payout. The page has to
// agree with the lifecycle contract, which maps it to RECONCILIATION_PENDING.
const cleanup = buildReceiptView({
  ok: true,
  receiptId: "ppc-cleanup",
  state: "compensation_required",
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
});
assert.equal(cleanup.stateLabel, "RECONCILIATION PENDING");
assert.doesNotMatch(cleanup.plain, /payout of up to/i, "a cleanup record must not quote a payable amount");
assert.doesNotMatch(cleanup.plain, /is owed to the buyer/i, "a cleanup record must not assert a payout is owed");
assert.match(cleanup.plain, /no payout is owed/i, "it must state plainly that nothing is owed on this receipt");
assert.match(cleanup.plain, /awaiting reconciliation/i);

// A relay covenant awaiting its clock is paid and issued, not terminal.
const awaitingClock = buildReceiptView({
  ok: true,
  receiptId: "ppc-relay",
  state: "pending_start",
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "Foreman", agentId: "4348" }, servicePayment: {} },
});
assert.equal(awaitingClock.found, true);
assert.equal(awaitingClock.stateLabel, "AWAITING CLOCK START");
assert.doesNotMatch(awaitingClock.plain, /no longer in force/, "a pending relay receipt is not terminal");
assert.match(awaitingClock.plain, /not counting down yet/);

// The page must ship, be routed, and keep the shared navigation contract.
const html = await readFile(new URL("../web/receipt.html", import.meta.url), "utf8");
assert.equal((html.match(/<h1\b/g) || []).length, 1, "receipt.html must have one h1");
assert.equal((html.match(/<main\b/g) || []).length, 1, "receipt.html must have one main landmark");
assert.equal((html.match(/class="desktop-nav"/g) || []).length, 1, "receipt.html must retain desktop navigation");
const desktopNav = html.match(/<nav class="desktop-nav"[\s\S]*?<\/nav>/)?.[0] || "";
assert.equal((desktopNav.match(/<a\b/g) || []).length, 5, "receipt.html desktop nav must contain exactly five links");
assert.match(html, /class="mobile-nav"/, "receipt.html must retain mobile navigation");
assert.ok(
  html.includes('rel="canonical" href="https://policypool.vercel.app/proof/receipt"'),
  "receipt.html canonical mismatch",
);
assert.ok(html.includes('href="/api/manifest"'), "receipt.html must link the machine-readable manifest");
assert.match(html, /id="receipt-form"/, "receipt.html must expose the lookup form");

// Every element the script reaches for must exist in the markup. A renamed id
// would otherwise fail only in a browser, which nothing else here exercises.
const script = await readFile(new URL("../web/receipt.js", import.meta.url), "utf8");
const referencedIds = [...new Set([...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]))];
assert.ok(referencedIds.length >= 7, "the verifier script must bind the receipt panel elements");
for (const id of referencedIds) {
  assert.ok(html.includes(`id="${id}"`), `receipt.html is missing #${id}, which receipt.js reads`);
}
assert.match(html, /data-example="ppc-/, "receipt.html must offer at least one live example receipt");

const webPackage = JSON.parse(await readFile(new URL("../web/package.json", import.meta.url), "utf8"));
for (const asset of ["receipt.html", "receipt.js"]) {
  assert.ok(webPackage.scripts.build.includes(asset), `${asset} must be copied into the web build`);
}

const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
assert.ok(
  vercel.routes.some((entry) => entry.src === "/proof/receipt" && entry.dest === "/web/receipt.html"),
  "/proof/receipt must resolve to the receipt verifier",
);

console.log("PolicyPool receipt verifier passed: three real receipts, evidence links, disclosure, routing, and build wiring.");
