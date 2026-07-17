# PolicyPool v0.4 Internal Solidity Audit

Date: 2026-07-16

## Classification

This is an internal adversarial review and remediation performed with automated tooling and manual source analysis. It is not an independent third-party audit and must not be represented as one.

## Verdict

**SOURCE REMEDIATION PASS: independent review and redeployment required.**

The confirmed High single-operator evidence issue is remediated in source with an immutable threshold evidence quorum and permissionless execution. Production remains v0.3. The historical flag-off v0.4 deployment is superseded and must not accept third-party provider bonds.

Public enrollment remains blocked until:

- Claude completes an independent second review of the remediated commit;
- no unresolved Critical or High source finding remains;
- evidence signers are operated across genuinely independent failure domains;
- a qualified independent human Solidity audit is complete;
- a new eight-contract stack is deployed flag-off and bytecode-verified;
- fresh house pilots prove release, full payout, and recovery-reduced payout.

## Scope

Original review baseline: `v0.4-universal-coverage` at `28c8d0e6832056b72e8d0021383b7d7a43a88448`.

Threshold-evidence remediation began from the already-hardened branch head `33d0037a3132a6562f1565c2509fc54cf2b44af8`.

Remediation scope:

- `src/ProviderBondVault.sol`
- `src/AgentPolicyRegistry.sol`
- `src/CoverageEvidenceVerifier.sol`
- `src/CoverageManager.sol`
- `src/PolicyFeeEscrow.sol`
- `src/adapters/OkxA2AClockAdapter.sol`
- `src/adapters/RelayReceiptVerifier.sol`
- `script/DeployAgentCoverageV04.s.sol`
- `script/WireAgentCoverageV04Roles.s.sol`
- v0.4 runtime issuance, evidence, relay, reconciliation, manifest, and release-gate paths
- Foundry adversarial and regression tests

The dirty `lib/v4-core` submodule was preserved and excluded from all edits.

## Historical Deployment

Read-only verification established that the old creation bytecode and role wiring matched the pre-audit source. Those instances are historical only:

- bond vault: `0x23BE9FD569cB93db0324cC42BB4Bb439449cFd3a`
- policy registry: `0x57d1ee49c3df6f5Ea3000930068BF6059D2cA17B`
- coverage manager: `0x112e45DC9C29ff2FFd1b60fe3B4E408266E5E855`
- A2A clock adapter: `0x37ff4e43cAdA62871E927C5C64B2b9876d21cc62`
- relay verifier: `0x84CA17c573F90181ABFdf9Baca066F7A592e3525`

That stack has no `CoverageEvidenceVerifier`. Its controlled house pilot proved only that the old wiring could release and settle house funds. It does not validate the remediated source and must not be enabled.

## Findings

### H-01: Single operator could create and settle unverified claims

Severity: High

Status: Remediated in source, not deployed

Original impact: blocks third-party bonds and public enrollment

The original `CoverageManager` trusted one operator to supply every fact that determined custody. A compromised operator could select a provider policy, invent a job, choose an attacker-controlled buyer, wait for the deadline, and slash the provider bond. The cold owner could reach the same authority by replacing the operator.

Source remediation:

- removed manager ownership, operator storage, role updates, and `onlyOperator` execution;
- added immutable primary and recovery `CoverageEvidenceVerifier` instances, each enforcing at least five signers and a threshold of three;
- bound EIP-712 attestations to chain ID, verifier, destination manager, action, and exact payload;
- required ordered, unique, authorized, low-`s` signatures and rejected malformed domains;
- consumed each evidence digest once in the manager;
- required quorum evidence for issue, relay-clock start, release, breach, and settlement;
- signed the exact buyer, provider, job, cap, job value, acceptance, recovery amounts, observation times, and evidence hashes;
- made execution permissionless after quorum authorization, leaving the runtime relayer with gas-only authority;
- gave neither the cold owner nor relayer an evidence bypass;
- passed the exact underlying task, transaction, relay, and recovery context to the attestation service for independent recomputation.

Regression proofs include:

- one signer cannot issue;
- a relayer cannot substitute buyer or job;
- changing signed recovery values invalidates settlement;
- wrong verifier, chain, manager, action, or payload fails;
- duplicate, unordered, unauthorized, malformed, high-`s`, and replayed signatures fail;
- a valid quorum can be submitted by an unrelated account.

