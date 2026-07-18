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
  reconciler,
  coveredReceipt,
  evidenceClient,
  relay,
  providerRelay,
  providerPolicyStore,
  relayGrant,
  chain,
  universalPolicy,
  enrollment,
  manifest,
  deployment,
  wiring,
  environment,
  documentation,
  securityNotes,
  auditReport,
  vercel,
  reconciliationWorkflow,
] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("api/lib/universal-config.js"),
  read("src/CoverageManager.sol"),
  read("src/CoverageEvidenceVerifier.sol"),
  read("src/ProviderBondVault.sol"),
  read("api/lib/universal-issuer.js"),
  read("api/lib/universal-reconciler.js"),
  read("api/covered-job-receipt.js"),
  read("api/lib/evidence-attestation.js"),
  read("src/adapters/RelayReceiptVerifier.sol"),
  read("api/lib/provider-relay.js"),
  read("api/lib/provider-policy-store.js"),
  read("api/lib/relay-grant.js"),
  read("api/lib/chain.js"),
  read("api/lib/universal-policy.js"),
  read("api/lib/provider-enrollment.js"),
  read("api/universal-manifest.js"),
  read("script/DeployAgentCoverageV04.s.sol"),
  read("script/WireAgentCoverageV04Roles.s.sol"),
  read(".env.example"),
  read("docs/UNIVERSAL_COVERAGE_V04.md"),
  read("docs/SECURITY_NOTES.md"),
  read("docs/INTERNAL_SOLIDITY_AUDIT_V04.md"),
  read("vercel.json").then(JSON.parse),
  read(".github/workflows/reconcile-agent-coverage.yml"),
]);
const [
  feeEscrowContract,
  feeEscrowClient,
  directConstants,
  directPolicyFee,
  directCoordinator,
  directState,
  directReconciler,
  directHandler,
  directReconcileHandler,
  directSchedule,
] = await Promise.all([
  read("src/PolicyFeeEscrow.sol"),
  read("api/lib/policy-fee-escrow.js"),
  read("api/lib/direct-a2mcp-constants.js"),
  read("api/lib/direct-policy-fee.js"),
  read("api/lib/direct-a2mcp.js"),
  read("api/lib/direct-a2mcp-store.js"),
  read("api/lib/direct-a2mcp-reconciler.js"),
  read("api/direct-a2mcp.js"),
  read("api/reconcile-direct-a2mcp.js"),
  read("scripts/setup-qstash-direct-a2mcp-schedule.mjs"),
]);

