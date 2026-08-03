import { publicRouteForUrl } from "./public-origin-contract.js";
import { publicUrl } from "./public-origin.js";
import { PREDEPLOY_RECEIPT_INTEGRITY_MIGRATIONS } from "./receipt-integrity-migrations.js";
import { sha256, stableStringify } from "./utils.js";

const RECEIPT_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_ID_RE = /^ppc-[a-f0-9]{16}$/;
const MAX_RECEIPT_MIGRATIONS = 100;
const MAX_RECEIPT_MIGRATIONS_BYTES = 32_768;

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

function providerRelayRoute(endpoint, keyPrefix) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  const handlerPath = "/api/provider-relay";
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.toString() !== endpoint
    || !parsed.pathname.endsWith(handlerPath)
  ) {
    return null;
  }
  const pathPrefix = parsed.pathname.slice(0, -handlerPath.length);
  if (
    pathPrefix
    && (
      !pathPrefix.startsWith("/")
      || pathPrefix.endsWith("/")
      || pathPrefix.includes("//")
      || pathPrefix.includes("\\")
      || pathPrefix.includes("%")
      || pathPrefix.split("/").some((segment) => segment === "." || segment === "..")
      || !/^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(pathPrefix)
    )
  ) {
    return null;
  }
  const compatibleRoute = publicRouteForUrl(endpoint);
  if (
    compatibleRoute
    && endpoint
      === `${compatibleRoute.origin}${compatibleRoute.pathPrefix}/api/provider-relay`
  ) {
    return compatibleRoute;
  }
  return Object.freeze({
    key: `${keyPrefix}:${parsed.origin}${pathPrefix}`,
    origin: parsed.origin,
    pathPrefix,
  });
}

function configuredProviderRelayRoute(value, environment) {
  const endpoint = publicUrl("/api/provider-relay", environment);
  if (String(value) !== endpoint) return null;
  return providerRelayRoute(endpoint, "configured-public");
}

function anchoredProviderRelayRoute(value, anchor) {
  const endpoint = anchor?.providerRelayEndpoint;
  if (typeof endpoint !== "string" || String(value) !== endpoint) return null;
  return providerRelayRoute(endpoint, "issued-public");
}

export function buildReceiptIntegrityAnchor(receipt) {
  const receiptHash = String(receipt?.receiptHash || "");
  if (!RECEIPT_HASH_RE.test(receiptHash)) {
    throw new ReceiptIntegrityError("receipt_hash_invalid");
  }
  const relayEndpoint = receipt?.providerRelay?.endpoint;
  if (relayEndpoint !== undefined && relayEndpoint !== null && typeof relayEndpoint !== "string") {
    throw new ReceiptIntegrityError("receipt_provider_relay_invalid");
  }
  return Object.freeze({
    receiptHash,
    providerRelayEndpoint: relayEndpoint || null,
  });
}

function configuredReceiptIntegrityMigrations(environment = process.env) {
  const raw = String(environment.POLICYPOOL_RECEIPT_INTEGRITY_MIGRATIONS || "").trim();
  if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_MIGRATIONS_BYTES) {
    throw new ReceiptIntegrityError("receipt_integrity_migration_configuration_invalid");
  }
  let configuredEntries = [];
  if (raw) {
    try {
      configuredEntries = JSON.parse(raw);
    } catch {
      throw new ReceiptIntegrityError("receipt_integrity_migration_configuration_invalid");
    }
  }
  if (!Array.isArray(configuredEntries)) {
    throw new ReceiptIntegrityError("receipt_integrity_migration_configuration_invalid");
  }
  const entries = [...PREDEPLOY_RECEIPT_INTEGRITY_MIGRATIONS, ...configuredEntries];
  if (entries.length > MAX_RECEIPT_MIGRATIONS) {
    throw new ReceiptIntegrityError("receipt_integrity_migration_configuration_invalid");
  }
  const migrations = new Map();
  for (const entry of entries) {
    const receiptId = String(entry?.receiptId || "");
    const receiptHash = String(entry?.receiptHash || "");
    const providerRelayEndpoint = entry?.providerRelayEndpoint == null
      ? null
      : String(entry.providerRelayEndpoint);
    if (
      !RECEIPT_ID_RE.test(receiptId)
      || !RECEIPT_HASH_RE.test(receiptHash)
      || (
        providerRelayEndpoint !== null
        && !providerRelayRoute(providerRelayEndpoint, "configured-migration")
      )
      || migrations.has(receiptId)
    ) {
      throw new ReceiptIntegrityError("receipt_integrity_migration_configuration_invalid");
    }
    migrations.set(receiptId, Object.freeze({ receiptHash, providerRelayEndpoint }));
  }
  return migrations;
}

function sameNonemptyValue(left, right) {
  const expected = String(left || "");
  return Boolean(expected) && expected.toLowerCase() === String(right || "").toLowerCase();
}

function sameNonemptyIdentifier(left, right) {
  const expected = String(left || "");
  return Boolean(expected) && expected === String(right || "");
}

function sameNonemptyAtomic(left, right) {
  const expected = String(left ?? "");
  const actual = String(right ?? "");
  return /^(0|[1-9][0-9]*)$/.test(expected)
    && /^(0|[1-9][0-9]*)$/.test(actual)
    && BigInt(expected) === BigInt(actual);
}

