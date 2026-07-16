import { Redis } from "@upstash/redis";
import { header, sha256 } from "./utils.js";

export class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super("rate_limit_exceeded");
    this.name = "RateLimitError";
    this.code = "rate_limit_exceeded";
    this.status = 429;
    this.retryAfterSeconds = Math.max(1, Number(retryAfterSeconds) || 1);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function requestRateLimitKey(req, subject = "") {
  const forwarded = header(req, "x-forwarded-for").split(",")[0].trim();
  const address = forwarded || header(req, "x-real-ip") || req.socket?.remoteAddress || "unknown";
  return sha256(`${address.toLowerCase()}|${String(subject || "").toLowerCase()}`).slice(0, 32);
}

export class MemoryRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windows = new Map();
  }

  async check({ scope, key, limit, windowSeconds }) {
    const maximum = positiveInteger(limit, 20);
    const duration = positiveInteger(windowSeconds, 60);
    const id = `${scope}:${key}`;
    const now = this.now();
    let window = this.windows.get(id);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + duration * 1_000 };
      this.windows.set(id, window);
    }
    window.count += 1;
    if (window.count > maximum) throw new RateLimitError(Math.ceil((window.resetAt - now) / 1_000));
    return {
      limit: maximum,
      remaining: Math.max(0, maximum - window.count),
      resetAt: new Date(window.resetAt).toISOString(),
    };
  }
}

export class RedisRateLimiter {
  constructor({ redis, prefix = "pp:rate:v04", now = () => Date.now() } = {}) {
    this.redis = redis || Redis.fromEnv();
    this.prefix = String(prefix).replace(/:+$/, "");
    this.now = now;
  }

  async check({ scope, key, limit, windowSeconds }) {
    const maximum = positiveInteger(limit, 20);
    const duration = positiveInteger(windowSeconds, 60);
    const bucket = Math.floor(this.now() / (duration * 1_000));
    const redisKey = `${this.prefix}:${scope}:${key}:${bucket}`;
    const count = Number(await this.redis.incr(redisKey));
    if (count === 1) await this.redis.expire(redisKey, duration + 2);
    if (count > maximum) throw new RateLimitError(duration);
    return {
      limit: maximum,
      remaining: Math.max(0, maximum - count),
      resetAt: new Date((bucket + 1) * duration * 1_000).toISOString(),
    };
  }
}

export function createRateLimiter() {
  const hasRedis = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
      || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
  if (!hasRedis) return new MemoryRateLimiter();
  if (!process.env.UPSTASH_REDIS_REST_URL && process.env.KV_REST_API_URL) {
    process.env.UPSTASH_REDIS_REST_URL = process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = process.env.KV_REST_API_TOKEN;
  }
  return new RedisRateLimiter();
}

export async function enforceRateLimit(req, res, limiter, {
  scope,
  subject = "",
  limit = 20,
  windowSeconds = 60,
} = {}) {
  try {
    const state = await limiter.check({
      scope,
      key: requestRateLimitKey(req, subject),
      limit,
      windowSeconds,
    });
    res.setHeader("RateLimit-Limit", String(state.limit));
    res.setHeader("RateLimit-Remaining", String(state.remaining));
    res.setHeader("RateLimit-Reset", state.resetAt);
    return null;
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    return {
      ok: false,
      error: error.code,
      charged: false,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
}
