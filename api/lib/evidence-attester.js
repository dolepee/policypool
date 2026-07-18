import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createChainService } from "./chain.js";
import { PAYMENT, XLAYER } from "./config.js";
import {
  directAcceptanceEvidenceHash,
  directJobId,
  verifyFeePayment,
} from "./direct-a2mcp.js";
import {
  providerPaymentAuthorization,
  verifyProviderRelayReceipt,
} from "./provider-relay.js";
import { isBytes32, sha256, stableStringify } from "./utils.js";

const ISSUE_TUPLE = "(bytes32 policyId,bytes32 observedFingerprint,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 verifiedAcceptanceAt,uint64 enrollmentExpiresAt,bytes32 acceptanceEvidenceHash,(bytes32 authorizationHash,uint64 validBefore) feeAuthorization)";
const CLOCK_TUPLE = "(bytes32 covenantId,uint64 startedAt,bytes32 evidenceHash)";
const OBSERVATION_TUPLE = "(bytes32 covenantId,uint64 observedAt,bytes32 evidenceHash)";
const RELEASE_TUPLE = "(bytes32 covenantId,uint64 completedAt,uint64 observedAt,bytes32 evidenceHash)";
const SETTLEMENT_TUPLE = "(bytes32 covenantId,uint128 escrowRefundAtomic,uint128 otherRecoveryAtomic,uint64 observedAt,bool recoveryFinalized,bytes32 recoveryEvidenceHash)";
const CANCEL_UNPAID_TUPLE = "(bytes32 covenantId,uint64 observedAt,bytes32 feeAuthorizationHash,bytes32 nonSettlementEvidenceHash)";
const CAPTURE_TUPLE = "(bytes32 feeId,bytes32 covenantId,bytes32 providerAuthorizationHash,bytes32 relayReceiptDigest,bytes32 providerSettlementTransaction,uint64 observedAt)";

const MANAGER_ABI = parseAbi([
  "function evidenceVerifier() view returns (address)",
  "function recoveryEvidenceVerifier() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function bondVault() view returns (address)",
  "function getCovenant(bytes32 covenantId) view returns ((bytes32 id,bytes32 policyId,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 issuedAt,uint64 startAt,uint64 deadline,uint64 enrollmentExpiresAt,uint64 payoutDueAt,uint64 completedAt,uint64 recoveryObservedAt,uint32 slaSeconds,uint8 payoutBasis,uint8 clockMode,uint8 state,uint128 payoutAtomic,bytes32 acceptanceEvidenceHash,bytes32 breachEvidenceHash,bytes32 recoveryEvidenceHash,bytes32 feeAuthorizationHash,uint64 feeAuthorizationValidBefore,bool recoveryFinalized))",
  `function issueEvidenceDigest(${ISSUE_TUPLE} evidence) view returns (bytes32)`,
  `function clockEvidenceDigest(${CLOCK_TUPLE} evidence) view returns (bytes32)`,
  `function releaseEvidenceDigest(${RELEASE_TUPLE} evidence) view returns (bytes32)`,
  `function breachEvidenceDigest(${OBSERVATION_TUPLE} evidence) view returns (bytes32)`,
  `function settlementEvidenceDigest(${SETTLEMENT_TUPLE} evidence) view returns (bytes32)`,
  `function cancelUnpaidEvidenceDigest(${CANCEL_UNPAID_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyReleaseEvidenceDigest(${RELEASE_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyBreachEvidenceDigest(${OBSERVATION_TUPLE} evidence) view returns (bytes32)`,
  `function emergencySettlementEvidenceDigest(${SETTLEMENT_TUPLE} evidence) view returns (bytes32)`,
  `function emergencyCancelUnpaidEvidenceDigest(${CANCEL_UNPAID_TUPLE} evidence) view returns (bytes32)`,
]);
const REGISTRY_ABI = parseAbi([
  "function getPolicy(bytes32 policyId) view returns ((bytes32 id,bytes32 serviceKey,address provider,(bytes32 marketplace,uint256 agentId,uint256 serviceId,bytes32 serviceFingerprint,bytes32 scopeHash,uint32 slaSeconds,uint32 enrollmentWindowSeconds,uint128 maxCapAtomic,uint16 premiumBps,uint8 payoutBasis,uint8 clockMode,uint64 expiresAt,address adapter) terms,uint32 version,uint64 registeredAt,bool active,bytes32 suspensionReason))",
  "function isCoverable(bytes32 policyId,bytes32 observedFingerprint) view returns (bool)",
]);
const VAULT_ABI = parseAbi(["function availableBond(address provider) view returns (uint256)"]);
const PAYMENT_ASSET_ABI = parseAbi([
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
]);
const VERIFIER_ABI = parseAbi([
  "function threshold() view returns (uint8)",
  "function signerCount() view returns (uint256)",
  "function signerAt(uint256 index) view returns (address)",
]);
const ESCROW_ABI = parseAbi([
  "function feeAmountAtomic() view returns (uint128)",
  "function getFee(bytes32 feeId) view returns ((address buyer,bytes32 covenantId,bytes32 providerAuthorizationHash,uint128 amountAtomic,uint64 fundedAt,uint64 authorizationValidBefore,uint64 refundAvailableAt,uint8 state))",
  "function authorizationNonce(bytes32 policyId,bytes32 jobId,address buyer,bytes32 providerAuthorizationHash,uint256 validAfter,uint256 validBefore,uint256 providerAuthorizationValidBefore) pure returns (bytes32)",
  "function authorizationId(address buyer,uint256 validAfter,uint256 validBefore,bytes32 nonce) view returns (bytes32)",
  `function captureEvidenceDigest(${CAPTURE_TUPLE} evidence) view returns (bytes32)`,
]);

