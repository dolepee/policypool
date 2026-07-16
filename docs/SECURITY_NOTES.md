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

The pre-audit universal opt-in contracts are deployed flag-off on X Layer. Public enrollment and third-party bonds remain disabled. The internal adversarial review found one unresolved High operator-evidence issue and three defects that were fixed only in source. The deployed bytecode is therefore superseded and must not be enabled.

See [INTERNAL_SOLIDITY_AUDIT_V04.md](INTERNAL_SOLIDITY_AUDIT_V04.md) for the full findings and release ruling. This internal review does not satisfy the independent Solidity audit gate.

### Blocking trust boundary

The hot operator currently supplies the job, buyer, acceptance time, breach evidence, recovery amounts, and release reason consumed by `CoverageManager`. Those values are not independently authenticated on-chain. A compromised operator can create synthetic covenants and slash an enrolled provider's bond to an operator-controlled buyer; the cold owner can reach the same authority by replacing the operator.

Third-party capital remains blocked until issuance, release, breach, and recovery are bound to authoritative evidence and privileged role changes are delayed or threshold-controlled.

### Audit fixes awaiting redeployment

- One marketplace job can receive only one covenant, across every policy version and buyer.
- The bond-vault manager is initialized once and cannot be replaced.
- A2A delivery-like statuses remain on hold until historical delivery timing is proven.

### Static analysis

Slither `0.11.5` was run against the hardened source on July 16, 2026. Its v0.4 findings and dispositions are:

- `ProviderBondVault.depositFor` performs an external token call before crediting the bond. The function is protected by its `nonReentrant` guard, requires the exact vault balance delta, and rejects false-return and fee-on-transfer assets. A malicious callback test confirms re-entry fails and the outer deposit rolls back.
- `CoverageManager.issue` calls the immutable bond vault before writing the covenant. The vault's `lock` path performs no external calls, the vault address is immutable, and a revert rolls back the job-level uniqueness claim.
- Event-after-call warnings apply only to the immutable bond vault's `lock`, `release`, and `slash` methods. State transitions occur before release and settlement calls, and a revert rolls back the complete transaction.
- Timestamp comparisons are intentional inputs to policy expiry, enrollment windows, withdrawal delay, SLA clocks, and objective breach eligibility. X Layer timestamp/sequencer integrity remains an external dependency.
- Low-level token calls support both boolean-return and no-return ERC-20 implementations. False returns, transfer failure, fee-on-transfer behavior, zero amounts, and outbound-transfer rollback are covered by adversarial tests.
- Inline assembly is limited to ECDSA recovery. Signature length, recovery id, high-`s`, zero-signer, wrong-signer, expiry, and nonce replay paths are covered.
- The canonical X Layer ERC-8004 registry is an external EIP-1967 proxy. Policy ownership checks inherit its upgrade and availability risk.

### Adversarial coverage gate

The hardened v0.4 custody/state-transition suite contains 64 passing Foundry tests. Core branch coverage is:

- `AgentPolicyRegistry`: `100%` (`23/23`);
- `ProviderBondVault`: `100%` (`29/29`);
- `CoverageManager`: `96.43%` (`27/28`);
- `OkxA2AClockAdapter`: `100%` (`6/6`);
- `RelayReceiptVerifier`: `100%` (`8/8`).

The remaining uncovered manager branch is unreachable under the enforced policy invariant `enrollmentWindowSeconds <= slaSeconds`: an A2A deadline cannot already be elapsed while its shorter enrollment window is still open.

These results verify the implemented fixes. They do not authorize public deposits, validate the pre-audit deployment, close the operator-evidence issue, or replace an independent audit.

## Future Hardening

- Factory-owned pool creation so policy ownership is bound at initialization.
- Optional timelock or freeze for policy updates.
- Event-indexed policy versions, so traders can verify which covenant version applied to each swap.
- Separate immutable pool class for teams that want covenants that cannot change after launch.
