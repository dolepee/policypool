import { header } from "./utils.js";

export const DEFAULT_PUBLIC_ORIGIN = "https://policypool.dolepee.com";

export class PublicOriginConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicOriginConfigurationError";
  }
}

function publicPathPrefix(environment = process.env) {
  const raw = String(environment.POLICYPOOL_PUBLIC_PATH_PREFIX || "").trim();
  if (!raw) return "";
  if (
    !raw.startsWith("/")
    || raw === "/"
    || raw.endsWith("/")
    || raw.includes("//")
    || raw.includes("\\")
    || raw.includes("%")
    || raw.split("/").some((segment) => segment === "." || segment === "..")
    || !/^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(raw)
  ) {
    throw new PublicOriginConfigurationError(
      "POLICYPOOL_PUBLIC_PATH_PREFIX must be a normalized absolute path prefix",
    );
  }
  return raw;
}

function parseHttpsOrigin(value, label) {
  const raw = String(value || "").trim();
  if (!raw) throw new PublicOriginConfigurationError(`${label} is empty`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PublicOriginConfigurationError(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new PublicOriginConfigurationError(
      `${label} must be a credential-free HTTPS origin without a path, query, or fragment`,
    );
  }
  return parsed.origin;
}

export function configuredPublicOrigin(environment = process.env) {
  return parseHttpsOrigin(
    environment.POLICYPOOL_PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN,
    "POLICYPOOL_PUBLIC_ORIGIN",
  );
}

export function requestPublicOrigin(req, environment = process.env) {
  if (String(environment.POLICYPOOL_PUBLIC_ORIGIN || "").trim()) {
    return configuredPublicOrigin(environment);
  }
  const host = header(req, "x-forwarded-host") || header(req, "host");
  const proto = String(header(req, "x-forwarded-proto") || "https").toLowerCase();
  if (proto !== "https" || !host || /[\s/@\\]/.test(host)) {
    return DEFAULT_PUBLIC_ORIGIN;
  }
  try {
    return parseHttpsOrigin(`https://${host}`, "request public origin");
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

export function publicUrl(pathname, environment = process.env) {
  const path = new URL(pathname, `${DEFAULT_PUBLIC_ORIGIN}/`);
  const prefix = publicPathPrefix(environment);
  return new URL(
    `${prefix}${path.pathname}${path.search}${path.hash}`,
    `${configuredPublicOrigin(environment)}/`,
  ).toString();
}

// Builds a public URL for a known canonical handler path. The pathname argument
// is deliberately not derived from req.url: reverse proxies may preserve or
// rewrite their public mount, while the service contract itself is fixed.
export function canonicalRequestPublicUrl(req, pathname, environment = process.env) {
  const origin = requestPublicOrigin(req, environment);
  const canonical = new URL(pathname, `${DEFAULT_PUBLIC_ORIGIN}/`);
  const prefix = publicPathPrefix(environment);
  return new URL(`${prefix}${canonical.pathname}${canonical.search}`, `${origin}/`);
}

export const __test = { publicPathPrefix };
