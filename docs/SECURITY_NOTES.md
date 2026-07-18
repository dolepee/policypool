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

- issuance, relay-clock start, release, breach, and settlement require an exact 3-of-5 EIP-712 evidence quorum;
- every signature is bound to chain ID, verifier, manager, action, and exact payload;
- evidence digests are single-use;
- signatures must be unique, authorized, and sorted by recovered address;
- any address may submit a valid quorum, but no relayer can authorize a transition alone;
- the signer set and threshold are immutable and have no owner bypass;
- a second disjoint 3-of-5 quorum is the only emergency authority and cannot act until 30 days after the original deadline;
- recovery amounts are signed as part of settlement, so a relayer cannot reduce a known refund to inflate payout;
- every state-changing manager function has an explicit reentrancy guard.

The runtime sends the exact payload and underlying marketplace, transaction, relay, or recovery context to independently operated attesters. The attesters must recompute the manager digest themselves. The source fails closed if the evidence service is missing, ambiguous, malformed, or below threshold.

### Residual quorum trust boundary

This is a permissioned oracle model, not trustless verification. A colluding signer threshold can still attest false facts and slash a provider. Operational separation is therefore part of the security model: no one operator, host, cloud account, or organization may control enough keys to satisfy either threshold.

Both verifiers are intentionally immutable. A disjoint recovery quorum limits primary-quorum liveness failure, but if both evidence quorums lose threshold availability an unresolved bond can still remain locked. Signer replacement requires a new verifier and manager deployment after all old obligations are resolved. The cold owner can manage the vault and registry monitor but cannot bypass either evidence verifier.

Third-party capital remains blocked until the remediated source receives independent review, signer independence is demonstrated, a qualified independent human audit is complete, a new stack is deployed and bytecode-verified, and fresh house pilots pass.

### Other fixes awaiting redeployment

- One marketplace job can receive only one covenant, across every policy version and buyer.
- The bond-vault manager is initialized once and cannot be replaced.
- A2A delivery-like statuses remain on hold until historical delivery timing is proven.
- Relay receipts use EIP-712 domain separation by chain ID and verifier address.

### Hostile freshness, ordering, and liveness findings remediated in source

- A stale recovery observation can no longer be held and broadcast after a later marketplace refund. Settlement requires a signed terminal-recovery flag, a nonzero evidence hash, and an observation no more than ten minutes old.
- Release binds the authoritative completion timestamp and rejects completion after the covenant deadline. The contract stores that timestamp for later inspection.
- A breach is provisional for 24 hours measured from the mined `PayoutDue` transition, not from a potentially held observation. During that challenge period, quorum-attested proof of an on-time completion can move `PayoutDue` to `Released`; neither the primary nor emergency settlement path can win by transaction ordering alone.
- Loss of the primary quorum no longer makes resolution impossible by itself. A contract-enforced, signer-disjoint recovery quorum may release, breach, or settle after 30 days.
- The manager requires exactly five signers and threshold three in each verifier and rejects any signer overlap between the primary and recovery quorums. Deployment scripts repeat these checks, reject role reuse and noncanonical X Layer parameters before broadcast, and the release gate verifies them.

Residual: terminal recovery and completion time are facts attested by permissioned quorums, not facts derived directly from OKX contracts. Threshold collusion remains capable of false attestation. If both quorums become unavailable, no privileged reclaim path exists because any deterministic unilateral recipient would sacrifice either the buyer or provider.

### Provider-relay payment and network findings remediated in source

GitHub Codex found six High/P1 runtime paths after the Solidity review:

- Header presence could start an unpaid relay clock. The relay treated any nonempty payment header followed by a non-402 provider response as funded, so a fabricated header could create clock evidence without a provider payment.
- DNS rebinding could bypass the provider relay SSRF check. The relay validated one DNS lookup but let the later fetch resolve the hostname again, allowing the checked public address and connected private address to differ.
- A valid provider payment was not required to come from the buyer bound into the relay grant, so another wallet could start the clock while any breach payout still belonged to the original buyer.
- An unpaid receipt could replace the per-job pointer to an earlier payment-verified receipt, causing reconciliation to lose the valid clock or delivery result.
- The relay consumed grant and payment claims before signing and persisting the verified receipt, so a later signing or Redis failure could permanently leave a paid provider call without reconciliation evidence.
- A consumed grant claim expired after 24 hours even though a valid relay grant can remain usable longer, allowing a fresh payment to reuse the grant and replace the clock after the claim expired.

Source remediation:

