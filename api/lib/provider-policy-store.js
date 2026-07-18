import { Redis } from "@upstash/redis";
import { sha256 } from "./utils.js";
import { UNIVERSAL } from "./universal-config.js";

function normalizedId(value) {
  return String(value || "").trim();
}

function serviceKey(agentId, serviceId) {
  return `${normalizedId(agentId)}:${normalizedId(serviceId)}`;
}

const RELAY_GRANT_CLAIM_EXPIRY_MARGIN_SECONDS = 60 * 60;
const RELAY_GRANT_CLAIM_MAX_TTL_SECONDS = 8 * 24 * 60 * 60;

function relayCovenantId(record) {
  const value = String(record?.covenantId || "").toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(value) ? value : null;
}

function startsVerifiedRelayClock(record) {
  return record?.request?.paymentVerified === true
    && record?.clock?.source === "policypool_relay_verified_x402_settlement"
    && Boolean(record?.relayGrantId)
    && Boolean(relayCovenantId(record))
    && Boolean(record?.settlement?.transaction);
}

function relayReceiptRecord(input) {
  const receiptId = input.receiptId || `ppr-${sha256(input).slice(0, 24)}`;
  return { ...input, receiptId };
}

function relayGrantClaimTtlSeconds(expiresAt, nowMs = Date.now()) {
  const expiryMs = Date.parse(String(expiresAt || ""));
  if (!Number.isFinite(expiryMs)) return null;
  const throughExpiry = Math.ceil((expiryMs - nowMs) / 1_000) + RELAY_GRANT_CLAIM_EXPIRY_MARGIN_SECONDS;
  return Math.min(
    RELAY_GRANT_CLAIM_MAX_TTL_SECONDS,
    Math.max(RELAY_GRANT_CLAIM_EXPIRY_MARGIN_SECONDS, throughExpiry),
  );
}

export class MemoryProviderPolicyStore {
  constructor() {
    this.policies = new Map();
    this.latest = new Map();
    this.versions = new Map();
    this.demands = new Map();
    this.relayReceipts = new Map();
    this.latestRelayByJob = new Map();
    this.relayByCovenant = new Map();
    this.relayResponses = new Map();
    this.relayGrantClaims = new Map();
    this.relayPaymentClaims = new Map();
  }

  async savePolicy(input) {
    const key = serviceKey(input.agentId, input.serviceId);
    const version = (this.versions.get(key) || 0) + 1;
    const policyId = `ppp-${sha256({ key, version, provider: input.providerWallet, fingerprint: input.serviceFingerprint }).slice(0, 24)}`;
    const record = structuredClone({ ...input, policyId, version });
    this.versions.set(key, version);
    this.latest.set(key, policyId);
    this.policies.set(policyId, record);
    return structuredClone(record);
  }

  async getPolicy(policyId) {
    const value = this.policies.get(String(policyId));
    return value ? structuredClone(value) : null;
  }

  async updatePolicy(policyId, updates) {
    const current = await this.getPolicy(policyId);
    if (!current) return null;
    const next = structuredClone({ ...current, ...updates, policyId: current.policyId, version: current.version });
    this.policies.set(current.policyId, next);
    return structuredClone(next);
  }

  async getLatestPolicy(agentId, serviceId) {
    const id = this.latest.get(serviceKey(agentId, serviceId));
    return id ? this.getPolicy(id) : null;
  }

  async listPolicies(limit = 100) {
    return [...this.policies.values()].slice(-limit).reverse().map((item) => structuredClone(item));
  }

  async recordDemand(input) {
    const { dedupeKey, ...publicInput } = input;
    const id = `ppd-${sha256(dedupeKey || publicInput).slice(0, 24)}`;
    if (!this.demands.has(id)) this.demands.set(id, structuredClone({ ...publicInput, demandId: id }));
    return structuredClone(this.demands.get(id));
  }

  async listDemand(limit = 100) {
    return [...this.demands.values()].slice(-limit).reverse().map((item) => structuredClone(item));
  }

  async saveRelayReceipt(input) {
    const { receiptId, ...receipt } = relayReceiptRecord(input);
    const current = this.relayReceipts.get(receiptId);
    if (current) return structuredClone(current);
    const record = structuredClone({ ...receipt, receiptId });
    this.relayReceipts.set(receiptId, record);
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    const covenantId = relayCovenantId(record);
    if (targetJobId && startsVerifiedRelayClock(record)) {
      this.latestRelayByJob.set(targetJobId, receiptId);
      this.relayByCovenant.set(covenantId, receiptId);
    }
    return structuredClone(record);
  }

