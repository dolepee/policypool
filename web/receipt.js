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
  released: { label: "RELEASED", headline: "Delivered on time. Liability released." },
  payout_due: { label: "PAYOUT DUE", headline: "Deadline missed. Payout owed." },
  compensation_required: { label: "PAYOUT DUE", headline: "Deadline missed. Payout owed." },
  paid: { label: "PAID OUT", headline: "The buyer was paid on X Layer." },
  expired: { label: "EXPIRED", headline: "Coverage ended without a claim." },
  cancelled: { label: "CANCELLED", headline: "Coverage was cancelled before it started." },
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

export function buildReceiptView(payload, options = {}) {
  const httpStatus = options.httpStatus;
  if (!payload || payload.ok !== true || !payload.receipt) {
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

  const receipt = payload.receipt;
  const state = String(payload.state || "").toLowerCase();
  const presentation = STATE_PRESENTATION[state] || { label: state.toUpperCase(), headline: "Receipt found." };
  const target = receipt.target || {};
  const targetJob = receipt.targetJob || {};
  const covenant = receipt.covenant || {};
  const servicePayment = receipt.servicePayment || {};
  const payout = payload.payout || null;
  const release = payload.release || null;

  const capUSDT = covenant.coverageCapUSDT || usdt(covenant.coverageCapAtomic);
  const feeUSDT = servicePayment.amountUSDT || usdt(servicePayment.amountAtomic);
  const payoutUSDT = payout ? usdt(payout.amountAtomic) : null;
  const deadline = instant(covenant.deadline);
  const providerName = target.agentName || `agent ${target.agentId || "unknown"}`;

  let plain;
  if (state === "paid" && payoutUSDT) {
    plain = `The covered job missed its objective deadline, so PolicyPool paid the buyer ${payoutUSDT} USD₮0 from the reserve. The payout transaction below is the proof.`;
  } else if (state === "released") {
    plain = `${providerName} delivered within the agreed deadline, so no payout was owed and the reserved liability was released. This is the normal outcome for coverage that is never claimed.`;
  } else if (state === "payout_due" || state === "compensation_required") {
    plain = `The deadline passed without a verified delivery. A payout of up to ${capUSDT || "the cap"} USD₮0 is owed to the buyer and is pending execution.`;
  } else if (state === "active") {
    plain = `Coverage is in force until ${deadline || "the stored deadline"}. If ${providerName} has not delivered by then, the buyer is owed up to ${capUSDT || "the cap"} USD₮0.`;
  } else if (state === "pending_start") {
    // Paid and issued, but the relay clock has not started. Not terminal.
    plain = `The coverage fee has settled and this receipt is issued. Its deadline starts when the funded request reaches ${providerName}, so cover is not counting down yet.`;
  } else if (state === "pending") {
    plain = "This coverage was reserved but its fee has not settled yet, so no cover is in force and no receipt has been finalised.";
  } else {
    plain = "This receipt is no longer in force.";
  }

  const values = [
    ["Receipt", payload.receiptId],
    ["Coverage state", presentation.label],
    ["Maximum payout", capUSDT ? `${capUSDT} USD₮0` : null],
    // Report the fee actually recorded on this receipt. Older receipts carry a
    // different price than the current listing, and an assumed default here
    // would print a number that was never paid.
    ["Service fee paid", feeUSDT ? `${feeUSDT} USD₮0` : null],
    ["Objective deadline", deadline],
    ["Covered provider", target.agentName ? `${target.agentName} #${target.agentId}` : null],
    ["Covered service", target.serviceName ? `${target.serviceName} (${target.serviceType || "?"})` : null],
    ["Breach rule", (covenant.objectiveBreachRules || [])[0] || null],
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
  if (payout) addTx("Payout to buyer", payout.transaction);
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
    headline: presentation.headline,
    plain,
    values,
    evidence,
    disclosure,
  };
}

async function lookup(receiptId) {
  const response = await fetch(`/api/coverage-status?receiptId=${encodeURIComponent(receiptId)}`, {
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  return { body, httpStatus: response.status };
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

  const run = async (receiptId) => {
    if (!receiptId) return;
    status.textContent = "Reading the public receipt…";
    try {
      const { body, httpStatus } = await lookup(receiptId);
      const view = buildReceiptView(body, { httpStatus });
      render(view);
      // Only claim verification when a receipt was actually read.
      if (view.found) {
        status.textContent = "Verified against the public API and X Layer.";
      } else if (view.unavailable) {
        status.textContent = "The receipt service is briefly unavailable. Try the same ID again.";
      } else {
        status.textContent = "No receipt matched that ID.";
      }
    } catch {
      status.textContent = "Could not reach the receipt API. Try again.";
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(input.value.trim());
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
