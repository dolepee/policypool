import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryProviderPolicyStore } from "../api/lib/provider-policy-store.js";
import {
  createProviderEnrollmentService,
  ProviderEnrollmentError,
} from "../api/lib/provider-enrollment.js";
import {
  computeNetLossPayout,
  computeProviderCoverageCapacity,
} from "../api/lib/provider-exposure.js";
import { createUniversalPolicyResolver, UniversalPolicyError } from "../api/lib/universal-policy.js";
import { createCoverageDemandService } from "../api/lib/coverage-demand.js";

const provider = privateKeyToAccount(
  "0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const configuration = {
  ready: true,
  enabled: true,
  version: "0.4.0",
  policyRegistry: "0x1000000000000000000000000000000000000001",
  bondVault: "0x2000000000000000000000000000000000000002",
  a2aAdapter: "0x3000000000000000000000000000000000000003",
  relayAdapter: "0x4000000000000000000000000000000000000004",
  maximumSlaSeconds: 604800,
};
const snapshot = {
  agentId: "3808",
  name: "WARDEN",
  ownerAddress: provider.address.toLowerCase(),
  publicUrl: "https://www.okx.ai/agents/3808",
  services: [{
    agentId: "3808",
    serviceId: "33461",
    name: "Agent Endpoint Security Audit",
    description: "Deterministic endpoint security audit.",
    serviceType: "A2MCP",
    endpoint: "https://warden.example/audit",
    price: "0.5",
    fingerprint: `0x${"ab".repeat(32)}`,
  }],
};
const nowMs = Date.parse("2026-07-16T12:00:00.000Z");
const reads = {
  nonces: 3n,
  minimumBondAtomic: 500_000n,
  availableBond: 2_000_000n,
};
const onchainPolicyId = `0x${"11".repeat(32)}`;
const serviceKey = `0x${"22".repeat(32)}`;
let registrationReceipt;
const client = {
  async readContract({ functionName }) {
    if (functionName === "latestPolicyId") return onchainPolicyId;
    if (functionName === "isCoverable") return true;
    return reads[functionName];
  },
  async getTransactionReceipt() {
    return registrationReceipt;
  },
};
const directory = async () => structuredClone(snapshot);
const store = new MemoryProviderPolicyStore();
const service = createProviderEnrollmentService({
  client,
  directory,
  store,
  configuration,
  now: () => nowMs,
});
const input = {
  agentId: "3808",
  serviceId: "33461",
  provider: provider.address,
  scope: {
    deliveryPromise: "Return the standard 20-payload deterministic endpoint audit.",
    objectiveBreach: "No audit result within 300 seconds after the endpoint receives the funded request.",
    coveredKeywords: ["endpoint", "audit", "security", "payload"],
    exclusions: ["OKX routing delay before WARDEN receives the request", "Custom batteries above 20 payloads"],
  },
  slaSeconds: 300,
  enrollmentWindowSeconds: 60,
  maxCapUSDT: "0.5",
  premiumBps: 0,
  payoutBasis: "provider_bonded_sla_credit",
  clockMode: "policypool_relay",
  expiresAt: Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60,
};

const prepared = await service.prepare(input);
assert.equal(prepared.provider, provider.address);
assert.equal(prepared.agent.service.serviceId, "33461");
assert.equal(prepared.nonce, "3");
assert.equal(prepared.terms.maxCapAtomic, "500000");
assert.equal(prepared.terms.payoutBasis, 1);
assert.equal(prepared.terms.clockMode, 1);
assert.equal(prepared.terms.premiumBps, 0);
assert.equal(prepared.bond.availableAtomic, "2000000");

const signature = await provider.signTypedData({
  ...prepared.typedData,
  message: {
    ...prepared.typedData.message,
    nonce: BigInt(prepared.nonce),
    deadline: BigInt(prepared.signatureDeadline),
  },
});
const submitted = await service.submit({
  ...input,
  nonce: prepared.nonce,
  signatureDeadline: prepared.signatureDeadline,
  signature,
});
assert.equal(submitted.ok, true);
assert.equal(submitted.activation, "pending_onchain_registration");
assert.equal(submitted.transaction.to, configuration.policyRegistry);
assert.match(submitted.transaction.data, /^0x[a-f0-9]+$/);
assert.equal((await store.listPolicies()).length, 1);

const policyRegisteredEvent = parseAbiItem(
  "event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed serviceKey, address indexed provider, uint256 agentId, uint256 serviceId, uint32 version, bytes32 serviceFingerprint)",
);
registrationReceipt = {
  status: "success",
  to: configuration.policyRegistry,
  logs: [{
    address: configuration.policyRegistry,
    topics: encodeEventTopics({
      abi: [policyRegisteredEvent],
      eventName: "PolicyRegistered",
      args: { policyId: onchainPolicyId, serviceKey, provider: provider.address },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }],
      [3808n, 33461n, 1, snapshot.services[0].fingerprint],
    ),
  }],
};
const registrationTx = `0x${"33".repeat(32)}`;
const confirmed = await service.confirm({
  enrollmentId: submitted.enrollment.policyId,
  transactionHash: registrationTx,
});
assert.equal(confirmed.enrollment.status, "active");
assert.equal(confirmed.enrollment.onchainPolicyId, onchainPolicyId);
assert.equal(confirmed.enrollment.registrationTransactionHash, registrationTx);
const confirmedAgain = await service.confirm({
  enrollmentId: submitted.enrollment.policyId,
  transactionHash: registrationTx,
});
assert.equal(confirmedAgain.idempotentReplay, true);