  async getRelayReceipt(receiptId) {
    const value = this.relayReceipts.get(String(receiptId));
    return value ? structuredClone(value) : null;
  }

  async getLatestRelayReceiptForJob(targetJobId) {
    const receiptId = this.latestRelayByJob.get(String(targetJobId || "").toLowerCase());
    return receiptId ? this.getRelayReceipt(receiptId) : null;
  }

  async getRelayReceiptForCovenant(covenantId) {
    const receiptId = this.relayByCovenant.get(String(covenantId || "").toLowerCase());
    return receiptId ? this.getRelayReceipt(receiptId) : null;
  }

  async getRelayResponse(receiptId) {
    const value = this.relayResponses.get(String(receiptId));
    return value ? structuredClone(value) : null;
  }

  async reserveRelayExecution(grantId, paymentId, requestId, _grantExpiresAt) {
    const grantKey = String(grantId);
    const paymentKey = String(paymentId);
    if (this.relayGrantClaims.has(grantKey)) return "grant_used";
    if (this.relayPaymentClaims.has(paymentKey)) return "payment_used";
    const pending = { requestId, state: "pending" };
    this.relayGrantClaims.set(grantKey, pending);
    this.relayPaymentClaims.set(paymentKey, pending);
    return "reserved";
  }

  async commitRelayExecutionReceipt(grantId, paymentId, requestId, grantExpiresAt, input, upstream = null) {
    const grantKey = String(grantId);
    const paymentKey = String(paymentId);
    const grant = this.relayGrantClaims.get(grantKey);
    const payment = this.relayPaymentClaims.get(paymentKey);
    if (relayGrantClaimTtlSeconds(grantExpiresAt) === null) return null;
    const record = structuredClone(relayReceiptRecord(input));
    const consumed = { requestId, state: "consumed" };
    if (
      grant?.requestId === requestId
      && payment?.requestId === requestId
      && grant.state === "consumed"
      && payment.state === "consumed"
    ) {
      const existing = this.relayReceipts.get(record.receiptId);
      const existingUpstream = this.relayResponses.get(record.receiptId);
      if (!existing || sha256(existing) !== sha256(record)) return null;
      if (upstream && existingUpstream && sha256(existingUpstream) !== sha256(upstream)) return null;
      if (upstream && !existingUpstream) this.relayResponses.set(record.receiptId, structuredClone(upstream));
      return structuredClone(existing);
    }
    if (
      !grant
      || !payment
      || grant.requestId !== requestId
      || payment.requestId !== requestId
      || grant.state !== "pending"
      || payment.state !== "pending"
      || !startsVerifiedRelayClock(record)
    ) return null;
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    const covenantId = relayCovenantId(record);
    if (!targetJobId || !covenantId) return null;
    const current = this.relayReceipts.get(record.receiptId);
    if (current && sha256(current) !== sha256(record)) return null;
    const currentUpstream = this.relayResponses.get(record.receiptId);
    if (upstream && currentUpstream && sha256(currentUpstream) !== sha256(upstream)) return null;
    this.relayReceipts.set(record.receiptId, current || record);
    if (upstream && !currentUpstream) this.relayResponses.set(record.receiptId, structuredClone(upstream));
    this.latestRelayByJob.set(targetJobId, record.receiptId);
    this.relayByCovenant.set(covenantId, record.receiptId);
    this.relayGrantClaims.set(grantKey, consumed);
    this.relayPaymentClaims.set(paymentKey, consumed);
    return structuredClone(current || record);
  }

  async releaseRelayExecution(grantId, paymentId, requestId) {
    const grantKey = String(grantId);
    const paymentKey = String(paymentId);
    const grant = this.relayGrantClaims.get(grantKey);
    const payment = this.relayPaymentClaims.get(paymentKey);
    if (
      !grant
      || !payment
      || grant.requestId !== requestId
      || payment.requestId !== requestId
      || grant.state !== "pending"
      || payment.state !== "pending"
    ) return false;
    this.relayGrantClaims.delete(grantKey);
    this.relayPaymentClaims.delete(paymentKey);
    return true;
  }
}

