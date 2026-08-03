import {
  PublicOriginContractError,
  publicRouteForUrl,
  requireCompatiblePublicUrl,
} from "./public-origin-contract.js";
import { sha256, stableStringify } from "./utils.js";

const RECEIPT_HASH_RE = /^sha256:[a-f0-9]{64}$/;

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

function embeddedPolicyPoolRoutes(receipt) {
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
    let route;
    try {
      route = requireCompatiblePublicUrl(relayEndpoint);
    } catch (error) {
      if (error instanceof PublicOriginContractError) {
        throw new ReceiptIntegrityError(error.code, error.message);
      }
      throw error;
    }
    routes.push({ field: "providerRelay.endpoint", route });
  }
  return routes;
}

export function verifyReceiptIntegrity(receipt) {
  const claimed = String(receipt?.receiptHash || "");
  if (!RECEIPT_HASH_RE.test(claimed)) {
    throw new ReceiptIntegrityError("receipt_hash_invalid");
  }
  const computed = computeReceiptHash(receipt);
  if (computed !== claimed) {
    throw new ReceiptIntegrityError("receipt_hash_mismatch");
  }

  const routes = embeddedPolicyPoolRoutes(receipt);
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