const resolver = createUniversalPolicyResolver({
  store,
  client,
  directory,
  configuration,
  now: () => nowMs,
});
const resolvedPolicy = await resolver.resolve({ agentId: "3808", serviceId: "33461" });
assert.equal(resolvedPolicy.agentName, "WARDEN");
assert.equal(resolvedPolicy.policyHash, `onchain:${onchainPolicyId}`);
assert.equal(resolvedPolicy.clockSource, "policypool_relay_received_at");
assert.deepEqual(resolvedPolicy.allowedKeywords, ["endpoint", "audit", "security", "payload"]);

const changedSnapshot = structuredClone(snapshot);
changedSnapshot.services[0].fingerprint = `0x${"cd".repeat(32)}`;
const changedResolver = createUniversalPolicyResolver({
  store,
  client,
  directory: async () => changedSnapshot,
  configuration,
  now: () => nowMs,
});
await assert.rejects(
  () => changedResolver.resolve({ agentId: "3808", serviceId: "33461" }),
  (error) => error instanceof UniversalPolicyError && error.code === "target_service_fingerprint_changed",
);

const demandStore = new MemoryProviderPolicyStore();
let demandNow = nowMs;
const demandService = createCoverageDemandService({
  store: demandStore,
  directory,
  now: () => demandNow,
});
const demand = await demandService.record({
  agentId: "3808",
  serviceId: "33461",
  taskReference: "https://www.okx.ai/tasks/405668",
  requestedCoverageUSDT: "0.5",
  buyerWallet: provider.address,
});
assert.equal(demand.buyerCharged, false);
assert.equal(demand.demand.requestedCoverageAtomic, "500000");
assert.equal("buyerWallet" in demand.demand, false);
assert.match(demand.enrollmentInvite, /agent=3808&service=33461&demand=ppd-/);
demandNow += 60_000;
const duplicateDemand = await demandService.record({
  agentId: "3808",
  serviceId: "33461",
  taskReference: "https://www.okx.ai/tasks/405668",
  requestedCoverageUSDT: "0.5",
});
assert.equal(duplicateDemand.demand.demandId, demand.demand.demandId);
assert.equal((await demandStore.listDemand()).length, 1, "repeat attempts for one task must not inflate demand");
const distinctDemand = await demandService.record({
  agentId: "3808",
  serviceId: "33461",
  taskReference: "https://www.okx.ai/tasks/405669",
  requestedCoverageUSDT: "0.5",
});
assert.notEqual(distinctDemand.demand.demandId, demand.demand.demandId);
assert.equal((await demandStore.listDemand()).length, 2);

await assert.rejects(
  () => service.prepare({ ...input, provider: "0x4000000000000000000000000000000000000004" }),
  (error) => error instanceof ProviderEnrollmentError && error.code === "provider_does_not_own_agent",
);
await assert.rejects(
  () => service.prepare({ ...input, premiumBps: 1 }),
  (error) => error instanceof ProviderEnrollmentError && error.code === "provider_premium_not_supported_v04",
);
reads.availableBond = 100_000n;
await assert.rejects(
  () => service.prepare(input),
  (error) => error instanceof ProviderEnrollmentError && error.code === "provider_bond_below_minimum",
);
reads.availableBond = 2_000_000n;

const firstLossOnly = computeProviderCoverageCapacity({
  requestedAtomic: 1_000_000n,
  jobValueAtomic: 1_000_000n,
  policyCapAtomic: 1_000_000n,
  providerBondAtomic: 2_000_000n,
  providerAvailableBondAtomic: 800_000n,
  providerOutstandingAtomic: 1_200_000n,
  sharedReserveAvailableAtomic: 5_000_000n,
  sharedExposureMultiplierBps: 10_000,
  sharedCoverageEnabled: false,
});
assert.equal(firstLossOnly.capAtomic, 800_000n);
assert.equal(firstLossOnly.providerFirstLossAtomic, 800_000n);
assert.equal(firstLossOnly.sharedCoverageAtomic, 0n);

const coCovered = computeProviderCoverageCapacity({
  requestedAtomic: 1_000_000n,
  jobValueAtomic: 1_000_000n,
  policyCapAtomic: 1_000_000n,
  providerBondAtomic: 500_000n,
  providerAvailableBondAtomic: 500_000n,
  providerOutstandingAtomic: 0,
  sharedReserveAvailableAtomic: 5_000_000n,
  providerSharedOutstandingAtomic: 200_000n,
  sharedExposureMultiplierBps: 10_000,
  sharedCoverageEnabled: true,
});
assert.equal(coCovered.providerFirstLossAtomic, 500_000n);
assert.equal(coCovered.sharedCoverageAtomic, 300_000n);
assert.equal(coCovered.capAtomic, 800_000n);

const netLoss = computeNetLossPayout({
  coverageCapAtomic: 500_000n,
  buyerPaidAtomic: 500_000n,
  escrowRefundAtomic: 400_000n,
  otherRecoveryAtomic: 25_000n,
});
assert.equal(netLoss.payoutAtomic, 75_000n);
assert.equal(netLoss.netLossAtomic, 75_000n);
assert.equal(netLoss.totalRecoveryAtomic, 425_000n);

const noDoubleRecovery = computeNetLossPayout({
  coverageCapAtomic: 500_000n,
  buyerPaidAtomic: 500_000n,
  escrowRefundAtomic: 500_000n,
});
assert.equal(noDoubleRecovery.payoutAtomic, 0n);
assert.equal(noDoubleRecovery.fullyRecovered, true);

console.log("PolicyPool provider enrollment passed: ownership, bond, signed terms, deduplicated demand, exposure, and net-loss gates.");
