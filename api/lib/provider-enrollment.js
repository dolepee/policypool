import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
  verifyTypedData,
} from "viem";
import { PAYMENT, XLAYER } from "./config.js";
import {
  fetchOkxAgentPage,
  findOkxAgentService,
  OkxAgentPageError,
} from "./okx-agent-page.js";
import { universalConfiguration } from "./universal-config.js";
import { clean, isBytes32, parseUsdtAtomic, stableStringify } from "./utils.js";

const POLICY_IDENTITY_TYPE =
  "PolicyIdentity(bytes32 marketplace,uint256 agentId,uint256 serviceId,bytes32 serviceFingerprint,bytes32 scopeHash)";
const POLICY_ECONOMICS_TYPE =
  "PolicyEconomics(uint32 slaSeconds,uint32 enrollmentWindowSeconds,uint128 maxCapAtomic,uint16 premiumBps,uint8 payoutBasis,uint8 clockMode,uint64 expiresAt,address adapter)";
const POLICY_TERMS_TYPE = "PolicyTerms(bytes32 identityHash,bytes32 economicsHash)";
const POLICY_IDENTITY_TYPEHASH = keccak256(stringToHex(POLICY_IDENTITY_TYPE));
const POLICY_ECONOMICS_TYPEHASH = keccak256(stringToHex(POLICY_ECONOMICS_TYPE));
const POLICY_TERMS_TYPEHASH = keccak256(stringToHex(POLICY_TERMS_TYPE));
const OKX_MARKETPLACE = keccak256(stringToHex("OKX.AI"));
const ENROLLMENT_DOMAIN = { name: "PolicyPool Provider Enrollment", version: "0.4.0" };
const ENROLLMENT_TYPES = {
  PolicyEnrollment: [
    { name: "provider", type: "address" },
    { name: "policyTermsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const REGISTRY_ABI = parseAbi([
  "function nonces(address provider) view returns (uint256)",
  "function minimumBondAtomic() view returns (uint256)",
  "function latestPolicyId(bytes32 serviceKey) view returns (bytes32)",
  "function isCoverable(bytes32 policyId, bytes32 observedFingerprint) view returns (bool)",
  "function getPolicy(bytes32 policyId) view returns ((bytes32 id, bytes32 serviceKey, address provider, (bytes32 marketplace, uint256 agentId, uint256 serviceId, bytes32 serviceFingerprint, bytes32 scopeHash, uint32 slaSeconds, uint32 enrollmentWindowSeconds, uint128 maxCapAtomic, uint16 premiumBps, uint8 payoutBasis, uint8 clockMode, uint64 expiresAt, address adapter) terms, uint32 version, uint64 registeredAt, bool active, bytes32 suspensionReason))",
  "function registerPolicyBySig(address provider, (bytes32 marketplace,uint256 agentId,uint256 serviceId,bytes32 serviceFingerprint,bytes32 scopeHash,uint32 slaSeconds,uint32 enrollmentWindowSeconds,uint128 maxCapAtomic,uint16 premiumBps,uint8 payoutBasis,uint8 clockMode,uint64 expiresAt,address adapter) terms, uint256 nonce, uint256 deadline, bytes signature) returns (bytes32)",
]);
const POLICY_REGISTERED_EVENT = parseAbiItem(
  "event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed serviceKey, address indexed provider, uint256 agentId, uint256 serviceId, uint32 version, bytes32 serviceFingerprint)",
);
const BOND_ABI = parseAbi([
  "function availableBond(address provider) view returns (uint256)",
]);

export class ProviderEnrollmentError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "ProviderEnrollmentError";
    this.code = code;
    this.status = status;
  }
}

function integer(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProviderEnrollmentError(`${field}_invalid`);
  }
  return parsed;
}

function normalizeScope(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const deliveryPromise = clean(source.deliveryPromise, 600);
  const objectiveBreach = clean(source.objectiveBreach, 600);
  const exclusions = Array.isArray(source.exclusions)
    ? source.exclusions.map((item) => clean(item, 180)).filter(Boolean).slice(0, 12)
    : [];
  const coveredKeywords = Array.isArray(source.coveredKeywords)
    ? source.coveredKeywords
      .map((item) => clean(item, 60).toLowerCase())
      .filter((item) => /^[a-z0-9][a-z0-9 ._/-]{1,59}$/.test(item))
      .slice(0, 20)
    : [];
  if (!deliveryPromise) throw new ProviderEnrollmentError("delivery_promise_required");
  if (!objectiveBreach) throw new ProviderEnrollmentError("objective_breach_required");
  if (coveredKeywords.length === 0) throw new ProviderEnrollmentError("covered_keywords_required");
  return { deliveryPromise, objectiveBreach, exclusions, coveredKeywords };
}