export function buildPreAnchorReceiptIntegrityAnchor(
  record,
  environment = process.env,
) {
  const receipt = record?.receipt;
  const endpoint = receipt?.providerRelay?.endpoint || null;
  const trustedAnchor = configuredReceiptIntegrityMigrations(environment)
    .get(String(record?.receiptId || ""));
  if (
    !receipt
    || record.receiptId !== receipt.receiptId
    || !trustedAnchor
    || trustedAnchor.receiptHash !== receipt.receiptHash
    || trustedAnchor.providerRelayEndpoint !== endpoint
  ) {
    throw new ReceiptIntegrityError("receipt_integrity_anchor_backfill_ineligible");
  }
  const durableRelay = Boolean(record.relayGrantPayload)
    || record.receiptContext?.policy?.clockMode === "policypool_relay";
  const receiptRelay = receipt.target?.clockMode === "policypool_relay";
  if (durableRelay !== receiptRelay) {
    throw new ReceiptIntegrityError("receipt_integrity_anchor_backfill_ineligible");
  }
  if (durableRelay) {
    const coverageCapAtomic = receipt?.covenant?.coverageCapAtomic;
    if (
      receipt.version !== "0.4.0"
      || receipt.outcome?.type !== "ISSUED"
      || (record.receiptDocumentKind
        && record.receiptDocumentKind !== STORED_RECEIPT_SHAPES.issued)
      || !sameNonemptyValue(record.finalizedAt, receipt.generatedAt)
      || !sameNonemptyValue(
        record.settlement?.transaction,
        receipt.servicePayment?.transaction,
      )
      || !sameNonemptyAtomic(record.providerBondLiabilityAtomic, coverageCapAtomic)
      || !sameNonemptyAtomic(record.receiptContext?.coverageCapAtomic, coverageCapAtomic)
      || !sameNonemptyAtomic(receipt.providerBond?.lockedAtomic, coverageCapAtomic)
      || String(record.liabilityAtomic ?? "") !== "0"
      || !sameNonemptyAtomic(
        record.settlement?.transfer?.amountAtomic,
        receipt.servicePayment?.amountAtomic,
      )
      || !sameNonemptyAtomic(
        record.paymentReceiptTerms?.amountAtomic,
        receipt.servicePayment?.amountAtomic,
      )
      || !sameNonemptyValue(
        record.universalCovenant?.covenantId,
        receipt.covenant?.onchain?.covenantId,
      )
      || !sameNonemptyIdentifier(
        record.relayGrantPayload?.grantId,
        receipt.providerRelay?.grantId,
      )
      || !sameNonemptyIdentifier(
        record.relayGrantPayload?.expiresAt,
        receipt.providerRelay?.grantExpiresAt,
      )
    ) {
      throw new ReceiptIntegrityError("receipt_integrity_anchor_backfill_ineligible");
    }
  }
  const anchor = buildReceiptIntegrityAnchor(receipt);
  verifyReceiptIntegrity(receipt, { anchor });
  return anchor;
}

export async function ensureReceiptIntegrityAnchor(record, ledger) {
  if (!record?.receipt || record.receiptIntegrityAnchor) return record;
  if (!ledger?.backfillReceiptIntegrityAnchor) {
    throw new ReceiptIntegrityError("receipt_integrity_anchor_backfill_unavailable");
  }
  const anchor = buildPreAnchorReceiptIntegrityAnchor(record);
  const persisted = await ledger.backfillReceiptIntegrityAnchor(
    record.receiptId,
    anchor.receiptHash,
    anchor,
  );
  if (!persisted?.receiptIntegrityAnchor) {
    throw new ReceiptIntegrityError("receipt_integrity_anchor_backfill_conflict");
  }
  return record.replayed ? { ...persisted, replayed: true } : persisted;
}

function embeddedPolicyPoolRoutes(receipt, environment, anchor) {
  const routes = [];
  const reserveUrl = receipt?.reserve?.publicUrl;
  if (reserveUrl) {
    const route = publicRouteForUrl(reserveUrl);
    // POLICYPOOL_RESERVE_URL historically allowed a third-party evidence page.
    // Only a known PolicyPool URL participates in same-route enforcement.
    if (route) routes.push({ field: "reserve.publicUrl", route });
  }
  const relayEndpoint = receipt?.providerRelay?.endpoint;
  if (
    receipt?.target?.clockMode === "policypool_relay"
    && (typeof relayEndpoint !== "string" || relayEndpoint.length === 0)
  ) {
    throw new ReceiptIntegrityError(
      "receipt_provider_relay_missing",
      "Relay-clock receipts require a provider relay endpoint",
    );
  }
  if (relayEndpoint) {
    const route = configuredProviderRelayRoute(relayEndpoint, environment)
      || anchoredProviderRelayRoute(relayEndpoint, anchor);
    if (!route) {
      throw new ReceiptIntegrityError(
        "receipt_public_origin_untrusted",
        "Receipt relay endpoint is not the exact configured or issuance-anchored PolicyPool route",
      );
    }
    routes.push({ field: "providerRelay.endpoint", route });
  }
  return routes;
}

export function verifyReceiptIntegrity(
  receipt,
  { environment = process.env, anchor = null } = {},
) {
  const claimed = String(receipt?.receiptHash || "");
  if (!RECEIPT_HASH_RE.test(claimed)) {
    throw new ReceiptIntegrityError("receipt_hash_invalid");
  }
  if (anchor !== null) {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
      throw new ReceiptIntegrityError("receipt_integrity_anchor_invalid");
    }
    if (String(anchor.receiptHash || "") !== claimed) {
      throw new ReceiptIntegrityError("receipt_hash_anchor_mismatch");
    }
    const relayEndpoint = receipt?.providerRelay?.endpoint || null;
    if ((anchor.providerRelayEndpoint || null) !== relayEndpoint) {
      throw new ReceiptIntegrityError("receipt_provider_relay_anchor_mismatch");
    }
  }
  const computed = computeReceiptHash(receipt);
  if (computed !== claimed) {
    throw new ReceiptIntegrityError("receipt_hash_mismatch");
  }

  const routes = embeddedPolicyPoolRoutes(receipt, environment, anchor);
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
