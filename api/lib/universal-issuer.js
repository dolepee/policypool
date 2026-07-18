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
import { createEvidenceAttestationClient, EvidenceAttestationError } from "./evidence-attestation.js";
import { universalConfiguration } from "./universal-config.js";
import { isBytes32 } from "./utils.js";

const ISSUE_TUPLE = "(bytes32 policyId,bytes32 observedFingerprint,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 verifiedAcceptanceAt,uint64 enrollmentExpiresAt,bytes32 acceptanceEvidenceHash,(bytes32 authorizationHash,uint64 validBefore) feeAuthorization)";
const CLOCK_TUPLE = "(bytes32 covenantId,uint64 startedAt,bytes32 evidenceHash)";
const OBSERVATION_TUPLE = "(bytes32 covenantId,uint64 observedAt,bytes32 evidenceHash)";
const RELEASE_TUPLE = "(bytes32 covenantId,uint64 completedAt,uint64 observedAt,bytes32 evidenceHash)";
const SETTLEMENT_TUPLE = "(bytes32 covenantId,uint128 escrowRefundAtomic,uint128 otherRecoveryAtomic,uint64 observedAt,bool recoveryFinalized,bytes32 recoveryEvidenceHash)";
const CANCEL_UNPAID_TUPLE = "(bytes32 covenantId,uint64 observedAt,bytes32 feeAuthorizationHash,bytes32 nonSettlementEvidenceHash)";