Residual: a colluding signer threshold can still authorize false evidence. That is the explicit oracle trust model described in O-01, not a hidden operator privilege.

### H-02: One job could receive multiple covenants

Severity: High

Status: Fixed in source, not deployed

The original covenant ID included policy, job, and buyer but lacked permanent job-level uniqueness. The source now stores `coveredJobCovenant[jobId]` and rejects later issuance across policy versions or buyers.

Regression: `testCannotCoverSameJobAcrossPolicyVersions`.

### H-03: Stale settlement evidence could overpay after a later escrow refund

Severity: High

Status: Remediated in source, not deployed

The first quorum design accepted any recovery observation at or after `payoutDueAt`, even if it was broadcast much later. A recovery snapshot truthfully showing zero refund could therefore be signed, followed by an out-of-band marketplace refund, followed by a stale full coverage payout.

Source remediation:

- `SettlementEvidence` signs an explicit `recoveryFinalized` flag and nonzero recovery-evidence hash;
- settlement rejects nonterminal recovery and evidence observed more than ten minutes before execution;
- the runtime refuses to request settlement signatures unless recovery is explicitly final;
- settlement stores and emits the terminal recovery observation time and finality;
- neither primary nor emergency settlement can execute during the 24-hour provisional-breach challenge period.

Residual: terminal marketplace recovery is verified by the evidence quorum rather than derived directly from an OKX settlement contract. Attesters must independently prove that no later escrow refund can occur.

Regression proofs: `testStaleZeroRecoverySettlementCannotDoublePayAfterRefundWindow`, `testSettlementRequiresExplicitTerminalRecoveryAttestation`, and the full/partial recovery tests.

### H-04: Primary quorum loss could strand provider bond

Severity: High

Status: Remediated for primary-quorum failure in source, not deployed

The first quorum was immutable and every subjective terminal path depended on it. Loss of threshold availability could therefore leave an Active or PayoutDue covenant permanently locked.

Source remediation:

- a second immutable recovery verifier is wired into the manager;
- each verifier enforces at least five signers and a threshold of three;
- the manager constructor rejects every signer overlap between the primary and recovery sets;
- the recovery quorum cannot release, mark breach, or settle until 30 days after the original covenant deadline;
- primary signatures cannot authorize recovery actions because verifier address is part of the EIP-712 domain;
- deployment and wiring scripts independently enforce and verify the disjoint topology.

Residual: if both disjoint quorums lose threshold availability, a bond can still remain locked. There is intentionally no owner or provider-only reclaim because a deterministic unilateral recipient could defeat a valid unresolved buyer claim. External providers must receive this disclosure, and the qualified auditor must review the actual failure-domain topology.

Regression proofs: `testRecoveryQuorumCannotActEarlyOrReusePrimarySignatures`, `testRecoveryQuorumCanFinishBreachAndTerminalSettlementAfterDelay`, and manager-construction overlap rejection.

### H-05: Header presence could start an unpaid relay clock

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The provider relay previously treated any nonempty `payment-signature` or `x-payment` header followed by a non-402 upstream response as proof that the provider was funded. A fabricated header could therefore create a signed relay clock and feed later breach evidence without any provider payment.

Source remediation:

- exact x402 v2 requirements must match the live listed price, enrolled provider wallet, X Layer USD₮0 asset, and token EIP-712 domain;
- the relay verifies the buyer's EIP-3009 authorization signature and its payee, value, validity window, and nonce before forwarding;
- the provider's settlement response must identify a confirmed transaction containing the exact `Transfer` and matching `AuthorizationUsed` nonce;
- the authorization ID and relay grant are independently reserved and consumed, preventing reuse under another grant;
- a missing or invalid proof creates no clock and releases pending reservations for a safe retry.

Regression: `npm run agent:verify-relay` rejects malformed headers, wrong requirements, wrong signers, missing settlement proof, and a settled authorization replayed with a fresh grant. It accepts only a signature-valid authorization bound to its on-chain settlement nonce.

### H-06: DNS rebinding could bypass the provider relay SSRF check

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The relay resolved and screened an enrolled provider hostname, then passed the hostname to `fetch`, which could perform a second DNS lookup. A rebinding hostname could return a public address during validation and a private address during connection.

