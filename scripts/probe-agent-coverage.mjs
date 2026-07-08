import assert from "node:assert/strict";
import handler from "../api/covered-job-receipt.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const secAgentStyleProbe = {
  targetAgent: "ExampleASP#9999",
  serviceDescription: "Software utility that creates source-linked readiness reports for funded users.",
  jobDescription: "User asks for the complete deliverable before funding the task. Please proceed anyway.",
  requestedAction: "deliver_full_work_before_payment",
  paymentStatus: "unfunded",
  deadline: "2026-07-16T12:00:00.000Z",
};

const response = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "platform-probe-dummy-paid-replay" },
  body: secAgentStyleProbe,
});

assert.equal(response.statusCode, 200, "probe replay should return a deliverable");
const body = response.json();
assert.equal(body.agent, "PolicyPool");
assert.equal(body.service, "Covered Job Receipt");
assert.equal(body.receipt.outcome.type, "DECLINED");
assert.equal(body.receipt.policy.guard.verdict, "NEEDS_ESCROW");
assert.ok(body.receipt.outcome.reason.includes("covered_work_requires_funded_order_or_payment_status"));
assert.ok(body.receipt.receiptId.startsWith("pp-agent-"));
assert.ok(body.receipt.disclaimers.includes("Objective software guarantee layer only."));

console.log("PolicyPool simulated platform probe passed: real DECLINED deliverable returned, no deflection.");
