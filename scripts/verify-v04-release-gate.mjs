import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [
  packageJson,
  configuration,
  manager,
  evidenceVerifier,
  vault,
  issuer,
  evidenceClient,
  relay,
  enrollment,
  manifest,
  deployment,
  wiring,
  environment,
  documentation,
  vercel,
] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("api/lib/universal-config.js"),
  read("src/CoverageManager.sol"),
  read("src/CoverageEvidenceVerifier.sol"),
  read("src/ProviderBondVault.sol"),
  read("api/lib/universal-issuer.js"),
  read("api/lib/evidence-attestation.js"),
  read("src/adapters/RelayReceiptVerifier.sol"),
  read("api/lib/provider-enrollment.js"),
  read("api/universal-manifest.js"),
  read("script/DeployAgentCoverageV04.s.sol"),
  read("script/WireAgentCoverageV04Roles.s.sol"),
  read(".env.example"),
  read("docs/UNIVERSAL_COVERAGE_V04.md"),
  read("vercel.json").then(JSON.parse),
]);

assert.equal(packageJson.version, "0.4.0");
assert.match(configuration, /enabled:\s*process\.env\.POLICYPOOL_UNIVERSAL_ENABLED === "true"/);
assert.match(configuration, /sharedCoverageEnabled:\s*process\.env\.POLICYPOOL_SHARED_COVERAGE_ENABLED === "true"/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_ATTESTATION_URL/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_THRESHOLD/);
assert.match(manager, /coverageCapAtomic > policyMaxCapAtomic/);
assert.match(manager, /evidence\.enrollmentExpiresAt[\s\S]*evidence\.verifiedAcceptanceAt\) \+ enrollmentWindowSeconds/);
assert.match(manager, /mapping\(bytes32 jobId => bytes32 covenantId\) public coveredJobCovenant/);
assert.match(manager, /revert JobAlreadyCovered\(\)/);
assert.match(manager, /ICoverageEvidenceVerifier public immutable evidenceVerifier/);
assert.match(manager, /mapping\(bytes32 evidenceDigest => bool consumed\) public consumedEvidenceDigest/);
assert.match(manager, /function settleNetLoss[\s\S]*external[\s\S]*nonReentrant/);
assert.doesNotMatch(manager, /onlyOperator|setOperator|address public operator|address public owner/);
assert.match(evidenceVerifier, /threshold_ < 2/);
assert.match(evidenceVerifier, /EIP712Domain\(string name,string version,uint256 chainId,address verifyingContract\)/);
assert.match(evidenceVerifier, /attestationDigest\(msg\.sender, action, payloadHash\)/);
assert.doesNotMatch(evidenceVerifier, /onlyOwner|setSigner|transferOwnership/);
assert.match(vault, /function initializeManager\(address nextManager\) external onlyOwner/);
assert.doesNotMatch(vault, /function setManager\(/);
assert.match(issuer, /createEvidenceAttestationClient/);
assert.match(issuer, /POLICYPOOL_RELAYER_PRIVATE_KEY/);
assert.doesNotMatch(issuer, /POLICYPOOL_MANAGER_PRIVATE_KEY/);
assert.match(issuer, /chainId:\s*XLAYER\.id/);
assert.match(issuer, /manager:\s*configuration\.coverageManager/);
assert.match(issuer, /verifier:\s*configuration\.evidenceVerifier/);
assert.match(evidenceClient, /evidence_attestation_domain_invalid/);
assert.match(relay, /EIP712Domain\(string name,string version,uint256 chainId,address verifyingContract\)/);
assert.match(enrollment, /provider_premium_not_supported_v04/);
assert.match(manifest, /sharedReserveForNewProviders:\s*false/);
assert.match(manifest, /requires_live_quote_time_owner_fingerprint_policy_and_bond_revalidation/);
assert.ok(
  deployment.indexOf("vault.initializeManager(address(manager))")
    < deployment.indexOf("vault.transferOwnership(config.owner)"),
  "bond manager must be wired before optional owner handoff",
);
assert.match(wiring, /evidenceVerifier\.signerCount\(\) != evidenceSigners\.length/);
assert.match(wiring, /evidenceVerifier\.signerAt\(index\) != evidenceSigners\[index\]/);
for (const line of [
  "POLICYPOOL_UNIVERSAL_ENABLED=false",
  "POLICYPOOL_SHARED_COVERAGE_ENABLED=false",
  "POLICYPOOL_RELAY_GRANT_SECRET=",
  "POLICYPOOL_EVIDENCE_SIGNERS=",
  "POLICYPOOL_EVIDENCE_THRESHOLD=2",
  "POLICYPOOL_EVIDENCE_ATTESTATION_URL=",
  "POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN=",
  "POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS=",
  "POLICYPOOL_RELAYER_PRIVATE_KEY=",
]) {
  assert.ok(environment.includes(line), `.env.example missing ${line}`);
}
assert.match(documentation, /REMEDIATED IN SOURCE: independent review and redeployment required/);
assert.match(documentation, /hardened source now differs from that bytecode and is not deployed/i);
assert.match(documentation, /Production remains v0\.3/);
assert.match(documentation, /threshold evidence quorum/);
assert.ok(
  vercel.routes.some((route) => route.src === "/providers/enroll" && route.dest === "/web/enroll.html"),
  "provider enrollment route must stay explicit",
);

console.log("PolicyPool v0.4 release contract passed: feature gate, provider-first loss, signed limits, rollout, and fallback are explicit.");
