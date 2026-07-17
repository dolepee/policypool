const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const EXPLORER_ADDRESS = "https://www.oklink.com/x-layer/address/";
const providerNames = new Map([
  ["3465", "GlassDesk"],
  ["4348", "Foreman"],
  ["3808", "Warden"],
]);
const externalProofCatalog = Object.freeze([
  { receiptId: "ppc-6c3d1dbe749cca96", buyer: "0xfc9b58e81BcE27c2f46558D501228D935f93e802" },
  { receiptId: "ppc-136a34aee2022a42", buyer: "0xfc9b58e81BcE27c2f46558D501228D935f93e802" },
  { receiptId: "ppc-5e59d4e5300b6fc3", buyer: "0xf4C9FA07f3BB852547fdC4DF7c1d9Fd9991cfA51" },
]);
const statusCache = new Map();

function amount(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(number);
}

function short(value, left = 8, right = 6) {
  const text = String(value || "");
  if (text.length <= left + right + 1) return text || "—";
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function dateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((node) => { node.textContent = value; });
}

function setLink(node, href, text, external = false) {
  if (!node) return;
  node.href = href;
  if (text) node.textContent = text;
  if (external) {
    node.target = "_blank";
    node.rel = "noreferrer";
  } else {
    node.removeAttribute("target");
    node.removeAttribute("rel");
  }
}

function setLiveBusy(busy) {
  document.querySelectorAll(".system-strip-track").forEach((node) => {
    node.setAttribute("aria-busy", String(busy));
  });
}

function disableLink(node, text) {
  if (!node) return;
  node.removeAttribute("href");
  node.removeAttribute("target");
  node.removeAttribute("rel");
  if (text) node.textContent = text;
}

function bindMobileNavigation() {
  const menu = document.querySelector(".mobile-nav");
  if (!menu) return;
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => { menu.open = false; }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") menu.open = false; });
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
}

function bindCopyLinks() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-link]");
    if (!button) return;
    const original = button.textContent;
    const url = new URL(button.dataset.copyLink, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    window.setTimeout(() => { button.textContent = original; }, 1800);
  });
}

function updateReserveSurface(data) {
  const scale = 10 ** Number(data.asset.decimals || 6);
  const balanceAtomic = Number(data.reserve.balanceAtomic || 0);
  const availableAtomic = Number(data.reserve.availableAtomic || 0);
  const committedAtomic = Number(data.reserve.committedAtomic || 0);
  const freePercent = balanceAtomic > 0 ? Math.max(0, Math.min(100, (availableAtomic / balanceAtomic) * 100)) : 0;
  setText("[data-reserve-available]", amount(availableAtomic / scale));
  setText("[data-reserve-balance]", amount(balanceAtomic / scale));
  setText("[data-reserve-committed]", amount(committedAtomic / scale));
  setText("[data-record-count]", String(data.liabilities.recordCount));
  setText("[data-ledger-updated]", `Live read ${dateTime(data.generatedAt)}. No cached fallback.`);
  document.querySelectorAll("[data-solvency]").forEach((node) => {
    node.textContent = data.reserve.solvent ? "Solvent" : "Overcommitted";
    node.classList.toggle("is-positive", data.reserve.solvent);
    node.classList.toggle("is-risk", !data.reserve.solvent);
    const stripState = node.closest(".system-strip-state");
    stripState?.classList.toggle("is-positive", data.reserve.solvent);
    stripState?.classList.toggle("is-risk", !data.reserve.solvent);
  });
  document.querySelectorAll("[data-reserve-waterline]").forEach((node) => {
    if (node.parentElement?.classList.contains("balance-water")) node.style.height = `${freePercent}%`;
    else node.style.width = `${freePercent}%`;
  });
  document.querySelectorAll("[data-reserve-link]").forEach((node) => {
    setLink(node, `${EXPLORER_ADDRESS}${data.reserve.wallet}`, short(data.reserve.wallet), true);
  });
  setLiveBusy(false);
}

