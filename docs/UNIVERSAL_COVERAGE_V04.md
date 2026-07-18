# PolicyPool Universal Coverage v0.4

Status: REMEDIATED IN SOURCE: independent review and redeployment required.

The pre-audit v0.4 contracts were deployed flag-off for a controlled house pilot. The hardened source now differs from that bytecode and is not deployed. Production remains v0.3. Public enrollment and third-party bonds remain blocked.

## Product Boundary

v0.4 makes an eligible OKX.AI service coverable only after its provider opts in. The provider must own the listed agent, deposit first-loss USD₮0 into the bond vault, and sign objective versioned terms for one exact service fingerprint. Unknown services create a deduplicated demand signal and an enrollment link; they never receive unbacked coverage.

This is not provider-agnostic insurance. Without provider first loss, a buyer and an unenrolled provider could collude, allow a task to fail, recover marketplace escrow, and also claim coverage. Provider-funded first loss closes that buyer-provider extraction path only when the evidence quorum is honest. It does not protect against a colluding signer threshold.

The listed A2A PolicyPool service continues to charge its fixed `0.1 USD₮0` fee. Direct A2MCP checkout uses a separate immutable `0.1 USD₮0` refundable fee escrow. The enrollment API derives the A2MCP policy rate from that fixed fee and the selected cap; it rejects a cap that cannot represent the fee exactly in basis points. Providers cannot add a discretionary premium.

## Evidence Trust Model

The original manager gave one hot operator authority over the job, buyer, acceptance, release, breach, and recovery facts that moved provider bonds. The remediated source removes that owner/operator path.

Every subjective lifecycle action now requires an immutable threshold evidence quorum:

- The manager accepts exactly five signers and threshold three in each `CoverageEvidenceVerifier`.
- The digest binds the current chain, verifier, destination manager, action, and exact payload.
- The manager consumes each digest once and rejects replay.
- Signatures must be unique and sorted by recovered signer address.
- Any account may relay a valid quorum-attested action; the relayer has no custody authority.
- The primary and recovery verifier signer sets must be completely disjoint; the manager checks this during construction.
- The verifier has no owner, signer rotation, threshold update, or privileged bypass.
- The runtime sends the exact evidence plus its underlying task, transaction, relay, or recovery context to independently operated attesters. Attesters must recompute the payload and manager digest rather than trust the relayer's summary.

This is a permissioned oracle model, not trustless marketplace verification. A colluding threshold can still attest false facts. A separate disjoint 3-of-5 recovery quorum can resolve a covenant only after a 30-day delayed recovery window, so loss of the primary quorum does not immediately strand provider capital. If both evidence quorums lose threshold availability, an unresolved bond can still remain locked. Replacing lost or compromised signer sets requires a new verifier and manager deployment after every old obligation is resolved.

## Invariants

