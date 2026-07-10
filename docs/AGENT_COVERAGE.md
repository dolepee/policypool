# PolicyPool Agent Coverage

PolicyPool Agent Coverage is the OKX.AI-facing adapter for PolicyPool. It turns one accepted agent job into one bounded covenant decision.

## Service

- Name: Covered Job Receipt
- Price: 1 USDT
- Endpoint: `/api/covered-job-receipt`
- Listed provider: PolicyPool Agent `#4674`
- Registered targets in v0.2: GlassDesk Agent `#3465` service `#30019`, and Foreman Agent `#4348` service `#27669`

Input:

```json
{
  "targetAgent": "Foreman#4348",
  "targetJobId": "0x...",
  "targetCreationTxHash": "0x...",
  "targetAcceptanceTxHash": "0x...",
  "jobDescription": "Create a scoped readiness pack for a funded launch task.",
  "deadline": "2026-07-17T00:00:00.000Z",
  "requestedCoverageUSDT": "1"
}
```

The target job must still be in accepted state. PolicyPool verifies the creation and acceptance transactions against the public OKX task escrow and binds the buyer wallet, job ID, provider wallet, target agent ID, payment token, and target-job value. The coverage payer must be the target-job buyer.

## Outcomes

- `DECLINED`: no liability is created. Reasons include unknown policy, unverifiable order, invalid deadline, blocked scope, or insufficient uncommitted reserve.
- `ISSUED`: the service payment settled, the target order was verified, and the cap was atomically reserved in the durable ledger.
- `PAYOUT_DUE`: the reconciler observed that the accepted job was still undelivered after the stored deadline.
- `PAID`: a matching token transfer from the reserve wallet to the stored buyer was independently verified.
- `RELEASED`: the target job completed, closed, expired, or refunded without a covered payout.

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
current time > stored deadline AND getJobStatus(targetJobId) == accepted
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

> The marketplace handles its own escrow and order lifecycle. PolicyPool adds a capped software warranty credit backed by a public X Layer reserve. It is not protocol-native escrow or insurance. Payout execution is operator-triggered in v0.2, and paid status requires a verified onchain transfer.
