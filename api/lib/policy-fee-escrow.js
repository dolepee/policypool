import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XLAYER } from "./config.js";
import { createEvidenceAttestationClient, EvidenceAttestationError } from "./evidence-attestation.js";
import { universalConfiguration } from "./universal-config.js";
import { isBytes32 } from "./utils.js";

const FUND_TUPLE = "(address buyer,bytes32 policyId,bytes32 jobId,bytes32 providerAuthorizationHash,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint256 providerAuthorizationValidBefore)";
const CAPTURE_TUPLE = "(bytes32 feeId,bytes32 covenantId,bytes32 providerAuthorizationHash,bytes32 relayReceiptDigest,bytes32 providerSettlementTransaction,uint64 observedAt)";
const ESCROW_ABI = parseAbi([
  "function feeAmountAtomic() view returns (uint128)",
  "function treasury() view returns (address)",
  `function authorizationNonce(bytes32 policyId,bytes32 jobId,address buyer,bytes32 providerAuthorizationHash,uint256 validAfter,uint256 validBefore,uint256 providerAuthorizationValidBefore) pure returns (bytes32)`,
  "function authorizationId(address buyer,uint256 validAfter,uint256 validBefore,bytes32 nonce) view returns (bytes32)",
  `function fund(${FUND_TUPLE} authorization,bytes signature) returns (bytes32 feeId)`,
  `function capture(${CAPTURE_TUPLE} evidence,bytes[] signatures)`,
  `function captureEvidenceDigest(${CAPTURE_TUPLE} evidence) view returns (bytes32)`,
  "function getFee(bytes32 feeId) view returns ((address buyer,bytes32 covenantId,bytes32 providerAuthorizationHash,uint128 amountAtomic,uint64 fundedAt,uint64 authorizationValidBefore,uint64 refundAvailableAt,uint8 state))",
  "function refund(bytes32 feeId)",
]);

export class PolicyFeeEscrowError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = "PolicyFeeEscrowError";
    this.code = code;
    this.status = status;
  }
}

function relayerAccount() {
  const key = String(process.env.POLICYPOOL_RELAYER_PRIVATE_KEY || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new PolicyFeeEscrowError("coverage_relayer_signer_not_configured");
  return privateKeyToAccount(key);
}

function clients(account) {
  const chain = defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
  });
  return {
    publicClient: createPublicClient({ chain, transport: http(XLAYER.rpcUrl) }),
    walletClient: createWalletClient({ account, chain, transport: http(XLAYER.rpcUrl) }),
  };
}

