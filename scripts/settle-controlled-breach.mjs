import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT, XLAYER } from "../api/lib/config.js";

const TOKEN_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const DEFAULT_RECEIPT_ID = "ppc-bd38c81112102af0";
const API_BASE = process.env.POLICYPOOL_API_BASE || "https://policypool.vercel.app";
const PAYOUT_RUN_DIRECTORY = process.env.POLICYPOOL_PAYOUT_RUN_DIRECTORY
  || resolve(homedir(), ".config/policypool/payout-runs");

function parseArgs(argv) {
  const args = { execute: false, receiptId: DEFAULT_RECEIPT_ID };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--execute") args.execute = true;
    if (argv[index] === "--receipt-id") args.receiptId = String(argv[index + 1] || "").trim();
  }
  if (!/^ppc-[a-f0-9]{16}$/.test(args.receiptId)) throw new Error("invalid_receipt_id");
  return args;
}

function readEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const splitAt = line.indexOf("=");
    values[line.slice(0, splitAt).trim()] = line.slice(splitAt + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function loadRuntimeSecrets() {
  const path = process.env.POLICYPOOL_RUNTIME_SECRETS
    || resolve(homedir(), ".config/policypool/runtime-secrets.env");
  const values = readEnvFile(path);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
  if (!process.env.POLICYPOOL_OPERATOR_TOKEN) throw new Error("operator_token_missing");
  if (!/^0x[a-fA-F0-9]{64}$/.test(process.env.POLICYPOOL_FACILITATOR_PRIVATE_KEY || "")) {
    throw new Error("reserve_private_key_missing");
  }
}

function payoutRunPath(receiptId) {
  return resolve(PAYOUT_RUN_DIRECTORY, `${receiptId}.json`);
}

function readPayoutRun(receiptId) {
  const path = payoutRunPath(receiptId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePayoutRun(receiptId, value) {
  mkdirSync(PAYOUT_RUN_DIRECTORY, { recursive: true, mode: 0o700 });
  const path = payoutRunPath(receiptId);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.authorized ? { authorization: `Bearer ${process.env.POLICYPOOL_OPERATOR_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function telegramConfig() {
  try {
    const env = readEnvFile(resolve(homedir(), ".hermes/.env"));
    const token = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_HOME_CHANNEL
      || process.env.TELEGRAM_CHAT_ID
      || env.TELEGRAM_HOME_CHANNEL
      || String(env.TELEGRAM_ALLOWED_USERS || "").split(",")[0].trim();
    return token && chatId ? { token, chatId } : null;
  } catch {
    return null;
  }
}

async function notify(message) {
  const config = telegramConfig();
  if (!config) return;
  const body = new URLSearchParams({
    chat_id: config.chatId,
    text: message.slice(0, 3900),
    disable_web_page_preview: "true",
  });
  await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }).catch(() => undefined);
}

function xLayer() {
  return defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
  });
}

async function getReceiptRecord(receiptId) {
  const { response, body } = await apiJson(`/api/coverage-status?receiptId=${encodeURIComponent(receiptId)}`);
  if (!response.ok || !body.ok || !body.receipt) throw new Error(body.error || "coverage_status_unavailable");
  return {
    state: body.state,
    receipt: body.receipt,
    payout: body.payout,
    payer: body.receipt.buyer?.address,
    liabilityAtomic: body.liabilityAtomic || "0",
  };
}

async function reconcile() {
  const { response, body } = await apiJson("/api/reconcile-coverage", {
    method: "POST",
    authorized: true,
  });
  if (!response.ok || !body.ok) throw new Error(body.error || "coverage_reconciliation_failed");
  return body;
}

async function assertFabricatedPayoutRejected(receiptId) {
  const fabricated = `0x${"1".repeat(64)}`;
  const { response, body } = await apiJson("/api/record-payout", {
    method: "POST",
    authorized: true,
    body: JSON.stringify({ receiptId, transaction: fabricated }),
  });
  if (response.status !== 422 || body.error !== "payout_transaction_not_verified") {
    throw new Error("fabricated_payout_probe_did_not_fail_closed");
  }
  const record = await getReceiptRecord(receiptId);
  if (record.state !== "payout_due") throw new Error("fabricated_payout_probe_changed_state");
}

function assertPayoutRunMatches(run, { receiptId, reserveWallet, recipient, amountAtomic }) {
  if (run.receiptId !== receiptId) throw new Error("payout_run_receipt_mismatch");
  if (getAddress(run.reserveWallet) !== reserveWallet) throw new Error("payout_run_reserve_mismatch");
  if (getAddress(run.recipient) !== recipient) throw new Error("payout_run_recipient_mismatch");
  if (BigInt(run.amountAtomic) !== amountAtomic) throw new Error("payout_run_amount_mismatch");
  if (!/^0x[a-fA-F0-9]+$/.test(run.serializedTransaction || "")) {
    throw new Error("payout_run_serialized_transaction_invalid");
  }
  if (keccak256(run.serializedTransaction) !== run.transaction) {
    throw new Error("payout_run_transaction_hash_mismatch");
  }
}

async function preparePayoutRun({ publicClient, account, receiptId, reserveWallet, recipient, amountAtomic }) {
  const existing = readPayoutRun(receiptId);
  if (existing) {
    assertPayoutRunMatches(existing, { receiptId, reserveWallet, recipient, amountAtomic });
    return existing;
  }

  const data = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: "transfer",
    args: [recipient, amountAtomic],
  });
  const request = await publicClient.prepareTransactionRequest({
    account,
    to: PAYMENT.asset,
    data,
    value: 0n,
  });
  const serializedTransaction = await account.signTransaction(request);
  const run = {
    receiptId,
    reserveWallet,
    recipient,
    amountAtomic: amountAtomic.toString(),
    serializedTransaction,
    transaction: keccak256(serializedTransaction),
    preparedAt: new Date().toISOString(),
  };
  writePayoutRun(receiptId, run);
  return run;
}

async function broadcastPayoutRun(publicClient, run) {
  try {
    const broadcastHash = await publicClient.sendRawTransaction({
      serializedTransaction: run.serializedTransaction,
    });
    if (broadcastHash !== run.transaction) throw new Error("broadcast_transaction_hash_mismatch");
  } catch (error) {
    const transaction = await publicClient.getTransaction({ hash: run.transaction }).catch(() => null);
    if (!transaction) throw error;
  }
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: run.transaction,
    confirmations: 1,
    timeout: 60_000,
  });
  if (receipt.status !== "success") throw new Error("payout_transfer_reverted");
  return run.transaction;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRuntimeSecrets();

  const account = privateKeyToAccount(process.env.POLICYPOOL_FACILITATOR_PRIVATE_KEY);
  const reserveWallet = getAddress(process.env.POLICYPOOL_FACILITATOR_ADDRESS || "");
  if (account.address.toLowerCase() !== reserveWallet.toLowerCase()) {
    throw new Error("reserve_key_address_mismatch");
  }
  let record = await getReceiptRecord(args.receiptId);
  if (record.state === "paid") {
    console.log(JSON.stringify({ ok: true, alreadyPaid: true, receiptId: args.receiptId, payout: record.payout }, null, 2));
    return;
  }
  const deadline = Date.parse(record.receipt?.covenant?.deadline || "");
  if (!Number.isFinite(deadline)) throw new Error("coverage_deadline_missing");
  if (Date.now() <= deadline) {
    console.log(JSON.stringify({
      ok: true,
      ready: false,
      receiptId: args.receiptId,
      state: record.state,
      deadline: new Date(deadline).toISOString(),
      executeRequested: args.execute,
    }, null, 2));
    return;
  }

  await reconcile();
  record = await getReceiptRecord(args.receiptId);
  if (record.state !== "payout_due") {
    throw new Error(`coverage_not_payout_due:${record.state}`);
  }
  const recipient = getAddress(record.buyer?.address || record.payer);
  const amountAtomic = BigInt(record.receipt.covenant.coverageCapAtomic);
  if (amountAtomic !== BigInt(record.liabilityAtomic)) throw new Error("payout_amount_state_mismatch");

  const chain = xLayer();
  const transport = http(XLAYER.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const [reserveBalance, gasBalance] = await Promise.all([
    publicClient.readContract({
      address: PAYMENT.asset,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [reserveWallet],
    }),
    publicClient.getBalance({ address: reserveWallet }),
  ]);
  if (reserveBalance < amountAtomic) throw new Error("reserve_token_balance_insufficient");
  if (gasBalance === 0n) throw new Error("reserve_gas_balance_missing");

  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      ready: true,
      dryRun: true,
      receiptId: args.receiptId,
      state: record.state,
      recipient,
      amountAtomic: amountAtomic.toString(),
      amountUSDT: formatUnits(amountAtomic, PAYMENT.decimals),
      reserveBalanceUSDT: formatUnits(reserveBalance, PAYMENT.decimals),
    }, null, 2));
    return;
  }

  await assertFabricatedPayoutRejected(args.receiptId);
  const payoutRun = await preparePayoutRun({
    publicClient,
    account,
    receiptId: args.receiptId,
    reserveWallet,
    recipient,
    amountAtomic,
  });
  const transaction = await broadcastPayoutRun(publicClient, payoutRun);

  const recorded = await apiJson("/api/record-payout", {
    method: "POST",
    authorized: true,
    body: JSON.stringify({ receiptId: args.receiptId, transaction }),
  });
  if (!recorded.response.ok || !recorded.body.ok || recorded.body.state !== "paid") {
    throw new Error(recorded.body.error || "payout_recording_failed");
  }
  const finalRecord = await getReceiptRecord(args.receiptId);
  if (finalRecord.state !== "paid" || finalRecord.payout?.transaction !== transaction) {
    throw new Error("paid_state_verification_failed");
  }
  writePayoutRun(args.receiptId, {
    ...payoutRun,
    state: "paid",
    recordedAt: new Date().toISOString(),
  });

  const output = {
    ok: true,
    receiptId: args.receiptId,
    state: finalRecord.state,
    amountUSDT: formatUnits(amountAtomic, PAYMENT.decimals),
    recipient,
    transaction,
    explorer: `https://www.oklink.com/x-layer/tx/${transaction}`,
    fabricatedPayoutRejected: true,
  };
  console.log(JSON.stringify(output, null, 2));
  await notify([
    "PolicyPool controlled breach payout verified.",
    `Receipt: ${args.receiptId}`,
    `Amount: ${output.amountUSDT} USDT`,
    `State: ${output.state}`,
    `Tx: ${transaction}`,
    output.explorer,
  ].join("\n"));
}

export const __test = {
  assertPayoutRunMatches,
  broadcastPayoutRun,
  preparePayoutRun,
  readPayoutRun,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`PolicyPool controlled payout failed: ${message}`);
    await notify(`PolicyPool controlled payout FAILED.\n${message}\nManual review required.`);
    process.exitCode = 1;
  });
}
