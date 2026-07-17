import { Client } from "@upstash/qstash";

const token = process.env.QSTASH_TOKEN || "";
const operatorToken = process.env.POLICYPOOL_OPERATOR_TOKEN || "";
const destination = process.env.POLICYPOOL_UNIVERSAL_RECONCILE_URL
  || "https://policypool.vercel.app/api/reconcile-universal";

if (!token) throw new Error("QSTASH_TOKEN is required");
if (!operatorToken) throw new Error("POLICYPOOL_OPERATOR_TOKEN is required");
if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
  throw new Error("QStash signing keys must be configured before creating the schedule");
}

const client = new Client({ token });
const result = await client.schedules.create({
  destination,
  scheduleId: "policypool-universal-reconciler-v04",
  cron: "* * * * *",
  method: "GET",
  headers: { Authorization: `Bearer ${operatorToken}` },
  retries: 5,
  timeout: 30,
  label: ["policypool", "universal-reconciler", "v0.4"],
});

console.log(JSON.stringify({
  ok: true,
  scheduleId: result.scheduleId,
  destination,
  cron: "* * * * *",
  retries: 5,
}, null, 2));
