import assert from "node:assert/strict";
import { preflightMessage, preflightValueRows } from "../web/coverage-site.js";

// The product site refused with a de-underscored error code for anything its
// local map had not seen. When OKX withdrew the public task evidence, a visitor
// pasting a task URL was told "okx task timeline unavailable" and nothing else,
// while /api/coverage-preflight was already returning an explicit message, a
// retryability flag, and a next action. The page must show the contract it is
// given rather than leaking the raw code.

const withdrawn = {
  ok: false,
  error: "okx_task_timeline_unavailable",
  code: "PUBLIC_TASK_EVIDENCE_UNAVAILABLE",
  message: "The public task page no longer publishes the acceptance timeline this quote is bound to.",
  retryable: false,
  nextAction: "No payment was taken and no task should be recreated. Resolve the target's on-chain evidence yourself and supply targetJobId, targetCreationTxHash, and targetAcceptanceTxHash directly to the paid endpoint, which does not read the public task page.",
};
const shown = preflightMessage(withdrawn);
assert.match(shown, /no longer publishes the acceptance timeline/, "the API's explanation must reach the reader");
assert.match(shown, /targetJobId/, "the actionable next step must reach the reader too");
assert.doesNotMatch(shown, /okx task timeline unavailable/, "the raw code must not be what a visitor sees");

// A curated local line stays authoritative where one exists, so existing
// wording that was written for this page is not silently replaced.
assert.equal(
  preflightMessage({
    ok: false,
    error: "requested_coverage_below_minimum",
    message: "The requested coverage cap is below the minimum this service will underwrite.",
    nextAction: "Request a higher coverage cap, bounded by the target job value.",
  }),
  "Request at least 0.5 USD₮0 of coverage. No payment was requested.",
);

// The API's generic placeholder carries no information, so it must never
// displace the local fallback.
for (const message of ["The request could not be completed.", "The request could not be completed right now."]) {
  assert.equal(
    preflightMessage({ ok: false, error: "some_unmapped_failure", message }),
    "some unmapped failure",
    "a generic API message must not be preferred over the local fallback",
  );
}

// Dropping the generic message must not drop its next action with it. On a
// throttled or service-side failure, describeFailure() pairs that placeholder
// with the only actionable part of the response, so a visitor would otherwise
// read nothing but the bare code.
assert.equal(
  preflightMessage({
    ok: false,
    error: "rate_limit_exceeded",
    message: "The request could not be completed right now.",
    retryable: true,
    retryAfterSeconds: 30,
    nextAction: "This request was throttled. Wait and retry the same request.",
  }),
  "rate limit exceeded This request was throttled. Wait and retry the same request.",
);
assert.equal(
  preflightMessage({
    ok: false,
    error: "coverage_quote_unavailable",
    message: "The request could not be completed right now.",
    retryable: true,
    retryAfterSeconds: 15,
    nextAction: "This is a service-side failure. Retry the same request; do not change the input.",
  }),
  "coverage quote unavailable This is a service-side failure. Retry the same request; do not change the input.",
);

// An ordinary no-charge decline is the common case and does not arrive as an
// error at all: preflight answers HTTP 200 with ok true, eligible false, and the
// code under `reason` rather than `error`. It carries the same contract, so it
// has to be read the same way.
const refinedDecline = preflightMessage({
  ok: true,
  eligible: false,
  charged: false,
  reason: "target_job_not_accepted:6",
  code: "TARGET_ALREADY_RESOLVED",
  message: 'The target job already reached "complete", so it can no longer be covered.',
  retryable: false,
  targetState: "complete",
  nextAction: "Purchase coverage while the target job is accepted and before it resolves.",
});
assert.match(refinedDecline, /already reached "complete"/, "a decline must explain itself, not print its code");
assert.match(refinedDecline, /Purchase coverage while the target job is accepted/);
assert.doesNotMatch(refinedDecline, /target job not accepted:6/, "the raw refined code must not reach a visitor");

