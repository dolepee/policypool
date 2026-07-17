import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import { clean, sha256, stableStringify } from "./utils.js";

const TOKEN_PATTERN = /^ppd_([a-f0-9]{32})\.([a-f0-9]{64})$/;
const DEFAULT_TTL_SECONDS = 10 * 60;
const DEFAULT_LEASE_SECONDS = 2 * 60;
const DEFAULT_EXECUTION_RETENTION_SECONDS = 10 * 24 * 60 * 60;
const MINIMUM_SECRET_LENGTH = 32;

const BIND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if current.state == 'bound' and current.bindingHash == ARGV[1] then return {'existing', raw} end
if current.state ~= 'probed' then return {'state_mismatch', raw} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl) else redis.call('SET', KEYS[1], ARGV[2]) end
return {'bound', ARGV[2]}
`;

const CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if current.state == 'complete' then return {'complete', raw} end
if current.state == 'executing' then
  if current.execution.id ~= ARGV[1] then return {'execution_mismatch', raw} end
  if tonumber(current.execution.leaseExpiresAtMs) > tonumber(ARGV[2]) then return {'in_progress', raw} end
  local ttl = redis.call('PTTL', KEYS[1])
  local retention = tonumber(ARGV[4])
  if ttl < retention then ttl = retention end
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl)
  redis.call('ZADD', KEYS[2], 'NX', ARGV[6], ARGV[5])
  return {'reclaimed', ARGV[3]}
end
if current.state ~= 'bound' then return {'state_mismatch', raw} end
local ttl = redis.call('PTTL', KEYS[1])
local retention = tonumber(ARGV[4])
if ttl < retention then ttl = retention end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl)
redis.call('ZADD', KEYS[2], 'NX', ARGV[6], ARGV[5])
return {'claimed', ARGV[3]}
`;

const UPDATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if current.state ~= 'executing' or current.execution.id ~= ARGV[1] then return {'state_mismatch', raw} end
local nextState = cjson.decode(ARGV[2])
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl) else redis.call('SET', KEYS[1], ARGV[2]) end
if nextState.state == 'executing' then
  redis.call('ZADD', KEYS[2], 'NX', ARGV[4], ARGV[3])
else
  redis.call('ZREM', KEYS[2], ARGV[3])
end
return {'updated', ARGV[2]}
`;

const RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if current.state ~= 'executing' or current.execution.id ~= ARGV[1] then return {'state_mismatch', raw} end
if next(current.execution.stages) ~= nil then return {'irreversible', raw} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl) else redis.call('SET', KEYS[1], ARGV[2]) end
redis.call('ZREM', KEYS[2], ARGV[3])
return {'released', ARGV[2]}
`;

