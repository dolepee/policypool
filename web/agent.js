const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const EXPLORER_ADDRESS = "https://www.oklink.com/x-layer/address/";
const outcomeProofs = new Map();

function short(value, left = 8, right = 6) {
  if (!value || value.length <= left + right) return value || "-";
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function amount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
    : "0";
}

function dateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function stateChip(state) {
  if (state === "active" || state === "paid" || state === "released") return "chip-positive";
  if (state === "payout_due" || state === "pending") return "chip-risk";
  return "chip-neutral";
}

const PREFLIGHT_REASONS = {
  insufficient_uncommitted_reserve: "The public reserve does not currently have enough uncommitted capacity.",
  job_outside_registered_policy: "The task falls outside the target agent's published policy snapshot.",
  okx_task_reference_required: "Enter an accepted OKX.AI task URL or public task ID.",
  okx_task_host_not_allowed: "Only public task links from okx.ai can be checked.",
  okx_task_url_invalid: "This is not a recognized OKX.AI task URL.",
  registered_policy_sla_already_elapsed: "The registered coverage window has already elapsed.",
  requested_coverage_below_minimum: "Request at least 1 USDT of coverage.",
  target_policy_not_registered: "PolicyPool does not yet have a published policy snapshot for this target.",
};

function preflightReason(reason) {
  if (String(reason).startsWith("target_job_not_accepted:")) {
    return "The task is no longer in the accepted state, so new coverage cannot be issued.";
  }
  return PREFLIGHT_REASONS[reason] || String(reason || "The task did not pass the coverage gate.").replaceAll("_", " ");
}

function setPreflightStatus(message, state = "neutral") {
  const status = document.querySelector("#coverage-form-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function createResultValue(value, href) {
  if (!href) return document.createTextNode(value);
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = value;
  return link;
}

function renderPreflightValues(entries) {
  const list = document.querySelector("#preflight-kv");
  list.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = entry.label;
    detail.append(createResultValue(entry.value, entry.href));
    row.append(term, detail);
    list.append(row);
  }
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
    chip.className = "chip chip-risk";
    summary.textContent = preflightReason(data.reason);
    paid.hidden = true;
    renderPreflightValues([
      ...(data.task ? [{ label: "Task", value: data.task.title, href: data.task.publicUrl }] : []),
      { label: "Reason", value: String(data.reason || "coverage_gate_failed") },
      { label: "Charge", value: "0 USDT" },
    ]);
    return;
  }

  verdict.textContent = "Ready to cover";
  chip.textContent = "Verified";
  chip.className = "chip chip-positive";
  summary.textContent = "The accepted task, target policy, buyer/provider binding, SLA, and current reserve capacity all passed.";
  paid.hidden = false;
  renderPreflightValues([
    { label: "Task", value: data.task.title, href: data.task.publicUrl },
    { label: "Target", value: `${data.policy.agentName} #${data.policy.agentId}` },
    { label: "Coverage cap", value: `${data.coverage.capUSDT} USDT` },
    { label: "Service fee", value: `${data.coverage.serviceFeeUSDT} USDT` },
    { label: "Deadline", value: new Date(data.coverage.deadline).toLocaleString() },
    { label: "Reserve free", value: `${data.coverage.availableUSDT} USDT` },
    {
      label: "Creation tx",
      value: short(data.evidence.creationTxHash),
      href: `${EXPLORER_TX}${data.evidence.creationTxHash}`,
    },
    {
      label: "Acceptance tx",
      value: short(data.evidence.acceptanceTxHash),
      href: `${EXPLORER_TX}${data.evidence.acceptanceTxHash}`,
    },
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
    submit.textContent = "Verifying...";
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
      setPreflightStatus(
        data.eligible ? "Preflight passed. Review the verified paid request below." : "Preflight completed without charge.",
        data.eligible ? "success" : "error",
      );
    } catch (error) {
      setPreflightStatus(error instanceof Error ? error.message : "Coverage preflight failed.", "error");
    } finally {
      form.removeAttribute("aria-busy");
      submit.disabled = false;
      submit.textContent = "Check coverage";
    }
  });

  document.querySelector("#copy-coverage-request")?.addEventListener("click", async () => {
    const content = document.querySelector("#coverage-request-json")?.textContent || "";
    try {
      await navigator.clipboard.writeText(content);
      setPreflightStatus("Verified request JSON copied.", "success");
    } catch {
      setPreflightStatus("Copy failed. Select the request JSON manually.", "error");
    }
  });
}