1. No provider bond, no active policy.
2. The provider wallet must own the OKX.AI agent at enrollment and quote time.
3. One policy version binds one agent ID, service ID, live service fingerprint, scope hash, cap, SLA, enrollment window, payout basis, clock mode, expiry, and adapter.
4. A listing or ownership change fails closed for new coverage until the provider signs a new policy version.
5. The manager enforces the provider-signed maximum cap and exact enrollment window; quorum evidence cannot widen either.
6. A covenant cap cannot exceed the target-job value, provider-signed cap, configured global cap, or available provider bond.
7. Shared-reserve exposure is disabled. New v0.4 covenants lock provider first-loss capital only.
8. A paid relay grant is short-lived, bound to one covenant, job, buyer, agent, and service, and permits at most one paid provider execution. The signed receipt carries that covenant ID and is indexed and reconciled by the exact covenant rather than by job alone. A relay clock starts only after the buyer's EIP-3009 authorization is signature-verified, the exact USD₮0 transfer and authorization nonce are proven in the settlement transaction, and that authorization is permanently consumed.
9. Settlement failure cannot erase the on-chain lock. A durable `compensation_required` record remains until reconciliation releases it.
10. Issuance, clock start, subjective release, breach, and settlement require threshold-attested evidence. The runtime relayer cannot perform any of them alone.
11. A full marketplace refund cannot stack with a net-loss payout. Recovery amounts are part of the signed settlement payload.
12. One marketplace job can receive only one covenant, across all policy versions and buyers.
13. Every state-changing manager entry point has an explicit reentrancy guard.
14. Net-loss settlement requires terminal recovery evidence observed within ten minutes of execution.
15. Breach is provisional for a 24-hour challenge period. A quorum-attested completion at or before the original deadline can correct `PayoutDue` to `Released` before settlement.
16. The primary and 30-day delayed recovery quorums each require exactly 3-of-5 signers and share no signer address.
17. A2MCP provider DNS is resolved once, every returned address must be public, and the outbound TLS connection is pinned to one of those checked addresses while preserving hostname and certificate verification.
18. A2MCP uses direct HTTP plus x402. It never routes through the OKX Task Marketplace A2A lifecycle.
19. The provider authorization and refundable PolicyPool-fee authorization are separate, buyer-signed EIP-3009 payloads bound to one quote, job, policy, request, and provider challenge.
20. The covenant locks provider bond and the PolicyPool fee enters refundable escrow before the provider authorization can settle.
21. A provider authorization is executed at most once. Recovery uses its indexed `AuthorizationUsed` nonce and exact USD₮0 transfer; uncertainty never triggers an automatic paid retry.
22. The PolicyPool fee is captured only after verified provider settlement and clock start. If the provider never settles before both authorizations expire, quorum evidence cancels the unpaid covenant and the buyer alone can receive the fee refund.
23. A settled provider response is stored atomically with its signed relay receipt. If settlement is proven but the response is unavailable, coverage remains active in a manual safety hold and the provider is not treated as breached for PolicyPool infrastructure loss.

## Contracts

### `ProviderBondVault`

- Holds provider-owned USD₮0 first-loss deposits.
- Locks a covenant-specific amount before the PolicyPool service fee settles.
- Prevents withdrawal of locked or queued capital and uses an eight-day withdrawal queue.
- Releases a successful covenant or slashes only the manager-authorized payout amount to the covenant's fixed buyer.
- Rejects fee-on-transfer assets and guards token-moving paths against reentrancy.
- Initializes its manager once; the manager cannot be replaced.

### `AgentPolicyRegistry`

- Verifies ERC-8004/OKX agent ownership.
- Supports direct enrollment and relayed EIP-712 enrollment with nonces and expiry.
- Creates immutable policy versions and revalidates ownership, latest version, fingerprint, expiry, and minimum available bond.
- Lets a provider pause its policy and a separate monitor suspend a changed fingerprint.

### `CoverageEvidenceVerifier`

- Stores an immutable signer set and threshold, with a minimum of five signers, a minimum threshold of three, and a hard maximum of 16 signers.
- Rejects weak thresholds, duplicate signers, malformed or high-`s` signatures, unauthorized signers, duplicate signatures, unordered signatures, and cross-domain attestations.
- Binds every attestation to the calling manager and returns the replay-protection digest.
- Has no privileged administration after construction.

### `CoverageManager`

- Locks provider capital before the x402 fee is settled.
- Pins policy, job, buyer, provider, cap, job value, SLA, enrollment window, clock mode, and acceptance evidence.
- Supports A2A acceptance clocks and A2MCP relay clocks.
- Verifies threshold evidence for issue, clock start, release, breach, and settlement.
- Allows permissionless execution only after valid quorum authorization.
- Prevents duplicate job coverage and double recovery.
- Stores the attested completion and terminal-recovery observation timestamps on chain.
- Enforces completion at or before the covenant deadline, 10-minute settlement-evidence freshness, terminal recovery, and a 24-hour challenge period measured from the mined provisional-breach transition before either settlement path.
- Allows a completely disjoint recovery quorum to release or settle after a 30-day delay without giving an owner or relayer a custody bypass.
- Accepts a relay receipt whose signed start is inside the enrollment window during a bounded ten-minute recovery period after fee-authorization expiry, then makes `expireUnstarted` permissionless on the non-overlapping side of that cutoff.

