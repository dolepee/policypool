const CHAIN_ID_HEX = "0xc4";
const RPC_URL = "https://rpc.xlayer.tech";
const EXPLORER_TX = "https://www.oklink.com/x-layer/tx/";
const USDC = 1_000_000n;

const ADDRESSES = {
  hook: "0x7D676FA819D8CDF0A2BB73B944a3533870868080",
  router: "0xCD46b2C1e6dD9d0fd3Edd9B26F0137E02F3Fc29e",
  poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
  mockUsdc: "0xBb856B7ce87315eaBF1005861B1b321826a6D33c",
  mockEth: "0xEA76c34E0d6d43326c9AB98088536d129242d181",
};

const POOLS = {
  loose: "0x1f03803fe744002a219a7d74646f3e355130b4afbd073c05afd3684bc70bbbf7",
  strict: "0x1c32ec3d512c6807ba73c5cd32bdf2fe6c3ab07dc3e820340378c728bb5711f7",
  surge: "0x1a024c08b90a1c3534b790c9e6c3c128d54fc9a3703d4882398f27a2d2ac068b",
};

const PROOFS = [
  {
    time: "verified 2026-05-23",
    pool: "Loose",
    poolId: POOLS.loose,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "5,000 MockUSDC",
    verdict: "accepted",
    reason: "SwapAccepted",
    tx: "0x1ee4c6e668306c1ed7dddb0a47cb8c722607f892d03f69746d2822df13423396",
  },
  {
    time: "verified 2026-05-23",
    pool: "Strict",
    poolId: POOLS.strict,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "5,000 MockUSDC",
    verdict: "refused",
    reason: "MAX_SWAP_EXCEEDED",
    tx: "0xbc206a69a3728847dd28e4958e8e7f7d931f6d34d3e84a505103fd6ff0ec435a",
  },
  {
    time: "verified 2026-05-23",
    pool: "Strict",
    poolId: POOLS.strict,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "1,000 MockUSDC",
    verdict: "accepted",
    reason: "SwapAccepted",
    tx: "0x2a260e92507918a290117e17445aea183b9fa2f1959bbd5719750b487b56f178",
  },
  {
    time: "verified 2026-05-23",
    pool: "Strict",
    poolId: POOLS.strict,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "1,000 MockUSDC",
    verdict: "accepted",
    reason: "SwapAccepted",
    tx: "0xc6085e4feaa9e6559a04a21d10eb55503224a86a924c19622e51a31b0a45292b",
  },
  {
    time: "verified 2026-05-23",
    pool: "Strict",
    poolId: POOLS.strict,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "1,000 MockUSDC",
    verdict: "refused",
    reason: "DAILY_CAP_EXCEEDED",
    tx: "0x71130fce6387f081b5f2ded837879c38cdd18640fd62a8a11533d48737be771c",
  },
  {
    time: "verified 2026-05-23",
    pool: "Surge",
    poolId: POOLS.surge,
    trader: "0xd05AAD5b86f6FFCc10872803bEdb5fa911e0E1fD",
    amount: "5,000 MockUSDC + 40 mUSDC donate",
    verdict: "accepted",
    reason: "SurgeAccepted",
    tx: "0x18096b74138d43a6683f1c914e7aa83633c8ed0ba6a533cf6e7e939f5f7ea9a8",
  },
  {
    time: "verified 2026-05-23",
    pool: "Surge",
    poolId: POOLS.surge,
    trader: "0xAe9894AEF73eA9B1521262771CBACA3FfbFe081b",
    amount: "5,000 MockUSDC",
    verdict: "refused",
    reason: "MAX_SWAP_EXCEEDED",
    tx: "0x4877a6cf2214148d8ba0b3ca7d036da1cde7e35a33eeaaf79718f3e54ee4843a",
  },
];

const ROUTES = new Map([
  ["/", "home"],
  ["/console", "console"],
  ["/receipts", "receipts"],
]);

