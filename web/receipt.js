// Public receipt verifier.
//
// The view model is built by a pure function so the same logic that renders the
// page is verified in CI against real receipts, without a browser.

const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const EXPLORER_ADDRESS = "https://www.oklink.com/x-layer/address/";

// PolicyPool operates its own coverable test targets. Where a covered provider
// shares this wallet, the receipt is a controlled test and says so.
const POLICYPOOL_OWNER_WALLET = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";

const STATE_PRESENTATION = Object.freeze({
  active: { label: "COVERAGE ACTIVE", headline: "Coverage is in force." },
  pending_start: { label: "AWAITING CLOCK START", headline: "Paid and issued. Deadline not started." },
  pending: { label: "PAYMENT NOT SETTLED", headline: "Reserved, not yet paid." },
  // Neutral by default. Released is reached by on-time delivery, by expiry of
  // an unstarted clock, and by recovery without payout, so the headline is
  // only specialised once the recorded reason proves which occurred.
  released: { label: "RELEASED", headline: "Ended without a payout." },
  payout_due: { label: "PAYOUT DUE", headline: "Deadline missed. Payout owed." },
  // Not a payout. This is the cleanup state for aborted, unconfirmed, or
  // unsettled issuance, so coverage may never have existed.
  compensation_required: { label: "RECONCILIATION PENDING", headline: "Awaiting reconciliation." },
  paid: { label: "PAID OUT", headline: "The buyer was paid on X Layer." },
  expired: { label: "EXPIRED", headline: "Coverage ended without a claim." },
  cancelled: { label: "CANCELLED", headline: "Coverage was cancelled before it started." },
  // Persisted by the v0.4 universal reconciler and forwarded by
  // /api/coverage-status, so they need presentations here too. Without them the
  // page shows a raw internal label and calls a resolved covenant "no longer in
  // force" rather than explaining what actually happened.
  recovered_without_payout: { label: "RELEASED", headline: "Ended without a payout." },
  cancelled_unpaid: { label: "CANCELLED", headline: "Cancelled before the fee settled." },
});

function usdt(atomic, decimals = 6) {
  if (atomic === undefined || atomic === null || atomic === "") return null;
  try {
    const raw = BigInt(atomic);
    const unit = 10n ** BigInt(decimals);
    const whole = raw / unit;
    const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  } catch {
    return null;
  }
}

