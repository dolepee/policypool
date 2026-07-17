import assert from "node:assert/strict";
import { authorizationTypes } from "@x402/evm";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createChainService, EvidenceError } from "../api/lib/chain.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import { MemoryProviderPolicyStore } from "../api/lib/provider-policy-store.js";
import {
  __test,
  createProviderRelay,
  ProviderRelayError,
  verifyProviderRelayReceipt,
} from "../api/lib/provider-relay.js";
import { sha256 } from "../api/lib/utils.js";

const signer = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca3a545d9ef0ad14f60a17bcaef0aee4170b4818c50675",
);
const buyerSigner = privateKeyToAccount(generatePrivateKey());
const wrongSigner = privateKeyToAccount(generatePrivateKey());
const relayVerifier = "0x9000000000000000000000000000000000000009";
const provider = "0xf4c9fa07f3bb852547fdc4df7c1d9fd9991cfa51";
const buyer = buyerSigner.address;
const paymentTransaction = `0x${"12".repeat(32)}`;
const policy = {
  agentId: "3808",
  serviceIds: ["33461"],
  serviceType: "A2MCP",
  serviceEndpoint: "https://warden.example/audit",
  servicePriceAtomic: "500000",
  providerWallet: provider,
  policyHash: `onchain:0x${"11".repeat(32)}`,
  slaSeconds: 300,
};
const resolver = { async resolve() { return structuredClone(policy); } };
const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
const store = new MemoryProviderPolicyStore();
const targetJobId = `0x${"44".repeat(32)}`;
const covenantId = `0x${"45".repeat(32)}`;
const grant = {
  grantId: "pprg-test",
  covenantId,
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  buyer,
  issuedAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-22T12:00:00.000Z",
};
const secondGrant = { ...grant, grantId: "pprg-test-second" };
let boundGrant;
const grantService = {
  resolve(token) {
    if (token === "signed-relay-grant") return grant;
    if (token === "second-relay-grant") return secondGrant;
    if (token === "bound-relay-grant") return boundGrant;
    assert.fail(`unexpected relay grant token: ${token}`);
  },
};
async function paymentHeader(tag, {
  amount = policy.servicePriceAtomic,
  payTo = provider,
  signingAccount = buyerSigner,
  from = buyer,
  authorizationAtMs = Date.now(),
  maxTimeoutSeconds = 600,
} = {}) {
  const authorization = {
    from: getAddress(from),
    to: getAddress(payTo),
    value: amount,
    validAfter: "0",
    validBefore: String(Math.floor(authorizationAtMs / 1_000) + 600),
    nonce: `0x${sha256(`nonce:${tag}`)}`,
  };
  const signature = await signingAccount.signTypedData({
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
    accepted: {
      scheme: "exact",
      network: XLAYER.network,
      asset: PAYMENT.asset,
      amount,
      payTo,
      maxTimeoutSeconds,
      extra: { name: PAYMENT.name, version: PAYMENT.version },
    },
    payload: {
      signature,
      authorization,
    },
  });
}

function reencodePaymentHeader(raw) {
  const decoded = decodePaymentSignatureHeader(raw);
  const { accepted, payload } = decoded;
  const authorization = payload.authorization;
  return encodePaymentSignatureHeader({
    payload: {
      authorization: {
        nonce: authorization.nonce,
        validBefore: authorization.validBefore,
        validAfter: authorization.validAfter,
        value: authorization.value,
        to: authorization.to,
        from: authorization.from,
      },
      signature: payload.signature,
    },
    accepted: {
      extra: {
        version: accepted.extra.version,
        name: accepted.extra.name,
      },
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      payTo: accepted.payTo,
      amount: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      scheme: accepted.scheme,
    },
    x402Version: decoded.x402Version,
  });
}

function paymentRequiredHeader(accepts = null) {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: {
      url: policy.serviceEndpoint,
      description: "Warden endpoint audit",
      mimeType: "application/json",
    },
    accepts: accepts || [{
      scheme: "exact",
      network: XLAYER.network,
      asset: PAYMENT.asset,
      amount: policy.servicePriceAtomic,
      payTo: provider,
      maxTimeoutSeconds: 600,
      extra: { name: PAYMENT.name, version: PAYMENT.version },
    }],
  });
}

function settlementHeader() {
  return encodePaymentResponseHeader({
    success: true,
    transaction: paymentTransaction,
    network: XLAYER.network,
    payer: buyer,
    amount: policy.servicePriceAtomic,
  });
}

