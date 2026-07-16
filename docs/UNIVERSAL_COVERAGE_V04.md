# PolicyPool Universal Coverage v0.4

Status: the pre-audit v0.4 contracts were deployed flag-off for a controlled house pilot. The hardened source now differs from that bytecode and is not deployed. Production remains v0.3; public enrollment and third-party bonds are blocked by the internal audit verdict.

## Product Boundary

v0.4 makes any eligible OKX.AI service coverable only after its provider opts in. The provider must own the listed agent, deposit first-loss USD₮0 into the bond vault, and sign objective versioned terms for one exact service fingerprint. Unknown services create a deduplicated demand signal and an enrollment link; they never receive unbacked coverage.

This is not provider-agnostic insurance. A buyer and an unenrolled provider could otherwise collude, allow a task to fail, recover marketplace escrow, and also claim coverage. Provider-funded first loss removes that extraction path.

The listed PolicyPool service continues to charge a fixed `0.1 USD₮0` issuance fee. Provider-defined premiums are not active in v0.4 and the enrollment API requires `premiumBps: 0`.

## Invariants

1. No provider bond, no active policy.
2. The provider wallet must own the OKX.AI agent at enrollment and quote time.
3. One policy version binds one agent ID, service ID, live service fingerprint, scope hash, cap, SLA, enrollment window, payout basis, clock mode, expiry, and adapter.
4. A listing or ownership change fails closed for new coverage until the provider signs a new policy version.
5. The on-chain manager enforces the provider-signed maximum cap and exact enrollment window; the operator cannot silently widen either.
6. A covenant cap cannot exceed the target-job value, provider-signed cap, configured global cap, or available provider bond.
7. Shared-reserve exposure is disabled by default. New v0.4 covenants lock provider first-loss capital only.
8. A paid relay grant is short-lived, bound to one covenant, job, buyer, agent, and service, and permits at most one paid provider execution.
9. Settlement failure cannot erase the on-chain lock. A durable `compensation_required` record remains until reconciliation releases it.
10. Payout settlement remains operator-approved and requires independently verified recovery evidence. The scheduler can mark `payout_due`; it cannot decide or send final compensation.
11. One marketplace job can receive only one covenant, across all policy versions and buyers.

## Contracts

### `ProviderBondVault`

- Holds provider-owned USD₮0 first-loss deposits.
- Locks a covenant-specific amount before the PolicyPool service fee settles.
- Prevents withdrawal of locked or queued capital.
- Uses an eight-day withdrawal queue.
- Releases a successful covenant or slashes only the verified payout amount.
- Rejects fee-on-transfer assets and uses a reentrancy guard on token-moving paths.

### `AgentPolicyRegistry`

- Verifies ERC-8004/OKX agent ownership.
- Supports direct enrollment and relayed EIP-712 enrollment with nonces and expiry.
- Creates immutable policy versions; a new version does not mutate an existing covenant.
- Revalidates live agent ownership, latest version, fingerprint, expiry, and minimum available bond in `isCoverable`.
- Lets a provider pause its own policy and a monitor suspend a changed fingerprint.

### `CoverageManager`

- Locks provider capital before the x402 fee is settled.
- Pins policy, job, buyer, provider, cap, job value, SLA, enrollment window, and clock mode.
- Enforces provider-signed cap and enrollment window on-chain.
- Supports A2A acceptance clocks and A2MCP relay clocks.
- Releases, marks payout due, expires an unstarted relay clock, or settles verified loss.
- Prevents a full marketplace refund from stacking with a net-loss payout.
- Rejects a second covenant for a job even if the policy version or buyer changes.

The contracts are intentionally non-upgradeable. The bond-vault manager is initialized once and cannot be replaced. Audit fixes require a complete redeployment, and an independent security audit remains mandatory before third-party capital is accepted.

## Enrollment Flow

1. Open `/providers/enroll` and connect the wallet that owns the OKX.AI agent.
2. Build and broadcast the USD₮0 approval/deposit transactions returned by `/api/provider-bond`.
3. Enter one service ID and objective terms.
4. `/api/provider-enrollment` fetches the live OKX.AI agent page, verifies owner and service, calculates the service fingerprint, checks available bond, and returns EIP-712 data.
5. The provider signs the exact terms.
6. The provider broadcasts `registerPolicyBySig` and confirms its transaction hash.
7. PolicyPool verifies the event, current fingerprint, latest policy version, and on-chain coverability before projecting the policy as active.

