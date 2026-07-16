import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { PAYMENT, XLAYER } from "./lib/config.js";
import { universalConfiguration } from "./lib/universal-config.js";
import { parseUsdtAtomic, sendJson } from "./lib/utils.js";
import { createRateLimiter, enforceRateLimit } from "./lib/rate-limit.js";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const VAULT_ABI = parseAbi([
  "function availableBond(address provider) view returns (uint256)",
  "function deposit(uint256 amount)",
]);
const REGISTRY_ABI = parseAbi([
  "function minimumBondAtomic() view returns (uint256)",
]);

function client() {
  return createPublicClient({
    chain: defineChain({
      id: XLAYER.id,
      name: XLAYER.name,
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
    }),
    transport: http(XLAYER.rpcUrl),
  });
}

export function createProviderBondHandler(dependencies = {}) {
  const configuration = dependencies.configuration || universalConfiguration();
  const publicClient = dependencies.client || client();
  const limiter = dependencies.limiter || createRateLimiter();

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        service: "PolicyPool Provider Bond Builder",
        custody: "provider_signs_and_broadcasts_every_transaction",
        enabled: configuration.ready,
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", charged: false });
    }
    const limited = await enforceRateLimit(req, res, limiter, {
      scope: "provider-bond",
      subject: req.body?.provider,
      limit: 20,
      windowSeconds: 60,
    });
    if (limited) return sendJson(res, 429, limited);
    if (!configuration.ready) {
      return sendJson(res, 503, { ok: false, error: "universal_enrollment_not_active", charged: false });
    }
    let provider;
    try {
      provider = getAddress(req.body?.provider);
    } catch {
      return sendJson(res, 422, { ok: false, error: "provider_address_invalid", charged: false });
    }
    const amountAtomic = parseUsdtAtomic(req.body?.amountUSDT ?? "0", PAYMENT.decimals);
    if (amountAtomic < 0n) {
      return sendJson(res, 422, { ok: false, error: "bond_amount_invalid", charged: false });
    }
    try {
      const [minimumBondAtomic, availableBondAtomic, allowanceAtomic] = await Promise.all([
        publicClient.readContract({
          address: configuration.policyRegistry,
          abi: REGISTRY_ABI,
          functionName: "minimumBondAtomic",
        }),
        publicClient.readContract({
          address: configuration.bondVault,
          abi: VAULT_ABI,
          functionName: "availableBond",
          args: [provider],
        }),
        publicClient.readContract({
          address: PAYMENT.asset,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [provider, configuration.bondVault],
        }),
      ]);
      if (BigInt(availableBondAtomic) + amountAtomic < BigInt(minimumBondAtomic)) {
        return sendJson(res, 422, {
          ok: false,
          error: "resulting_bond_below_minimum",
          charged: false,
          minimumBondAtomic: BigInt(minimumBondAtomic).toString(),
          availableBondAtomic: BigInt(availableBondAtomic).toString(),
        });
      }
      const transactions = [];
      if (amountAtomic > 0n && BigInt(allowanceAtomic) < amountAtomic) {
        transactions.push({
          purpose: "approve_provider_bond_vault",
          to: PAYMENT.asset,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [configuration.bondVault, amountAtomic],
          }),
          value: "0x0",
        });
      }
      if (amountAtomic > 0n) {
        transactions.push({
          purpose: "deposit_provider_first_loss_bond",
          to: configuration.bondVault,
          data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amountAtomic] }),
          value: "0x0",
        });
      }
      return sendJson(res, 200, {
        ok: true,
        version: "0.4.0",
        provider,
        asset: PAYMENT.asset,
        amountAtomic: amountAtomic.toString(),
        minimumBondAtomic: BigInt(minimumBondAtomic).toString(),
        availableBondAtomic: BigInt(availableBondAtomic).toString(),
        resultingAvailableBondAtomic: (BigInt(availableBondAtomic) + amountAtomic).toString(),
        transactions,
        broadcastBy: "provider_wallet",
      });
    } catch {
      return sendJson(res, 503, { ok: false, error: "provider_bond_state_unavailable", charged: false });
    }
  };
}

export default createProviderBondHandler();