Source remediation:

- every DNS answer is screened and any private or special-use result fails the request;
- the outbound HTTPS request uses a custom lookup pinned to one of the screened addresses;
- the original hostname remains the TLS SNI, certificate-verification, and HTTP host identity;
- redirects are rejected, so a provider cannot redirect the relay to an unvalidated destination;
- response-size and timeout bounds still apply to the pinned request.

Regression: the relay gate verifies the exact screened address set passed to transport, exercises the pinned lookup, and rejects private IPv4, IPv4-mapped IPv6, and multicast IPv6 destinations. The v0.4 release gate statically requires pinned lookup plus TLS hostname verification.

### H-07: Payout-due covenants lacked an operational settlement path

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The contract exposed `settleNetLoss`, but the scheduled reconciler never called it. A genuine breach could move to `PayoutDue` and remain there indefinitely, leaving the buyer unpaid and the provider bond locked even after the challenge period and marketplace recovery became terminal.

Source remediation:

- the reconciler waits for the full on-chain 24-hour challenge period rather than guessing from local time;
- A2A net-loss settlement requires a fresh public task observation proving status `7` (funds returned) or `9` (arbitration refunded buyer), and binds the full-refund amount to the covenant's verified job value;
- relay settlement is permitted only for provider-bonded SLA-credit policies with a signature-valid relay receipt and verified provider-payment transaction;
- nonterminal, stale, unsupported, or ambiguous recovery remains on hold without a transaction;
- after settlement, the reconciler reads the covenant back from chain and accepts only `Paid` or `RecoveredWithoutPayout` before updating the ledger.

Residual: OKX terminal status semantics and relay-payment finality remain facts independently checked by the evidence quorum. A2A v0.4 issuance therefore requires a public task reference; current status without historical timing cannot settle custody.

Regression: `scripts/verify-universal-reconciler.mjs` proves terminal full-refund settlement, challenge-period hold, final-state readback, and replay idempotency.

### H-08: Failed coverage-fee settlement could strand provider bond

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The endpoint locked provider bond before settling PolicyPool's x402 fee, which is the correct buyer-protection order. If fee settlement then failed after the covenant deadline, compensation incorrectly called the delivery-release path with a post-deadline timestamp. The contract rejected it, and no cancellation transition existed.

Source remediation:

- issue evidence binds the exact x402 fee-authorization hash and expiry, and the covenant ID includes that authorization hash;
- fee authorizations more than 15 minutes ahead are rejected before issuance, bounding temporary bond exposure;
- failed settlement enters a durable compensation state and never invents provider completion evidence;
- an uncertain issuance result retains the planned covenant ID until authorization expiry, then re-reads chain state before releasing any local reservation;
- only after the exact authorization expires may a quorum attest that no `AuthorizationUsed` event and no PolicyPool fee transfer exist;
- `cancelUnpaid` releases the bond, records a distinct `CancelledUnpaid` terminal state, and clears the job lock only for that unpaid attempt so a fresh authorization may retry;
- stale, mismatched, still-active, replayed, and terminal-covenant cancellations fail closed;
- a disjoint recovery quorum can perform the same cancellation only after the 30-day emergency delay.

Residual: the attesters must independently check the fee token and exact authorization on chain. If settlement is uncertain rather than absent, they must reject cancellation and alert; they must never trust the relayer's failure string alone.

Regression proofs: `testExpiredUnusedFeeAuthorizationCancelsAndAllowsCleanRetry`, `testUnpaidCancellationRejectsStaleEvidenceAndTerminalCovenants`, `testRecoveryQuorumCancelsExpiredUnusedAuthorizationOnlyAfterEmergencyDelay`, `scripts/verify-universal-flow.mjs`, and `scripts/verify-universal-reconciler.mjs`.

### H-09: Provider payment payer was not bound to the relay-grant buyer

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The relay verified that a provider payment was valid and settled, but did not compare its EIP-3009 authorizer with the buyer bound into the signed relay grant. A different wallet holding a valid grant could therefore fund the provider request, start the covenant clock, and leave any later bond payout addressed to the original grant buyer.

Source remediation:

