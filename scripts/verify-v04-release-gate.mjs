import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [
  packageJson,
  configuration,
  manager,
  vault,
  enrollment,
  manifest,
  deployment,
  environment,
  documentation,
  vercel,
] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("api/lib/universal-config.js"),
  read("src/CoverageManager.sol"),
  read("src/ProviderBondVault.sol"),
  read("api/lib/provider-enrollment.js"),
  read("api/universal-manifest.js"),
  read("script/DeployAgentCoverageV04.s.sol"),
  read(".env.example"),
  read("docs/UNIVERSAL_COVERAGE_V04.md"),
  read("vercel.json").then(JSON.parse),
]);

assert.equal(packageJson.version, "0.4.0");
assert.match(configuration, /enabled:\s*process\.env\.POLICYPOOL_UNIVERSAL_ENABLED === "true"/);
assert.match(configuration, /sharedCoverageEnabled:\s*process\.env\.POLICYPOOL_SHARED_COVERAGE_ENABLED === "true"/);
assert.match(manager, /coverageCapAtomic > policyMaxCapAtomic/);
assert.match(manager, /enrollmentExpiresAt\) != uint256\(verifiedAcceptanceAt\) \+ enrollmentWindowSeconds/);
assert.match(manager, /mapping\(bytes32 jobId => bytes32 covenantId\) public coveredJobCovenant/);
assert.match(manager, /revert JobAlreadyCovered\(\)/);
assert.match(vault, /function initializeManager\(address nextManager\) external onlyOwner/);
assert.doesNotMatch(vault, /function setManager\(/);
assert.match(enrollment, /provider_premium_not_supported_v04/);
assert.match(manifest, /sharedReserveForNewProviders:\s*false/);
assert.match(manifest, /requires_live_quote_time_owner_fingerprint_policy_and_bond_revalidation/);
assert.ok(
  deployment.indexOf("vault.initializeManager(address(manager))")
    < deployment.indexOf("vault.transferOwnership(owner)"),
  "bond manager must be wired before optional owner handoff",
);
for (const line of [
  "POLICYPOOL_UNIVERSAL_ENABLED=false",
  "POLICYPOOL_SHARED_COVERAGE_ENABLED=false",
  "POLICYPOOL_RELAY_GRANT_SECRET=",
  "POLICYPOOL_MANAGER_PRIVATE_KEY=",
]) {
  assert.ok(environment.includes(line), `.env.example missing ${line}`);
}
assert.match(documentation, /BLOCKED: confirmed unresolved High issue/);
assert.match(documentation, /hardened source now differs from that bytecode and is not deployed/i);
assert.match(documentation, /Production remains v0\.3/);
assert.match(documentation, /Final payout remains outside the scheduler/);
assert.ok(
  vercel.routes.some((route) => route.src === "/providers/enroll" && route.dest === "/web/enroll.html"),
  "provider enrollment route must stay explicit",
);

console.log("PolicyPool v0.4 release contract passed: feature gate, provider-first loss, signed limits, rollout, and fallback are explicit.");
