import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
} from "viem";
import { COVERAGE, PAYMENT, XLAYER } from "./config.js";
import { createChainService } from "./chain.js";
import {
  MAX_DIRECT_AUTHORIZATION_WINDOW_SECONDS,
  MAX_DIRECT_ENROLLMENT_WINDOW_SECONDS,
  MIN_DIRECT_EXECUTION_WINDOW_SECONDS,
} from "./direct-a2mcp-constants.js";
import { finalizeDirectPolicyFee } from "./direct-policy-fee.js";
import { DirectA2mcpStateError } from "./direct-a2mcp-store.js";
import { PolicyFeeEscrowError } from "./policy-fee-escrow.js";
import {
  canonicalEip3009AuthorizationIdentity,
  ProviderRelayError,
} from "./provider-relay.js";
import { UniversalIssuerError } from "./universal-issuer.js";
import {
  formatUsdtAtomic,
  isBytes32,
  parseUsdtAtomic,
  sha256,
  stableStringify,
} from "./utils.js";

const DIRECT_JOB_TYPEHASH = keccak256(stringToHex(
  "PolicyPoolDirectA2MCPJob(bytes32 policyId,address buyer,bytes32 requestHash,bytes32 providerAuthorizationHash)",
));
const DIRECT_ACCEPTANCE_TYPEHASH = keccak256(stringToHex(
  "PolicyPoolDirectA2MCPAcceptance(bytes32 jobId,bytes32 policyId,address buyer,bytes32 requestHash,bytes32 providerRequirementsHash,bytes32 providerAuthorizationHash,bytes32 quoteId)",
));
export class DirectA2mcpError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "DirectA2mcpError";
    this.code = code;
    this.status = status;
  }
}

function bytes32FromSha256(value, field) {
  const normalized = String(value || "").toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) throw new DirectA2mcpError(`${field}_invalid`);
  return `0x${normalized.slice(7)}`;
}

function onchainPolicyId(policy) {
  const value = String(policy?.onchainPolicyId || policy?.policyHash || "").replace(/^onchain:/, "");
  if (!isBytes32(value)) throw new DirectA2mcpError("direct_policy_id_invalid");
  return value.toLowerCase();
}

function quoteIdBytes32(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new DirectA2mcpError("direct_quote_id_invalid");
  return `0x${String(id).padEnd(64, "0")}`;
}

function directJobId({ policyId, buyer, requestHash, providerAuthorizationHash }) {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      DIRECT_JOB_TYPEHASH,
      policyId,
      getAddress(buyer),
      bytes32FromSha256(requestHash, "direct_request_hash"),
      providerAuthorizationHash,
    ],
  ));
}

function directAcceptanceEvidenceHash({
  jobId,
  policyId,
  buyer,
  requestHash,
  providerRequirementsHash,
  providerAuthorizationHash,
  quoteId,
}) {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      DIRECT_ACCEPTANCE_TYPEHASH,
      jobId,
      policyId,
      getAddress(buyer),
      bytes32FromSha256(requestHash, "direct_request_hash"),
      bytes32FromSha256(providerRequirementsHash, "direct_requirements_hash"),
      providerAuthorizationHash,
      quoteIdBytes32(quoteId),
    ],
  ));
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function directEnrollmentWindowSeconds(value) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed <= 0
    || parsed > MAX_DIRECT_ENROLLMENT_WINDOW_SECONDS
  ) {
    throw new DirectA2mcpError("direct_enrollment_window_unfundable");
  }
  return parsed;
}

function normalizedAccepted(accepted) {
  return {
    ...accepted,
    asset: getAddress(accepted.asset),
    payTo: getAddress(accepted.payTo),
    amount: String(accepted.amount),
    maxTimeoutSeconds: Number(accepted.maxTimeoutSeconds),
    extra: accepted.extra ? { ...accepted.extra } : {},
  };
}