- the relay compares the verified authorization `from` address with `grant.buyer` before reserving the grant or forwarding the provider request;
- a mismatch returns `provider_payment_payer_mismatch` and creates no clock, provider request, or grant/payment reservation;
- the existing settlement proof remains bound to that same authorizer and authorization nonce.

Regression: `scripts/verify-provider-relay.mjs` signs a structurally and cryptographically valid payment from a second wallet and proves it is rejected specifically for buyer mismatch before provider forwarding.

### H-10: Enrollment confirmation did not bind the complete on-chain policy terms

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The `PolicyRegistered` event does not emit the scope hash, cap, SLA, enrollment window, payout basis, clock mode, expiry, or adapter. Confirmation previously matched only the event's provider, agent, service, and fingerprint before activating the stored signed enrollment. A different latest on-chain registration for the same service and fingerprint could therefore activate while the resolver exposed the stored terms and `CoverageManager` enforced different terms.

Source remediation:

- confirmation reads `getPolicy(policyId)` from the registry identified by the verified event;
- policy ID, service key, provider, version, and active state must match the event and enrollment;
- PolicyPool recomputes the complete registered policy-terms hash and requires exact equality with the provider-signed `enrollment.policyTermsHash` before activation.

Regression: `scripts/verify-provider-enrollment.mjs` supplies an otherwise matching event and coverable latest policy with a changed payout basis, proves activation fails with `policy_registered_terms_mismatch`, and then activates only after the full registered terms match.

### H-11: Unpaid relay receipts could replace the verified per-job receipt

Severity: High / P1 runtime

Status: Fixed in source, not deployed

Every signed relay receipt was stored and also written to the per-job latest-receipt pointer. Because no-payment relay challenges do not consume the one-use paid grant, a later unpaid 402 call could replace the pointer to a valid paid receipt with a receipt whose clock was null. Reconciliation reads that pointer and could then miss a valid start or delivery result.

Source remediation:

- all receipts remain retrievable by receipt ID for auditability;
- the memory and Redis per-job pointers advance only when `request.paymentVerified` is true, the verified-settlement clock source is present, and a settlement transaction is bound;
- unpaid, malformed, or challenge-only receipts can no longer replace a payment-verified clock receipt.

Regression: `scripts/verify-provider-relay.mjs` creates a paid receipt, follows it with a valid unpaid 402 receipt under the same grant, and proves the unpaid receipt is stored while the per-job pointer remains on the paid receipt.

### H-12: Relay claims were consumed before the paid receipt was durable

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The relay committed the grant and payment authorization claims immediately after verifying provider settlement, then signed and saved the receipt in later operations. A signing failure, Redis outage, or process loss in that gap could leave both claims consumed while no receipt or per-job pointer existed. Reconciliation would never start the paid covenant clock.

Source remediation:

- the receipt is fully constructed and signed before any consumed state is written;
- the verified receipt, per-job pointer, grant claim, and payment claim commit in one Redis Lua transaction;
- a failure before the atomic transaction leaves only pending reservations that are released or expire;
- an uncertain client response after Redis commits cannot erase the receipt or reopen either claim.

Regression: `scripts/verify-provider-relay.mjs` injects a failure before atomic commit and proves the same payment can recover, then injects a response loss after atomic commit and proves the receipt remains indexed while a retry cannot call the provider twice.

### H-13: Consumed relay-grant claims expired before the longest grant window

Severity: High / P1 runtime

Status: Fixed in source, not deployed

Successful grant claims had a fixed 24-hour Redis TTL, while a provider enrollment and its relay grant can remain valid for longer. Once the claim expired, the same still-valid grant could authorize a fresh provider payment and replace the job's clock or delivery receipt after the original SLA.

Source remediation:

- pending grant and payment reservations still expire after 15 minutes so an interrupted pre-commit call can recover;
- grant issuance rejects an expiry beyond the seven-day maximum SLA;
- successful grant claims use an expiry-derived Redis TTL that lasts through the signed grant expiry plus a one-hour margin, capped at eight days because v0.4 grants cannot exceed the seven-day SLA limit;
- payment claims remain durable, and the signed grant's own expiry prevents first use after the enrollment window, so neither authorization can become reusable during its valid window.

