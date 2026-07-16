import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, keccak256, stringToHex, verifyTypedData } from "viem";
import { XLAYER } from "./config.js";
import { clean, isBytes32, sha256, stableStringify } from "./utils.js";
import { RelayGrantError } from "./relay-grant.js";

const MAX_REQUEST_BYTES = 256_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TIMEOUT_MS = 300_000;
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
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function privateIp(address) {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
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
  return endpoint;
}

function paymentHeaderPresent(headers) {
  return Boolean(headers?.["payment-signature"] || headers?.["x-payment"]);
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
  fetchImpl = globalThis.fetch,
  resolveHost = lookup,
  signer,
  receiptVerifierAddress,
  grantService,
  now = () => Date.now(),
} = {}) {
  if (!policyResolver?.resolve) throw new ProviderRelayError("universal_policy_resolver_unavailable", 503);
  if (!store?.saveRelayReceipt) throw new ProviderRelayError("provider_relay_store_unavailable", 503);
  if (!store?.claimRelayGrant) throw new ProviderRelayError("provider_relay_grant_store_unavailable", 503);
  if (!grantService?.resolve) throw new ProviderRelayError("provider_relay_grant_service_unavailable", 503);
  if (typeof fetchImpl !== "function") throw new ProviderRelayError("provider_relay_fetch_unavailable", 503);
  const receiptSigner = signer || defaultSigner();
  const signatureDomain = receiptDomain(receiptVerifierAddress);

  async function execute(input, requestHeaders = {}) {
    let grant;
    try {
      grant = grantService.resolve(input?.relayGrant);
    } catch (error) {
      if (error instanceof RelayGrantError) throw new ProviderRelayError(error.code, error.status);
      throw new ProviderRelayError("relay_grant_invalid");
    }
    const policy = await policyResolver.resolve({ agentId: input?.agentId, serviceId: input?.serviceId });
    if (policy.serviceType !== "A2MCP") throw new ProviderRelayError("provider_relay_requires_a2mcp");
    const endpoint = await verifyPublicEndpoint(policy.serviceEndpoint, resolveHost);
    const canonicalEndpoint = endpoint.toString();
    if (input?.endpoint && new URL(input.endpoint).toString() !== canonicalEndpoint) {
      throw new ProviderRelayError("provider_endpoint_does_not_match_enrollment");
    }
    const providerRequest = input?.providerRequest;
    if (!isBytes32(input?.targetJobId)) throw new ProviderRelayError("target_job_id_required");
    if (
      grant.agentId !== String(policy.agentId)
      || grant.serviceId !== String(policy.serviceIds[0])
      || grant.targetJobId.toLowerCase() !== input.targetJobId.toLowerCase()
    ) {
      throw new ProviderRelayError("relay_grant_scope_mismatch");
    }
    if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
      throw new ProviderRelayError("provider_request_required");
    }
    const body = stableStringify(providerRequest);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderRelayError("provider_request_too_large", 413);

    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = requestHeaders[name];
      if (value) headers[name] = String(value);
    }
    headers.accept ||= "application/json";
    headers["content-type"] = "application/json";
    const hasPayment = paymentHeaderPresent(headers);
    const requestId = `sha256:${sha256({
      agentId: policy.agentId,
      serviceId: policy.serviceIds[0],
      targetJobId: input.targetJobId.toLowerCase(),
      endpoint: canonicalEndpoint,
      request: providerRequest,
      paymentAuthorizationPresent: hasPayment,
    })}`;
    if (hasPayment && !await store.claimRelayGrant(grant.grantId, requestId)) {
      throw new ProviderRelayError("relay_grant_already_used", 409);
    }
    const forwardedAtMs = now();
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, policy.slaSeconds * 1_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(canonicalEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new ProviderRelayError("provider_response_timeout", 504);
      throw new ProviderRelayError("provider_endpoint_unreachable", 502);
    } finally {
      clearTimeout(timeout);
    }
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
    const unsignedReceipt = {
      protocol: "PolicyPool Provider Relay",
      version: "0.4.0",
      signatureDomain,
      requestId,
      relayGrantId: grant.grantId,
      provider: {
        agentId: policy.agentId,
        serviceId: policy.serviceIds[0],
        policyHash: policy.policyHash,
        endpointHash: `sha256:${sha256(canonicalEndpoint)}`,
        targetJobId: input.targetJobId.toLowerCase(),
      },
      request: {
        hash: `sha256:${sha256(body)}`,
        paymentAuthorizationPresent: hasPayment,
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
      clock: hasPayment && response.status !== 402
        ? {
          source: "policypool_relay_observation",
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
    const stored = await store.saveRelayReceipt({
      ...unsignedReceipt,
      receiptDigest,
      signer: receiptSigner.address,
      signature,
    });
    return {
      receipt: stored,
      upstream: {
        status: response.status,
        headers: returnedHeaders,
        contentType: returnedHeaders["content-type"] || "application/octet-stream",
        bodyBase64: responseBytes.toString("base64"),
      },
    };
  }

  return { execute };
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

export const __test = { privateIp, verifyPublicEndpoint };
