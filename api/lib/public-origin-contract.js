export class PublicOriginContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "PublicOriginContractError";
    this.code = code;
  }
}

function exactHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an exact HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    throw new TypeError(`${label} must be an exact HTTPS origin`);
  }
  return parsed.origin;
}

function route(key, origin, pathPrefix = "") {
  if (
    pathPrefix
    && (!pathPrefix.startsWith("/") || pathPrefix.endsWith("/") || pathPrefix.includes("//"))
  ) {
    throw new TypeError("PolicyPool public path prefix is invalid");
  }
  return Object.freeze({
    key,
    origin: exactHttpsOrigin(origin, `${key} origin`),
    pathPrefix,
  });
}

export const CUSTOM_PUBLIC_ROUTE = route(
  "canonical-custom",
  "https://policypool.dolepee.com",
);

// Render remains an accepted rollback/upstream route so records issued during
// the reviewer-relay period keep verifying. It is not the public issuance
// identity once the custom front door is canonical.
export const RENDER_ROLLBACK_PUBLIC_ROUTE = route(
  "render-upstream-rollback",
  "https://okx-agent-review-relay.onrender.com",
  "/policypool",
);

export const LEGACY_VERCEL_PUBLIC_ROUTE = route(
  "legacy-vercel",
  "https://policypool.vercel.app",
);

export const VERIFICATION_PUBLIC_ROUTES = Object.freeze([
  CUSTOM_PUBLIC_ROUTE,
  RENDER_ROLLBACK_PUBLIC_ROUTE,
  LEGACY_VERCEL_PUBLIC_ROUTE,
]);

export const CURRENT_ISSUANCE_PUBLIC_ROUTE = CUSTOM_PUBLIC_ROUTE;

function pathBelongsToRoute(pathname, routeContract) {
  if (!routeContract.pathPrefix) return pathname.startsWith("/");
  return pathname === routeContract.pathPrefix
    || pathname.startsWith(`${routeContract.pathPrefix}/`);
}

export function publicRouteForUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return VERIFICATION_PUBLIC_ROUTES.find(
    (candidate) => parsed.origin === candidate.origin
      && pathBelongsToRoute(parsed.pathname, candidate),
  ) || null;
}

export function requireCompatiblePublicUrl(value) {
  const resolved = publicRouteForUrl(value);
  if (!resolved) {
    throw new PublicOriginContractError(
      "receipt_public_origin_untrusted",
      "Receipt URL is not on a compatible PolicyPool public route",
    );
  }
  return resolved;
}