function setLedgerUnavailable(message) {
  setText("[data-reserve-available]", "—");
  setText("[data-reserve-balance]", "—");
  setText("[data-reserve-committed]", "—");
  setText("[data-record-count]", "—");
  setText("[data-latest-outcome]", "Unavailable");
  setText("[data-outcome-provider]", "—");
  setText("[data-outcome-cap]", "—");
  setText("[data-outcome-finalized]", "—");
  disableLink(document.querySelector("[data-latest-outcome]"), "Unavailable");
  document.querySelectorAll("[data-outcome-link]").forEach((node) => disableLink(node, "Live receipt unavailable"));
  setText("[data-ledger-updated]", `Live ledger unavailable. ${message}`);
  document.querySelectorAll("[data-solvency]").forEach((node) => {
    node.textContent = "Unavailable";
    node.classList.remove("is-positive");
    node.classList.add("is-risk");
    const stripState = node.closest(".system-strip-state");
    stripState?.classList.remove("is-positive");
    stripState?.classList.add("is-risk");
  });
  setLiveBusy(false);
}

function initScrollReveals() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window) || !("animate" in Element.prototype)) return;
  const items = [...document.querySelectorAll([
    ".outcome-ticket",
    ".mechanism-grid li",
    ".role-grid a",
    ".coverage-form-card",
    ".decision-card",
    ".notes-grid article",
    ".balance-sheet",
    ".ledger-table-shell",
    ".proof-selector-column",
    ".proof-receipt",
    ".evidence-grid a",
    ".provider-card",
    ".admission-layout li",
    ".command-card",
  ].join(", "))];
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const delay = Number(entry.target.dataset.enterDelay || 0);
      entry.target.animate(
        [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 520, delay, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  items.forEach((item, index) => {
    item.dataset.enterDelay = String((index % 4) * 55);
    observer.observe(item);
  });
}

function renderHomeOutcomes(records) {
  const finalized = [...records]
    .filter((record) => record.finalizedAt)
    .sort((left, right) => new Date(right.finalizedAt).getTime() - new Date(left.finalizedAt).getTime());
  const latest = finalized[0];
  const latestLink = document.querySelector("[data-latest-outcome]");
  if (latest && latestLink) {
    const label = latest.state.charAt(0).toUpperCase() + latest.state.slice(1);
    setLink(latestLink, `/proof?state=${latest.state}`, `${label} · ${amount(latest.liabilityUSDT)} USD₮0`);
  } else if (latestLink) {
    latestLink.textContent = "No closed receipt";
    latestLink.removeAttribute("href");
  }

  for (const state of ["released", "paid"]) {
    const record = finalized.find((item) => item.state === state && (state !== "paid" || item.payoutTx));
    const link = document.querySelector(`[data-outcome-link="${state}"]`);
    if (!record) {
      if (link) {
        link.textContent = "No live receipt available";
        link.removeAttribute("href");
      }
      setText(`[data-outcome-provider="${state}"]`, "—");
      setText(`[data-outcome-cap="${state}"]`, "—");
      setText(`[data-outcome-finalized="${state}"]`, "—");
      continue;
    }
    if (link) {
      link.href = `/proof?state=${state}`;
      link.textContent = `${record.receiptId} →`;
    }
    setText(`[data-outcome-provider="${state}"]`, `${providerNames.get(String(record.targetAgentId)) || "Agent"} #${record.targetAgentId}`);
    setText(`[data-outcome-cap="${state}"]`, `${amount(record.liabilityUSDT)} USD₮0`);
    setText(`[data-outcome-finalized="${state}"]`, dateTime(record.finalizedAt));
  }
}

function stateClass(state) {
  if (state === "paid") return "state-paid";
  if (state === "released") return "state-released";
  return "state-active";
}

function recordProof(record) {
  if (record.payoutTx) return { href: `${EXPLORER_TX}${record.payoutTx}`, label: "Payout tx", external: true };
  return { href: `/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}`, label: "Receipt", external: false };
}

function renderLedgerRecords(records) {
  const table = document.querySelector("#coverage-rows");
  const cards = document.querySelector("#coverage-cards");
  if (!table && !cards) return;
  if (!records.length) {
    if (table) table.innerHTML = '<tr><td colspan="6">The live ledger is healthy and has no covenant records.</td></tr>';
    if (cards) cards.textContent = "The live ledger is healthy and has no covenant records.";
    return;
  }

  if (table) {
    table.replaceChildren(...records.map((record) => {
      const row = document.createElement("tr");
      const proof = recordProof(record);
      const cells = [
        { value: short(record.receiptId, 11, 5), href: `/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}` },
        { value: `${providerNames.get(String(record.targetAgentId)) || "Agent"} #${record.targetAgentId}` },
        { value: short(record.targetJobId, 10, 6), code: true },
        { value: record.state.replaceAll("_", " "), state: true },
        { value: `${amount(record.liabilityUSDT)} USD₮0` },
        { value: proof.label, href: proof.href, external: proof.external },
      ];
      for (const cell of cells) {
        const td = document.createElement("td");
        if (cell.state) {
          const stamp = document.createElement("span");
          stamp.className = `state-stamp ${stateClass(record.state)}`;
          stamp.textContent = cell.value;
          td.append(stamp);
        } else if (cell.href) {
          const link = document.createElement("a");
          setLink(link, cell.href, cell.value, cell.external);
          td.append(link);
        } else if (cell.code) {
          const code = document.createElement("code");
          code.textContent = cell.value;
          td.append(code);
        } else td.textContent = cell.value;
        row.append(td);
      }
      return row;
    }));
  }

  if (cards) {
    cards.replaceChildren(...records.map((record) => {
      const card = document.createElement("article");
      card.className = "ledger-card";
      const header = document.createElement("header");
      const code = document.createElement("code");
      code.textContent = record.receiptId;
      const stamp = document.createElement("span");
      stamp.className = `state-stamp ${stateClass(record.state)}`;
      stamp.textContent = record.state.replaceAll("_", " ");
      header.append(code, stamp);
      const details = document.createElement("dl");
      const values = [
        ["Provider", `${providerNames.get(String(record.targetAgentId)) || "Agent"} #${record.targetAgentId}`],
        ["Target job", short(record.targetJobId, 10, 6)],
        ["Cap", `${amount(record.liabilityUSDT)} USD₮0`],
      ];
      for (const [label, value] of values) {
        const line = document.createElement("div");
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        line.append(term, detail);
        details.append(line);
      }
      const link = document.createElement("a");
      const proof = recordProof(record);
      setLink(link, proof.href, `${proof.label} ↗`, proof.external);
      link.className = "text-action";
      card.append(header, details, link);
      return card;
    }));
  }
}

async function fetchReceiptStatus(receiptId) {
  if (statusCache.has(receiptId)) return statusCache.get(receiptId);
  const response = await fetch(`/api/coverage-status?receiptId=${encodeURIComponent(receiptId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`receipt returned ${response.status}`);
  const status = await response.json();
  if (!status.ok || status.receiptId !== receiptId) throw new Error("receipt identity mismatch");
  statusCache.set(receiptId, status);
  return status;
}

async function fetchStatus(record) {
  const status = await fetchReceiptStatus(record.receiptId);
  if (status.state !== record.state) throw new Error("receipt state mismatch");
  const proof = { status, record };
  return proof;
}

function externalStateCopy(state) {
  if (state === "released") return "Target work completed; reserved capacity returned.";
  if (state === "paid") return "Covered breach paid from the public reserve.";
  if (state === "payout_due") return "Objective breach recorded; reserve action is due.";
  return "Coverage remains active while the marketplace job reaches a terminal state.";
}

function externalProofCard(entry, status, index) {
  const receipt = status.receipt;
  const expectedBuyer = entry.buyer.toLowerCase();
  const buyer = String(receipt?.buyer?.address || "").toLowerCase();
  const payer = String(receipt?.servicePayment?.payer || "").toLowerCase();
  const jobBuyer = String(receipt?.targetJob?.buyer || "").toLowerCase();
  if (!receipt?.servicePayment?.verified || !receipt?.servicePayment?.settled) throw new Error("service payment is not verified");
  if (buyer !== expectedBuyer || payer !== expectedBuyer || jobBuyer !== expectedBuyer) throw new Error("buyer binding mismatch");

  const card = document.createElement("article");
  card.className = "external-proof-card";
  const header = document.createElement("header");
  const label = document.createElement("span");
  label.textContent = `EXTERNAL BUYER-FUNDED / 0${index + 1}`;
  const stamp = document.createElement("b");
  stamp.className = `state-stamp ${stateClass(status.state)}`;
  stamp.textContent = status.state.replaceAll("_", " ");
  header.append(label, stamp);

  const heading = document.createElement("h3");
  heading.textContent = `${amount(receipt.servicePayment.amountUSDT)} USD₮0 fee covered a ${amount(receipt.covenant.coverageCapUSDT)} USD₮0 job.`;
  const summary = document.createElement("p");
  summary.textContent = externalStateCopy(status.state);

  const details = document.createElement("dl");
  const values = [
    ["Buyer", short(receipt.buyer.address, 10, 8)],
    ["Provider", `${receipt.target.agentName} #${receipt.target.agentId}`],
    ["Target job", short(receipt.targetJob.jobId, 10, 8)],
    ["Coverage receipt", receipt.receiptId],
  ];
  for (const [term, value] of values) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    details.append(row);
  }

  const actions = document.createElement("footer");
  actions.className = "external-proof-actions";
  const path = `/api/coverage-status?receiptId=${encodeURIComponent(receipt.receiptId)}`;
  const link = document.createElement("a");
  setLink(link, path, "Open receipt ↗");
  link.setAttribute("aria-label", `Open public receipt ${receipt.receiptId}`);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.dataset.copyLink = path;
  copy.textContent = "Copy proof link";
  copy.setAttribute("aria-label", `Copy proof link for ${receipt.receiptId}`);
  actions.append(link, copy);
  card.append(header, heading, summary, details, actions);
  return card;
}