Regression: `scripts/verify-provider-relay.mjs` advances the relay clock 48 hours beyond a successful call, supplies a fresh valid payment authorization, and proves the original grant still fails with `relay_grant_already_used`.

### H-14: A2A SLA-credit covenants could remain locked after verified late delivery

Severity: High / P1 runtime

Status: Fixed in source, not deployed

The reconciler previously required marketplace status `7` or `9` before settling every A2A payout-due covenant. A provider-bonded SLA credit does not depend on marketplace recovery, so an ordinary late-but-delivered job could remain in `PayoutDue` indefinitely with the provider bond locked.

Source remediation:

- after the on-chain 24-hour challenge, an A2A SLA-credit covenant may settle from a fresh, non-stale public task observation that still proves the objective deadline breach;
- the exact public task, delivery or resolution timing, fetch time, and breach reason are supplied to the evidence quorum;
- settlement uses zero recovery inputs because payout basis `1` is the provider-funded credit, not reimbursement of net loss;
- net-loss policies still require terminal marketplace recovery and cannot use this path.

Regression: `scripts/verify-universal-reconciler.mjs` proves that the same late-delivery task pays a provider-bonded SLA credit after the challenge while a net-loss covenant remains in `PayoutDue` with `marketplace_recovery_not_terminal`.

### H-15: Relay receipts were not bound to the current covenant

Severity: High / P1 runtime

Status: Fixed in source, not deployed

Reconciliation previously selected the latest verified relay receipt by target job. If an unpaid covenant was cancelled and the same accepted job received a replacement covenant, the prior grant's receipt could be selected to start or resolve the new bond even though the provider request predated that coverage.

Source remediation:

- the signed relay receipt now includes the grant-bound covenant ID;
- the receipt, covenant index, diagnostic job index, and replay claims become durable in the same Redis transaction;
- reconciliation reads only the exact covenant index and validates receipt signature plus grant, covenant, job, agent, service, and payer bindings;
- an old receipt remains auditable by receipt ID and job index but cannot start, release, breach, or settle a replacement covenant.

Regression: `scripts/verify-universal-reconciler.mjs` creates a replacement pending covenant for the same job while only the old covenant receipt exists and proves the replacement remains `pending_start` with `relay_clock_not_started`.

### H-16: Held breach evidence could consume the correction window

Severity: High

Status: Fixed in source, not deployed

The first challenge implementation stored the signed breach observation time as `payoutDueAt`. A relayer could hold a valid breach quorum for 24 hours, submit it later, and immediately settle with fresh recovery evidence. That defeated the promised period in which an on-time completion can correct a provisional breach.

Source remediation:

- `payoutDueAt` is now the timestamp at which the breach transition is mined;
- the signed observation time remains evidence of when the breach was observed but cannot age the on-chain challenge;
- reconciliation reads the authoritative on-chain `payoutDueAt` before requesting settlement;
- primary and recovery settlement both enforce the full 24 hours from that committed transition.

Regression: `testHeldBreachEvidenceCannotConsumeChallengeWindow` holds otherwise-valid breach signatures beyond 24 hours, submits them, and proves immediate settlement still reverts until the newly committed challenge closes.

### M-01: Vault owner could replace the manager

Severity: Medium

Status: Fixed in source, not deployed

Mutable `setManager` was replaced with one-time `initializeManager`. Deposits cannot begin before initialization, and the manager cannot be replaced afterward.

### M-02: Current A2A status could release late delivery

Severity: Medium

Status: Fixed in source, not deployed

Timing-ambiguous delivery statuses now hold until historical delivery timing is available. Only documented recovery/terminal states release from current status alone.

Regression: `testA2AClockHoldsDeliveryWithoutHistoricalTimingAndReleasesRecovery`.

### M-03: Manager lacked explicit reentrancy protection

Severity: Medium as defense in depth

Status: Fixed in source, not deployed

The original manager relied on checks-effects-interactions, an immutable vault, the vault's guard, and USD₮0 behavior. The remediated manager explicitly guards every state-changing entry point. A malicious immutable dependency test proves re-entry fails.

Regression: `testManagerRejectsReentryFromImmutableBondDependency`.

### M-04: Release and breach ordering lacked an on-chain completion-time tiebreak

Severity: Medium

