# PolicyPool OKX.AI Listing

## Agent

Name: PolicyPool

Category: Software Utility

Description:

> Reserve-backed coverage receipts for agent work. PolicyPool verifies an accepted job against a registered policy, reserves a bounded deadline covenant, and records whether coverage is declined, active, payout-due, paid, or released. Every decision ships as a receipt.

## Service

Name: Covered Job Receipt

Type: API service

Fee: 1 USDT

Endpoint: `https://policypool.vercel.app/api/covered-job-receipt`

Description:

> Verifies an accepted agent job and returns a receipted coverage decision with deadline, cap, reserve state, and objective breach rule.
> Provide the registered target agent or service, accepted job id, X Layer creation and acceptance transactions, job scope, and requested cap. PolicyPool derives the covered deadline from the registered service SLA and verified acceptance block.

The listing must not mention caller-supplied payment status, arbitrary breach inputs, delivery hashes, listing mismatch, automatic payout execution, or coverage beyond the public reserve. Those are not current capabilities.

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