export function createPolicyFeeEscrowClient({
  configuration = universalConfiguration(),
  account,
  evidenceProvider,
  publicClient,
  walletClient,
  now = () => Date.now(),
} = {}) {
  if (!configuration.ready || !configuration.feeEscrow || !configuration.evidenceVerifier) {
    throw new PolicyFeeEscrowError("policy_fee_escrow_not_configured");
  }
  account ||= relayerAccount();
  if (!publicClient || !walletClient) {
    const defaults = clients(account);
    publicClient ||= defaults.publicClient;
    walletClient ||= defaults.walletClient;
  }
  evidenceProvider ||= createEvidenceAttestationClient({
    url: configuration.evidenceAttestationUrl,
    token: process.env.POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN,
    threshold: configuration.evidenceThreshold,
  });

  async function read(functionName, args = []) {
    try {
      return await publicClient.readContract({
        address: configuration.feeEscrow,
        abi: ESCROW_ABI,
        functionName,
        args,
      });
    } catch (error) {
      throw new PolicyFeeEscrowError(
        `policy_fee_escrow_${functionName}_read_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function write(functionName, args) {
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: configuration.feeEscrow,
        abi: ESCROW_ABI,
        functionName,
        args,
      });
      const transactionHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
        timeout: 30_000,
      });
      if (receipt.status !== "success") throw new Error("transaction reverted");
      return { transactionHash, blockNumber: receipt.blockNumber.toString() };
    } catch (error) {
      throw new PolicyFeeEscrowError(
        `policy_fee_escrow_${functionName}_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function terms() {
    const [amountAtomic, treasury] = await Promise.all([
      read("feeAmountAtomic"),
      read("treasury"),
    ]);
    return { amountAtomic: BigInt(amountAtomic), treasury: getAddress(treasury) };
  }

  async function previewAuthorization({
    policyId,
    jobId,
    buyer,
    providerAuthorizationHash,
    validAfter,
    validBefore,
    providerAuthorizationValidBefore,
  }) {
    if (![policyId, jobId, providerAuthorizationHash].every(isBytes32)) {
      throw new PolicyFeeEscrowError("policy_fee_authorization_binding_invalid", 422);
    }
    let payer;
    try {
      payer = getAddress(buyer);
    } catch {
      throw new PolicyFeeEscrowError("policy_fee_buyer_invalid", 422);
    }
    const nonce = await read("authorizationNonce", [
      policyId,
      jobId,
      payer,
      providerAuthorizationHash,
      BigInt(validAfter),
      BigInt(validBefore),
      BigInt(providerAuthorizationValidBefore),
    ]);
    const feeId = await read("authorizationId", [payer, BigInt(validAfter), BigInt(validBefore), nonce]);
    return { feeId, nonce, buyer: payer };
  }

  async function fund(authorization, signature) {
    if (!/^0x[a-fA-F0-9]+$/.test(String(signature || ""))) {
      throw new PolicyFeeEscrowError("policy_fee_signature_invalid", 422);
    }
    return write("fund", [{
      ...authorization,
      buyer: getAddress(authorization.buyer),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      providerAuthorizationValidBefore: BigInt(authorization.providerAuthorizationValidBefore),
    }, signature]);
  }

  async function getFee(feeId) {
    if (!isBytes32(feeId)) throw new PolicyFeeEscrowError("policy_fee_id_invalid", 422);
    const value = await read("getFee", [feeId]);
    return {
      buyer: value.buyer,
      covenantId: value.covenantId,
      providerAuthorizationHash: value.providerAuthorizationHash,
      amountAtomic: value.amountAtomic.toString(),
      fundedAt: Number(value.fundedAt),
      authorizationValidBefore: Number(value.authorizationValidBefore),
      refundAvailableAt: Number(value.refundAvailableAt),
      state: Number(value.state),
    };
  }

  async function capture(evidence, context = {}) {
    if (
      ![
        evidence?.feeId,
        evidence?.covenantId,
        evidence?.providerAuthorizationHash,
        evidence?.relayReceiptDigest,
        evidence?.providerSettlementTransaction,
      ].every(isBytes32)
    ) throw new PolicyFeeEscrowError("policy_fee_capture_evidence_invalid", 422);
    const normalized = { ...evidence, observedAt: BigInt(evidence.observedAt || Math.floor(now() / 1_000)) };
    const digest = await read("captureEvidenceDigest", [normalized]);
    let signatures;
    try {
      signatures = await evidenceProvider.attest({
        action: "capture_fee",
        digest,
        evidence: normalized,
        context,
        domain: {
          chainId: XLAYER.id,
          manager: configuration.feeEscrow,
          verifier: configuration.evidenceVerifier,
        },
      });
    } catch (error) {
      if (error instanceof EvidenceAttestationError) {
        throw new PolicyFeeEscrowError(error.code, error.status);
      }
      throw error;
    }
    return write("capture", [normalized, signatures]);
  }

  async function refund(feeId) {
    if (!isBytes32(feeId)) throw new PolicyFeeEscrowError("policy_fee_id_invalid", 422);
    return write("refund", [feeId]);
  }

  return { capture, fund, getFee, previewAuthorization, refund, terms };
}

export const __test = { ESCROW_ABI };