- the relay decodes exact x402 v2 requirements and requires the live listed service price, enrolled provider wallet, X Layer USD₮0 asset, and authentic token domain;
- the buyer's EIP-3009 authorization fields and signature are verified before forwarding;
- the verified authorization payer must equal the HMAC-signed relay-grant buyer before any reservation or provider request;
- a successful provider response must carry settlement metadata whose X Layer transaction proves both the exact USD₮0 `Transfer` and matching `AuthorizationUsed` nonce;
- the signed authorization is permanently consumed, independently of the short-lived one-use relay grant, so an old payment cannot start another covenant clock;
- missing or invalid settlement proof releases only the pending reservations and creates no clock;
- all signed relay receipts remain available by receipt ID, but the per-job reconciliation pointer advances only for receipts carrying a payment-verified clock and settlement transaction;
- a verified paid receipt, its per-job pointer, and both consumed claims commit in one Redis Lua transaction only after the receipt is signed;
- relay-grant issuance rejects lifetimes beyond the seven-day maximum SLA;
- failed commits leave only short-lived pending reservations, while successful grant claims remain consumed through the signed grant expiry plus a safety margin and payment claims remain durable;
- all resolved provider addresses must be public, and the HTTPS connection uses a pinned checked address while preserving the original hostname for SNI, certificate verification, and `Host`;
- redirects remain disabled and request, response, and timeout limits remain enforced.

Regression: `npm run agent:verify-relay` rejects malformed headers, wrong amounts, wrong signers, a valid payment from the wrong buyer, absent settlement evidence, authorization replay under a fresh grant, private DNS, and unpinned connection metadata. It proves that a later unpaid receipt cannot replace the payment-verified job pointer, a failure before atomic commit can retry, a lost response after atomic commit cannot lose or duplicate the provider call, and a consumed grant remains blocked beyond the former 24-hour TTL. Only the grant-bound buyer's signature-valid, nonce-bound, on-chain-verified provider payment creates or replaces a relay clock.

### Enrollment confirmation terms binding remediated in source

The registration event identifies the provider, service, fingerprint, version, and policy ID, but it does not emit every signed policy field. Confirming from that event alone could activate a pending enrollment against a different latest policy registration for the same service and fingerprint while the off-chain resolver continued serving the originally signed terms.

Confirmation now reads the exact policy struct back from the registry by the emitted policy ID, checks its metadata, recomputes the complete policy-terms hash, and requires equality with the provider-signed enrollment hash before activation. The binding covers scope, cap, SLA, enrollment window, payout basis, clock mode, expiry, and adapter as well as service identity. `npm run agent:verify-enrollment` proves an otherwise matching event with altered payout economics remains pending and fails with `policy_registered_terms_mismatch`.

### Universal lifecycle findings remediated in source

GitHub Codex found two additional High/P1 lifecycle gaps:

- payout-due covenants had no operational settlement path, so a valid breach could hold buyer and provider funds indefinitely even after the challenge and terminal recovery checks were satisfiable;
- a failed coverage-fee settlement could strand provider bond because compensation reused the delivery-release action with a post-deadline timestamp.

Source remediation keeps the evidence meanings separate:

- the scheduled reconciler now settles only after the on-chain 24-hour challenge and independently attestable terminal recovery; nonterminal or ambiguous recovery remains on hold;
- v0.4 A2A issuance requires a public task reference so terminal status, historical timing, and refund evidence can be re-derived;
- issue evidence binds the exact x402 fee authorization and its expiry;
- failed or unconfirmed coverage-fee settlement queues compensation rather than claiming provider delivery;
- an uncertain issuance broadcast retains its planned covenant ID and cannot be discarded until the fee authorization expires and chain state proves no covenant exists;
- after authorization expiry, a fresh quorum attestation that the authorization remains unused may call `cancelUnpaid`, release the bond, and clear only the unpaid job lock;
- cancellation evidence expires after ten minutes, and the recovery quorum path remains delayed 30 days.

Residual: fee non-settlement and terminal marketplace recovery are permissioned-oracle facts. Attesters must query the chain and OKX evidence directly. A settlement timeout or relayer error is never sufficient evidence by itself.

### A2A provider-bonded SLA-credit settlement remediated in source

An A2A policy using `provider_bonded_sla_credit` could enter `PayoutDue` after a verified late delivery but remain locked because the reconciler required marketplace refund status `7` or `9`. That requirement belongs to net-loss coverage, not to a provider-funded deadline credit whose payout is independent of refund.

The reconciler now settles the SLA-credit path only after the on-chain challenge period and only from a fresh, non-stale public OKX task observation that still proves the objective deadline breach. It supplies the full task and observed timing to the evidence quorum, uses zero marketplace recovery inputs, and preserves terminal-recovery requirements for every net-loss policy. A late-delivered net-loss covenant remains on hold until marketplace recovery is terminal.