async function hydrateExternalProofs() {
  const grid = document.querySelector("#external-proof-grid");
  const summary = document.querySelector("#external-proof-summary");
  if (!grid || !summary) return;
  const results = await Promise.all(externalProofCatalog.map(async (entry, index) => {
    try {
      const status = await fetchReceiptStatus(entry.receiptId);
      return { card: externalProofCard(entry, status, index), state: status.state };
    } catch (error) {
      const card = document.createElement("article");
      card.className = "external-proof-card external-proof-unavailable";
      const label = document.createElement("span");
      label.textContent = `EXTERNAL RECEIPT / 0${index + 1}`;
      const heading = document.createElement("h3");
      heading.textContent = "Live evidence unavailable.";
      const note = document.createElement("p");
      note.textContent = error instanceof Error ? error.message : "Receipt could not be verified.";
      card.append(label, heading, note);
      return { card, state: null };
    }
  }));
  grid.replaceChildren(...results.map((result) => result.card));
  grid.setAttribute("aria-busy", "false");
  const verified = results.filter((result) => result.state);
  const states = [...new Set(verified.map((result) => result.state))]
    .map((state) => `${verified.filter((result) => result.state === state).length} ${state.replaceAll("_", " ")}`)
    .join(" · ");
  summary.textContent = verified.length === externalProofCatalog.length
    ? `${verified.length} external buyer-funded covenants verified live${states ? ` · ${states}` : ""}.`
    : `${verified.length} of ${externalProofCatalog.length} curated external receipts verified live. Unavailable evidence is not counted.`;
}

