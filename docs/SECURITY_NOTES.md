# Security Notes

PolicyPool is a focused Hook submission, not a production risk engine. These notes define the v1 trust boundaries and the checks covered by the current test suite.

## Enforced In V1

- Only the configured Uniswap v4 `PoolManager` can call `beforeSwap`.
- The deployed Hook only advertises `BEFORE_SWAP_FLAG`.
- Exact-output swaps are refused.
- Exact-input swaps above `maxSwapAmount` are refused.
- Exact-input swaps that push `spentToday + amountIn` above `dailyCap` are refused.
- Accepted swaps increment `spentToday` before the swap continues.
- Accepted swaps emit `SwapAccepted(poolId, trader, amountIn)`.
- Refused swaps revert with `PolicyBlocked(reason, attempted, limit)`.

## V1 Trust Boundaries

- Policy ownership is owner-managed. The first address to call `setPolicy(poolId, ...)` becomes that pool's policy owner. The deployer EOA that won this race for the live pools is the address visible in each pool's `PolicySet` event on X Layer; `verify-deployment.mjs` and `verify-surge.mjs` log the resolved owner so judges can cross-reference it against the deployment tx history.
- Policy updates are immediate. In v1, updating a policy resets `spentToday` and `lastResetTimestamp`. Owners can therefore refresh the daily counter mid-window. This is documented as an owner-trusted behavior in v1; a production version should require timelocked changes or distinguish between cap-raises and counter-resets.
- The demo pools are initialized by the deployer for hackathon proof. A production version should bind policy ownership to a factory, governance process, or timelocked pool owner.
- Refused Hook logs do not persist after a revert. `PolicyPoolDemoRouter.swapOrRecord` catches the revert and emits `SwapBlockedCaught` so indexers can display the refusal. The Hook itself still enforces the block inside `beforeSwap`.
- Mock assets are used to isolate Hook behavior from liquidity and token-list risk.
- `PolicyPoolSurgeRouter.SurgeAccepted` is emitted for any `swapWithSurge` action, including calls with `surgeAmount = 0`. Indexers should filter by non-zero `surgeAmount` to count actual surge overrides; the `PoolManager.Donate` log is the canonical signal that a surge fee was paid.

## Not In Scope For V1

- Slippage covenants.
- Oracle checks.
- KYC or compliance lists.
- Per-LP policy aggregation.
- Dynamic fees.
- Production liquidity routing.
- Immutable policy commitments.

## Main Security Assumption

PolicyPool v1 assumes the pool policy owner is trusted to publish and maintain the covenant honestly. The live proof demonstrates Hook enforcement once the covenant is set; it does not claim decentralized governance over policy changes.

For the invariant-by-invariant test and live-proof map, see [HOOK_INVARIANTS.md](HOOK_INVARIANTS.md).

## V0.4 Provider-Funded Coverage

The pre-audit universal opt-in contracts are deployed flag-off on X Layer. Public enrollment and third-party bonds remain disabled. The deployed bytecode is superseded and must not be enabled.

See [INTERNAL_SOLIDITY_AUDIT_V04.md](INTERNAL_SOLIDITY_AUDIT_V04.md) for the full findings and release ruling. This internal review does not satisfy the independent Solidity audit gate.

### Single-operator finding remediated in source

The original manager let one hot operator choose the job, buyer, acceptance, release, breach, and recovery facts that controlled provider bonds. A compromised key could issue a synthetic covenant and slash a provider to an attacker-selected buyer.

The remediated source removes the manager owner/operator role and introduces `CoverageEvidenceVerifier`:

- issuance, relay-clock start, release, breach, and settlement require at least two EIP-712 evidence signatures;
- every signature is bound to chain ID, verifier, manager, action, and exact payload;
- evidence digests are single-use;
- signatures must be unique, authorized, and sorted by recovered address;
- any address may submit a valid quorum, but no relayer can authorize a transition alone;
- the signer set and threshold are immutable and have no owner bypass;
- recovery amounts are signed as part of settlement, so a relayer cannot reduce a known refund to inflate payout;
- every state-changing manager function has an explicit reentrancy guard.

