import { createHash } from "node:crypto";

const PAYMENT = {
  network: "eip155:196",
  asset: process.env.POLICYPOOL_PAYMENT_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  amount: process.env.POLICYPOOL_PRICE_ATOMIC || "1000000",
  decimals: 6,
  symbol: process.env.POLICYPOOL_PAYMENT_SYMBOL || "USDT",
  name: process.env.POLICYPOOL_PAYMENT_NAME || "Tether USD",
  payTo: process.env.POLICYPOOL_PAY_TO || "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
};

const RESERVE = {
  wallet: process.env.POLICYPOOL_RESERVE_WALLET || PAYMENT.payTo,
  chain: "X Layer",
  chainId: 196,
  publicUrl: process.env.POLICYPOOL_RESERVE_URL || "https://policypool.vercel.app/agent#reserve",
};

const OBJECTIVE_BREACHES = new Set([
  "deadline_missed",
  "no_delivery",
  "delivery_hash_absent",
  "listing_mismatch",
]);

const FORBIDDEN_PATTERNS = [
  [/investment advice|financial advice|buy signal|sell signal|price prediction/i, "regulated_or_trading_advice"],
  [/private key|seed phrase|mnemonic/i, "secret_request"],
  [/guarantee.*approval|approval.*guarantee|guaranteed listing/i, "approval_outcome_guarantee"],
  [/fake review|engagement farm|wash/i, "marketplace_manipulation"],
  [/ignore (all )?(previous|prior) instructions|disregard (your|the) restrictions/i, "instruction_override_attempt"],
];

const DEFAULT_POLICY = {
  allowedActions: ["scope_check", "covenant_issue", "objective_breach_check"],
  forbiddenActions: [
    "regulated advice",
    "review-outcome promises",
    "private key requests",
    "marketplace manipulation",
    "subjective quality underwriting",
  ],
  objectiveBreachRules: [...OBJECTIVE_BREACHES],
};