### `PolicyFeeEscrow`

- Holds the direct A2MCP `0.1 USD₮0` PolicyPool fee separately from the provider payment.
- Binds one fee authorization to the buyer, policy, synthetic direct job, provider authorization hash, and both authorization windows.
- Captures to the immutable treasury only after the covenant clock has started and a primary-quorum attestation binds the exact relay receipt and provider settlement transaction.
- Allows only the fixed buyer to reclaim an uncaptured fee after the provider authorization and safety window expire.
- Has no owner, upgrade, sweep, treasury-change, or arbitrary-recipient path and rejects short-transfer tokens in both directions.

### Clock adapters

`OkxA2AClockAdapter` holds timing-ambiguous delivery statuses until historical delivery timing is available. The A2MCP relay rejects redirects and private or special-use destinations, pins the checked IP at connection time, verifies the grant-bound buyer's token-domain EIP-3009 signature, and proves the exact `Transfer` plus `AuthorizationUsed` nonce before creating a clock. The signed paid receipt, reconciliation pointer, and consumed grant/payment claims commit atomically; grant consumption lasts through the signed grant expiry plus a safety margin, and an uncertain commit cannot leave a consumed grant without its receipt. Unpaid receipts remain addressable for diagnostics but cannot replace the payment-verified per-job receipt used by reconciliation. `RelayReceiptVerifier` uses EIP-712 signatures bound to chain ID and verifier address; relay receipts alone cannot move bonds because the manager separately requires quorum evidence.

The contracts are intentionally non-upgradeable. Security changes require a complete redeployment. A qualified independent human audit remains mandatory before third-party-funded provider bonds are accepted.

## Enrollment Flow

1. Open `/providers/enroll` with the wallet that owns the OKX.AI agent.
2. Approve and deposit USD₮0 into the bond vault.
3. Enter one service ID and objective terms.
4. `/api/provider-enrollment` verifies the live owner and service, computes the fingerprint, checks bond capacity, and returns EIP-712 enrollment data.
5. The provider signs and broadcasts `registerPolicyBySig`.
6. PolicyPool verifies the event, reads the exact registered policy, matches its complete terms hash to the provider-signed enrollment, and then checks the fingerprint, latest version, and current coverability before projecting the policy as active.

The manifest is a last-confirmed projection, not a guarantee. Every quote revalidates the live owner, service fingerprint, policy, expiry, and bond.

## A2A Buyer Flow

1. Submit an OKX.AI task URL, target agent, service, and requested cap to `/api/coverage-preflight`.
2. PolicyPool verifies the public task and X Layer acceptance evidence.
3. An unenrolled service produces a deduplicated demand signal and provider enrollment link without charge.
4. An eligible request produces a signed ten-minute quote bound to the buyer, job, policy, and canonical request.
5. The buyer pays `/api/covered-job-receipt` through x402.
6. PolicyPool reruns eligibility and asks the evidence-attestation service for quorum signatures over the exact issue payload and underlying task evidence.
7. Any relayer submits the signed issue action. The bond locks before the `0.1 USD₮0` fee settles.
8. If service-fee settlement fails, the same evidence process releases the bond; an unresolved failure remains durable as `compensation_required`.

Bodyless OKX replay is supported by the verified payer: exactly one live quote may be recovered. Zero or multiple matches fail closed without settlement.

## Direct A2MCP Buyer Flow

`/api/direct-a2mcp` is the A2MCP checkout. It is direct HTTP plus x402 and explicitly reports `marketplaceTaskCompatible: false`.