const PRIMARY_DIGESTS = {
  issue: "issueEvidenceDigest",
  start_clock: "clockEvidenceDigest",
  release: "releaseEvidenceDigest",
  breach: "breachEvidenceDigest",
  settlement: "settlementEvidenceDigest",
  cancel_unpaid: "cancelUnpaidEvidenceDigest",
  capture_fee: "captureEvidenceDigest",
};
const RECOVERY_DIGESTS = {
  release: "emergencyReleaseEvidenceDigest",
  breach: "emergencyBreachEvidenceDigest",
  settlement: "emergencySettlementEvidenceDigest",
  cancel_unpaid: "emergencyCancelUnpaidEvidenceDigest",
};
const COVENANT = { pendingStart: 1, active: 2, released: 3, payoutDue: 4, paid: 5, recovered: 6, cancelled: 7 };
const FEE = { none: 0, funded: 1, captured: 2, refunded: 3 };

export class EvidenceAttesterError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "EvidenceAttesterError";
    this.code = code;
    this.status = status;
  }
}

function requiredAddress(value, field) {
  const raw = String(value || "").trim();
  if (!isAddress(raw)) throw new EvidenceAttesterError(`${field}_invalid`, 503);
  return getAddress(raw);
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function sameBytes32(left, right) {
  return isBytes32(left) && String(left).toLowerCase() === String(right).toLowerCase();
}

function sameSha256Id(left, right) {
  const pattern = /^sha256:[a-f0-9]{64}$/;
  const normalizedLeft = String(left || "").toLowerCase();
  const normalizedRight = String(right || "").toLowerCase();
  return pattern.test(normalizedLeft)
    && pattern.test(normalizedRight)
    && normalizedLeft === normalizedRight;
}

function authorizationIdForHash(value) {
  return isBytes32(value) ? `sha256:${String(value).slice(2).toLowerCase()}` : null;
}

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new EvidenceAttesterError(`${field}_invalid`);
  return parsed;
}

function positiveInteger(value, field) {
  const parsed = integer(value, field);
  if (parsed <= 0) throw new EvidenceAttesterError(`${field}_invalid`);
  return parsed;
}

function isoSeconds(value, field) {
  const parsed = Math.floor(Date.parse(String(value || "")) / 1_000);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new EvidenceAttesterError(`${field}_invalid`);
  return parsed;
}

function contextHash(value) {
  return keccak256(stringToHex(stableStringify(value)));
}

function policyIdValue(value) {
  const normalized = String(value || "").replace(/^onchain:/, "").toLowerCase();
  if (!isBytes32(normalized)) throw new EvidenceAttesterError("policy_id_invalid");
  return normalized;
}

function parsePrivateKeys(value) {
  const keys = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (keys.length !== 5 || keys.some((key) => !/^0x[a-fA-F0-9]{64}$/.test(key))) {
    throw new EvidenceAttesterError("attester_private_keys_invalid", 503);
  }
  const accounts = keys.map((key) => privateKeyToAccount(key));
  if (new Set(accounts.map((account) => account.address.toLowerCase())).size !== accounts.length) {
    throw new EvidenceAttesterError("attester_private_keys_duplicate", 503);
  }
  return accounts;
}

function parsePolicyIds(value) {
  const values = String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (values.length === 0 || values.some((item) => !isBytes32(item))) {
    throw new EvidenceAttesterError("attester_policy_allowlist_invalid", 503);
  }
  return new Set(values);
}

export function evidenceAttesterConfiguration(env = process.env) {
  const role = String(env.POLICYPOOL_ATTESTER_ROLE || "").trim().toLowerCase();
  if (!["primary", "recovery"].includes(role)) {
    throw new EvidenceAttesterError("attester_role_invalid", 503);
  }
  return {
    role,
    manager: requiredAddress(env.POLICYPOOL_COVERAGE_MANAGER_ADDRESS, "attester_manager"),
    registry: requiredAddress(env.POLICYPOOL_POLICY_REGISTRY_ADDRESS, "attester_registry"),
    vault: requiredAddress(env.POLICYPOOL_BOND_VAULT_ADDRESS, "attester_vault"),
    feeEscrow: requiredAddress(env.POLICYPOOL_FEE_ESCROW_ADDRESS, "attester_fee_escrow"),
    verifier: requiredAddress(
      role === "primary"
        ? env.POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS
        : env.POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS,
      "attester_verifier",
    ),
    primaryVerifier: requiredAddress(env.POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS, "attester_primary_verifier"),
    recoveryVerifier: requiredAddress(
      env.POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS,
      "attester_recovery_verifier",
    ),
    relayVerifier: requiredAddress(env.POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS, "attester_relay_verifier"),
    relaySigner: requiredAddress(env.POLICYPOOL_RELAY_SIGNER_ADDRESS, "attester_relay_signer"),
    paymentAsset: requiredAddress(env.POLICYPOOL_PAYMENT_ASSET || PAYMENT.asset, "attester_payment_asset"),
    accounts: parsePrivateKeys(env.POLICYPOOL_ATTESTER_PRIVATE_KEYS),
    allowedPolicyIds: parsePolicyIds(env.POLICYPOOL_ATTESTER_ALLOWED_POLICY_IDS),
  };
}