function proofLink(node, transaction, fallbackHref, fallbackText) {
  if (!node) return;
  const code = node?.querySelector("code");
  if (transaction) {
    setLink(node, `${EXPLORER_TX}${transaction}`, undefined, true);
    if (code) code.textContent = short(transaction, 10, 8);
  } else if (fallbackHref) {
    setLink(node, fallbackHref, undefined, false);
    if (code) code.textContent = fallbackText;
  } else {
    disableLink(node);
    if (code) code.textContent = "Unavailable";
  }
}

function renderProof({ status, record }) {
  const receipt = status.receipt;
  const paid = status.state === "paid";
  setText("#proof-receipt-id", receipt.receiptId);
  setText("#proof-state", paid ? "Paid" : "Released");
  setText("#proof-final-step", paid ? "Paid" : "Released");
  setText("#proof-target", `${receipt.target.agentName} #${receipt.target.agentId}`);
  setText("#proof-service", receipt.target.serviceName);
  setText("#proof-cap", `${amount(receipt.covenant.coverageCapUSDT)} USD₮0`);
  setText("#proof-accepted", dateTime(receipt.targetJob.acceptedAt));
  setText("#proof-deadline", dateTime(receipt.covenant.deadline));
  setText("#proof-receipt-hash", receipt.receiptHash);
  setText("#proof-outcome", paid ? `Buyer paid ${amount(receipt.covenant.coverageCapUSDT)} USD₮0` : "Capacity returned to the reserve");
  setText("#proof-outcome-note", paid
    ? "The reserve transfer matched the recorded buyer, USD₮0 asset, and bounded amount."
    : "The target job completed and the recorded liability was released without a payout.");

  proofLink(document.querySelector("#proof-creation-link"), receipt.targetJob.creationTxHash);
  proofLink(document.querySelector("#proof-acceptance-link"), receipt.targetJob.acceptanceTxHash);
  proofLink(document.querySelector("#proof-service-link"), record.servicePaymentTx);
  proofLink(
    document.querySelector("#proof-outcome-link"),
    paid ? record.payoutTx : null,
    `/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}`,
    "Public release receipt",
  );
  document.querySelectorAll("[data-proof-state]").forEach((button) => {
    const selected = button.dataset.proofState === status.state;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) document.querySelector("#proof-receipt-panel")?.setAttribute("aria-labelledby", button.id);
  });
}