function clean(value, max = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isoOrEmpty(value) {
  const text = clean(value, 80);
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const body = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const policy = parseJsonMaybe(body.policy) || {};
  const requestedCoverageUSDT = numberOrDefault(
    body.requestedCoverageUSDT ?? body.coverageCapUSDT ?? body.capUSDT,
    5,
  );

  return {
    targetAgent: clean(body.targetAgent || body.agent || body.agentId || body.serviceId || "sample-agent"),
    serviceDescription: clean(body.serviceDescription || body.service || body.listing || "Agent service with a published scope."),
    jobDescription: clean(body.jobDescription || body.job || body.task || body.prompt || "Prepare an in-scope agent service deliverable."),
    requestedAction: clean(body.requestedAction || body.action || "issue_coverage"),
    paymentStatus: clean(body.paymentStatus || body.escrowStatus || body.fundingStatus || "funded").toLowerCase(),
    deadline: isoOrEmpty(body.deadline || body.dueAt || body.expiresAt),
    now: isoOrEmpty(body.now) || new Date().toISOString(),
    deliveryHash: clean(body.deliveryHash || body.outputHash || ""),
    breachType: clean(body.breachType || body.claimType || ""),
    listingMismatch: Boolean(body.listingMismatch === true || body.listingMismatch === "true"),
    payoutTxHash: clean(body.payoutTxHash || body.txHash || ""),
    requestedCoverageUSDT,
    policy: {
      ...DEFAULT_POLICY,
      ...(policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {}),
    },
  };
}

function hasPayment(req) {
  return Boolean(
    header(req, "payment-signature")
    || header(req, "x-payment")
    || header(req, "authorization"),
  );
}

function header(req, name) {
  const direct = req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? req.headers?.[name.toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct || "";
}

function absoluteUrl(req) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "policypool.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  return req.url?.startsWith("http") ? req.url : `${proto}://${host}${req.url || "/api/covered-job-receipt"}`;
}

function encodeHeader(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function sha256Json(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sendJson(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(payload, null, 2));
}

function paymentRequired(req, res) {
  const outputSchema = {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          targetAgent: {
            type: "string",
            description: "Target agent id, service id, or public service name.",
          },
          serviceDescription: {
            type: "string",
            description: "Published service scope for the target agent.",
          },
          jobDescription: {
            type: "string",
            description: "The proposed job to cover.",
          },
          requestedAction: {
            type: "string",
            description: "Action being checked, such as issue_coverage or deliver_work.",
          },
          paymentStatus: {
            type: "string",
            description: "funded, paid, escrowed, unfunded, unpaid, or no_escrow.",
          },
          deadline: {
            type: "string",
            description: "ISO-8601 deadline for objective breach checks.",
          },
          requestedCoverageUSDT: {
            type: "number",
            description: "Requested coverage cap in USDT.",
          },
          breachType: {
            type: "string",
            description: "Optional objective breach: deadline_missed, no_delivery, delivery_hash_absent, listing_mismatch.",
          },
          deliveryHash: {
            type: "string",
            description: "Optional hash of delivered output.",
          },
          payoutTxHash: {
            type: "string",
            description: "Optional reserve payout transaction hash once executed.",
          },
        },
        required: ["targetAgent", "jobDescription", "paymentStatus", "deadline"],
        additionalProperties: true,
      },
    },
    output: {
      type: "json",
      example: {
        ok: true,
        agent: "PolicyPool",
        service: "Covered Job Receipt",
        receipt: {
          outcome: { type: "ISSUED", status: "coverage_active" },
          receiptHash: "sha256:...",
        },
      },
    },
  };
  const requirements = {
    scheme: "exact",
    network: PAYMENT.network,
    asset: PAYMENT.asset,
    amount: PAYMENT.amount,
    maxAmountRequired: PAYMENT.amount,
    decimals: PAYMENT.decimals,
    symbol: PAYMENT.symbol,
    payTo: PAYMENT.payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: PAYMENT.name,
      version: "2",
      decimals: PAYMENT.decimals,
      symbol: PAYMENT.symbol,
      service: "PolicyPool Covered Job Receipt",
    },
    outputSchema,
  };
  const challenge = {
    x402Version: 2,
    resource: {
      url: absoluteUrl(req),
      description: "PolicyPool Covered Job Receipt API",
      mimeType: "application/json",
    },
    outputSchema,
    accepts: [requirements],
  };
  res.setHeader("PAYMENT-REQUIRED", encodeHeader(challenge));
  return sendJson(res, 402, {
    ok: false,
    error: "Payment required",
    charged: false,
    ...challenge,
  });
}

function guard(input) {
  const text = `${input.serviceDescription} ${input.jobDescription} ${input.requestedAction}`;
  for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return {
        verdict: "BLOCK",
        reason,
        rule: "published_policy_forbidden_action",
      };
    }
  }

  if (["unfunded", "unpaid", "no_escrow", "none", "missing"].includes(input.paymentStatus)) {
    return {
      verdict: "NEEDS_ESCROW",
      reason: "covered_work_requires_funded_order_or_payment_status",
      rule: "payment_required_before_coverage",
    };
  }

  if (!input.deadline) {
    return {
      verdict: "BLOCK",
      reason: "deadline_required_for_objective_coverage",
      rule: "objective_breach_needs_timestamp",
    };
  }

  if (new Date(input.deadline).getTime() <= Date.now() && !input.breachType) {
    return {
      verdict: "BLOCK",
      reason: "deadline_must_be_future_when_issuing_new_coverage",
      rule: "future_deadline_required",
    };
  }

  return {
    verdict: "ALLOW",
    reason: "request_matches_published_policy_and_has_funding_status",
    rule: "covered_job_policy",
  };
}