let elapsed = 0;
const relayNowBase = Date.parse("2026-07-16T12:00:00.000Z");
let responseStatus = 402;
const fetchImpl = async (url, options, connection) => {
  assert.equal(url, policy.serviceEndpoint);
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
  assert.deepEqual(connection.records, [{ address: "93.184.216.34", family: 4 }]);
  elapsed += 250;
  const headers = responseStatus === 402
    ? { "content-type": "application/json", "payment-required": paymentRequiredHeader() }
    : { "content-type": "application/json", "payment-response": settlementHeader() };
  return new Response(JSON.stringify({ status: responseStatus === 402 ? "payment_required" : "audit_complete" }), {
    status: responseStatus,
    headers,
  });
};
const chain = {
  async verifyProviderPaymentAuthorization(input) {
    return verifyTypedData({
      address: input.payer,
      domain: {
        name: input.name,
        version: input.version,
        chainId: XLAYER.id,
        verifyingContract: input.asset,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        ...input.authorization,
        value: BigInt(input.authorization.value),
        validAfter: BigInt(input.authorization.validAfter),
        validBefore: BigInt(input.authorization.validBefore),
      },
      signature: input.signature,
    });
  },
  async verifyProviderSettlement(input) {
    assert.deepEqual({ ...input, authorizationNonce: undefined }, {
      txHash: paymentTransaction,
      payer: getAddress(buyer),
      payTo: getAddress(provider),
      asset: getAddress(PAYMENT.asset),
      amountAtomic: policy.servicePriceAtomic,
      authorizationNonce: undefined,
    });
    assert.match(input.authorizationNonce, /^0x[a-fA-F0-9]{64}$/);
    return { ...input, blockNumber: "123" };
  },
};
const relay = createProviderRelay({
  policyResolver: resolver,
  store,
  fetchImpl,
  resolveHost,
  chain,
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
  now: () => relayNowBase + elapsed,
});

const providerRequest = { target_url: "https://policypool.vercel.app/api/covered-job-receipt" };
const probe = await relay.probe({
  agentId: "3808",
  serviceId: "33461",
  providerRequest,
});
assert.equal(probe.accepted.amount, policy.servicePriceAtomic);
assert.equal(probe.accepted.payTo, getAddress(provider));
assert.match(probe.requestHash, /^sha256:[a-f0-9]{64}$/);
assert.match(probe.providerRequirementsHash, /^sha256:[a-f0-9]{64}$/);
boundGrant = {
  ...grant,
  grantId: "pprg-bound",
  providerRequestHash: probe.requestHash,
  providerRequirementsHash: probe.providerRequirementsHash,
};
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest,
    relayGrant: "bound-relay-grant",
  }, {}),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_signature_required",
  "a direct bound grant must not degrade into an unpaid provider replay",
);
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { ...providerRequest, extra: "substituted" },
    relayGrant: "bound-relay-grant",
  }, {}),
  (error) => error instanceof ProviderRelayError && error.code === "provider_request_does_not_match_grant",
  "the paid relay body must exactly match the probed request",
);
const changedRequirementsPayment = await paymentHeader("changed-requirements", { maxTimeoutSeconds: 599 });
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest,
    relayGrant: "bound-relay-grant",
  }, { "payment-signature": changedRequirementsPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_challenge_changed",
  "the signed provider requirements must exactly match the probe",
);
assert.throws(
  () => __test.validateProviderChallenge(paymentRequiredHeader([
    probe.accepted,
    probe.accepted,
  ]), policy, policy.serviceEndpoint),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_challenge_ambiguous",
);

const challenge = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest,
  relayGrant: "signed-relay-grant",
}, {});
assert.equal(challenge.upstream.status, 402);
assert.equal(challenge.receipt.clock, null);
assert.equal(challenge.receipt.request.paymentAuthorizationPresent, false);
assert.equal(challenge.receipt.request.paymentVerified, false);
assert.equal(challenge.receipt.signer, signer.address);
assert.equal(
  await store.getLatestRelayReceiptForJob(targetJobId),
  null,
  "an unpaid challenge must not create a reconciliation pointer",
);

