import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XLAYER } from "./config.js";
import { universalConfiguration } from "./universal-config.js";
import { isBytes32 } from "./utils.js";

const MANAGER_ABI = parseAbi([
  "function getCovenant(bytes32 covenantId) view returns ((bytes32 id,bytes32 policyId,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 issuedAt,uint64 startAt,uint64 deadline,uint64 enrollmentExpiresAt,uint32 slaSeconds,uint8 payoutBasis,uint8 clockMode,uint8 state,uint128 payoutAtomic,bytes32 recoveryEvidenceHash))",
  "function issue(bytes32 policyId, bytes32 observedFingerprint, bytes32 jobId, address provider, address buyer, uint128 coverageCapAtomic, uint128 buyerPaidAtomic, uint64 verifiedAcceptanceAt, uint64 enrollmentExpiresAt) returns (bytes32)",
  "function release(bytes32 covenantId, bytes32 reason)",
  "function startClock(bytes32 covenantId, uint64 startedAt, bytes32 evidenceHash)",
  "function expireUnstarted(bytes32 covenantId)",
  "function markPayoutDue(bytes32 covenantId, bytes32 breachEvidenceHash)",
  "function settleNetLoss(bytes32 covenantId, uint128 escrowRefundAtomic, uint128 otherRecoveryAtomic, bytes32 recoveryEvidenceHash) returns (uint256)",
]);

export class UniversalIssuerError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = "UniversalIssuerError";
    this.code = code;
    this.status = status;
  }
}

function seconds(value, field) {
  const parsed = Math.floor(Date.parse(String(value || "")) / 1000);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UniversalIssuerError(`${field}_invalid`, 422);
  return parsed;
}

function policyId(value) {
  const parsed = String(value || "").replace(/^onchain:/, "");
  if (!isBytes32(parsed)) throw new UniversalIssuerError("onchain_policy_id_invalid", 422);
  return parsed;
}

function operatorAccount() {
  const key = String(process.env.POLICYPOOL_MANAGER_PRIVATE_KEY || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new UniversalIssuerError("coverage_manager_signer_not_configured");
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

export function createUniversalIssuer({
  configuration = universalConfiguration(),
  account = operatorAccount(),
  publicClient,
  walletClient,
} = {}) {
  if (!configuration.ready || !configuration.coverageManager) {
    throw new UniversalIssuerError("universal_issuance_not_configured");
  }
  if (!publicClient || !walletClient) {
    const defaults = clients(account);
    publicClient ||= defaults.publicClient;
    walletClient ||= defaults.walletClient;
  }

  async function write(functionName, args) {
    let request;
    try {
      ({ request } = await publicClient.simulateContract({
        account,
        address: configuration.coverageManager,
        abi: MANAGER_ABI,
        functionName,
        args,
      }));
      const transactionHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
        timeout: 30_000,
      });
      if (receipt.status !== "success") throw new Error("transaction reverted");
      return { transactionHash, blockNumber: receipt.blockNumber.toString() };
    } catch (error) {
      throw new UniversalIssuerError(
        `coverage_manager_${functionName}_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function getCovenant(covenantId) {
    if (!isBytes32(covenantId)) throw new UniversalIssuerError("covenant_id_invalid", 422);
    try {
      const value = await publicClient.readContract({
        address: configuration.coverageManager,
        abi: MANAGER_ABI,
        functionName: "getCovenant",
        args: [covenantId],
      });
      return {
        id: value.id,
        policyId: value.policyId,
        jobId: value.jobId,
        provider: value.provider,
        buyer: value.buyer,
        coverageCapAtomic: value.coverageCapAtomic.toString(),
        buyerPaidAtomic: value.buyerPaidAtomic.toString(),
        issuedAt: Number(value.issuedAt),
        startAt: Number(value.startAt),
        deadline: Number(value.deadline),
        enrollmentExpiresAt: Number(value.enrollmentExpiresAt),
        slaSeconds: Number(value.slaSeconds),
        payoutBasis: Number(value.payoutBasis),
        clockMode: Number(value.clockMode),
        state: Number(value.state),
        payoutAtomic: value.payoutAtomic.toString(),
        recoveryEvidenceHash: value.recoveryEvidenceHash,
      };
    } catch (error) {
      throw new UniversalIssuerError(
        `coverage_manager_read_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function issue({ policy, targetOrder, coverageCapAtomic, enrollmentClosesAt }) {
    const onchainPolicyId = policyId(policy?.onchainPolicyId);
    const args = [
      onchainPolicyId,
      policy.serviceFingerprint,
      targetOrder.jobId,
      policy.providerWallet,
      targetOrder.buyer,
      BigInt(coverageCapAtomic),
      BigInt(targetOrder.amountAtomic),
      BigInt(seconds(targetOrder.acceptedAt, "target_acceptance_time")),
      BigInt(seconds(enrollmentClosesAt, "coverage_enrollment_close")),
    ];
    const id = previewCovenantId({ policy, targetOrder });
    return { covenantId: id, ...(await write("issue", args)) };
  }

  function previewCovenantId({ policy, targetOrder }) {
    const onchainPolicyId = policyId(policy?.onchainPolicyId);
    return keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [onchainPolicyId, targetOrder.jobId, targetOrder.buyer],
    ));
  }

  async function release(covenantId, reason) {
    if (!isBytes32(covenantId) || !isBytes32(reason)) throw new UniversalIssuerError("release_evidence_invalid", 422);
    return write("release", [covenantId, reason]);
  }

  async function startClock(covenantId, startedAt, evidenceHash) {
    return write("startClock", [
      covenantId,
      BigInt(seconds(startedAt, "relay_clock_start")),
      evidenceHash,
    ]);
  }

  async function expireUnstarted(covenantId) {
    if (!isBytes32(covenantId)) throw new UniversalIssuerError("covenant_id_invalid", 422);
    return write("expireUnstarted", [covenantId]);
  }

  async function markPayoutDue(covenantId, breachEvidenceHash) {
    return write("markPayoutDue", [covenantId, breachEvidenceHash]);
  }

  async function settleNetLoss(covenantId, escrowRefundAtomic, otherRecoveryAtomic, recoveryEvidenceHash) {
    return write("settleNetLoss", [
      covenantId,
      BigInt(escrowRefundAtomic),
      BigInt(otherRecoveryAtomic),
      recoveryEvidenceHash,
    ]);
  }

  return {
    issue,
    previewCovenantId,
    getCovenant,
    release,
    startClock,
    expireUnstarted,
    markPayoutDue,
    settleNetLoss,
    operator: account.address,
  };
}