function shortHash(value, left = 6, right = 4) {
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function pad64(value) {
  return value.toString(16).padStart(64, "0");
}

function encodeAddress(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeUint(value) {
  return pad64(BigInt(value));
}

function amountToUnits(value) {
  const clean = Number.isFinite(Number(value)) ? Math.max(1, Number(value)) : 1;
  return BigInt(Math.round(clean * 1_000_000));
}

function selectedPoolId(feeTier) {
  return feeTier === "10000" ? POOLS.strict : POOLS.loose;
}

function renderRoute(path = window.location.pathname) {
  const page = ROUTES.get(path) || "home";
  document.querySelectorAll("[data-page]").forEach((node) => {
    node.hidden = node.dataset.page !== page;
  });
  document.querySelectorAll("[data-nav]").forEach((node) => {
    if (node.dataset.nav === page) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  document.title =
    page === "console"
      ? "PolicyPool Console · X Layer"
      : page === "receipts"
        ? "PolicyPool Receipts · X Layer"
        : "PolicyPool · X Layer policy console";
}

function onRouteClick(event) {
  const link = event.target.closest("[data-route]");
  if (!link) return;
  const url = new URL(link.href);
  if (url.origin !== window.location.origin) return;
  event.preventDefault();
  window.history.pushState({}, "", url.pathname);
  renderRoute(url.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderReceipts(proofs = PROOFS) {
  const rows = document.querySelector("#receipt-rows");
  if (!rows) return;
  rows.innerHTML = proofs
    .map((proof) => {
      const chip = proof.verdict === "accepted" ? "chip-positive" : "chip-risk";
      return `
        <tr>
          <td data-label="Time">${proof.time}</td>
          <td data-label="Pool" class="mono">${proof.pool}</td>
          <td data-label="Trader" class="mono">${shortHash(proof.trader, 8, 4)}</td>
          <td data-label="Amount">${proof.amount}</td>
          <td data-label="Verdict"><span class="chip ${chip}">${proof.verdict} · ${proof.reason}</span></td>
          <td data-label="Tx" class="mono"><a href="${EXPLORER_TX}${proof.tx}" target="_blank" rel="noreferrer">${shortHash(proof.tx)}</a></td>
        </tr>
      `;
    })
    .join("");
}

function updateStats() {
  const accepted = PROOFS.filter((proof) => proof.verdict === "accepted").length;
  const refused = PROOFS.filter((proof) => proof.verdict === "refused").length;
  document.querySelector("#accepted-count").textContent = String(accepted);
  document.querySelector("#refused-count").textContent = String(refused);
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

async function hydrateReceiptTimes() {
  try {
    const hydrated = [];
    const blockCache = new Map();
    for (const proof of PROOFS) {
      const receipt = await rpc("eth_getTransactionReceipt", [proof.tx]);
      if (!receipt?.blockNumber) {
        hydrated.push(proof);
        continue;
      }
      if (!blockCache.has(receipt.blockNumber)) {
        blockCache.set(receipt.blockNumber, await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]));
      }
      const block = blockCache.get(receipt.blockNumber);
      const timestamp = new Date(Number.parseInt(block.timestamp, 16) * 1000);
      hydrated.push({
        ...proof,
        time: timestamp.toLocaleString(undefined, {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    }
    renderReceipts(hydrated);
    document.querySelector("#proof-source").textContent = "live-read receipts";
    document.querySelector("#receipts-source").textContent = "live-read receipts";
  } catch {
    renderReceipts(PROOFS);
  }
}

function buildSetPolicyCalldata(poolId, maxSwap, dailyCap) {
  const selector = "76921b31";
  return `0x${selector}${poolId.replace(/^0x/, "")}${encodeUint(maxSwap)}${encodeUint(dailyCap)}`;
}

function buildInitializeCalldata(feeTier) {
  const selector = "6276cbbe";
  const tickSpacing = feeTier === "10000" ? 200n : 60n;
  const sqrtPriceX96 = 79_228_162_514_264_337_593_543_950_336n;
  return `0x${selector}${encodeAddress(ADDRESSES.mockUsdc)}${encodeAddress(ADDRESSES.mockEth)}${encodeUint(BigInt(feeTier))}${encodeUint(tickSpacing)}${encodeAddress(ADDRESSES.hook)}${encodeUint(sqrtPriceX96)}`;
}

function updateConsoleOutput() {
  const maxSwapInput = document.querySelector("#max-swap");
  const dailyCapInput = document.querySelector("#daily-cap");
  const feeTierInput = document.querySelector("#fee-tier");
  const maxSwap = Math.max(1, Number(maxSwapInput.value || 1));
  const dailyCap = Math.max(maxSwap, Number(dailyCapInput.value || maxSwap));
  if (dailyCap !== Number(dailyCapInput.value)) dailyCapInput.value = String(dailyCap);

  const maxUnits = amountToUnits(maxSwap);
  const capUnits = amountToUnits(dailyCap);
  const poolId = selectedPoolId(feeTierInput.value);
  const setPolicyCalldata = buildSetPolicyCalldata(poolId, maxUnits, capUnits);
  const initializeCalldata = buildInitializeCalldata(feeTierInput.value);
  const tickSpacing = feeTierInput.value === "10000" ? 200 : 60;

  document.querySelector("#policy-preview").textContent =
    `Swaps over ${maxSwap.toLocaleString()} MockUSDC refuse. Pool stops accepting after ${dailyCap.toLocaleString()} MockUSDC per day.`;
  document.querySelector("#set-policy-calldata").textContent = setPolicyCalldata;
  document.querySelector("#cast-command").textContent =
    `# Existing live pool owner-only policy update\n` +
    `cast send ${ADDRESSES.hook} "setPolicy(bytes32,uint256,uint256)" ${poolId} ${maxUnits} ${capUnits} --rpc-url $XLAYER_RPC_URL --chain 196 --private-key $PRIVATE_KEY\n\n` +
    `# Brand-new pool initialization calldata for the live router (not submitted by this UI)\n` +
    `cast send ${ADDRESSES.router} "initialize((address,address,uint24,int24,address),uint160)" ` +
    `"(${ADDRESSES.mockUsdc},${ADDRESSES.mockEth},${feeTierInput.value},${tickSpacing},${ADDRESSES.hook})" ` +
    `79228162514264337593543950336 --rpc-url $XLAYER_RPC_URL --chain 196 --private-key $PRIVATE_KEY\n\n` +
    `# initialize calldata\n${initializeCalldata}`;
}

async function connectWallet() {
  const status = document.querySelector("#wallet-status");
  if (!window.ethereum) {
    status.textContent = "No browser wallet detected";
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== CHAIN_ID_HEX) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: "X Layer Mainnet",
            nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: ["https://www.oklink.com/x-layer"],
          },
        ],
      });
    }
    status.textContent = `Connected ${shortHash(accounts[0], 8, 4)} on X Layer`;
  } catch (error) {
    status.textContent = error?.message || "Wallet connection rejected";
  }
}

async function copyTarget(button) {
  const target = document.querySelector(`#${button.dataset.copyTarget}`);
  if (!target) return;
  await navigator.clipboard.writeText(target.textContent);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

document.addEventListener("click", (event) => {
  onRouteClick(event);
  const copyButton = event.target.closest("[data-copy-target]");
  if (copyButton) void copyTarget(copyButton);
});

window.addEventListener("popstate", () => renderRoute());
document.querySelector("#connect-wallet")?.addEventListener("click", connectWallet);
document.querySelector("#policy-form")?.addEventListener("input", updateConsoleOutput);

renderRoute();
renderReceipts();
updateStats();
updateConsoleOutput();
void hydrateReceiptTimes();