assert.match(
  preflightMessage({
    ok: true,
    eligible: false,
    charged: false,
    reason: "insufficient_provider_bond_capacity",
    message: "The provider's first-loss bond cannot currently back this coverage cap.",
    retryable: true,
    nextAction: "Retry with a lower coverage cap, or retry later as covenants settle.",
  }),
  /first-loss bond cannot currently back this coverage cap.*lower coverage cap/,
  "a bond-capacity decline must state both the cause and the remedy",
);

// `error` still wins where both are present: a transport failure is the more
// specific fact about that particular response.
assert.match(
  preflightMessage({ error: "some_unmapped_failure", reason: "target_agent_required" }),
  /some unmapped failure/,
);

// An unclassified failure with no API message still degrades to the old
// behaviour rather than rendering undefined or an empty status line.
assert.equal(preflightMessage({ ok: false, error: "some_unmapped_failure" }), "some unmapped failure");
assert.equal(preflightMessage({}), "Coverage could not be verified.");
assert.equal(preflightMessage(null), "Coverage could not be verified.");

// A message with no next action is shown on its own rather than with a trailing
// space or the word undefined.
assert.equal(
  preflightMessage({ ok: false, error: "another_unmapped", message: "Something specific went wrong." }),
  "Something specific went wrong.",
);


// A direct-evidence quote carries no marketplace page, so `task` is null by
// design. The renderer read `data.task.title` unconditionally, which threw and
// took the whole result panel with it, leaving a buyer who had just quoted
// successfully with nothing to copy. Nothing outside a browser could catch that,
// so the row builder is pure and exported and the null shape is asserted here.
const directQuote = {
  ok: true,
  eligible: true,
  task: null,
  evidenceMode: "verified_onchain_evidence",
  scopeEvidence: "verified_accepted_service_binding",
  policy: { agentName: "Foreman", agentId: "4348" },
  coverage: {
    capUSDT: "0.5",
    serviceFeeUSDT: "0.1",
    deadline: "2026-07-25T18:00:00.000Z",
    enrollmentClosesAt: "2026-07-25T17:50:00.000Z",
    availableUSDT: "4.6",
    fundingSource: "shared_reserve",
  },
  quote: { expiresAt: "2026-07-25T17:50:00.000Z" },
  evidence: { creationTxHash: `0x${"c".repeat(64)}`, acceptanceTxHash: `0x${"d".repeat(64)}` },
  paidRequest: {
    body: {
      targetJobId: `0x${"7".repeat(64)}`,
      targetAcceptanceTxHash: `0x${"d".repeat(64)}`,
    },
  },
};

const directRows = preflightValueRows(directQuote);
const labels = directRows.map((row) => row.label);
assert.ok(!labels.includes("Task"), "a quote with no marketplace page must not claim a task row");
const targetJobRow = directRows.find((row) => row.label === "Target job");
assert.ok(targetJobRow, "a direct quote must still identify the covered job");
assert.match(targetJobRow.value, /^0x7+…7+$/, "the target job row must show the supplied job id, shortened");
assert.ok(
  directRows.some((row) => row.label === "Scope proved by"),
  "a direct quote must say scope came from the accepted-service binding, not a description",
);
// The public path keeps its task row exactly as before.
const publicRows = preflightValueRows({
  ...directQuote,
  task: { title: "Market evidence job", publicUrl: "https://www.okx.ai/tasks/401999" },
  scopeEvidence: "public_task_description_matched_registered_policy",
});
const publicTaskRow = publicRows.find((row) => row.label === "Task");
assert.equal(publicTaskRow.value, "Market evidence job");
assert.equal(publicTaskRow.href, "https://www.okx.ai/tasks/401999");
assert.ok(
  !publicRows.some((row) => row.label === "Scope proved by"),
  "the public path's scope note is only shown where scope came from the service binding",
);

console.log("PolicyPool site messaging verified: classified failures and ordinary declines reach the visitor, curated wording wins where it exists, and a quote with no marketplace page still renders its target job.");