### Relay receipt covenant binding remediated in source

Verified relay receipts were indexed by target job, but reconciliation did not prove the selected receipt belonged to the current covenant and grant. After an unpaid covenant cancellation cleared the on-chain job lock, an old receipt for that job could otherwise start or resolve a replacement covenant.

Every signed relay receipt now includes the grant's covenant ID. Its durable atomic commit writes both the diagnostic job index and an exact covenant index. Reconciliation reads only the covenant index, verifies the receipt signature, and requires exact grant, covenant, job, agent, service, and grant-buyer/payment-payer equality before using any clock or delivery evidence. A prior receipt for the same job remains auditable but cannot drive a replacement covenant.

### Direct A2MCP checkout and refundable fee escrow

OKX Task Marketplace is an A2A accept/deliver transport and is not used for A2MCP services. `/api/direct-a2mcp` performs direct HTTP+x402 checkout through three fail-closed stages: probe and quote, provider authorization, then separate refundable PolicyPool fee authorization. The canonical provider request and x402 challenge are hashed into the quote; the buyer, policy, service fingerprint, endpoint, amount, provider destination, both nonces, and both authorization windows cannot change between stages.

The ownerless `PolicyFeeEscrow` receives the PolicyPool fee before the provider call but cannot send it to the treasury until the provider settlement and clock are quorum-attested. If no provider settlement exists after authorization expiry, the covenant is quorum-cancelled and only the buyer can refund the fee. The escrow has no sweep or alternate recipient and verifies exact balance deltas.

Provider execution is at most once. The paid response body and signed relay receipt persist in one atomic commit. Recovery first checks that durable record, then performs a bounded on-chain search for the exact indexed EIP-3009 nonce and USD₮0 transfer. A proven settlement with no durable response creates a safety hold: PolicyPool does not call the provider again and does not infer a provider breach from its own response-loss failure. If the PolicyPool fee was already refunded before a delayed settlement is recovered, coverage still follows the settled provider job while no second provider call or fee capture occurs.

The settlement scan overlaps its timestamp-derived lower bound by one block so a grant timestamp slightly ahead of the chain clock cannot hide a payment in the boundary block. This overlap is safe because recovery still requires the exact authorization payer and nonce plus the exact asset, recipient, amount, and transfer receipt.

Provider and PolicyPool-fee payment identities are derived from canonical signed EIP-3009 fields rather than encoded x402 headers. Equivalent JSON or base64 encodings therefore share one durable provider claim, one direct job, and one execution identity. The direct quote ID remains acceptance provenance but cannot make an already-signed provider authorization payable again.

The direct scheduler is authenticated independently from the buyer route. It can relay only quorum-attested lifecycle actions and uses durable quote indexes rather than accepting caller-selected job or payment evidence. Ambiguous or conflicting states remain visible as holds instead of being guessed into release, cancellation, or payout.

Direct reconciliation no longer depends on manually creating the QStash schedule. QStash remains the one-minute primary, while the checked-in five-minute GitHub workflow discovers whether the direct route is enabled and invokes it through an `always()`-isolated step. Both paths use the operator bearer token; scheduled QStash calls additionally carry its platform signature.

Reconciliation reads a dedicated execution-only queue rather than the newest general quotes. Claim, completion, and reversible release update that queue atomically. Every inspected live execution moves behind records not yet inspected, including when it remains on hold or an attempt fails, so probe traffic and persistent holds cannot starve an older covenant. Expired or terminal index members are removed without being treated as lifecycle evidence.

The canonical provider request and original provider x402 authorization needed for unattended chain recovery are retained only as an AES-256-GCM envelope. Its key is domain-separated from the direct quote secret, its authenticated data binds quote and execution IDs, substitution fails closed, and terminal direct records discard it. The reconciler decrypts it only to call the same policy-, grant-, payer-, request-, and nonce-validated relay recovery path used by an exact buyer retry.

An authorized request becomes uncertain once dispatch begins. A timeout, lost response, missing settlement proof, or failed durable commit keeps the one-shot grant/payment reservation through the bounded recovery window; only a definitely unpaid `402` permits immediate release. If chain recovery proves payment but the provider response was not durable, PolicyPool starts the verified settlement clock and resolves fee custody but holds delivery judgment for manual evidence. It never calls the provider twice and never turns PolicyPool response loss into an automatic provider breach.

Completed direct results remain retrievable for the execution-retention window after their payment authorizations expire, but only with the exact original provider request and both bound payment signatures. The store rechecks the execution ID derived from both payment headers before returning a terminal result. Expiry tolerance never applies to a new or merely bound execution.