const MANAGER_ABI = parseAbi([
  "function getCovenant(bytes32 covenantId) view returns ((bytes32 id,bytes32 policyId,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 issuedAt,uint64 startAt,uint64 deadline,uint64 enrollmentExpiresAt,uint64 payoutDueAt,uint64 completedAt,uint64 recoveryObservedAt,uint32 slaSeconds,uint8 payoutBasis,uint8 clockMode,uint8 state,uint128 payoutAtomic,bytes32 acceptanceEvidenceHash,bytes32 breachEvidenceHash,bytes32 recoveryEvidenceHash,bytes32 feeAuthorizationHash,uint64 feeAuthorizationValidBefore,bool recoveryFinalized))",
  `function issue(${ISSUE_TUPLE} evidence, bytes[] signatures) returns (bytes32)`,
  `function issueEvidenceDigest(${ISSUE_TUPLE} evidence) view returns (bytes32)`,
  `function release(${RELEASE_TUPLE} evidence, bytes[] signatures)`,
  `function releaseEvidenceDigest(${RELEASE_TUPLE} evidence) view returns (bytes32)`,
  `function startClock(${CLOCK_TUPLE} evidence, bytes[] signatures)`,
  `function clockEvidenceDigest(${CLOCK_TUPLE} evidence) view returns (bytes32)`,
  "function expireUnstarted(bytes32 covenantId)",
  `function markPayoutDue(${OBSERVATION_TUPLE} evidence, bytes[] signatures)`,
  `function breachEvidenceDigest(${OBSERVATION_TUPLE} evidence) view returns (bytes32)`,
  `function settleNetLoss(${SETTLEMENT_TUPLE} evidence, bytes[] signatures) returns (uint256)`,
  `function settlementEvidenceDigest(${SETTLEMENT_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyRelease(${RELEASE_TUPLE} evidence, bytes[] signatures)`,
  `function emergencyReleaseEvidenceDigest(${RELEASE_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyMarkPayoutDue(${OBSERVATION_TUPLE} evidence, bytes[] signatures)`,
  `function emergencyBreachEvidenceDigest(${OBSERVATION_TUPLE} evidence) view returns (bytes32)`,
  `function emergencySettleNetLoss(${SETTLEMENT_TUPLE} evidence, bytes[] signatures) returns (uint256)`,
  `function emergencySettlementEvidenceDigest(${SETTLEMENT_TUPLE} evidence) view returns (bytes32)`,
  `function cancelUnpaid(${CANCEL_UNPAID_TUPLE} evidence, bytes[] signatures)`,
  `function cancelUnpaidEvidenceDigest(${CANCEL_UNPAID_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyCancelUnpaid(${CANCEL_UNPAID_TUPLE} evidence, bytes[] signatures)`,
  `function emergencyCancelUnpaidEvidenceDigest(${CANCEL_UNPAID_TUPLE} evidence) view returns (bytes32)`,
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

function relayerAccount() {
  const key = String(process.env.POLICYPOOL_RELAYER_PRIVATE_KEY || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new UniversalIssuerError("coverage_relayer_signer_not_configured");
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

function acceptanceEvidenceHash(targetOrder) {
  if (isBytes32(targetOrder?.acceptanceEvidenceHash)) return targetOrder.acceptanceEvidenceHash;
  if (!isBytes32(targetOrder?.jobId) || !isBytes32(targetOrder?.creationTxHash) || !isBytes32(targetOrder?.acceptanceTxHash)) {
    throw new UniversalIssuerError("target_acceptance_evidence_invalid", 422);
  }
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [targetOrder.jobId, targetOrder.creationTxHash, targetOrder.acceptanceTxHash],
  ));
}

export function createUniversalIssuer({
  configuration = universalConfiguration(),
  account,
  evidenceProvider,
  recoveryEvidenceProvider,
  publicClient,
  walletClient,
  now = () => Date.now(),
} = {}) {
  if (
    !configuration.ready
    || !configuration.coverageManager
    || !configuration.evidenceVerifier
    || !configuration.recoveryEvidenceVerifier
  ) {
    throw new UniversalIssuerError("universal_issuance_not_configured");
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
  recoveryEvidenceProvider ||= createEvidenceAttestationClient({
    url: configuration.recoveryEvidenceAttestationUrl,
    token: process.env.POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN,
    threshold: configuration.recoveryEvidenceThreshold,
  });

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

  async function signatures({ action, digestFunctionName, evidence, context, recovery = false }) {
    let digest;
    try {
      digest = await publicClient.readContract({
        address: configuration.coverageManager,
        abi: MANAGER_ABI,
        functionName: digestFunctionName,
        args: [evidence],
      });
      const provider = recovery ? recoveryEvidenceProvider : evidenceProvider;
      return await provider.attest({
        action,
        digest,
        evidence,
        context,
        domain: {
          chainId: XLAYER.id,
          manager: configuration.coverageManager,
          verifier: recovery ? configuration.recoveryEvidenceVerifier : configuration.evidenceVerifier,
        },
      });
    } catch (error) {
      if (error instanceof EvidenceAttestationError) throw new UniversalIssuerError(error.code, error.status);
      throw new UniversalIssuerError(
        `coverage_evidence_${action}_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function attestedWrite({ functionName, digestFunctionName, action, evidence, context, recovery = false }) {
    const approved = await signatures({ action, digestFunctionName, evidence, context, recovery });
    return write(functionName, [evidence, approved]);
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
        payoutDueAt: Number(value.payoutDueAt),
        completedAt: Number(value.completedAt),
        recoveryObservedAt: Number(value.recoveryObservedAt),
        slaSeconds: Number(value.slaSeconds),
        payoutBasis: Number(value.payoutBasis),
        clockMode: Number(value.clockMode),
        state: Number(value.state),
        payoutAtomic: value.payoutAtomic.toString(),
        acceptanceEvidenceHash: value.acceptanceEvidenceHash,
        breachEvidenceHash: value.breachEvidenceHash,
        recoveryEvidenceHash: value.recoveryEvidenceHash,
        feeAuthorizationHash: value.feeAuthorizationHash,
        feeAuthorizationValidBefore: Number(value.feeAuthorizationValidBefore),
        recoveryFinalized: Boolean(value.recoveryFinalized),
      };
    } catch (error) {
      throw new UniversalIssuerError(
        `coverage_manager_read_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function issue({
    policy,
    targetOrder,
    coverageCapAtomic,
    enrollmentClosesAt,
    paymentAuthorization,
    attestationContext = {},
  }) {
    if (!isBytes32(paymentAuthorization?.hash)) {
      throw new UniversalIssuerError("fee_authorization_hash_invalid", 422);
    }
    const evidence = {
      policyId: policyId(policy?.onchainPolicyId),
      observedFingerprint: policy.serviceFingerprint,
      jobId: targetOrder.jobId,
      provider: policy.providerWallet,
      buyer: targetOrder.buyer,
      coverageCapAtomic: BigInt(coverageCapAtomic),
      buyerPaidAtomic: BigInt(targetOrder.amountAtomic),
      verifiedAcceptanceAt: BigInt(seconds(targetOrder.acceptedAt, "target_acceptance_time")),
      enrollmentExpiresAt: BigInt(seconds(enrollmentClosesAt, "coverage_enrollment_close")),
      acceptanceEvidenceHash: acceptanceEvidenceHash(targetOrder),
      feeAuthorization: {
        authorizationHash: paymentAuthorization.hash,
        validBefore: BigInt(paymentAuthorization.validBefore),
      },
    };
    const id = previewCovenantId({ policy, targetOrder, paymentAuthorization });
    return {
      covenantId: id,
      ...(await attestedWrite({
        functionName: "issue",
        digestFunctionName: "issueEvidenceDigest",
        action: "issue",
        evidence,
        context: {
          ...(attestationContext && typeof attestationContext === "object" ? attestationContext : {}),
          policy,
          targetOrder,
          paymentAuthorization,
        },
      })),
    };
  }

  function previewCovenantId({ policy, targetOrder, paymentAuthorization }) {
    const onchainPolicyId = policyId(policy?.onchainPolicyId);
    if (!isBytes32(paymentAuthorization?.hash)) {
      throw new UniversalIssuerError("fee_authorization_hash_invalid", 422);
    }
    return keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [onchainPolicyId, targetOrder.jobId, targetOrder.buyer, paymentAuthorization.hash],
    ));
  }

  async function release(covenantId, completedAt, evidenceHash, context = {}) {
    if (!isBytes32(covenantId) || !isBytes32(evidenceHash)) {
      throw new UniversalIssuerError("release_evidence_invalid", 422);
    }
    const evidence = {
      covenantId,
      completedAt: BigInt(seconds(completedAt, "release_completion_time")),
      observedAt: BigInt(Math.floor(now() / 1_000)),
      evidenceHash,
    };
    return attestedWrite({
      functionName: "release",
      digestFunctionName: "releaseEvidenceDigest",
      action: "release",
      evidence,
      context,
    });
  }

  async function emergencyRelease(covenantId, completedAt, evidenceHash, context = {}) {
    if (!isBytes32(covenantId) || !isBytes32(evidenceHash)) {
      throw new UniversalIssuerError("release_evidence_invalid", 422);
    }
    const evidence = {
      covenantId,
      completedAt: BigInt(seconds(completedAt, "release_completion_time")),
      observedAt: BigInt(Math.floor(now() / 1_000)),
      evidenceHash,
    };
    return attestedWrite({
      functionName: "emergencyRelease",
      digestFunctionName: "emergencyReleaseEvidenceDigest",
      action: "release",
      evidence,
      context,
      recovery: true,
    });
  }

  async function startClock(covenantId, startedAt, evidenceHash, context = {}) {
    const evidence = {
      covenantId,
      startedAt: BigInt(seconds(startedAt, "relay_clock_start")),
      evidenceHash,
    };
    return attestedWrite({
      functionName: "startClock",
      digestFunctionName: "clockEvidenceDigest",
      action: "start_clock",
      evidence,
      context,
    });
  }

  async function expireUnstarted(covenantId) {
    if (!isBytes32(covenantId)) throw new UniversalIssuerError("covenant_id_invalid", 422);
    return write("expireUnstarted", [covenantId]);
  }

  async function markPayoutDue(covenantId, breachEvidenceHash, context = {}) {
    const evidence = {
      covenantId,
      observedAt: BigInt(Math.floor(now() / 1_000)),
      evidenceHash: breachEvidenceHash,
    };
    return attestedWrite({
      functionName: "markPayoutDue",
      digestFunctionName: "breachEvidenceDigest",
      action: "breach",
      evidence,
      context,
    });
  }

  async function emergencyMarkPayoutDue(covenantId, breachEvidenceHash, context = {}) {
    const evidence = {
      covenantId,
      observedAt: BigInt(Math.floor(now() / 1_000)),
      evidenceHash: breachEvidenceHash,
    };
    return attestedWrite({
      functionName: "emergencyMarkPayoutDue",
      digestFunctionName: "emergencyBreachEvidenceDigest",
      action: "breach",
      evidence,
      context,
      recovery: true,
    });
  }

  async function settleNetLoss(
    covenantId,
    escrowRefundAtomic,
    otherRecoveryAtomic,
    recoveryFinalized,
    recoveryEvidenceHash,
    context = {},
  ) {
    if (recoveryFinalized !== true) throw new UniversalIssuerError("recovery_not_final", 422);
    const evidence = {
      covenantId,
      escrowRefundAtomic: BigInt(escrowRefundAtomic),
      otherRecoveryAtomic: BigInt(otherRecoveryAtomic),
      observedAt: BigInt(Math.floor(now() / 1_000)),
      recoveryFinalized: true,
      recoveryEvidenceHash,
    };
    return attestedWrite({
      functionName: "settleNetLoss",
      digestFunctionName: "settlementEvidenceDigest",
      action: "settlement",
      evidence,
      context,
    });
  }

  async function emergencySettleNetLoss(
    covenantId,
    escrowRefundAtomic,
    otherRecoveryAtomic,
    recoveryFinalized,
    recoveryEvidenceHash,
    context = {},
  ) {
    if (recoveryFinalized !== true) throw new UniversalIssuerError("recovery_not_final", 422);
    const evidence = {
      covenantId,
      escrowRefundAtomic: BigInt(escrowRefundAtomic),
      otherRecoveryAtomic: BigInt(otherRecoveryAtomic),
      observedAt: BigInt(Math.floor(now() / 1_000)),
      recoveryFinalized: true,
      recoveryEvidenceHash,
    };
    return attestedWrite({
      functionName: "emergencySettleNetLoss",
      digestFunctionName: "emergencySettlementEvidenceDigest",
      action: "settlement",
      evidence,
      context,
      recovery: true,
    });
  }

  async function cancelUnpaid(covenantId, feeAuthorizationHash, nonSettlementEvidenceHash, context = {}) {
    if (![covenantId, feeAuthorizationHash, nonSettlementEvidenceHash].every(isBytes32)) {
      throw new UniversalIssuerError("unpaid_cancellation_evidence_invalid", 422);
    }
    const evidence = {
      covenantId,
      observedAt: BigInt(Math.floor(now() / 1_000)),
      feeAuthorizationHash,
      nonSettlementEvidenceHash,
    };
    return attestedWrite({
      functionName: "cancelUnpaid",
      digestFunctionName: "cancelUnpaidEvidenceDigest",
      action: "cancel_unpaid",
      evidence,
      context,
    });
  }

  async function emergencyCancelUnpaid(covenantId, feeAuthorizationHash, nonSettlementEvidenceHash, context = {}) {
    if (![covenantId, feeAuthorizationHash, nonSettlementEvidenceHash].every(isBytes32)) {
      throw new UniversalIssuerError("unpaid_cancellation_evidence_invalid", 422);
    }
    const evidence = {
      covenantId,
      observedAt: BigInt(Math.floor(now() / 1_000)),
      feeAuthorizationHash,
      nonSettlementEvidenceHash,
    };
    return attestedWrite({
      functionName: "emergencyCancelUnpaid",
      digestFunctionName: "emergencyCancelUnpaidEvidenceDigest",
      action: "cancel_unpaid",
      evidence,
      context,
      recovery: true,
    });
  }

  return {
    issue,
    previewCovenantId,
    getCovenant,
    release,
    emergencyRelease,
    startClock,
    expireUnstarted,
    markPayoutDue,
    emergencyMarkPayoutDue,
    settleNetLoss,
    emergencySettleNetLoss,
    cancelUnpaid,
    emergencyCancelUnpaid,
    relayer: account.address,
  };
}