function setProofUnavailable(message) {
  setText("#proof-receipt-id", "Live proof unavailable");
  setText("#proof-state", "Unavailable");
  setText("#proof-final-step", "Unavailable");
  setText("#proof-target", "—");
  setText("#proof-service", "—");
  setText("#proof-cap", "—");
  setText("#proof-accepted", "—");
  setText("#proof-deadline", "—");
  setText("#proof-receipt-hash", "—");
  setText("#proof-outcome", "No fallback proof shown");
  setText("#proof-outcome-note", message);
  for (const selector of ["#proof-creation-link", "#proof-acceptance-link", "#proof-service-link", "#proof-outcome-link"]) {
    proofLink(document.querySelector(selector));
  }
}

async function hydrateProof(records) {
  const available = new Map([
    ["paid", records.find((record) => record.state === "paid" && record.payoutTx)],
    ["released", records.find((record) => record.state === "released")],
  ]);
  const buttons = [...document.querySelectorAll("[data-proof-state]")];
  if (!buttons.length) return;
  await Promise.all([...available.values()].filter(Boolean).map(async (record) => {
    try { await fetchStatus(record); }
    catch { available.delete(record.state); }
  }));
  const show = async (state) => {
    const record = available.get(state);
    if (!record) {
      setProofUnavailable(`No ${state} receipt is available in the public ledger.`);
      return;
    }
    try { renderProof(await fetchStatus(record)); }
    catch (error) { setProofUnavailable(error instanceof Error ? error.message : "Receipt unavailable."); }
  };
  buttons.forEach((button, index) => {
    button.disabled = !available.get(button.dataset.proofState);
    button.addEventListener("click", () => show(button.dataset.proofState));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      if (!next.disabled) { next.focus(); next.click(); }
    });
  });
  const requested = new URLSearchParams(window.location.search).get("state");
  const initial = available.get(requested) ? requested : available.get("paid") ? "paid" : "released";
  await show(initial);
}

function preflightReason(reason) {
  const reasons = {
    target_policy_not_registered: "That provider does not have a registered PolicyPool policy. No payment was requested.",
    target_agent_required: "Choose a registered target provider.",
    target_job_not_found: "The public task could not be found.",
    target_job_not_accepted: "The target task is not currently accepted.",
    target_job_target_mismatch: "The accepted task does not match the selected provider.",
    target_job_buyer_mismatch: "Coverage must be purchased by the target-job buyer.",
    target_service_not_verified: "The accepted service could not be bound to the registered policy.",
    requested_coverage_below_minimum: "Request at least 0.5 USD₮0 of coverage. No payment was requested.",
    requested_coverage_exceeds_job_value: "The requested cap exceeds the verified target-job value.",
    reserve_capacity_exceeded: "The public reserve cannot support that cap right now.",
    coverage_already_exists: "That target job already has a covenant record.",
    coverage_enrollment_window_closed: "The provider's published enrollment window has closed. No payment was settled.",
    coverage_quote_window_elapsed: "The verified quote window closed before payment. Run preflight again.",
  };
  return reasons[String(reason || "")] || String(reason || "Coverage could not be verified.").replaceAll("_", " ");
}