1. The buyer submits its wallet, target agent and service, requested cap, and exact provider request. PolicyPool probes the enrolled endpoint without payment and validates one canonical x402 challenge against the live policy, endpoint, provider wallet, service price, X Layer USD₮0 asset, and token domain.
2. PolicyPool returns the provider's original payment challenge plus a signed ten-minute quote. Nothing is locked or charged.
3. The buyer signs the provider authorization and resubmits it as `PROVIDER-PAYMENT-SIGNATURE`. PolicyPool verifies its signer, nonce, amount, destination, expiry, and original challenge hash without settling it.
4. PolicyPool derives the synthetic direct job and covenant IDs, then returns its separate refundable fee challenge. The buyer signs that authorization as `PAYMENT-SIGNATURE`.
5. On the final call, PolicyPool reruns the live policy and provider challenge. The evidence quorum issues the covenant and locks provider bond, then the `PolicyFeeEscrow` funds the buyer's refundable `0.1 USD₮0` fee.
6. Only after both protections exist does the one-use relay submit the original provider authorization and request. The response, signed receipt, settlement transaction, exact transfer, and `AuthorizationUsed` nonce persist atomically.
7. The relay receipt starts the objective provider clock. PolicyPool captures its fee, then releases a timely completed covenant or leaves the scheduled reconciler to follow the challenge and settlement lifecycle.
8. Exact retries reuse the same quote and both original signatures. Request drift, signature substitution, ambiguous settlement, or a second provider call fails closed.

If the provider never settles, the reconciler proves non-settlement after authorization expiry, obtains quorum authorization to cancel the unpaid covenant, and makes the fee refundable to the buyer. If settlement is proven but the upstream response was lost, the provider is never called again and the covenant enters a manual safety hold rather than an automatic breach.

## Reconciliation

`/api/reconcile-universal` and `/api/reconcile-direct-a2mcp` always require the existing operator bearer token. Scheduled QStash calls additionally carry a QStash signature, which is verified when present; direct operator calls use the bearer token alone. Both endpoints are unprivileged relayers: they observe state, obtain threshold attestations, and broadcast authorized actions. They cannot fabricate or approve custody facts themselves.

QStash is the one-minute primary direct reconciler. The checked-in GitHub workflow independently checks `/api/direct-a2mcp` every five minutes and calls the direct reconciler whenever discovery reports it enabled. That fallback runs with `always()` isolation from the legacy reconciliation step, so direct recovery does not depend on manual QStash setup or on the health of the older path.

Direct reconciliation is scheduled from a fair execution-only queue. Probe and bound quotes cannot occupy its scan window; claim and terminal transitions update membership atomically; and every inspected live execution rotates behind executions not yet scanned. A fixed batch limit therefore bounds work without allowing newer traffic or a persistent safety hold to strand an older covenant.

Before provider dispatch, the live execution retains an authenticated encrypted recovery envelope containing the canonical request and original provider authorization. If the request becomes uncertain, its one-shot reservation remains held and the scheduler can recover the exact settlement and signed relay receipt without the buyer or provider resending anything. Missing provider response bytes remain a visible manual-evidence hold after clock start; they are never treated as proof of provider breach.

The exact completed result remains replayable throughout the ten-day execution-retention window even after its short-lived authorizations expire. The original request and both original signatures must still match every stored binding; expiry tolerance cannot authorize new execution.

Direct A2MCP checkout covers the provider's exact enrolled cap because the fee escrow amount is immutable and enrollment derives the premium from that cap. Omitted coverage defaults to the enrolled cap; partial or larger requests fail before payment rather than being silently overcharged.

The scheduled path can request quorum authorization to:

- start a verified relay clock;
- release timely A2A or A2MCP delivery;
- mark an objective missed deadline as payout due;
- release a lock left after failed service-fee settlement.
- recover a direct provider settlement by its indexed authorization nonce without issuing a second paid request;
- capture or refund the direct PolicyPool fee according to the verified settlement state;
- recover a verified in-window relay clock after the enrollment window closes, or expire it and refund an uncaptured fee after the bounded recovery cutoff;
- hold a settled-but-unrecoverable provider response for manual resolution without slashing the provider.

