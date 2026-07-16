export class PolicyPoolClient {
  constructor({ origin = "https://policypool.vercel.app", fetchImpl = globalThis.fetch } = {}) {
    this.origin = String(origin).replace(/\/$/, "");
    this.fetch = fetchImpl;
    if (typeof this.fetch !== "function") throw new TypeError("fetch implementation required");
  }

  async request(path, body, headers = {}) {
    const response = await this.fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok && response.status !== 402) {
      const error = new Error(payload.error || `PolicyPool request failed: ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return { status: response.status, headers: response.headers, payload };
  }

  preflight({ agentId, serviceId, taskReference, requestedCoverageUSDT }) {
    return this.request("/api/coverage-preflight", {
      targetAgent: String(agentId),
      targetServiceId: String(serviceId),
      taskReference,
      requestedCoverageUSDT,
    });
  }

  recordDemand({ agentId, serviceId, taskReference, requestedCoverageUSDT }) {
    return this.request("/api/coverage-demand", {
      agentId: String(agentId),
      serviceId: String(serviceId),
      taskReference,
      requestedCoverageUSDT,
    });
  }

  prepareEnrollment(input) {
    return this.request("/api/provider-enrollment", { ...input, action: "prepare" });
  }

  submitEnrollment(input) {
    return this.request("/api/provider-enrollment", { ...input, action: "submit" });
  }

  confirmEnrollment({ enrollmentId, transactionHash }) {
    return this.request("/api/provider-enrollment", {
      action: "confirm",
      enrollmentId,
      transactionHash,
    });
  }

  relayProviderRequest({ relayGrant, ...input }, paymentSignature = "") {
    if (!relayGrant) throw new TypeError("relayGrant from an active PolicyPool covenant is required");
    return this.request(
      "/api/provider-relay",
      { ...input, relayGrant },
      paymentSignature ? { "payment-signature": paymentSignature } : {},
    );
  }
}
