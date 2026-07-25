import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReceiptView, createLookupSequencer } from "../web/receipt.js";

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
// This real receipt was released with reason `platform_job_completed`, which the
// reconciler records from job status alone. It establishes that the job
// eventually completed, not that it completed inside the SLA, so the page must
// report it neutrally and surface the recorded reason instead.
assert.equal(released.release?.reason ?? "platform_job_completed", "platform_job_completed");
assert.doesNotMatch(
  released.plain,
  /delivered within the agreed deadline/i,
  "completion status alone must not be presented as timely delivery",
);
assert.doesNotMatch(released.headline, /delivered on time/i);
assert.match(released.plain, /platform_job_completed/, "the recorded reason must be shown to the reader");
assert.ok(
  released.values.some(([label]) => label === "Released because"),
  "a released receipt must show why it was released",
);

const paid = buildReceiptView(fixtures["ppc-bd38c81112102af0"]);
assert.equal(paid.state, "paid");
assert.equal(paid.stateLabel, "PAID OUT");
assert.match(paid.plain, /was paid 0\.5 USD₮0/, "a paid receipt must state the amount paid");
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
// The fact table must agree with that explanation rather than quote an amount.
assert.ok(
  !cleanup.values.some(([label]) => label === "Maximum payout"),
  "a cleanup record must not display a maximum payout row",
);

// Cleanup records are copied from the pre-finalisation reservation, so they
// carry a ledger state but no receipt document. They must still render.
const cleanupWithoutReceipt = buildReceiptView({
  ok: true,
  receiptId: "ppc-cleanup-bare",
  state: "compensation_required",
});
assert.equal(cleanupWithoutReceipt.found, true, "a record with a state exists even without a receipt document");
assert.equal(cleanupWithoutReceipt.stateLabel, "RECONCILIATION PENDING");
assert.match(cleanupWithoutReceipt.plain, /awaiting reconciliation/i);
assert.ok(
  !cleanupWithoutReceipt.values.some(([label]) => label === "Maximum payout"),
  "a receiptless cleanup record must not display a maximum payout row",
);

// A pre-settlement reservation is likewise a real record with no receipt yet.
const reservedNoReceipt = buildReceiptView({ ok: true, receiptId: "ppc-reserved-view", state: "pending" });
assert.equal(reservedNoReceipt.found, true);
assert.equal(reservedNoReceipt.stateLabel, "PAYMENT NOT SETTLED");
assert.ok(
  !reservedNoReceipt.values.some(([label]) => label === "Maximum payout"),
  "an unfunded reservation must not display a maximum payout row",
);

// A genuinely unknown id, carrying neither state nor receipt, is still absent.
assert.equal(buildReceiptView({ ok: true, receiptId: "ppc-nothing" }).found, false);

// A funded, in-force covenant still shows what it could pay.
const payableCap = buildReceiptView({
  ok: true,
  receiptId: "ppc-payable",
  state: "active",
  receipt: { covenant: { coverageCapUSDT: "0.5", deadline: "2026-07-25T16:34:29.000Z" }, target: {}, servicePayment: {} },
});
assert.ok(
  payableCap.values.some(([label, value]) => label === "Maximum payout" && value === "0.5 USD₮0"),
  "active coverage must still state its maximum payout",
);

// v0.4 covenants settle from the provider's own first-loss bond, not the shared
// reserve, so the funding source must be read from the receipt.
const paidPayout = {
  amountAtomic: "500000",
  transaction: `0x${"ab".repeat(32)}`,
  verifiedAt: "2026-07-20T00:00:00.000Z",
};
const providerFundedPayout = buildReceiptView({
  ok: true,
  receiptId: "ppc-provider-funded",
  state: "paid",
  payout: paidPayout,
  receipt: {
    covenant: { coverageCapUSDT: "0.5" },
    target: {},
    servicePayment: {},
    providerBond: { custody: "provider_first_loss_bond_vault", sharedReserveUsed: false },
  },
});
assert.match(providerFundedPayout.plain, /provider's own first-loss bond/i);
assert.doesNotMatch(
  providerFundedPayout.plain,
  /from the PolicyPool reserve/i,
  "a provider-funded payout must not be attributed to the shared reserve",
);

const reserveFundedPayout = buildReceiptView({
  ok: true,
  receiptId: "ppc-reserve-funded",
  state: "paid",
  payout: paidPayout,
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: {}, servicePayment: {}, providerBond: null },
});
assert.match(reserveFundedPayout.plain, /from the PolicyPool reserve/i);

