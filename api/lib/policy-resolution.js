import { findPublishedPolicy } from "./policy-registry.js";
import { createProviderPolicyStore } from "./provider-policy-store.js";
import { createUniversalPolicyResolver, UniversalPolicyError } from "./universal-policy.js";
import { universalConfiguration } from "./universal-config.js";

function agentIdFromReference(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(?:^|#)(\d{1,12})$/);
  return match ? match[1] : /^\d{1,12}$/.test(raw) ? raw : "";
}

export function createCoveragePolicyResolver(dependencies = {}) {
  const configuration = dependencies.configuration || universalConfiguration();
  let runtimeStore = dependencies.store;
  let runtimeUniversal = dependencies.universalResolver;
  const getStore = () => (runtimeStore ||= createProviderPolicyStore());
  const getUniversal = () => (runtimeUniversal ||= createUniversalPolicyResolver({
    ...dependencies,
    configuration,
    store: getStore(),
  }));

  async function resolve(targetAgent, targetServiceId = "") {
    const published = findPublishedPolicy(targetAgent);
    if (published) {
      if (targetServiceId && !published.serviceIds.includes(String(targetServiceId))) {
        throw new UniversalPolicyError("target_service_not_in_registered_policy");
      }
      return { policy: published, source: "v0.3_static_registry" };
    }
    if (!configuration.ready) return { policy: null, source: "universal_registry_inactive" };
    const agentId = agentIdFromReference(targetAgent);
    if (!agentId) throw new UniversalPolicyError("target_agent_id_required");
    if (!/^\d{1,12}$/.test(String(targetServiceId || ""))) {
      throw new UniversalPolicyError("target_service_id_required");
    }
    return {
      policy: await getUniversal().resolve({ agentId, serviceId: String(targetServiceId) }),
      source: "v0.4_provider_enrollment_registry",
    };
  }

  return { resolve };
}