const wrongAmountPayment = await paymentHeader("wrong-amount", { amount: "1" });
const wrongSignaturePayment = await paymentHeader("wrong-signature", { signingAccount: wrongSigner });
const wrongPayerPayment = await paymentHeader("wrong-payer", {
  signingAccount: wrongSigner,
  from: wrongSigner.address,
});
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": "not-a-payment" }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_signature_malformed",
  "a nonempty fake payment header must not reach the provider or consume the relay grant",
);

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": wrongAmountPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_requirements_mismatch",
  "payment authorization must match the live listed service price and provider wallet",
);
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": wrongSignaturePayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_signature_invalid",
  "a structurally valid authorization signed by a different key must fail before relay",
);
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": wrongPayerPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_payer_mismatch",
  "a valid provider payment from a wallet other than the grant-bound buyer must not start the clock",
);

responseStatus = 200;
const validPayment = await paymentHeader("valid-provider-payment");
const reencodedValidPayment = reencodePaymentHeader(validPayment);
assert.notEqual(reencodedValidPayment, validPayment);
const validPayload = decodePaymentSignatureHeader(validPayment);
const validIdentity = await __test.providerPaymentAuthorization(
  validPayment,
  policy,
  chain,
  relayNowBase + elapsed,
);
const reencodedIdentity = await __test.providerPaymentAuthorization(
  reencodedValidPayment,
  policy,
  chain,
  relayNowBase + elapsed,
);
assert.equal(reencodedIdentity.id, validIdentity.id);
assert.equal(reencodedIdentity.hash, validIdentity.hash);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const authorizationUsedEvent = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
const chainBackedVerifier = createChainService({
  client: {
    verifyTypedData,
    async waitForTransactionReceipt() {
      return {
        status: "success",
        blockNumber: 123n,
        logs: [
          {
            address: PAYMENT.asset,
            topics: encodeEventTopics({
              abi: [transferEvent],
              eventName: "Transfer",
              args: { from: buyer, to: provider },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [BigInt(policy.servicePriceAtomic)]),
          },
          {
            address: PAYMENT.asset,
            topics: encodeEventTopics({
              abi: [authorizationUsedEvent],
              eventName: "AuthorizationUsed",
              args: { authorizer: buyer, nonce: validPayload.payload.authorization.nonce },
            }),
            data: "0x",
          },
        ],
      };
    },
  },
});
assert.equal(await chainBackedVerifier.verifyProviderPaymentAuthorization({
  payer: buyer,
  asset: PAYMENT.asset,
  name: PAYMENT.name,
  version: PAYMENT.version,
  authorization: validPayload.payload.authorization,
  signature: validPayload.payload.signature,
}), true);
assert.equal((await chainBackedVerifier.verifyProviderSettlement({
  txHash: paymentTransaction,
  payer: buyer,
  payTo: provider,
  asset: PAYMENT.asset,
  amountAtomic: policy.servicePriceAtomic,
  authorizationNonce: validPayload.payload.authorization.nonce,
})).authorizationNonce, validPayload.payload.authorization.nonce);
await assert.rejects(
  () => chainBackedVerifier.verifyProviderSettlement({
    txHash: paymentTransaction,
    payer: buyer,
    payTo: provider,
    asset: PAYMENT.asset,
    amountAtomic: policy.servicePriceAtomic,
    authorizationNonce: `0x${"ff".repeat(32)}`,
  }),
  (error) => error instanceof EvidenceError
    && error.code === "provider_payment_authorization_event_missing",
  "the settlement transfer must carry the exact signed EIP-3009 authorization nonce",
);
const delivered = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  endpoint: policy.serviceEndpoint,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
}, { "payment-signature": validPayment });
assert.equal(delivered.upstream.status, 200);
assert.equal(delivered.receipt.clock.delivered, true);
assert.equal(delivered.receipt.clock.completedWithinSla, true);
assert.equal(delivered.receipt.request.paymentAuthorizationPresent, true);
assert.equal(delivered.receipt.request.paymentVerified, true);
assert.equal(delivered.receipt.settlement.transaction, paymentTransaction);
assert.equal(delivered.receipt.clock.source, "policypool_relay_verified_x402_settlement");
assert.equal(delivered.receipt.covenantId, covenantId);
assert.equal(delivered.receipt.provider.targetJobId, targetJobId);
assert.equal(await verifyProviderRelayReceipt(delivered.receipt, signer.address, relayVerifier), true);
assert.equal(
  await verifyProviderRelayReceipt(delivered.receipt, signer.address, "0x8000000000000000000000000000000000000008"),
  false,
);
assert.equal(await store.getRelayReceipt(delivered.receipt.receiptId) !== null, true);
assert.deepEqual(
  await store.getRelayResponse(delivered.receipt.receiptId),
  delivered.upstream,
  "the paid provider response must commit atomically with its relay receipt",
);
assert.equal(
  (await store.getLatestRelayReceiptForJob(targetJobId)).receiptId,
  delivered.receipt.receiptId,
  "relay receipt must be indexed by target job for autonomous reconciliation",
);
assert.equal(
  (await store.getRelayReceiptForCovenant(covenantId)).receiptId,
  delivered.receipt.receiptId,
  "relay receipt must be indexed by its exact covenant for reconciliation",
);
const onchainRecoveryStore = new MemoryProviderPolicyStore();
let settlementSearches = 0;
const onchainRecoveryRelay = createProviderRelay({
  policyResolver: resolver,
  store: onchainRecoveryStore,
  fetchImpl: async () => assert.fail("on-chain recovery must not call the provider"),
  resolveHost,
  chain: {
    ...chain,
    async findProviderSettlement(input) {
      settlementSearches += 1;
      return {
        txHash: paymentTransaction,
        blockNumber: "123",
        asset: getAddress(input.asset),
        from: getAddress(input.payer),
        to: getAddress(input.payTo),
        amountAtomic: String(input.amountAtomic),
        authorizationNonce: input.authorizationNonce,
        settledAt: "2026-07-16T12:00:02.000Z",
      };
    },
  },
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
  now: () => relayNowBase + elapsed,
});
const recoveredPayment = await paymentHeader("recover-settled-provider", {
  authorizationAtMs: relayNowBase + elapsed,
});
const recoveredFromChain = await onchainRecoveryRelay.recover({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest,
  relayGrant: "signed-relay-grant",
}, { "payment-signature": recoveredPayment });
assert.equal(recoveredFromChain.recovered, true);
assert.equal(recoveredFromChain.upstream, null);
assert.equal(recoveredFromChain.receipt.clock.delivered, false);
assert.equal(recoveredFromChain.receipt.settlement.transaction, paymentTransaction);
assert.equal(await verifyProviderRelayReceipt(recoveredFromChain.receipt, signer.address, relayVerifier), true);
assert.equal(settlementSearches, 1);
const recoveredFromStore = await onchainRecoveryRelay.recover({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest,
  relayGrant: "signed-relay-grant",
}, { "payment-signature": recoveredPayment });
assert.equal(recoveredFromStore.receipt.receiptId, recoveredFromChain.receipt.receiptId);
assert.equal(settlementSearches, 1, "durable recovery must not scan the chain twice");
responseStatus = 402;
const unpaidAfterPaid = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
}, {});
assert.equal(unpaidAfterPaid.receipt.clock, null);
assert.equal(await store.getRelayReceipt(unpaidAfterPaid.receipt.receiptId) !== null, true);
assert.equal(
  (await store.getLatestRelayReceiptForJob(targetJobId)).receiptId,
  delivered.receipt.receiptId,
  "an unpaid receipt must not replace the verified clock receipt used by reconciliation",
);
assert.equal(
  (await store.getRelayReceiptForCovenant(covenantId)).receiptId,
  delivered.receipt.receiptId,
  "an unpaid receipt must not replace the covenant-bound paid receipt",
);
responseStatus = 200;
const elapsedBeforeLateReuse = elapsed;
elapsed += 48 * 60 * 60 * 1_000;
const lateFreshPayment = await paymentHeader("late-grant-reuse", {
  authorizationAtMs: relayNowBase + elapsed,
});
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": lateFreshPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "a consumed relay grant must remain consumed beyond the former 24-hour claim TTL",
);
elapsed = elapsedBeforeLateReuse;
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "second-relay-grant",
  }, { "payment-signature": reencodedValidPayment }),
  (error) => error instanceof ProviderRelayError
    && error.code === "provider_payment_authorization_already_used",
  "a re-encoded payment authorization must not be reusable under a fresh relay grant",
);

