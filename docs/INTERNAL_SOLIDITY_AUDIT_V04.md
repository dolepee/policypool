# PolicyPool v0.4 Internal Solidity Audit

Date: 2026-07-16

## Classification

This is an internal adversarial review performed with automated tooling and manual source analysis. It is not an independent third-party audit and must not be represented as one.

## Verdict

**BLOCKED: confirmed unresolved High issue.**

The v0.4 contracts must not accept third-party provider bonds or enable public enrollment. The production v0.3 service is outside this Solidity rollout and remains unaffected. The v0.4 feature flags must remain off.

Three confirmed defects were fixed in the audited source:

- duplicate coverage of one job across policy versions;
- unrestricted replacement of the bond vault manager by the owner;
- release of timing-ambiguous A2A jobs from current status alone.

Those fixes require a new deployment. They do not close the remaining High operator-evidence trust boundary.

## Scope

Reviewed branch baseline: `v0.4-universal-coverage` at `28c8d0e6832056b72e8d0021383b7d7a43a88448`.

Primary scope:

- `src/ProviderBondVault.sol`
- `src/AgentPolicyRegistry.sol`
- `src/CoverageManager.sol`
- `src/adapters/OkxA2AClockAdapter.sol`
- `src/adapters/RelayReceiptVerifier.sol`
- `script/DeployAgentCoverageV04.s.sol`
- `script/WireAgentCoverageV04Roles.s.sol`
- the v0.4 Foundry tests and runtime integration paths

The dirty `lib/v4-core` submodule was preserved and excluded from all edits.

## Deployed Baseline

Before audit fixes, read-only verification established that the creation bytecode recorded for the five flag-off v0.4 contracts matched the source at baseline commit `28c8d0e`. The deployed role wiring also matched the documented cold owner, hot operator, monitor, and relay signer.

The deployed addresses are historical pre-audit instances:

- bond vault: `0x23BE9FD569cB93db0324cC42BB4Bb439449cFd3a`
- policy registry: `0x57d1ee49c3df6f5Ea3000930068BF6059D2cA17B`
- coverage manager: `0x112e45DC9C29ff2FFd1b60fe3B4E408266E5E855`
- A2A clock adapter: `0x37ff4e43cAdA62871E927C5C64B2b9876d21cc62`
- relay verifier: `0x84CA17c573F90181ABFdf9Baca066F7A592e3525`

The controlled house pilot proves that the pre-audit wiring moved house funds through release and settlement. It does not validate the fixed source and does not authorize third-party capital.

## Findings

### H-01: Operator can create and settle unverified claims against provider bonds

Severity: High

Status: Unresolved

Release impact: Blocks third-party bonds and public enrollment

`CoverageManager` trusts the operator to supply every fact that determines custody:

- `issue` accepts the job ID, buyer, provider, job value, and acceptance time without proving them against the marketplace;
- `startClock` accepts a timestamp and opaque evidence hash;
- `release` accepts an opaque reason and can release an active covenant early;
- `markPayoutDue` accepts an opaque breach hash;
- `settleNetLoss` accepts recovery amounts and an opaque evidence hash.

A compromised or malicious operator can create synthetic job IDs against an enrolled provider, select an operator-controlled buyer, wait for the configured deadline, and slash the provider bond. For provider-funded SLA-credit policies, the payout can be the full covenant cap. Repeating this with unique synthetic job IDs can consume the provider's available bond. The cold owner can also appoint a replacement operator immediately, so cold-owner compromise reaches the same authority.

The fixed vault manager prevents bypassing `CoverageManager`, but it cannot make unverified manager inputs trustworthy.

Required remediation:

- bind issuance to authoritative task-acceptance evidence that proves job ID, buyer, provider, service, value, and acceptance time;
- bind release and breach transitions to authenticated adapter evidence, including historical delivery timing;
- derive escrow refunds and other recovery from independently verifiable settlement evidence rather than operator-supplied numbers;
- constrain emergency and role changes with a timelock, threshold multisig, or equivalent delayed control;
- define a dispute/challenge path before external provider capital is accepted.

### H-02: One job could receive multiple covenants across policy versions

Severity: High

Status: Fixed in source, not deployed

The original covenant identifier included `policyId`, `jobId`, and `buyer`, but no permanent job-level uniqueness guard existed. After a provider registered a new policy version, the same marketplace job could receive a second covenant and lock or pay twice.

An adversarial Foundry proof reproduced two independent covenants for one job on the baseline source. The fix adds `coveredJobCovenant[jobId]` and rejects every later issuance for that job, including attempts using a new policy version or a different buyer.

Regression: `testCannotCoverSameJobAcrossPolicyVersions`.

### M-01: Vault owner could replace the manager and bypass lifecycle invariants

Severity: Medium

Status: Fixed in source, not deployed