A relay receipt must attest a start at or before the on-chain enrollment deadline. That valid start may be submitted through fee-authorization expiry plus a ten-minute crash-recovery period; after that exact cutoff, clock start fails and `expireUnstarted` becomes permissionless. Relay issuance also rejects a fee-authorization window that closes before enrollment, so recovery and expiry cannot overlap or invert. A provisional breach stays open for 24 hours so an attested on-time completion can correct it. Final net-loss settlement requires quorum signatures over the exact refund, other recovery, terminal-finality flag, observation time, and recovery-evidence hash, and the observation must be no more than ten minutes old when executed. Provider-bonded SLA credit is different: after the same challenge period, a fresh public-task observation that independently proves an A2A deadline breach may settle the full provider-funded credit without waiting for a marketplace refund. That path cannot be used by a net-loss policy.

## Runtime Configuration

The feature remains disabled unless `POLICYPOOL_UNIVERSAL_ENABLED=true` and every required address and evidence-attestation setting is valid.

```text
POLICYPOOL_UNIVERSAL_ENABLED=false
POLICYPOOL_SHARED_COVERAGE_ENABLED=false
POLICYPOOL_DIRECT_A2MCP_ENABLED=false
OKX_AGENT_IDENTITY_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
POLICYPOOL_V04_OWNER=
POLICYPOOL_V04_MONITOR=
POLICYPOOL_PAYMENT_ASSET=0x779Ded0c9e1022225f8E0630b35a9b54bE713736
POLICYPOOL_OKX_TASK_ESCROW=0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE
POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC=500000
POLICYPOOL_POLICY_REGISTRY_ADDRESS=
POLICYPOOL_BOND_VAULT_ADDRESS=
POLICYPOOL_COVERAGE_MANAGER_ADDRESS=
POLICYPOOL_FEE_ESCROW_ADDRESS=
POLICYPOOL_FEE_TREASURY=
POLICYPOOL_DIRECT_FEE_ATOMIC=100000
POLICYPOOL_PUBLIC_ORIGIN=https://policypool.vercel.app
POLICYPOOL_DIRECT_QUOTE_SECRET=
POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS=
POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS=
POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS=
POLICYPOOL_EVIDENCE_SIGNERS=
POLICYPOOL_EVIDENCE_THRESHOLD=3
POLICYPOOL_EVIDENCE_ATTESTATION_URL=
POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN=
POLICYPOOL_RECOVERY_EVIDENCE_SIGNERS=
POLICYPOOL_RECOVERY_EVIDENCE_THRESHOLD=3
POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL=
POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN=
POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS=
POLICYPOOL_RELAYER_PRIVATE_KEY=
POLICYPOOL_RELAY_SIGNER_ADDRESS=
POLICYPOOL_RELAY_SIGNER_PRIVATE_KEY=
POLICYPOOL_RELAY_GRANT_SECRET=
POLICYPOOL_PROVIDER_REGISTRY_PREFIX=pp:providers:v04
POLICYPOOL_V04_MAX_SLA_SECONDS=604800
POLICYPOOL_PROVIDER_EXPOSURE_MULTIPLIER_BPS=10000
POLICYPOOL_UNIVERSAL_RECONCILE_URL=https://policypool.vercel.app/api/reconcile-universal
POLICYPOOL_DIRECT_A2MCP_RECONCILE_URL=https://policypool.vercel.app/api/reconcile-direct-a2mcp
```

The relayer key, relay signer, five primary evidence signers, and five recovery evidence signers are distinct roles. The relayer may broadcast but cannot authorize custody. Both 3-of-5 quorums must span genuinely independent failure domains, and no signer address may appear in both sets. Each aggregation service returns unique signatures sorted by recovered address. Secrets must never be committed, and Vercel values must be checked for newline contamination.

`POLICYPOOL_V04_OWNER_PRIVATE_KEY` is deployment-only. It must never be configured in an always-on runtime. The cold owner accepts vault ownership and configures the registry monitor; it has no manager or evidence-verifier override.

## Historical Flag-Off Deployment

The July 16 pre-audit deployment is historical and must not be reused:

