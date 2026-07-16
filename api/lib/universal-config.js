import { getAddress, isAddress } from "viem";

function optionalAddress(value) {
  const raw = String(value || "").trim();
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

export const UNIVERSAL = {
  version: "0.4.0",
  enabled: process.env.POLICYPOOL_UNIVERSAL_ENABLED === "true",
  sharedCoverageEnabled: process.env.POLICYPOOL_SHARED_COVERAGE_ENABLED === "true",
  policyRegistry: optionalAddress(process.env.POLICYPOOL_POLICY_REGISTRY_ADDRESS),
  bondVault: optionalAddress(process.env.POLICYPOOL_BOND_VAULT_ADDRESS),
  coverageManager: optionalAddress(process.env.POLICYPOOL_COVERAGE_MANAGER_ADDRESS),
  a2aAdapter: optionalAddress(process.env.POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS),
  relayAdapter: optionalAddress(process.env.POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS),
  relaySigner: optionalAddress(process.env.POLICYPOOL_RELAY_SIGNER_ADDRESS),
  registryPrefix: process.env.POLICYPOOL_PROVIDER_REGISTRY_PREFIX || "pp:providers:v04",
  maximumSlaSeconds: Number(process.env.POLICYPOOL_V04_MAX_SLA_SECONDS || 7 * 24 * 60 * 60),
  providerExposureMultiplierBps: Number(process.env.POLICYPOOL_PROVIDER_EXPOSURE_MULTIPLIER_BPS || 10_000),
};

export function universalConfiguration() {
  const missing = [];
  if (!UNIVERSAL.policyRegistry) missing.push("POLICYPOOL_POLICY_REGISTRY_ADDRESS");
  if (!UNIVERSAL.bondVault) missing.push("POLICYPOOL_BOND_VAULT_ADDRESS");
  if (!UNIVERSAL.coverageManager) missing.push("POLICYPOOL_COVERAGE_MANAGER_ADDRESS");
  if (!UNIVERSAL.a2aAdapter) missing.push("POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS");
  if (!UNIVERSAL.relayAdapter) missing.push("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS");
  if (!UNIVERSAL.relaySigner) missing.push("POLICYPOOL_RELAY_SIGNER_ADDRESS");
  return {
    ready: UNIVERSAL.enabled && missing.length === 0,
    enabled: UNIVERSAL.enabled,
    version: UNIVERSAL.version,
    policyRegistry: UNIVERSAL.policyRegistry,
    bondVault: UNIVERSAL.bondVault,
    coverageManager: UNIVERSAL.coverageManager,
    a2aAdapter: UNIVERSAL.a2aAdapter,
    relayAdapter: UNIVERSAL.relayAdapter,
    relaySigner: UNIVERSAL.relaySigner,
    maximumSlaSeconds: UNIVERSAL.maximumSlaSeconds,
    sharedCoverageEnabled: UNIVERSAL.sharedCoverageEnabled,
    providerExposureMultiplierBps: UNIVERSAL.providerExposureMultiplierBps,
    missing,
  };
}