const MARK_SCANNED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 0
end
local current = cjson.decode(raw)
if current.state ~= 'executing' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 0
end
local score = tonumber(ARGV[1])
local tail = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if #tail == 2 and tonumber(tail[2]) >= score then score = tonumber(tail[2]) + 1 end
redis.call('ZADD', KEYS[2], score, ARGV[2])
return 1
`;

export class DirectA2mcpStateError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = "DirectA2mcpStateError";
    this.code = code;
    this.status = status;
  }
}

function clone(value) {
  return value ? structuredClone(value) : null;
}

function normalizedListLimit(limit) {
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
}

function tokenSecret(override) {
  const value = String(
    override || process.env.POLICYPOOL_DIRECT_QUOTE_SECRET || process.env.POLICYPOOL_QUOTE_SECRET || "",
  ).trim();
  if (Buffer.byteLength(value) < MINIMUM_SECRET_LENGTH) {
    throw new DirectA2mcpStateError("direct_quote_secret_not_configured", 503);
  }
  return value;
}

function signatureFor(id, secret) {
  return createHmac("sha256", secret).update(`policypool-direct-a2mcp:v1:${id}`).digest("hex");
}

function tokenFor(id, secret) {
  return `ppd_${id}.${signatureFor(id, secret)}`;
}

function parseToken(token, secret) {
  const match = TOKEN_PATTERN.exec(clean(token, 140));
  if (!match) throw new DirectA2mcpStateError("direct_quote_invalid", 422);
  const [, id, suppliedSignature] = match;
  const supplied = Buffer.from(suppliedSignature, "hex");
  const expected = Buffer.from(signatureFor(id, secret), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new DirectA2mcpStateError("direct_quote_invalid", 422);
  }
  return id;
}

export class MemoryDirectA2mcpStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.quotes = new Map();
    this.executing = new Map();
  }

  async create(record, ttlSeconds) {
    if (this.quotes.has(record.id)) throw new DirectA2mcpStateError("direct_quote_collision", 503);
    this.quotes.set(record.id, { record: clone(record), expiresAtMs: this.now() + ttlSeconds * 1_000 });
    return clone(record);
  }

  async get(id) {
    const stored = this.quotes.get(String(id));
    if (!stored) return null;
    if (stored.expiresAtMs <= this.now()) {
      this.quotes.delete(String(id));
      this.executing.delete(String(id));
      return null;
    }
    return clone(stored.record);
  }

  async list(limit = 100) {
    const records = [];
    for (const id of [...this.quotes.keys()].reverse()) {
      const record = await this.get(id);
      if (record) records.push(record);
      if (records.length >= limit) break;
    }
    return clone(records);
  }

  async listExecuting(limit = 100) {
    const count = normalizedListLimit(limit);
    if (count === 0) return [];
    const records = [];
    const ordered = [...this.executing.entries()]
      .sort(([leftId, leftScore], [rightId, rightScore]) => leftScore - rightScore || leftId.localeCompare(rightId));
    for (const [id] of ordered) {
      const record = await this.get(id);
      if (!record || record.state !== "executing") {
        this.executing.delete(id);
        continue;
      }
      records.push(record);
      if (records.length >= count) break;
    }
    return clone(records);
  }

  async bind(id, bindingHash, next) {
    const current = await this.get(id);
    if (!current) return { status: "missing", record: null };
    if (current.state === "bound" && current.bindingHash === bindingHash) {
      return { status: "existing", record: current };
    }
    if (current.state !== "probed") return { status: "state_mismatch", record: current };
    this.quotes.get(String(id)).record = clone(next);
    return { status: "bound", record: clone(next) };
  }

  async claim(id, executionId, next, _nowMs, retentionSeconds) {
    const current = await this.get(id);
    if (!current) return { status: "missing", record: null };
    if (current.state === "complete") return { status: "complete", record: current };
    if (current.state === "executing") {
      if (current.execution.id !== executionId) return { status: "execution_mismatch", record: current };
      if (current.execution.leaseExpiresAtMs > this.now()) return { status: "in_progress", record: current };
      const stored = this.quotes.get(String(id));
      stored.record = clone(next);
      stored.expiresAtMs = Math.max(stored.expiresAtMs, this.now() + retentionSeconds * 1_000);
      if (!this.executing.has(String(id))) this.executing.set(String(id), next.execution.startedAtMs);
      return { status: "reclaimed", record: clone(next) };
    }
    if (current.state !== "bound") return { status: "state_mismatch", record: current };
    const stored = this.quotes.get(String(id));
    stored.record = clone(next);
    stored.expiresAtMs = Math.max(stored.expiresAtMs, this.now() + retentionSeconds * 1_000);
    this.executing.set(String(id), next.execution.startedAtMs);
    return { status: "claimed", record: clone(next) };
  }

  async update(id, executionId, next) {
    const current = await this.get(id);
    if (!current) return { status: "missing", record: null };
    if (current.state !== "executing" || current.execution.id !== executionId) {
      return { status: "state_mismatch", record: current };
    }
    this.quotes.get(String(id)).record = clone(next);
    if (next.state === "executing") {
      if (!this.executing.has(String(id))) this.executing.set(String(id), next.execution.startedAtMs);
    } else {
      this.executing.delete(String(id));
    }
    return { status: "updated", record: clone(next) };
  }

  async release(id, executionId, next) {
    const current = await this.get(id);
    if (!current) return { status: "missing", record: null };
    if (current.state !== "executing" || current.execution.id !== executionId) {
      return { status: "state_mismatch", record: current };
    }
    if (Object.keys(current.execution.stages || {}).length > 0) return { status: "irreversible", record: current };
    this.quotes.get(String(id)).record = clone(next);
    this.executing.delete(String(id));
    return { status: "released", record: clone(next) };
  }

  async markExecutingScanned(id, scannedAtMs) {
    const current = await this.get(String(id));
    if (!current || current.state !== "executing") {
      this.executing.delete(String(id));
      return false;
    }
    let tailScore = 0;
    for (const score of this.executing.values()) tailScore = Math.max(tailScore, score);
    this.executing.set(String(id), Math.max(scannedAtMs, tailScore + 1));
    return true;
  }
}

export class RedisDirectA2mcpStore {
  constructor({ redis, prefix = "pp:direct-a2mcp:v1" } = {}) {
    this.redis = redis || Redis.fromEnv();
    this.prefix = String(prefix).replace(/:+$/, "");
  }

  key(id) {
    return `${this.prefix}:quote:${id}`;
  }

  indexKey() {
    return `${this.prefix}:quotes`;
  }

  executingIndexKey() {
    return `${this.prefix}:executing`;
  }

  async create(record, ttlSeconds) {
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
        redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
        redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
        return 1
      `,
      [this.key(record.id), this.indexKey()],
      [JSON.stringify(record), String(ttlSeconds), String(Date.parse(record.issuedAt)), record.id],
    );
    if (Number(result) !== 1) throw new DirectA2mcpStateError("direct_quote_collision", 503);
    return record;
  }

  async get(id) {
    const value = await this.redis.get(this.key(id));
    if (!value) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async list(limit = 100) {
    const ids = await this.redis.zrange(this.indexKey(), 0, Math.max(0, limit - 1), { rev: true });
    if (!ids.length) return [];
    const values = await this.redis.mget(...ids.map((id) => this.key(String(id))));
    const missing = [];
    const records = [];
    values.forEach((value, index) => {
      if (!value) missing.push(String(ids[index]));
      else records.push(typeof value === "string" ? JSON.parse(value) : value);
    });
    if (missing.length) await this.redis.zrem(this.indexKey(), ...missing);
    return records;
  }

  async listExecuting(limit = 100) {
    const count = normalizedListLimit(limit);
    if (count === 0) return [];
    const records = [];
    let offset = 0;
    while (records.length < count) {
      const remaining = count - records.length;
      const ids = await this.redis.zrange(this.executingIndexKey(), offset, offset + remaining - 1);
      if (!ids.length) break;
      const values = await this.redis.mget(...ids.map((id) => this.key(String(id))));
      const stale = [];
      let live = 0;
      values.forEach((value, index) => {
        const id = String(ids[index]);
        if (!value) {
          stale.push(id);
          return;
        }
        const record = typeof value === "string" ? JSON.parse(value) : value;
        if (record.state !== "executing") stale.push(id);
        else {
          records.push(record);
          live += 1;
        }
      });
      if (stale.length) await this.redis.zrem(this.executingIndexKey(), ...stale);
      offset += live;
      if (ids.length < remaining && stale.length === 0) break;
    }
    return records;
  }

  async bind(id, bindingHash, next) {
    return this._transition(BIND_SCRIPT, id, [bindingHash, JSON.stringify(next)]);
  }

  async claim(id, executionId, next, nowMs, retentionSeconds) {
    return this._transition(CLAIM_SCRIPT, id, [
      executionId,
      String(nowMs),
      JSON.stringify(next),
      String(retentionSeconds * 1_000),
      String(id),
      String(next.execution.startedAtMs),
    ]);
  }

  async update(id, executionId, next) {
    return this._transition(UPDATE_SCRIPT, id, [
      executionId,
      JSON.stringify(next),
      String(id),
      String(next.execution?.startedAtMs || Date.parse(next.issuedAt)),
    ]);
  }

  async release(id, executionId, next) {
    return this._transition(RELEASE_SCRIPT, id, [executionId, JSON.stringify(next), String(id)]);
  }

  async markExecutingScanned(id, scannedAtMs) {
    const result = await this.redis.eval(
      MARK_SCANNED_SCRIPT,
      [this.key(id), this.executingIndexKey()],
      [String(scannedAtMs), String(id)],
    );
    return Number(result) === 1;
  }

  async _transition(script, id, args) {
    const result = await this.redis.eval(script, [this.key(id), this.executingIndexKey()], args);
    const value = result?.[1];
    return {
      status: String(result?.[0] || "state_error"),
      record: value ? (typeof value === "string" ? JSON.parse(value) : value) : null,
    };
  }
}

