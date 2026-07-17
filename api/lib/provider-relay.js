import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, keccak256, stringToHex, verifyTypedData } from "viem";
import { createChainService } from "./chain.js";
import { PAYMENT, XLAYER } from "./config.js";
import { clean, isBytes32, sha256, stableStringify } from "./utils.js";
import { RelayGrantError } from "./relay-grant.js";

const MAX_REQUEST_BYTES = 256_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PROBE_TIMEOUT_MS = 15_000;
const FORWARDED_HEADERS = ["accept", "content-type", "payment-signature", "x-payment"];
const RETURNED_HEADERS = ["content-type", "payment-required", "payment-response", "x-payment-response"];
const RELAY_RECEIPT_TYPES = {
  RelayReceipt: [{ name: "receiptDigest", type: "bytes32" }],
};

export class ProviderRelayError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "ProviderRelayError";
    this.code = code;
    this.status = status;
  }
}

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 0 && parts[2] === 0)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function privateIp(address) {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (
    normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("::ffff:")
  ) return true;
  const firstHextet = Number.parseInt(normalized.split(":")[0], 16);
  return !Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff;
}

async function verifyPublicEndpoint(value, resolveHost = lookup) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProviderRelayError("provider_endpoint_invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new ProviderRelayError("provider_endpoint_not_allowed");
  }
  let records;
  try {
    records = await resolveHost(endpoint.hostname, { all: true, verbatim: true });
  } catch {
    throw new ProviderRelayError("provider_endpoint_dns_failed", 503);
  }
  if (!Array.isArray(records) || records.length === 0 || records.some((record) => privateIp(record.address))) {
    throw new ProviderRelayError("provider_endpoint_resolves_private");
  }
  return {
    endpoint,
    records: records.map((record) => ({ address: record.address, family: isIP(record.address) })),
  };
}

function createPinnedLookup(record) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, [record]);
    return callback(null, record.address, record.family);
  };
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, String(value));
  }
  return headers;
}

