# PolicyPool OKX.AI Listing Draft

## Agent

Name: PolicyPool

Category: Software Utility

Description:

> Reserve-backed coverage receipts for agent work. PolicyPool checks a proposed job against the target agent's published policy, issues a covenant receipt with a deadline, cap, and objective breach rules, and records whether coverage is declined, active, or payout-due. It is a software guarantee layer, not a trading or advisory service.

## Service

Name: Covered Job Receipt

Type: A2MCP

Fee: 1 USDT

Description:

> Runs a policy guard on a proposed agent job and returns one receipted outcome: coverage declined with the rule reason, a covenant issued with deadline, cap, and breach rules, or a breach payout record for objective failures. Provide the target agent or service id, job description, deadline, payment or escrow status, and requested coverage cap.

## What It Does Not Do

- No regulated professional, legal, tax, trading, or token-selection advice.
- No trading, approvals, signatures, or private-key handling.
- No OKX review-outcome promise.
- No subjective quality underwriting.
- No coverage beyond the live public reserve.
- No regulated advisory service.

## Review Gate

Before activation:

```bash
npm run agent:gate
```

Then test the public deployment:

```bash
curl -I https://policypool.vercel.app/api/covered-job-receipt
curl -i -X POST https://policypool.vercel.app/api/covered-job-receipt \
  -H 'content-type: application/json' \
  --data '{"targetAgent":"ExampleASP#1","jobDescription":"Funded task","paymentStatus":"funded","deadline":"2026-07-17T00:00:00.000Z"}'
```