function instant(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function shortHash(value) {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

// A service outage must not be reported as a missing receipt. The API answers
// with JSON on failure, so `fetch` resolves and the payload alone cannot tell
// "no such receipt" apart from "the lookup could not run right now".
const UNAVAILABLE_ERRORS = new Set([
  "coverage_status_unavailable",
  "ledger_unavailable",
  "rpc_error",
  "chain_unavailable",
]);

function isUnavailable(payload, httpStatus) {
  if (Number.isInteger(httpStatus) && httpStatus >= 500) return true;
  if (Number.isInteger(httpStatus) && httpStatus === 429) return true;
  return UNAVAILABLE_ERRORS.has(String(payload?.error || ""));
}

// Coverage caps must not be quoted for records where coverage may never have
// existed or has not been funded. A "maximum payout" row there reads as an
// amount someone could claim.
const NON_PAYABLE_STATES = new Set([
  "compensation_required",
  "pending",
  "cancelled",
  "cancelled_unpaid",
  // Resolved through recovery with nothing paid to the buyer, so quoting a
  // maximum payout would imply a claim that can no longer occur.
  "recovered_without_payout",
]);

export function buildReceiptView(payload, options = {}) {
  const httpStatus = options.httpStatus;
  // A cleanup record is copied from the pre-finalisation reservation, so it
  // carries a ledger state but no receipt document. Requiring a receipt here
  // would report a record that genuinely exists as missing.
  const ledgerState = String(payload?.state || "").trim().toLowerCase();
  if (!payload || payload.ok !== true || (!payload.receipt && !ledgerState)) {
    if (isUnavailable(payload, httpStatus)) {
      return {
        found: false,
        unavailable: true,
        stateLabel: "TEMPORARILY UNAVAILABLE",
        headline: "The lookup could not run just now.",
        plain: "This does not mean the receipt is missing. The public receipt service or its chain lookup is briefly unavailable. Try the same ID again in a few seconds.",
        values: [],
        evidence: [],
        disclosure: null,
      };
    }
    return {
      found: false,
      unavailable: false,
      stateLabel: "NOT FOUND",
      headline: "No receipt with that ID.",
      plain: "Check the ID and try again. Receipt IDs look like ppc- followed by sixteen hex characters.",
      values: [],
      evidence: [],
      disclosure: null,
    };
  }

  const receipt = payload.receipt || {};
  const state = ledgerState;
  const presentation = STATE_PRESENTATION[state] || { label: state.toUpperCase(), headline: "Receipt found." };
  const target = receipt.target || {};
  const targetJob = receipt.targetJob || {};
  const covenant = receipt.covenant || {};
  const servicePayment = receipt.servicePayment || {};
  const payout = payload.payout || null;
  // v0.4 transitions record their outcome in universalReconciliation and never
  // populate release. The API unifies the two, and the view keeps the same
  // fallback so an older cached API response cannot lose the recorded reason.
  const universal = payload.universalReconciliation || null;
  const release = payload.release
    || (state === "released" && universal?.to === "released" ? universal : null);

  const capUSDT = covenant.coverageCapUSDT || usdt(covenant.coverageCapAtomic);
  const feeUSDT = servicePayment.amountUSDT || usdt(servicePayment.amountAtomic);
  // A zero-recovery settlement stores a payout object with amountAtomic "0" and
  // its settlement transaction. That is not money paid to the buyer, so payout
  // rows and links are gated on a positive amount rather than object presence.
  const payoutAtomic = payout ? Number(payout.amountAtomic) : 0;
  const payoutIsPositive = Number.isFinite(payoutAtomic) && payoutAtomic > 0;
  const payoutUSDT = payoutIsPositive ? usdt(payout.amountAtomic) : null;
  // A started relay covenant's authoritative deadline is computed by the
  // reconciler and travels beside the hash-committed receipt, never inside it,
  // so the issued document alone under-reports it.
  const effectiveDeadline = covenant.deadline
    || payload.reconciliation?.deadline
    || universal?.deadline
    || null;
  const deadline = instant(effectiveDeadline);
  const providerName = target.agentName || `agent ${target.agentId || "unknown"}`;

  let plain;
  // Defaults to the state's neutral headline; only a reason that proves timing
  // may upgrade it to a delivery claim.
  let headline = presentation.headline;
  if (state === "paid" && payoutUSDT) {
    // v0.4 covenants settle from the provider's own first-loss bond, not the
    // shared reserve, so the funding source is read from the receipt rather
    // than assumed.
    const providerFunded = Boolean(receipt.providerBond)
      && receipt.providerBond.sharedReserveUsed !== true;
    const source = providerFunded
      ? "from the provider's own first-loss bond"
      : "from the PolicyPool reserve";
    plain = `The covered job missed its objective deadline, so the buyer was paid ${payoutUSDT} USD₮0 ${source}. The payout transaction below is the proof.`;
  } else if (state === "released") {
    // Released is also reached by expiry of an unstarted relay clock and by
    // recovery without payout, where nothing was delivered. Only the recorded
    // reason can say which happened, so it is never assumed.
    //
    // `platform_job_completed` is deliberately excluded: the reconciler records
    // it from job status alone, with no completion timestamp and no comparison
    // against the deadline, so a job that finished late still earns it. Only a
    // reason that verified timing may claim delivery was within the SLA.
    // Both reasons are timestamp-verified: the A2A clock compares the recorded
    // delivery time against the deadline, and the relay clock releases only on
    // completedWithinSla. Status-only reasons stay excluded.
    const timeVerifiedDelivery = new Set([
      "service_delivered_within_sla",
      "provider_response_delivered_within_sla",
    ]);
    if (timeVerifiedDelivery.has(release?.reason)) {
      headline = "Delivered on time. Liability released.";
      plain = `${providerName} delivered within the agreed deadline, so no payout was owed and the reserved liability was released. This is the normal outcome for coverage that is never claimed.`;
    } else if (release?.reason) {
      plain = `This covenant ended without a payout and its reserved liability was released. Recorded reason: ${release.reason}. That is not a statement that the service was delivered on time.`;
    } else {
      plain = "This covenant ended without a payout and its reserved liability was released.";
    }
  } else if (state === "payout_due") {
    plain = `The deadline passed without a verified delivery. A payout of up to ${capUSDT || "the cap"} USD₮0 is owed to the buyer and is pending execution.`;
  } else if (state === "compensation_required") {
    // Must not claim a payout: issuance or fee settlement may be unconfirmed,
    // so this record may represent coverage that was never issued at all.
    plain = "This record is awaiting reconciliation. Coverage issuance or its fee settlement is unconfirmed, so no payout is owed on the strength of this receipt. The reconciler will resolve it to a released, cancelled, or payable outcome.";
  } else if (state === "active") {
    // What the deadline pays depends on the covenant's recorded payout basis,
    // and the pipelines genuinely differ: the reserve reconciler releases any
    // platform-terminal job observed while active, while a provider-bonded SLA
    // credit treats a deadline breach as payable even if the platform later
    // stops, closes, refunds, or expires the job. The wording is selected from
    // the receipt's own recorded basis rather than asserted for all of them.
    const basis = target.payoutBasis
      || (receipt.providerBond ? null : "legacy_reserve_covenant");
    const until = deadline || "the stored deadline";
    const cap = capUSDT || "the cap";
    if (basis === "provider_bonded_sla_credit") {
      plain = `Coverage is in force until ${until}. If ${providerName} has not delivered by then, the buyer is owed up to ${cap} USD₮0 from the provider's first-loss bond, even if the platform later stops, closes, refunds, or expires the job. A job the platform ends before the deadline is released without a payout.`;
    } else if (basis === "net_loss") {
      plain = `Coverage is in force until ${until}. If ${providerName} has not delivered by then, up to ${cap} USD₮0 becomes payable only after marketplace recovery is terminal, reduced by any verified recovered amounts.`;
    } else if (basis === "legacy_reserve_covenant") {
      plain = `Coverage is in force until ${until}. If the job is still accepted and ${providerName} has not delivered by then, the buyer is owed up to ${cap} USD₮0. A job the platform stops, closes, or expires while coverage is active is released without a payout.`;
    } else {
      plain = `Coverage is in force until ${until}. The outcome at the deadline follows the covenant's recorded payout basis shown below; nothing beyond it is promised here.`;
    }
  } else if (state === "pending_start") {
    // Paid and issued, but the relay clock has not started. Not terminal.
    plain = `The coverage fee has settled and this receipt is issued. Its deadline starts when the funded request reaches ${providerName}, so cover is not counting down yet.`;
  } else if (state === "pending") {
    plain = "This coverage was reserved but its fee has not settled yet, so no cover is in force and no receipt has been finalised.";
  } else if (state === "recovered_without_payout") {
    plain = "This covenant was resolved through recovery without any payout to the buyer, and its reserved liability was released. That is not a statement that the service was delivered on time.";
  } else if (state === "cancelled_unpaid") {
    plain = "This coverage was cancelled before its fee settled, so no cover ever took effect and nothing is owed. Any authorised fee is refundable to the buyer.";
  } else {
    plain = "This receipt is no longer in force.";
  }

  const values = [
    ["Receipt", payload.receiptId],
    ["Coverage state", presentation.label],
    // Suppressed where coverage may never have existed or is unfunded, so the
    // table cannot quote a payable-looking amount the explanation denies.
    ["Maximum payout", capUSDT && !NON_PAYABLE_STATES.has(state) ? `${capUSDT} USD₮0` : null],
    // Report the fee actually recorded on this receipt. Older receipts carry a
    // different price than the current listing, and an assumed default here
    // would print a number that was never paid.
    ["Service fee paid", feeUSDT ? `${feeUSDT} USD₮0` : null],
    ["Objective deadline", deadline],
    ["Covered provider", target.agentName ? `${target.agentName} #${target.agentId}` : null],
    ["Covered service", target.serviceName ? `${target.serviceName} (${target.serviceType || "?"})` : null],
    ["Breach rule", (covenant.objectiveBreachRules || [])[0] || null],
    ["Payout basis", target.payoutBasis || null],
    ["Target job value", usdt(targetJob.amountAtomic) ? `${usdt(targetJob.amountAtomic)} USD₮0` : null],
    ["Job accepted at", instant(targetJob.acceptedAt)],
    ["Receipt hash", receipt.receiptHash ? shortHash(receipt.receiptHash) : null],
    ["Policy hash", target.policyHash ? shortHash(target.policyHash) : null],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");

  if (release && release.reason) {
    values.push(["Released because", `${release.reason} (${instant(release.observedAt) || "observed"})`]);
  }
  if (payout && payoutUSDT) {
    values.push(["Paid to buyer", `${payoutUSDT} USD₮0 on ${instant(payout.verifiedAt) || "X Layer"}`]);
  }

  const evidence = [];
  const addTx = (label, hash) => {
    if (hash) evidence.push({ label, href: `${EXPLORER_TX}${hash}`, text: shortHash(hash) });
  };
  addTx("Target job created", targetJob.creationTxHash);
  addTx("Target job accepted", targetJob.acceptanceTxHash);
  addTx("Coverage paid for", servicePayment.transaction);
  if (payout) addTx(payoutIsPositive ? "Payout to buyer" : "Recovery settlement, no payout", payout.transaction);
  if (receipt.reserve && receipt.reserve.wallet) {
    evidence.push({
      label: "Reserve wallet",
      href: `${EXPLORER_ADDRESS}${receipt.reserve.wallet}`,
      text: shortHash(receipt.reserve.wallet),
    });
  }

  const providerWallet = String(target.providerWallet || "").toLowerCase();
  const buyerWallet = String((receipt.buyer || {}).address || "").toLowerCase();
  let disclosure = null;
  if (providerWallet && providerWallet === POLICYPOOL_OWNER_WALLET) {
    disclosure = buyerWallet === POLICYPOOL_OWNER_WALLET
      ? "Controlled test: the covered provider and the buyer both use PolicyPool's own wallet. This receipt proves the mechanism, not independent demand."
      : "Controlled provider: the covered provider shares PolicyPool's owner wallet. The buyer is independent, the provider is not.";
  }

  return {
    found: true,
    state,
    stateLabel: presentation.label,
    headline,
    plain,
    values,
    evidence,
    disclosure,
  };
}

// Lookups are chain-backed and can take seconds, so a second search may start
// before the first returns. Each attempt takes a generation and renders only if
// it is still the latest; otherwise a slower earlier response lands last and the
// panel shows one receipt's lifecycle beside another's id in the input.
export function createLookupSequencer() {
  let generation = 0;
  return {
    begin() {
      const mine = ++generation;
      return () => mine === generation;
    },
  };
}

async function lookup(receiptId) {
  const response = await fetch(`/api/coverage-status?receiptId=${encodeURIComponent(receiptId)}`, {
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  return { body, httpStatus: response.status };
}

// Retiring the panel is separate from superseding a callback. Without this, an
// already-rendered receipt stays on screen for the seconds a new chain-backed
// lookup takes, so the input shows one id while the page presents another's
// lifecycle and evidence.
function clearRenderedReceipt() {
  const result = document.getElementById("receipt-result");
  if (!result) return;
  result.hidden = true;
  document.getElementById("receipt-state-label").textContent = "";
  document.getElementById("receipt-headline").textContent = "";
  document.getElementById("receipt-plain").textContent = "";
  document.getElementById("receipt-values").replaceChildren();
  document.getElementById("receipt-evidence").replaceChildren();
  const disclosure = document.getElementById("receipt-disclosure");
  disclosure.textContent = "";
  disclosure.hidden = true;
}

function render(view) {
  const result = document.getElementById("receipt-result");
  document.getElementById("receipt-state-label").textContent = view.stateLabel;
  document.getElementById("receipt-headline").textContent = view.headline;
  document.getElementById("receipt-plain").textContent = view.plain;

  const values = document.getElementById("receipt-values");
  values.replaceChildren();
  for (const [label, value] of view.values) {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrapper.append(dt, dd);
    values.append(wrapper);
  }

  const evidence = document.getElementById("receipt-evidence");
  evidence.replaceChildren();
  if (view.evidence.length) {
    const heading = document.createElement("span");
    heading.className = "section-index";
    heading.textContent = "PUBLIC EVIDENCE";
    evidence.append(heading);
    const list = document.createElement("ul");
    for (const item of view.evidence) {
      const li = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.href = item.href;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = `${item.label}: ${item.text} ↗`;
      li.append(anchor);
      list.append(li);
    }
    evidence.append(list);
  }

  const disclosure = document.getElementById("receipt-disclosure");
  disclosure.textContent = view.disclosure || "";
  disclosure.hidden = !view.disclosure;

  result.hidden = false;
  result.focus();
}

if (typeof document !== "undefined") {
  const form = document.getElementById("receipt-form");
  const input = document.getElementById("receipt-id");
  const status = document.getElementById("receipt-status");

  const sequencer = createLookupSequencer();

  // One invariant governs this panel: it may only ever show a receipt that a
  // still-current lookup returned for the id presently in the input. Enforcing
  // that branch by branch produced a run of near-identical defects, each a path
  // that met one half of it. Every entry point now resets both the generation
  // and the panel here, before any branching, so no future path can satisfy one
  // obligation and quietly miss the other.
  const beginLookup = () => {
    const isCurrent = sequencer.begin();
    clearRenderedReceipt();
    return isCurrent;
  };

  const run = async (receiptId) => {
    const isCurrent = beginLookup();
    // A whitespace-only submission passes the HTML required check and trims to
    // empty here; it is answered after the reset above, never before it.
    if (!receiptId) {
      status.textContent = "Enter a receipt ID to check.";
      return;
    }
    status.textContent = "Reading the public receipt…";
    try {
      const { body, httpStatus } = await lookup(receiptId);
      // The invariant is stated against the id presently in the input, so it is
      // checked against the input itself, not only against the generation. A
      // reader who edits the field mid-request must never be shown the answer
      // to the id they replaced.
      if (!isCurrent() || input.value.trim() !== receiptId) return;
      const view = buildReceiptView(body, { httpStatus });
      render(view);
      // Only claim verification when a receipt was actually read.
      if (view.found) {
        // Records with no target job never reach a chain lookup, so claiming an
        // X Layer check for them would assert evidence that was never gathered.
        status.textContent = view.evidence.length
          ? "Verified against the public API and X Layer."
          : "Read from the public API. No chain evidence is attached to this record.";
      } else if (view.unavailable) {
        status.textContent = "The receipt service is briefly unavailable. Try the same ID again.";
      } else {
        status.textContent = "No receipt matched that ID.";
      }
    } catch {
      if (!isCurrent()) return;
      status.textContent = "Could not reach the receipt API. Try again.";
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(input.value.trim());
  });

  // Editing the field changes "the id presently in the input", so it is a
  // mutation of the invariant's subject and must reset through the same point.
  input.addEventListener("input", () => {
    beginLookup();
    status.textContent = "Enter a receipt ID to check.";
  });

  for (const example of document.querySelectorAll("[data-example]")) {
    example.addEventListener("click", (event) => {
      event.preventDefault();
      input.value = example.dataset.example;
      run(input.value);
    });
  }

  const requested = new URLSearchParams(window.location.search).get("id");
  if (requested) {
    input.value = requested;
    run(requested);
  }
}