- bond vault: `0x23BE9FD569cB93db0324cC42BB4Bb439449cFd3a`
- policy registry: `0x57d1ee49c3df6f5Ea3000930068BF6059D2cA17B`
- coverage manager: `0x112e45DC9C29ff2FFd1b60fe3B4E408266E5E855`
- A2A adapter: `0x37ff4e43cAdA62871E927C5C64B2b9876d21cc62`
- relay verifier: `0x84CA17c573F90181ABFdf9Baca066F7A592e3525`

That stack has no `CoverageEvidenceVerifier` and retains the original single-operator trust boundary. Its controlled release and full-payout transactions prove only that the old wiring moved house funds. They do not validate the remediated source.

Production remains v0.3, `/api/manifest` remains the active contract, universal flags remain off, no public enrollment is open, and no OKX listing field needs to change for source development.

## Internal Audit Checkpoint

The July 16 internal reviews and remediation are recorded in [INTERNAL_SOLIDITY_AUDIT_V04.md](INTERNAL_SOLIDITY_AUDIT_V04.md). The original High single-operator finding is remediated in source. The later hostile review's stale-settlement, release-ordering, and quorum-loss findings are also remediated in source with terminal recovery plus 10-minute settlement-evidence freshness, a 24-hour challenge period with signed completion time, and a 30-day delayed recovery quorum. GitHub Codex's runtime reviews then prompted remediation of unpaid header-only relay clocks, DNS rebinding between endpoint validation and connection, provider-payment payer substitution, unpaid relay receipt pointer replacement, non-atomic paid-receipt persistence, expiring consumed grant claims, incomplete enrollment-confirmation binding, the missing payout-due settlement path, post-deadline fee-failure bond lock, and both pre-grant and post-settlement clock-write crash windows. The final internal pass additionally anchors the challenge to the mined breach transition, rejects outbound short transfers, and makes the canonical X Layer deployment plus exact 3-of-5 role topology fail before broadcast. The direct A2MCP extension adds an ownerless refundable fee escrow, immutable two-authorization checkout, durable response persistence, canonical EIP-3009 identities for both payment legs, bounded nonce-indexed settlement recovery with a one-block clock-skew overlap, and unattended direct reconciliation with QStash primary plus a checked-in GitHub fallback. The candidate suite passes 118 Foundry tests; runtime gates cover full on-chain enrollment-term binding, grant-buyer-bound paid relay proof with atomic durable reconciliation indexing, terminal settlement, challenge holds, uncertain issuance reconciliation, expired-unused fee cancellation, direct no-settlement refund, crash-safe one-time provider execution, bounded delayed clock recovery, settled-response safety holds, and scheduler fallback presence.

Core branch coverage:

- `AgentPolicyRegistry`: `100%` (`23/23`)
- `ProviderBondVault`: `100%` (`30/30`)
- `CoverageEvidenceVerifier`: `100%` (`13/13`)
- `CoverageManager`: `93.33%` (`42/45`)
- `OkxA2AClockAdapter`: `100%` (`6/6`)
- `RelayReceiptVerifier`: `100%` (`8/8`)

The three reported uncovered manager branches are defensive paths: the explicit reentrancy behavior test is not attributed to the guard branch by Foundry coverage instrumentation; an A2A deadline cannot already be elapsed while its shorter enrollment window remains open under `enrollmentWindowSeconds <= slaSeconds`; and an `Active` or `PayoutDue` covenant cannot enter emergency resolution with an unset deadline.

This is still an internal review. Claude's second review is another internal adversarial pass, not a qualified independent human audit.

## Release Gates

```bash
npm install
npm run agent:gate-v04
```

Required before a fresh flag-off house-operated deployment:

