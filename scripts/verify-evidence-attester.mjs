import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { authorizationTypes } from "@x402/evm";
import {
  getAddress,
  keccak256,
  recoverAddress,
  stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createEvidenceAttester,
  EvidenceAttesterError,
  __test as attesterTest,
} from "../api/lib/evidence-attester.js";
import {
  canonicalEip3009AuthorizationIdentity,
} from "../api/lib/provider-relay.js";
import {
  directAcceptanceEvidenceHash,
  directJobId,
} from "../api/lib/direct-a2mcp.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import { sha256, stableStringify } from "../api/lib/utils.js";
import { createEvidenceAttestHandler } from "../attesters/evidence-attest.js";

const nowMs = Date.parse("2026-07-18T18:00:00.000Z");
let currentNowMs = nowMs;
const nowSeconds = Math.floor(nowMs / 1_000);
const manager = "0x1000000000000000000000000000000000000001";
const registry = "0x2000000000000000000000000000000000000002";
const vault = "0x3000000000000000000000000000000000000003";
const primaryVerifier = "0x4000000000000000000000000000000000000004";
const recoveryVerifier = "0x5000000000000000000000000000000000000005";
const feeEscrow = "0x6000000000000000000000000000000000000006";
const relayVerifier = "0x7000000000000000000000000000000000000007";
const provider = "0x8000000000000000000000000000000000000008";
const buyer = privateKeyToAccount(generatePrivateKey());
const relaySigner = privateKeyToAccount(generatePrivateKey());
const primaryAccounts = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
const recoveryAccounts = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
const policyId = `0x${"11".repeat(32)}`;
const fingerprint = `0x${"22".repeat(32)}`;
const feeNonce = `0x${"33".repeat(32)}`;
const feeId = `0x${"44".repeat(32)}`;
const requestDigest = `0x${"55".repeat(32)}`;
const providerNonce = `0x${"66".repeat(32)}`;
const providerRequest = { target_url: "https://policypool.example/api/covered-job-receipt" };
const requestHash = `sha256:${sha256(stableStringify(providerRequest))}`;
const quoteId = "77".repeat(16);
const quoteToken = "signed-direct-quote-token";
const providerValidBefore = nowSeconds + 500;
const feeValidBefore = providerValidBefore;
const feeMaxTimeoutSeconds = feeValidBefore - nowSeconds;
const providerAccepted = {
  scheme: "exact",
  network: XLAYER.network,
  asset: PAYMENT.asset,
  amount: "500000",
  payTo: provider,
  maxTimeoutSeconds: 600,
  extra: { name: PAYMENT.name, version: PAYMENT.version },
};
const providerRequirementsHash = `sha256:${sha256(providerAccepted)}`;