The public manifest is a last-confirmed enrollment projection, not a live guarantee. Every quote revalidates agent owner, service fingerprint, policy state, expiry, and available bond.

## Buyer Flow

1. Submit an OKX.AI task URL, target agent, target service, and requested cap to `/api/coverage-preflight`.
2. PolicyPool verifies the public task and X Layer acceptance evidence.
3. If the service is not enrolled, `/api/coverage-demand` records one deduplicated signal and returns the provider enrollment link without charging.
4. If eligible, preflight returns a signed ten-minute quote bound to the verified buyer, job, policy, and canonical request.
5. The buyer pays the existing `/api/covered-job-receipt` x402 endpoint.
6. PolicyPool reruns the entire eligibility pass, locks the provider bond on-chain, settles the `0.1 USD₮0` service fee, and returns the covenant receipt.
7. If settlement fails, PolicyPool releases the bond. If that release fails, durable compensation evidence is retained for the reconciler.

Bodyless OKX replay is supported by the payment payer: exactly one live canonical quote bound to that payer may be recovered. Zero or multiple canonical quotes fail closed without settlement.

## Clock Adapters

### A2A

The clock starts at verified target-job acceptance. Reconciliation uses the public OKX task timeline for delivery timing. If a historical delivery timestamp is unavailable, PolicyPool holds rather than guessing. New preflight-generated covenants store the public task reference needed for that evidence.

### A2MCP

The buyer sends the funded provider request through `/api/provider-relay` using the relay grant returned with the covenant. The relay only calls the exact live enrolled HTTPS endpoint, blocks private/reserved DNS results, caps request and response sizes, forwards a narrow header allowlist, and signs a receipt over request/response hashes and timing.

The first paid request consumes the grant. Paid retries fail closed instead of risking duplicate provider execution.

## Reconciliation

`/api/reconcile-universal` is authenticated by the operator token. QStash requests additionally require a valid QStash signature. The intended primary schedule is once per minute with retries; the existing GitHub schedule remains a backup.

Automatic transitions:

- start a verified relay clock;
- release timely A2A or A2MCP delivery;
- mark an objective missed deadline as payout due;
- expire an A2MCP covenant whose funded request never reached the relay;
- release a bond left in `compensation_required` after a failed service-fee settlement.

Final payout remains outside the scheduler. An operator must supply independently verified recovery evidence and approve settlement.

## Runtime Configuration

The v0.4 feature remains disabled unless `POLICYPOOL_UNIVERSAL_ENABLED=true` and all contract/signer addresses are present.

```text
POLICYPOOL_UNIVERSAL_ENABLED=false
POLICYPOOL_SHARED_COVERAGE_ENABLED=false
OKX_AGENT_IDENTITY_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
POLICYPOOL_V04_OWNER=0xe1B41AF2ebAB2476930eC4Da03D80dA525076A21
POLICYPOOL_V04_OPERATOR=0x79b21b067b19b50Dbb1C890D4825Fdf6B6B61Dd2
POLICYPOOL_V04_MONITOR=0x3376703ba5610688d88FeA99C9E09A0eA8B95199
POLICYPOOL_PAYMENT_ASSET=0x779Ded0c9e1022225f8E0630b35a9b54bE713736
POLICYPOOL_OKX_TASK_ESCROW=0x000000EB79a0c9cBEED4BD63372653E28F6bEdbE
POLICYPOOL_MINIMUM_PROVIDER_BOND_ATOMIC=500000
POLICYPOOL_POLICY_REGISTRY_ADDRESS=0x57d1ee49c3df6f5Ea3000930068BF6059D2cA17B
POLICYPOOL_BOND_VAULT_ADDRESS=0x23BE9FD569cB93db0324cC42BB4Bb439449cFd3a
POLICYPOOL_COVERAGE_MANAGER_ADDRESS=0x112e45DC9C29ff2FFd1b60fe3B4E408266E5E855
POLICYPOOL_OKX_A2A_ADAPTER_ADDRESS=0x37ff4e43cAdA62871E927C5C64B2b9876d21cc62
POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS=0x84CA17c573F90181ABFdf9Baca066F7A592e3525
POLICYPOOL_MANAGER_PRIVATE_KEY=
POLICYPOOL_RELAY_SIGNER_ADDRESS=0xfd5F856713d271A450Ef804095c847d52210d1dc
POLICYPOOL_RELAY_SIGNER_PRIVATE_KEY=
POLICYPOOL_RELAY_GRANT_SECRET=
POLICYPOOL_PROVIDER_REGISTRY_PREFIX=pp:providers:v04
POLICYPOOL_V04_MAX_SLA_SECONDS=604800
POLICYPOOL_PROVIDER_EXPOSURE_MULTIPLIER_BPS=10000
POLICYPOOL_UNIVERSAL_RECONCILE_URL=https://policypool.vercel.app/api/reconcile-universal
```