- all runtime, v0.3 regression, v0.4, Foundry, dependency, secret, and diff gates pass;
- Claude independently reviews the remediated commit and no unresolved Critical or High finding remains;
- both internal adversarial reviews have no unresolved Critical or High finding;
- the house signer manifest satisfies the exact, disjoint 3-of-5 topology and is suitable only for controlled drills;
- the evidence service independently verifies underlying context instead of signing relayer assertions;
- the old deployment remains disabled and empty of third-party capital;
- a new eight-contract stack is deployed flag-off and source/creation bytecode is verified;
- fresh house pilots prove release, full payout, recovery-reduced payout, direct success, direct no-settlement cancellation/refund, and fee capture;
- interactive 390px browser checks and a dry-run reconciler preserve v0.3 receipts;
- any externally owned provider using a PolicyPool-sponsored bond is disclosed as sponsored and follows a successful house canary;
- third-party-funded provider bonds remain blocked until a qualified independent human Solidity audit and operationally independent signer topology are complete.

## Rollout And Rollback

1. Deploy the vault, registry, primary evidence verifier, disjoint recovery evidence verifier, manager, fee escrow, A2A adapter, and relay verifier while the feature is off.
2. Initialize the vault manager once, transfer vault ownership to the cold owner, accept ownership, and set the registry monitor.
3. Verify bytecode, immutable dependencies, both 3-of-5 signer sets, zero signer overlap, thresholds, token, identity registry, ownership, monitor, and relay signer from chain state.
4. Configure the unprivileged relayer and both independently operated evidence services while the feature remains off.
5. Run the complete gate and read-only reconciliation.
6. Run separately labeled house covenants for release, full payout, payout reduced by verified recovery, direct A2MCP success, direct no-settlement cancellation/refund, and fee capture.
7. After a house A2MCP canary, enroll one externally owned provider with a clearly disclosed PolicyPool-sponsored bond and run a controlled house-buyer happy path.
8. Treat a genuine non-reciprocal external buyer as upside, not a release prerequisite. Do not accept provider-funded external capital until the qualified audit and independent signer gate close.

Rollback stops new issuance by setting `POLICYPOOL_UNIVERSAL_ENABLED=false`. Existing covenants still require their normal evidence-attested lifecycle and cannot be abandoned.

## Known Limitations

- The hardened source is not deployed. The historical flag-off bytecode must never accept third-party bonds.
- Both evidence quorums are trusted oracle sets. Threshold collusion can authorize false evidence; the delayed recovery quorum reduces primary-quorum liveness risk but cannot resolve an obligation if both evidence quorums lose threshold availability.
- Immutable signer sets and the one-time vault manager favor fail-closed custody over privileged recovery. Rotation requires a new stack and planned migration after old obligations close.
- This internal work is not a qualified independent audit.
- The canonical X Layer ERC-8004 registry is an externally controlled EIP-1967 proxy; ownership checks inherit its upgrade and availability risk.
- OKX.AI exposes no documented stable JSON service directory, so strict cached HTML parsing remains an external dependency and fails closed when stale.
- A2A delivery timing and terminal recovery need a public task reference and historical timestamp. v0.4 A2A issuance rejects requests without one; current status alone does not prove timing or authorize settlement.
- A2MCP coverage must use `/api/direct-a2mcp` or the covenant-bound PolicyPool relay. OKX Task Marketplace is A2A-only and cannot execute an A2MCP service.
- Relay execution is at-most-once. An uncertain provider response requires investigation rather than an automatic paid retry.
- Direct checkout can recover a proven provider settlement without another call, but if the upstream response was not durably captured it cannot reconstruct the deliverable and therefore holds coverage for manual resolution.
- The direct fee escrow is fixed at `0.1 USD₮0`; enrollment verifies that immutable on-chain amount, rejects a cap above the live service price, and accepts a direct policy cap only when its derived basis-point rate represents the fee exactly.
- Coverage-fee failure never masquerades as provider delivery. The exact fee authorization is bound at issuance; uncertain issuance remains durable until expiry and chain recheck, after which quorum-attested non-settlement can cancel an unpaid covenant and unlock a clean retry.
- Policy expiry is the last issuance time, not the deadline by which an existing covenant must finish.
- Discretionary provider premiums, shared-reserve co-coverage, subjective quality claims, ratings, additional chains, and discretionary automated payouts remain out of scope.