function policyTermsHash(terms) {
  const identityHash = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      POLICY_IDENTITY_TYPEHASH,
      terms.marketplace,
      BigInt(terms.agentId),
      BigInt(terms.serviceId),
      terms.serviceFingerprint,
      terms.scopeHash,
    ],
  ));
  const economicsHash = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint128" },
      { type: "uint16" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "uint64" },
      { type: "address" },
    ],
    [
      POLICY_ECONOMICS_TYPEHASH,
      terms.slaSeconds,
      terms.enrollmentWindowSeconds,
      BigInt(terms.maxCapAtomic),
      terms.premiumBps,
      terms.payoutBasis,
      terms.clockMode,
      BigInt(terms.expiresAt),
      terms.adapter,
    ],
  ));
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [POLICY_TERMS_TYPEHASH, identityHash, economicsHash],
  ));
}

function serializableTerms(terms) {
  return {
    ...terms,
    agentId: String(terms.agentId),
    serviceId: String(terms.serviceId),
    maxCapAtomic: String(terms.maxCapAtomic),
    expiresAt: String(terms.expiresAt),
  };
}

function contractTerms(terms) {
  return {
    marketplace: terms.marketplace,
    agentId: BigInt(terms.agentId),
    serviceId: BigInt(terms.serviceId),
    serviceFingerprint: terms.serviceFingerprint,
    scopeHash: terms.scopeHash,
    slaSeconds: terms.slaSeconds,
    enrollmentWindowSeconds: terms.enrollmentWindowSeconds,
    maxCapAtomic: BigInt(terms.maxCapAtomic),
    premiumBps: terms.premiumBps,
    payoutBasis: terms.payoutBasis,
    clockMode: terms.clockMode,
    expiresAt: BigInt(terms.expiresAt),
    adapter: terms.adapter,
  };
}

