import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402Facilitator } from "@okxweb3/x402-core/facilitator";
import {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@okxweb3/x402-core/http";
import { toFacilitatorEvmSigner } from "@okxweb3/x402-evm";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/facilitator";
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

export class PaymentSettlementUnknownError extends PaymentVerificationError {
  constructor(code, message, transaction = null) {
    super(code, message);
    this.name = "PaymentSettlementUnknownError";
    this.transaction = isBytes32(transaction) ? transaction : null;
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

function createOkxFacilitator(environment = process.env) {
  const names = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];
  const values = names.map((name) => String(environment[name] || ""));
  if (values.every((value) => !value)) return null;
  const missing = names.filter((_, index) => !values[index].trim());
  const padded = names.filter((_, index) => values[index] !== values[index].trim());
  if (missing.length > 0 || padded.length > 0) {
    throw new PaymentConfigurationError("OKX facilitator credentials are incomplete or padded");
  }
  return new OKXFacilitatorClient({
    apiKey: values[0],
    secretKey: values[1],
    passphrase: values[2],
    syncSettle: true,
  });
}

function selfHostedFacilitatorEnabled(environment = process.env) {
  const value = String(environment.POLICYPOOL_SELF_HOSTED_FACILITATOR_ENABLED || "")
    .trim()
    .toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new PaymentConfigurationError(
    "POLICYPOOL_SELF_HOSTED_FACILITATOR_ENABLED must be true or false",
  );
}

function officialFacilitatorRequired(environment = process.env) {
  const value = String(environment.POLICYPOOL_REQUIRE_OKX_FACILITATOR || "")
    .trim()
    .toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new PaymentConfigurationError(
    "POLICYPOOL_REQUIRE_OKX_FACILITATOR must be true or false",
  );
}

function createLocalFacilitator(environment = process.env) {
  const privateKey = environment.POLICYPOOL_FACILITATOR_PRIVATE_KEY;
  if (!privateKey) return null;
  if (!selfHostedFacilitatorEnabled(environment)) {
    throw new PaymentConfigurationError(
      "Set POLICYPOOL_SELF_HOSTED_FACILITATOR_ENABLED=true to select the self-hosted facilitator",
    );
  }
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

export function createPaymentService({ facilitator, chain, environment = process.env } = {}) {
  let resolvedFacilitator = facilitator;
  function getFacilitator() {
    if (!resolvedFacilitator) {
      const okxFacilitator = createOkxFacilitator(environment);
      if (okxFacilitator) {
        resolvedFacilitator = okxFacilitator;
      } else if (officialFacilitatorRequired(environment)) {
        throw new PaymentConfigurationError(
          "Official OKX facilitator credentials are required but not configured",
        );
      } else {
        resolvedFacilitator = createLocalFacilitator(environment);
      }
    }
    if (!resolvedFacilitator) {
      throw new PaymentConfigurationError(
        "Configure OKX facilitator credentials or a dedicated POLICYPOOL_FACILITATOR_PRIVATE_KEY",
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
    const authorizationNonce = verified?.payload?.payload?.authorization?.nonce;
    if (!isBytes32(authorizationNonce)) {
      throw new PaymentVerificationError("payment_settlement_authorization_nonce_missing");
    }
    let result;
    try {
      result = await getFacilitator().settle(verified.payload, requirements);
    } catch (error) {
      throw new PaymentSettlementUnknownError(
        "payment_settlement_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result?.success) {
      // settle() is the submission boundary. A facilitator rejection received
      // after that call is not proof that the authorization was never mined;
      // only the nonce-bound chain scan can establish that safely.
      throw new PaymentSettlementUnknownError(
        result?.errorReason || "payment_settlement_outcome_unknown",
        result?.errorMessage,
        result?.transaction,
      );
    }
    if (!isBytes32(result.transaction)) {
      throw new PaymentSettlementUnknownError(
        "payment_settlement_transaction_unavailable",
        "The facilitator reported success without a transaction hash",
      );
    }
    if (result.network !== requirements.network) {
      throw new PaymentSettlementUnknownError(
        "settlement_network_mismatch",
        "The facilitator settlement network did not match the signed requirement",
        result.transaction,
      );
    }
    const settledAmount = result.amount || requirements.amount;
    if (String(settledAmount) !== String(requirements.amount)) {
      throw new PaymentSettlementUnknownError(
        "settlement_amount_mismatch",
        "The facilitator settlement amount did not match the signed requirement",
        result.transaction,
      );
    }
    if (!chain?.verifySettlement) {
      throw new PaymentSettlementUnknownError(
        "payment_settlement_verifier_unavailable",
        "Chain settlement verifier is unavailable",
        result.transaction,
      );
    }
    let transfer;
    try {
      transfer = await chain.verifySettlement({
        txHash: result.transaction,
        payer: verified.payer,
        amountAtomic: requirements.amount,
        authorizationNonce,
      });
    } catch (error) {
      throw new PaymentSettlementUnknownError(
        "payment_settlement_verification_unavailable",
        error instanceof Error ? error.message : String(error),
        result.transaction,
      );
    }
    return {
      ...result,
      payer: verified.payer,
      amount: requirements.amount,
      transfer,
      responseHeader: encodePaymentResponseHeader(result),
    };
  }

  function settlementRecovery(verified, requirements, error, attemptedAtMs) {
    const authorization = verified?.payload?.payload?.authorization;
    const nonce = authorization?.nonce;
    const attemptedAtSeconds = Math.floor(Number(attemptedAtMs) / 1_000);
    const timeoutSeconds = Number(requirements?.maxTimeoutSeconds);
    let validBeforeSeconds;
    try {
      const validBefore = BigInt(authorization?.validBefore);
      if (validBefore > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("out_of_range");
      validBeforeSeconds = Number(validBefore);
    } catch {
      throw new PaymentVerificationError("payment_settlement_recovery_expiry_invalid");
    }
    if (!isBytes32(nonce)) {
      throw new PaymentVerificationError("payment_settlement_recovery_nonce_missing");
    }
    if (!Number.isSafeInteger(attemptedAtSeconds) || attemptedAtSeconds <= 0) {
      throw new PaymentVerificationError("payment_settlement_recovery_time_invalid");
    }
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 15 * 60) {
      throw new PaymentVerificationError("payment_settlement_recovery_window_invalid");
    }
    if (
      !Number.isSafeInteger(validBeforeSeconds)
      || validBeforeSeconds <= attemptedAtSeconds
      || validBeforeSeconds > attemptedAtSeconds + 15 * 60
    ) {
      throw new PaymentVerificationError("payment_settlement_recovery_expiry_invalid");
    }
    return {
      authorizationNonce: nonce,
      transaction: error instanceof PaymentSettlementUnknownError ? error.transaction : null,
      notBeforeTimestamp: attemptedAtSeconds - 30,
      // A facilitator can submit at any point while the signed authorization is
      // valid. Do not conclude "not found" until that spend window plus the
      // bounded chain-observation margin is complete.
      notAfterTimestamp: validBeforeSeconds + 60,
    };
  }

  function recoveredSettlement(record, requirements, transfer) {
    const response = {
      success: true,
      network: requirements.network,
      transaction: transfer.txHash,
      payer: record.payer,
    };
    return {
      ...response,
      amount: requirements.amount,
      transfer,
      responseHeader: encodePaymentResponseHeader(response),
    };
  }

  async function reconcileSettlement(record, requirements) {
    const recovery = record?.settlement?.recovery;
    if (!recovery || !chain?.findProviderSettlement) {
      throw new PaymentVerificationError("payment_settlement_reconciliation_unavailable");
    }
    if (isBytes32(recovery.transaction)) {
      try {
        const transfer = await chain.verifySettlement({
          txHash: recovery.transaction,
          payer: record.payer,
          amountAtomic: requirements.amount,
          authorizationNonce: recovery.authorizationNonce,
        });
        return { status: "settled", settlement: recoveredSettlement(record, requirements, transfer) };
      } catch {
        // The known transaction may still be propagating. The nonce-indexed scan
        // below is the authoritative bounded recovery path.
      }
    }
    try {
      const transfer = await chain.findProviderSettlement({
        payer: record.payer,
        payTo: requirements.payTo,
        asset: requirements.asset,
        amountAtomic: requirements.amount,
        authorizationNonce: recovery.authorizationNonce,
        notBeforeTimestamp: recovery.notBeforeTimestamp,
        notAfterTimestamp: recovery.notAfterTimestamp,
        requireCompleteWindow: true,
      });
      if (!transfer) return { status: "not_found" };
      return { status: "settled", settlement: recoveredSettlement(record, requirements, transfer) };
    } catch (error) {
      if (error?.code === "provider_settlement_search_window_incomplete") {
        return { status: "pending" };
      }
      throw new PaymentVerificationError(
        "payment_settlement_reconciliation_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { fingerprint, reconcileSettlement, settle, settlementRecovery, verify };
}

export const __test = {
  assertAccepted,
  createLocalFacilitator,
  createOkxFacilitator,
  officialFacilitatorRequired,
  selfHostedFacilitatorEnabled,
};
