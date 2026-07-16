import { fetchOkxAgentPage, findOkxAgentService } from "./okx-agent-page.js";
import { clean, parseUsdtAtomic, sha256 } from "./utils.js";
import { PAYMENT } from "./config.js";

export class CoverageDemandError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.name = "CoverageDemandError";
    this.code = code;
    this.status = status;
  }
}

export function createCoverageDemandService({
  store,
  directory = fetchOkxAgentPage,
  now = () => Date.now(),
  publicOrigin = "https://policypool.vercel.app",
} = {}) {
  if (!store?.recordDemand) throw new CoverageDemandError("provider_policy_store_unavailable", 503);

  async function record(input) {
    const snapshot = await directory(input?.agentId);
    const service = findOkxAgentService(snapshot, input?.serviceId);
    if (!service) throw new CoverageDemandError("target_service_not_found", 404);
    const requestedCoverageAtomic = parseUsdtAtomic(input?.requestedCoverageUSDT || "0", PAYMENT.decimals);
    const taskReference = clean(input?.taskReference, 300);
    const createdAt = new Date(now()).toISOString();
    const day = createdAt.slice(0, 10);
    const dedupeKey = sha256({
      marketplace: "OKX.AI",
      agentId: snapshot.agentId,
      serviceId: service.serviceId,
      taskReference: taskReference ? taskReference.toLowerCase() : null,
      day: taskReference ? null : day,
    });
    const demand = await store.recordDemand({
      dedupeKey,
      createdAt,
      day,
      marketplace: "OKX.AI",
      agentId: snapshot.agentId,
      agentName: snapshot.name,
      serviceId: service.serviceId,
      serviceName: service.name,
      serviceFingerprint: service.fingerprint,
      requestedCoverageAtomic: requestedCoverageAtomic.toString(),
      taskReference: taskReference || null,
      status: "provider_enrollment_required",
    });
    const invite = new URL("/providers/enroll", publicOrigin);
    invite.searchParams.set("agent", snapshot.agentId);
    invite.searchParams.set("service", service.serviceId);
    invite.searchParams.set("demand", demand.demandId);
    return {
      demand,
      enrollmentInvite: invite.toString(),
      buyerCharged: false,
      coverageIssued: false,
    };
  }

  return { record };
}