function createDefaultClient() {
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

export function createProviderEnrollmentService({
  client = createDefaultClient(),
  directory = fetchOkxAgentPage,
  store,
  configuration = universalConfiguration(),
  now = () => Date.now(),
  signatureTtlSeconds = 600,
} = {}) {
  if (!store?.savePolicy) throw new ProviderEnrollmentError("provider_policy_store_unavailable", 503);

  function requireReady() {
    if (!configuration.ready) throw new ProviderEnrollmentError("universal_enrollment_not_active", 503);
  }

  async function prepare(input) {
    requireReady();
    let snapshot;
    try {
      snapshot = await directory(input?.agentId);
    } catch (error) {
      if (error instanceof OkxAgentPageError) throw new ProviderEnrollmentError(error.code);
      throw new ProviderEnrollmentError("okx_agent_directory_unavailable", 503);
    }
    const service = findOkxAgentService(snapshot, input?.serviceId);
    if (snapshot.stale) throw new ProviderEnrollmentError("okx_agent_directory_stale", 503);
    if (!service) throw new ProviderEnrollmentError("okx_service_not_found");
    const provider = getAddress(snapshot.ownerAddress);
    if (input?.provider && getAddress(input.provider) !== provider) {
      throw new ProviderEnrollmentError("provider_does_not_own_agent");
    }

    const scope = normalizeScope(input?.scope);
    const slaSeconds = integer(input?.slaSeconds, "sla_seconds", 1, configuration.maximumSlaSeconds);
    const enrollmentWindowSeconds = integer(
      input?.enrollmentWindowSeconds,
      "enrollment_window_seconds",
      1,
      slaSeconds,
    );
    const premiumBps = integer(input?.premiumBps ?? 0, "premium_bps", 0, 10_000);
    if (premiumBps !== 0) throw new ProviderEnrollmentError("provider_premium_not_supported_v04");
    const payoutBasis = {
      net_loss: 0,
      provider_bonded_sla_credit: 1,
    }[clean(input?.payoutBasis, 60).toLowerCase()];
    if (payoutBasis === undefined) throw new ProviderEnrollmentError("payout_basis_invalid");
    const requestedClock = clean(input?.clockMode, 60).toLowerCase();
    const expectedClock = service.serviceType === "A2A" ? "verified_acceptance" : "policypool_relay";
    if (requestedClock !== expectedClock) throw new ProviderEnrollmentError("clock_mode_service_type_mismatch");
    const clockMode = expectedClock === "verified_acceptance" ? 0 : 1;
    const maxCapAtomic = parseUsdtAtomic(input?.maxCapUSDT, PAYMENT.decimals);
    if (maxCapAtomic <= 0n) throw new ProviderEnrollmentError("max_cap_invalid");
    const currentSeconds = Math.floor(now() / 1000);
    const expiresAt = integer(
      input?.expiresAt,
      "expires_at",
      currentSeconds + slaSeconds + 1,
      currentSeconds + 365 * 24 * 60 * 60,
    );

    const [nonce, minimumBondAtomic, availableBondAtomic] = await Promise.all([
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "nonces",
        args: [provider],
      }),
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "minimumBondAtomic",
      }),
      client.readContract({
        address: configuration.bondVault,
        abi: BOND_ABI,
        functionName: "availableBond",
        args: [provider],
      }),
    ]);
    if (BigInt(availableBondAtomic) < BigInt(minimumBondAtomic)) {
      throw new ProviderEnrollmentError("provider_bond_below_minimum");
    }
    if (maxCapAtomic > BigInt(availableBondAtomic)) {
      throw new ProviderEnrollmentError("policy_cap_exceeds_available_bond");
    }

    const terms = {
      marketplace: OKX_MARKETPLACE,
      agentId: snapshot.agentId,
      serviceId: service.serviceId,
      serviceFingerprint: service.fingerprint,
      scopeHash: keccak256(stringToHex(stableStringify(scope))),
      slaSeconds,
      enrollmentWindowSeconds,
      maxCapAtomic: maxCapAtomic.toString(),
      premiumBps,
      payoutBasis,
      clockMode,
      expiresAt: String(expiresAt),
      adapter: service.serviceType === "A2A" ? configuration.a2aAdapter : configuration.relayAdapter,
    };
    const termsHash = policyTermsHash(terms);
    const deadline = input?.signatureDeadline
      ? integer(
        input.signatureDeadline,
        "signature_deadline",
        currentSeconds + 1,
        currentSeconds + signatureTtlSeconds,
      )
      : currentSeconds + signatureTtlSeconds;
    const typedData = {
      domain: {
        ...ENROLLMENT_DOMAIN,
        chainId: XLAYER.id,
        verifyingContract: configuration.policyRegistry,
      },
      types: ENROLLMENT_TYPES,
      primaryType: "PolicyEnrollment",
      message: {
        provider,
        policyTermsHash: termsHash,
        nonce: BigInt(nonce).toString(),
        deadline: String(deadline),
      },
    };
    return {
      version: configuration.version,
      provider,
      agent: {
        agentId: snapshot.agentId,
        name: snapshot.name,
        publicUrl: snapshot.publicUrl,
        service,
      },
      scope,
      terms: serializableTerms(terms),
      policyTermsHash: termsHash,
      nonce: BigInt(nonce).toString(),
      signatureDeadline: String(deadline),
      bond: {
        asset: PAYMENT.asset,
        minimumAtomic: BigInt(minimumBondAtomic).toString(),
        availableAtomic: BigInt(availableBondAtomic).toString(),
      },
      typedData,
    };
  }

  async function submit(input) {
    const prepared = await prepare(input);
    if (String(input?.nonce) !== prepared.nonce || String(input?.signatureDeadline) !== prepared.signatureDeadline) {
      throw new ProviderEnrollmentError("enrollment_preparation_stale");
    }
    const signature = clean(input?.signature, 300);
    if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
      throw new ProviderEnrollmentError("enrollment_signature_invalid");
    }
    const valid = await verifyTypedData({
      address: prepared.provider,
      ...prepared.typedData,
      message: {
        ...prepared.typedData.message,
        nonce: BigInt(prepared.nonce),
        deadline: BigInt(prepared.signatureDeadline),
      },
      signature,
    });
    if (!valid) throw new ProviderEnrollmentError("enrollment_signature_invalid");

    const data = encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "registerPolicyBySig",
      args: [
        prepared.provider,
        contractTerms(prepared.terms),
        BigInt(prepared.nonce),
        BigInt(prepared.signatureDeadline),
        signature,
      ],
    });
    const record = await store.savePolicy({
      status: "signed_pending_onchain_registration",
      createdAt: new Date(now()).toISOString(),
      providerWallet: prepared.provider,
      agentId: prepared.agent.agentId,
      agentName: prepared.agent.name,
      serviceId: prepared.agent.service.serviceId,
      serviceName: prepared.agent.service.name,
      serviceType: prepared.agent.service.serviceType,
      serviceEndpoint: prepared.agent.service.endpoint,
      serviceFingerprint: prepared.agent.service.fingerprint,
      servicePublicUrl: prepared.agent.publicUrl,
      scope: prepared.scope,
      policyTermsHash: prepared.policyTermsHash,
      terms: prepared.terms,
      nonce: prepared.nonce,
      signatureDeadline: prepared.signatureDeadline,
      signature,
    });
    return {
      ok: true,
      enrollment: record,
      transaction: {
        chainId: XLAYER.id,
        to: configuration.policyRegistry,
        data,
        value: "0",
      },
      activation: "pending_onchain_registration",
    };
  }

  async function confirm(input) {
    requireReady();
    const enrollmentId = clean(input?.enrollmentId || input?.policyId, 100);
    const txHash = clean(input?.transactionHash || input?.txHash, 100);
    if (!enrollmentId) throw new ProviderEnrollmentError("enrollment_id_required");
    if (!isBytes32(txHash)) throw new ProviderEnrollmentError("registration_transaction_invalid");
    const enrollment = await store.getPolicy(enrollmentId);
    if (!enrollment) throw new ProviderEnrollmentError("enrollment_not_found", 404);
    if (enrollment.status === "active") return { ok: true, enrollment, idempotentReplay: true };
    if (enrollment.status !== "signed_pending_onchain_registration") {
      throw new ProviderEnrollmentError("enrollment_state_invalid");
    }

    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch {
      throw new ProviderEnrollmentError("registration_transaction_unconfirmed", 503);
    }
    if (receipt.status !== "success" || receipt.to?.toLowerCase() !== configuration.policyRegistry.toLowerCase()) {
      throw new ProviderEnrollmentError("registration_transaction_invalid");
    }
    let registered;
    for (const log of receipt.logs || []) {
      if (log.address.toLowerCase() !== configuration.policyRegistry.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [POLICY_REGISTERED_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName === "PolicyRegistered") {
          registered = decoded.args;
          break;
        }
      } catch {
        // Ignore unrelated registry logs.
      }
    }
    if (!registered) throw new ProviderEnrollmentError("policy_registered_event_missing");
    if (
      getAddress(registered.provider) !== getAddress(enrollment.providerWallet)
      || String(registered.agentId) !== enrollment.agentId
      || String(registered.serviceId) !== enrollment.serviceId
      || registered.serviceFingerprint.toLowerCase() !== enrollment.serviceFingerprint.toLowerCase()
    ) {
      throw new ProviderEnrollmentError("policy_registered_event_mismatch");
    }

    const snapshot = await directory(enrollment.agentId);
    if (snapshot.stale) throw new ProviderEnrollmentError("okx_agent_directory_stale", 503);
    const service = findOkxAgentService(snapshot, enrollment.serviceId);
    if (!service || service.fingerprint.toLowerCase() !== enrollment.serviceFingerprint.toLowerCase()) {
      throw new ProviderEnrollmentError("service_fingerprint_changed_since_signature");
    }
    const [latestPolicyId, coverable, registeredPolicy] = await Promise.all([
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "latestPolicyId",
        args: [registered.serviceKey],
      }),
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "isCoverable",
        args: [registered.policyId, enrollment.serviceFingerprint],
      }),
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "getPolicy",
        args: [registered.policyId],
      }),
    ]);
    if (latestPolicyId.toLowerCase() !== registered.policyId.toLowerCase() || !coverable) {
      throw new ProviderEnrollmentError("registered_policy_not_coverable");
    }
    let registeredTermsHash;
    try {
      if (
        registeredPolicy.id.toLowerCase() !== registered.policyId.toLowerCase()
        || registeredPolicy.serviceKey.toLowerCase() !== registered.serviceKey.toLowerCase()
        || getAddress(registeredPolicy.provider) !== getAddress(enrollment.providerWallet)
        || Number(registeredPolicy.version) !== Number(registered.version)
        || registeredPolicy.active !== true
      ) {
        throw new Error("registered policy metadata mismatch");
      }
      registeredTermsHash = policyTermsHash(registeredPolicy.terms);
    } catch {
      throw new ProviderEnrollmentError("policy_registered_terms_mismatch");
    }
    if (registeredTermsHash.toLowerCase() !== enrollment.policyTermsHash.toLowerCase()) {
      throw new ProviderEnrollmentError("policy_registered_terms_mismatch");
    }
    const activated = await store.updatePolicy(enrollmentId, {
      status: "active",
      activatedAt: new Date(now()).toISOString(),
      registrationTransactionHash: txHash,
      onchainPolicyId: registered.policyId,
      serviceKey: registered.serviceKey,
      onchainVersion: Number(registered.version),
    });
    return { ok: true, enrollment: activated, idempotentReplay: false };
  }

  return { prepare, submit, confirm };
}

export const __test = {
  ENROLLMENT_TYPES,
  OKX_MARKETPLACE,
  policyTermsHash,
};