function bindMobileNavigation() {
  const menu = document.querySelector(".mobile-nav");
  if (!menu) return;
  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.open = false;
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") menu.open = false;
  });
}

function renderReceiptConsole(data) {
  const receipt = data.receipt;
  const state = data.state;
  const paid = state === "paid";
  const sheet = document.querySelector("#terminal-sheet");
  sheet.dataset.state = state;
  document.querySelector("#terminal-state").textContent = paid ? "Paid" : "Released";
  document.querySelector("#terminal-receipt").textContent = receipt.receiptId;
  document.querySelector("#terminal-final-step").textContent = paid ? "Paid" : "Released";
  document.querySelector("#terminal-target").textContent = `${receipt.target.agentName} #${receipt.target.agentId}`;
  document.querySelector("#terminal-service").textContent = receipt.target.serviceName;
  document.querySelector("#terminal-cap").textContent = `${amount(receipt.covenant.coverageCapUSDT)} USD₮0`;
  document.querySelector("#terminal-accepted").textContent = dateTime(receipt.targetJob.acceptedAt);
  document.querySelector("#terminal-deadline").textContent = dateTime(receipt.covenant.deadline);

  const proofLink = document.querySelector("#terminal-proof-link");
  if (paid) {
    document.querySelector("#terminal-outcome-title").textContent = `Buyer paid ${amount(receipt.covenant.coverageCapUSDT)} USD₮0`;
    document.querySelector("#terminal-outcome-note").textContent = "Reserve transfer matched the buyer, asset, and bounded amount.";
    proofLink.href = `${EXPLORER_TX}${data.payout.transaction}`;
    proofLink.target = "_blank";
    proofLink.rel = "noreferrer";
    proofLink.textContent = "View payout tx ↗";
  } else {
    document.querySelector("#terminal-outcome-title").textContent = "Capacity returned to the pool";
    document.querySelector("#terminal-outcome-note").textContent = "The job completed and the reserved cap was released.";
    proofLink.href = `/api/coverage-status?receiptId=${encodeURIComponent(receipt.receiptId)}`;
    proofLink.removeAttribute("target");
    proofLink.removeAttribute("rel");
    proofLink.textContent = "Open receipt ↗";
  }

  document.querySelectorAll(".receipt-tabs button").forEach((button) => {
    const selected = button.dataset.outcome === state;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) sheet.setAttribute("aria-labelledby", button.id);
  });
}

function setReceiptConsoleUnavailable() {
  const sheet = document.querySelector("#terminal-sheet");
  sheet.dataset.state = "unavailable";
  document.querySelector("#terminal-state").textContent = "Unavailable";
  document.querySelector("#terminal-receipt").textContent = "Live receipt unavailable";
  document.querySelector("#terminal-outcome-title").textContent = "No fallback proof shown";
  document.querySelector("#terminal-outcome-note").textContent = "Retry the public ledger before relying on this surface.";
}