export class RedisProviderPolicyStore {
  constructor({ redis, prefix = UNIVERSAL.registryPrefix, now = () => Date.now() } = {}) {
    this.redis = redis || Redis.fromEnv();
    this.prefix = String(prefix).replace(/:+$/, "");
    this.now = now;
  }

  key(kind, id = "") {
    return `${this.prefix}:${kind}${id ? `:${id}` : ""}`;
  }

  async savePolicy(input) {
    const key = serviceKey(input.agentId, input.serviceId);
    const version = Number(await this.redis.incr(this.key("version", key)));
    const policyId = `ppp-${sha256({ key, version, provider: input.providerWallet, fingerprint: input.serviceFingerprint }).slice(0, 24)}`;
    const record = { ...input, policyId, version };
    await Promise.all([
      this.redis.set(this.key("policy", policyId), JSON.stringify(record)),
      this.redis.set(this.key("latest", key), policyId),
      this.redis.zadd(this.key("policies"), { score: Date.parse(record.createdAt), member: policyId }),
    ]);
    return record;
  }

  async getPolicy(policyId) {
    const value = await this.redis.get(this.key("policy", String(policyId)));
    if (!value) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async updatePolicy(policyId, updates) {
    const current = await this.getPolicy(policyId);
    if (!current) return null;
    const next = { ...current, ...updates, policyId: current.policyId, version: current.version };
    await this.redis.set(this.key("policy", current.policyId), JSON.stringify(next));
    return next;
  }

  async getLatestPolicy(agentId, serviceId) {
    const id = await this.redis.get(this.key("latest", serviceKey(agentId, serviceId)));
    return id ? this.getPolicy(String(id)) : null;
  }

  async listPolicies(limit = 100) {
    const ids = await this.redis.zrange(this.key("policies"), 0, Math.max(0, limit - 1), { rev: true });
    if (!ids.length) return [];
    const values = await this.redis.mget(...ids.map((id) => this.key("policy", String(id))));
    return values.filter(Boolean).map((value) => (typeof value === "string" ? JSON.parse(value) : value));
  }

  async recordDemand(input) {
    const { dedupeKey, ...publicInput } = input;
    const demandId = `ppd-${sha256(dedupeKey || publicInput).slice(0, 24)}`;
    const record = { ...publicInput, demandId };
    const created = await this.redis.set(this.key("demand", demandId), JSON.stringify(record), { nx: true });
    if (created) {
      await this.redis.zadd(this.key("demands"), { score: Date.parse(record.createdAt), member: demandId });
      return record;
    }
    const existing = await this.redis.get(this.key("demand", demandId));
    return typeof existing === "string" ? JSON.parse(existing) : existing;
  }

  async listDemand(limit = 100) {
    const ids = await this.redis.zrange(this.key("demands"), 0, Math.max(0, limit - 1), { rev: true });
    if (!ids.length) return [];
    const values = await this.redis.mget(...ids.map((id) => this.key("demand", String(id))));
    return values.filter(Boolean).map((value) => (typeof value === "string" ? JSON.parse(value) : value));
  }

  async saveRelayReceipt(input) {
    const record = relayReceiptRecord(input);
    const { receiptId } = record;
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    const covenantId = relayCovenantId(record);
    const writes = [this.redis.set(this.key("relay", receiptId), JSON.stringify(record), { nx: true })];
    if (targetJobId && startsVerifiedRelayClock(record)) {
      writes.push(this.redis.set(this.key("relay-job", targetJobId), receiptId));
      writes.push(this.redis.set(this.key("relay-covenant", covenantId), receiptId));
    }
    await Promise.all(writes);
    return this.getRelayReceipt(receiptId);
  }

  async getRelayReceipt(receiptId) {
    const value = await this.redis.get(this.key("relay", String(receiptId)));
    if (!value) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async getLatestRelayReceiptForJob(targetJobId) {
    const receiptId = await this.redis.get(this.key("relay-job", String(targetJobId || "").toLowerCase()));
    return receiptId ? this.getRelayReceipt(String(receiptId)) : null;
  }

  async getRelayReceiptForCovenant(covenantId) {
    const receiptId = await this.redis.get(this.key("relay-covenant", String(covenantId || "").toLowerCase()));
    return receiptId ? this.getRelayReceipt(String(receiptId)) : null;
  }

  async getRelayResponse(receiptId) {
    const value = await this.redis.get(this.key("relay-response", String(receiptId)));
    if (!value) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async reserveRelayExecution(grantId, paymentId, requestId, grantExpiresAt) {
    const grantKey = this.key("relay-grant", String(grantId));
    const paymentKey = this.key("relay-payment", String(paymentId));
    const reservationTtlSeconds = relayGrantClaimTtlSeconds(grantExpiresAt, this.now());
    if (reservationTtlSeconds === null) return "invalid_expiry";
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 1 end
        if redis.call("EXISTS", KEYS[2]) == 1 then return 2 end
        redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
        redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
        return 0
      `,
      [grantKey, paymentKey],
      [`pending:${requestId}`, String(reservationTtlSeconds)],
    );
    if (Number(result) === 1) return "grant_used";
    if (Number(result) === 2) return "payment_used";
    return "reserved";
  }

  async commitRelayExecutionReceipt(grantId, paymentId, requestId, grantExpiresAt, input, upstream = null) {
    const grantKey = this.key("relay-grant", String(grantId));
    const paymentKey = this.key("relay-payment", String(paymentId));
    const record = relayReceiptRecord(input);
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    const covenantId = relayCovenantId(record);
    const grantClaimTtlSeconds = relayGrantClaimTtlSeconds(grantExpiresAt, this.now());
    if (
      !targetJobId
      || !covenantId
      || !startsVerifiedRelayClock(record)
      || grantClaimTtlSeconds === null
    ) return null;
    const receiptKey = this.key("relay", record.receiptId);
    const jobKey = this.key("relay-job", targetJobId);
    const covenantKey = this.key("relay-covenant", covenantId);
    const responseKey = this.key("relay-response", record.receiptId);
    // A paid clock is usable only if its receipt, index, and replay claims become durable together.
    const result = await this.redis.eval(
      `
        local grant = redis.call("GET", KEYS[1])
        local payment = redis.call("GET", KEYS[2])
        local existing = redis.call("GET", KEYS[3])
        local existingResponse = redis.call("GET", KEYS[6])
        if ARGV[6] ~= "" and existingResponse and existingResponse ~= ARGV[6] then return 0 end
        if grant == ARGV[2] and payment == ARGV[2] then
          if existing ~= ARGV[3] then return 0 end
          if ARGV[6] ~= "" and not existingResponse then redis.call("SET", KEYS[6], ARGV[6]) end
          redis.call("SET", KEYS[4], ARGV[4])
          redis.call("SET", KEYS[5], ARGV[4])
          return 2
        end
        if grant == ARGV[1] and payment == ARGV[1] then
          if existing and existing ~= ARGV[3] then return 0 end
          if not existing then redis.call("SET", KEYS[3], ARGV[3]) end
          if ARGV[6] ~= "" and not existingResponse then redis.call("SET", KEYS[6], ARGV[6]) end
          redis.call("SET", KEYS[4], ARGV[4])
          redis.call("SET", KEYS[5], ARGV[4])
          redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[5])
          redis.call("SET", KEYS[2], ARGV[2])
          return 1
        end
        return 0
      `,
      [grantKey, paymentKey, receiptKey, jobKey, covenantKey, responseKey],
      [
        `pending:${requestId}`,
        `consumed:${requestId}`,
        JSON.stringify(record),
        record.receiptId,
        String(grantClaimTtlSeconds),
        upstream ? JSON.stringify(upstream) : "",
      ],
    );
    return Number(result) > 0 ? this.getRelayReceipt(record.receiptId) : null;
  }

  async releaseRelayExecution(grantId, paymentId, requestId) {
    const grantKey = this.key("relay-grant", String(grantId));
    const paymentKey = this.key("relay-payment", String(paymentId));
    const result = await this.redis.eval(
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] and redis.call("GET", KEYS[2]) == ARGV[1] then
          redis.call("DEL", KEYS[1])
          redis.call("DEL", KEYS[2])
          return 1
        end
        return 0
      `,
      [grantKey, paymentKey],
      [`pending:${requestId}`],
    );
    return Number(result) === 1;
  }
}

export function createProviderPolicyStore() {
  const hasRedis = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
      || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
  if (!hasRedis) throw new Error("provider_policy_store_not_configured");
  if (!process.env.UPSTASH_REDIS_REST_URL && process.env.KV_REST_API_URL) {
    process.env.UPSTASH_REDIS_REST_URL = process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = process.env.KV_REST_API_TOKEN;
  }
  return new RedisProviderPolicyStore();
}