The runtime sends the exact payload and underlying marketplace, transaction, relay, or recovery context to independently operated attesters. The attesters must recompute the manager digest themselves. The source fails closed if the evidence service is missing, ambiguous, malformed, or below threshold.

### Residual quorum trust boundary

This is a permissioned oracle model, not trustless verification. A colluding signer threshold can still attest false facts and slash a provider; unavailable signers can halt subjective lifecycle transitions. Operational separation is therefore part of the security model: no one operator, host, cloud account, or organization may control enough keys to satisfy the threshold.

The verifier is intentionally immutable. A signer loss or compromise requires a new verifier and manager deployment and an orderly migration after the old vault has no stranded obligations. The cold owner can manage the vault and registry monitor but cannot bypass the evidence verifier.

Third-party capital remains blocked until the remediated source receives independent review, signer independence is demonstrated, a qualified independent human audit is complete, a new stack is deployed and bytecode-verified, and fresh house pilots pass.

### Other fixes awaiting redeployment

- One marketplace job can receive only one covenant, across every policy version and buyer.
- The bond-vault manager is initialized once and cannot be replaced.
- A2A delivery-like statuses remain on hold until historical delivery timing is proven.
- Relay receipts use EIP-712 domain separation by chain ID and verifier address.

### Static analysis

Slither `0.11.5` analyzed 43 contracts with 101 detectors. It returned 26 raw results and no unclassified v0.4 manager/verifier custody bypass. Relevant warning dispositions are:

- `ProviderBondVault.depositFor` performs an external token call before crediting the bond. The function is protected by its `nonReentrant` guard, requires the exact vault balance delta, and rejects false-return and fee-on-transfer assets. A malicious callback test confirms re-entry fails and the outer deposit rolls back.
- `CoverageManager` calls immutable verifier and vault dependencies. Every state-changing entry point is `nonReentrant`, state is written before the vault call, and any dependency revert rolls back the full transaction.
- `CoverageEvidenceVerifier` loops over at most 16 signatures and rejects duplicate, unordered, unauthorized, malformed, high-`s`, and cross-domain attestations.
- Timestamp comparisons are intentional inputs to policy expiry, enrollment windows, withdrawal delay, SLA clocks, and objective breach eligibility. X Layer timestamp/sequencer integrity remains an external dependency.
- Low-level token calls support both boolean-return and no-return ERC-20 implementations. False returns, transfer failure, fee-on-transfer behavior, zero amounts, and outbound-transfer rollback are covered by adversarial tests.
- Inline assembly is limited to ECDSA recovery. Signature length, recovery ID, high-`s`, zero signer, wrong signer, ordering, threshold, expiry, nonce replay, and digest replay paths are covered.
- The canonical X Layer ERC-8004 registry is an external EIP-1967 proxy. Policy ownership checks inherit its upgrade and availability risk.
- The `arbitrary-send-erc20` and `unused-return` results are in the historical Uniswap v4 `CurrencySettlement` library, outside the v0.4 provider-bond path.
- Missing-inheritance results describe local view interfaces rather than runtime authorization gaps.

### Adversarial coverage gate

The remediated custody/state-transition suite contains 75 passing Foundry tests. Core branch coverage is:

- `AgentPolicyRegistry`: `100%` (`23/23`);
- `ProviderBondVault`: `100%` (`29/29`);
- `CoverageEvidenceVerifier`: `100%` (`13/13`);
- `CoverageManager`: `96.30%` (`26/27`);
- `OkxA2AClockAdapter`: `100%` (`6/6`);
- `RelayReceiptVerifier`: `100%` (`8/8`).

The remaining uncovered manager branch is unreachable under the enforced policy invariant `enrollmentWindowSeconds <= slaSeconds`: an A2A deadline cannot already be elapsed while its shorter enrollment window is still open.

These results verify the implemented source changes. They do not authorize public deposits, validate the old deployment, prove signer independence, or replace an independent audit.

## Future Hardening

- Factory-owned pool creation so policy ownership is bound at initialization.
- Optional timelock or freeze for policy updates.
- Event-indexed policy versions, so traders can verify which covenant version applied to each swap.
- Separate immutable pool class for teams that want covenants that cannot change after launch.
