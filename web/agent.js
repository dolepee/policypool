const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";

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
  if (state === "active" || state === "paid") return "chip-positive";
  if (state === "payout_due" || state === "pending") return "chip-risk";
  return "chip-neutral";
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
    document.querySelector("#reserve-balance").textContent = `${amount(data.reserve.balanceUSDT)} USDT0`;
    document.querySelector("#reserve-committed").textContent = `${amount(data.reserve.committedUSDT)} USDT0`;
    document.querySelector("#coverage-count").textContent = String(data.liabilities.recordCount);
    document.querySelector("#ledger-updated").textContent = `Live read ${new Date(data.generatedAt).toLocaleString()}. No cached fallback.`;
    health.textContent = data.reserve.solvent ? "Solvent" : "Overcommitted";
    health.className = `chip ${data.reserve.solvent ? "chip-positive" : "chip-risk"}`;
    renderRows(data.records || []);
  } catch (error) {
    health.textContent = "Unavailable";
    health.className = "chip chip-risk";
    document.querySelector("#ledger-updated").textContent = "Live ledger unavailable. No fallback numbers are being shown.";
    const rows = document.querySelector("#coverage-rows");
    if (rows) rows.innerHTML = `<tr><td colspan="5">Live proof unavailable: ${error.message}</td></tr>`;
  }
}

hydrateCoverage();