function providerCard(policy) {
  const card = document.createElement("article");
  card.className = "provider-card";
  card.id = `provider-v04-${policy.agentId}-${policy.serviceId}`;
  const header = document.createElement("header");
  const monogram = document.createElement("div");
  monogram.className = "provider-monogram";
  monogram.textContent = String(policy.agentName || "A").slice(0, 1).toUpperCase();
  const identity = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = `${policy.serviceType} · AGENT #${policy.agentId}`;
  const title = document.createElement("h3");
  title.textContent = policy.agentName || `Agent #${policy.agentId}`;
  const service = document.createElement("p");
  service.textContent = policy.serviceName || `Service #${policy.serviceId}`;
  identity.append(eyebrow, title, service);
  const status = document.createElement("b");
  status.textContent = "ENROLLED";
  header.append(monogram, identity, status);

  const band = document.createElement("div");
  band.className = "policy-band";
  const bandLabel = document.createElement("span");
  bandLabel.textContent = "Provider-signed promise";
  const promise = document.createElement("p");
  promise.textContent = policy.scope?.deliveryPromise || "Objective delivery terms published on X Layer.";
  band.append(bandLabel, promise);

  const details = document.createElement("dl");
  const cap = Number(policy.terms?.maxCapAtomic || 0) / 1_000_000;
  const rows = [
    ["Service", `#${policy.serviceId}`],
    ["Cap", `${amount(cap)} USD₮0`],
    ["Clock", Number(policy.terms?.clockMode) === 1 ? "PolicyPool provider relay" : "Verified OKX acceptance"],
    ["Registration", policy.registrationTransactionHash ? short(policy.registrationTransactionHash) : "On-chain"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    details.append(row);
  }

  const footer = document.createElement("footer");
  footer.className = "provider-actions";
  const link = document.createElement("a");
  setLink(link, policy.servicePublicUrl || `https://www.okx.ai/agents/${policy.agentId}`, "Open listed agent ↗", true);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.dataset.copyLink = `/providers#${card.id}`;
  copy.textContent = "Copy policy link";
  footer.append(link, copy);
  card.append(header, band, details, footer);
  return card;
}

async function hydrateUniversalProviders() {
  const registry = document.querySelector("#universal-provider-registry");
  const grid = document.querySelector("#universal-provider-grid");
  const target = document.querySelector("#coverage-target");
  if (!registry && !target) return;
  try {
    const response = await fetch("/api/universal-manifest", { cache: "no-store" });
    if (!response.ok) return;
    const manifest = await response.json();
    if (!manifest.enabled) return;
    const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
    if (registry && grid) {
      registry.hidden = false;
      document.querySelector("#universal-registry-state").textContent = `SIGNED REGISTRY / ${String(providers.length).padStart(2, "0")} ENROLLED`;
      grid.replaceChildren(...providers.map(providerCard));
      if (providers.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "The v0.4 contracts are active; no external provider has completed bonded enrollment yet.";
        grid.append(empty);
      }
    }
    if (target) {
      const existing = new Set([...target.options].map((option) => `${option.value}:${option.dataset.serviceId || ""}`));
      const custom = [...target.options].find((option) => option.value === "custom");
      for (const policy of providers) {
        const key = `${policy.agentId}:${policy.serviceId}`;
        if (existing.has(key)) continue;
        const option = document.createElement("option");
        option.value = String(policy.agentId);
        option.dataset.serviceId = String(policy.serviceId);
        option.textContent = `${policy.agentName} #${policy.agentId} · ${policy.serviceName}`;
        target.insertBefore(option, custom || null);
      }
    }
  } catch {
    // v0.3 founding policies remain usable when the optional v0.4 registry is unavailable.
  }
}

function setPreflightStatus(message, state = "") {
  const status = document.querySelector("#coverage-form-status");
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function resultValue(value, href) {
  if (!href) return document.createTextNode(value);
  const link = document.createElement("a");
  setLink(link, href, value, href.startsWith("http"));
  return link;
}

function renderPreflightValues(entries) {
  const list = document.querySelector("#preflight-kv");
  if (!list) return;
  list.replaceChildren(...entries.map((entry) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = entry.label;
    detail.append(resultValue(entry.value, entry.href));
    row.append(term, detail);
    return row;
  }));
}

function showPreflightResult(data) {
  document.querySelector("#preflight-empty").hidden = true;
  document.querySelector("#preflight-output").hidden = false;
  const verdict = document.querySelector("#preflight-verdict");
  const chip = document.querySelector("#preflight-chip");
  const summary = document.querySelector("#preflight-summary");
  const paid = document.querySelector("#preflight-paid-request");
  if (!data.eligible) {
    verdict.textContent = "Not coverable";
    chip.textContent = "Declined free";
    chip.className = "state-stamp state-paid";
    summary.textContent = preflightReason(data.reason);
    paid.hidden = true;
    renderPreflightValues([
      ...(data.task ? [{ label: "Task", value: data.task.title, href: data.task.publicUrl }] : []),
      { label: "Reason", value: String(data.reason || "coverage_gate_failed") },
      { label: "Charge", value: "0 USD₮0" },
      ...(data.enrollmentInvite ? [{ label: "Provider enrollment", value: "Open invite", href: data.enrollmentInvite }] : []),
    ]);
    return;
  }
  verdict.textContent = "Ready to cover";
  chip.textContent = "Verified";
  chip.className = "state-stamp state-released";
  const providerFunded = data.coverage.fundingSource === "provider_first_loss_bond";
  summary.textContent = providerFunded
    ? "The accepted task, signed provider policy, buyer/provider binding, enrollment window, SLA, and live provider bond all passed."
    : "The accepted task, target policy, buyer/provider binding, enrollment window, SLA, and live reserve capacity all passed.";
  paid.hidden = false;
  renderPreflightValues([
    { label: "Task", value: data.task.title, href: data.task.publicUrl },
    { label: "Target", value: `${data.policy.agentName} #${data.policy.agentId}` },
    { label: "Coverage cap", value: `${data.coverage.capUSDT} USD₮0` },
    { label: "Service fee", value: `${data.coverage.serviceFeeUSDT} USD₮0` },
    { label: "Deadline", value: dateTime(data.coverage.deadline) },
    { label: "Enrollment closes", value: dateTime(data.coverage.enrollmentClosesAt) },
    { label: "Quote expires", value: dateTime(data.quote.expiresAt) },
    {
      label: providerFunded ? "Provider bond free" : "Reserve free",
      value: `${providerFunded ? data.coverage.providerBondAvailableUSDT : data.coverage.availableUSDT} USD₮0`,
    },
    { label: "Creation tx", value: short(data.evidence.creationTxHash), href: `${EXPLORER_TX}${data.evidence.creationTxHash}` },
    { label: "Acceptance tx", value: short(data.evidence.acceptanceTxHash), href: `${EXPLORER_TX}${data.evidence.acceptanceTxHash}` },
  ]);
  document.querySelector("#coverage-request-json").textContent = JSON.stringify(data.paidRequest, null, 2);
}

function revealPreflightResult() {
  if (!window.matchMedia("(max-width: 1040px)").matches) return;
  const result = document.querySelector("#coverage-preflight-result");
  if (!result) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  result.focus({ preventScroll: true });
  result.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
}

function bindCoveragePreflight() {
  const form = document.querySelector("#coverage-preflight-form");
  if (!form) return;
  const submit = document.querySelector("#coverage-submit");
  const taskInput = document.querySelector("#coverage-task");
  const capInput = document.querySelector("#coverage-cap");
  const targetSelect = document.querySelector("#coverage-target");
  const targetService = document.querySelector("#coverage-target-service");
  const customAgent = document.querySelector("#coverage-custom-agent");
  const customService = document.querySelector("#coverage-custom-service");
  const setTargetMode = () => {
    const custom = targetSelect.value === "custom";
    document.querySelector("#custom-agent-field").hidden = !custom;
    document.querySelector("#custom-service-field").hidden = !custom;
    customAgent.required = custom;
    customService.required = custom;
    targetService.value = custom ? customService.value : targetSelect.selectedOptions[0]?.dataset.serviceId || "";
  };
  targetSelect.addEventListener("change", setTargetMode);
  customService.addEventListener("input", () => { targetService.value = customService.value.trim(); });
  setTargetMode();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    taskInput.removeAttribute("aria-invalid");
    capInput.removeAttribute("aria-invalid");
    if (!form.checkValidity()) {
      form.querySelector(":invalid")?.setAttribute("aria-invalid", "true");
      form.reportValidity();
      setPreflightStatus("Complete the required fields before checking coverage.", "error");
      return;
    }
    const values = new FormData(form);
    form.setAttribute("aria-busy", "true");
    submit.disabled = true;
    submit.textContent = "Verifying…";
    setPreflightStatus("Reading the OKX task and verifying its X Layer events.");
    try {
      const response = await fetch("/api/coverage-preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetAgent: targetSelect.value === "custom" ? customAgent.value.trim() : values.get("targetAgent"),
          targetServiceId: targetSelect.value === "custom" ? customService.value.trim() : values.get("targetServiceId"),
          taskReference: values.get("taskReference"),
          requestedCoverageUSDT: values.get("requestedCoverageUSDT"),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.error === "target_policy_not_registered" && customAgent.value && customService.value) {
          const demandResponse = await fetch("/api/coverage-demand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: customAgent.value.trim(),
              serviceId: customService.value.trim(),
              taskReference: values.get("taskReference"),
              requestedCoverageUSDT: values.get("requestedCoverageUSDT"),
            }),
          });
          const demand = await demandResponse.json();
          if (demandResponse.ok && demand.ok) {
            showPreflightResult({ eligible: false, reason: data.error, enrollmentInvite: demand.enrollmentInvite });
            setPreflightStatus("Provider demand recorded without charge. Share the enrollment link with the provider.", "error");
            revealPreflightResult();
            return;
          }
        }
        if (String(data.error || "").startsWith("okx_task_")) taskInput.setAttribute("aria-invalid", "true");
        throw new Error(preflightReason(data.error));
      }
      showPreflightResult(data);
      setPreflightStatus(data.eligible ? "Preflight passed. Review the verified paid request." : "Preflight completed without charge.", data.eligible ? "success" : "error");
      revealPreflightResult();
    } catch (error) {
      setPreflightStatus(error instanceof Error ? error.message : "Coverage preflight failed.", "error");
    } finally {
      form.removeAttribute("aria-busy");
      submit.disabled = false;
      submit.textContent = "Run free preflight";
    }
  });
  document.querySelector("#copy-coverage-request")?.addEventListener("click", async () => {
    const content = document.querySelector("#coverage-request-json")?.textContent || "";
    try { await navigator.clipboard.writeText(content); setPreflightStatus("Signed paid request copied.", "success"); }
    catch { setPreflightStatus("Copy failed. Select the request JSON manually.", "error"); }
  });
}

async function hydrateLiveData() {
  const needsLedger = document.querySelector("[data-reserve-available], #coverage-rows, [data-home-outcomes], [data-proof-state]");
  if (!needsLedger) return;
  try {
    const response = await fetch("/api/coverage-ledger", { cache: "no-store" });
    if (!response.ok) throw new Error(`ledger returned ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "ledger unavailable");
    updateReserveSurface(data);
    const records = data.records || [];
    renderHomeOutcomes(records);
    renderLedgerRecords(records);
    await hydrateProof(records);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ledger unavailable";
    setLedgerUnavailable(message);
    setProofUnavailable(message);
    const table = document.querySelector("#coverage-rows");
    if (table) table.innerHTML = `<tr><td colspan="6">Live ledger unavailable. No fallback records shown.</td></tr>`;
    const cards = document.querySelector("#coverage-cards");
    if (cards) cards.textContent = "Live ledger unavailable. No fallback records shown.";
  }
}

bindMobileNavigation();
bindCopyLinks();
bindCoveragePreflight();
hydrateUniversalProviders();
initScrollReveals();
hydrateLiveData();
hydrateExternalProofs();
