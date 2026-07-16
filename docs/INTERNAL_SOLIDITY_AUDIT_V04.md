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
- a new six-contract stack is deployed flag-off and bytecode-verified;
- fresh house pilots prove release, full payout, and recovery-reduced payout.

## Scope

Original review baseline: `v0.4-universal-coverage` at `28c8d0e6832056b72e8d0021383b7d7a43a88448`.

Threshold-evidence remediation began from the already-hardened branch head `33d0037a3132a6562f1565c2509fc54cf2b44af8`.

Remediation scope:

- `src/ProviderBondVault.sol`
- `src/AgentPolicyRegistry.sol`
- `src/CoverageEvidenceVerifier.sol`
- `src/CoverageManager.sol`
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
- added immutable `CoverageEvidenceVerifier` with a minimum 2-of-N threshold and a 16-signer cap;
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

### L-01: Relay signatures lacked deployment domain separation

Severity: Low

Status: Fixed in source, not deployed

Relay receipts now use EIP-712 and bind chain ID plus verifier address. Reusing a receipt on another chain or verifier fails. Relay receipts still cannot move bonds without separate threshold evidence.

### O-01: Threshold oracle integrity and liveness

Severity: Operational deployment blocker; High if misconfigured

Status: Open by design

The source cryptographically requires a threshold, but security depends on the deployment placing signer keys in independent failure domains and requiring each signer to verify raw evidence. If one operator controls enough keys, the original H-01 risk reappears operationally. If too many signers are unavailable, subjective transitions halt.

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

## Automated Analysis

Tooling:

- Foundry `1.7.1`, Solidity `0.8.26`
- Slither `0.11.5`
- npm production dependency audit
- repository secret and diff gates

Relevant static-analysis dispositions:

- Slither analyzed 43 contracts with 101 detectors and returned 26 raw results. No manager/verifier custody bypass remained after the checks-effects-interactions cleanup.
- `ProviderBondVault.depositFor` is `nonReentrant`, verifies exact balance delta, and rejects false-return and fee-on-transfer assets. A malicious callback test confirms rollback.
- Manager calls cross immutable verifier/vault dependencies. Every state-changing manager entry point is `nonReentrant`, manager state is written before the vault call, and dependency failure reverts the complete transaction.
- Signature loops are bounded by `MAX_SIGNERS = 16`; ordering also prevents duplicate signer credit.
- Timestamp checks are intentional protocol inputs.
- Low-level token calls support optional-return tokens and reject false returns, transfer failure, and balance-delta mismatch.
- ECDSA recovery validates length, low `s`, recovery ID, nonzero signer, authorization, ordering, domain, and replay.
- `arbitrary-send-erc20` and `unused-return` findings belong to the historical Uniswap v4 `CurrencySettlement` library, outside the provider-bond path. Missing-inheritance findings describe local view interfaces.

No production credential is intentionally tracked. The local dirty `lib/v4-core` submodule is outside the remediation.

## Verification Results

- clean `forge test --summary`: 75 passed, 0 failed
- `AgentPolicyRegistry` branch coverage: 100% (`23/23`)
- `ProviderBondVault` branch coverage: 100% (`29/29`)
- `CoverageEvidenceVerifier` branch coverage: 100% (`13/13`)
- `CoverageManager` branch coverage: 96.30% (`26/27`)
- `OkxA2AClockAdapter` branch coverage: 100% (`6/6`)
- `RelayReceiptVerifier` branch coverage: 100% (`8/8`)
- `npm run agent:gate-v04`: pass
- npm production vulnerabilities: 0

The remaining manager branch is unreachable under `enrollmentWindowSeconds <= slaSeconds`: an acceptance-clock deadline cannot already be elapsed while its shorter enrollment window remains open.

The complete JavaScript/runtime/release gate and final Slither rerun passed on the candidate worktree. They must be rerun after any reviewer-requested source change. These results do not turn this document into an independent audit.

## Deployment Impact

Redeployment is required. The remediated manager constructor adds the evidence verifier, removes the operator model, changes every lifecycle ABI, and hardens relay domains. The old vault is permanently bound to its old manager, so the stack cannot be partially upgraded.

The next deployment must create six contracts flag-off: vault, registry, evidence verifier, manager, A2A adapter, and relay verifier. It must then verify bytecode and immutable wiring before any pilot.

No production endpoint, OKX listing, feature flag, scheduler, existing contract, or fund balance is changed by this source remediation.

## Next Review Questions

Claude and the qualified independent auditor should attempt to disprove:

1. that no single key, cold owner, relay signer, runtime relayer, or manager caller can authorize custody;
2. that signatures cannot replay across chain, verifier, manager, action, payload, or lifecycle call;
3. that underlying evidence is recomputed rather than trusted from the relayer;
4. that settlement recovery values and the fixed buyer cannot be substituted;
5. that reentrancy or malicious immutable dependencies cannot create a partial lifecycle state;
6. that the six-contract deployment and signer topology preserve the reviewed assumptions;
7. that a fresh recovery-reduced pilot pays only net loss on X Layer.
