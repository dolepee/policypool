import assert from "node:assert/strict";
import { authorizationTypes } from "@x402/evm";
import {
  decodePaymentSignatureHeader,
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
const grant = {
  grantId: "pprg-test",
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  buyer,
};
const secondGrant = { ...grant, grantId: "pprg-test-second" };
const grantService = {
  resolve(token) {
    if (token === "signed-relay-grant") return grant;
    if (token === "second-relay-grant") return secondGrant;
    assert.fail(`unexpected relay grant token: ${token}`);
  },
};
async function paymentHeader(tag, {
  amount = policy.servicePriceAtomic,
  payTo = provider,
  signingAccount = buyerSigner,
  from = buyer,
} = {}) {
  const authorization = {
    from: getAddress(from),
    to: getAddress(payTo),
    value: amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1_000) + 600),
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
      maxTimeoutSeconds: 600,
      extra: { name: PAYMENT.name, version: PAYMENT.version },
    },
    payload: {
      signature,
      authorization,
    },
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
let responseStatus = 402;
const fetchImpl = async (url, options, connection) => {
  assert.equal(url, policy.serviceEndpoint);
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
  assert.deepEqual(connection.records, [{ address: "93.184.216.34", family: 4 }]);
  elapsed += 250;
  const headers = responseStatus === 402
    ? { "content-type": "application/json", "payment-required": "challenge" }
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
  now: () => Date.parse("2026-07-16T12:00:00.000Z") + elapsed,
});

const challenge = await relay.execute({
  agentId: "3808",
  serviceId: "33461",
  targetJobId,
  providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
  relayGrant: "signed-relay-grant",
}, {});
assert.equal(challenge.upstream.status, 402);
assert.equal(challenge.receipt.clock, null);
assert.equal(challenge.receipt.request.paymentAuthorizationPresent, false);
assert.equal(challenge.receipt.request.paymentVerified, false);
assert.equal(challenge.receipt.signer, signer.address);

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
const validPayload = decodePaymentSignatureHeader(validPayment);
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
assert.equal(delivered.receipt.provider.targetJobId, targetJobId);
assert.equal(await verifyProviderRelayReceipt(delivered.receipt, signer.address, relayVerifier), true);
assert.equal(
  await verifyProviderRelayReceipt(delivered.receipt, signer.address, "0x8000000000000000000000000000000000000008"),
  false,
);
assert.equal(await store.getRelayReceipt(delivered.receipt.receiptId) !== null, true);
assert.equal(
  (await store.getLatestRelayReceiptForJob(targetJobId)).receiptId,
  delivered.receipt.receiptId,
  "relay receipt must be indexed by target job for autonomous reconciliation",
);
await assert.rejects(
  () => relay.execute({
    agentId: "3808",
    serviceId: "33461",
    targetJobId,
    providerRequest: { target_url: "https://policypool.vercel.app/api/covered-job-receipt" },
    relayGrant: "second-relay-grant",
  }, { "payment-signature": validPayment }),
  (error) => error instanceof ProviderRelayError
    && error.code === "provider_payment_authorization_already_used",
  "a verified payment authorization must not be reusable under a fresh relay grant",
);

let includeSettlementProof = false;
const retryStore = new MemoryProviderPolicyStore();
const retryRelay = createProviderRelay({
  policyResolver: resolver,
  store: retryStore,
  fetchImpl: async (url, options, connection) => {
    assert.equal(url, policy.serviceEndpoint);
    assert.equal(options.method, "POST");
    assert.deepEqual(connection.records, [{ address: "93.184.216.34", family: 4 }]);
    return new Response(JSON.stringify({ status: "audit_complete" }), {
      status: 200,
      headers: includeSettlementProof
        ? { "content-type": "application/json", "payment-response": settlementHeader() }
        : { "content-type": "application/json" },
    });
  },
  resolveHost,
  chain,
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
includeSettlementProof = true;
const retried = await retryRelay.execute(retryInput, { "payment-signature": retryPayment });
assert.equal(retried.receipt.request.paymentVerified, true);
assert.equal(retried.receipt.clock !== null, true, "released reservation must permit a verified retry");

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

console.log("PolicyPool provider relay passed: buyer-bound payment, pinned DNS, verified settlement, retry-safe grant claims, signed clocks, and job index.");
