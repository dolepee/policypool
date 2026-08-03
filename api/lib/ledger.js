import { Redis } from "@upstash/redis";

const RESERVE_SCRIPT = `
local existingPayment = redis.call('GET', KEYS[2])
if existingPayment then return {'payment_exists', existingPayment} end
local existingRequest = redis.call('GET', KEYS[1])
if existingRequest then return {'request_exists', existingRequest} end
local active = tonumber(redis.call('GET', KEYS[4]) or '0')
local pending = tonumber(redis.call('GET', KEYS[5]) or '0')
local due = tonumber(redis.call('GET', KEYS[6]) or '0')
local cap = tonumber(ARGV[4])
local reserve = tonumber(ARGV[5])
if active + pending + due + cap > reserve then
  return {'insufficient_reserve', tostring(active + pending + due), tostring(reserve)}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('INCRBY', KEYS[5], ARGV[4])
redis.call('ZADD', KEYS[7], ARGV[3], ARGV[1])
return {'reserved', ARGV[1], tostring(active), tostring(pending + cap), tostring(due)}
`;

const FINALIZE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'pending' and decoded.state ~= 'compensation_required' then
  if ARGV[6] ~= '' and decoded.receipt and decoded.receipt.receiptHash == ARGV[7] then
    redis.call('SET', KEYS[5], ARGV[6], 'NX')
  end
  return {'existing', current}
end
local cap = tonumber(ARGV[2])
redis.call('INCRBY', KEYS[2], -cap)
if ARGV[3] == 'active' then redis.call('INCRBY', KEYS[3], cap) end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[5])
if ARGV[6] ~= '' then redis.call('SET', KEYS[5], ARGV[6], 'NX') end
return {'finalized', ARGV[1]}
`;

const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[3])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'pending' and decoded.state ~= 'compensation_required' then return {'not_pending'} end
redis.call('INCRBY', KEYS[4], -tonumber(ARGV[1]))
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[5])
return {'released'}
`;

const PAYOUT_DUE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'active' then return {'not_active', current} end
local cap = tonumber(ARGV[2])
redis.call('INCRBY', KEYS[2], -cap)
redis.call('INCRBY', KEYS[3], cap)
redis.call('SET', KEYS[1], ARGV[1])
return {'payout_due', ARGV[1]}
`;

const PAID_SCRIPT = `
local usedBy = redis.call('GET', KEYS[3])
if usedBy and usedBy ~= ARGV[3] then return {'payout_transaction_exists', usedBy} end
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'payout_due' then return {'not_payout_due', current} end
redis.call('INCRBY', KEYS[2], -tonumber(ARGV[2]))
redis.call('SET', KEYS[3], ARGV[3])
redis.call('SET', KEYS[1], ARGV[1])
return {'paid', ARGV[1]}
`;

const RELEASE_ACTIVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'active' then return {'not_active', current} end
redis.call('INCRBY', KEYS[2], -tonumber(ARGV[2]))
redis.call('SET', KEYS[1], ARGV[1])
return {'released', ARGV[1]}
`;

const TRANSITION_UNIVERSAL_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
local allowed = false
for index = 2, #ARGV do
  if decoded.state == ARGV[index] then allowed = true break end
end
if not allowed then return {'state_mismatch', current} end
redis.call('SET', KEYS[1], ARGV[1])
return {'updated', ARGV[1]}
`;

const MARK_SETTLEMENT_STATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.state ~= 'pending' then return {'state_mismatch', current} end
redis.call('SET', KEYS[1], ARGV[1])
return {'updated', ARGV[1]}
`;

const BACKFILL_RECEIPT_INTEGRITY_ANCHOR_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
local existing = redis.call('GET', KEYS[2])
if existing then return {'existing', current, existing} end
if not decoded.receipt or decoded.receipt.receiptHash ~= ARGV[1] then
  return {'receipt_mismatch', current}