function defaultPublicClient() {
  const chain = defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(XLAYER.rpcUrl) });
}

function assertDirectContext(context) {
  const direct = context?.directA2mcp;
  if (!direct || direct.transport !== "direct-a2mcp") {
    throw new EvidenceAttesterError("direct_attestation_context_required");
  }
  return direct;
}

function assertRequestEnvelope(request, configuration) {
  if (request?.protocol !== "PolicyPool Coverage Evidence" || request?.version !== "1") {
    throw new EvidenceAttesterError("attestation_protocol_invalid");
  }
  const action = String(request.action || "");
  const digests = configuration.role === "primary" ? PRIMARY_DIGESTS : RECOVERY_DIGESTS;
  if (!digests[action]) throw new EvidenceAttesterError("attestation_action_not_allowed", 403);
  const expectedManager = action === "capture_fee" ? configuration.feeEscrow : configuration.manager;
  if (
    Number(request.domain?.chainId) !== XLAYER.id
    || !sameAddress(request.domain?.manager, expectedManager)
    || !sameAddress(request.domain?.verifier, configuration.verifier)
    || !isBytes32(request.digest)
    || !request.evidence
    || typeof request.evidence !== "object"
    || Array.isArray(request.evidence)
  ) throw new EvidenceAttesterError("attestation_envelope_invalid");
  return { action, digestFunctionName: digests[action], expectedManager };
}

