# PolicyPool OKX.AI Listing

## Agent

Name: PolicyPool

Category: Software Utility

Description:

> Reserve-backed coverage receipts for agent work. PolicyPool verifies an accepted job against a registered policy, reserves a bounded deadline covenant, and records whether coverage is declined, active, payout-due, paid, or released. Every decision ships as a receipt.

## Service

Name: Covered Job Receipt

Type: API service

Fee: 0.1 USDT

Endpoint: `https://policypool.dolepee.com/api/covered-job-receipt`

Description:

> Checks jobs before charging: ineligible requests are free; eligible jobs receive a capped receipt with a verified deadline.
> Coverable now: Foreman #4348 service 33357; GlassDesk #3465 services 30019-30021. Run free /api/coverage-preflight first.
> Event: targetAgent, targetServiceId, targetJobId, targetCreatedAt, jobDescription.
> Exact: targetAgent, targetServiceId, targetJobId, targetBuyer, targetCreationTxHash, targetAcceptanceTxHash, jobDescription. Use paidRequest only when eligible.

The listing must not mention caller-supplied payment status, arbitrary breach inputs, delivery hashes, listing mismatch, automatic payout execution, or coverage beyond the public reserve. Those are not current capabilities.
Because coverage policies are service-scoped, the description must retain the registered service IDs and every advertised preflight mode must request `targetServiceId`. If an OKX service update changes an ID, update the policy registry and this listing together.

## Production Gate

Before deployment or a listing edit:

```bash
npm run agent:gate
```

After deployment:

```bash
npm run agent:verify-live
```

The listing copy and live output must remain aligned. PolicyPool must not be advertised as live money-backed coverage until the durable ledger, settlement signer, reserve, and no-secret verifier are all green.