end
redis.call('SET', KEYS[2], ARGV[2], 'NX')
return {'backfilled', current, redis.call('GET', KEYS[2])}
`;

function prefixValue(value = "pp:coverage:v1") {
  return String(value).replace(/:+$/, "");
}

function parseRecord(value) {
  if (!value) return null;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export class MemoryLedger {
  constructor() {
    this.records = new Map();
    this.requests = new Map();
    this.payments = new Map();
    this.activeAtomic = 0n;
    this.pendingAtomic = 0n;
    this.payoutDueAtomic = 0n;
    this.payoutTransactions = new Map();
    this.quotes = new Map();
    this.receiptIntegrityAnchors = new Map();
  }

  withReceiptIntegrityAnchor(record) {
    if (!record) return null;
    const anchor = this.receiptIntegrityAnchors.get(record.receiptId)
      || record.receiptIntegrityAnchor;
    return anchor
      ? { ...record, receiptIntegrityAnchor: structuredClone(anchor) }
      : record;
  }

  storeRecord(record) {
    if (
      record.receiptIntegrityAnchor
      && !this.receiptIntegrityAnchors.has(record.receiptId)
    ) {
      this.receiptIntegrityAnchors.set(
        record.receiptId,
        structuredClone(record.receiptIntegrityAnchor),
      );
    }
    const anchored = this.withReceiptIntegrityAnchor(record);
    this.records.set(record.receiptId, structuredClone(anchored));
    return anchored;
  }

  async findByPaymentId(paymentId) {
    const id = this.payments.get(paymentId);
    return id ? this.withReceiptIntegrityAnchor(this.records.get(id)) : null;
  }

  async get(receiptId) {
    return this.withReceiptIntegrityAnchor(this.records.get(receiptId));
  }

  async backfillReceiptIntegrityAnchor(receiptId, expectedReceiptHash, anchor) {
    const current = this.records.get(receiptId);
    const existing = this.receiptIntegrityAnchors.get(receiptId)
      || current?.receiptIntegrityAnchor;
    if (!current || existing) return this.withReceiptIntegrityAnchor(current);
    if (current.receipt?.receiptHash !== expectedReceiptHash) return current;
    this.receiptIntegrityAnchors.set(receiptId, structuredClone(anchor));
    return this.withReceiptIntegrityAnchor(current);
  }

  async saveQuote(record) {
    if (this.quotes.has(record.id)) throw new Error("coverage_quote_collision");
    this.quotes.set(record.id, structuredClone(record));
    return record;
  }

  async getQuote(id) {
    const record = this.quotes.get(id);
    return record ? structuredClone(record) : null;
  }

  async findOpenQuotesByBuyer(buyer) {
    const normalized = String(buyer || "").toLowerCase();
    return [...this.quotes.values()]
      .filter((record) => String(record.buyer || "").toLowerCase() === normalized)
      .map((record) => structuredClone(record));
  }

  async reserve(record, reserveBalanceAtomic) {
    const payment = this.payments.get(record.paymentId);
    if (payment) return { status: "payment_exists", receiptId: payment };
    const request = this.requests.get(record.requestId);
    if (request) return { status: "request_exists", receiptId: request };
    const cap = BigInt(record.liabilityAtomic);
    const committed = this.activeAtomic + this.pendingAtomic + this.payoutDueAtomic;
    if (committed + cap > BigInt(reserveBalanceAtomic)) {
      return { status: "insufficient_reserve", committedAtomic: committed.toString() };
    }
    this.requests.set(record.requestId, record.receiptId);
    this.payments.set(record.paymentId, record.receiptId);
    this.storeRecord(record);
    this.pendingAtomic += cap;
    return { status: "reserved", receiptId: record.receiptId };
  }

  async finalize(record) {
    const current = this.records.get(record.receiptId);
    if (!current) throw new Error("ledger_record_missing");
    if (!["pending", "compensation_required"].includes(current.state)) {
      return this.withReceiptIntegrityAnchor(current);
    }
    const cap = BigInt(current.liabilityAtomic);
    this.pendingAtomic -= cap;
    if (record.state === "active") this.activeAtomic += cap;
    return this.storeRecord(record);
  }

  async release(record) {
    const current = this.records.get(record.receiptId);
    if (!current) return { status: "missing" };
    if (!["pending", "compensation_required"].includes(current.state)) {
      return { status: "not_pending" };
    }
    this.pendingAtomic -= BigInt(current.liabilityAtomic);
    this.records.delete(record.receiptId);
    this.receiptIntegrityAnchors.delete(record.receiptId);
    this.requests.delete(record.requestId);
    this.payments.delete(record.paymentId);
    return { status: "released" };
  }

  async markSettlementState(record) {
    const current = this.records.get(record.receiptId);
    if (!current) throw new Error("ledger_record_missing");
    if (current.state !== "pending") return this.withReceiptIntegrityAnchor(current);
    if (!["submitting", "unknown"].includes(record.settlement?.status)) {
      throw new Error("settlement_recovery_state_required");
    }
    return this.storeRecord(record);
  }

  async markPayoutDue(record) {
    const current = this.records.get(record.receiptId);
    if (!current || current.state !== "active") return this.withReceiptIntegrityAnchor(current);
    const cap = BigInt(current.liabilityAtomic);
    this.activeAtomic -= cap;
    this.payoutDueAtomic += cap;
    return this.storeRecord(record);
  }

  async markPaid(record) {
    const current = this.records.get(record.receiptId);
    if (!current || current.state !== "payout_due") return this.withReceiptIntegrityAnchor(current);
    const transaction = record.payout?.transaction;
    if (!transaction) throw new Error("payout_transaction_missing");
    const usedBy = this.payoutTransactions.get(transaction);
    if (usedBy && usedBy !== record.receiptId) throw new Error("payout_transaction_exists");
    this.payoutDueAtomic -= BigInt(current.liabilityAtomic);
    this.payoutTransactions.set(transaction, record.receiptId);
    return this.storeRecord(record);
  }

  async markReleased(record) {
    const current = this.records.get(record.receiptId);
    if (!current || current.state !== "active") return this.withReceiptIntegrityAnchor(current);
    this.activeAtomic -= BigInt(current.liabilityAtomic);
    return this.storeRecord(record);
  }

  async transitionUniversal(record, expectedStates) {
    const current = this.records.get(record.receiptId);
    if (!current) return null;
    if (!Array.isArray(expectedStates) || !expectedStates.includes(current.state)) {
      return this.withReceiptIntegrityAnchor(current);
    }
    if (!current.universalCovenant?.covenantId) throw new Error("universal_covenant_missing");
    return this.storeRecord(record);
  }

  async list(limit = 50) {
    return [...this.records.values()]
      .slice(-limit)
      .reverse()
      .map((record) => this.withReceiptIntegrityAnchor(record));
  }

  async stats() {
    return {
      activeAtomic: this.activeAtomic.toString(),
      pendingAtomic: this.pendingAtomic.toString(),
      payoutDueAtomic: this.payoutDueAtomic.toString(),
      committedAtomic: (this.activeAtomic + this.pendingAtomic + this.payoutDueAtomic).toString(),
      recordCount: this.records.size,
    };
  }
}

export class RedisLedger {
  constructor({ redis, prefix = process.env.POLICYPOOL_LEDGER_PREFIX } = {}) {
    this.redis = redis || Redis.fromEnv();
    this.prefix = prefixValue(prefix);
  }

  key(kind, id = "") {
    return `${this.prefix}:${kind}${id ? `:${id}` : ""}`;
  }

  attachReceiptIntegrityAnchor(record, anchor) {
    if (!record) return null;
    const resolved = anchor || record.receiptIntegrityAnchor;
    return resolved ? { ...record, receiptIntegrityAnchor: resolved } : record;
  }

  async withReceiptIntegrityAnchor(record) {
    if (!record) return null;
    const anchor = parseRecord(
      await this.redis.get(this.key("receipt-anchor", record.receiptId)),
    );
    return this.attachReceiptIntegrityAnchor(record, anchor);
  }

  async findByPaymentId(paymentId) {
    const id = await this.redis.get(this.key("payment", paymentId));
    return id ? this.get(String(id)) : null;
  }

  async get(receiptId) {
    const [record, anchor] = await Promise.all([
      this.redis.get(this.key("receipt", receiptId)),
      this.redis.get(this.key("receipt-anchor", receiptId)),
    ]);
    return this.attachReceiptIntegrityAnchor(parseRecord(record), parseRecord(anchor));
  }

  async backfillReceiptIntegrityAnchor(receiptId, expectedReceiptHash, anchor) {
    const result = await this.redis.eval(BACKFILL_RECEIPT_INTEGRITY_ANCHOR_SCRIPT, [
      this.key("receipt", receiptId),
      this.key("receipt-anchor", receiptId),
    ], [expectedReceiptHash, JSON.stringify(anchor)]);
    return this.attachReceiptIntegrityAnchor(
      parseRecord(result[1]),
      parseRecord(result[2]),
    );
  }

  async saveQuote(record, ttlSeconds) {
    const result = await this.redis.set(
      this.key("quote", record.id),
      JSON.stringify(record),
      { ex: ttlSeconds, nx: true },
    );
    if (result !== "OK") throw new Error("coverage_quote_collision");
    if (record.buyer) await this.redis.sadd(this.key("buyer-quotes", String(record.buyer).toLowerCase()), record.id);
    return record;
  }

  async getQuote(id) {
    return parseRecord(await this.redis.get(this.key("quote", id)));
  }

  async findOpenQuotesByBuyer(buyer) {
    const key = this.key("buyer-quotes", String(buyer || "").toLowerCase());
    const ids = await this.redis.smembers(key);
    if (!ids.length) return [];
    const values = await this.redis.mget(...ids.map((id) => this.key("quote", String(id))));
    const records = values.map(parseRecord).filter(Boolean);
    const liveIds = new Set(records.map((record) => record.id));
    const stale = ids.filter((id) => !liveIds.has(String(id)));
    if (stale.length) await this.redis.srem(key, ...stale);
    return records;
  }

  async reserve(record, reserveBalanceAtomic) {
    const result = await this.redis.eval(RESERVE_SCRIPT, [
      this.key("request", record.requestId),
      this.key("payment", record.paymentId),
      this.key("receipt", record.receiptId),
      this.key("liability", "active"),
      this.key("liability", "pending"),
      this.key("liability", "payout_due"),
      this.key("receipts"),
    ], [
      record.receiptId,
      JSON.stringify(record),
      String(Date.parse(record.createdAt)),
      record.liabilityAtomic,
      String(reserveBalanceAtomic),
    ]);
    return {
      status: String(result[0]),
      receiptId: result[1] ? String(result[1]) : undefined,
      committedAtomic: result[1] ? String(result[1]) : undefined,
    };
  }

  async finalize(record) {
    const anchor = record.receiptIntegrityAnchor || null;
    const result = await this.redis.eval(FINALIZE_SCRIPT, [
      this.key("receipt", record.receiptId),
      this.key("liability", "pending"),
      this.key("liability", "active"),
      this.key("receipts"),
      this.key("receipt-anchor", record.receiptId),
    ], [
      JSON.stringify(record),
      record.liabilityAtomic,
      record.state,
      String(Date.now()),
      record.receiptId,
      anchor ? JSON.stringify(anchor) : "",
      anchor?.receiptHash || "",
    ]);
    if (String(result[0]) === "missing") throw new Error("ledger_record_missing");
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async release(record) {
    const result = await this.redis.eval(RELEASE_SCRIPT, [
      this.key("request", record.requestId),
      this.key("payment", record.paymentId),
      this.key("receipt", record.receiptId),
      this.key("liability", "pending"),
      this.key("receipt-anchor", record.receiptId),
    ], [record.liabilityAtomic]);
    return { status: String(result[0]) };
  }

  async markSettlementState(record) {
    if (!["submitting", "unknown"].includes(record.settlement?.status)) {
      throw new Error("settlement_recovery_state_required");
    }
    const result = await this.redis.eval(MARK_SETTLEMENT_STATE_SCRIPT, [
      this.key("receipt", record.receiptId),
    ], [JSON.stringify(record)]);
    if (String(result[0]) === "missing") throw new Error("ledger_record_missing");
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async markPayoutDue(record) {
    const result = await this.redis.eval(PAYOUT_DUE_SCRIPT, [
      this.key("receipt", record.receiptId),
      this.key("liability", "active"),
      this.key("liability", "payout_due"),
    ], [JSON.stringify(record), record.liabilityAtomic]);
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async markPaid(record) {
    const result = await this.redis.eval(PAID_SCRIPT, [
      this.key("receipt", record.receiptId),
      this.key("liability", "payout_due"),
      this.key("payout", record.payout.transaction),
    ], [JSON.stringify(record), record.liabilityAtomic, record.receiptId]);
    if (String(result[0]) === "payout_transaction_exists") throw new Error("payout_transaction_exists");
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async markReleased(record) {
    const result = await this.redis.eval(RELEASE_ACTIVE_SCRIPT, [
      this.key("receipt", record.receiptId),
      this.key("liability", "active"),
    ], [JSON.stringify(record), record.liabilityAtomic]);
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async transitionUniversal(record, expectedStates) {
    if (!Array.isArray(expectedStates) || expectedStates.length === 0) {
      throw new Error("universal_transition_states_required");
    }
    const result = await this.redis.eval(TRANSITION_UNIVERSAL_SCRIPT, [
      this.key("receipt", record.receiptId),
    ], [JSON.stringify(record), ...expectedStates]);
    return this.withReceiptIntegrityAnchor(parseRecord(result[1]));
  }

  async list(limit = 50) {
    const ids = await this.redis.zrange(this.key("receipts"), 0, Math.max(0, limit - 1), { rev: true });
    if (!ids.length) return [];
    const values = await this.redis.mget(...ids.map((id) => this.key("receipt", String(id))));
    const anchors = await this.redis.mget(
      ...ids.map((id) => this.key("receipt-anchor", String(id))),
    );
    return values
      .map((value, index) => this.attachReceiptIntegrityAnchor(
        parseRecord(value),
        parseRecord(anchors[index]),
      ))
      .filter(Boolean);
  }

  async stats() {
    const [active, pending, payoutDue, recordCount] = await Promise.all([
      this.redis.get(this.key("liability", "active")),
      this.redis.get(this.key("liability", "pending")),
      this.redis.get(this.key("liability", "payout_due")),
      this.redis.zcard(this.key("receipts")),
    ]);
    const activeAtomic = BigInt(active || 0);
    const pendingAtomic = BigInt(pending || 0);
    const payoutDueAtomic = BigInt(payoutDue || 0);
    return {
      activeAtomic: activeAtomic.toString(),
      pendingAtomic: pendingAtomic.toString(),
      payoutDueAtomic: payoutDueAtomic.toString(),
      committedAtomic: (activeAtomic + pendingAtomic + payoutDueAtomic).toString(),
      recordCount: Number(recordCount || 0),
    };
  }
}

export function createLedger() {
  const hasUpstash = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
    || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
  if (!hasUpstash) throw new Error("durable_ledger_not_configured");
  if (!process.env.UPSTASH_REDIS_REST_URL && process.env.KV_REST_API_URL) {
    process.env.UPSTASH_REDIS_REST_URL = process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = process.env.KV_REST_API_TOKEN;
  }
  return new RedisLedger();
}
