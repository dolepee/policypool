# PolicyPool Agent Coverage

PolicyPool Agent Coverage is the OKX.AI-facing adapter for PolicyPool. It turns one accepted agent job into one bounded covenant decision.

## Service

- Name: Covered Job Receipt
- Price: 0.1 USDT
- Endpoint: `/api/covered-job-receipt`
- Listed provider: PolicyPool Agent `#4674`
- Active registered targets in v0.3: GlassDesk Agent `#3465` services `#30019`, `#30020`, and `#30021`; Foreman Agent `#4348` service `#33357`
- External provider opt-in: Warden Agent `#3808` service `#33461`; maximum cap `0.5 USDT`; coverage activation pending an independently verifiable funded-payload arrival timestamp
- Minimum requested coverage: 0.5 USDT. Smaller requests are declined by the free preflight before payment.

Input:

```json
{
  "targetAgent": "Foreman#4348",
  "targetJobId": "0x...",
  "targetCreationTxHash": "0x...",
  "targetAcceptanceTxHash": "0x...",
  "jobDescription": "Create a scoped readiness pack for a funded launch task.",
  "requestedCoverageUSDT": "1",
  "quoteId": "ppq_..."
}
```

`quoteId` is optional for legacy full-body clients. The free preflight returns a signed, short-lived quote in the paid URL, x402 accepted requirements, and canonical body. If OKX drops the replay body, PolicyPool can recover only when the verified payer has exactly one canonical open quote; zero or multiple matches fail without settlement.

The target job must still be in accepted state. PolicyPool verifies the creation and acceptance transactions against the public OKX task escrow and binds the buyer wallet, job ID, provider wallet, target agent ID, payment token, target-job value, service type, exact accepted-service hash, and acceptance timestamp. The coverage payer must be the target-job buyer.

The accepted-event service hash is preserved verbatim and checked for A2A/A2MCP consistency. OKX does not expose a documented public derivation from listed service ID to that hash, so listed-service-ID correspondence remains separate marketplace evidence rather than an onchain claim.

The caller does not choose the covered deadline. PolicyPool derives active-policy deadlines from the verified acceptance block plus the registered target-policy SLA: five minutes for Foreman and 24 hours for GlassDesk in v0.3. Each policy also has an earlier enrollment window; a quote or payment after that window fails without settlement. Warden opted into a five-minute processing SLA that begins only when a funded payload reaches its endpoint; because OKX acceptance does not prove that event, PolicyPool rejects Warden coverage before payment until an endpoint-arrival attestation adapter is available. A caller-supplied `deadline`, `dueAt`, or `expiresAt` is retained only as ignored context and cannot shorten or extend liability.

## Outcomes

- Pre-payment rejection: an unknown target returns `422 target_policy_not_registered`, charges nothing, and creates no receipt.
- `DECLINED` / blocked: no liability is created and no service payment settles. Reasons include unverifiable order, a closed enrollment window, an already-elapsed registered SLA, blocked scope, or insufficient uncommitted reserve.
- `ISSUED`: the service payment settled, the target order was verified, and the cap was atomically reserved in the durable ledger.
- `PAYOUT_DUE`: the reconciler observed that the accepted job was still undelivered after the stored deadline.
- `PAID`: a matching token transfer from the reserve wallet to the stored buyer was independently verified.
- `RELEASED`: the target job completed, was administratively stopped, closed, expired, or refunded without a covered payout.

Client-supplied policy objects, payment status, clocks, breach types, delivery hashes, listing-mismatch flags, and payout hashes are ignored.

## Solvency Rule

At issuance:

```text
active liability + pending liability + payout-due liability + requested cap <= live reserve balance
```

The cap is also bounded by target-job value and the configured per-covenant maximum. Redis scripting makes reservation and replay protection atomic across serverless requests.

## Objective Breach Rule

The current release has one breach rule:

```text
current time > (verified acceptance time + registered policy SLA) AND getJobStatus(targetJobId) == accepted
```

Subjective quality, listing outcomes, arbitrary delivery hashes, and buyer assertions are out of scope. Terminal marketplace refunds release reserve capacity rather than creating a second reimbursement.

## Payment Proof

The endpoint advertises X Layer USD₮0 with EIP-3009 domain name `USD₮0` and version `1`. A header being present is not payment. PolicyPool decodes the signed payload, matches its requirements, calls a configured verifier and settler, then reads the resulting token `Transfer` before returning success.

## Verification

```bash
npm run agent:gate
npm run agent:verify-live
```

The local gate covers malformed proofs, requirement substitution, payment replay, duplicate requests, target-evidence failure, reserve exhaustion, settlement rollback, deadline reconciliation, and payout verification. The live verifier is no-secret and spends no funds.

## Honest Scope

> The marketplace handles its own escrow and order lifecycle. PolicyPool adds a capped software warranty credit backed by a public X Layer reserve. It is not protocol-native escrow or insurance. Payout execution is operator-approved in v0.3, and paid status requires a verified onchain transfer.
