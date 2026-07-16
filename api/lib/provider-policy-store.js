import { Redis } from "@upstash/redis";
import { sha256 } from "./utils.js";
import { UNIVERSAL } from "./universal-config.js";

function normalizedId(value) {
  return String(value || "").trim();
}

function serviceKey(agentId, serviceId) {
  return `${normalizedId(agentId)}:${normalizedId(serviceId)}`;
}

export class MemoryProviderPolicyStore {
  constructor() {
    this.policies = new Map();
    this.latest = new Map();
    this.versions = new Map();
    this.demands = new Map();
    this.relayReceipts = new Map();
    this.latestRelayByJob = new Map();
    this.relayGrantClaims = new Map();
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
    const receiptId = input.receiptId || `ppr-${sha256(input).slice(0, 24)}`;
    const current = this.relayReceipts.get(receiptId);
    if (current) return structuredClone(current);
    const record = structuredClone({ ...input, receiptId });
    this.relayReceipts.set(receiptId, record);
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    if (targetJobId) this.latestRelayByJob.set(targetJobId, receiptId);
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

  async claimRelayGrant(grantId, requestId) {
    const current = this.relayGrantClaims.get(String(grantId));
    if (current) return false;
    this.relayGrantClaims.set(String(grantId), requestId);
    return true;
  }
}

export class RedisProviderPolicyStore {
  constructor({ redis, prefix = UNIVERSAL.registryPrefix } = {}) {
    this.redis = redis || Redis.fromEnv();
    this.prefix = String(prefix).replace(/:+$/, "");
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
    const receiptId = input.receiptId || `ppr-${sha256(input).slice(0, 24)}`;
    const record = { ...input, receiptId };
    const targetJobId = String(record.provider?.targetJobId || "").toLowerCase();
    const writes = [this.redis.set(this.key("relay", receiptId), JSON.stringify(record), { nx: true })];
    if (targetJobId) writes.push(this.redis.set(this.key("relay-job", targetJobId), receiptId));
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

  async claimRelayGrant(grantId, requestId) {
    const key = this.key("relay-grant", String(grantId));
    const created = await this.redis.set(key, requestId, { nx: true, ex: 24 * 60 * 60 });
    return created === "OK";
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