Direct A2MCP policies use a fixed escrow fee derived from the enrolled policy cap. Checkout therefore covers exactly that cap: omitting the amount selects it, while a different amount is declined before either payment authorization. Partial-cap pricing requires a future variable-fee escrow and is not emulated by overcharging.

Residual: a direct fee may time out and refund after a provider settlement if PolicyPool loses both the immediate transition and scheduled capture long enough. This loses PolicyPool's fee but does not remove buyer coverage or debit the provider twice. A settlement whose response bytes were never durable cannot automatically prove timely completion; it requires manual evidence resolution without slashing the provider for PolicyPool infrastructure loss.

### Static analysis

Slither `0.11.5` analyzed 47 contracts with 101 detectors. It returned 44 raw results and no unclassified v0.4 manager, verifier, vault, or fee-escrow custody bypass. Relevant warning dispositions are:

- `ProviderBondVault.depositFor` performs an external token call before crediting the bond. The function is protected by its `nonReentrant` guard, requires the exact vault balance delta, and rejects false-return and fee-on-transfer assets. A malicious callback test confirms re-entry fails and the outer deposit rolls back.
- `PolicyFeeEscrow.fund` performs the buyer-authorized token call before recording the fee. Its `nonReentrant` guard blocks an authorization-token callback, the exact inbound delta is required, and any callback, tax, or token failure rolls back the authorization and state. Capture and refund write terminal state before an exact-delta outbound transfer.
- `CoverageManager` calls immutable verifier and vault dependencies. Every state-changing entry point is `nonReentrant`, state is written before the vault call, and any dependency revert rolls back the full transaction.
- `CoverageEvidenceVerifier` loops over at most 16 signatures and rejects duplicate, unordered, unauthorized, malformed, high-`s`, and cross-domain attestations.
- `CoverageManager` validates exact 3-of-5 primary/recovery topology with bounded constructor-time calls to immutable verifier contracts. It fails deployment closed on any dependency revert, topology drift, or overlap.
- Timestamp comparisons are intentional inputs to policy expiry, enrollment windows, withdrawal delay, SLA clocks, and objective breach eligibility. X Layer timestamp/sequencer integrity remains an external dependency.
- Low-level token calls support both boolean-return and no-return ERC-20 implementations. False returns, transfer failure, fee-on-transfer behavior, zero amounts, and outbound-transfer rollback are covered by adversarial tests.
- Inline assembly is limited to ECDSA recovery. Signature length, recovery ID, high-`s`, zero signer, wrong signer, ordering, threshold, expiry, nonce replay, and digest replay paths are covered.
- The canonical X Layer ERC-8004 registry is an external EIP-1967 proxy. Policy ownership checks inherit its upgrade and availability risk.
- The `arbitrary-send-erc20` and `unused-return` results are in the historical Uniswap v4 `CurrencySettlement` library, outside the v0.4 provider-bond path.
- Missing-inheritance results describe local view interfaces rather than runtime authorization gaps.

### Adversarial coverage gate

The remediated custody/state-transition suite passes 116 Foundry tests and includes executable hostile regressions for stale settlement, held breach evidence, terminal recovery, late completion, provisional-breach correction, primary and emergency challenge-period ordering, quorum separation, delayed recovery, exact outbound token transfers, primary and recovery-quorum expired-unused fee cancellation, uncertain issuance reconciliation, and the direct refundable fee escrow.

- `AgentPolicyRegistry`: `100%` (`23/23`);
- `ProviderBondVault`: `100%` (`30/30`);
- `CoverageEvidenceVerifier`: `100%` (`13/13`);
- `CoverageManager`: `93.33%` (`42/45`);
- `OkxA2AClockAdapter`: `100%` (`6/6`);
- `RelayReceiptVerifier`: `100%` (`8/8`).
- `PolicyFeeEscrow`: `91.30%` (`21/23`).

The three reported uncovered manager branches are defensive paths: Foundry does not attribute the explicit reentrancy regression to the guard branch, an A2A deadline cannot already be elapsed while its shorter enrollment window remains open under `enrollmentWindowSeconds <= slaSeconds`, and an `Active` or `PayoutDue` covenant cannot enter emergency resolution with an unset deadline.

These results verify the implemented source changes. They do not authorize public deposits, validate the old deployment, prove signer independence, or replace an independent audit.

## Future Hardening

- Factory-owned pool creation so policy ownership is bound at initialization.
- Optional timelock or freeze for policy updates.
- Event-indexed policy versions, so traders can verify which covenant version applied to each swap.
- Separate immutable pool class for teams that want covenants that cannot change after launch.
