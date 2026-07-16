# PolicyPool Universal Coverage v0.4

Status: REMEDIATED IN SOURCE: independent review and redeployment required.

The pre-audit v0.4 contracts were deployed flag-off for a controlled house pilot. The hardened source now differs from that bytecode and is not deployed. Production remains v0.3. Public enrollment and third-party bonds remain blocked.

## Product Boundary

v0.4 makes an eligible OKX.AI service coverable only after its provider opts in. The provider must own the listed agent, deposit first-loss USD₮0 into the bond vault, and sign objective versioned terms for one exact service fingerprint. Unknown services create a deduplicated demand signal and an enrollment link; they never receive unbacked coverage.

This is not provider-agnostic insurance. Without provider first loss, a buyer and an unenrolled provider could collude, allow a task to fail, recover marketplace escrow, and also claim coverage. Provider-funded first loss closes that buyer-provider extraction path only when the evidence quorum is honest. It does not protect against a colluding signer threshold.

The listed PolicyPool service continues to charge a fixed `0.1 USD₮0` issuance fee. Provider-defined premiums are not active in v0.4 and the enrollment API requires `premiumBps: 0`.

## Evidence Trust Model

The original manager gave one hot operator authority over the job, buyer, acceptance, release, breach, and recovery facts that moved provider bonds. The remediated source removes that owner/operator path.

Every subjective lifecycle action now requires an immutable threshold evidence quorum:

- Each `CoverageEvidenceVerifier` is contractually restricted to at least five signers and a 3-of-5 threshold.
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
8. A paid relay grant is short-lived, bound to one covenant, job, buyer, agent, and service, and permits at most one paid provider execution. A relay clock starts only after the buyer's EIP-3009 authorization is signature-verified, the exact USD₮0 transfer and authorization nonce are proven in the settlement transaction, and that authorization is permanently consumed.
9. Settlement failure cannot erase the on-chain lock. A durable `compensation_required` record remains until reconciliation releases it.
10. Issuance, clock start, subjective release, breach, and settlement require threshold-attested evidence. The runtime relayer cannot perform any of them alone.
11. A full marketplace refund cannot stack with a net-loss payout. Recovery amounts are part of the signed settlement payload.
12. One marketplace job can receive only one covenant, across all policy versions and buyers.
13. Every state-changing manager entry point has an explicit reentrancy guard.
14. Net-loss settlement requires terminal recovery evidence observed within ten minutes of execution.
15. Breach is provisional for a 24-hour challenge period. A quorum-attested completion at or before the original deadline can correct `PayoutDue` to `Released` before settlement.
16. The primary and 30-day delayed recovery quorums each require at least 3-of-5 signers and share no signer address.
17. A2MCP provider DNS is resolved once, every returned address must be public, and the outbound TLS connection is pinned to one of those checked addresses while preserving hostname and certificate verification.

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
- Enforces completion at or before the covenant deadline, 10-minute settlement-evidence freshness, terminal recovery, and a 24-hour challenge period before either settlement path.
- Allows a completely disjoint recovery quorum to release or settle after a 30-day delay without giving an owner or relayer a custody bypass.
- Keeps objective `expireUnstarted` permissionless after the on-chain enrollment deadline.

### Clock adapters

`OkxA2AClockAdapter` holds timing-ambiguous delivery statuses until historical delivery timing is available. The A2MCP relay rejects redirects and private or special-use destinations, pins the checked IP at connection time, verifies the grant-bound buyer's token-domain EIP-3009 signature, and proves the exact `Transfer` plus `AuthorizationUsed` nonce before creating a clock. Unpaid receipts remain addressable for diagnostics but cannot replace the payment-verified per-job receipt used by reconciliation. `RelayReceiptVerifier` uses EIP-712 signatures bound to chain ID and verifier address; relay receipts alone cannot move bonds because the manager separately requires quorum evidence.

The contracts are intentionally non-upgradeable. Security changes require a complete redeployment. A qualified independent human audit remains mandatory before third-party capital is accepted.

