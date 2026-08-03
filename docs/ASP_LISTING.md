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

> Checks an accepted agent job before charging, refuses ineligible coverage without charging, and issues a verifiable receipt with a bounded cap; deadlines derive only from verified clock evidence.
> Provide targetAgent, targetJobId, targetCreationTxHash, targetAcceptanceTxHash, and jobDescription. v0.4 needs targetServiceId; some policies also need targetTaskReference. Other fields optional.
> Check eligibility free at /api/coverage-preflight first; it never charges.

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
