import assert from "node:assert/strict";
import { preflightMessage } from "../web/coverage-site.js";

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

console.log("PolicyPool site failure messaging verified: classified API failures reach the visitor, curated wording wins where it exists, and unclassified failures still degrade safely.");