export function createDirectA2mcpStore() {
  const configured = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
      || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
  if (!configured) throw new DirectA2mcpStateError("direct_quote_store_not_configured", 503);
  if (!process.env.UPSTASH_REDIS_REST_URL && process.env.KV_REST_API_URL) {
    process.env.UPSTASH_REDIS_REST_URL = process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = process.env.KV_REST_API_TOKEN;
  }
  return new RedisDirectA2mcpStore();
}

export function createDirectA2mcpState({
  store = createDirectA2mcpStore(),
  secret,
  now = () => Date.now(),
  randomId = () => randomBytes(16).toString("hex"),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  executionRetentionSeconds = DEFAULT_EXECUTION_RETENTION_SECONDS,
} = {}) {
  const key = tokenSecret(secret);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > DEFAULT_TTL_SECONDS) {
    throw new DirectA2mcpStateError("direct_quote_ttl_invalid", 503);
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > DEFAULT_LEASE_SECONDS) {
    throw new DirectA2mcpStateError("direct_execution_lease_invalid", 503);
  }
  if (
    !Number.isSafeInteger(executionRetentionSeconds)
    || executionRetentionSeconds < ttlSeconds
    || executionRetentionSeconds > DEFAULT_EXECUTION_RETENTION_SECONDS
  ) {
    throw new DirectA2mcpStateError("direct_execution_retention_invalid", 503);
  }

  async function issue(input) {
    const id = randomId();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new DirectA2mcpStateError("direct_quote_id_invalid", 503);
    const issuedAtMs = now();
    const record = {
      ...clone(input),
      id,
      state: "probed",
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + ttlSeconds * 1_000).toISOString(),
    };
    await store.create(record, ttlSeconds);
    return { ...record, token: tokenFor(id, key) };
  }

  async function resolve(token) {
    const id = parseToken(token, key);
    const record = await store.get(id);
    if (
      !record
      || (["probed", "bound"].includes(record.state) && Date.parse(record.expiresAt) <= now())
    ) {
      throw new DirectA2mcpStateError("direct_quote_not_found_or_expired", 404);
    }
    return { ...record, token };
  }

  async function bind(token, binding) {
    const current = await resolve(token);
    const bindingHash = `sha256:${sha256(binding)}`;
    const next = { ...current, token: undefined, ...clone(binding), bindingHash, state: "bound" };
    const result = await store.bind(current.id, bindingHash, next);
    if (["bound", "existing"].includes(result.status)) return { ...result.record, token };
    throw new DirectA2mcpStateError(`direct_quote_bind_${result.status}`);
  }

  async function claim(token, executionId) {
    const current = await resolve(token);
    const next = {
      ...current,
      token: undefined,
      state: "executing",
      execution: {
        ...(current.execution?.id === executionId
          ? current.execution
          : { id: executionId, startedAtMs: now(), stages: {} }),
        id: executionId,
        leaseExpiresAtMs: now() + leaseSeconds * 1_000,
      },
    };
    const result = await store.claim(
      current.id,
      executionId,
      next,
      now(),
      executionRetentionSeconds,
    );
    if (["claimed", "reclaimed", "complete"].includes(result.status)) {
      return { status: result.status, record: { ...result.record, token } };
    }
    throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
  }

  async function checkpoint(token, executionId, stage, value) {
    const current = await resolve(token);
    if (current.state !== "executing" || current.execution?.id !== executionId) {
      throw new DirectA2mcpStateError("direct_execution_state_mismatch");
    }
    const next = {
      ...current,
      token: undefined,
      execution: {
        ...current.execution,
        leaseExpiresAtMs: now() + leaseSeconds * 1_000,
        stages: { ...current.execution.stages, [stage]: clone(value) },
      },
    };
    const result = await store.update(current.id, executionId, next);
    if (result.status !== "updated") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return { ...result.record, token };
  }

  async function complete(token, executionId, resultValue) {
    const current = await resolve(token);
    const next = {
      ...current,
      token: undefined,
      state: "complete",
      completedAt: new Date(now()).toISOString(),
      result: clone(resultValue),
      execution: { ...current.execution, leaseExpiresAtMs: 0 },
    };
    const result = await store.update(current.id, executionId, next);
    if (result.status !== "updated") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return { ...result.record, token };
  }

  async function yieldExecution(token, executionId, errorCode) {
    const current = await resolve(token);
    if (current.state !== "executing" || current.execution?.id !== executionId) {
      throw new DirectA2mcpStateError("direct_execution_state_mismatch");
    }
    const next = {
      ...current,
      token: undefined,
      execution: {
        ...current.execution,
        leaseExpiresAtMs: now(),
        lastError: clean(errorCode, 180),
      },
    };
    const result = await store.update(current.id, executionId, next);
    if (result.status !== "updated") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return { ...result.record, token };
  }

  async function release(token, executionId) {
    const current = await resolve(token);
    const { execution, ...rest } = current;
    const next = { ...rest, token: undefined, state: "bound" };
    const result = await store.release(current.id, executionId, next);
    if (result.status !== "released") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return { ...result.record, token };
  }

  async function listExecuting(limit = 100) {
    if (!store.listExecuting) throw new DirectA2mcpStateError("direct_execution_index_unavailable", 503);
    return store.listExecuting(limit);
  }

  async function markReconciled(id) {
    if (!store.markExecutingScanned) throw new DirectA2mcpStateError("direct_execution_index_unavailable", 503);
    return store.markExecutingScanned(String(id), now());
  }

  async function reconcileCheckpoint(id, executionId, stage, value) {
    const current = await store.get(String(id));
    if (!current || current.state !== "executing" || current.execution?.id !== executionId) {
      throw new DirectA2mcpStateError("direct_execution_state_mismatch");
    }
    const next = {
      ...current,
      execution: {
        ...current.execution,
        stages: { ...current.execution.stages, [stage]: clone(value) },
      },
    };
    const result = await store.update(current.id, executionId, next);
    if (result.status !== "updated") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return result.record;
  }

  async function reconcileComplete(id, executionId, resultValue) {
    const current = await store.get(String(id));
    if (!current || current.state !== "executing" || current.execution?.id !== executionId) {
      throw new DirectA2mcpStateError("direct_execution_state_mismatch");
    }
    const next = {
      ...current,
      state: "complete",
      completedAt: new Date(now()).toISOString(),
      result: clone(resultValue),
      execution: { ...current.execution, leaseExpiresAtMs: 0 },
    };
    const result = await store.update(current.id, executionId, next);
    if (result.status !== "updated") throw new DirectA2mcpStateError(`direct_execution_${result.status}`);
    return result.record;
  }

  return {
    bind,
    checkpoint,
    claim,
    complete,
    issue,
    listExecuting,
    markReconciled,
    reconcileCheckpoint,
    reconcileComplete,
    release,
    resolve,
    yieldExecution,
  };
}

export const __test = { parseToken, tokenFor };