async function hydrateReceiptConsole(records) {
  const candidates = new Map([
    ["released", records.find((record) => record.state === "released")],
    ["paid", records.find((record) => record.state === "paid" && record.payoutTx)],
  ]);

  outcomeProofs.clear();
  await Promise.all([...candidates.entries()].map(async ([state, record]) => {
    if (!record) return;
    try {
      const response = await fetch(`/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (data.ok && data.state === state) outcomeProofs.set(state, data);
    } catch {
      // Each tab fails closed independently; a missing receipt is never replaced with static proof.
    }
  }));

  document.querySelectorAll(".receipt-tabs button").forEach((button) => {
    button.disabled = !outcomeProofs.has(button.dataset.outcome);
  });
  const preferred = outcomeProofs.get("paid") || outcomeProofs.get("released");
  if (preferred) renderReceiptConsole(preferred);
  else setReceiptConsoleUnavailable();
}

function bindReceiptTabs() {
  const tabs = [...document.querySelectorAll(".receipt-tabs button")];
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => {
      const data = outcomeProofs.get(button.dataset.outcome);
      if (data) renderReceiptConsole(data);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      if (!next.disabled) {
        next.focus();
        next.click();
      }
    });
  });
}

function renderRows(records) {
  const host = document.querySelector("#coverage-rows");
  if (!host) return;
  if (!records.length) {
    host.innerHTML = '<tr><td colspan="5">No live money-backed covenant has been issued yet. The ledger is ready and empty.</td></tr>';
    return;
  }
  host.innerHTML = records.map((record) => {
    const payment = record.servicePaymentTx
      ? `<a href="${EXPLORER_TX}${record.servicePaymentTx}" target="_blank" rel="noreferrer">${short(record.servicePaymentTx)}</a>`
      : "-";
    return `<tr>
      <td data-label="Receipt"><a href="/api/coverage-status?receiptId=${encodeURIComponent(record.receiptId)}">${short(record.receiptId, 10, 5)}</a></td>
      <td data-label="Target job" class="mono">${short(record.targetJobId)}</td>
      <td data-label="State"><span class="chip ${stateChip(record.state)}">${record.state.replaceAll("_", " ")}</span></td>
      <td data-label="Cap">${amount(record.liabilityUSDT)} USDT0</td>
      <td data-label="Service payment" class="mono">${payment}</td>
    </tr>`;
  }).join("");
}

async function hydrateCoverage() {
  const health = document.querySelector("#ledger-health");
  try {
    const response = await fetch("/api/coverage-ledger", { cache: "no-store" });
    if (!response.ok) throw new Error(`ledger returned ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "ledger unavailable");
    document.querySelector("#reserve-available").textContent = amount(
      Number(data.reserve.availableAtomic) / 10 ** data.asset.decimals,
    );
    const balanceAtomic = Number(data.reserve.balanceAtomic || 0);
    const availableAtomic = Number(data.reserve.availableAtomic || 0);
    const availablePercent = balanceAtomic > 0 ? Math.max(0, Math.min(100, (availableAtomic / balanceAtomic) * 100)) : 0;
    document.querySelector("#reserve-meter-bar").style.width = `${availablePercent}%`;
    document.querySelector("#reserve-meter-label").textContent = `${amount(availablePercent)}% free`;
    document.querySelector("#reserve-balance").textContent = `${amount(data.reserve.balanceUSDT)} USDT0`;
    document.querySelector("#reserve-committed").textContent = `${amount(data.reserve.committedUSDT)} USDT0`;
    document.querySelector("#coverage-count").textContent = String(data.liabilities.recordCount);
    const reserveLink = document.querySelector("#reserve-link");
    reserveLink.href = `${EXPLORER_ADDRESS}${data.reserve.wallet}`;
    reserveLink.textContent = short(data.reserve.wallet);
    document.querySelector("#ledger-updated").textContent = `Live read ${new Date(data.generatedAt).toLocaleString()}. No cached fallback.`;
    health.textContent = data.reserve.solvent ? "Solvent" : "Overcommitted";
    health.className = `chip ${data.reserve.solvent ? "chip-positive" : "chip-risk"}`;
    const records = data.records || [];
    renderRows(records);
    await hydrateReceiptConsole(records);
  } catch (error) {
    health.textContent = "Unavailable";
    health.className = "chip chip-risk";
    document.querySelector("#reserve-meter-bar").style.width = "0%";
    document.querySelector("#reserve-meter-label").textContent = "Unavailable";
    document.querySelector("#ledger-updated").textContent = "Live ledger unavailable. No fallback numbers are being shown.";
    setReceiptConsoleUnavailable();
    const rows = document.querySelector("#coverage-rows");
    if (rows) rows.innerHTML = `<tr><td colspan="5">Live proof unavailable: ${error.message}</td></tr>`;
  }
}

hydrateCoverage();
bindCoveragePreflight();
bindMobileNavigation();
bindReceiptTabs();
