const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const EXPLORER_ADDRESS = "https://www.oklink.com/x-layer/address/";

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
  requested_coverage_below_minimum: "Request at least 0.01 USDT of coverage.",
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
    { label: "Service fee", value: "1 USDT" },
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

function renderOutcomeProofs(records) {
  const released = records.find((record) => record.state === "released");
  const paid = records.find((record) => record.state === "paid" && record.payoutTx);

  if (released) {
    document.querySelector("#success-state").textContent = "Released";
    document.querySelector("#success-amount").textContent = `${amount(released.liabilityUSDT)} USDT0`;
    const receipt = document.querySelector("#success-receipt-link");
    receipt.href = `/api/coverage-status?receiptId=${encodeURIComponent(released.receiptId)}`;
    receipt.textContent = short(released.receiptId, 10, 5);
  } else {
    document.querySelector("#success-state").textContent = "Awaiting proof";
    document.querySelector("#success-amount").textContent = "--";
    document.querySelector("#success-receipt-link").textContent = "No released receipt";
  }

  if (paid) {
    document.querySelector("#breach-state").textContent = "Paid";
    document.querySelector("#breach-amount").textContent = `${amount(paid.liabilityUSDT)} USDT0`;
    const payout = document.querySelector("#breach-payout-link");
    payout.href = `${EXPLORER_TX}${paid.payoutTx}`;
    payout.target = "_blank";
    payout.rel = "noreferrer";
    payout.textContent = short(paid.payoutTx);
  } else {
    document.querySelector("#breach-state").textContent = "No payout yet";
    document.querySelector("#breach-amount").textContent = "--";
    document.querySelector("#breach-payout-link").textContent = "No paid receipt";
  }
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
    renderOutcomeProofs(records);
  } catch (error) {
    health.textContent = "Unavailable";
    health.className = "chip chip-risk";
    document.querySelector("#reserve-meter-bar").style.width = "0%";
    document.querySelector("#reserve-meter-label").textContent = "Unavailable";
    document.querySelector("#ledger-updated").textContent = "Live ledger unavailable. No fallback numbers are being shown.";
    document.querySelector("#success-state").textContent = "Unavailable";
    document.querySelector("#success-receipt-link").textContent = "Live proof unavailable";
    document.querySelector("#breach-state").textContent = "Unavailable";
    document.querySelector("#breach-payout-link").textContent = "Live proof unavailable";
    const rows = document.querySelector("#coverage-rows");
    if (rows) rows.innerHTML = `<tr><td colspan="5">Live proof unavailable: ${error.message}</td></tr>`;
  }
}

hydrateCoverage();
bindCoveragePreflight();
bindMobileNavigation();