Keep manager and relay keys distinct. `POLICYPOOL_RELAY_SIGNER_ADDRESS` is public configuration; its corresponding private key and the relay-grant secret must never be committed. Verify secret byte lengths after setting Vercel variables because newline contamination changes HMAC output.

`POLICYPOOL_V04_OWNER_PRIVATE_KEY` is deployment-only input for `WireAgentCoverageV04Roles.s.sol`. It must never be configured in Vercel or any always-on runtime. After deployment, the cold owner accepts the bond-vault ownership transfer and sets the dedicated manager operator and policy monitor through that script.

## Flag-Off Production Checkpoint

Production deployment `dpl_6h8MXHN5oWfEr8JHdyARLhP1oudm` was aliased to `https://policypool.vercel.app` on 2026-07-16 with `POLICYPOOL_UNIVERSAL_ENABLED=false` and `POLICYPOOL_SHARED_COVERAGE_ENABLED=false`.

- The v0.3 manifest remains the active production contract at `/api/manifest`.
- The v0.4 manifest is available at `/api/universal-manifest` and reports `feature_gated`, with every required public runtime address present.
- The existing listed endpoint remains `HEAD 200` and fails closed with `charged:false` for an invalid request.
- A production-ledger dry run inspected seven v0.3 records, selected zero v0.4 records, produced zero changes, and preserved the exact before/after record hash.
- The pre-audit v0.4 gate passed with 63 Foundry tests and zero production dependency vulnerabilities.
- No QStash schedule is active, no OKX listing field changed, and public provider enrollment remains closed.
- The Hobby-plan function limit is met by serving both manifest surfaces through the existing manifest serverless function; both public URLs remain stable.

This checkpoint does not satisfy the independent Solidity audit gate. Third-party bonds and public enrollment remain prohibited.

## Controlled Mainnet Pilot

The two-path house pilot completed on X Layer on 2026-07-16. It used only PolicyPool-controlled wallets and `0.5 USD₮0` of provider bond, is labeled controlled and house-funded, and is excluded from revenue, external usage, and organic traction claims.

- Policy: `0x1f9b305f5f5f8e3da7d1604841ac4504c147b0052c0f96c347eec1efc8619e31`.
- Release covenant: `0x0720c4daefa787dc3760a430e25d0b8d04b5e9348e078a98b748ada1da71c9b9`; final on-chain state `Released` (`3`); the full bond lock returned to available capacity.
- Breach covenant: `0x3866b4dd515c77c02f253e9c47811b66bc845d2da3dc987258ddce4c30efe898`; final on-chain state `Paid` (`5`); payout `500000` atomic USD₮0.
- Net-loss settlement: `0x96590b055dc400c57b8087e220e08f292741563d631c68b6ba3cc9a0d00c0af0`; the receipt is successful and its ERC-20 transfer moves exactly `0.5 USD₮0` from the bond vault to the separate controlled buyer.
- Recovery inputs were zero escrow refund, zero other recovery, and a nonzero evidence hash. No shared reserve was used.
- After settlement the provider bond is zero and the policy fails closed as not coverable.

Do not rerun or fund this pilot again. The next release gate is independent Solidity review, followed by a separately authorized bounded rollout; the completed house proof does not authorize third-party capital.

## Internal Audit Checkpoint