function feePaymentRequirements(record, token) {
  return {
    scheme: "exact",
    network: XLAYER.network,
    asset: PAYMENT.asset,
    amount: record.feeAmountAtomic,
    payTo: record.feeEscrow,
    maxTimeoutSeconds: record.feeMaxTimeoutSeconds,
    extra: {
      name: PAYMENT.name,
      version: PAYMENT.version,
      assetTransferMethod: "eip3009",
      policyPoolDirectQuote: token,
      policyPoolAuthorizationNonce: record.feeNonce,
    },
  };
}

async function verifyFeePayment({ raw, record, token, chain, nowMs, allowExpired = false }) {
  if (!raw) throw new DirectA2mcpError("policy_fee_signature_required", 402);
  let payload;
  try {
    payload = decodePaymentSignatureHeader(raw);
  } catch {
    throw new DirectA2mcpError("policy_fee_signature_malformed", 400);
  }
  const expected = feePaymentRequirements(record, token);
  let accepted;
  let authorization;
  let signature;
  try {
    accepted = normalizedAccepted(payload.accepted);
    authorization = payload.payload.authorization;
    signature = payload.payload.signature;
  } catch {
    throw new DirectA2mcpError("policy_fee_signature_invalid", 400);
  }
  if (
    payload.x402Version !== 2
    || stableStringify(accepted) !== stableStringify(expected)
    || !sameAddress(authorization?.from, record.buyer)
    || !sameAddress(authorization?.to, record.feeEscrow)
    || String(authorization?.value || "") !== record.feeAmountAtomic
    || String(authorization?.validAfter || "") !== String(record.feeValidAfter)
    || String(authorization?.validBefore || "") !== String(record.feeValidBefore)
    || String(authorization?.nonce || "").toLowerCase() !== record.feeNonce.toLowerCase()
    || !/^0x[a-fA-F0-9]+$/.test(String(signature || ""))
    || (!allowExpired && Number(authorization?.validBefore) <= Math.floor(nowMs / 1_000))
  ) throw new DirectA2mcpError("policy_fee_requirements_mismatch", 400);
  try {
    const verified = await chain.verifyProviderPaymentAuthorization({
      payer: record.buyer,
      asset: PAYMENT.asset,
      name: PAYMENT.name,
      version: PAYMENT.version,
      authorization,
      signature,
    });
    if (verified !== true) throw new Error("fee payment signature rejected");
  } catch {
    throw new DirectA2mcpError("policy_fee_signature_invalid", 400);
  }
  const identity = canonicalEip3009AuthorizationIdentity(accepted, authorization);
  return { authorization, signature, paymentHash: identity.id };
}

function validateProviderRequest(record, providerRequest) {
  if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
    throw new DirectA2mcpError("provider_request_required");
  }
  const requestHash = `sha256:${sha256(stableStringify(providerRequest))}`;
  if (requestHash !== record.requestHash) throw new DirectA2mcpError("provider_request_changed", 409);
}

function validateQuotePolicy(record, probe) {
  if (
    probe.requestHash !== record.requestHash
    || probe.providerRequirementsHash !== record.providerRequirementsHash
    || onchainPolicyId(probe.policy) !== record.policyId
    || String(probe.policy.serviceFingerprint).toLowerCase() !== record.serviceFingerprint
    || String(probe.policy.servicePriceAtomic) !== record.servicePriceAtomic
  ) throw new DirectA2mcpError("direct_quote_policy_or_challenge_changed", 409);
}

function validateExistingCovenant(covenant, record) {
  if (
    covenant.id?.toLowerCase() !== record.covenantId
    || covenant.policyId?.toLowerCase() !== record.policyId
    || covenant.jobId?.toLowerCase() !== record.jobId
    || !sameAddress(covenant.buyer, record.buyer)
    || covenant.feeAuthorizationHash?.toLowerCase() !== record.feeId
    || Number(covenant.feeAuthorizationValidBefore) !== record.feeValidBefore
  ) throw new DirectA2mcpError("direct_existing_covenant_mismatch", 503);
}