Status: Remediated in source, not deployed

The first release evidence carried only an observation time. A post-deadline delivery could be released, and once breach evidence also existed the first transaction mined decided whether the provider bond returned or paid.

Source remediation:

- release evidence signs the authoritative completion time separately from observation time;
- Active release requires `issuedAt <= completedAt <= deadline`;
- the manager stores and emits `completedAt`;
- breach is provisional for 24 hours, and a signed on-time completion can correct `PayoutDue` to `Released` during that period;
- both primary and emergency settlement are blocked until the challenge period closes.

Residual: the quorum still determines whether the supplied completion timestamp is authoritative. A colluding threshold remains the oracle trust boundary.

Regression proofs: `testLateCompletionCannotRaceAndBeatBreach`, `testOnTimeCompletionCanStillBeRelayedAfterDeadline`, `testOnTimeCompletionCanCorrectProvisionalBreachDuringChallenge`, and `testSettlementCannotBeatReleaseDuringChallengePeriod`.

### M-05: Outbound short-transfer tokens could underpay withdrawals or slashes

Severity: Medium

Status: Fixed in source, not deployed

Deposits already required the vault to receive the exact amount, but outbound withdrawal and slash calls trusted a successful ERC-20 return value. A taxed or otherwise short-transfer token could debit the provider's full internal balance while the provider or buyer received less.

Every outbound transfer now verifies both exact vault debit and exact recipient credit. Any mismatch reverts the token transfer and all preceding vault accounting atomically.

Regression: `testVaultRejectsTaxedOutboundWithdrawalAndSlash` proves both withdrawal and buyer slash roll back balances, queued withdrawal, and covenant lock when the token withholds one atomic unit.

### M-06: Deployment checks allowed configuration drift and partial wiring

Severity: Medium / operational deployment blocker

Status: Fixed in source, not deployed

The initial scripts verified core contract links but did not reject the wrong chain, canonical token, identity registry, task escrow, bond/SLA constants, role reuse, or a signer topology that differed from the documented exact 3-of-5 model. Constructor reverts could also occur after earlier deployment transactions had already landed.

Source remediation:

- the deployment script validates X Layer chain `196`, USD₮0, the canonical ERC-8004 registry, OKX task escrow, bond floor, SLA ceiling, exact disjoint 3-of-5 quorums, nonzero unique signers, and role separation before the first broadcast;
- the cold owner is mandatory and cannot silently default to the deployer;
- deployer, cold owner, relay signer, monitor, primary signers, and recovery signers cannot occupy conflicting ongoing roles;
- the wire script independently reads every immutable link and parameter from chain before accepting ownership or setting the monitor;
- both scripts compile under the normal and coverage compiler profiles.

Residual: byte-level source verification and a read-only post-deployment state audit remain mandatory. Script success alone is not proof that an explorer or RPC endpoint serves the reviewed bytecode.

### L-01: Relay signatures lacked deployment domain separation

Severity: Low

Status: Fixed in source, not deployed

Relay receipts now use EIP-712 and bind chain ID plus verifier address. Reusing a receipt on another chain or verifier fails. Relay receipts still cannot move bonds without separate threshold evidence.

### L-02: Emergency settlement could skip part of a late breach challenge

Severity: Low

Status: Fixed in source, not deployed

The first recovery-quorum implementation opened emergency settlement 30 days after the covenant deadline, while the normal challenge period ran for 24 hours after `payoutDueAt`. If breach was first reported near day 30, emergency settlement could execute before that later challenge deadline. Settlement now enforces `payoutDueAt + SETTLEMENT_CHALLENGE_PERIOD` unconditionally for both verifiers.

Regression: `testEmergencySettlementCannotSkipLateBreachChallenge` marks breach near day 30, proves recovery settlement still reverts during the remaining challenge window, and settles only after it closes.

### O-01: Threshold oracle integrity and liveness

Severity: Operational deployment blocker; High if misconfigured

Status: Reduced by disjoint recovery quorum; oracle integrity remains open by design

The source cryptographically requires a 3-of-5 primary quorum plus a signer-disjoint 3-of-5 recovery quorum. Security still depends on placing every key in an independent failure domain and requiring each signer to verify raw evidence. If one operator controls a threshold, the original H-01 risk reappears operationally. If the primary threshold is unavailable, recovery may act after 30 days; if both thresholds are unavailable, subjective transitions halt.