const retryStore = new MemoryProviderPolicyStore();
let retryProviderCalls = 0;
let retrySettlement = null;
const retryRelay = createProviderRelay({
  policyResolver: resolver,
  store: retryStore,
  fetchImpl: async (url, options, connection) => {
    retryProviderCalls += 1;
    assert.equal(url, policy.serviceEndpoint);
    assert.equal(options.method, "POST");
    assert.deepEqual(connection.records, [{ address: "93.184.216.34", family: 4 }]);
    return new Response(JSON.stringify({ status: "audit_complete" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
  resolveHost,
  chain: {
    ...chain,
    async findProviderSettlement() { return retrySettlement; },
  },
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
const retryInput = {
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
};
const retryPayment = await paymentHeader("retry-after-missing-proof");
const differentPayment = await paymentHeader("different-provider-payment");
await assert.rejects(
  () => retryRelay.execute(retryInput, { "payment-signature": retryPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_payment_response_missing",
  "an upstream 200 without settlement evidence must not start a clock or consume the grant",
);
await assert.rejects(
  () => retryRelay.execute(retryInput, { "payment-signature": retryPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "an uncertain paid response must remain reserved instead of forwarding twice",
);
assert.equal(retryProviderCalls, 1);
const retryAuthorization = decodePaymentSignatureHeader(retryPayment).payload.authorization;
retrySettlement = {
  txHash: paymentTransaction,
  blockNumber: "124",
  asset: PAYMENT.asset,
  from: buyer,
  to: provider,
  amountAtomic: policy.servicePriceAtomic,
  authorizationNonce: retryAuthorization.nonce,
  settledAt: "2026-07-16T12:00:02.000Z",
};
const recoveredMissingProof = await retryRelay.recover(
  retryInput,
  { "payment-signature": retryPayment },
);
assert.equal(recoveredMissingProof.recovered, true);
assert.equal(recoveredMissingProof.receipt.request.paymentVerified, true);
assert.equal(retryProviderCalls, 1, "chain recovery must never forward the uncertain request again");

const timeoutStore = new MemoryProviderPolicyStore();
let timeoutProviderCalls = 0;
let timeoutSettlement = null;
const timeoutRelay = createProviderRelay({
  policyResolver: resolver,
  store: timeoutStore,
  fetchImpl: async () => {
    timeoutProviderCalls += 1;
    const error = new Error("response lost after request dispatch");
    error.name = "AbortError";
    throw error;
  },
  resolveHost,
  chain: {
    ...chain,
    async findProviderSettlement() { return timeoutSettlement; },
  },
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
const timeoutPayment = await paymentHeader("timeout-after-provider-dispatch");
await assert.rejects(
  () => timeoutRelay.execute(retryInput, { "payment-signature": timeoutPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_response_timeout",
);
await assert.rejects(
  () => timeoutRelay.execute(retryInput, { "payment-signature": timeoutPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "a response timeout after dispatch must retain the one-shot reservation",
);
const timeoutAuthorization = decodePaymentSignatureHeader(timeoutPayment).payload.authorization;
timeoutSettlement = {
  txHash: paymentTransaction,
  blockNumber: "125",
  asset: PAYMENT.asset,
  from: buyer,
  to: provider,
  amountAtomic: policy.servicePriceAtomic,
  authorizationNonce: timeoutAuthorization.nonce,
  settledAt: "2026-07-16T12:00:03.000Z",
};
assert.equal(
  (await timeoutRelay.recover(retryInput, { "payment-signature": timeoutPayment })).recovered,
  true,
);
assert.equal(timeoutProviderCalls, 1, "timeout recovery must not execute a non-idempotent provider twice");

const atomicFetch = async () => new Response(JSON.stringify({ status: "audit_complete" }), {
  status: 200,
  headers: { "content-type": "application/json", "payment-response": settlementHeader() },
});
const retryableAtomicBacking = new MemoryProviderPolicyStore();
let failBeforeAtomicCommit = true;
let retryableProviderCalls = 0;
const retryableAtomicStore = {
  saveRelayReceipt: (...args) => retryableAtomicBacking.saveRelayReceipt(...args),
  reserveRelayExecution: (...args) => retryableAtomicBacking.reserveRelayExecution(...args),
  releaseRelayExecution: (...args) => retryableAtomicBacking.releaseRelayExecution(...args),
  async commitRelayExecutionReceipt(...args) {
    if (failBeforeAtomicCommit) {
      failBeforeAtomicCommit = false;
      throw new Error("simulated Redis outage before atomic commit");
    }
    return retryableAtomicBacking.commitRelayExecutionReceipt(...args);
  },
};
const retryableAtomicRelay = createProviderRelay({
  policyResolver: resolver,
  store: retryableAtomicStore,
  fetchImpl: async (...args) => {
    retryableProviderCalls += 1;
    return atomicFetch(...args);
  },
  resolveHost,
  chain,
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
const retryableAtomicPayment = await paymentHeader("retryable-atomic-commit");
await assert.rejects(
  () => retryableAtomicRelay.execute(retryInput, { "payment-signature": retryableAtomicPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_relay_commit_failed",
  "a store outage after verified settlement must fail without forgetting that the paid call occurred",
);
assert.equal(await retryableAtomicBacking.getLatestRelayReceiptForJob(targetJobId), null);
await assert.rejects(
  () => retryableAtomicRelay.execute(retryInput, { "payment-signature": retryableAtomicPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "a verified settlement with a failed durable commit must hold its reservation for chain recovery",
);
assert.equal(retryableProviderCalls, 1, "a commit outage after settlement must not call the provider twice");

const uncertainAtomicBacking = new MemoryProviderPolicyStore();
let loseAtomicCommitReply = true;
let uncertainProviderCalls = 0;
const uncertainAtomicStore = {
  saveRelayReceipt: (...args) => uncertainAtomicBacking.saveRelayReceipt(...args),
  getRelayReceiptForCovenant: (...args) => uncertainAtomicBacking.getRelayReceiptForCovenant(...args),
  getRelayResponse: (...args) => uncertainAtomicBacking.getRelayResponse(...args),
  reserveRelayExecution: (...args) => uncertainAtomicBacking.reserveRelayExecution(...args),
  releaseRelayExecution: (...args) => uncertainAtomicBacking.releaseRelayExecution(...args),
  async commitRelayExecutionReceipt(...args) {
    const stored = await uncertainAtomicBacking.commitRelayExecutionReceipt(...args);
    if (loseAtomicCommitReply) {
      loseAtomicCommitReply = false;
      throw new Error("simulated Redis response loss after atomic commit");
    }
    return stored;
  },
};
const uncertainAtomicRelay = createProviderRelay({
  policyResolver: resolver,
  store: uncertainAtomicStore,
  fetchImpl: async (...args) => {
    uncertainProviderCalls += 1;
    return atomicFetch(...args);
  },
  resolveHost,
  chain,
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
const uncertainAtomicPayment = await paymentHeader("uncertain-atomic-commit");
await assert.rejects(
  () => uncertainAtomicRelay.execute(retryInput, { "payment-signature": uncertainAtomicPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_relay_commit_failed",
  "a lost Redis reply after the atomic commit may fail the request but must not lose its receipt",
);
assert.equal(
  (await uncertainAtomicBacking.getLatestRelayReceiptForJob(targetJobId)).request.paymentVerified,
  true,
);
await assert.rejects(
  () => uncertainAtomicRelay.execute(retryInput, { "payment-signature": uncertainAtomicPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "an uncertain response after atomic commit must not forward or settle the provider twice",
);
assert.equal(uncertainProviderCalls, 1);
const recoveredUncertain = await uncertainAtomicRelay.recover(
  retryInput,
  { "payment-signature": uncertainAtomicPayment },
);
assert.equal(recoveredUncertain.recovered, true);
assert.equal(recoveredUncertain.upstream.status, 200);
assert.equal(uncertainProviderCalls, 1, "recovery must not call the paid provider again");

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://different.example" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": differentPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "one relay grant must never authorize two paid provider requests",
);

const replayedPayment = await paymentHeader("replayed-provider-payment");
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "signed-relay-grant",
  }, { "payment-signature": replayedPayment }),
  (error) => error instanceof ProviderRelayError && error.code === "relay_grant_already_used",
  "even an identical paid replay must fail closed instead of executing the provider twice",
);

await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    endpoint: "https://attacker.example/audit",
    providerRequest: { target_url: "https://example.com" },
    relayGrant: "signed-relay-grant",
  }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_endpoint_does_not_match_enrollment",
);

const privateRelay = createProviderRelay({
  policyResolver: resolver,
  store: new MemoryProviderPolicyStore(),
  fetchImpl,
  resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  signer,
  receiptVerifierAddress: relayVerifier,
  grantService,
});
await assert.rejects(
  () => privateRelay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://example.com" },
    relayGrant: "signed-relay-grant",
  }),
  (error) => error instanceof ProviderRelayError && error.code === "provider_endpoint_resolves_private",
);

const pinnedLookup = __test.createPinnedLookup({ address: "93.184.216.34", family: 4 });
const pinnedAddress = await new Promise((resolve, reject) => {
  pinnedLookup("warden.example", {}, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  });
});
assert.deepEqual(pinnedAddress, { address: "93.184.216.34", family: 4 });
assert.equal(__test.privateIp("::ffff:127.0.0.1"), true);
assert.equal(__test.privateIp("ff02::1"), true);

console.log("PolicyPool provider relay passed: buyer-bound payment, pinned DNS, verified settlement, retry-safe grant claims, signed clocks, and covenant index.");