// A zero-recovery settlement stores a payout object with amountAtomic "0" and
// its settlement transaction. That is not money paid to the buyer.
const zeroRecovery = buildReceiptView({
  ok: true,
  receiptId: "ppc-zero",
  state: "recovered_without_payout",
  payout: { amountAtomic: "0", transaction: `0x${"cd".repeat(32)}`, verifiedAt: "2026-07-20T00:00:00.000Z" },
  release: { reason: "recovered_without_payout" },
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: {}, servicePayment: {} },
});
assert.ok(
  !zeroRecovery.values.some(([label]) => label === "Paid to buyer"),
  "a zero-value recovery must not report money paid to the buyer",
);
assert.ok(
  !zeroRecovery.evidence.some((item) => item.label === "Payout to buyer"),
  "a zero-value settlement must not be labelled a payout",
);
assert.ok(
  zeroRecovery.evidence.some((item) => item.label === "Recovery settlement, no payout"),
  "the settlement transaction is still linked, labelled honestly",
);
assert.doesNotMatch(zeroRecovery.plain, /delivered within the agreed deadline/i, "recovery is not a delivery claim");

// Released reached by expiry must not be presented as on-time delivery.
const expiredRelease = buildReceiptView({
  ok: true,
  receiptId: "ppc-expired",
  state: "released",
  release: { reason: "expire_unstarted" },
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "Foreman", agentId: "4348" }, servicePayment: {} },
});
assert.doesNotMatch(expiredRelease.plain, /delivered within the agreed deadline/i);
assert.match(expiredRelease.plain, /not a statement that the service was delivered/i);

// Only a reason that actually verified timing may claim delivery was on time,
// and the headline must agree with the paragraph beneath it. The reconciler
// records `platform_job_completed` from job status alone, with no completion
// timestamp and no deadline comparison, so a late job still earns that reason.
for (const reason of ["platform_job_completed", "expire_unstarted", "recovered_without_payout"]) {
  const view = buildReceiptView({
    ok: true,
    receiptId: "ppc-neutral",
    state: "released",
    release: { reason },
    receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
  });
  assert.doesNotMatch(view.plain, /delivered within the agreed deadline/i, `${reason} must not claim timely delivery`);
  assert.doesNotMatch(view.headline, /delivered on time/i, `${reason} headline must stay neutral`);
}

// A time-verified release still reads as an on-time delivery, headline included.
const deliveredRelease = buildReceiptView({
  ok: true,
  receiptId: "ppc-delivered",
  state: "released",
  release: { reason: "service_delivered_within_sla" },
  receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
});
assert.match(deliveredRelease.plain, /delivered within the agreed deadline/i);
assert.match(deliveredRelease.headline, /delivered on time/i);

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

