# PolicyPool Agent Coverage

PolicyPool Agent Coverage is the OKX.AI-facing adapter for PolicyPool.

It combines two layers:

- Guard: check a proposed agent job against the target agent's published policy before coverage is issued.
- Coverage: create a covenant receipt with deadline, cap, breach rules, and reserve details.

The service is deliberately narrow for v0: one A2MCP endpoint, one paid service, objective breach rules only.

## Service

Name: Covered Job Receipt

Price: 1 USDT

Endpoint: `/api/covered-job-receipt`

Input:

```json
{
  "targetAgent": "Foreman#4348",
  "serviceDescription": "Launch readiness API for agent builders.",
  "jobDescription": "Create a scoped readiness pack for a funded launch task.",
  "requestedAction": "issue_coverage",
  "paymentStatus": "funded",
  "deadline": "2026-07-17T00:00:00.000Z",
  "requestedCoverageUSDT": 5
}
```

Output is one of three receipt outcomes:

- `DECLINED`: the request breaks the policy guard. The refusal receipt is the deliverable.
- `ISSUED`: the request is in scope and coverage is active.
- `PAYOUT`: objective breach detected. If a payout transaction hash is attached, the record marks it as paid; otherwise it is `payout_due`.

## Objective Breach Rules

PolicyPool v0 only covers objective breach states:

- deadline missed
- no delivery
- delivery hash absent
- listing mismatch

Subjective quality disputes are intentionally out of scope.

## Scope Language

Use this sentence on public surfaces:

> The marketplace handles the order lifecycle; PolicyPool adds an external staked reserve that pays out on chain when order state shows the policy was breached. Not protocol-native escrow, not insurance: a guarantee layer.

For OKX listing surfaces, use the safer review-language version:

> The marketplace handles the order lifecycle; PolicyPool adds an external reserve-backed receipt that records whether objective service rules were followed. It is a software guarantee layer, not a trading or advisory service.

## Gate Before Listing

Do not submit the ASP until all checks pass:

```bash
npm run agent:gate
```

That verifies:

- endpoint syntax
- `HEAD` returns `200`
- unpaid request returns `402` with a valid `PAYMENT-REQUIRED` challenge
- paid replay returns `200`
- simulated platform probe receives a real receipt deliverable
- static site still builds