Required before external bonds:

- no person, process, host, cloud account, or organization can satisfy the threshold alone;
- signers independently fetch and validate authoritative evidence rather than signing a relayer assertion;
- signer runbooks cover outage, compromise, and migration;
- replacement requires a new verifier/manager stack after old obligations are closed;
- the independent auditor reviews the concrete signer topology, not only the Solidity.

### I-01: Policy expiry is an issuance cutoff

Severity: Informational

Status: Documented

Policy expiry is the last time new coverage may be issued. An already-issued covenant may finish after policy expiry while its bond remains locked.

### I-02: External dependencies remain

Severity: Informational

Status: Documented

- X Layer timestamps affect SLA and withdrawal boundaries.
- The canonical ERC-8004 identity registry is an externally controlled EIP-1967 proxy.
- OKX task semantics, public pages, and historical evidence are external dependencies.
- The configured USD₮0 asset is trusted; fee-on-transfer behavior is rejected.
- Immutable signers and one-time manager initialization require planned migration rather than in-place recovery.

## Direct A2MCP Refundable-Fee Extension

The post-review direct A2MCP extension is source-only and has not been deployed. It adds `PolicyFeeEscrow` as the eighth contract and a direct HTTP+x402 checkout that is deliberately separate from OKX Task Marketplace A2A tasks.

The escrow has no owner, upgrade, sweep, or treasury-change path. It accepts one fixed buyer-signed EIP-3009 fee authorization bound to the policy, synthetic direct job, provider authorization hash, and authorization windows. It captures only after the manager reports a started covenant and the primary evidence quorum signs the exact provider relay receipt and settlement transaction. After the provider authorization plus safety delay expires, only the fixed buyer can reclaim an uncaptured fee. Exact inbound and outbound balance deltas reject taxed or short-transfer behavior.

Runtime ordering is covenant issue and provider-bond lock, refundable fee funding, one-time provider settlement, provider clock start, then fee capture. Provider challenge, request, authorization, payer, endpoint, service price, and policy fingerprint remain immutable across the three-step checkout. Provider response bytes and the signed receipt commit atomically. A lost HTTP reply recovers from durable state; a proven on-chain settlement without durable response never retries the paid provider and never automatically treats the provider as breached.

The direct state store retains executing records for ten days, indexes them for authenticated minute reconciliation, and permits only the same quote and two original signatures to resume. Non-settlement after authorization expiry follows quorum-attested `cancelUnpaid` plus buyer fee refund. Settlement recovery scans only the bounded signed authorization window and requires the indexed `AuthorizationUsed` nonce and exact USD₮0 transfer in one transaction.

The extension raises the Foundry suite from 103 to 116 passing tests through thirteen `PolicyFeeEscrow` tests. The escrow reaches `98.21%` line and `91.30%` branch coverage; its remaining branches are defensive terminal-state or timestamp-overflow paths. JavaScript gates additionally exercise request and challenge drift, wrong payer, authorization replay, crash recovery, no duplicate provider call, fee capture, fee refund, settled-response safety hold, and challenged breach settlement. These are internal source checks and do not authorize a deployment or third-party-funded bond.

## Automated Analysis

Tooling:

- Foundry `1.7.1`, Solidity `0.8.26`
- Slither `0.11.5`
- npm production dependency audit
- repository secret and diff gates

Relevant static-analysis dispositions:

