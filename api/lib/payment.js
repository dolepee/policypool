import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT, XLAYER } from "./config.js";
import { header, isBytes32, sha256 } from "./utils.js";

export class PaymentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaymentConfigurationError";
  }
}

export class PaymentVerificationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "PaymentVerificationError";
    this.code = code;
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function assertAccepted(accepted, requirements) {
  if (!accepted || typeof accepted !== "object") throw new PaymentVerificationError("missing_accepted_requirements");
  if (accepted.scheme !== requirements.scheme) throw new PaymentVerificationError("payment_scheme_mismatch");
  if (accepted.network !== requirements.network) throw new PaymentVerificationError("payment_network_mismatch");
  if (!sameAddress(accepted.asset, requirements.asset)) throw new PaymentVerificationError("payment_asset_mismatch");
  if (!sameAddress(accepted.payTo, requirements.payTo)) throw new PaymentVerificationError("payment_recipient_mismatch");
  if (String(accepted.amount) !== String(requirements.amount)) throw new PaymentVerificationError("payment_amount_mismatch");
}

function createHttpFacilitator() {
  const url = process.env.POLICYPOOL_FACILITATOR_URL;
  if (!url) return null;
  const token = process.env.POLICYPOOL_FACILITATOR_TOKEN;
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  return new HTTPFacilitatorClient({
    url,
    createAuthHeaders: async () => ({
      verify: auth,
      settle: auth,
      supported: auth,
      bazaar: auth,
    }),
  });
}

function createLocalFacilitator() {
  const privateKey = process.env.POLICYPOOL_FACILITATOR_PRIVATE_KEY;
  if (!privateKey) return null;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new PaymentConfigurationError("POLICYPOOL_FACILITATOR_PRIVATE_KEY must be a 32-byte hex key");
  }
  const chain = defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(XLAYER.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(XLAYER.rpcUrl) });
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: publicClient.readContract.bind(publicClient),
    verifyTypedData: publicClient.verifyTypedData.bind(publicClient),
    writeContract: walletClient.writeContract.bind(walletClient),
    sendTransaction: walletClient.sendTransaction.bind(walletClient),
    waitForTransactionReceipt: publicClient.waitForTransactionReceipt.bind(publicClient),
    getCode: publicClient.getCode.bind(publicClient),
  });
  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, {
    signer,
    networks: XLAYER.network,
    simulateInSettle: true,
  });
  return facilitator;
}

export function createPaymentService({ facilitator, chain } = {}) {
  let resolvedFacilitator = facilitator;
  function getFacilitator() {
    if (!resolvedFacilitator) {
      resolvedFacilitator = createHttpFacilitator() || createLocalFacilitator();
    }
    if (!resolvedFacilitator) {
      throw new PaymentConfigurationError(
        "Configure POLICYPOOL_FACILITATOR_URL or a dedicated POLICYPOOL_FACILITATOR_PRIVATE_KEY",
      );
    }
    return resolvedFacilitator;
  }

  function paymentHeader(req) {
    return header(req, "payment-signature");
  }

  function fingerprint(req) {
    const value = paymentHeader(req);
    return value ? `sha256:${sha256(value)}` : "";
  }

  async function verify(req, requirements) {
    const raw = paymentHeader(req);
    if (!raw) throw new PaymentVerificationError("payment_signature_missing");
    let payload;
    try {
      payload = decodePaymentSignatureHeader(raw);
    } catch {
      throw new PaymentVerificationError("payment_signature_malformed");
    }
    if (payload.x402Version !== 2) throw new PaymentVerificationError("unsupported_x402_version");
    assertAccepted(payload.accepted, requirements);
    let result;
    try {
      result = await getFacilitator().verify(payload, requirements);
    } catch (error) {
      throw new PaymentVerificationError("payment_verifier_unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!result?.isValid || !result.payer) {
      throw new PaymentVerificationError(result?.invalidReason || "payment_invalid", result?.invalidMessage);
    }
    return {
      payload,
      payer: getAddress(result.payer),
      paymentId: `sha256:${sha256(raw)}`,
      verifyResult: result,
    };
  }

  async function settle(verified, requirements) {
    let result;
    try {
      result = await getFacilitator().settle(verified.payload, requirements);
    } catch (error) {
      throw new PaymentVerificationError("payment_settlement_unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!result?.success || !isBytes32(result.transaction)) {
      throw new PaymentVerificationError(result?.errorReason || "payment_settlement_failed", result?.errorMessage);
    }
    if (result.network !== requirements.network) throw new PaymentVerificationError("settlement_network_mismatch");
    const settledAmount = result.amount || requirements.amount;
    if (String(settledAmount) !== String(requirements.amount)) {
      throw new PaymentVerificationError("settlement_amount_mismatch");
    }
    if (!chain?.verifySettlement) throw new PaymentConfigurationError("chain settlement verifier is unavailable");
    const transfer = await chain.verifySettlement({
      txHash: result.transaction,
      payer: verified.payer,
      amountAtomic: requirements.amount,
    });
    return {
      ...result,
      payer: verified.payer,
      amount: requirements.amount,
      transfer,
      responseHeader: encodePaymentResponseHeader(result),
    };
  }

  return { fingerprint, settle, verify };
}

export const __test = { assertAccepted };
