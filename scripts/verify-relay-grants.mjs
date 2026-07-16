import assert from "node:assert/strict";
import { createRelayGrantService, RelayGrantError } from "../api/lib/relay-grant.js";

let now = Date.parse("2026-07-16T12:00:00.000Z");
const service = createRelayGrantService({
  secret: "relay-grant-test-secret-with-more-than-thirty-two-bytes",
  now: () => now,
});
const issued = service.issue({
  covenantId: `0x${"11".repeat(32)}`,
  targetJobId: `0x${"22".repeat(32)}`,
  buyer: "0x3000000000000000000000000000000000000003",
  agentId: "3808",
  serviceId: "33461",
  expiresAt: "2026-07-16T12:01:00.000Z",
});
assert.equal(service.resolve(issued.token).grantId, issued.payload.grantId);
assert.throws(
  () => service.issue({
    covenantId: `0x${"11".repeat(32)}`,
    targetJobId: `0x${"22".repeat(32)}`,
    buyer: "0x3000000000000000000000000000000000000003",
    agentId: "3808",
    serviceId: "33461",
    expiresAt: "2026-07-23T12:00:01.000Z",
  }),
  (error) => error instanceof RelayGrantError && error.code === "relay_grant_expiry_invalid",
);
const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
assert.throws(() => service.resolve(tampered), (error) => error instanceof RelayGrantError);
now += 61_000;
assert.throws(
  () => service.resolve(issued.token),
  (error) => error instanceof RelayGrantError && error.code === "relay_grant_expired",
);

console.log("PolicyPool relay grants passed: covenant/job/provider binding, HMAC tamper rejection, bounded lifetime, and hard expiry.");