The baseline vault exposed `setManager`, allowing the owner to replace the manager immediately. A replacement address could call `lock`, `release`, and `slash` directly without satisfying `CoverageManager` lifecycle checks.

The fix replaces mutable manager updates with one-time `initializeManager`, prevents deposits before initialization, and updates deployment wiring and release-gate checks. The manager cannot be replaced after initialization.

This is defense in depth only; H-01 remains because the cold owner can still appoint a new `CoverageManager.operator`.

### M-02: Current A2A status could release a job delivered after its deadline

Severity: Medium

Status: Fixed in source, not deployed

The baseline adapter returned `Release` for every task status from 2 through 9. Statuses 2, 3, 4, and 6 describe delivery-like states but do not prove when delivery occurred. A job delivered after its SLA could therefore release the bond instead of remaining eligible for breach evaluation.

The fixed adapter holds statuses 2, 3, 4, and 6 until historical timing evidence is available. Only the documented recovery/terminal statuses 5, 7, 8, and 9 return `Release` from current status alone.

Regression: `testA2AClockHoldsDeliveryWithoutHistoricalTimingAndReleasesRecovery`.

### L-01: Relay signatures are not domain-separated by chain and verifier

Severity: Low

Status: Open

`RelayReceiptVerifier` verifies an Ethereum-signed arbitrary `receiptDigest` without adding the chain ID or verifier address. A signature can therefore verify on another deployment that reuses the signer and digest.

Current impact is limited because the runtime receipt digest contains request-specific data, the relay uses a dedicated signer, and the verifier is not itself an authorization path into `CoverageManager`. A future version should use EIP-712 or an equivalent digest bound to chain ID, verifier address, version, job, covenant, and nonce.

### I-01: Policy expiry is an enrollment cutoff, not a covenant deadline bound

Severity: Informational

Status: Documented

`isCoverable` requires a policy to be unexpired when issuance occurs, but an issued covenant may end after the policy expiry. Locked capital still backs that covenant. Public terms must describe expiry as the last issuance time, or the manager must require `deadline <= policy.expiresAt` if the intended meaning is different.

### I-02: External trust and availability dependencies remain

Severity: Informational

Status: Documented

- X Layer timestamps affect SLA and withdrawal boundaries.
- The canonical ERC-8004 identity registry is an externally controlled upgradeable proxy.
- OKX task-status semantics and historical task evidence are external dependencies.
- The configured USDt0 asset is trusted; fee-on-transfer behavior is rejected.
- The one-time vault manager improves custody isolation but makes manager migration impossible for deposited funds.

## Automated Analysis

Tooling used:

- Foundry `1.7.1`, Solidity `0.8.26`
- Slither `0.11.5`
- npm production dependency audit
- `detect-secrets 1.5.0`

Slither's v0.4-relevant warnings were reviewed manually:

- the `depositFor` balance/reentrancy warning is mitigated by `nonReentrant`, exact balance-delta validation, and rollback tests;
- the `CoverageManager.issue` warning crosses an immutable trusted vault whose `lock` path makes no external token call;
- event-after-call warnings revert atomically if the immutable vault reverts;
- timestamp checks are intentional protocol inputs;
- low-level ERC-20 calls support optional-return tokens and reject false returns and fee-on-transfer behavior;
- ECDSA assembly validates signature length, low `s`, recovery ID, and nonzero signer.

No tracked production credential was found. Secret-scan candidates in ignored `.env` and `.vercel` files were local configuration; tracked script hits were synthetic test constants or keyword matches.

## Verification Results

- `forge fmt --check`: pass
- `forge test --summary`: 64 passed, 0 failed
- `AgentPolicyRegistry` branch coverage: 100% (`23/23`)
- `ProviderBondVault` branch coverage: 100% (`29/29`)
- `CoverageManager` branch coverage: 96.43% (`27/28`)
- `OkxA2AClockAdapter` branch coverage: 100% (`6/6`)
- `RelayReceiptVerifier` branch coverage: 100% (`8/8`)
- npm production vulnerabilities: 0
- `npm run agent:gate-v04`: pass

The remaining uncovered manager branch is unreachable under the enforced invariant `enrollmentWindowSeconds <= slaSeconds`: an acceptance-clock deadline cannot already be elapsed while the shorter enrollment window is still open.

## Deployment Impact

Redeployment is required. The audit changes alter `ProviderBondVault`, `CoverageManager`, and `OkxA2AClockAdapter`; the registry is bound to the vault and the manager is bound to both, so the v0.4 stack must be redeployed and rewired rather than partially upgraded.

Do not redeploy merely to ship the three fixes. First close H-01, obtain an independent Solidity audit, rerun the complete release gate, deploy flag-off, verify bytecode and roles, and repeat a newly authorized bounded house pilot. The existing feature flag must remain off until all of those gates pass.