function requestPinnedEndpoint(endpoint, options, record) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: options.method,
      headers: options.headers,
      lookup: createPinnedLookup(record),
      servername: endpoint.hostname,
      rejectUnauthorized: true,
      signal: options.signal,
    }, (incoming) => {
      const status = Number(incoming.statusCode || 0);
      if (status >= 300 && status < 400) {
        incoming.resume();
        reject(new ProviderRelayError("provider_endpoint_redirect_not_allowed", 502));
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          incoming.destroy(new ProviderRelayError("provider_response_too_large", 502));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers: responseHeaders(incoming.headers) }));
      });
      incoming.on("error", reject);
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function fetchPinnedEndpoint(endpoint, options, records) {
  let lastError;
  for (const record of records) {
    try {
      return await requestPinnedEndpoint(endpoint, options, record);
    } catch (error) {
      if (error instanceof ProviderRelayError || error?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError || new ProviderRelayError("provider_endpoint_unreachable", 502);
}

function paymentHeader(headers) {
  return clean(headers?.["payment-signature"] || headers?.["x-payment"], 16_000);
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function normalizedAcceptedRequirements(accepted) {
  return {
    ...accepted,
    asset: getAddress(accepted.asset),
    payTo: getAddress(accepted.payTo),
    amount: String(accepted.amount),
    maxTimeoutSeconds: Number(accepted.maxTimeoutSeconds),
    extra: accepted.extra ? { ...accepted.extra } : {},
  };
}

function acceptedRequirementsHash(accepted) {
  try {
    return `sha256:${sha256(normalizedAcceptedRequirements(accepted))}`;
  } catch {
    throw new ProviderRelayError("provider_payment_challenge_invalid", 502);
  }
}

function canonicalProviderAuthorizationIdentity(accepted, authorization) {
  const digest = sha256({
    protocol: "eip3009",
    chainId: XLAYER.id,
    network: XLAYER.network,
    asset: getAddress(accepted.asset).toLowerCase(),
    name: String(accepted.extra.name),
    version: String(accepted.extra.version),
    from: getAddress(authorization.from).toLowerCase(),
    to: getAddress(authorization.to).toLowerCase(),
    value: BigInt(authorization.value).toString(),
    validAfter: BigInt(authorization.validAfter).toString(),
    validBefore: BigInt(authorization.validBefore).toString(),
    nonce: String(authorization.nonce).toLowerCase(),
  });
  return { id: `sha256:${digest}`, hash: `0x${digest}` };
}

function validateProviderChallenge(raw, policy, canonicalEndpoint) {
  let challenge;
  try {
    challenge = decodePaymentRequiredHeader(raw);
  } catch {
    throw new ProviderRelayError("provider_payment_challenge_malformed", 502);
  }
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  if (challenge?.x402Version !== 2 || accepts.length !== 1) {
    throw new ProviderRelayError("provider_payment_challenge_ambiguous", 502);
  }
  const accepted = accepts[0];
  let resourceUrl;
  try {
    resourceUrl = new URL(challenge?.resource?.url).toString();
  } catch {
    throw new ProviderRelayError("provider_payment_challenge_invalid", 502);
  }
  if (
    resourceUrl !== canonicalEndpoint
    || accepted?.scheme !== "exact"
    || accepted?.network !== XLAYER.network
    || !sameAddress(accepted?.asset, PAYMENT.asset)
    || !sameAddress(accepted?.payTo, policy.providerWallet)
    || String(accepted?.amount || "") !== String(policy.servicePriceAtomic || "")
    || accepted?.extra?.name !== PAYMENT.name
    || accepted?.extra?.version !== PAYMENT.version
    || ![undefined, "eip3009"].includes(accepted?.extra?.assetTransferMethod)
    || !Number.isSafeInteger(Number(accepted?.maxTimeoutSeconds))
    || Number(accepted.maxTimeoutSeconds) <= 0
    || Number(accepted.maxTimeoutSeconds) > 15 * 60
  ) {
    throw new ProviderRelayError("provider_payment_challenge_mismatch", 502);
  }
  return {
    challenge,
    accepted: normalizedAcceptedRequirements(accepted),
    requirementsHash: acceptedRequirementsHash(accepted),
  };
}

async function providerPaymentAuthorization(
  raw,
  policy,
  chain,
  nowMs,
  expectedRequirementsHash = null,
  { allowExpired = false } = {},
) {
  if (!raw) return null;
  let payload;
  try {
    payload = decodePaymentSignatureHeader(raw);
  } catch {
    throw new ProviderRelayError("provider_payment_signature_malformed", 400);
  }
  const accepted = payload?.accepted;
  const authorization = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  let payer;
  let validAfter;
  let validBefore;
  try {
    payer = getAddress(authorization?.from);
    validAfter = BigInt(authorization?.validAfter);
    validBefore = BigInt(authorization?.validBefore);
  } catch {
    throw new ProviderRelayError("provider_payment_authorization_invalid", 400);
  }
  const nowSeconds = BigInt(Math.floor(nowMs / 1_000));
  if (
    payload?.x402Version !== 2
    || accepted?.scheme !== "exact"
    || accepted?.network !== XLAYER.network
    || !sameAddress(accepted?.asset, PAYMENT.asset)
    || !sameAddress(accepted?.payTo, policy.providerWallet)
    || String(accepted?.amount || "") !== String(policy.servicePriceAtomic || "")
    || accepted?.extra?.name !== PAYMENT.name
    || accepted?.extra?.version !== PAYMENT.version
    || ![undefined, "eip3009"].includes(accepted?.extra?.assetTransferMethod)
    || !sameAddress(authorization?.to, accepted?.payTo)
    || String(authorization?.value || "") !== String(accepted?.amount || "")
    || !isBytes32(authorization?.nonce)
    || typeof signature !== "string"
    || !signature.startsWith("0x")
    || validAfter > nowSeconds
    || (!allowExpired && validBefore <= nowSeconds)
    || validBefore <= validAfter
  ) {
    throw new ProviderRelayError("provider_payment_requirements_mismatch", 400);
  }
  if (expectedRequirementsHash && acceptedRequirementsHash(accepted) !== expectedRequirementsHash) {
    throw new ProviderRelayError("provider_payment_challenge_changed", 409);
  }
  if (!chain?.verifyProviderPaymentAuthorization) {
    throw new ProviderRelayError("provider_payment_verifier_unavailable", 503);
  }
  try {
    const verified = await chain.verifyProviderPaymentAuthorization({
      payer,
      asset: getAddress(accepted.asset),
      name: accepted.extra.name,
      version: accepted.extra.version,
      authorization,
      signature,
    });
    if (verified !== true) throw new Error("provider payment signature rejected");
  } catch {
    throw new ProviderRelayError("provider_payment_signature_invalid", 400);
  }
  const identity = canonicalProviderAuthorizationIdentity(accepted, authorization);
  return {
    accepted,
    authorization: {
      ...authorization,
      from: payer,
      to: getAddress(authorization.to),
    },
    ...identity,
    payload,
    raw,
  };
}

async function verifyProviderPaymentSettlement(authorization, returnedHeaders, chain) {
  const raw = returnedHeaders["payment-response"] || returnedHeaders["x-payment-response"];
  if (!raw) throw new ProviderRelayError("provider_payment_response_missing", 502);
  let settlement;
  try {
    settlement = decodePaymentResponseHeader(raw);
  } catch {
    throw new ProviderRelayError("provider_payment_response_malformed", 502);
  }
  const payer = authorization.authorization.from;
  if (
    settlement?.success !== true
    || !isBytes32(settlement?.transaction)
    || settlement?.network !== authorization.accepted.network
    || (settlement?.payer !== undefined && !sameAddress(settlement.payer, payer))
    || (settlement.amount !== undefined && String(settlement.amount) !== String(authorization.accepted.amount))
  ) {
    throw new ProviderRelayError("provider_payment_response_invalid", 502);
  }
  if (!chain?.verifyProviderSettlement) {
    throw new ProviderRelayError("provider_payment_verifier_unavailable", 503);
  }
  let transfer;
  try {
    transfer = await chain.verifyProviderSettlement({
      txHash: settlement.transaction,
      payer: getAddress(payer),
      payTo: getAddress(authorization.accepted.payTo),
      asset: getAddress(authorization.accepted.asset),
      amountAtomic: String(authorization.accepted.amount),
      authorizationNonce: authorization.authorization.nonce,
    });
  } catch {
    throw new ProviderRelayError("provider_payment_transfer_unverified", 502);
  }
  return {
    transaction: settlement.transaction,
    network: settlement.network,
    payer: getAddress(payer),
    payTo: getAddress(authorization.accepted.payTo),
    asset: getAddress(authorization.accepted.asset),
    amountAtomic: String(authorization.accepted.amount),
    authorizationNonce: authorization.authorization.nonce,
    transfer,
  };
}

function defaultSigner() {
  const key = String(process.env.POLICYPOOL_RELAY_SIGNER_PRIVATE_KEY || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
    throw new ProviderRelayError("provider_relay_signer_not_configured", 503);
  }
  return privateKeyToAccount(key);
}

function receiptDomain(verifierAddress) {
  const raw = String(verifierAddress || process.env.POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS || "").trim();
  if (!isAddress(raw)) throw new ProviderRelayError("provider_relay_verifier_not_configured", 503);
  return {
    name: "PolicyPool Relay Receipt",
    version: "1",
    chainId: XLAYER.id,
    verifyingContract: getAddress(raw),
  };
}

export function createProviderRelay({
  policyResolver,
  store,
  fetchImpl,
  resolveHost = lookup,
  chain = createChainService(),
  signer,
  receiptVerifierAddress,
  grantService,
  now = () => Date.now(),
} = {}) {
  if (!policyResolver?.resolve) throw new ProviderRelayError("universal_policy_resolver_unavailable", 503);
  if (!store?.saveRelayReceipt) throw new ProviderRelayError("provider_relay_store_unavailable", 503);
  if (
    !store?.reserveRelayExecution
    || !store?.commitRelayExecutionReceipt
    || !store?.releaseRelayExecution
  ) {
    throw new ProviderRelayError("provider_relay_grant_store_unavailable", 503);
  }
  if (!grantService?.resolve) throw new ProviderRelayError("provider_relay_grant_service_unavailable", 503);
  const relayFetch = fetchImpl || ((_, options, connection) => (
    fetchPinnedEndpoint(connection.endpoint, options, connection.records)
  ));
  if (typeof relayFetch !== "function") throw new ProviderRelayError("provider_relay_fetch_unavailable", 503);
  const receiptSigner = signer || defaultSigner();
  const signatureDomain = receiptDomain(receiptVerifierAddress);

  async function prepareProviderRequest(input) {
    const policy = await policyResolver.resolve({ agentId: input?.agentId, serviceId: input?.serviceId });
    if (policy.serviceType !== "A2MCP") throw new ProviderRelayError("provider_relay_requires_a2mcp");
    const connection = await verifyPublicEndpoint(policy.serviceEndpoint, resolveHost);
    const canonicalEndpoint = connection.endpoint.toString();
    if (input?.endpoint) {
      let suppliedEndpoint;
      try {
        suppliedEndpoint = new URL(input.endpoint).toString();
      } catch {
        throw new ProviderRelayError("provider_endpoint_does_not_match_enrollment");
      }
      if (suppliedEndpoint !== canonicalEndpoint) {
        throw new ProviderRelayError("provider_endpoint_does_not_match_enrollment");
      }
    }
    const providerRequest = input?.providerRequest;
    if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
      throw new ProviderRelayError("provider_request_required");
    }
    const body = stableStringify(providerRequest);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderRelayError("provider_request_too_large", 413);
    return {
      policy,
      providerRequest,
      body,
      canonicalEndpoint,
      connection,
      requestHash: `sha256:${sha256(body)}`,
    };
  }

  async function probe(input) {
    const prepared = await prepareProviderRequest(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_PROBE_TIMEOUT_MS);
    try {
      const response = await relayFetch(prepared.canonicalEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: prepared.body,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }, prepared.connection);
      if (response.status !== 402) throw new ProviderRelayError("provider_payment_challenge_expected", 502);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_RESPONSE_BYTES) throw new ProviderRelayError("provider_response_too_large", 502);
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new ProviderRelayError("provider_response_too_large", 502);
      const raw = clean(response.headers.get("payment-required"), 16_000);
      if (!raw) throw new ProviderRelayError("provider_payment_challenge_missing", 502);
      const verified = validateProviderChallenge(raw, prepared.policy, prepared.canonicalEndpoint);
      return {
        policy: prepared.policy,
        endpoint: prepared.canonicalEndpoint,
        requestHash: prepared.requestHash,
        requestBytes: Buffer.byteLength(prepared.body),
        providerChallengeHash: `sha256:${sha256(raw)}`,
        providerRequirementsHash: verified.requirementsHash,
        paymentRequired: verified.challenge,
        accepted: verified.accepted,
      };
    } catch (error) {
      if (error instanceof ProviderRelayError) throw error;
      if (error?.name === "AbortError") throw new ProviderRelayError("provider_challenge_timeout", 504);
      throw new ProviderRelayError("provider_endpoint_unreachable", 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function verifyAuthorization({
    agentId,
    serviceId,
    raw,
    buyer,
    providerRequirementsHash,
    allowExpired = false,
  }) {
    const policy = await policyResolver.resolve({ agentId, serviceId });
    if (policy.serviceType !== "A2MCP") throw new ProviderRelayError("provider_relay_requires_a2mcp");
    const authorization = await providerPaymentAuthorization(
      raw,
      policy,
      chain,
      now(),
      providerRequirementsHash,
      { allowExpired },
    );
    if (!authorization) throw new ProviderRelayError("provider_payment_signature_required", 402);
    if (buyer && !sameAddress(authorization.authorization.from, buyer)) {
      throw new ProviderRelayError("provider_payment_payer_mismatch", 400);
    }
    return {
      id: authorization.id,
      hash: authorization.hash,
      payer: authorization.authorization.from,
      validAfter: String(authorization.authorization.validAfter),
      validBefore: String(authorization.authorization.validBefore),
      nonce: authorization.authorization.nonce,
      requirementsHash: acceptedRequirementsHash(authorization.accepted),
    };
  }

  async function execute(input, requestHeaders = {}) {
    let grant;
    try {
      grant = grantService.resolve(input?.relayGrant);
    } catch (error) {
      if (error instanceof RelayGrantError) throw new ProviderRelayError(error.code, error.status);
      throw new ProviderRelayError("relay_grant_invalid");
    }
    const prepared = await prepareProviderRequest(input);
    const { policy, providerRequest, body, canonicalEndpoint, requestHash } = prepared;
    if (!isBytes32(input?.targetJobId)) throw new ProviderRelayError("target_job_id_required");
    if (
      grant.agentId !== String(policy.agentId)
      || grant.serviceId !== String(policy.serviceIds[0])
      || grant.targetJobId.toLowerCase() !== input.targetJobId.toLowerCase()
    ) {
      throw new ProviderRelayError("relay_grant_scope_mismatch");
    }
    if (grant.providerRequestHash && grant.providerRequestHash !== requestHash) {
      throw new ProviderRelayError("provider_request_does_not_match_grant", 409);
    }

    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = requestHeaders[name];
      if (value) headers[name] = String(value);
    }
    headers.accept ||= "application/json";
    headers["content-type"] = "application/json";
    const authorization = await providerPaymentAuthorization(
      paymentHeader(headers),
      policy,
      chain,
      now(),
      grant.providerRequirementsHash || null,
    );
    if (grant.providerRequirementsHash && !authorization) {
      throw new ProviderRelayError("provider_payment_signature_required", 402);
    }
    if (authorization && !sameAddress(authorization.authorization.from, grant.buyer)) {
      throw new ProviderRelayError("provider_payment_payer_mismatch", 400);
    }
    const requestId = `sha256:${sha256({
      agentId: policy.agentId,
      serviceId: policy.serviceIds[0],
      targetJobId: input.targetJobId.toLowerCase(),
      endpoint: canonicalEndpoint,
      request: providerRequest,
      paymentAuthorizationId: authorization?.id || null,
    })}`;
    let executionReserved = false;
    let executionCommitted = false;
    let requestDispatched = false;
    let definitelyUnsettled = false;
    if (authorization) {
      const reservation = await store.reserveRelayExecution(
        grant.grantId,
        authorization.id,
        requestId,
        grant.expiresAt,
      );
      if (reservation === "grant_used") throw new ProviderRelayError("relay_grant_already_used", 409);
      if (reservation === "payment_used") {
        throw new ProviderRelayError("provider_payment_authorization_already_used", 409);
      }
      if (reservation !== "reserved") throw new ProviderRelayError("provider_relay_reservation_failed", 503);
      executionReserved = true;
    }
    const forwardedAtMs = now();
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, policy.slaSeconds * 1_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      requestDispatched = true;
      const response = await relayFetch(canonicalEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }, prepared.connection);
      definitelyUnsettled = response.status === 402;
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_RESPONSE_BYTES) throw new ProviderRelayError("provider_response_too_large", 502);
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new ProviderRelayError("provider_response_too_large", 502);
      const completedAtMs = now();
      const returnedHeaders = {};
      for (const name of RETURNED_HEADERS) {
        const value = response.headers.get(name);
        if (value) returnedHeaders[name] = value;
      }
      const providerSettlement = authorization && response.status !== 402
        ? await verifyProviderPaymentSettlement(authorization, returnedHeaders, chain)
        : null;
      const unsignedReceipt = {
        protocol: "PolicyPool Provider Relay",
        version: "0.4.0",
        signatureDomain,
        requestId,
        relayGrantId: grant.grantId,
        covenantId: grant.covenantId.toLowerCase(),
        provider: {
          agentId: policy.agentId,
          serviceId: policy.serviceIds[0],
          policyHash: policy.policyHash,
          endpointHash: `sha256:${sha256(canonicalEndpoint)}`,
          targetJobId: input.targetJobId.toLowerCase(),
        },
        request: {
          hash: `sha256:${sha256(body)}`,
          paymentAuthorizationPresent: Boolean(authorization),
          paymentAuthorizationId: authorization?.id || null,
          paymentVerified: Boolean(providerSettlement),
          forwardedAt: new Date(forwardedAtMs).toISOString(),
        },
        response: {
          status: response.status,
          hash: `sha256:${sha256(responseBytes)}`,
          bytes: responseBytes.byteLength,
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - forwardedAtMs,
          paymentRequired: response.status === 402,
        },
        settlement: providerSettlement,
        clock: providerSettlement
          ? {
            source: "policypool_relay_verified_x402_settlement",
            startedAt: new Date(forwardedAtMs).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
            delivered: response.ok,
            completedWithinSla: response.ok && completedAtMs - forwardedAtMs <= policy.slaSeconds * 1_000,
          }
          : null,
      };
      const receiptDigest = keccak256(stringToHex(stableStringify(unsignedReceipt)));
      const signature = await receiptSigner.signTypedData({
        domain: signatureDomain,
        types: RELAY_RECEIPT_TYPES,
        primaryType: "RelayReceipt",
        message: { receiptDigest },
      });
      const signedReceipt = {
        ...unsignedReceipt,
        receiptDigest,
        signer: receiptSigner.address,
        signature,
      };
      const upstream = {
        status: response.status,
        headers: returnedHeaders,
        contentType: returnedHeaders["content-type"] || "application/octet-stream",
        bodyBase64: responseBytes.toString("base64"),
      };
      let stored;
      if (providerSettlement) {
        try {
          stored = await store.commitRelayExecutionReceipt(
            grant.grantId,
            authorization.id,
            requestId,
            grant.expiresAt,
            signedReceipt,
            upstream,
          );
        } catch {
          throw new ProviderRelayError("provider_relay_commit_failed", 503);
        }
        if (!stored) throw new ProviderRelayError("provider_relay_commit_failed", 503);
        executionCommitted = true;
      } else {
        stored = await store.saveRelayReceipt(signedReceipt);
      }
      return {
        receipt: stored,
        upstream,
      };
    } catch (error) {
      if (error instanceof ProviderRelayError) throw error;
      if (error?.name === "AbortError") throw new ProviderRelayError("provider_response_timeout", 504);
      throw new ProviderRelayError("provider_endpoint_unreachable", 502);
    } finally {
      clearTimeout(timeout);
      if (executionReserved && !executionCommitted && (!requestDispatched || definitelyUnsettled)) {
        try {
          await store.releaseRelayExecution(grant.grantId, authorization.id, requestId);
        } catch {
          // A stale definitely-unsettled reservation expires with the bounded relay grant.
        }
      }
    }
  }

  async function recover(input, requestHeaders = {}) {
    let grant;
    try {
      grant = grantService.resolve(input?.relayGrant, { allowExpired: true });
    } catch (error) {
      if (error instanceof RelayGrantError) throw new ProviderRelayError(error.code, error.status);
      throw new ProviderRelayError("relay_grant_invalid");
    }
    const prepared = await prepareProviderRequest(input);
    const { policy, providerRequest, canonicalEndpoint, requestHash } = prepared;
    if (!isBytes32(input?.targetJobId)) throw new ProviderRelayError("target_job_id_required");
    if (
      grant.agentId !== String(policy.agentId)
      || grant.serviceId !== String(policy.serviceIds[0])
      || grant.targetJobId.toLowerCase() !== input.targetJobId.toLowerCase()
      || (grant.providerRequestHash && grant.providerRequestHash !== requestHash)
    ) throw new ProviderRelayError("relay_grant_scope_mismatch");

    const authorization = await providerPaymentAuthorization(
      paymentHeader(requestHeaders),
      policy,
      chain,
      now(),
      grant.providerRequirementsHash || null,
      { allowExpired: true },
    );
    if (!authorization) throw new ProviderRelayError("provider_payment_signature_required", 402);
    if (!sameAddress(authorization.authorization.from, grant.buyer)) {
      throw new ProviderRelayError("provider_payment_payer_mismatch", 400);
    }
    const requestId = `sha256:${sha256({
      agentId: policy.agentId,
      serviceId: policy.serviceIds[0],
      targetJobId: input.targetJobId.toLowerCase(),
      endpoint: canonicalEndpoint,
      request: providerRequest,
      paymentAuthorizationId: authorization.id,
    })}`;

    async function existingRecovery() {
      if (!store.getRelayReceiptForCovenant) return null;
      const receipt = await store.getRelayReceiptForCovenant(grant.covenantId);
      if (!receipt) return null;
      if (
        receipt.requestId !== requestId
        || receipt.relayGrantId !== grant.grantId
        || receipt.request?.paymentAuthorizationId !== authorization.id
        || receipt.provider?.targetJobId?.toLowerCase() !== input.targetJobId.toLowerCase()
        || receipt.settlement?.authorizationNonce?.toLowerCase()
          !== authorization.authorization.nonce.toLowerCase()
      ) throw new ProviderRelayError("provider_relay_recovery_mismatch", 503);
      const upstream = store.getRelayResponse
        ? await store.getRelayResponse(receipt.receiptId)
        : null;
      if (upstream) {
        let body;
        try {
          body = Buffer.from(upstream.bodyBase64, "base64");
        } catch {
          throw new ProviderRelayError("provider_relay_response_corrupt", 503);
        }
        if (
          `sha256:${sha256(body)}` !== receipt.response?.hash
          || body.byteLength !== Number(receipt.response?.bytes)
          || Number(upstream.status) !== Number(receipt.response?.status)
        ) throw new ProviderRelayError("provider_relay_response_corrupt", 503);
      }
      return { receipt, upstream, recovered: true };
    }

    const existing = await existingRecovery();
    if (existing) return existing;
    if (!chain?.findProviderSettlement) {
      throw new ProviderRelayError("provider_settlement_recovery_unavailable", 503);
    }
    let transfer;
    try {
      transfer = await chain.findProviderSettlement({
        payer: authorization.authorization.from,
        payTo: authorization.accepted.payTo,
        asset: authorization.accepted.asset,
        amountAtomic: authorization.accepted.amount,
        authorizationNonce: authorization.authorization.nonce,
        notBeforeTimestamp: Math.floor(Date.parse(grant.issuedAt) / 1_000),
        notAfterTimestamp: Number(authorization.authorization.validBefore),
      });
    } catch (error) {
      throw new ProviderRelayError(
        `provider_settlement_recovery_failed:${error?.code || "chain_lookup_failed"}`,
        503,
      );
    }
    if (!transfer) throw new ProviderRelayError("provider_payment_settlement_not_found", 404);
    const providerSettlement = {
      transaction: transfer.txHash,
      network: XLAYER.network,
      payer: getAddress(authorization.authorization.from),
      payTo: getAddress(authorization.accepted.payTo),
      asset: getAddress(authorization.accepted.asset),
      amountAtomic: String(authorization.accepted.amount),
      authorizationNonce: authorization.authorization.nonce,
      transfer,
    };
    const unsignedReceipt = {
      protocol: "PolicyPool Provider Relay",
      version: "0.4.0",
      signatureDomain,
      requestId,
      relayGrantId: grant.grantId,
      covenantId: grant.covenantId.toLowerCase(),
      provider: {
        agentId: policy.agentId,
        serviceId: policy.serviceIds[0],
        policyHash: policy.policyHash,
        endpointHash: `sha256:${sha256(canonicalEndpoint)}`,
        targetJobId: input.targetJobId.toLowerCase(),
      },
      request: {
        hash: `sha256:${sha256(prepared.body)}`,
        paymentAuthorizationPresent: true,
        paymentAuthorizationId: authorization.id,
        paymentVerified: true,
        forwardedAt: grant.issuedAt,
        recoveredFromChain: true,
      },
      response: {
        status: null,
        hash: null,
        bytes: 0,
        completedAt: null,
        durationMs: null,
        paymentRequired: false,
        recovery: "provider_settlement_found_without_durable_upstream_response",
      },
      settlement: providerSettlement,
      clock: {
        source: "policypool_relay_verified_x402_settlement",
        startedAt: transfer.settledAt,
        completedAt: null,
        delivered: false,
        completedWithinSla: false,
      },
    };
    const receiptDigest = keccak256(stringToHex(stableStringify(unsignedReceipt)));
    const signature = await receiptSigner.signTypedData({
      domain: signatureDomain,
      types: RELAY_RECEIPT_TYPES,
      primaryType: "RelayReceipt",
      message: { receiptDigest },
    });
    const signedReceipt = {
      ...unsignedReceipt,
      receiptDigest,
      signer: receiptSigner.address,
      signature,
    };
    let stored = await store.commitRelayExecutionReceipt(
      grant.grantId,
      authorization.id,
      requestId,
      grant.expiresAt,
      signedReceipt,
    );
    if (!stored) {
      const reservation = await store.reserveRelayExecution(
        grant.grantId,
        authorization.id,
        requestId,
        grant.expiresAt,
      );
      if (reservation === "reserved") {
        stored = await store.commitRelayExecutionReceipt(
          grant.grantId,
          authorization.id,
          requestId,
          grant.expiresAt,
          signedReceipt,
        );
      } else if (["grant_used", "payment_used"].includes(reservation)) {
        const recovered = await existingRecovery();
        if (recovered) return recovered;
      }
    }
    if (!stored) throw new ProviderRelayError("provider_relay_recovery_commit_failed", 503);
    return { receipt: stored, upstream: null, recovered: true };
  }

  return { execute, probe, recover, verifyAuthorization };
}