async function paymentHeader(accepted, authorization) {
  const signature = await buyer.signTypedData({
    domain: {
      name: PAYMENT.name,
      version: PAYMENT.version,
      chainId: XLAYER.id,
      verifyingContract: PAYMENT.asset,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { authorization, signature },
  });
}

const providerAuthorization = {
  from: buyer.address,
  to: provider,
  value: "500000",
  validAfter: "0",
  validBefore: String(providerValidBefore),
  nonce: providerNonce,
};
const providerPaymentSignature = await paymentHeader(providerAccepted, providerAuthorization);
const providerIdentity = canonicalEip3009AuthorizationIdentity(providerAccepted, providerAuthorization);
const jobId = directJobId({
  policyId,
  buyer: buyer.address,
  requestHash,
  providerAuthorizationHash: providerIdentity.hash,
});
const feeAccepted = {
  scheme: "exact",
  network: XLAYER.network,
  asset: PAYMENT.asset,
  amount: "100000",
  payTo: feeEscrow,
  maxTimeoutSeconds: feeMaxTimeoutSeconds,
  extra: {
    name: PAYMENT.name,
    version: PAYMENT.version,
    assetTransferMethod: "eip3009",
    policyPoolDirectQuote: quoteToken,
    policyPoolAuthorizationNonce: feeNonce,
  },
};
const feeAuthorization = {
  from: buyer.address,
  to: feeEscrow,
  value: "100000",
  validAfter: "0",
  validBefore: String(feeValidBefore),
  nonce: feeNonce,
};
const policyFeePaymentSignature = await paymentHeader(feeAccepted, feeAuthorization);
const acceptanceEvidenceHash = directAcceptanceEvidenceHash({
  jobId,
  policyId,
  buyer: buyer.address,
  requestHash,
  providerRequirementsHash,
  providerAuthorizationHash: providerIdentity.hash,
  quoteId,
});
const issuedAt = nowSeconds - 5;
const issueEvidence = {
  policyId,
  observedFingerprint: fingerprint,
  jobId,
  provider,
  buyer: buyer.address,
  coverageCapAtomic: "500000",
  buyerPaidAtomic: "500000",
  verifiedAcceptanceAt: String(issuedAt),
  enrollmentExpiresAt: String(issuedAt + 60),
  acceptanceEvidenceHash,
  feeAuthorization: { authorizationHash: feeId, validBefore: String(feeValidBefore) },
};
const issueContext = {
  directA2mcp: {
    transport: "direct-a2mcp",
    quoteId,
    quoteToken,
    agentId: "3808",
    serviceId: "33461",
    endpoint: "https://warden.example/audit",
    requestHash,
    providerRequirementsHash,
    providerRequest,
    providerPaymentSignature,
    policyFeePaymentSignature,
    providerAuthorization: {
      ...providerIdentity,
      nonce: providerNonce,
      validAfter: 0,
      validBefore: providerValidBefore,
    },
    feeAuthorization: {
      id: feeId,
      nonce: feeNonce,
      validAfter: 0,
      validBefore: feeValidBefore,
      maxTimeoutSeconds: feeMaxTimeoutSeconds,
    },
  },
  policy: {
    onchainPolicyId: policyId,
    providerWallet: provider,
    serviceFingerprint: fingerprint,
  },
  targetOrder: {
    jobId,
    buyer: buyer.address,
    amountAtomic: "500000",
    acceptedAt: new Date(issuedAt * 1_000).toISOString(),
    acceptanceEvidenceHash,
  },
  paymentAuthorization: { hash: feeId, validBefore: feeValidBefore },
};
const policy = {
  id: policyId,
  serviceKey: `0x${"88".repeat(32)}`,
  provider,
  terms: {
    marketplace: `0x${"99".repeat(32)}`,
    agentId: 3808n,
    serviceId: 33461n,
    serviceFingerprint: fingerprint,
    scopeHash: `0x${"aa".repeat(32)}`,
    slaSeconds: 300,
    enrollmentWindowSeconds: 60,
    maxCapAtomic: 500000n,
    premiumBps: 2000,
    payoutBasis: 0,
    clockMode: 1,
    expiresAt: BigInt(nowSeconds + 30 * 24 * 60 * 60),
    adapter: relayVerifier,
  },
  version: 1,
  registeredAt: BigInt(nowSeconds - 60),
  active: true,
  suspensionReason: `0x${"00".repeat(32)}`,
};
let currentDigest = requestDigest;
let currentCovenant = {
  id: `0x${"ab".repeat(32)}`,
  policyId,
  jobId,
  provider,
  buyer: buyer.address,
  coverageCapAtomic: 500000n,
  buyerPaidAtomic: 500000n,
  issuedAt: BigInt(issuedAt),
  startAt: BigInt(issuedAt + 2),
  deadline: BigInt(issuedAt + 302),
  enrollmentExpiresAt: BigInt(issuedAt + 60),
  payoutDueAt: 0n,
  completedAt: 0n,
  recoveryObservedAt: 0n,
  slaSeconds: 300,
  payoutBasis: 0,
  clockMode: 1,
  state: 2,
  payoutAtomic: 0n,
  acceptanceEvidenceHash,
  breachEvidenceHash: `0x${"00".repeat(32)}`,
  recoveryEvidenceHash: `0x${"00".repeat(32)}`,
  feeAuthorizationHash: feeId,
  feeAuthorizationValidBefore: BigInt(feeValidBefore),
  recoveryFinalized: false,
};
let currentFee = {
  buyer: buyer.address,
  covenantId: currentCovenant.id,
  providerAuthorizationHash: providerIdentity.hash,
  amountAtomic: 100000n,
  fundedAt: BigInt(issuedAt),
  authorizationValidBefore: BigInt(feeValidBefore),
  refundAvailableAt: BigInt(feeValidBefore + 120),
  state: 1,
};
let currentFeeAmountAtomic = 100000n;
let settlementSearchResult = null;
let settlementSearches = 0;
let settlementVerifications = 0;
const settlementVerificationInputs = [];
const consumedAuthorizationNonces = new Set();

function signerSet(address) {
  return getAddress(address) === getAddress(primaryVerifier) ? primaryAccounts : recoveryAccounts;
}

const publicClient = {
  async readContract({ address, functionName, args = [] }) {
    if (functionName === "evidenceVerifier") return primaryVerifier;
    if (functionName === "recoveryEvidenceVerifier") return recoveryVerifier;
    if (functionName === "policyRegistry") return registry;
    if (functionName === "bondVault") return vault;
    if (functionName === "threshold") return 3;
    if (functionName === "signerCount") return 5n;
    if (functionName === "signerAt") return signerSet(address)[Number(args[0])].address;
    if (functionName === "getPolicy") return structuredClone(policy);
    if (functionName === "isCoverable") return true;
    if (functionName === "availableBond") return 500000n;
    if (functionName === "authorizationState") {
      return consumedAuthorizationNonces.has(String(args[1]).toLowerCase());
    }
    if (functionName === "authorizationNonce") return feeNonce;
    if (functionName === "authorizationId") return feeId;
    if (functionName === "feeAmountAtomic") return currentFeeAmountAtomic;
    if (functionName === "getCovenant") return structuredClone(currentCovenant);
    if (functionName === "getFee") return structuredClone(currentFee);
    if (functionName.endsWith("EvidenceDigest")) return currentDigest;
    throw new Error(`unexpected read ${functionName}`);
  },
};
const chain = {
  async verifyProviderPaymentAuthorization() { return true; },
  async verifyProviderSettlement(input) {
    settlementVerifications += 1;
    settlementVerificationInputs.push(structuredClone(input));
    return true;
  },
  async findProviderSettlement() { settlementSearches += 1; return settlementSearchResult; },
};
const baseConfiguration = {
  manager,
  registry,
  vault,
  feeEscrow,
  primaryVerifier,
  recoveryVerifier,
  relayVerifier,
  relaySigner: relaySigner.address,
  paymentAsset: PAYMENT.asset,
  allowedPolicyIds: new Set([policyId]),
};
const primaryConfiguration = {
  ...baseConfiguration,
  role: "primary",
  verifier: primaryVerifier,
  accounts: primaryAccounts,
};
const recoveryConfiguration = {
  ...baseConfiguration,
  role: "recovery",
  verifier: recoveryVerifier,
  accounts: recoveryAccounts,
};
const primary = createEvidenceAttester({ configuration: primaryConfiguration, publicClient, chain, now: () => currentNowMs });
const recovery = createEvidenceAttester({ configuration: recoveryConfiguration, publicClient, chain, now: () => currentNowMs });

const issueRequest = {
  protocol: "PolicyPool Coverage Evidence",
  version: "1",
  action: "issue",
  digest: requestDigest,
  domain: { chainId: XLAYER.id, manager, verifier: primaryVerifier },
  evidence: issueEvidence,
  context: issueContext,
};
const issueResult = await primary.attest(issueRequest);
assert.equal(issueResult.signatures.length, 3);
const recoveredIssueSigners = [];
for (const signature of issueResult.signatures) {
  recoveredIssueSigners.push(await recoverAddress({ hash: requestDigest, signature }));
}
assert.deepEqual(
  recoveredIssueSigners.map((item) => item.toLowerCase()),
  [...recoveredIssueSigners].map((item) => item.toLowerCase()).sort(),
  "signatures must be ordered by recovered address",
);

const originalPolicyCap = policy.terms.maxCapAtomic;
const partialCoverageIssue = structuredClone(issueRequest);
partialCoverageIssue.evidence.coverageCapAtomic = "300000";
const partialFeeAccepted = { ...feeAccepted, amount: "60000" };
const partialFeeAuthorization = { ...feeAuthorization, value: "60000" };
partialCoverageIssue.context.directA2mcp.policyFeePaymentSignature = await paymentHeader(
  partialFeeAccepted,
  partialFeeAuthorization,
);
policy.terms.maxCapAtomic = 300000n;
currentFeeAmountAtomic = 60000n;
assert.equal(
  (await primary.attest(partialCoverageIssue)).signatures.length,
  3,
  "a policy cap below the signed provider service price must remain issuable",
);

const overInsuredIssue = structuredClone(issueRequest);
overInsuredIssue.evidence.coverageCapAtomic = "600000";
policy.terms.maxCapAtomic = 600000n;
await assert.rejects(
  () => primary.attest(overInsuredIssue),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "issue_evidence_policy_mismatch",
  "coverage must never exceed the buyer's signed provider payment",
);
policy.terms.maxCapAtomic = originalPolicyCap;
currentFeeAmountAtomic = 100000n;

consumedAuthorizationNonces.add(providerNonce.toLowerCase());
await assert.rejects(
  () => primary.attest(issueRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "provider_authorization_already_consumed",
);
consumedAuthorizationNonces.delete(providerNonce.toLowerCase());
consumedAuthorizationNonces.add(feeNonce.toLowerCase());
await assert.rejects(
  () => primary.attest(issueRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "fee_authorization_already_consumed",
);
consumedAuthorizationNonces.delete(feeNonce.toLowerCase());

const substitutedRequest = structuredClone(issueRequest);
substitutedRequest.context.directA2mcp.providerRequest.target_url = "https://attacker.example/replace";
await assert.rejects(
  () => primary.attest(substitutedRequest),
  (error) => error instanceof EvidenceAttesterError && error.code === "direct_request_hash_mismatch",
);

const substitutedBuyer = structuredClone(issueRequest);
substitutedBuyer.evidence.buyer = provider;
await assert.rejects(
  () => primary.attest(substitutedBuyer),
  (error) => error instanceof EvidenceAttesterError,
);

const substitutedDigest = structuredClone(issueRequest);
substitutedDigest.digest = `0x${"fe".repeat(32)}`;
await assert.rejects(
  () => primary.attest(substitutedDigest),
  (error) => error instanceof EvidenceAttesterError && error.code === "attestation_digest_mismatch",
);

await assert.rejects(
  () => recovery.attest(issueRequest),
  (error) => error instanceof EvidenceAttesterError && error.code === "attestation_action_not_allowed",
);

const signatureDomain = {
  name: "PolicyPool Relay Receipt",
  version: "1",
  chainId: XLAYER.id,
  verifyingContract: relayVerifier,
};

async function signRelayReceipt(unsignedReceiptValue, receiptId) {
  const digest = keccak256(stringToHex(stableStringify(unsignedReceiptValue)));
  const signature = await relaySigner.signTypedData({
    domain: signatureDomain,
    types: { RelayReceipt: [{ name: "receiptDigest", type: "bytes32" }] },
    primaryType: "RelayReceipt",
    message: { receiptDigest: digest },
  });
  return {
    ...unsignedReceiptValue,
    receiptId,
    receiptDigest: digest,
    signer: relaySigner.address,
    signature,
  };
}

const unsignedReceipt = {
  version: "0.4.0",
  signatureDomain,
  requestId: `sha256:${"bc".repeat(32)}`,
  relayGrantId: "pprg-hostile-test",
  covenantId: currentCovenant.id,
  provider: {
    agentId: "3808",
    serviceId: "33461",
    policyHash: `onchain:${policyId}`,
    endpointHash: `sha256:${"cd".repeat(32)}`,
    targetJobId: jobId,
  },
  request: {
    hash: requestHash,
    paymentAuthorizationPresent: true,
    paymentAuthorizationId: providerIdentity.id,
    paymentVerified: true,
    forwardedAt: new Date((issuedAt + 2) * 1_000).toISOString(),
  },
  response: {
    status: 200,
    hash: `sha256:${"de".repeat(32)}`,
    bytes: 100,
    completedAt: new Date((issuedAt + 3) * 1_000).toISOString(),
    durationMs: 1000,
    paymentRequired: false,
  },
  settlement: {
    transaction: `0x${"ef".repeat(32)}`,
    payer: buyer.address,
    payTo: provider,
    asset: PAYMENT.asset,
    amountAtomic: "500000",
    authorizationNonce: providerNonce,
  },
  clock: {
    source: "policypool_relay_verified_x402_settlement",
    startedAt: new Date((issuedAt + 2) * 1_000).toISOString(),
    completedAt: new Date((issuedAt + 3) * 1_000).toISOString(),
    delivered: true,
    completedWithinSla: true,
  },
};
const relayReceipt = await signRelayReceipt(unsignedReceipt, "ppr-hostile-test");
const { receiptDigest } = relayReceipt;
const lifecycleAuthorizationContext = {
  directQuote: quoteId,
  providerAuthorizationEvidence: {
    paymentSignature: providerPaymentSignature,
    requirementsHash: providerRequirementsHash,
    requestHash,
    authorizationHash: providerIdentity.hash,
    authorizationId: providerIdentity.id,
    validAfter: 0,
    validBefore: providerValidBefore,
  },
};
consumedAuthorizationNonces.add(providerNonce.toLowerCase());
currentDigest = `0x${"12".repeat(32)}`;
const releaseRequest = {
  protocol: "PolicyPool Coverage Evidence",
  version: "1",
  action: "release",
  digest: currentDigest,
  domain: { chainId: XLAYER.id, manager, verifier: recoveryVerifier },
  evidence: {
    covenantId: currentCovenant.id,
    completedAt: String(issuedAt + 3),
    observedAt: String(issuedAt + 4),
    evidenceHash: receiptDigest,
  },
  context: { ...lifecycleAuthorizationContext, relayReceipt },
};
const recoveryRelease = await recovery.attest(releaseRequest);
assert.equal(recoveryRelease.signatures.length, 3);
assert.equal(settlementVerifications, 1);

const substitutedRequestReceipt = await signRelayReceipt({
  ...unsignedReceipt,
  request: {
    ...unsignedReceipt.request,
    hash: `sha256:${"01".repeat(32)}`,
  },
}, "ppr-substituted-request");
const substitutedRequestRelease = structuredClone(releaseRequest);
substitutedRequestRelease.context.relayReceipt = substitutedRequestReceipt;
substitutedRequestRelease.evidence.evidenceHash = substitutedRequestReceipt.receiptDigest;
await assert.rejects(
  () => recovery.attest(substitutedRequestRelease),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "relay_receipt_covenant_mismatch",
  "a valid relay receipt for another provider request must not authorize release",
);

const missingRequestHashUnsignedReceipt = structuredClone(unsignedReceipt);
delete missingRequestHashUnsignedReceipt.request.hash;
const missingRequestHashReceipt = await signRelayReceipt(
  missingRequestHashUnsignedReceipt,
  "ppr-missing-request-hash",
);
const missingRequestHashRelease = structuredClone(releaseRequest);
missingRequestHashRelease.context.relayReceipt = missingRequestHashReceipt;
missingRequestHashRelease.evidence.evidenceHash = missingRequestHashReceipt.receiptDigest;
await assert.rejects(
  () => recovery.attest(missingRequestHashRelease),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "relay_receipt_covenant_mismatch",
  "a relay receipt without the direct request binding must not authorize release",
);

const originalProviderAuthorizationHash = currentFee.providerAuthorizationHash;
currentFee.providerAuthorizationHash = `0x${"98".repeat(32)}`;
await assert.rejects(
  () => recovery.attest(releaseRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "lifecycle_provider_authorization_mismatch",
);
currentFee.providerAuthorizationHash = originalProviderAuthorizationHash;

policy.active = false;
assert.equal((await recovery.attest(releaseRequest)).signatures.length, 3);
await assert.rejects(() => primary.attest(issueRequest), /policy_not_active/);
policy.active = true;

currentDigest = `0x${"13".repeat(32)}`;
const captureRequest = {
  protocol: "PolicyPool Coverage Evidence",
  version: "1",
  action: "capture_fee",
  digest: currentDigest,
  domain: { chainId: XLAYER.id, manager: feeEscrow, verifier: primaryVerifier },
  evidence: {
    feeId,
    covenantId: currentCovenant.id,
    providerAuthorizationHash: providerIdentity.hash,
    relayReceiptDigest: receiptDigest,
    providerSettlementTransaction: unsignedReceipt.settlement.transaction,
    observedAt: String(issuedAt + 4),
  },
  context: { ...lifecycleAuthorizationContext, relayReceipt },
};
assert.equal((await primary.attest(captureRequest)).signatures.length, 3);
const substitutedRequestCapture = structuredClone(captureRequest);
substitutedRequestCapture.context.relayReceipt = substitutedRequestReceipt;
substitutedRequestCapture.evidence.relayReceiptDigest = substitutedRequestReceipt.receiptDigest;
await assert.rejects(
  () => primary.attest(substitutedRequestCapture),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "relay_receipt_covenant_mismatch",
  "a valid relay receipt for another provider request must not authorize fee capture",
);

currentFee.state = 0;
consumedAuthorizationNonces.add(feeNonce.toLowerCase());
currentNowMs = (providerValidBefore + 121) * 1_000;
currentDigest = `0x${"15".repeat(32)}`;
const orphanedPaymentTransaction = `0x${"16".repeat(32)}`;
const orphanedRefundRequest = {
  protocol: "PolicyPool Coverage Evidence",
  version: "1",
  action: "refund_orphaned_fee",
  digest: currentDigest,
  domain: { chainId: XLAYER.id, manager: feeEscrow, verifier: primaryVerifier },
  evidence: {
    feeId,
    covenantId: currentCovenant.id,
    authorizationNonce: feeNonce,
    paymentTransaction: orphanedPaymentTransaction,
    observedAt: String(providerValidBefore + 121),
  },
  context: {
    ...lifecycleAuthorizationContext,
    policyFeeAuthorizationEvidence: {
      paymentSignature: policyFeePaymentSignature,
      quoteToken,
      nonce: feeNonce,
      validAfter: 0,
      validBefore: feeValidBefore,
      maxTimeoutSeconds: feeMaxTimeoutSeconds,
    },
  },
};
assert.equal((await primary.attest(orphanedRefundRequest)).signatures.length, 3);
assert.deepEqual(settlementVerificationInputs.at(-1), {
  txHash: orphanedPaymentTransaction,
  payer: buyer.address,
  payTo: feeEscrow,
  asset: PAYMENT.asset,
  amountAtomic: 100000n,
  authorizationNonce: feeNonce,
});
await assert.rejects(
  () => recovery.attest({
    ...orphanedRefundRequest,
    domain: { chainId: XLAYER.id, manager: feeEscrow, verifier: recoveryVerifier },
  }),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "attestation_action_not_allowed",
);
consumedAuthorizationNonces.delete(feeNonce.toLowerCase());
await assert.rejects(
  () => primary.attest(orphanedRefundRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "fee_authorization_state_mismatch",
  "an unconsumed nonce cannot claim an orphaned fee transfer",
);
consumedAuthorizationNonces.add(feeNonce.toLowerCase());
const staleOrphanedRefund = structuredClone(orphanedRefundRequest);
staleOrphanedRefund.evidence.observedAt = String(providerValidBefore - 600);
await assert.rejects(
  () => primary.attest(staleOrphanedRefund),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "orphaned_fee_refund_evidence_invalid",
);

consumedAuthorizationNonces.delete(providerNonce.toLowerCase());
currentCovenant.state = 1;
currentNowMs = (providerValidBefore + 121) * 1_000;
const cancellationNowSeconds = Math.floor(currentNowMs / 1_000);
currentFee.state = 1;
const nonSettlement = {
  protocol: "PolicyPool Direct A2MCP",
  version: "0.4.0",
  quoteId,
  covenantId: currentCovenant.id,
  buyer: buyer.address,
  provider,
  amountAtomic: "500000",
  providerAuthorizationHash: providerIdentity.hash,
  providerAuthorizationId: providerIdentity.id,
  authorizationNonce: providerNonce,
  authorizationValidAfter: 0,
  authorizationValidBefore: providerValidBefore,
  policyFeeAuthorizationHash: feeId,
  policyFeeAuthorizationNonce: feeNonce,
  policyFeeAuthorizationValidBefore: feeValidBefore,
  settlementSearchNotBefore: providerValidBefore - 500,
  settlementSearchResult: "not_found",
  observedAt: cancellationNowSeconds,
};
currentDigest = `0x${"14".repeat(32)}`;
const cancelRequest = {
  protocol: "PolicyPool Coverage Evidence",
  version: "1",
  action: "cancel_unpaid",
  digest: currentDigest,
  domain: { chainId: XLAYER.id, manager, verifier: primaryVerifier },
  evidence: {
    covenantId: currentCovenant.id,
    observedAt: String(cancellationNowSeconds),
    feeAuthorizationHash: feeId,
    nonSettlementEvidenceHash: attesterTest.contextHash(nonSettlement),
  },
  context: {
    nonSettlement,
    directQuote: quoteId,
    policyFeeState: 1,
    providerAuthorizationEvidence: {
      paymentSignature: providerPaymentSignature,
      requirementsHash: providerRequirementsHash,
      requestHash,
      authorizationHash: providerIdentity.hash,
      authorizationId: providerIdentity.id,
      validAfter: 0,
      validBefore: providerValidBefore,
    },
    policyFeeAuthorizationEvidence: {
      paymentSignature: policyFeePaymentSignature,
      quoteToken,
      nonce: feeNonce,
      validAfter: 0,
      validBefore: feeValidBefore,
      maxTimeoutSeconds: feeMaxTimeoutSeconds,
    },
    providerSettlementSearch: {
      payer: buyer.address,
      payTo: provider,
      asset: PAYMENT.asset,
      amountAtomic: "500000",
      authorizationNonce: providerNonce,
      notBeforeTimestamp: providerValidBefore - 500,
      notAfterTimestamp: providerValidBefore,
    },
  },
};
await assert.rejects(
  () => primary.attest(cancelRequest),
  (error) => error instanceof EvidenceAttesterError && error.code === "cancel_unpaid_evidence_invalid",
);
assert.equal(settlementSearches, 0, "a funded fee must fail before any cancellation search/signature");

currentFee.state = 3;
cancelRequest.context.policyFeeState = 3;
consumedAuthorizationNonces.add(feeNonce.toLowerCase());
assert.equal((await primary.attest(cancelRequest)).signatures.length, 3);
assert.equal(settlementSearches, 1);
currentFee.state = 0;
cancelRequest.context.policyFeeState = 0;
await assert.rejects(
  () => primary.attest(cancelRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "fee_authorization_state_mismatch",
);
currentFee.state = 3;
cancelRequest.context.policyFeeState = 3;
consumedAuthorizationNonces.add(providerNonce.toLowerCase());
await assert.rejects(
  () => primary.attest(cancelRequest),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "provider_authorization_already_consumed",
);
consumedAuthorizationNonces.delete(providerNonce.toLowerCase());
const substitutedNonce = structuredClone(cancelRequest);
substitutedNonce.context.nonSettlement.authorizationNonce = `0x${"99".repeat(32)}`;
substitutedNonce.evidence.nonSettlementEvidenceHash = attesterTest.contextHash(
  substitutedNonce.context.nonSettlement,
);
substitutedNonce.context.providerSettlementSearch.authorizationNonce = `0x${"99".repeat(32)}`;
await assert.rejects(
  () => primary.attest(substitutedNonce),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "provider_authorization_covenant_mismatch",
);
const substitutedSearch = structuredClone(cancelRequest);
substitutedSearch.context.providerSettlementSearch.amountAtomic = "499999";
await assert.rejects(
  () => primary.attest(substitutedSearch),
  (error) => error instanceof EvidenceAttesterError
    && error.code === "provider_settlement_search_context_invalid",
);
settlementSearchResult = { txHash: unsignedReceipt.settlement.transaction };
await assert.rejects(
  () => primary.attest(cancelRequest),
  (error) => error instanceof EvidenceAttesterError && error.code === "provider_settlement_exists",
);

function responseHarness() {
  return {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; },
  };
}
process.env.POLICYPOOL_ATTESTER_TOKEN = "hostile-handler-token";
const handler = createEvidenceAttestHandler({
  attester: { async attest(body) { return { ok: true, digest: body.digest, signatures: [] }; } },
});
const unauthorizedResponse = responseHarness();
await handler({ method: "POST", headers: {}, body: { digest: requestDigest } }, unauthorizedResponse);
assert.equal(unauthorizedResponse.statusCode, 401);
const authorizedResponse = responseHarness();
await handler({
  method: "POST",
  headers: { authorization: "Bearer hostile-handler-token" },
  body: { digest: requestDigest },
}, authorizedResponse);
assert.equal(authorizedResponse.statusCode, 200);
assert.equal(JSON.parse(authorizedResponse.body).ok, true);

console.log("PolicyPool evidence attester passed: independent two-authorization derivation, ordered quorum signatures, exact relay/settlement binding, refund-aware cancellation, on-chain nonce state, and authenticated handler behavior.");