async function read(publicClient, address, abi, functionName, args = []) {
  try {
    return await publicClient.readContract({ address, abi, functionName, args });
  } catch (error) {
    throw new EvidenceAttesterError(
      `attester_chain_read_failed:${functionName}:${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }
}

async function covenantFor(publicClient, configuration, covenantId) {
  if (!isBytes32(covenantId)) throw new EvidenceAttesterError("covenant_id_invalid");
  const value = await read(publicClient, configuration.manager, MANAGER_ABI, "getCovenant", [covenantId]);
  if (!sameBytes32(value.id, covenantId)) throw new EvidenceAttesterError("covenant_not_found", 404);
  return value;
}

async function policyFor(publicClient, configuration, policyId, { requireActive = true } = {}) {
  if (!configuration.allowedPolicyIds.has(policyId.toLowerCase())) {
    throw new EvidenceAttesterError("policy_not_allowlisted", 403);
  }
  const value = await read(publicClient, configuration.registry, REGISTRY_ABI, "getPolicy", [policyId]);
  if (!sameBytes32(value.id, policyId)) {
    throw new EvidenceAttesterError("policy_not_found", 404);
  }
  if (requireActive && value.active !== true) {
    throw new EvidenceAttesterError("policy_not_active");
  }
  return value;
}

async function verifyTopology(publicClient, configuration) {
  const [managerPrimary, managerRecovery, managerRegistry, managerVault, threshold, signerCount] = await Promise.all([
    read(publicClient, configuration.manager, MANAGER_ABI, "evidenceVerifier"),
    read(publicClient, configuration.manager, MANAGER_ABI, "recoveryEvidenceVerifier"),
    read(publicClient, configuration.manager, MANAGER_ABI, "policyRegistry"),
    read(publicClient, configuration.manager, MANAGER_ABI, "bondVault"),
    read(publicClient, configuration.verifier, VERIFIER_ABI, "threshold"),
    read(publicClient, configuration.verifier, VERIFIER_ABI, "signerCount"),
  ]);
  if (
    !sameAddress(managerPrimary, configuration.primaryVerifier)
    || !sameAddress(managerRecovery, configuration.recoveryVerifier)
    || !sameAddress(managerRegistry, configuration.registry)
    || !sameAddress(managerVault, configuration.vault)
    || Number(threshold) !== 3
    || Number(signerCount) !== 5
  ) throw new EvidenceAttesterError("attester_topology_mismatch", 503);
  const configured = [];
  for (let index = 0; index < Number(signerCount); index += 1) {
    configured.push(await read(publicClient, configuration.verifier, VERIFIER_ABI, "signerAt", [BigInt(index)]));
  }
  const onchain = configured.map((item) => getAddress(item).toLowerCase()).sort();
  const local = configuration.accounts.map((item) => item.address.toLowerCase()).sort();
  if (stableStringify(onchain) !== stableStringify(local)) {
    throw new EvidenceAttesterError("attester_signer_set_mismatch", 503);
  }
  return Number(threshold);
}

async function verifyIssue({ request, configuration, publicClient, chain, now }) {
  if (configuration.role !== "primary") throw new EvidenceAttesterError("issue_primary_only", 403);
  const evidence = request.evidence;
  const context = request.context || {};
  const direct = assertDirectContext(context);
  const policyId = policyIdValue(evidence.policyId);
  const policy = await policyFor(publicClient, configuration, policyId);
  const terms = policy.terms;
  const cap = BigInt(evidence.coverageCapAtomic);
  const buyerPaid = BigInt(evidence.buyerPaidAtomic);
  const verifiedAcceptanceAt = positiveInteger(evidence.verifiedAcceptanceAt, "acceptance_time");
  const enrollmentExpiresAt = positiveInteger(evidence.enrollmentExpiresAt, "enrollment_expiry");
  const nowSeconds = Math.floor(now() / 1_000);
  if (
    !sameBytes32(evidence.observedFingerprint, terms.serviceFingerprint)
    || !sameAddress(evidence.provider, policy.provider)
    || !sameAddress(context.policy?.providerWallet, policy.provider)
    || policyIdValue(context.policy?.onchainPolicyId) !== policyId
    || String(context.policy?.serviceFingerprint || "").toLowerCase() !== String(terms.serviceFingerprint).toLowerCase()
    || String(direct.agentId) !== String(terms.agentId)
    || String(direct.serviceId) !== String(terms.serviceId)
    || Number(terms.clockMode) !== 1
    || !sameAddress(terms.adapter, configuration.relayVerifier)
    || cap !== BigInt(terms.maxCapAtomic)
    || cap > buyerPaid
    || enrollmentExpiresAt !== verifiedAcceptanceAt + Number(terms.enrollmentWindowSeconds)
    || verifiedAcceptanceAt > nowSeconds
    || nowSeconds > enrollmentExpiresAt
    || !sameAddress(context.targetOrder?.buyer, evidence.buyer)
    || String(context.targetOrder?.amountAtomic) !== buyerPaid.toString()
    || isoSeconds(context.targetOrder?.acceptedAt, "context_acceptance_time") !== verifiedAcceptanceAt
  ) throw new EvidenceAttesterError("issue_evidence_policy_mismatch");
  const [coverable, availableBond] = await Promise.all([
    read(publicClient, configuration.registry, REGISTRY_ABI, "isCoverable", [policyId, terms.serviceFingerprint]),
    read(publicClient, configuration.vault, VAULT_ABI, "availableBond", [policy.provider]),
  ]);
  if (coverable !== true || BigInt(availableBond) < cap) {
    throw new EvidenceAttesterError("issue_policy_not_coverable");
  }
  const expectedRequestHash = `sha256:${sha256(stableStringify(direct.providerRequest))}`;
  if (direct.requestHash !== expectedRequestHash) throw new EvidenceAttesterError("direct_request_hash_mismatch");
  const providerAuthorization = await providerPaymentAuthorization(
    direct.providerPaymentSignature,
    { providerWallet: policy.provider, servicePriceAtomic: buyerPaid.toString() },
    chain,
    now(),
    direct.providerRequirementsHash,
  );
  if (
    !sameAddress(providerAuthorization.authorization?.from, evidence.buyer)
    || !sameBytes32(providerAuthorization.hash, direct.providerAuthorization?.hash)
    || providerAuthorization.id !== direct.providerAuthorization?.id
    || !sameBytes32(providerAuthorization.authorization?.nonce, direct.providerAuthorization?.nonce)
    || Number(providerAuthorization.authorization?.validAfter) !== Number(direct.providerAuthorization?.validAfter)
    || Number(providerAuthorization.authorization?.validBefore) !== Number(direct.providerAuthorization?.validBefore)
  ) throw new EvidenceAttesterError("provider_authorization_context_mismatch");
  const expectedJobId = directJobId({
    policyId,
    buyer: evidence.buyer,
    requestHash: expectedRequestHash,
    providerAuthorizationHash: providerAuthorization.hash,
  });
  if (!sameBytes32(expectedJobId, evidence.jobId) || !sameBytes32(context.targetOrder?.jobId, evidence.jobId)) {
    throw new EvidenceAttesterError("direct_job_id_mismatch");
  }
  const fee = direct.feeAuthorization || {};
  const expectedFeeNonce = await read(
    publicClient,
    configuration.feeEscrow,
    ESCROW_ABI,
    "authorizationNonce",
    [
      policyId,
      evidence.jobId,
      getAddress(evidence.buyer),
      providerAuthorization.hash,
      BigInt(fee.validAfter),
      BigInt(fee.validBefore),
      BigInt(providerAuthorization.authorization.validBefore),
    ],
  );
  const expectedFeeId = await read(
    publicClient,
    configuration.feeEscrow,
    ESCROW_ABI,
    "authorizationId",
    [getAddress(evidence.buyer), BigInt(fee.validAfter), BigInt(fee.validBefore), expectedFeeNonce],
  );
  const feeAmount = await read(publicClient, configuration.feeEscrow, ESCROW_ABI, "feeAmountAtomic");
  const expectedFeeAmount = cap * BigInt(terms.premiumBps) / 10_000n;
  if (
    !sameBytes32(expectedFeeNonce, fee.nonce)
    || !sameBytes32(expectedFeeId, fee.id)
    || !sameBytes32(expectedFeeId, evidence.feeAuthorization?.authorizationHash)
    || !sameBytes32(expectedFeeId, context.paymentAuthorization?.hash)
    || Number(evidence.feeAuthorization?.validBefore) !== Number(fee.validBefore)
    || Number(context.paymentAuthorization?.validBefore) !== Number(fee.validBefore)
    || BigInt(feeAmount) !== expectedFeeAmount
  ) throw new EvidenceAttesterError("fee_authorization_context_mismatch");
  const verifiedFeePayment = await verifyFeePayment({
    raw: direct.policyFeePaymentSignature,
    record: {
      id: direct.quoteId,
      buyer: evidence.buyer,
      feeEscrow: configuration.feeEscrow,
      feeAmountAtomic: BigInt(feeAmount).toString(),
      feeValidAfter: Number(fee.validAfter),
      feeValidBefore: Number(fee.validBefore),
      feeNonce: expectedFeeNonce,
      feeMaxTimeoutSeconds: Number(fee.maxTimeoutSeconds),
    },
    token: direct.quoteToken,
    chain,
    nowMs: now(),
  });
  const [providerAuthorizationConsumed, feeAuthorizationConsumed] = await Promise.all([
    read(
      publicClient,
      configuration.paymentAsset,
      PAYMENT_ASSET_ABI,
      "authorizationState",
      [evidence.buyer, providerAuthorization.authorization.nonce],
    ),
    read(
      publicClient,
      configuration.paymentAsset,
      PAYMENT_ASSET_ABI,
      "authorizationState",
      [evidence.buyer, verifiedFeePayment.authorization.nonce],
    ),
  ]);
  if (providerAuthorizationConsumed === true) {
    throw new EvidenceAttesterError("provider_authorization_already_consumed", 409);
  }
  if (feeAuthorizationConsumed === true) {
    throw new EvidenceAttesterError("fee_authorization_already_consumed", 409);
  }
  const acceptanceHash = directAcceptanceEvidenceHash({
    jobId: evidence.jobId,
    policyId,
    buyer: evidence.buyer,
    requestHash: expectedRequestHash,
    providerRequirementsHash: direct.providerRequirementsHash,
    providerAuthorizationHash: providerAuthorization.hash,
    quoteId: direct.quoteId,
  });
  if (!sameBytes32(acceptanceHash, evidence.acceptanceEvidenceHash)) {
    throw new EvidenceAttesterError("direct_acceptance_evidence_mismatch");
  }
}

async function verifyDirectAuthorizationBinding({
  context,
  covenant,
  configuration,
  publicClient,
  chain,
  now,
  expectedConsumed,
}) {
  const evidence = context.providerAuthorizationEvidence;
  let authorization;
  try {
    authorization = await providerPaymentAuthorization(
      evidence?.paymentSignature,
      { providerWallet: covenant.provider, servicePriceAtomic: String(covenant.buyerPaidAtomic) },
      chain,
      now(),
      evidence?.requirementsHash,
      { allowExpired: true },
    );
  } catch {
    throw new EvidenceAttesterError("provider_authorization_evidence_invalid");
  }
  const policyId = String(covenant.policyId).toLowerCase();
  const expectedJobId = directJobId({
    policyId,
    buyer: covenant.buyer,
    requestHash: evidence?.requestHash,
    providerAuthorizationHash: authorization.hash,
  });
  const expectedAcceptanceHash = directAcceptanceEvidenceHash({
    jobId: covenant.jobId,
    policyId,
    buyer: covenant.buyer,
    requestHash: evidence?.requestHash,
    providerRequirementsHash: evidence?.requirementsHash,
    providerAuthorizationHash: authorization.hash,
    quoteId: context.directQuote,
  });
  if (
    !sameBytes32(expectedJobId, covenant.jobId)
    || !sameBytes32(expectedAcceptanceHash, covenant.acceptanceEvidenceHash)
    || !sameBytes32(authorization.hash, evidence?.authorizationHash)
    || authorization.id !== evidence?.authorizationId
    || !sameAddress(authorization.authorization?.from, covenant.buyer)
    || Number(authorization.authorization?.validAfter) !== Number(evidence?.validAfter)
    || Number(authorization.authorization?.validBefore) !== Number(evidence?.validBefore)
  ) throw new EvidenceAttesterError("provider_authorization_covenant_mismatch");
  const consumed = await read(
    publicClient,
    configuration.paymentAsset,
    PAYMENT_ASSET_ABI,
    "authorizationState",
    [covenant.buyer, authorization.authorization.nonce],
  );
  if (consumed !== expectedConsumed) {
    throw new EvidenceAttesterError(
      expectedConsumed
        ? "provider_authorization_not_consumed"
        : "provider_authorization_already_consumed",
      409,
    );
  }
  return {
    authorization,
    requestHash: String(evidence.requestHash).toLowerCase(),
  };
}

async function verifyPolicyFeeAuthorizationBinding({
  context,
  covenant,
  policy,
  fee,
  providerAuthorization,
  configuration,
  publicClient,
  chain,
  now,
}) {
  const evidence = context.policyFeeAuthorizationEvidence;
  let validAfter;
  let validBefore;
  let expectedNonce;
  let expectedId;
  try {
    validAfter = BigInt(evidence?.validAfter);
    validBefore = BigInt(evidence?.validBefore);
    expectedNonce = await read(
      publicClient,
      configuration.feeEscrow,
      ESCROW_ABI,
      "authorizationNonce",
      [
        covenant.policyId,
        covenant.jobId,
        covenant.buyer,
        providerAuthorization.hash,
        validAfter,
        validBefore,
        BigInt(providerAuthorization.authorization.validBefore),
      ],
    );
    expectedId = await read(
      publicClient,
      configuration.feeEscrow,
      ESCROW_ABI,
      "authorizationId",
      [covenant.buyer, validAfter, validBefore, expectedNonce],
    );
  } catch (error) {
    if (error instanceof EvidenceAttesterError && error.status === 503) throw error;
    throw new EvidenceAttesterError("fee_authorization_evidence_invalid");
  }
  const feeAmount = await read(publicClient, configuration.feeEscrow, ESCROW_ABI, "feeAmountAtomic");
  const expectedFeeAmount = BigInt(covenant.coverageCapAtomic) * BigInt(policy.terms.premiumBps) / 10_000n;
  let verified;
  try {
    verified = await verifyFeePayment({
      raw: evidence?.paymentSignature,
      record: {
        buyer: covenant.buyer,
        feeEscrow: configuration.feeEscrow,
        feeAmountAtomic: BigInt(feeAmount).toString(),
        feeValidAfter: Number(validAfter),
        feeValidBefore: Number(validBefore),
        feeNonce: expectedNonce,
        feeMaxTimeoutSeconds: Number(evidence?.maxTimeoutSeconds),
      },
      token: evidence?.quoteToken,
      chain,
      nowMs: now(),
      allowExpired: true,
    });
  } catch {
    throw new EvidenceAttesterError("fee_authorization_evidence_invalid");
  }
  if (
    BigInt(feeAmount) !== expectedFeeAmount
    || !sameBytes32(expectedNonce, evidence?.nonce)
    || !sameBytes32(expectedId, covenant.feeAuthorizationHash)
    || !sameBytes32(verified.authorization?.nonce, expectedNonce)
    || Number(verified.authorization?.validBefore) !== Number(covenant.feeAuthorizationValidBefore)
    || (Number(fee.state) === FEE.refunded
      && (
        !sameBytes32(fee.covenantId, covenant.id)
        || !sameAddress(fee.buyer, covenant.buyer)
        || !sameBytes32(fee.providerAuthorizationHash, providerAuthorization.hash)
        || String(fee.amountAtomic) !== expectedFeeAmount.toString()
      ))
  ) throw new EvidenceAttesterError("fee_authorization_covenant_mismatch");
  const consumed = await read(
    publicClient,
    configuration.paymentAsset,
    PAYMENT_ASSET_ABI,
    "authorizationState",
    [covenant.buyer, expectedNonce],
  );
  const expectedConsumed = Number(fee.state) === FEE.refunded;
  if (consumed !== expectedConsumed) {
    throw new EvidenceAttesterError("fee_authorization_state_mismatch", 409);
  }
  return { id: expectedId, nonce: expectedNonce, validAfter, validBefore };
}

async function verifyRelayBinding({
  receipt,
  covenant,
  policy,
  fee,
  providerBinding,
  configuration,
  chain,
}) {
  const { authorization: providerAuthorization, requestHash } = providerBinding;
  if (!await verifyProviderRelayReceipt(receipt, configuration.relaySigner, configuration.relayVerifier)) {
    throw new EvidenceAttesterError("relay_receipt_signature_invalid");
  }
  if (
    !sameBytes32(receipt.covenantId, covenant.id)
    || !sameBytes32(receipt.provider?.targetJobId, covenant.jobId)
    || policyIdValue(receipt.provider?.policyHash) !== String(covenant.policyId).toLowerCase()
    || String(receipt.provider?.agentId) !== String(policy.terms.agentId)
    || String(receipt.provider?.serviceId) !== String(policy.terms.serviceId)
    || !sameSha256Id(receipt.request?.hash, requestHash)
    || receipt.request?.paymentAuthorizationPresent !== true
    || receipt.request?.paymentAuthorizationId !== authorizationIdForHash(fee.providerAuthorizationHash)
    || receipt.request?.paymentAuthorizationId !== providerAuthorization.id
    || receipt.request?.paymentVerified !== true
    || !sameAddress(receipt.settlement?.payer, covenant.buyer)
    || !sameAddress(receipt.settlement?.payTo, covenant.provider)
    || !sameAddress(receipt.settlement?.asset, configuration.paymentAsset)
    || String(receipt.settlement?.amountAtomic) !== String(covenant.buyerPaidAtomic)
    || !isBytes32(receipt.settlement?.authorizationNonce)
    || !sameBytes32(receipt.settlement?.authorizationNonce, providerAuthorization.authorization?.nonce)
    || !isBytes32(receipt.settlement?.transaction)
  ) throw new EvidenceAttesterError("relay_receipt_covenant_mismatch");
  await chain.verifyProviderSettlement({
    txHash: receipt.settlement.transaction,
    payer: covenant.buyer,
    payTo: covenant.provider,
    asset: configuration.paymentAsset,
    amountAtomic: covenant.buyerPaidAtomic,
    authorizationNonce: receipt.settlement.authorizationNonce,
  });
}

async function verifyLifecycle({ action, request, configuration, publicClient, chain, now }) {
  const evidence = request.evidence;
  const context = request.context || {};
  const covenant = await covenantFor(publicClient, configuration, evidence.covenantId);
  // Policy suspension blocks new risk, not resolution of already-locked capital.
  const policy = await policyFor(
    publicClient,
    configuration,
    String(covenant.policyId).toLowerCase(),
    { requireActive: false },
  );
  if (action === "cancel_unpaid") {
    const fee = await read(publicClient, configuration.feeEscrow, ESCROW_ABI, "getFee", [evidence.feeAuthorizationHash]);
    if (
      ![COVENANT.pendingStart, COVENANT.active, COVENANT.payoutDue].includes(Number(covenant.state))
      || !sameBytes32(evidence.feeAuthorizationHash, covenant.feeAuthorizationHash)
      || ![FEE.none, FEE.refunded].includes(Number(fee.state))
      || Number(evidence.observedAt) <= Number(covenant.feeAuthorizationValidBefore)
      || Number(evidence.observedAt) > Math.floor(now() / 1_000)
      || !sameBytes32(evidence.nonSettlementEvidenceHash, contextHash(context.nonSettlement))
      || context.nonSettlement?.settlementSearchResult !== "not_found"
      || Number(context.policyFeeState) !== Number(fee.state)
    ) throw new EvidenceAttesterError("cancel_unpaid_evidence_invalid");
    const providerBinding = await verifyDirectAuthorizationBinding({
      context,
      covenant,
      configuration,
      publicClient,
      chain,
      now,
      expectedConsumed: false,
    });
    const { authorization: providerAuthorization } = providerBinding;
    const policyFeeAuthorization = await verifyPolicyFeeAuthorizationBinding({
      context,
      covenant,
      policy,
      fee,
      providerAuthorization,
      configuration,
      publicClient,
      chain,
      now,
    });
    if (
      !sameBytes32(providerAuthorization.authorization?.nonce, context.nonSettlement?.authorizationNonce)
      || !sameBytes32(context.nonSettlement?.providerAuthorizationHash, providerAuthorization.hash)
      || context.nonSettlement?.providerAuthorizationId !== providerAuthorization.id
      || Number(context.nonSettlement?.authorizationValidAfter)
        !== Number(providerAuthorization.authorization?.validAfter)
      || Number(context.nonSettlement?.authorizationValidBefore)
        !== Number(providerAuthorization.authorization?.validBefore)
      || !sameBytes32(context.nonSettlement?.policyFeeAuthorizationHash, policyFeeAuthorization.id)
      || !sameBytes32(context.nonSettlement?.policyFeeAuthorizationNonce, policyFeeAuthorization.nonce)
      || Number(context.nonSettlement?.policyFeeAuthorizationValidBefore)
        !== Number(policyFeeAuthorization.validBefore)
      || Number(evidence.observedAt) <= Number(providerAuthorization.authorization?.validBefore)
    ) throw new EvidenceAttesterError("provider_authorization_covenant_mismatch");
    const search = context.providerSettlementSearch;
    if (
      !search
      || !sameAddress(search.payer, covenant.buyer)
      || !sameAddress(search.payTo, covenant.provider)
      || !sameAddress(search.asset, configuration.paymentAsset)
      || String(search.amountAtomic) !== String(covenant.buyerPaidAtomic)
      || !sameBytes32(search.authorizationNonce, context.nonSettlement?.authorizationNonce)
      || !sameBytes32(context.nonSettlement?.covenantId, covenant.id)
      || !sameAddress(context.nonSettlement?.buyer, covenant.buyer)
      || !sameAddress(context.nonSettlement?.provider, covenant.provider)
      || String(context.nonSettlement?.amountAtomic) !== String(covenant.buyerPaidAtomic)
      || Number(context.nonSettlement?.authorizationValidBefore) !== Number(search.notAfterTimestamp)
      || Number(context.nonSettlement?.settlementSearchNotBefore) !== Number(search.notBeforeTimestamp)
      || Number(context.nonSettlement?.observedAt) !== Number(evidence.observedAt)
      || Number(search.notBeforeTimestamp) <= 0
      || Number(search.notAfterTimestamp) <= Number(search.notBeforeTimestamp)
      || Number(search.notAfterTimestamp) >= Number(evidence.observedAt)
    ) {
      throw new EvidenceAttesterError("provider_settlement_search_context_invalid");
    }
    const settlement = await chain.findProviderSettlement({
      payer: search.payer,
      payTo: search.payTo,
      asset: search.asset,
      amountAtomic: search.amountAtomic,
      authorizationNonce: search.authorizationNonce,
      notBeforeTimestamp: search.notBeforeTimestamp,
      notAfterTimestamp: search.notAfterTimestamp,
    });
    if (settlement) throw new EvidenceAttesterError("provider_settlement_exists", 409);
    return;
  }
  const fee = await read(
    publicClient,
    configuration.feeEscrow,
    ESCROW_ABI,
    "getFee",
    [covenant.feeAuthorizationHash],
  );
  if (
    Number(fee.state) === FEE.none
    || !sameBytes32(fee.covenantId, covenant.id)
    || !sameAddress(fee.buyer, covenant.buyer)
    || !isBytes32(fee.providerAuthorizationHash)
  ) throw new EvidenceAttesterError("lifecycle_fee_binding_invalid");
  const providerBinding = await verifyDirectAuthorizationBinding({
    context,
    covenant,
    configuration,
    publicClient,
    chain,
    now,
    expectedConsumed: true,
  });
  const { authorization: providerAuthorization } = providerBinding;
  if (!sameBytes32(fee.providerAuthorizationHash, providerAuthorization.hash)) {
    throw new EvidenceAttesterError("lifecycle_provider_authorization_mismatch");
  }
  const receipt = context.relayReceipt;
  await verifyRelayBinding({
    receipt,
    covenant,
    policy,
    fee,
    providerBinding,
    configuration,
    chain,
  });
  if (action === "start_clock") {
    if (
      Number(covenant.state) !== COVENANT.pendingStart
      || Number(evidence.startedAt) !== isoSeconds(receipt.clock?.startedAt, "relay_clock_start")
      || !sameBytes32(evidence.evidenceHash, receipt.receiptDigest)
    ) throw new EvidenceAttesterError("clock_evidence_invalid");
    return;
  }
  if (action === "release") {
    if (
      ![COVENANT.active, COVENANT.payoutDue].includes(Number(covenant.state))
      || receipt.clock?.delivered !== true
      || receipt.clock?.completedWithinSla !== true
      || Number(evidence.completedAt) !== isoSeconds(receipt.clock?.completedAt, "relay_completion_time")
      || Number(evidence.completedAt) > Number(covenant.deadline)
      || !sameBytes32(evidence.evidenceHash, receipt.receiptDigest)
    ) throw new EvidenceAttesterError("release_evidence_invalid");
    return;
  }
  if (action === "breach") {
    if (
      Number(covenant.state) !== COVENANT.active
      || Math.floor(now() / 1_000) <= Number(covenant.deadline)
      || (receipt.clock?.delivered === true && receipt.clock?.completedWithinSla === true)
      || !sameBytes32(evidence.evidenceHash, contextHash(context.breach))
      || !sameBytes32(context.breach?.covenantId, covenant.id)
      || Number(context.breach?.deadline) !== Number(covenant.deadline)
    ) throw new EvidenceAttesterError("breach_evidence_invalid");
    return;
  }
  if (action === "settlement") {
    if (
      Number(covenant.state) !== COVENANT.payoutDue
      || evidence.recoveryFinalized !== true
      || context.recovery?.directTransferFinal !== true
      || String(evidence.escrowRefundAtomic) !== "0"
      || String(evidence.otherRecoveryAtomic) !== "0"
      || String(evidence.escrowRefundAtomic) !== String(context.recovery?.marketplaceEscrowRefundAtomic)
      || String(evidence.otherRecoveryAtomic) !== String(context.recovery?.otherRecoveryAtomic)
      || !sameBytes32(evidence.recoveryEvidenceHash, contextHash(context.recovery))
      || !sameBytes32(context.recovery?.providerPaymentTransaction, receipt.settlement.transaction)
    ) throw new EvidenceAttesterError("settlement_evidence_invalid");
    return;
  }
  if (action === "capture_fee") {
    if (
      !sameBytes32(evidence.feeId, covenant.feeAuthorizationHash)
      || Number(fee.state) !== FEE.funded
      || Number(covenant.state) === COVENANT.pendingStart
      || !sameBytes32(fee.covenantId, covenant.id)
      || !sameBytes32(fee.providerAuthorizationHash, evidence.providerAuthorizationHash)
      || !sameBytes32(evidence.relayReceiptDigest, receipt.receiptDigest)
      || !sameBytes32(evidence.providerSettlementTransaction, receipt.settlement.transaction)
    ) throw new EvidenceAttesterError("capture_evidence_invalid");
    return;
  }
  throw new EvidenceAttesterError("attestation_action_not_supported", 403);
}

async function recomputeDigest({ action, digestFunctionName, request, configuration, publicClient }) {
  const address = action === "capture_fee" ? configuration.feeEscrow : configuration.manager;
  const abi = action === "capture_fee" ? ESCROW_ABI : MANAGER_ABI;
  const digest = await read(publicClient, address, abi, digestFunctionName, [request.evidence]);
  if (!sameBytes32(digest, request.digest)) throw new EvidenceAttesterError("attestation_digest_mismatch");
  return digest;
}

export function createEvidenceAttester({
  configuration = evidenceAttesterConfiguration(),
  publicClient = defaultPublicClient(),
  chain = createChainService({ client: publicClient }),
  now = () => Date.now(),
} = {}) {
  async function attest(request) {
    const envelope = assertRequestEnvelope(request, configuration);
    const threshold = await verifyTopology(publicClient, configuration);
    if (envelope.action === "issue") {
      await verifyIssue({ request, configuration, publicClient, chain, now });
    } else {
      await verifyLifecycle({
        action: envelope.action,
        request,
        configuration,
        publicClient,
        chain,
        now,
      });
    }
    const digest = await recomputeDigest({
      action: envelope.action,
      digestFunctionName: envelope.digestFunctionName,
      request,
      configuration,
      publicClient,
    });
    const sorted = [...configuration.accounts]
      .sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()))
      .slice(0, threshold);
    const signatures = [];
    for (const account of sorted) signatures.push(await account.sign({ hash: digest }));
    return { ok: true, role: configuration.role, digest, signatures };
  }
  return { attest };
}

export const __test = {
  contextHash,
  ESCROW_ABI,
  MANAGER_ABI,
  REGISTRY_ABI,
  VERIFIER_ABI,
  VAULT_ABI,
};