## Enrollment Flow

1. Open `/providers/enroll` with the wallet that owns the OKX.AI agent.
2. Approve and deposit USD₮0 into the bond vault.
3. Enter one service ID and objective terms.
4. `/api/provider-enrollment` verifies the live owner and service, computes the fingerprint, checks bond capacity, and returns EIP-712 enrollment data.
5. The provider signs and broadcasts `registerPolicyBySig`.
6. PolicyPool verifies the event, reads the exact registered policy, matches its complete terms hash to the provider-signed enrollment, and then checks the fingerprint, latest version, and current coverability before projecting the policy as active.

The manifest is a last-confirmed projection, not a guarantee. Every quote revalidates the live owner, service fingerprint, policy, expiry, and bond.

## Buyer Flow

1. Submit an OKX.AI task URL, target agent, service, and requested cap to `/api/coverage-preflight`.
2. PolicyPool verifies the public task and X Layer acceptance evidence.
3. An unenrolled service produces a deduplicated demand signal and provider enrollment link without charge.
4. An eligible request produces a signed ten-minute quote bound to the buyer, job, policy, and canonical request.
5. The buyer pays `/api/covered-job-receipt` through x402.
6. PolicyPool reruns eligibility and asks the evidence-attestation service for quorum signatures over the exact issue payload and underlying task evidence.
7. Any relayer submits the signed issue action. The bond locks before the `0.1 USD₮0` fee settles.
8. If service-fee settlement fails, the same evidence process releases the bond; an unresolved failure remains durable as `compensation_required`.

Bodyless OKX replay is supported by the verified payer: exactly one live quote may be recovered. Zero or multiple matches fail closed without settlement.

## Reconciliation

`/api/reconcile-universal` is authenticated by the existing operator token. QStash requests also require a valid QStash signature. That endpoint is an unprivileged relayer: it observes state, obtains threshold attestations, and broadcasts authorized actions. It cannot fabricate or approve custody facts itself.

The scheduled path can request quorum authorization to:

- start a verified relay clock;
- release timely A2A or A2MCP delivery;
- mark an objective missed deadline as payout due;
- release a lock left after failed service-fee settlement.

An unstarted relay covenant may be expired permissionlessly after its on-chain enrollment deadline. A provisional breach stays open for 24 hours so an attested on-time completion can correct it. Final net-loss settlement requires quorum signatures over the exact refund, other recovery, terminal-finality flag, observation time, and recovery-evidence hash, and the observation must be no more than ten minutes old when executed.

## Runtime Configuration

The feature remains disabled unless `POLICYPOOL_UNIVERSAL_ENABLED=true` and every required address and evidence-attestation setting is valid.