The July 16 internal adversarial review is recorded in [INTERNAL_SOLIDITY_AUDIT_V04.md](INTERNAL_SOLIDITY_AUDIT_V04.md). Its release verdict is `BLOCKED: confirmed unresolved High issue` for third-party bonds and public enrollment.

The hardened source:

- prevents duplicate coverage of one job across policy versions or buyers;
- initializes the vault manager once and makes it non-replaceable;
- holds timing-ambiguous A2A delivery states until historical timing is proven;
- passes 64 Foundry tests, with 96.43% to 100% branch coverage across the five core v0.4 contracts.

The unresolved blocker is operator evidence authority: `CoverageManager` still trusts the hot operator for the job, buyer, acceptance time, release, breach, and recovery facts that control provider bond settlement. Those facts must be authenticated independently before strangers' capital is accepted.

The audit fixes changed contract bytecode. The existing flag-off deployment and house-pilot receipts remain historical evidence for the pre-audit stack only. A remediated stack requires a full redeployment and a new, separately authorized controlled pilot. No audit action changed production, the OKX listing, feature flags, schedulers, funding, or deployed contracts.

## Release Gates

```bash
npm install
npm run agent:gate-v04
```

Required before deployment:

- all JavaScript and Python syntax checks pass;
- all v0.3 regression gates pass;
- all v0.4 enrollment, bond, relay, clock, issuer, manifest, rate-limit, compensation, and reconciliation gates pass;
- all Foundry tests pass;
- dependency audit reports zero known production vulnerabilities;
- secret scan and `git diff --check` pass;
- `/coverage`, `/providers`, and `/providers/enroll` pass an interactive 390px browser gate;
- the High operator-evidence finding in the internal audit is resolved in code and regression tests;
- an independent Solidity audit is complete;
- deployment owner, operator, monitor, and relay signer are distinct where appropriate;
- dry-run reconciliation leaves existing external v0.3 receipts untouched;
- a controlled provider-funded test succeeds before public enrollment opens.

## Rollout And Rollback

1. Deploy contracts without enabling the feature.
2. Run `WireAgentCoverageV04Roles.s.sol` from the cold owner to accept bond-vault ownership, set the hot operator, and set the registry monitor.
3. Verify bytecode, ownership, pending ownership, manager wiring, minimum bond, signer, monitor, operator, token, identity registry, and adapters from chain state.
4. Configure Redis, signer, and contract addresses while `POLICYPOOL_UNIVERSAL_ENABLED=false`.
5. Run the full gate and a read-only reconciler dry run.
6. Enable v0.4 for one house provider and one bounded controlled covenant only.
7. Open external enrollment only after independent review and the controlled covenant releases or settles correctly.

Rollback is the feature flag: set `POLICYPOOL_UNIVERSAL_ENABLED=false`. Production v0.3 static policies and receipts continue through the unchanged listed endpoint. Existing on-chain v0.4 covenants still require reconciliation and cannot be abandoned by disabling new issuance.

## Known Limitations

- The deployed v0.4 bytecode predates the internal audit fixes and must never be enabled for third-party bonds.
- The hardened source still has an unresolved High operator-evidence trust boundary and must not custody public provider funds.
- This internal review is not an independent Solidity audit.
- The canonical X Layer ERC-8004 identity registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is an EIP-1967 upgradeable proxy controlled outside PolicyPool. Agent ownership checks inherit that third-party upgrade and availability risk.
- OKX.AI has no documented stable JSON service-directory API; PolicyPool uses strict, cached, bounded HTML parsing and fails closed on stale evidence.
- A2A delivery timing requires a public task reference and timeline timestamp. Current status alone never proves historical timing.
- A2MCP coverage requires the PolicyPool relay; direct provider calls cannot prove the processing-start clock.
- Relay execution is at-most-once. A lost response after provider execution requires operator investigation rather than an automatic paid retry.
- Relay receipt signatures are not yet domain-separated by chain ID and verifier address; use a dedicated deployment signer until EIP-712 binding lands.
- Policy expiry currently means the last time new coverage may be issued, not the deadline by which an already-issued covenant must finish.
- One-time vault-manager initialization prevents manager migration while funds remain in that vault.
- Provider-defined premiums, shared-reserve co-coverage, subjective quality claims, ratings, additional chains, and automatic payout discretion are out of v0.4.
