#!/bin/zsh
# Exercise PolicyPool's unpaid A2MCP contract, not only its HEAD route.
set -u

PUBLIC_ORIGIN="${POLICYPOOL_PUBLIC_ORIGIN:-https://policypool.vercel.app}"
PUBLIC_PREFIX="${POLICYPOOL_PUBLIC_PATH_PREFIX:-}"
ENDPOINT="${POLICYPOOL_AGENT_ENDPOINT:-${PUBLIC_ORIGIN}${PUBLIC_PREFIX}/api/covered-job-receipt}"
LOG="${POLICYPOOL_KEEPWARM_LOG:-/Users/qdee/.okx-agent-task/logs/policypool-keepwarm.log}"
NODE_BIN="${POLICYPOOL_NODE_BIN:-}"

mkdir -p "$(dirname "$LOG")"

if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '%s FAIL node_executable_not_found\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "$LOG"
  exit 1
fi

result=$("$NODE_BIN" --input-type=module - "$ENDPOINT" <<'NODE' 2>&1
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const endpoint = new URL(process.argv[2]);
const requestImpl = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
const payload = "{}";
const started = Date.now();

const response = await new Promise((resolve, reject) => {
  const request = requestImpl(endpoint, {
    method: "POST",
    maxHeaderSize: 2_048,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  }, (incoming) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolve({
      statusCode: incoming.statusCode,
      statusMessage: incoming.statusMessage,
      headers: incoming.headers,
      rawHeaders: incoming.rawHeaders,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.setTimeout(30_000, () => request.destroy(new Error("probe_timeout")));
  request.once("error", reject);
  request.end(payload);
});

let headerBytes = Buffer.byteLength(
  `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n\r\n`,
);
for (let index = 0; index < response.rawHeaders.length; index += 2) {
  headerBytes += Buffer.byteLength(
    `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
  );
}
if (response.statusCode !== 402) throw new Error(`expected_402_got_${response.statusCode}`);
if (headerBytes >= 2_048) throw new Error(`header_block_${headerBytes}_bytes`);
const required = response.headers["payment-required"];
if (!required) throw new Error("missing_payment_required");
const challenge = JSON.parse(Buffer.from(required, "base64").toString("utf8"));
const body = JSON.parse(response.body);
const accepted = challenge.accepts?.[0];
if (challenge.x402Version !== 2) throw new Error("unexpected_x402_version");
if (accepted?.network !== "eip155:196") throw new Error("unexpected_network");
if (accepted?.amount !== "100000") throw new Error("unexpected_amount");
if (challenge.outputSchema) throw new Error("schema_leaked_into_header");
if (!body.outputSchema?.input) throw new Error("missing_body_input_schema");
if (JSON.stringify(body.accepts) !== JSON.stringify(challenge.accepts)) {
  throw new Error("body_header_requirements_mismatch");
}
console.log(`OK 402 ${((Date.now() - started) / 1_000).toFixed(3)}s payment_required_valid ${headerBytes}B`);
NODE
)
probe_status=$?

if [ "$probe_status" -ne 0 ]; then
  result="FAIL $(printf '%s' "$result" | tr '\n' ' ' | cut -c1-240)"
fi

printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$result" >> "$LOG"

if [ "$(wc -l < "$LOG")" -gt 2500 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit "$probe_status"
