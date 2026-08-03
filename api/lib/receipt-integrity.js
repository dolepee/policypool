import { publicRouteForUrl } from "./public-origin-contract.js";
import { publicUrl } from "./public-origin.js";
import { sha256, stableStringify } from "./utils.js";

const RECEIPT_HASH_RE = /^sha256:[a-f0-9]{64}$/;

export const STORED_RECEIPT_SHAPES = Object.freeze({
  issued: "issued",
});

export class ReceiptIntegrityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ReceiptIntegrityError";
    this.code = code;
  }
}

export function computeReceiptHash(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ReceiptIntegrityError("receipt_document_invalid");
  }
  const { receiptHash: _ignored, ...hashCommitted } = receipt;
  // A relay grant token is minted only when the response is rendered and is
  // intentionally absent from the durable receipt that established the hash.
  // Keep that long-standing recovery behavior explicit: the token remains
  // bound by the hash-committed grant id/expiry, but is not itself receipt
  // material and can be refreshed without rewriting historical hashes.
  if (hashCommitted.providerRelay?.grantToken !== undefined) {
    const { grantToken: _ephemeral, ...providerRelay } = hashCommitted.providerRelay;
    hashCommitted.providerRelay = providerRelay;
  }
  return `sha256:${sha256(stableStringify(hashCommitted))}`;
}

function configuredProviderRelayRoute(value, environment) {
  const endpoint = publicUrl("/api/provider-relay", environment);
  if (String(value) !== endpoint) return null;
  const compatibleRoute = publicRouteForUrl(endpoint);
  if (
    compatibleRoute
    && endpoint
      === `${compatibleRoute.origin}${compatibleRoute.pathPrefix}/api/provider-relay`
  ) {
    return compatibleRoute;
  }
  const parsed = new URL(endpoint);
  const handlerPath = "/api/provider-relay";
  const pathPrefix = parsed.pathname.slice(0, -handlerPath.length);
  return Object.freeze({
    key: `configured-public:${parsed.origin}${pathPrefix}`,
    origin: parsed.origin,
    pathPrefix,
  });
}

function embeddedPolicyPoolRoutes(receipt, environment) {
  const routes = [];
  const reserveUrl = receipt?.reserve?.publicUrl;
  if (reserveUrl) {
    const route = publicRouteForUrl(reserveUrl);
    // POLICYPOOL_RESERVE_URL historically allowed a third-party evidence page.
    // Only a known PolicyPool URL participates in same-route enforcement.
    if (route) routes.push({ field: "reserve.publicUrl", route });
  }
  const relayEndpoint = receipt?.providerRelay?.endpoint;
  if (relayEndpoint) {
    const route = configuredProviderRelayRoute(relayEndpoint, environment);
    if (!route) {
      throw new ReceiptIntegrityError(
        "receipt_public_origin_untrusted",
        "Receipt relay endpoint is not the exact configured PolicyPool provider relay route",
      );
    }
    routes.push({ field: "providerRelay.endpoint", route });
  }
  return routes;
}

export function verifyReceiptIntegrity(receipt, { environment = process.env } = {}) {
  const claimed = String(receipt?.receiptHash || "");
  if (!RECEIPT_HASH_RE.test(claimed)) {
    throw new ReceiptIntegrityError("receipt_hash_invalid");
  }
  const computed = computeReceiptHash(receipt);
  if (computed !== claimed) {
    throw new ReceiptIntegrityError("receipt_hash_mismatch");
  }

  const routes = embeddedPolicyPoolRoutes(receipt, environment);
  const routeKeys = new Set(routes.map(({ route }) => route.key));
  if (routeKeys.size > 1) {
    throw new ReceiptIntegrityError(
      "receipt_public_origin_mismatch",
      "Receipt combines incompatible PolicyPool public routes",
    );
  }
  return Object.freeze({
    receiptHash: claimed,
    publicRoute: routes[0]?.route || null,
  });
}
