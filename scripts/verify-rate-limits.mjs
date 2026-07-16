import assert from "node:assert/strict";
import { MemoryRateLimiter, RateLimitError, requestRateLimitKey } from "../api/lib/rate-limit.js";

let now = Date.parse("2026-07-16T10:00:00.000Z");
const limiter = new MemoryRateLimiter({ now: () => now });
const input = { scope: "relay", key: "buyer", limit: 2, windowSeconds: 60 };
assert.equal((await limiter.check(input)).remaining, 1);
assert.equal((await limiter.check(input)).remaining, 0);
await assert.rejects(() => limiter.check(input), (error) => (
  error instanceof RateLimitError
  && error.code === "rate_limit_exceeded"
  && error.retryAfterSeconds === 60
));
now += 60_000;
assert.equal((await limiter.check(input)).remaining, 1);

const request = {
  headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" },
};
assert.equal(requestRateLimitKey(request, "Agent#1"), requestRateLimitKey(request, "agent#1"));
assert.notEqual(requestRateLimitKey(request, "agent#1"), requestRateLimitKey(request, "agent#2"));

console.log("PolicyPool rate limits passed: hashed request identity, bounded windows, retry timing, and reset behavior.");
