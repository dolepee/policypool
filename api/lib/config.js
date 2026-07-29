import { getAddress } from "viem";

export const XLAYER = {
  id: 196,
  network: "eip155:196",
  name: "X Layer",
  rpcUrl: process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
};

export const PAYMENT = {
  asset: getAddress(process.env.POLICYPOOL_PAYMENT_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736"),
  amountAtomic: process.env.POLICYPOOL_PRICE_ATOMIC || "100000",
  decimals: 6,
  symbol: process.env.POLICYPOOL_PAYMENT_SYMBOL || "USD₮0",
  name: process.env.POLICYPOOL_PAYMENT_NAME || "USD₮0",
  version: process.env.POLICYPOOL_PAYMENT_VERSION || "1",
  payTo: getAddress(process.env.POLICYPOOL_PAY_TO || "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7"),
};

export const COVERAGE = {
  reserveWallet: getAddress(process.env.POLICYPOOL_RESERVE_WALLET || PAYMENT.payTo),
  maxAtomic: process.env.POLICYPOOL_MAX_COVERAGE_ATOMIC || "5000000",
  minAtomic: process.env.POLICYPOOL_MIN_COVERAGE_ATOMIC || "500000",
  maxDurationSeconds: Number(process.env.POLICYPOOL_MAX_DURATION_SECONDS || 7 * 24 * 60 * 60),
  publicUrl: process.env.POLICYPOOL_RESERVE_URL || "https://policypool.vercel.app/ledger#reserve",
};

// PolicyPool's own listing. A coverage fee paid straight to the generic HTTP
// endpoint settles correctly but is invisible to OKX, so it never becomes a
// marketplace sale for the listed agent. Buyers kept discovering that only after
// paying, so the identifiers live here and every surface that states the payment
// route reads them from one place.
export const MARKETPLACE = {
  agentId: process.env.POLICYPOOL_OKX_AGENT_ID || "4674",
  serviceId: process.env.POLICYPOOL_OKX_SERVICE_ID || "33290",
  agentUrl: process.env.POLICYPOOL_OKX_AGENT_URL || "https://www.okx.ai/agents/4674",
  // OKX withdrew the anonymous task fields needed to bind a public task page
  // to its X Layer job. Keep discovery and execution on the same fail-closed
  // switch so callers are never told a disabled evidence path is usable.
  publicTaskEvidenceAvailable: false,
  publicTaskEvidenceUnavailableReason: "okx_public_task_evidence_withdrawn",
};

export const OKX_TASK = {
  escrow: getAddress(process.env.POLICYPOOL_OKX_TASK_ESCROW || "0x000000eb79a0c9cbeed4bd63372653e28f6bedbe"),
  statusChangedTopic: "0x4d7781468081641aba2c04c3349fcf5830b9fedac1b7aaffabc1f1dc6b8883fb",
  createdTopic: "0x50d71e89bdcdc5deb2d37b31af9cbedc06bab12894960fbbd71135d142e7102d",
  acceptedTopic: "0x49c131ab4997b3c3791e5e208b585c027c75b36373559faece1d17bb38a1cac7",
};

export const EVIDENCE_RESOLVER = {
  creationHintRadiusBlocks: 120,
  maxAutomaticAcceptanceScanBlocks: 1_800,
};

export const ONCHAIN_EVIDENCE_LIMITATIONS = Object.freeze([
  Object.freeze({
    whenPolicy: "serviceType is A2A and the policy is enrolled on the v0.4 stack",
    reason: "direct_evidence_unavailable_for_universal_a2a",
    note: "Reconciliation for these covenants reads the withdrawn public task page, so coverage bought this way could not release or pay out. It is refused rather than sold.",
  }),
]);

export const OBJECTIVE_BREACH_RULES = [
  "accepted_job_still_undelivered_after_deadline",
];

export function paymentRequirements() {
  return {
    scheme: "exact",
    network: XLAYER.network,
    asset: PAYMENT.asset,
    amount: PAYMENT.amountAtomic,
    maxAmountRequired: PAYMENT.amountAtomic,
    payTo: PAYMENT.payTo,
    symbol: "USDT",
    decimals: PAYMENT.decimals,
    maxTimeoutSeconds: 600,
    extra: {
      name: PAYMENT.name,
      version: PAYMENT.version,
    },
  };
}
