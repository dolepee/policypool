import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { XLAYER } from "./config.js";
import { fetchOkxAgentPage, findOkxAgentService } from "./okx-agent-page.js";
import { universalConfiguration } from "./universal-config.js";

const REGISTRY_ABI = parseAbi([
  "function isCoverable(bytes32 policyId, bytes32 observedFingerprint) view returns (bool)",
]);
const BOND_ABI = parseAbi([
  "function availableBond(address provider) view returns (uint256)",
]);

export class UniversalPolicyError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "UniversalPolicyError";
    this.code = code;
    this.status = status;
  }
}

function id(value, field) {
  const normalized = String(value || "").trim().replace(/^#/, "");
  if (!/^\d{1,12}$/.test(normalized) || Number(normalized) <= 0) {
    throw new UniversalPolicyError(`${field}_invalid`);
  }
  return normalized;
}

function defaultClient() {
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

export function createUniversalPolicyResolver({
  store,
  client = defaultClient(),
  directory = fetchOkxAgentPage,
  configuration = universalConfiguration(),
  now = () => Date.now(),
} = {}) {
  if (!store?.getLatestPolicy) throw new UniversalPolicyError("provider_policy_store_unavailable", 503);

  async function resolve({ agentId: agentInput, serviceId: serviceInput }) {
    if (!configuration.ready) throw new UniversalPolicyError("universal_coverage_not_active", 503);
    const agentId = id(agentInput, "target_agent_id");
    const serviceId = id(serviceInput, "target_service_id");
    const record = await store.getLatestPolicy(agentId, serviceId);
    if (!record) throw new UniversalPolicyError("target_policy_not_registered", 404);
    if (record.status !== "active" || !record.onchainPolicyId) {
      throw new UniversalPolicyError("target_policy_not_active");
    }
    if (Number(record.terms?.expiresAt || 0) <= Math.floor(now() / 1000)) {
      throw new UniversalPolicyError("target_policy_expired");
    }

    const snapshot = await directory(agentId);
    if (snapshot.stale) throw new UniversalPolicyError("okx_agent_directory_stale", 503);
    if (snapshot.ownerAddress.toLowerCase() !== record.providerWallet.toLowerCase()) {
      throw new UniversalPolicyError("target_provider_owner_changed");
    }
    const service = findOkxAgentService(snapshot, serviceId);
    if (!service) throw new UniversalPolicyError("target_service_not_listed");
    if (service.fingerprint.toLowerCase() !== record.serviceFingerprint.toLowerCase()) {
      throw new UniversalPolicyError("target_service_fingerprint_changed");
    }
    const [coverable, availableBondAtomic] = await Promise.all([
      client.readContract({
        address: configuration.policyRegistry,
        abi: REGISTRY_ABI,
        functionName: "isCoverable",
        args: [record.onchainPolicyId, service.fingerprint],
      }),
      client.readContract({
        address: configuration.bondVault,
        abi: BOND_ABI,
        functionName: "availableBond",
        args: [record.providerWallet],
      }),
    ]);
    if (!coverable) throw new UniversalPolicyError("target_policy_not_coverable");

    return {
      agentId,
      agentName: snapshot.name,
      providerWallet: record.providerWallet,
      serviceIds: [serviceId],
      serviceName: service.name,
      serviceType: service.serviceType,
      serviceEndpoint: service.endpoint,
      serviceFingerprint: service.fingerprint,
      publishedScope: [record.scope.deliveryPromise, record.scope.objectiveBreach],
      requiredInputs: [],
      allowedKeywords: record.scope.coveredKeywords,
      slaSeconds: Number(record.terms.slaSeconds),
      enrollmentWindowSeconds: Number(record.terms.enrollmentWindowSeconds),
      maxCoverageAtomic: String(record.terms.maxCapAtomic),
      providerAvailableBondAtomic: BigInt(availableBondAtomic).toString(),
      premiumBps: Number(record.terms.premiumBps),
      payoutBasis: Number(record.terms.payoutBasis) === 1
        ? "provider_bonded_sla_credit"
        : "net_loss",
      clockMode: Number(record.terms.clockMode) === 1 ? "policypool_relay" : "verified_acceptance",
      expiresAt: new Date(Number(record.terms.expiresAt) * 1000).toISOString(),
      coverageStatus: "active",
      policyHash: `onchain:${record.onchainPolicyId}`,
      onchainPolicyId: record.onchainPolicyId,
      policyVersion: Number(record.onchainVersion),
      clockSource: service.serviceType === "A2A"
        ? "verified_acceptance_block"
        : "policypool_relay_received_at",
      processingStart: service.serviceType === "A2A"
        ? "verified target-job acceptance"
        : "funded request received by the PolicyPool relay",
      exclusions: record.scope.exclusions || [],
      source: {
        kind: "provider-signed onchain policy plus live OKX.AI service fingerprint",
        registrationTransactionHash: record.registrationTransactionHash,
        servicePublicUrl: record.servicePublicUrl,
      },
    };
  }

  return { resolve };
}