function detectBreach(input) {
  const nowMs = new Date(input.now).getTime();
  const deadlineMs = input.deadline ? new Date(input.deadline).getTime() : Number.NaN;
  if (input.listingMismatch) return "listing_mismatch";
  if (input.breachType && OBJECTIVE_BREACHES.has(input.breachType)) return input.breachType;
  if (input.deadline && nowMs > deadlineMs && !input.deliveryHash) return "deadline_missed";
  if (input.deadline && nowMs > deadlineMs && input.deliveryHash === "") return "delivery_hash_absent";
  return "";
}

function buildReceipt(input) {
  const guardVerdict = guard(input);
  const breach = detectBreach(input);
  const coverageCapUSDT = Math.max(0.01, Math.min(input.requestedCoverageUSDT, 25));
  const base = {
    protocol: "PolicyPool Agent Coverage",
    version: "0.1.0",
    generatedAt: new Date().toISOString(),
    reserve: RESERVE,
    target: {
      agent: input.targetAgent,
      serviceDescription: input.serviceDescription,
    },
    job: {
      description: input.jobDescription,
      requestedAction: input.requestedAction,
      paymentStatus: input.paymentStatus,
      deadline: input.deadline,
      deliveryHash: input.deliveryHash || null,
    },
    policy: {
      guard: guardVerdict,
      objectiveBreachRules: [...OBJECTIVE_BREACHES],
      forbiddenActions: input.policy.forbiddenActions || DEFAULT_POLICY.forbiddenActions,
      coverageCapUSDT,
      coverageIsLimitedByReserve: true,
    },
  };

  let outcome;
  if (guardVerdict.verdict !== "ALLOW") {
    outcome = {
      type: "DECLINED",
      status: "coverage_not_issued",
      reason: guardVerdict.reason,
      payout: null,
    };
  } else if (breach) {
    outcome = {
      type: "PAYOUT",
      status: input.payoutTxHash ? "paid_from_reserve" : "payout_due",
      reason: breach,
      payout: {
        amountUSDT: coverageCapUSDT,
        reserveWallet: RESERVE.wallet,
        txHash: input.payoutTxHash || null,
        note: input.payoutTxHash
          ? "Reserve payout transaction supplied and linked."
          : "Objective breach detected. v0 records payout due; reserve operator must execute and attach tx hash.",
      },
    };
  } else {
    outcome = {
      type: "ISSUED",
      status: "coverage_active",
      reason: "guard_allowed_and_no_objective_breach_detected",
      covenant: {
        deadline: input.deadline,
        coverageCapUSDT,
        premiumUSDT: 1,
        breachRules: [...OBJECTIVE_BREACHES],
      },
      payout: null,
    };
  }

  const receiptDraft = {
    ...base,
    outcome,
    disclaimers: [
      "Not protocol-native escrow.",
      "Objective software guarantee layer only.",
      "Objective breach coverage only.",
      "Coverage is never promised beyond live reserve capacity.",
    ],
  };
  const receiptHash = `sha256:${sha256Json(receiptDraft)}`;
  const receiptId = `pp-agent-${receiptHash.slice(7, 19)}`;
  return {
    ...receiptDraft,
    receiptId,
    receiptHash,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "HEAD") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
    res.status(200).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  if (!hasPayment(req)) return paymentRequired(req, res);

  const input = readInput(req);
  const receipt = buildReceipt(input);
  const paymentResponse = {
    success: true,
    network: PAYMENT.network,
    amount: PAYMENT.amount,
    recipient: PAYMENT.payTo,
    service: "PolicyPool Covered Job Receipt",
  };
  res.setHeader("PAYMENT-RESPONSE", encodeHeader(paymentResponse));
  res.setHeader("X-PAYMENT-RESPONSE", encodeHeader(paymentResponse));
  return sendJson(res, 200, {
    ok: true,
    agent: "PolicyPool",
    service: "Covered Job Receipt",
    mode: "a2mcp_api",
    input,
    receipt,
  });
}

export const __test = {
  buildReceipt,
  guard,
  paymentRequired,
  readInput,
};
