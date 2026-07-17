import { getAddress, isAddress } from "viem";

function optionalAddress(value) {
  const raw = String(value || "").trim();
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

function optionalHttpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function optionalHttpsOrigin(value) {
  const parsed = optionalHttpsUrl(value);
  if (!parsed) return null;
  const url = new URL(parsed);
  return url.pathname === "/" && !url.search ? url.origin : null;
}

export const UNIVERSAL = {
  version: "0.4.0",
  enabled: process.env.POLICYPOOL_UNIVERSAL_ENABLED === "true",
  sharedCoverageEnabled: process.env.POLICYPOOL_SHARED_COVERAGE_ENABLED === "true",
  policyRegistry: optionalAddress(process.env.POLICYPOOL_POLICY_REGISTRY_ADDRESS),
  bondVault: optionalAddress(process.env.POLICYPOOL_BOND_VAULT_ADDRESS),
  evidenceVerifier: optionalAddress(process.env.POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS),
  recoveryEvidenceVerifier: optionalAddress(process.env.POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS),
  coverageManager: optionalAddress(process.env.POLICYPOOL_COVERAGE_MANAGER_ADDRESS),
  feeEscrow: optionalAddress(process.env.POLICYPOOL_FEE_ESCROW_ADDRESS),
  directA2mcpEnabled: process.env.POLICYPOOL_DIRECT_A2MCP_ENABLED === "true",
  directFeeAtomic: Number(process.env.POLICYPOOL_DIRECT_FEE_ATOMIC || 100_000),
  publicOrigin: optionalHttpsOrigin(
    process.env.POLICYPOOL_PUBLIC_ORIGIN || "https://policypool.vercel.app",
  ),
  a2aAdapter: optionalAddress(process.env.POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS),
  relayAdapter: optionalAddress(process.env.POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS),
  relaySigner: optionalAddress(process.env.POLICYPOOL_RELAY_SIGNER_ADDRESS),
  evidenceAttestationUrl: optionalHttpsUrl(process.env.POLICYPOOL_EVIDENCE_ATTESTATION_URL),
  evidenceAttestationTokenConfigured: Boolean(String(process.env.POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN || "").trim()),
  evidenceThreshold: Number(process.env.POLICYPOOL_EVIDENCE_THRESHOLD || 0),
  recoveryEvidenceAttestationUrl: optionalHttpsUrl(process.env.POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL),
  recoveryEvidenceAttestationTokenConfigured: Boolean(
    String(process.env.POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN || "").trim(),
  ),
  recoveryEvidenceThreshold: Number(process.env.POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD || 0),
  registryPrefix: process.env.POLICYPOOL_PROVIDER_REGISTRY_PREFIX || "pp:providers:v04",
  maximumSlaSeconds: Number(process.env.POLICYPOOL_V04_MAX_SLA_SECONDS || 7 * 24 * 60 * 60),
  providerExposureMultiplierBps: Number(process.env.POLICYPOOL_PROVIDER_EXPOSURE_MULTIPLIER_BPS || 10_000),
};

export function universalConfiguration() {
  const missing = [];
  if (!UNIVERSAL.policyRegistry) missing.push("POLICYPOOL_POLICY_REGISTRY_ADDRESS");
  if (!UNIVERSAL.bondVault) missing.push("POLICYPOOL_BOND_VAULT_ADDRESS");
  if (!UNIVERSAL.evidenceVerifier) missing.push("POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS");
  if (!UNIVERSAL.recoveryEvidenceVerifier) missing.push("POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS");
  if (!UNIVERSAL.coverageManager) missing.push("POLICYPOOL_COVERAGE_MANAGER_ADDRESS");
  if (!Number.isSafeInteger(UNIVERSAL.directFeeAtomic) || UNIVERSAL.directFeeAtomic <= 0) {
    missing.push("POLICYPOOL_DIRECT_FEE_ATOMIC");
  }
  if (!UNIVERSAL.a2aAdapter) missing.push("POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS");
  if (!UNIVERSAL.relayAdapter) missing.push("POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS");
  if (!UNIVERSAL.relaySigner) missing.push("POLICYPOOL_RELAY_SIGNER_ADDRESS");
  if (!UNIVERSAL.evidenceAttestationUrl) missing.push("POLICYPOOL_EVIDENCE_ATTESTATION_URL");
  if (!UNIVERSAL.evidenceAttestationTokenConfigured) missing.push("POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN");
  if (!Number.isSafeInteger(UNIVERSAL.evidenceThreshold) || UNIVERSAL.evidenceThreshold < 3) {
    missing.push("POLICYPOOL_EVIDENCE_THRESHOLD");
  }
  if (!UNIVERSAL.recoveryEvidenceAttestationUrl) missing.push("POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL");
  if (!UNIVERSAL.recoveryEvidenceAttestationTokenConfigured) {
    missing.push("POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN");
  }
  if (!Number.isSafeInteger(UNIVERSAL.recoveryEvidenceThreshold) || UNIVERSAL.recoveryEvidenceThreshold < 3) {
    missing.push("POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD");
  }
  return {
    ready: UNIVERSAL.enabled && missing.length === 0,
    enabled: UNIVERSAL.enabled,
    version: UNIVERSAL.version,
    policyRegistry: UNIVERSAL.policyRegistry,
    bondVault: UNIVERSAL.bondVault,
    evidenceVerifier: UNIVERSAL.evidenceVerifier,
    recoveryEvidenceVerifier: UNIVERSAL.recoveryEvidenceVerifier,
    coverageManager: UNIVERSAL.coverageManager,
    feeEscrow: UNIVERSAL.feeEscrow,
    directA2mcpEnabled: UNIVERSAL.directA2mcpEnabled,
    directFeeAtomic: UNIVERSAL.directFeeAtomic,
    publicOrigin: UNIVERSAL.publicOrigin,
    a2aAdapter: UNIVERSAL.a2aAdapter,
    relayAdapter: UNIVERSAL.relayAdapter,
    relaySigner: UNIVERSAL.relaySigner,
    evidenceAttestationUrl: UNIVERSAL.evidenceAttestationUrl,
    evidenceAttestationTokenConfigured: UNIVERSAL.evidenceAttestationTokenConfigured,
    evidenceThreshold: UNIVERSAL.evidenceThreshold,
    recoveryEvidenceAttestationUrl: UNIVERSAL.recoveryEvidenceAttestationUrl,
    recoveryEvidenceAttestationTokenConfigured: UNIVERSAL.recoveryEvidenceAttestationTokenConfigured,
    recoveryEvidenceThreshold: UNIVERSAL.recoveryEvidenceThreshold,
    maximumSlaSeconds: UNIVERSAL.maximumSlaSeconds,
    sharedCoverageEnabled: UNIVERSAL.sharedCoverageEnabled,
    providerExposureMultiplierBps: UNIVERSAL.providerExposureMultiplierBps,
    missing,
  };
}