```text
POLICYPOOL_UNIVERSAL_ENABLED=false
POLICYPOOL_SHARED_COVERAGE_ENABLED=false
OKX_AGENT_IDENTITY_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
POLICYPOOL_V04_OWNER=
POLICYPOOL_V04_MONITOR=
POLICYPOOL_PAYMENT_ASSET=0x779Ded0c9e1022225f8E0630b35a9b54bE713736
POLICYPOOL_OKX_TASK_ESCROW=0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE
POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC=500000
POLICYPOOL_POLICY_REGISTRY_ADDRESS=
POLICYPOOL_BOND_VAULT_ADDRESS=
POLICYPOOL_COVERAGE_MANAGER_ADDRESS=
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

The July 16 internal reviews and remediation are recorded in [INTERNAL_SOLIDITY_AUDIT_V04.md](INTERNAL_SOLIDITY_AUDIT_V04.md). The original High single-operator finding is remediated in source. The later hostile review's stale-settlement, release-ordering, and quorum-loss findings are also remediated in source with terminal recovery plus 10-minute settlement-evidence freshness, a 24-hour challenge period with signed completion time, and a 30-day delayed recovery quorum. GitHub Codex's runtime reviews then prompted remediation of unpaid header-only relay clocks, DNS rebinding between endpoint validation and connection, provider-payment payer substitution, unpaid relay receipt pointer replacement, incomplete enrollment-confirmation binding, the missing payout-due settlement path, and post-deadline fee-failure bond lock. The candidate suite passes 88 Foundry tests; runtime gates now cover full on-chain enrollment-term binding, grant-buyer-bound paid relay proof with stable reconciliation indexing, terminal settlement, challenge holds, uncertain issuance reconciliation, and primary plus recovery-quorum expired-unused fee cancellation.

Core branch coverage:

- `AgentPolicyRegistry`: `100%` (`23/23`)
- `ProviderBondVault`: `100%` (`29/29`)
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

Required before the next deployment:

- all runtime, v0.3 regression, v0.4, Foundry, dependency, secret, and diff gates pass;
- Claude independently reviews the remediated commit and no unresolved Critical or High finding remains;
- a qualified independent human Solidity audit is complete;
- evidence signers are operationally independent and no one failure domain can satisfy the threshold;
- the evidence service independently verifies underlying context instead of signing relayer assertions;
- the old deployment remains disabled and empty of third-party capital;
- a new seven-contract stack is deployed flag-off and source/creation bytecode is verified;
- a fresh house pilot proves release, full payout, and recovery-reduced payout;
- interactive 390px browser checks and a dry-run reconciler preserve v0.3 receipts;
- public enrollment opens only after every preceding gate is recorded.

## Rollout And Rollback

1. Deploy the vault, registry, primary evidence verifier, disjoint recovery evidence verifier, manager, A2A adapter, and relay verifier while the feature is off.
2. Initialize the vault manager once, transfer vault ownership to the cold owner, accept ownership, and set the registry monitor.
3. Verify bytecode, immutable dependencies, both 3-of-5 signer sets, zero signer overlap, thresholds, token, identity registry, ownership, monitor, and relay signer from chain state.
4. Configure the unprivileged relayer and both independently operated evidence services while the feature remains off.
5. Run the complete gate and read-only reconciliation.
6. Run three separately labeled house covenants: release, full payout, and payout reduced by verified recovery.
7. Enable one bounded external provider only after the qualified independent audit signs off.

Rollback stops new issuance by setting `POLICYPOOL_UNIVERSAL_ENABLED=false`. Existing covenants still require their normal evidence-attested lifecycle and cannot be abandoned.

## Known Limitations

- The hardened source is not deployed. The historical flag-off bytecode must never accept third-party bonds.
- Both evidence quorums are trusted oracle sets. Threshold collusion can authorize false evidence; the delayed recovery quorum reduces primary-quorum liveness risk but cannot resolve an obligation if both evidence quorums lose threshold availability.
- Immutable signer sets and the one-time vault manager favor fail-closed custody over privileged recovery. Rotation requires a new stack and planned migration after old obligations close.
- This internal work is not a qualified independent audit.
- The canonical X Layer ERC-8004 registry is an externally controlled EIP-1967 proxy; ownership checks inherit its upgrade and availability risk.
- OKX.AI exposes no documented stable JSON service directory, so strict cached HTML parsing remains an external dependency and fails closed when stale.
- A2A delivery timing and terminal recovery need a public task reference and historical timestamp. v0.4 A2A issuance rejects requests without one; current status alone does not prove timing or authorize settlement.
- A2MCP coverage requires the PolicyPool relay; direct provider calls cannot prove the processing-start clock.
- Relay execution is at-most-once. An uncertain provider response requires investigation rather than an automatic paid retry.
- Coverage-fee failure never masquerades as provider delivery. The exact fee authorization is bound at issuance; uncertain issuance remains durable until expiry and chain recheck, after which quorum-attested non-settlement can cancel an unpaid covenant and unlock a clean retry.
- Policy expiry is the last issuance time, not the deadline by which an existing covenant must finish.
- Provider premiums, shared-reserve co-coverage, subjective quality claims, ratings, additional chains, and discretionary automated payouts remain out of scope.