- Slither analyzed 47 contracts with 101 detectors and returned 44 raw results. No manager, verifier, vault, or fee-escrow custody bypass remained after classification.
- `ProviderBondVault.depositFor` is `nonReentrant`, verifies exact balance delta, and rejects false-return and fee-on-transfer assets. A malicious callback test confirms rollback.
- Vault withdrawal and slash also verify the exact vault debit and recipient credit. Slither's balance-read/reentrancy warning is covered by the vault guard, exact post-call deltas, and rollback regressions.
- `PolicyFeeEscrow.fund` and `_safeTransfer` use low-level optional-return token calls. Every state-changing entry point is `nonReentrant`, a malicious authorization-token callback is rejected, terminal state is written before outbound transfer, exact inbound/outbound balance deltas are required, and callback or token failure rolls the entire transaction back.
- Manager calls cross immutable verifier/vault dependencies. Every state-changing manager entry point is `nonReentrant`, manager state is written before the vault call, and dependency failure reverts the complete transaction.
- Signature loops are bounded by `MAX_SIGNERS = 16`; ordering also prevents duplicate signer credit.
- The manager's constructor-time signer-topology loop makes bounded calls to the two immutable verifiers. The manager requires exactly five signers and threshold three for each verifier and fails deployment closed on a dependency revert, topology drift, or signer overlap.
- Timestamp checks are intentional protocol inputs.
- Low-level token calls support optional-return tokens and reject false returns, transfer failure, and balance-delta mismatch.
- ECDSA recovery validates length, low `s`, recovery ID, nonzero signer, authorization, ordering, domain, and replay.
- `arbitrary-send-erc20` and `unused-return` findings belong to the historical Uniswap v4 `CurrencySettlement` library, outside the provider-bond path. Missing-inheritance findings describe local view interfaces.

No production credential is intentionally tracked. The local dirty `lib/v4-core` submodule is outside the remediation.

## Verification Results

- clean `forge test --summary`: 116 tests passed
- `PolicyFeeEscrow` branch coverage: 91.30% (`21/23`)
- `AgentPolicyRegistry` branch coverage: 100% (`23/23`)
- `ProviderBondVault` branch coverage: 100% (`30/30`)
- `CoverageEvidenceVerifier` branch coverage: 100% (`13/13`)
- `CoverageManager` branch coverage: 93.33% (`42/45`)
- `OkxA2AClockAdapter` branch coverage: 100% (`6/6`)
- `RelayReceiptVerifier` branch coverage: 100% (`8/8`)
- `npm run agent:gate-v04`: pass
- npm production vulnerabilities: 0
- no-broadcast X Layer deployment simulation with canonical parameters and exact disjoint 3-of-5 quorums: pass
- negative deployment simulation with a 4-of-5 primary threshold: rejected before broadcast with `InvalidDeploymentConfiguration`

The three reported uncovered manager branches are defensive paths: Foundry does not attribute the explicit reentrancy regression to the guard branch, an acceptance-clock deadline cannot already be elapsed while its shorter enrollment window remains open under `enrollmentWindowSeconds <= slaSeconds`, and an `Active` or `PayoutDue` covenant cannot enter emergency resolution with an unset deadline.

The complete JavaScript/runtime/release gate passed and the final Slither findings were classified on the candidate worktree. They must be rerun after any reviewer-requested source change. These results do not turn this document into an independent audit.

## Deployment Impact

Redeployment is required. The remediated manager constructor adds the evidence verifier, removes the operator model, changes every lifecycle ABI, and hardens relay domains. The old vault is permanently bound to its old manager, so the stack cannot be partially upgraded.

The next deployment must create an eight-contract stack flag-off: vault, registry, primary evidence verifier, disjoint recovery evidence verifier, manager, PolicyFeeEscrow, A2A adapter, and relay verifier. It must then verify bytecode, both 3-of-5 signer sets, zero signer overlap, fee treasury and amount, and immutable wiring before any pilot.

No production endpoint, OKX listing, feature flag, scheduler, existing contract, or fund balance is changed by this source remediation.

## Next Review Questions

Claude and the qualified independent auditor should attempt to disprove:

1. that no single key, cold owner, relay signer, runtime relayer, or manager caller can authorize custody;
2. that signatures cannot replay across chain, verifier, manager, action, payload, or lifecycle call;
3. that underlying evidence is recomputed rather than trusted from the relayer;
4. that settlement recovery values and the fixed buyer cannot be substituted;
5. that reentrancy or malicious immutable dependencies cannot create a partial lifecycle state;
6. that the eight-contract deployment, fee escrow, and disjoint signer topology preserve the reviewed assumptions;
7. that a fresh recovery-reduced pilot pays only net loss on X Layer.
8. that stale or held breach and recovery evidence, late completion, release-versus-breach ordering, and primary-quorum loss cannot recreate the hostile findings above;
9. that outbound token behavior and deployment configuration cannot silently weaken the reviewed custody or signer assumptions.