export async function verifyProviderRelayReceipt(receipt, expectedSigner, expectedVerifierAddress) {
  if (!receipt?.signature || !receipt?.signer || receipt.signer.toLowerCase() !== expectedSigner.toLowerCase()) {
    return false;
  }
  let expectedDomain;
  try {
    expectedDomain = receiptDomain(expectedVerifierAddress);
  } catch {
    return false;
  }
  if (
    receipt.signatureDomain?.name !== expectedDomain.name
    || receipt.signatureDomain?.version !== expectedDomain.version
    || Number(receipt.signatureDomain?.chainId) !== expectedDomain.chainId
    || String(receipt.signatureDomain?.verifyingContract || "").toLowerCase()
      !== expectedDomain.verifyingContract.toLowerCase()
  ) return false;
  const { signature, signer, receiptId, receiptDigest, ...unsigned } = receipt;
  const expectedDigest = keccak256(stringToHex(stableStringify(unsigned)));
  if (receiptDigest !== expectedDigest) return false;
  return verifyTypedData({
    address: signer,
    domain: expectedDomain,
    types: RELAY_RECEIPT_TYPES,
    primaryType: "RelayReceipt",
    message: { receiptDigest },
    signature,
  });
}

export const __test = {
  createPinnedLookup,
  privateIp,
  acceptedRequirementsHash,
  canonicalProviderAuthorizationIdentity,
  providerPaymentAuthorization,
  validateProviderChallenge,
  verifyProviderPaymentSettlement,
  verifyPublicEndpoint,
};