// The v0.4 universal reconciler persists these terminal states and
// /api/coverage-status forwards them, so the page must explain them rather than
// print a raw internal label and call a resolved covenant "no longer in force".
const universalTerminal = {
  recovered_without_payout: { label: "RELEASED", plain: /recovery without any payout/i },
  cancelled_unpaid: { label: "CANCELLED", plain: /cancelled before its fee settled/i },
};
for (const [ledgerState, expected] of Object.entries(universalTerminal)) {
  const view = buildReceiptView({
    ok: true,
    receiptId: `ppc-${ledgerState}`,
    state: ledgerState,
    receipt: { covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
  });
  assert.equal(view.stateLabel, expected.label, `${ledgerState} must have a presentation`);
  assert.doesNotMatch(view.plain, /no longer in force/i, `${ledgerState} must be explained, not dismissed`);
  assert.doesNotMatch(view.plain, /delivered within the agreed deadline/i, `${ledgerState} is not a delivery claim`);
  assert.match(view.plain, expected.plain);
  assert.ok(
    !view.values.some(([label]) => label === "Maximum payout"),
    `${ledgerState} must not quote a payable amount`,
  );
}

// A blank or whitespace-only submission must retire the previous receipt rather
// than leave it beside an empty input.
const blankGuard = await readFile(new URL("../web/receipt.js", import.meta.url), "utf8");
const blankBranch = blankGuard.match(/if \(!receiptId\) \{[\s\S]*?\n    \}/)?.[0] || "";
assert.ok(blankBranch, "the blank-input branch must exist");

// The panel invariant is enforced at one choke point rather than per branch,
// because enforcing it per branch produced four near-identical defects in a
// row, each a path that met one half of it. Assert the structure, so a future
// branch cannot reintroduce the split.
assert.match(
  blankGuard,
  /const beginLookup = \(\) => \{\s*const isCurrent = sequencer\.begin\(\);\s*clearRenderedReceipt\(\);/,
  "generation and panel must be reset together in one helper",
);
const runRoutine = blankGuard.match(/const run = async \(receiptId\) => \{[\s\S]*?\n  \};/)?.[0] || "";
assert.match(
  runRoutine,
  /^\s*const run = async \(receiptId\) => \{\s*const isCurrent = beginLookup\(\);/,
  "every lookup must reset through beginLookup before any branching",
);
assert.ok(
  runRoutine.indexOf("beginLookup()") < runRoutine.indexOf("if (!receiptId)"),
  "the reset must precede the blank-input check, not follow it",
);
assert.equal(
  (runRoutine.match(/sequencer\.begin\(\)/g) || []).length,
  0,
  "no branch may advance the generation on its own; that split is the defect",
);
assert.equal(
  (runRoutine.match(/clearRenderedReceipt\(\)/g) || []).length,
  0,
  "no branch may clear the panel on its own; that split is the defect",
);

// The sequencer must genuinely invalidate an outstanding lookup, not merely
// hand out a newer token: this is the blank-submission case in miniature.
const invalidation = createLookupSequencer();
const inFlight = invalidation.begin();
assert.equal(inFlight(), true, "the lookup is current while it is the only one");
invalidation.begin();
assert.equal(inFlight(), false, "starting another generation must invalidate the in-flight lookup");

// Example links must not assert more than the referenced receipt can support.
const examplesHtml = await readFile(new URL("../web/receipt.html", import.meta.url), "utf8");
assert.doesNotMatch(
  examplesHtml,
  /ppc-d99d7f72895d70ab"[^>]*>released after on-time delivery/,
  "that receipt was released by completion status, which does not establish on-time delivery",
);
for (const id of ["ppc-affca246b1cf8c9b", "ppc-d99d7f72895d70ab", "ppc-bd38c81112102af0"]) {
  assert.ok(examplesHtml.includes(`data-example="${id}"`), `${id} must be offered as a live example`);
}

// The active-coverage promise depends on the covenant's recorded payout basis;
// the pipelines genuinely differ, so one sentence cannot be correct for all.
function activeView(payoutBasis, providerBonded, clockMode) {
  return buildReceiptView({
    ok: true,
    receiptId: "ppc-active-basis",
    state: "active",
    receipt: {
      version: providerBonded ? "0.4.0" : "0.2.0",
      covenant: { coverageCapUSDT: "0.5", deadline: "2026-07-26T00:00:00.000Z" },
      target: { agentName: "Foreman", agentId: "4348", payoutBasis, ...(clockMode ? { clockMode } : {}) },
      servicePayment: {},
      ...(providerBonded ? { providerBond: { custody: "provider_first_loss_bond_vault" } } : {}),
    },
  });
}

const bonded = activeView("provider_bonded_sla_credit", true);
assert.match(bonded.plain, /first-loss bond/i, "a bonded SLA credit pays from the bond");
assert.match(bonded.plain, /even if the platform later stops, closes, refunds, or expires/i,
  "a bonded SLA credit is payable despite later platform-terminal outcomes");

const netLoss = activeView("net_loss", true);
assert.match(netLoss.plain, /marketplace recovery is terminal/i, "net-loss pays only after terminal recovery");
assert.match(netLoss.plain, /recovered amounts/i, "net-loss is reduced by recoveries");
// observeOkxA2AClock releases a verified-acceptance covenant outright when a
// terminal status lands at or before the deadline, so a promise that mentions
// only the post-deadline recovery path omits the outcome that pays nothing.
assert.match(
  netLoss.plain,
  /released without a payout/i,
  "a verified-acceptance net-loss covenant must disclose the early-terminal release",
);

// That early release is a marketplace outcome, so it must not be promised for a
// covenant clocked by PolicyPool's relay.
const netLossRelay = activeView("net_loss", true, "policypool_relay");
assert.match(netLossRelay.plain, /marketplace recovery is terminal/i);
assert.doesNotMatch(
  netLossRelay.plain,
  /released without a payout/i,
  "a relay net-loss covenant must not promise release for a platform-ended job",
);
assert.match(netLossRelay.plain, /relay clock/i, "a relay covenant must say which clock governs it");

const legacy = activeView("legacy_reserve_covenant", false);
assert.match(legacy.plain, /still accepted/i, "a reserve covenant requires the job to stay accepted");
assert.match(legacy.plain, /released without a payout/i, "a reserve covenant releases on platform-terminal outcomes");

// The three wordings are genuinely distinct, so no basis is silently misdescribed.
assert.notEqual(bonded.plain, legacy.plain, "bonded and reserve wording must differ");
assert.notEqual(netLoss.plain, legacy.plain, "net-loss and reserve wording must differ");

// Payout basis and clock mode are enrolled independently, so a bonded covenant
// may still run on PolicyPool's relay clock. observeRelayClock never reads
// marketplace job status, so for a relay covenant the promise that a
// platform-ended job is released before the deadline is one the reconciler
// contradicts: absent a verified in-SLA response it still becomes payable.
const bondedRelay = activeView("provider_bonded_sla_credit", true, "policypool_relay");
assert.match(bondedRelay.plain, /first-loss bond/i, "a bonded relay covenant still pays from the bond");
assert.doesNotMatch(
  bondedRelay.plain,
  /released without a payout/i,
  "a relay covenant must not promise release for a platform-ended job",
);
assert.doesNotMatch(
  bondedRelay.plain,
  /even if the platform later stops, closes, refunds, or expires/i,
  "a relay covenant's outcome does not turn on platform-terminal events at all",
);
assert.match(bondedRelay.plain, /relay clock/i, "a relay covenant must say which clock governs it");
assert.notEqual(
  bondedRelay.plain,
  bonded.plain,
  "relay and verified-acceptance bonded covenants must not share one promise",
);

// The recorded basis is surfaced in the fact table for the reader to check.
assert.ok(
  bonded.values.some(([label, value]) => label === "Payout basis" && value === "provider_bonded_sla_credit"),
  "the covenant's payout basis must be shown",
);

// A relay clock release is timestamp-verified (completedWithinSla), so it may
// state on-time delivery just as the A2A time-verified reason does.
const relayReleased = buildReceiptView({
  ok: true,
  receiptId: "ppc-relay-released",
  state: "released",
  release: { reason: "provider_response_delivered_within_sla" },
  universalReconciliation: { to: "released", reason: "provider_response_delivered_within_sla" },
  receipt: { version: "0.4.0", covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
});
assert.match(relayReleased.headline, /delivered on time/i, "a relay in-SLA release is an on-time delivery");
assert.match(relayReleased.plain, /delivered within the agreed deadline/i);

// A universal release evidence object (from the API's unified shape) is read
// even though it did not arrive under record.release.
const universalReleaseView = buildReceiptView({
  ok: true,
  receiptId: "ppc-universal-view",
  state: "released",
  universalReconciliation: { to: "released", reason: "service_delivered_within_sla" },
  receipt: { version: "0.4.0", covenant: { coverageCapUSDT: "0.5" }, target: { agentName: "GlassDesk", agentId: "3465" }, servicePayment: {} },
});
assert.match(universalReleaseView.headline, /delivered on time/i,
  "a universally released covenant must read its reason from the universal event");

// A started relay covenant with no receipt deadline still shows a deadline when
// the reconciled value is forwarded on the payload.
const relayDeadlineView = buildReceiptView({
  ok: true,
  receiptId: "ppc-relay-deadline",
  state: "active",
  reconciliation: { deadline: "2026-07-26T00:00:00.000Z" },
  receipt: { version: "0.4.0", covenant: { deadline: null, coverageCapUSDT: "0.5" }, target: { agentName: "Foreman", agentId: "4348", payoutBasis: "provider_bonded_sla_credit", providerBond: {} }, servicePayment: {}, providerBond: {} },
});
assert.ok(
  relayDeadlineView.values.some(([label]) => label === "Objective deadline"),
  "a reconciled deadline must appear even when the issued receipt lacks one",
);

// Overlapping lookups must not cross-render. A slow first request that resolves
// after a second one was started would otherwise paint the wrong receipt's
// lifecycle beside the newer id still shown in the input.
const sequencer = createLookupSequencer();
const first = sequencer.begin();
assert.equal(first(), true, "a lone lookup is current");
const second = sequencer.begin();
assert.equal(second(), true, "the newest lookup is current");
assert.equal(first(), false, "a superseded lookup must not render");
const third = sequencer.begin();
assert.equal(third(), true);
assert.equal(second(), false, "only the latest lookup may render");
assert.equal(first(), false, "older lookups stay superseded");

// Independent sequencers do not interfere with one another.
const other = createLookupSequencer();
const otherFirst = other.begin();
assert.equal(otherFirst(), true);
assert.equal(third(), true, "a separate sequencer must not supersede this one");

// The page must actually use the guard rather than merely export it.
const wiring = await readFile(new URL("../web/receipt.js", import.meta.url), "utf8");
assert.match(wiring, /const sequencer = createLookupSequencer\(\)/, "the page must create a sequencer");
assert.match(wiring, /const isCurrent = sequencer\.begin\(\)/, "each lookup must take a generation");
assert.equal(
  (wiring.match(/if \(!isCurrent\(\)/g) || []).length,
  2,
  "both the success and failure paths must drop superseded responses",
);
// The invariant is stated against the input, so the render path checks the
// input itself. A reader editing the field mid-request must not be shown the
// answer to the id they replaced.
assert.match(
  wiring,
  /if \(!isCurrent\(\) \|\| input\.value\.trim\(\) !== receiptId\) return;/,
  "the render path must verify the response still matches the id in the input",
);
// Editing the field mutates the invariant's subject, so it must reset too.
assert.match(
  wiring,
  /input\.addEventListener\("input", \(\) => \{\s*beginLookup\(\);/,
  "editing the input must retire the panel and invalidate the in-flight lookup",
);
// A record with no chain evidence must not be described as chain-verified.
assert.match(
  wiring,
  /view\.evidence\.length[\s\S]{0,160}No chain evidence is attached/,
  "the verification claim must depend on evidence actually being present",
);

// Superseding a callback is not enough: the previously rendered receipt must be
// retired synchronously, or it stays on screen for the seconds the new lookup
// takes while the input already shows a different id.
assert.match(wiring, /function clearRenderedReceipt\(\)/, "the page must be able to retire a rendered receipt");
const runBody = wiring.match(/const run = async \(receiptId\) => \{[\s\S]*?\n  \};/)?.[0] || "";
assert.ok(runBody, "the lookup routine must be present");
const resetIndex = runBody.indexOf("beginLookup()");
const awaitIndex = runBody.indexOf("await lookup(");
assert.ok(resetIndex > -1, "each lookup must reset through the shared choke point");
assert.ok(awaitIndex > -1, "each lookup must await the receipt request");
assert.ok(
  resetIndex < awaitIndex,
  "the reset must happen before awaiting, not after the response returns",
);
assert.match(wiring, /clearRenderedReceipt[\s\S]{0,400}result\.hidden = true/, "retiring must hide the panel");

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