assert.equal(packageJson.version, "0.4.0");
assert.match(configuration, /enabled:\s*process\.env\.POLICYPOOL_UNIVERSAL_ENABLED === "true"/);
assert.match(configuration, /sharedCoverageEnabled:\s*process\.env\.POLICYPOOL_SHARED_COVERAGE_ENABLED === "true"/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_ATTESTATION_URL/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN/);
assert.match(configuration, /POLICYPOOL_EVIDENCE_THRESHOLD/);
assert.match(configuration, /POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL/);
assert.match(configuration, /POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN/);
assert.match(configuration, /POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD/);
assert.match(configuration, /POLICYPOOL_DIRECT_FEE_ATOMIC/);
assert.match(configuration, /UNIVERSAL\.evidenceThreshold < 3/);
assert.match(configuration, /UNIVERSAL\.recoveryEvidenceThreshold < 3/);
assert.match(manager, /coverageCapAtomic > policyMaxCapAtomic/);
assert.match(manager, /evidence\.enrollmentExpiresAt[\s\S]*evidence\.verifiedAcceptanceAt\) \+ enrollmentWindowSeconds/);
assert.match(manager, /mapping\(bytes32 jobId => bytes32 covenantId\) public coveredJobCovenant/);
assert.match(manager, /revert JobAlreadyCovered\(\)/);
assert.match(manager, /ICoverageEvidenceVerifier public immutable evidenceVerifier/);
assert.match(manager, /ICoverageEvidenceVerifier public immutable recoveryEvidenceVerifier/);
assert.match(manager, /mapping\(bytes32 evidenceDigest => bool consumed\) public consumedEvidenceDigest/);
assert.match(manager, /function settleNetLoss[\s\S]*external[\s\S]*nonReentrant/);
assert.match(manager, /SETTLEMENT_EVIDENCE_MAX_AGE = 10 minutes/);
assert.match(manager, /SETTLEMENT_CHALLENGE_PERIOD = 24 hours/);
assert.match(manager, /covenant\.payoutDueAt = uint64\(block\.timestamp\)/);
assert.match(manager, /EMERGENCY_EVIDENCE_DELAY = 30 days/);
assert.match(manager, /evidence\.recoveryFinalized/);
assert.match(manager, /evidence\.completedAt > releaseDeadline/);
assert.match(manager, /covenant\.state != CovenantState\.PayoutDue/);
assert.match(manager, /function emergencySettleNetLoss/);
assert.match(manager, /function cancelUnpaid/);
assert.match(manager, /function emergencyCancelUnpaid/);
assert.match(manager, /feeAuthorizationValidBefore/);
assert.match(manager, /coveredJobCovenant\[covenant\.jobId\] = bytes32\(0\)/);
assert.match(manager, /CANCELLATION_EVIDENCE_MAX_AGE = 10 minutes/);
assert.match(manager, /CLOCK_START_RECOVERY_PERIOD = 10 minutes/);
assert.match(manager, /evidence\.startedAt > covenant\.enrollmentExpiresAt/);
assert.match(manager, /feeAuthorization\.validBefore < evidence\.enrollmentExpiresAt/);
assert.match(manager, /feeAuthorizationValidBefore\) \+ CLOCK_START_RECOVERY_PERIOD/);
assert.match(manager, /recoveryEvidenceVerifier\.isSigner\(signer\)/);
assert.match(manager, /revert EvidenceSignerOverlap\(\)/);
assert.match(manager, /primaryCount != REQUIRED_EVIDENCE_SIGNERS/);
assert.match(manager, /evidenceVerifier\.threshold\(\) != REQUIRED_EVIDENCE_THRESHOLD/);
assert.doesNotMatch(manager, /onlyOperator|setOperator|address public operator|address public owner/);
assert.match(evidenceVerifier, /MIN_SIGNERS = 5/);
assert.match(evidenceVerifier, /MIN_THRESHOLD = 3/);
assert.match(evidenceVerifier, /EIP712Domain\(string name,string version,uint256 chainId,address verifyingContract\)/);
assert.match(evidenceVerifier, /attestationDigest\(msg\.sender, action, payloadHash\)/);
assert.doesNotMatch(evidenceVerifier, /onlyOwner|setSigner|transferOwnership/);
assert.match(vault, /function initializeManager\(address nextManager\) external onlyOwner/);
assert.doesNotMatch(vault, /function setManager\(/);
assert.match(vault, /recipientBalanceAfter - recipientBalanceBefore != amount/);
assert.match(feeEscrowContract, /contract PolicyFeeEscrow/);
assert.doesNotMatch(feeEscrowContract, /onlyOwner|function sweep|function setTreasury/);
assert.match(feeEscrowContract, /covenant\.state != CoverageManager\.CovenantState\.PendingStart/);
assert.match(feeEscrowContract, /block\.timestamp >= current\.refundAvailableAt/);
assert.match(feeEscrowContract, /recipientBalanceAfter - recipientBalanceBefore != amount/);
assert.match(feeEscrowClient, /function capture/);
assert.match(feeEscrowClient, /function refund/);
assert.match(issuer, /createEvidenceAttestationClient/);
assert.match(issuer, /POLICYPOOL_RELAYER_PRIVATE_KEY/);
assert.doesNotMatch(issuer, /POLICYPOOL_MANAGER_PRIVATE_KEY/);
assert.match(issuer, /chainId:\s*XLAYER\.id/);
assert.match(issuer, /manager:\s*configuration\.coverageManager/);
assert.match(issuer, /configuration\.evidenceVerifier/);
assert.match(issuer, /verifier:\s*recovery \? configuration\.recoveryEvidenceVerifier/);
assert.match(issuer, /recoveryFinalized !== true/);
assert.match(issuer, /completedAt:\s*BigInt\(seconds\(completedAt/);
assert.match(issuer, /action:\s*"cancel_unpaid"/);
assert.match(reconciler, /issuer\.settleNetLoss/);
assert.match(reconciler, /issuer\.cancelUnpaid/);
assert.match(reconciler, /payout_due_challenge_period_active/);
assert.match(reconciler, /verified_okx_a2a_deadline_breach_with_provider_bonded_sla_credit/);
assert.match(reconciler, /a2a_sla_credit_breach_evidence_unavailable/);
assert.match(reconciler, /requiresCompensation/);
assert.match(reconciler, /coverage_issuance_outcome_pending/);
assert.match(coveredReceipt, /paymentAuthorization:\s*feeAuthorization/);
assert.match(coveredReceipt, /provider_bond_cancellation_pending_authorization_expiry/);
assert.match(evidenceClient, /evidence_attestation_domain_invalid/);
assert.match(relay, /EIP712Domain\(string name,string version,uint256 chainId,address verifyingContract\)/);
assert.match(providerRelay, /lookup:\s*createPinnedLookup\(record\)/);
assert.match(providerRelay, /servername:\s*endpoint\.hostname/);
assert.match(providerRelay, /rejectUnauthorized:\s*true/);
assert.match(providerRelay, /await chain\.verifyProviderPaymentAuthorization/);
assert.match(providerRelay, /!sameAddress\(authorization\.authorization\.from, grant\.buyer\)/);
assert.match(providerRelay, /provider_payment_payer_mismatch/);
assert.match(providerRelay, /authorizationNonce:\s*authorization\.authorization\.nonce/);
assert.match(providerRelay, /provider_payment_authorization_already_used/);
assert.match(providerRelay, /requestDispatched = true/);
assert.match(providerRelay, /definitelyUnsettled = response\.status === 402/);
assert.match(providerRelay, /!requestDispatched \|\| definitelyUnsettled/);
assert.doesNotMatch(providerRelay, /!settlementObserved/);
assert.match(providerRelay, /source:\s*"policypool_relay_verified_x402_settlement"/);
assert.doesNotMatch(providerRelay, /paymentHeaderPresent/);
assert.match(providerPolicyStore, /reserveRelayExecution/);
assert.match(providerPolicyStore, /commitRelayExecutionReceipt/);
assert.match(providerPolicyStore, /releaseRelayExecution/);
assert.doesNotMatch(providerPolicyStore, /RELAY_GRANT_CLAIM_TTL_SECONDS/);
assert.match(providerPolicyStore, /function relayGrantClaimTtlSeconds\(expiresAt/);
assert.match(providerPolicyStore, /RELAY_GRANT_CLAIM_MAX_TTL_SECONDS = 8 \* 24 \* 60 \* 60/);
assert.match(providerPolicyStore, /relayGrantClaimTtlSeconds\(grantExpiresAt, this\.now\(\)\)/);
assert.match(
  providerPolicyStore,
  /redis\.call\("SET", KEYS\[1\], ARGV\[2\], "EX", ARGV\[5\]\)\s+redis\.call\("SET", KEYS\[2\], ARGV\[2\]\)/,
);
assert.match(providerPolicyStore, /redis\.call\("SET", KEYS\[5\], ARGV\[4\]\)/);
assert.match(providerPolicyStore, /\[grantKey, paymentKey, receiptKey, jobKey, covenantKey, responseKey\]/);
assert.match(providerPolicyStore, /getRelayResponse/);
assert.match(providerPolicyStore, /function startsVerifiedRelayClock\(record\)/);
assert.match(providerPolicyStore, /getRelayReceiptForCovenant/);
assert.match(providerPolicyStore, /relay-covenant/);
assert.match(providerPolicyStore, /record\?\.request\?\.paymentVerified === true/);
assert.match(providerPolicyStore, /targetJobId && startsVerifiedRelayClock\(record\)/);
assert.match(relayGrant, /MAX_RELAY_GRANT_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1_000/);
assert.match(relayGrant, /expiresAt > issuedAt \+ MAX_RELAY_GRANT_TTL_MS/);
assert.ok(
  providerRelay.indexOf("receiptSigner.signTypedData")
    < providerRelay.indexOf("store.commitRelayExecutionReceipt"),
  "the paid relay receipt must be signed before its claims commit",
);
assert.match(providerRelay, /covenantId:\s*grant\.covenantId\.toLowerCase\(\)/);
assert.match(reconciler, /relay_receipt_covenant_binding_invalid/);
assert.doesNotMatch(reconciler, /getLatestRelayReceiptForJob/);
assert.doesNotMatch(providerRelay, /store\.commitRelayExecution\(/);
assert.match(providerRelay, /canonicalEip3009AuthorizationIdentity/);
assert.match(providerRelay, /protocol:\s*"eip3009"/);
assert.doesNotMatch(providerRelay, /id:\s*`sha256:\$\{sha256\(raw\)\}`/);
assert.match(directCoordinator, /canonicalEip3009AuthorizationIdentity/);
assert.doesNotMatch(directCoordinator, /paymentHash:\s*`sha256:\$\{sha256\(raw\)\}`/);
assert.match(directCoordinator, /provider_delivery_breach_reconciliation_pending/);
assert.match(directReconciler, /if \(!relayGrant\?\.token\) return null/);
assert.match(directReconciler, /coverage_clock_recovery_expired/);
assert.match(reconciler, /relay_clock_recovery_pending/);
assert.match(chain, /event AuthorizationUsed\(address indexed authorizer, bytes32 indexed nonce\)/);
assert.match(chain, /verifyProviderPaymentAuthorization/);
assert.match(chain, /findProviderSettlement/);
assert.match(chain, /MAX_PROVIDER_SETTLEMENT_SEARCH_SECONDS = 20 \* 60/);
assert.match(chain, /firstEligibleBlock > 0n \? firstEligibleBlock - 1n : 0n/);
assert.match(directCoordinator, /provider_authorization_expired_unsettled/);
assert.match(
  directCoordinator,
  /PolicyPoolDirectA2MCPJob\(bytes32 policyId,address buyer,bytes32 requestHash,bytes32 providerAuthorizationHash\)/,
);
assert.match(directCoordinator, /direct_coverage_cap_must_equal_policy_cap/);
assert.match(directCoordinator, /direct_policy_cap_unavailable/);
assert.match(directConstants, /DIRECT_QUOTE_TTL_SECONDS = 10 \* 60/);
assert.match(directConstants, /MIN_DIRECT_EXECUTION_WINDOW_SECONDS = 30/);
assert.match(directConstants, /MAX_DIRECT_ENROLLMENT_WINDOW_SECONDS = Math\.min/);
assert.match(enrollment, /direct_enrollment_window_exceeds_authorization_limit/);
assert.match(directCoordinator, /direct_enrollment_window_unfundable/);
assert.match(directCoordinator, /minimumProviderValidBefore/);
assert.match(directCoordinator, /direct_authorization_window_elapsed_before_execution/);
assert.match(directPolicyFee, /nowSeconds >= refundAvailableAt \? "refund" : "capture"/);
assert.match(directPolicyFee, /action !== "capture" \|\| currentAction !== "refund"/);
assert.match(directCoordinator, /finalizeDirectPolicyFee/);
assert.match(directReconciler, /finalizeDirectPolicyFee/);
assert.doesNotMatch(directCoordinator, /await feeEscrow\.capture/);
assert.doesNotMatch(directReconciler, /await feeEscrow\.capture/);
assert.match(directCoordinator, /await relay\.recover/);
assert.match(directCoordinator, /await state\.retainRecovery/);
assert.match(directCoordinator, /provider_delivery_indeterminate_manual_resolution/);
assert.match(directCoordinator, /\["executing", "complete"\]\.includes\(bound\.state\)/);
assert.match(directCoordinator, /allowExpired:\s*recoveringExistingExecution/);
assert.match(directCoordinator, /settled_response_unavailable_coverage_remains_active/);
assert.match(directCoordinator, /policy_fee_refunded_provider_unsettled/);
assert.match(directCoordinator, /refunded_after_provider_settlement/);
assert.match(directState, /DEFAULT_EXECUTION_RETENTION_SECONDS = 10 \* 24 \* 60 \* 60/);
assert.match(directState, /createCipheriv\("aes-256-gcm"/);
assert.match(directState, /createDecipheriv\("aes-256-gcm"/);
assert.match(directState, /async function retainRecovery/);
assert.match(directState, /async function recoveryContext/);
assert.match(directState, /current\.state == 'complete'[\s\S]*current\.execution\.id ~= ARGV\[1\]/);
assert.match(directState, /reconcileCheckpoint/);
assert.match(directState, /executingIndexKey\(\)/);
assert.match(directState, /MARK_SCANNED_SCRIPT/);
assert.match(directState, /listExecuting/);
assert.match(directState, /markExecutingScanned/);
assert.match(directReconciler, /state\.listExecuting\(limit\)/);
assert.match(directReconciler, /state\.recoveryContext\(record\.id, record\.execution\.id\)/);
assert.match(directReconciler, /relay\.recover/);
assert.match(directReconciler, /state\.markReconciled\(record\.id\)/);
assert.doesNotMatch(directReconciler, /state\.list\(limit\)/);
assert.doesNotMatch(directReconciler, /provider_settlement_found_receipt_recovery_required/);
assert.match(directReconciler, /provider_delivery_indeterminate_manual_resolution/);
assert.match(directReconciler, /provider_settled_after_unpaid_cancellation_manual_resolution/);
assert.match(directReconciler, /cancel_unpaid_coverage/);
assert.match(directReconciler, /refund_policy_fee/);
assert.match(directHandler, /marketplaceTaskCompatible:\s*false/);
assert.match(directHandler, /provider-payment-signature/);
assert.match(directReconcileHandler, /upstash-signature/);
assert.match(directSchedule, /policypool-direct-a2mcp-reconciler-v04/);
assert.match(
  reconciliationWorkflow,
  /Reconcile direct A2MCP executions when enabled[\s\S]*if:\s*\$\{\{\s*always\(\)\s*\}\}/,
);
assert.match(reconciliationWorkflow, /https:\/\/policypool\.vercel\.app\/api\/direct-a2mcp/);
assert.match(reconciliationWorkflow, /https:\/\/policypool\.vercel\.app\/api\/reconcile-direct-a2mcp/);
assert.match(reconciliationWorkflow, /json\.load\(sys\.stdin\)\.get\("enabled"\) is True/);
assert.match(universalPolicy, /servicePriceAtomic:\s*servicePriceAtomic\.toString\(\)/);
assert.match(enrollment, /function feeAmountAtomic\(\) view returns \(uint128\)/);
assert.match(enrollment, /direct_policy_cap_exceeds_service_price/);
assert.match(enrollment, /direct_fee_escrow_mismatch/);
assert.match(enrollment, /direct_fee_not_expressible_for_cap/);
assert.match(enrollment, /direct_fee_premium_mismatch/);
assert.match(enrollment, /functionName:\s*"getPolicy"/);
assert.match(enrollment, /registeredTermsHash = policyTermsHash\(registeredPolicy\.terms\)/);
assert.match(enrollment, /policy_registered_terms_mismatch/);
assert.match(manifest, /sharedReserveForNewProviders:\s*false/);
assert.match(manifest, /requires_live_quote_time_owner_fingerprint_policy_and_bond_revalidation/);
assert.match(manifest, /settlementChallengePeriodSeconds:\s*86_400/);
assert.match(manifest, /provisionalBreachCanBeCorrectedByOnTimeCompletion:\s*true/);
assert.ok(
  deployment.indexOf("vault.initializeManager(address(manager))")
    < deployment.indexOf("vault.transferOwnership(config.owner)"),
  "bond manager must be wired before optional owner handoff",
);
assert.match(wiring, /deployed\.evidenceVerifier\.signerCount\(\) != roles\.evidenceSigners\.length/);
assert.match(wiring, /deployed\.evidenceVerifier\.signerAt\(index\) != roles\.evidenceSigners\[index\]/);
assert.match(
  wiring,
  /deployed\.recoveryEvidenceVerifier\.signerCount\(\) != roles\.recoveryEvidenceSigners\.length/,
);
assert.match(wiring, /roles\.recoveryEvidenceSigners\[index\] == roles\.evidenceSigners\[primaryIndex\]/);
assert.match(deployment, /new CoverageEvidenceVerifier\(config\.recoveryEvidenceSigners/);
assert.match(deployment, /new PolicyFeeEscrow/);
assert.match(deployment, /POLICYPOOL_FEE_ESCROW_ADDRESS/);
assert.match(deployment, /_requireDisjointEvidenceQuorums/);
assert.match(deployment, /block\.chainid != XLAYER_CHAIN_ID/);
assert.match(deployment, /config\.identityRegistry != OKX_AGENT_IDENTITY_REGISTRY/);
assert.match(deployment, /config\.paymentAsset != XLAYER_USDT0/);
assert.match(deployment, /_requireRoleOutsideQuorums/);
assert.match(deployment, /config\.monitor = vm\.envAddress\("POLICYPOOL_V04_MONITOR"\)/);
assert.match(deployment, /config\.monitor == config\.feeTreasury/);
assert.match(deployment, /config\.feeTreasury == deployer/);
assert.match(deployment, /_requireRoleOutsideQuorums\(config\.monitor/);
assert.match(deployment, /_requireRoleOutsideQuorums\(config\.feeTreasury/);
assert.match(deployment, /config\.evidenceSigners\.length != V04_EVIDENCE_SIGNER_COUNT/);
assert.match(deployment, /config\.evidenceThreshold != V04_EVIDENCE_THRESHOLD/);
assert.match(deployment, /config\.owner == deployer/);
assert.match(deployment, /_validateEvidenceQuorum/);
assert.match(wiring, /address\(deployed\.vault\.asset\(\)\) != XLAYER_USDT0/);
assert.match(wiring, /address\(deployed\.registry\.identityRegistry\(\)\) != OKX_AGENT_IDENTITY_REGISTRY/);
assert.match(wiring, /address\(deployed\.a2a\.taskEscrow\(\)\) != OKX_TASK_ESCROW/);
assert.match(wiring, /address\(deployed\.feeEscrow\.coverageManager\(\)\) != address\(deployed\.manager\)/);
assert.match(wiring, /deployed\.feeEscrow\.feeAmountAtomic\(\) != V04_DIRECT_FEE_ATOMIC/);
assert.match(wiring, /_requireRoleSeparation/);
assert.match(wiring, /monitor == address\(0\)/);
assert.match(wiring, /feeTreasury == address\(0\)/);
assert.match(wiring, /coldOwner == feeTreasury/);
assert.match(wiring, /primary\[index\] == feeTreasury/);
assert.match(wiring, /recovery\[index\] == feeTreasury/);
assert.match(wiring, /roles\.evidenceSigners\.length != V04_EVIDENCE_SIGNER_COUNT/);
assert.match(wiring, /roles\.evidenceThreshold != V04_EVIDENCE_THRESHOLD/);
for (const line of [
  "POLICYPOOL_UNIVERSAL_ENABLED=false",
  "POLICYPOOL_SHARED_COVERAGE_ENABLED=false",
  "POLICYPOOL_DIRECT_A2MCP_ENABLED=false",
  "POLICYPOOL_RELAY_GRANT_SECRET=",
  "POLICYPOOL_EVIDENCE_SIGNERS=",
  "POLICYPOOL_EVIDENCE_THRESHOLD=3",
  "POLICYPOOL_EVIDENCE_ATTESTATION_URL=",
  "POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN=",
  "POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS=",
  "POLICYPOOL_RECOVERY_EVIDENCE_SIGNERS=",
  "POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD=3",
  "POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL=",
  "POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN=",
  "POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS=",
  "POLICYPOOL_FEE_ESCROW_ADDRESS=",
  "POLICYPOOL_FEE_TREASURY=",
  "POLICYPOOL_DIRECT_QUOTE_SECRET=",
  "POLICYPOOL_RELAYER_PRIVATE_KEY=",
]) {
  assert.ok(environment.includes(line), `.env.example missing ${line}`);
}
assert.match(documentation, /REMEDIATED IN SOURCE: independent review and redeployment required/);
assert.match(documentation, /hardened source now differs from that bytecode and is not deployed/i);
assert.match(documentation, /Production remains v0\.3/);
assert.match(documentation, /threshold evidence quorum/);
assert.match(documentation, /eight-contract stack/);
assert.match(documentation, /3-of-5/);
assert.match(documentation, /10-minute settlement-evidence freshness/);
assert.match(documentation, /24-hour challenge period/);
assert.match(documentation, /30-day delayed recovery quorum/);
assert.match(securityNotes, /stale recovery observation/i);
assert.match(securityNotes, /on-time completion/i);
assert.match(securityNotes, /both evidence quorums/i);
assert.match(securityNotes, /header presence could start an unpaid relay clock/i);
assert.match(securityNotes, /DNS rebinding could bypass the provider relay SSRF check/i);
assert.match(securityNotes, /payout-due covenants had no operational settlement path/i);
assert.match(securityNotes, /failed coverage-fee settlement could strand provider bond/i);
assert.match(auditReport, /H-03: Stale settlement evidence could overpay after a later escrow refund/);
assert.match(auditReport, /M-04: Release and breach ordering lacked an on-chain completion-time tiebreak/);
assert.match(auditReport, /H-04: Primary quorum loss could strand provider bond/);
assert.match(auditReport, /H-05: Header presence could start an unpaid relay clock/);
assert.match(auditReport, /H-06: DNS rebinding could bypass the provider relay SSRF check/);
assert.match(auditReport, /H-07: Payout-due covenants lacked an operational settlement path/);
assert.match(auditReport, /H-08: Failed coverage-fee settlement could strand provider bond/);
assert.match(auditReport, /H-09: Provider payment payer was not bound to the relay-grant buyer/);
assert.match(auditReport, /H-10: Enrollment confirmation did not bind the complete on-chain policy terms/);
assert.match(auditReport, /H-11: Unpaid relay receipts could replace the verified per-job receipt/);
assert.match(auditReport, /H-12: Relay claims were consumed before the paid receipt was durable/);
assert.match(auditReport, /H-13: Consumed relay-grant claims expired before the longest grant window/);
assert.match(auditReport, /H-14: A2A SLA-credit covenants could remain locked after verified late delivery/);
assert.match(auditReport, /H-15: Relay receipts were not bound to the current covenant/);
assert.match(auditReport, /H-17: Newer quote traffic could starve older direct executions/);
assert.match(auditReport, /H-18: Settled direct executions could not recover without the buyer replaying/);
assert.match(auditReport, /H-19: Uncertain forwarded provider calls could lose their one-shot reservation/);
assert.match(auditReport, /H-20: Completed direct results became inaccessible after authorization expiry/);
assert.match(auditReport, /M-08: Direct checkout advertised partial caps that its fixed fee could not honor/);
assert.match(auditReport, /M-07: Direct reconciliation depended on manual scheduler setup/);
assert.ok(
  vercel.builds.some((build) => build.src === "api/direct-a2mcp.js" && build.use === "@vercel/node"),
  "direct A2MCP checkout must be included in the Vercel build",
);
assert.ok(
  vercel.builds.some((build) => build.src === "api/reconcile-direct-a2mcp.js" && build.use === "@vercel/node"),
  "direct A2MCP reconciliation must be included in the Vercel build",
);
assert.ok(
  vercel.routes.some((route) => route.src === "/providers/enroll" && route.dest === "/web/enroll.html"),
  "provider enrollment route must stay explicit",
);

console.log("PolicyPool v0.4 release contract passed: feature gate, provider-first loss, signed limits, rollout, and fallback are explicit.");
