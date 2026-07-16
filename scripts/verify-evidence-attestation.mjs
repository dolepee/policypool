import assert from "node:assert/strict";
import {
  createEvidenceAttestationClient,
  EvidenceAttestationError,
} from "../api/lib/evidence-attestation.js";

const digest = `0x${"11".repeat(32)}`;
const domain = {
  chainId: 196,
  manager: `0x${"55".repeat(20)}`,
  verifier: `0x${"66".repeat(20)}`,
};
const calls = [];
const client = createEvidenceAttestationClient({
  url: "https://evidence.example/attest",
  token: "test-token",
  threshold: 2,
  fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      digest,
      signatures: [`0x${"22".repeat(65)}`, `0x${"33".repeat(65)}`],
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});

const signatures = await client.attest({
  action: "issue",
  digest,
  evidence: { coverageCapAtomic: 500000n },
  context: { acceptanceTxHash: `0x${"44".repeat(32)}` },
  domain,
});
assert.equal(signatures.length, 2);
assert.equal(calls[0].url, "https://evidence.example/attest");
assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
assert.equal(calls[0].body.evidence.coverageCapAtomic, "500000");
assert.equal(calls[0].body.context.acceptanceTxHash, `0x${"44".repeat(32)}`);
assert.deepEqual(calls[0].body.domain, domain);

const invalid = createEvidenceAttestationClient({
  url: "https://evidence.example/attest",
  token: "test-token",
  threshold: 2,
  fetchImpl: async () => new Response(JSON.stringify({
    digest: `0x${"44".repeat(32)}`,
    signatures: [`0x${"22".repeat(65)}`, `0x${"33".repeat(65)}`],
  }), { status: 200 }),
});
await assert.rejects(
  () => invalid.attest({ action: "issue", digest, evidence: {}, domain }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_attestation_response_invalid",
);

assert.throws(
  () => createEvidenceAttestationClient({ url: "http://evidence.example", token: "test", threshold: 2 }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_attestation_url_invalid",
);
await assert.rejects(
  () => client.attest({ action: "unknown", digest, evidence: {}, domain }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_action_invalid",
);
await assert.rejects(
  () => client.attest({ action: "issue", digest, evidence: {}, domain: { chainId: 196 } }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_attestation_domain_invalid",
);
assert.throws(
  () => createEvidenceAttestationClient({ url: "https://evidence.example", token: "", threshold: 2 }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_attestation_token_missing",
);
assert.throws(
  () => createEvidenceAttestationClient({ url: "https://evidence.example", token: "test", threshold: 1 }),
  (error) => error instanceof EvidenceAttestationError && error.code === "evidence_attestation_threshold_invalid",
);

console.log("PolicyPool evidence client passed: HTTPS-only quorum requests, bigint serialization, threshold response validation, and fail-closed errors.");
