# PolicyPool v0.4 Evidence Attester Runbook

## Scope

The v0.4 beta uses two separately deployed evidence-attestation services:

- `primary`: issue, start-clock, release, breach, settlement, unpaid cancellation, fee capture, and orphaned-fee refund.
- `recovery`: delayed emergency release, breach, settlement, and unpaid cancellation.

Each deployment is bound to one immutable verifier and one exact five-address signer set. The service returns the three signatures required by that verifier, ordered by recovered signer address.

This is a **house-operated beta topology**. It proves fail-closed evidence reconstruction and autonomous lifecycle execution for PolicyPool-sponsored capital. It does not prove independent signer failure domains. Third-party-funded provider bonds remain disabled until the signer sets are operated independently and the full topology receives external review.

## Independent checks

The attester does not sign a digest supplied by the relayer without reconstruction. For every request it:

1. verifies the chain, manager or fee escrow, verifier, action, and policy allowlist;
2. reads the manager's immutable verifier, registry, and vault wiring;
3. reads the exact on-chain five-signer set and 3-of-5 threshold;
4. reconstructs the action from raw context and canonical X Layer state;
5. asks the manager or fee escrow to recompute the evidence digest;
6. compares that digest with the requested digest; and
7. signs only after every check passes.

For direct A2MCP issuance, reconstruction includes both buyer-signed EIP-3009 authorizations, their unused on-chain nonce states, the raw provider request, provider challenge hash, synthetic job ID, acceptance evidence hash, fee nonce, fee ID, policy fingerprint, provider bond, cap, enrollment window, and active on-chain policy.

For relay-driven actions, the attester verifies the signed relay receipt, requires its request hash to equal the raw request already bound into the direct job and acceptance evidence, binds its canonical payment-authorization identity to the provider-authorization hash stored in PolicyFeeEscrow, and verifies the exact provider settlement transaction on X Layer. A valid receipt from an alternate or unbound provider request cannot authorize a lifecycle transition or fee capture. Settlement verification requires the matching USD₮0 `AuthorizationUsed` event to be immediately followed by that authorization's exact `Transfer`; another same-amount transfer elsewhere in a batched transaction cannot satisfy it. An unpaid cancellation is rejected while the policy fee is `Funded` or `Captured`; after refund or a never-funded attempt it reconstructs both original buyer authorizations and covenant bindings, verifies their USD₮0 nonce states against the fee record, and performs an independent provider-authorization settlement search before signing. If the fee nonce is consumed while the escrow record is still `None`, cancellation remains blocked until the primary quorum verifies the exact buyer-to-escrow authorization transaction and signs a fresh `refund_orphaned_fee` payload after the refund boundary. A timeout or relayer error is never accepted as proof of non-settlement.

## Deployment separation

Deploy `vercel.attester.json` twice as two separate Vercel projects. Do not add either service to the buyer-facing PolicyPool project.

Required environment values for each project:

```text
POLICYPOOL_ATTESTER_ROLE=primary|recovery
POLICYPOOL_ATTESTER_TOKEN=<distinct high-entropy bearer token>
POLICYPOOL_ATTESTER_PRIVATE_KEYS=<exact five-key set for this role>
POLICYPOOL_ATTESTER_ALLOWED_POLICY_IDS=<comma-separated beta policy IDs>
POLICYPOOL_COVERAGE_MANAGER_ADDRESS=
POLICYPOOL_POLICY_REGISTRY_ADDRESS=
POLICYPOOL_BOND_VAULT_ADDRESS=
POLICYPOOL_FEE_ESCROW_ADDRESS=
POLICYPOOL_EVIDENCE_VERIFIER_ADDRESS=
POLICYPOOL_RECOVERY_EVIDENCE_VERIFIER_ADDRESS=
POLICYPOOL_A2MCP_RELAY_ADAPTER_ADDRESS=
POLICYPOOL_RELAY_SIGNER_ADDRESS=
POLICYPOOL_PAYMENT_ASSET=
XLAYER_RPC_URL=
```

Use a distinct bearer token and signer set for each deployment. Never place a relayer, relay signer, owner, monitor, treasury, primary signer, or recovery signer in another role. Check all Vercel values for trailing newline contamination before testing.

The buyer-facing runtime receives only:

```text
POLICYPOOL_EVIDENCE_ATTESTATION_URL=<primary /api/attest URL>
POLICYPOOL_EVIDENCE_ATTESTATION_TOKEN=<primary bearer token>
POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_URL=<recovery /api/attest URL>
POLICYPOOL_RECOVERY_EVIDENCE_ATTESTATION_TOKEN=<recovery bearer token>
```

Executing direct-A2MCP records retain their encrypted recovery context for 45 days. This covers the 7-day maximum SLA, 30-day recovery-quorum delay, 24-hour settlement challenge, and an operational margin. Terminal records delete the recovery secret.

## Beta gates

Before a real external buyer:

1. deploy both attesters to isolated previews;
2. prove unauthorized, malformed, substituted, stale, wrong-policy, wrong-domain, and below-threshold requests fail closed;
3. run one house direct-A2MCP issue, fee fund, provider settlement, clock start, fee capture, and release;
4. run one funded-fee timeout where refund happens before cancellation and no settlement exists;
5. run one mixed fee-lifecycle drill where a normally funded fee remains accounted while a second fee is directly settled, the nonce-indexed orphan refund returns only the unaccounted fee before cancellation, and the funded fee then completes its normal refund path;
6. run a recovery-quorum drill without enabling public enrollment;
7. complete the 24-hour read-only reconciler soak; and
8. enroll Warden on the canonical eight-contract registry only after it signs a fresh registry-specific authorization.

Keep `POLICYPOOL_UNIVERSAL_ENABLED=false` and `POLICYPOOL_DIRECT_A2MCP_ENABLED=false` throughout preview validation. Production v0.3 stays unchanged until every beta gate passes.

## Incident rules

- If either attester is unavailable or uncertain, sign nothing and alert.
- If a policy, fingerprint, verifier, signer set, manager, escrow, relay signer, or settlement differs from configuration, sign nothing.
- Policy suspension blocks new issuance but must not block resolution of an existing covenant. Keep its policy ID allowlisted until every associated covenant is terminal.
- If a fee is funded, never sign `cancel_unpaid`; refund first after its on-chain refund window.
- If a fee nonce is consumed but its escrow record is `None`, verify and refund the exact direct settlement before signing `cancel_unpaid`; never treat surplus balance alone as payment evidence.
- If a provider settlement search is ambiguous or unavailable, sign nothing.
- If any signer key or bearer token is exposed, disable the affected service immediately. Verifier signer rotation requires a fresh contract deployment because signer sets are immutable.