export function createDirectA2mcpCoordinator({
  state,
  relay,
  feeEscrow,
  issuer,
  grantService,
  chain = createChainService(),
  configuration,
  now = () => Date.now(),
} = {}) {
  if (!state?.issue || !state?.bind || !state?.claim || !state?.retainRecovery) {
    throw new DirectA2mcpError("direct_state_unavailable", 503);
  }
  if (!relay?.probe || !relay?.verifyAuthorization || !relay?.execute || !relay?.recover) {
    throw new DirectA2mcpError("direct_provider_relay_unavailable", 503);
  }
  if (
    !feeEscrow?.terms
    || !feeEscrow?.previewAuthorization
    || !feeEscrow?.fund
    || !feeEscrow?.getFee
    || !feeEscrow?.capture
    || !feeEscrow?.refund
  ) {
    throw new DirectA2mcpError("direct_fee_escrow_unavailable", 503);
  }
  if (!issuer?.issue || !issuer?.previewCovenantId || !issuer?.getCovenant || !issuer?.startClock) {
    throw new DirectA2mcpError("direct_issuer_unavailable", 503);
  }
  if (!grantService?.issue) throw new DirectA2mcpError("direct_relay_grant_unavailable", 503);
  if (!configuration?.directA2mcpEnabled || !configuration?.feeEscrow) {
    throw new DirectA2mcpError("direct_a2mcp_not_active", 503);
  }

  async function quote(input) {
    let buyer;
    try {
      buyer = getAddress(input?.buyer);
    } catch {
      throw new DirectA2mcpError("direct_buyer_invalid");
    }
    const probe = await relay.probe(input);
    const policy = probe.policy;
    const policyId = onchainPolicyId(policy);
    const servicePriceAtomic = BigInt(policy.servicePriceAtomic);
    const policyCapAtomic = BigInt(policy.maxCoverageAtomic);
    const availableBondAtomic = BigInt(policy.providerAvailableBondAtomic);
    const enrollmentWindowSeconds = directEnrollmentWindowSeconds(policy.enrollmentWindowSeconds);
    const requested = input?.requestedCoverageUSDT
      ? parseUsdtAtomic(input.requestedCoverageUSDT, PAYMENT.decimals)
      : policyCapAtomic;
    if (
      policyCapAtomic < BigInt(COVERAGE.minAtomic)
      || policyCapAtomic > servicePriceAtomic
      || policyCapAtomic > availableBondAtomic
    ) {
      throw new DirectA2mcpError("direct_policy_cap_unavailable");
    }
    if (requested !== policyCapAtomic) {
      throw new DirectA2mcpError("direct_coverage_cap_must_equal_policy_cap");
    }
    const terms = await feeEscrow.terms();
    const expectedFee = policyCapAtomic * BigInt(policy.premiumBps) / 10_000n;
    if (expectedFee !== terms.amountAtomic) throw new DirectA2mcpError("direct_policy_fee_incompatible");
    const issued = await state.issue({
      version: "0.4.0-direct-a2mcp",
      buyer,
      agentId: String(policy.agentId),
      serviceId: String(policy.serviceIds[0]),
      policyId,
      policyHash: policy.policyHash,
      serviceFingerprint: String(policy.serviceFingerprint).toLowerCase(),
      servicePriceAtomic: servicePriceAtomic.toString(),
      coverageCapAtomic: requested.toString(),
      feeAmountAtomic: terms.amountAtomic.toString(),
      feeEscrow: getAddress(configuration.feeEscrow),
      requestHash: probe.requestHash,
      providerChallengeHash: probe.providerChallengeHash,
      providerRequirementsHash: probe.providerRequirementsHash,
      providerAccepted: probe.accepted,
      endpoint: probe.endpoint,
      enrollmentWindowSeconds,
    });
    return {
      stage: "provider_authorization_required",
      quote: issued,
      paymentRequired: probe.paymentRequired,
    };
  }

  async function bind({ token, providerRequest, providerPaymentSignature }) {
    const current = await state.resolve(token);
    validateProviderRequest(current, providerRequest);
    const authorization = await relay.verifyAuthorization({
      agentId: current.agentId,
      serviceId: current.serviceId,
      raw: providerPaymentSignature,
      buyer: current.buyer,
      providerRequirementsHash: current.providerRequirementsHash,
    });
    const nowSeconds = Math.floor(now() / 1_000);
    const providerValidAfter = Number(authorization.validAfter);
    const providerValidBefore = Number(authorization.validBefore);
    const quoteExpiresAt = Math.floor(Date.parse(current.expiresAt) / 1_000);
    const enrollmentWindowSeconds = directEnrollmentWindowSeconds(current.enrollmentWindowSeconds);
    const minimumProviderValidBefore = nowSeconds
      + enrollmentWindowSeconds
      + MIN_DIRECT_EXECUTION_WINDOW_SECONDS;
    if (
      !Number.isSafeInteger(providerValidAfter)
      || !Number.isSafeInteger(providerValidBefore)
      || !isBytes32(authorization.nonce)
      || providerValidAfter > nowSeconds
      || providerValidBefore < minimumProviderValidBefore
      || providerValidBefore > nowSeconds + MAX_DIRECT_AUTHORIZATION_WINDOW_SECONDS
      || providerValidBefore > quoteExpiresAt
    ) throw new DirectA2mcpError("provider_authorization_window_invalid", 400);
    const jobId = directJobId({
      policyId: current.policyId,
      buyer: current.buyer,
      requestHash: current.requestHash,
      providerAuthorizationHash: authorization.hash,
    });
    const feeValidAfter = 0;
    const feeValidBefore = Math.min(providerValidBefore, quoteExpiresAt);
    const feeMaxTimeoutSeconds = Math.max(1, feeValidBefore - nowSeconds);
    const feePreview = await feeEscrow.previewAuthorization({
      policyId: current.policyId,
      jobId,
      buyer: current.buyer,
      providerAuthorizationHash: authorization.hash,
      validAfter: feeValidAfter,
      validBefore: feeValidBefore,
      providerAuthorizationValidBefore: providerValidBefore,
    });
    const acceptanceEvidenceHash = directAcceptanceEvidenceHash({
      jobId,
      policyId: current.policyId,
      buyer: current.buyer,
      requestHash: current.requestHash,
      providerRequirementsHash: current.providerRequirementsHash,
      providerAuthorizationHash: authorization.hash,
      quoteId: current.id,
    });
    const paymentAuthorization = { hash: feePreview.feeId, validBefore: feeValidBefore };
    const policy = { onchainPolicyId: current.policyId };
    const targetOrder = { jobId, buyer: current.buyer };
    const covenantId = issuer.previewCovenantId({ policy, targetOrder, paymentAuthorization });
    const bound = await state.bind(token, {
      providerAuthorizationHash: authorization.hash,
      providerAuthorizationId: authorization.id,
      providerAuthorizationValidAfter: providerValidAfter,
      providerAuthorizationValidBefore: providerValidBefore,
      providerAuthorizationNonce: authorization.nonce.toLowerCase(),
      jobId,
      acceptanceEvidenceHash,
      feeId: feePreview.feeId.toLowerCase(),
      feeNonce: feePreview.nonce.toLowerCase(),
      feeValidAfter,
      feeValidBefore,
      feeMaxTimeoutSeconds,
      covenantId: covenantId.toLowerCase(),
    });
    return {
      stage: "policy_fee_authorization_required",
      quote: bound,
      requirements: feePaymentRequirements(bound, token),
      authorization: {
        from: bound.buyer,
        to: bound.feeEscrow,
        value: bound.feeAmountAtomic,
        validAfter: String(bound.feeValidAfter),
        validBefore: String(bound.feeValidBefore),
        nonce: bound.feeNonce,
      },
    };
  }

  async function execute({ token, providerRequest, providerPaymentSignature, policyFeePaymentSignature }) {
    const bound = await state.resolve(token);
    if (!bound.bindingHash || bound.state === "probed") throw new DirectA2mcpError("direct_quote_not_bound", 409);
    validateProviderRequest(bound, providerRequest);
    const recoveringExistingExecution = ["executing", "complete"].includes(bound.state);
    const providerAuthorization = await relay.verifyAuthorization({
      agentId: bound.agentId,
      serviceId: bound.serviceId,
      raw: providerPaymentSignature,
      buyer: bound.buyer,
      providerRequirementsHash: bound.providerRequirementsHash,
      allowExpired: recoveringExistingExecution,
    });
    if (
      providerAuthorization.hash.toLowerCase() !== bound.providerAuthorizationHash
      || providerAuthorization.id !== bound.providerAuthorizationId
    ) throw new DirectA2mcpError("provider_authorization_changed", 409);
    const feePayment = await verifyFeePayment({
      raw: policyFeePaymentSignature,
      record: bound,
      token,
      chain,
      nowMs: now(),
      allowExpired: recoveringExistingExecution,
    });
    const enrollmentWindowSeconds = directEnrollmentWindowSeconds(bound.enrollmentWindowSeconds);
    const executionNowSeconds = Math.floor(now() / 1_000);
    if (
      !recoveringExistingExecution
      && (
        bound.providerAuthorizationValidBefore < executionNowSeconds + enrollmentWindowSeconds
        || bound.feeValidBefore < executionNowSeconds + enrollmentWindowSeconds
      )
    ) {
      throw new DirectA2mcpError("direct_authorization_window_elapsed_before_execution", 409);
    }
    const executionId = `sha256:${sha256({
      quoteId: bound.id,
      providerPayment: providerAuthorization.id,
      policyFeePayment: feePayment.paymentHash,
    })}`;
    const claim = await state.claim(token, executionId);
    if (claim.status === "complete") {
      let providerReplay = null;
      const relayGrant = claim.record.execution?.stages?.relayGrant;
      if (relayGrant?.token) {
        try {
          providerReplay = await relay.recover({
            agentId: bound.agentId,
            serviceId: bound.serviceId,
            targetJobId: bound.jobId,
            endpoint: bound.endpoint,
            providerRequest,
            relayGrant: relayGrant.token,
          }, { "payment-signature": providerPaymentSignature });
        } catch {
          // The durable lifecycle result remains valid even if response retrieval is temporarily unavailable.
        }
      }
      return {
        replay: true,
        ...claim.record.result,
        relayReceipt: providerReplay?.receipt || null,
        providerResponse: providerReplay?.upstream || null,
      };
    }
    let record = claim.record;
    let providerResult;
    try {
      record = await state.retainRecovery(token, executionId, {
        providerRequest,
        providerPaymentSignature,
      });
      const acceptedAtMs = record.execution.startedAtMs;
      const acceptedAt = new Date(acceptedAtMs).toISOString();
      const enrollmentClosesAt = new Date(
        acceptedAtMs + Number(bound.enrollmentWindowSeconds) * 1_000,
      ).toISOString();
      const targetOrder = {
        jobId: bound.jobId,
        buyer: bound.buyer,
        amountAtomic: bound.servicePriceAtomic,
        acceptedAt,
        acceptanceEvidenceHash: bound.acceptanceEvidenceHash,
      };
      const paymentAuthorization = { hash: bound.feeId, validBefore: bound.feeValidBefore };
      let covenant = await issuer.getCovenant(bound.covenantId);
      if (Number(covenant.state) === 0) {
        if (Date.parse(enrollmentClosesAt) <= now()) {
          throw new DirectA2mcpError("direct_enrollment_window_elapsed", 409);
        }
        const probe = await relay.probe({
          agentId: bound.agentId,
          serviceId: bound.serviceId,
          endpoint: bound.endpoint,
          providerRequest,
        });
        validateQuotePolicy(bound, probe);
        const issued = await issuer.issue({
          policy: probe.policy,
          targetOrder,
          coverageCapAtomic: bound.coverageCapAtomic,
          enrollmentClosesAt,
          paymentAuthorization,
        });
        if (issued.covenantId.toLowerCase() !== bound.covenantId) {
          throw new DirectA2mcpError("direct_covenant_id_mismatch", 503);
        }
        record = await state.checkpoint(token, executionId, "covenantIssued", issued);
        covenant = await issuer.getCovenant(bound.covenantId);
      }
      validateExistingCovenant(covenant, bound);
      if (!record.execution.stages.covenantIssued) {
        record = await state.checkpoint(token, executionId, "covenantIssued", {
          recoveredFromChain: true,
          covenantId: bound.covenantId,
        });
      }

      let fee = await feeEscrow.getFee(bound.feeId);
      if (fee.state === 0) {
        const funded = await feeEscrow.fund({
          buyer: bound.buyer,
          policyId: bound.policyId,
          jobId: bound.jobId,
          providerAuthorizationHash: bound.providerAuthorizationHash,
          validAfter: bound.feeValidAfter,
          validBefore: bound.feeValidBefore,
          nonce: bound.feeNonce,
          providerAuthorizationValidBefore: bound.providerAuthorizationValidBefore,
        }, feePayment.signature);
        record = await state.checkpoint(token, executionId, "feeFunded", funded);
        fee = await feeEscrow.getFee(bound.feeId);
      }
      if (
        !sameAddress(fee.buyer, bound.buyer)
        || fee.covenantId.toLowerCase() !== bound.covenantId
        || fee.providerAuthorizationHash.toLowerCase() !== bound.providerAuthorizationHash
        || ![1, 2, 3].includes(fee.state)
      ) throw new DirectA2mcpError("direct_fee_escrow_state_mismatch", 503);
      if (!record.execution.stages.feeFunded) {
        record = await state.checkpoint(token, executionId, "feeFunded", {
          recoveredFromChain: true,
          feeId: bound.feeId,
          state: fee.state,
        });
      }

      let relayGrant = record.execution.stages.relayGrant;
      if (!relayGrant) {
        relayGrant = grantService.issue({
          covenantId: bound.covenantId,
          targetJobId: bound.jobId,
          buyer: bound.buyer,
          agentId: bound.agentId,
          serviceId: bound.serviceId,
          providerRequestHash: bound.requestHash,
          providerRequirementsHash: bound.providerRequirementsHash,
          expiresAt: new Date(Math.min(
            Date.parse(bound.expiresAt),
            bound.providerAuthorizationValidBefore * 1_000,
          )).toISOString(),
        });
        record = await state.checkpoint(token, executionId, "relayGrant", relayGrant);
      }
      const relayInput = {
        agentId: bound.agentId,
        serviceId: bound.serviceId,
        targetJobId: bound.jobId,
        endpoint: bound.endpoint,
        providerRequest,
        relayGrant: relayGrant.token,
      };
      try {
        providerResult = await relay.recover(
          relayInput,
          { "payment-signature": providerPaymentSignature },
        );
      } catch (error) {
        if (!(error instanceof ProviderRelayError) || error.code !== "provider_payment_settlement_not_found") {
          throw error;
        }
      }
      if (!providerResult) {
        if (Number(covenant.state) === 7) {
          throw new DirectA2mcpError("direct_coverage_cancelled_before_provider_settlement", 409);
        }
        if (fee.state === 3) {
          throw new DirectA2mcpError("policy_fee_refunded_provider_unsettled", 409);
        }
        if (Math.floor(now() / 1_000) >= bound.providerAuthorizationValidBefore) {
          throw new DirectA2mcpError("provider_authorization_expired_unsettled", 409);
        }
        const probe = await relay.probe({
          agentId: bound.agentId,
          serviceId: bound.serviceId,
          endpoint: bound.endpoint,
          providerRequest,
        });
        validateQuotePolicy(bound, probe);
        providerResult = await relay.execute(
          relayInput,
          { "payment-signature": providerPaymentSignature },
        );
      }
      if (!providerResult.receipt?.settlement || !providerResult.receipt?.clock) {
        throw new DirectA2mcpError("provider_payment_not_settled", 502);
      }
      if (Number(covenant.state) === 7) {
        throw new DirectA2mcpError("provider_settled_after_coverage_cancelled_manual_resolution", 503);
      }
      record = await state.checkpoint(token, executionId, "providerSettled", {
        receiptId: providerResult.receipt.receiptId,
        receiptDigest: providerResult.receipt.receiptDigest,
        transactionHash: providerResult.receipt.settlement.transaction,
        responseDurable: Boolean(providerResult.upstream),
        recovered: providerResult.recovered === true,
      });

      covenant = await issuer.getCovenant(bound.covenantId);
      if (Number(covenant.state) === 1) {
        const clock = await issuer.startClock(
          bound.covenantId,
          providerResult.receipt.clock.startedAt,
          providerResult.receipt.receiptDigest,
          { relayReceipt: providerResult.receipt },
        );
        record = await state.checkpoint(token, executionId, "clockStarted", clock);
        covenant = await issuer.getCovenant(bound.covenantId);
      }
      if (Number(covenant.state) < 2) throw new DirectA2mcpError("direct_coverage_clock_not_started", 503);
      if (!record.execution.stages.clockStarted) {
        record = await state.checkpoint(token, executionId, "clockStarted", {
          recoveredFromChain: true,
          state: Number(covenant.state),
        });
      }

      const feeResolution = await finalizeDirectPolicyFee({
        feeEscrow,
        feeId: bound.feeId,
        captureEvidence: {
          feeId: bound.feeId,
          covenantId: bound.covenantId,
          providerAuthorizationHash: bound.providerAuthorizationHash,
          relayReceiptDigest: providerResult.receipt.receiptDigest,
          providerSettlementTransaction: providerResult.receipt.settlement.transaction,
          observedAt: Math.floor(now() / 1_000),
        },
        context: { relayReceipt: providerResult.receipt },
        now,
      });
      fee = feeResolution.fee;
      const feeStage = fee.state === 2 ? "feeCaptured" : "feeRefunded";
      if (!record.execution.stages[feeStage]) {
        record = await state.checkpoint(token, executionId, feeStage, feeResolution.write || {
          recoveredFromChain: true,
          state: fee.state,
        });
      }
      if (![2, 3].includes(fee.state)) {
        throw new DirectA2mcpError("direct_fee_capture_pending", 503);
      }

      covenant = await issuer.getCovenant(bound.covenantId);
      if (providerResult.receipt.clock.delivered && providerResult.receipt.clock.completedWithinSla) {
        if (Number(covenant.state) === 2) {
          const released = await issuer.release(
            bound.covenantId,
            providerResult.receipt.clock.completedAt,
            providerResult.receipt.receiptDigest,
            { relayReceipt: providerResult.receipt },
          );
          record = await state.checkpoint(token, executionId, "coverageReleased", released);
          covenant = await issuer.getCovenant(bound.covenantId);
        }
        if (Number(covenant.state) !== 3) throw new DirectA2mcpError("direct_coverage_release_pending", 503);
      }
      if (providerResult.receipt.response?.recovery) {
        await state.yieldExecution(
          token,
          executionId,
          "provider_delivery_indeterminate_manual_resolution",
        );
        return {
          ok: true,
          replay: false,
          lifecyclePending: true,
          pendingReason: "provider_delivery_indeterminate_manual_resolution",
          quoteId: bound.id,
          covenantId: bound.covenantId,
          feeId: bound.feeId,
          feeState: fee.state,
          feeOutcome: fee.state === 2 ? "captured" : "refunded_after_provider_settlement",
          coverageState: Number(covenant.state),
          providerRelayReceiptId: providerResult.receipt.receiptId,
          providerSettlementTransaction: providerResult.receipt.settlement.transaction,
          providerDeliveryStatus: "settled_response_unavailable_coverage_remains_active",
          completedStages: Object.keys(record.execution.stages || {}),
          relayReceipt: providerResult.receipt,
          providerResponse: null,
        };
      }
      const durableResult = {
        ok: true,
        quoteId: bound.id,
        covenantId: bound.covenantId,
        feeId: bound.feeId,
        feeState: fee.state,
        feeOutcome: fee.state === 2 ? "captured" : "refunded_after_provider_settlement",
        coverageState: Number(covenant.state),
        providerRelayReceiptId: providerResult.receipt.receiptId,
        providerSettlementTransaction: providerResult.receipt.settlement.transaction,
        providerDeliveryStatus: providerResult.upstream
          ? "response_available"
          : "settled_response_unavailable_coverage_remains_active",
      };
      if (
        !(providerResult.receipt.clock.delivered && providerResult.receipt.clock.completedWithinSla)
        && ![3, 5, 6].includes(Number(covenant.state))
      ) {
        await state.yieldExecution(
          token,
          executionId,
          "provider_delivery_breach_reconciliation_pending",
        );
        return {
          ...durableResult,
          replay: false,
          lifecyclePending: true,
          pendingReason: "provider_delivery_breach_reconciliation_pending",
          relayReceipt: providerResult.receipt,
          providerResponse: providerResult.upstream,
        };
      }
      await state.complete(token, executionId, durableResult);
      return {
        ...durableResult,
        replay: false,
        relayReceipt: providerResult.receipt,
        providerResponse: providerResult.upstream,
      };
    } catch (error) {
      let latest = null;
      try {
        latest = await state.resolve(token);
        if (latest.state === "executing") {
          const hasIrreversible = Object.keys(latest.execution?.stages || {}).length > 0;
          if (hasIrreversible) await state.yieldExecution(token, executionId, error?.code || "direct_execution_failed");
          else await state.release(token, executionId);
        }
      } catch {
        // Preserve the original failure; a later lease expiry still permits same-signature recovery.
      }
      if (providerResult?.receipt?.settlement) {
        return {
          ok: true,
          replay: false,
          lifecyclePending: true,
          pendingReason: error?.code || "direct_lifecycle_reconciliation_pending",
          quoteId: bound.id,
          covenantId: bound.covenantId,
          feeId: bound.feeId,
          providerRelayReceiptId: providerResult.receipt.receiptId,
          providerSettlementTransaction: providerResult.receipt.settlement.transaction,
          providerDeliveryStatus: providerResult.upstream
            ? "response_available"
            : "settled_response_unavailable_coverage_remains_active",
          completedStages: Object.keys(latest?.execution?.stages || {}),
          relayReceipt: providerResult.receipt,
          providerResponse: providerResult.upstream,
        };
      }
      if (
        error instanceof DirectA2mcpError
        || error instanceof DirectA2mcpStateError
        || error instanceof ProviderRelayError
        || error instanceof PolicyFeeEscrowError
        || error instanceof UniversalIssuerError
      ) throw error;
      throw new DirectA2mcpError(
        `direct_execution_failed:${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    }
  }

  return { bind, execute, quote };
}

export const __test = {
  directAcceptanceEvidenceHash,
  directJobId,
  feePaymentRequirements,
  verifyFeePayment,
};
