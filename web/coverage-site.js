const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const EXPLORER_ADDRESS = "https://www.oklink.com/x-layer/address/";
const providerNames = new Map([
  ["3465", "GlassDesk"],
  ["4348", "Foreman"],
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

function bindMobileNavigation() {
  const menu = document.querySelector(".mobile-nav");
  if (!menu) return;
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => { menu.open = false; }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") menu.open = false; });
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
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
  });
  document.querySelectorAll("[data-reserve-waterline]").forEach((node) => {
    if (node.parentElement?.classList.contains("balance-water")) node.style.height = `${freePercent}%`;
    else node.style.width = `${freePercent}%`;
  });
  document.querySelectorAll("[data-reserve-link]").forEach((node) => {
    setLink(node, `${EXPLORER_ADDRESS}${data.reserve.wallet}`, short(data.reserve.wallet), true);
  });
}

function setLedgerUnavailable(message) {
  setText("[data-reserve-available]", "—");
  setText("[data-reserve-balance]", "—");
  setText("[data-reserve-committed]", "—");
  setText("[data-record-count]", "—");
  setText("[data-ledger-updated]", `Live ledger unavailable. ${message}`);
  document.querySelectorAll("[data-solvency]").forEach((node) => {
    node.textContent = "Unavailable";
    node.classList.remove("is-positive");
    node.classList.add("is-risk");
  });
}

function renderHomeOutcomes(records) {
  for (const state of ["released", "paid"]) {
    const record = records.find((item) => item.state === state && (state !== "paid" || item.payoutTx));
    const link = document.querySelector(`[data-outcome-link="${state}"]`);
    if (!link) continue;
    if (!record) {
      link.textContent = "No live receipt available";
      link.removeAttribute("href");
      continue;
    }
    link.href = `/proof?state=${state}`;
    link.textContent = `${record.receiptId} →`;
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

async function fetchStatus(record) {
  if (statusCache.has(record.state)) return statusCache.get(record.state);
  const response = await fetch(`/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`receipt returned ${response.status}`);
  const status = await response.json();
  if (!status.ok || status.state !== record.state) throw new Error("receipt state mismatch");
  const proof = { status, record };
  statusCache.set(record.state, proof);
  return proof;
}

function proofLink(node, transaction, fallbackHref, fallbackText) {
  const code = node?.querySelector("code");
  if (transaction) {
    setLink(node, `${EXPLORER_TX}${transaction}`, undefined, true);
    if (code) code.textContent = short(transaction, 10, 8);
  } else {
    setLink(node, fallbackHref, undefined, false);
    if (code) code.textContent = fallbackText;
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
  setText("#proof-outcome", "No fallback proof shown");
  setText("#proof-outcome-note", message);
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
    requested_coverage_exceeds_job_value: "The requested cap exceeds the verified target-job value.",
    reserve_capacity_exceeded: "The public reserve cannot support that cap right now.",
    coverage_already_exists: "That target job already has a covenant record.",
  };
  return reasons[String(reason || "")] || String(reason || "Coverage could not be verified.").replaceAll("_", " ");
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
    ]);
    return;
  }
  verdict.textContent = "Ready to cover";
  chip.textContent = "Verified";
  chip.className = "state-stamp state-released";
  summary.textContent = "The accepted task, target policy, buyer/provider binding, SLA, and live reserve capacity all passed.";
  paid.hidden = false;
  renderPreflightValues([
    { label: "Task", value: data.task.title, href: data.task.publicUrl },
    { label: "Target", value: `${data.policy.agentName} #${data.policy.agentId}` },
    { label: "Coverage cap", value: `${data.coverage.capUSDT} USD₮0` },
    { label: "Service fee", value: "1 USD₮0" },
    { label: "Deadline", value: dateTime(data.coverage.deadline) },
    { label: "Reserve free", value: `${data.coverage.availableUSDT} USD₮0` },
    { label: "Creation tx", value: short(data.evidence.creationTxHash), href: `${EXPLORER_TX}${data.evidence.creationTxHash}` },
    { label: "Acceptance tx", value: short(data.evidence.acceptanceTxHash), href: `${EXPLORER_TX}${data.evidence.acceptanceTxHash}` },
  ]);
  document.querySelector("#coverage-request-json").textContent = JSON.stringify(data.paidRequest, null, 2);
}

function bindCoveragePreflight() {
  const form = document.querySelector("#coverage-preflight-form");
  if (!form) return;
  const submit = document.querySelector("#coverage-submit");
  const taskInput = document.querySelector("#coverage-task");
  const capInput = document.querySelector("#coverage-cap");
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
          targetAgent: values.get("targetAgent"),
          taskReference: values.get("taskReference"),
          requestedCoverageUSDT: values.get("requestedCoverageUSDT"),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (String(data.error || "").startsWith("okx_task_")) taskInput.setAttribute("aria-invalid", "true");
        throw new Error(preflightReason(data.error));
      }
      showPreflightResult(data);
      setPreflightStatus(data.eligible ? "Preflight passed. Review the verified paid request." : "Preflight completed without charge.", data.eligible ? "success" : "error");
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
    try { await navigator.clipboard.writeText(content); setPreflightStatus("Verified request JSON copied.", "success"); }
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
bindCoveragePreflight();
hydrateLiveData();
