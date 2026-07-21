const XLAYER_HEX = "0xc4";
let providerWallet = "";
let universalEnabled = false;
let bondReady = false;

const byId = (id) => document.getElementById(id);

function setStatus(id, message, tone = "") {
  const node = byId(id);
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function setStep(step, active) {
  document.querySelector(`[data-step="${step}"]`)?.classList.toggle("is-complete", active);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

async function ensureXLayer() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId.toLowerCase() === XLAYER_HEX) return;
  await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: XLAYER_HEX }] });
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("Transaction reverted");
      return receipt;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
  throw new Error("Transaction confirmation timed out");
}

async function sendTransaction(transaction) {
  const rawValue = String(transaction.value ?? "0");
  const value = rawValue === "0" ? "0x0" : rawValue;
  const hash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: providerWallet, to: transaction.to, data: transaction.data, value }],
  });
  await waitForReceipt(hash);
  return hash;
}

function enrollmentInput() {
  const serviceType = byId("service-type").value;
  const days = 30;
  return {
    agentId: byId("agent-id").value.trim(),
    serviceId: byId("service-id").value.trim(),
    provider: providerWallet,
    slaSeconds: Number(byId("sla-seconds").value),
    enrollmentWindowSeconds: Number(byId("window-seconds").value),
    maxCapUSDT: byId("coverage-cap").value,
    payoutBasis: byId("payout-basis").value,
    clockMode: serviceType === "A2A" ? "verified_acceptance" : "policypool_relay",
    expiresAt: Math.floor(Date.now() / 1000) + days * 24 * 60 * 60,
    scope: {
      deliveryPromise: byId("delivery-promise").value.trim(),
      objectiveBreach: byId("objective-breach").value.trim(),
      coveredKeywords: byId("covered-keywords").value.split(",").map((item) => item.trim()).filter(Boolean),
      exclusions: byId("exclusions").value.split(",").map((item) => item.trim()).filter(Boolean),
    },
  };
}

async function connectWallet() {
  if (!universalEnabled) throw new Error("v0.4 enrollment is feature-gated");
  if (!window.ethereum) throw new Error("No EVM wallet found in this browser");
  await ensureXLayer();
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  providerWallet = account;
  byId("connected-wallet").textContent = `${account.slice(0, 8)}…${account.slice(-6)}`;
  byId("fund-bond").disabled = !universalEnabled;
  setStep("connect", true);
  setStatus("bond-status", "Wallet connected. Build the bond transactions.", "ready");
}

async function fundBond() {
  await ensureXLayer();
  setStatus("bond-status", "Checking allowance and bond requirement…");
  const plan = await api("/api/provider-bond", {
    provider: providerWallet,
    amountUSDT: byId("bond-amount").value,
  });
  if (plan.transactions.length === 0) {
    setStatus("bond-status", "Existing provider bond already satisfies the minimum.", "success");
  }
  for (const [index, transaction] of plan.transactions.entries()) {
    setStatus("bond-status", `Confirm transaction ${index + 1} of ${plan.transactions.length}: ${transaction.purpose}.`);
    await sendTransaction(transaction);
  }
  bondReady = true;
  byId("publish-policy").disabled = false;
  setStep("bond", true);
  if (plan.transactions.length > 0) setStatus("bond-status", "Provider bond confirmed on X Layer.", "success");
  setStatus("policy-status", "Enter objective terms, then sign the policy.", "ready");
}

async function publishPolicy(event) {
  event.preventDefault();
  if (!bondReady || !providerWallet) return;
  await ensureXLayer();
  const input = enrollmentInput();
  setStatus("policy-status", "Verifying live OKX.AI owner, service, fingerprint, and bond…");
  const prepared = await api("/api/provider-enrollment", { ...input, action: "prepare" });
  setStatus("policy-status", "Sign the exact versioned policy terms in your wallet.");
  const signature = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [providerWallet, JSON.stringify(prepared.typedData)],
  });
  const submitted = await api("/api/provider-enrollment", {
    ...input,
    action: "submit",
    nonce: prepared.nonce,
    signatureDeadline: prepared.signatureDeadline,
    signature,
  });
  setStatus("policy-status", "Broadcast the on-chain policy registration.");
  const transactionHash = await sendTransaction(submitted.transaction);
  const confirmed = await api("/api/provider-enrollment", {
    action: "confirm",
    enrollmentId: submitted.enrollment.policyId,
    transactionHash,
  });
  setStep("policy", true);
  setStatus("policy-status", "Policy active. Listing changes will fail closed until re-enrollment.", "success");
  const result = byId("enrollment-result");
  const values = byId("enrollment-result-values");
  values.replaceChildren(...[
    ["Agent", `#${confirmed.enrollment.agentId}`],
    ["Service", `#${confirmed.enrollment.serviceId}`],
    ["Policy", confirmed.enrollment.onchainPolicyId],
    ["Registration tx", transactionHash],
  ].map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    return row;
  }));
  result.hidden = false;
  result.focus();
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const connectButton = byId("connect-wallet");
  byId("agent-id").value = params.get("agent") || "";
  byId("service-id").value = params.get("service") || "";
  try {
    const response = await fetch("/api/universal-manifest", { cache: "no-store" });
    const manifest = await response.json();
    universalEnabled = Boolean(manifest.enabled);
    connectButton.disabled = !universalEnabled;
    setStatus(
      "universal-status",
      universalEnabled ? "v0.4 enrollment is live." : "v0.4 enrollment is feature-gated; no transaction can be created yet.",
      universalEnabled ? "success" : "",
    );
  } catch {
    connectButton.disabled = true;
    setStatus("universal-status", "Enrollment status unavailable. No transaction will be requested.");
  }
  byId("connect-wallet").addEventListener("click", () => connectWallet().catch((error) => setStatus("universal-status", error.message)));
  byId("fund-bond").addEventListener("click", () => fundBond().catch((error) => setStatus("bond-status", error.message, "error")));
  byId("enrollment-form").addEventListener("submit", (event) => publishPolicy(event).catch((error) => setStatus("policy-status", error.message, "error")));
}

initialize();
