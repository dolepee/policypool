import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = new Map([
  ["home.html", "/"],
  ["coverage.html", "/coverage"],
  ["ledger.html", "/ledger"],
  ["proof.html", "/proof"],
  ["providers.html", "/providers"],
]);
const subordinatePages = new Map([["enroll.html", "/providers/enroll"]]);
const navigation = ["/coverage", "/ledger", "/proof", "/providers"];

for (const [file, route] of pages) {
  const html = await readFile(new URL(`../web/${file}`, import.meta.url), "utf8");
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${file} must have one h1`);
  assert.equal((html.match(/<main\b/g) || []).length, 1, `${file} must have one main landmark`);
  assert.match(html, /class="desktop-nav"/, `${file} must include desktop navigation`);
  assert.match(html, /class="mobile-nav"/, `${file} must include mobile navigation`);
  assert.match(html, /class="system-strip"/, `${file} must expose live operating status`);
  assert.equal((html.match(/class="system-strip-item"/g) || []).length, 4, `${file} must show four operating metrics`);
  assert.match(html, /coverage-site\.css/, `${file} must use the PolicyPool product system`);
  assert.match(html, /coverage-site\.js/, `${file} must use the shared live-data layer`);
  for (const destination of navigation) {
    assert.ok(html.includes(`href="${destination}"`), `${file} must link to ${destination}`);
  }
  assert.ok(html.includes('href="/api/manifest"'), `${file} must link to the machine-readable API manifest`);
  const canonical = route === "/" ? "https://policypool.vercel.app/" : `https://policypool.vercel.app${route}`;
  assert.ok(html.includes(`rel="canonical" href="${canonical}"`), `${file} canonical mismatch`);
}
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
assert.ok(
  vercel.routes.some((entry) => entry.src === "/.well-known/policypool.json" && entry.dest === "/api/manifest.js"),
  "well-known PolicyPool manifest route must stay stable",
);
for (const [file, route] of pages) {
  const source = route === "/" ? "^/$" : route;
  assert.ok(
    vercel.routes.some((entry) => entry.src === source && entry.dest === `/web/${file}`),
    `vercel route ${route} must resolve to ${file}`,
  );
}

const legacyAgent = await readFile(new URL("../web/agent.html", import.meta.url), "utf8");
assert.match(legacyAgent, /http-equiv="refresh" content="0; url=\/"/, "legacy /agent page must redirect home");

const providers = await readFile(new URL("../web/providers.html", import.meta.url), "utf8");
assert.match(providers, /FOUNDING REGISTRY \/ 03 POLICIES/, "provider registry must publish all three founding policies");
assert.match(providers, /href="\/providers\/enroll"/, "provider registry must expose enrollment without adding a nav item");
assert.match(providers, /Warden/, "Warden versioned status must be visible");
assert.match(providers, /v0\.3 state<\/dt><dd>Pending clock adapter/, "Warden v0.3 directory status must remain explicit");
assert.match(providers, /Canonical v0\.4<\/dt><dd>Not enrolled/, "Warden must not be presented as enrolled on the canonical stack");
assert.match(providers, /independent audit and operationally independent signer topology/, "v0.4 enrollment must name the remaining activation gates");
assert.match(providers, /0\.5 USD₮0 cap/, "Warden's published cap must be visible");
assert.match(providers, /id="universal-provider-registry"/, "providers page must expose the signed v0.4 registry surface");
assert.match(providers, /last-confirmed enrollment/, "provider projection must not claim live coverability without quote-time revalidation");
for (const provider of ["glassdesk", "foreman", "warden"]) {
  assert.match(providers, new RegExp(`id="provider-${provider}"`), `${provider} policy must have a stable share anchor`);
  assert.match(providers, new RegExp(`data-copy-link="/providers#provider-${provider}"`), `${provider} policy must expose a copy link`);
}

const proof = await readFile(new URL("../web/proof.html", import.meta.url), "utf8");
assert.match(proof, /id="external-usage"/, "proof room must expose external usage separately from controlled proofs");
assert.match(proof, /Buyer-funded covenants/, "external usage must lead with buyer-funded evidence");
assert.match(proof, /controlled tests remain excluded/, "external usage must preserve the controlled-proof boundary");
assert.match(proof, /id="v04-house-proof"/, "proof room must expose the controlled v0.4 payout proof");
assert.equal((proof.match(/>Paid<\/b>/g) || []).length, 2, "v0.4 proof must show both fixed credits Paid");
assert.match(proof, /0x1b65afdc6f50e18a0dca2dd026b6450407234e0860e4e547b02a8c98dcc3e631/, "first v0.4 settlement receipt must be linked");
assert.match(proof, /0x14529d6d09489f8e446db8fa8cc70aac71e21aa529864a726dce04c5946aa44b/, "second v0.4 settlement receipt must be linked");
assert.match(proof, /public v0\.4 flags off/, "v0.4 proof must retain the flag-off boundary");
assert.doesNotMatch(proof, /NET-LOSS CREDIT|0\.3 USD₮0|state-pending">PayoutDue/, "v0.4 proof must not retain the invalid reduced-payout claim");
assert.match(proof, /href="\/proof\/receipt"/, "proof room must expose the public receipt verifier for receipts it does not itself display");

const coverageScript = await readFile(new URL("../web/coverage-site.js", import.meta.url), "utf8");
for (const receiptId of ["ppc-6c3d1dbe749cca96", "ppc-136a34aee2022a42", "ppc-5e59d4e5300b6fc3"]) {
  assert.ok(coverageScript.includes(receiptId), `external proof catalog must include ${receiptId}`);
}
assert.match(coverageScript, /data-copy-link/, "shared product script must support copyable public proof links");
assert.match(coverageScript, /Provider bond free/, "universal preflight results must identify provider-bond funding");

const coverage = await readFile(new URL("../web/coverage.html", import.meta.url), "utf8");
assert.match(
  coverage,
  /<option value="Warden#3808" data-service-id="33461" disabled>Warden #3808 · v0\.3 pending clock adapter<\/option>/,
  "coverage form must expose but disable the pending Warden v0.3 policy",
);
assert.match(coverage, /Another OKX\.AI service/, "coverage form must accept demand for an unenrolled service");
assert.match(coverage, /name="targetServiceId"/, "coverage form must bind dynamic policies to a service id");

// A public task URL cannot be quoted since OKX withdrew the fields binding it to
// an on-chain job. A visitor must not be left thinking the service is broken,
// and a notice that only says "unavailable" is barely better. It has to name the
// path that still works, itself, rather than promise one the page never shows.
// Extract the notice before asserting on it. Searching the whole page would let
// the notice drop a required field while an unrelated mention elsewhere keeps
// the gate green, which is the failure mode these checks exist to prevent.
const evidenceNotice = coverage.match(/<div class="evidence-notice"[\s\S]*?<\/div>/)?.[0] || "";
assert.ok(evidenceNotice, "coverage form must disclose the withdrawn public task evidence");
// Every field the paid endpoint actually requires, verified against production:
// omitting targetAgent returns target_agent_required and omitting jobDescription
// returns job_description_required, so a notice listing only the three evidence
// hashes sends a visitor into a rejection.
for (const field of [
  "targetAgent",
  "jobDescription",
  "targetJobId",
  "targetCreationTxHash",
  "targetAcceptanceTxHash",
]) {
  assert.match(evidenceNotice, new RegExp(`<code>${field}</code>`), `the notice must name ${field} as a required input`);
}
// A bare public task ID resolves to the same withdrawn page as a URL, so the
// disclosure must cover both forms.
assert.match(evidenceNotice, /in either form/, "the notice must cover public task IDs as well as URLs");
// The notice must not read as an obituary. Coverage is still purchasable on this
// page, and a visitor has to be told so rather than left to infer the product is
// down.
assert.match(
  evidenceNotice,
  /still fully available|still available/i,
  "the notice must say coverage can still be bought here, not merely that a path is gone",
);

// The notice must not present the buyer's own description as something
// PolicyPool proves. OKX publishes no authenticated mapping from an accepted
// order to a listed service, so grouping jobDescription with the escrow-verified
// fields tells a visitor the opposite of what the API returns, moments before
// they pay.
assert.match(evidenceNotice, /Proved against the task escrow/, "the notice must separate proved evidence");
assert.match(evidenceNotice, /Taken on trust/, "the notice must name what it cannot prove");
const provedClause = evidenceNotice.match(/Proved against the task escrow:[\s\S]*?<\/p>/)?.[0] || "";
const trustedClause = evidenceNotice.match(/Taken on trust:[\s\S]*?<\/p>/)?.[0] || "";
assert.ok(provedClause && trustedClause, "both halves of the disclosure must be present");
assert.doesNotMatch(
  provedClause,
  /<code>jobDescription<\/code>/,
  "jobDescription is buyer-written and must not appear among the proved fields",
);
assert.match(
  trustedClause,
  /<code>jobDescription<\/code>/,
  "jobDescription must be named among the fields taken on trust",
);

// The working path has to be the form itself, not a URL a visitor is told to
// construct by hand. Assert the inputs exist and are named exactly as the API
// reads them, so a rename on either side breaks the gate rather than the page.
const coverageForm = coverage.match(/<form class="coverage-form-card"[\s\S]*?<\/form>/)?.[0] || "";
assert.ok(coverageForm, "the coverage page must still carry the preflight form");
for (const field of [
  "targetJobId",
  "targetCreationTxHash",
  "targetAcceptanceTxHash",
  "targetBuyer",
  "jobDescription",
]) {
  assert.match(
    coverageForm,
    new RegExp(`name="${field}"`),
    `the form must collect ${field} so direct evidence is usable without hand-writing a request`,
  );
}

// The mode switch must offer the working path selected and the withdrawn one
// visibly unavailable, rather than silently dropping it.
const modeSwitch = coverageForm.match(/<fieldset class="mode-switch"[\s\S]*?<\/fieldset>/)?.[0] || "";
assert.ok(modeSwitch, "the form must let a visitor see which evidence modes exist");
assert.match(
  modeSwitch,
  /value="verified_onchain_evidence"[^>]*checked/,
  "the working mode must be the default",
);
assert.match(
  modeSwitch,
  /value="public_task_reference"[^>]*disabled/,
  "the withdrawn mode must be shown disabled rather than offered or hidden",
);

// An enrolled v0.4 A2A policy still requires the public task reference. Without a
// field for it the form can never cover one, since its request carries only the
// advertised direct fields.
assert.match(
  coverageForm,
  /id="coverage-direct-task"[^>]*name="taskReference"/,
  "the form must let a direct request carry a task reference for A2A policies",
);
assert.match(
  coverageForm,
  /id="coverage-direct-task"[^>]*data-optional="true"/,
  "the reference is conditional, so it must not be demanded of every direct request",
);
// Exactly one submittable input may own the name, or FormData becomes ambiguous.
assert.equal(
  (coverageForm.match(/name="taskReference"/g) || []).length,
  1,
  "only one input may carry the taskReference name",
);

// The same disclosure lives in three places and has now been narrowed to "URL"
// twice. parseOkxTaskReference normalises a bare task id and a URL to the same
// withdrawn page, so any surface that scopes the outage to URLs alone sends a
// reader into a preflight guaranteed to fail.
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

// Scope each assertion to the passage it actually governs. A negative on the
// whole file only rejects one phrasing, and a positive on the whole file is
// satisfied by the withdrawal record further down, so neither constrains the
// coverage loop at all.
const coverageLoopStep = readme.match(/^2\. The free preflight[^\n]*$/m)?.[0] || "";
assert.ok(coverageLoopStep, "the coverage loop must still document the preflight step");
assert.match(
  coverageLoopStep,
  /entire public-task-reference path[^\n]*unavailable/,
  "coverage loop step 2 must scope the outage to the whole public-reference path",
);
assert.match(
  coverageLoopStep,
  /bare task id/,
  "coverage loop step 2 must say a bare task id is unavailable too, not only a URL",
);

const withdrawalRecord = readme.match(/^## Why Evidence Binds To Chain$[\s\S]*?(?=^## )/m)?.[0] || "";
assert.ok(withdrawalRecord, "the withdrawal record must stay in the README");
assert.match(
  withdrawalRecord,
  /public task reference in either form/,
  "the withdrawal record must state that a bare task id is equally unavailable",
);
for (const field of ["targetAgent", "jobDescription", "targetJobId", "targetCreationTxHash", "targetAcceptanceTxHash"]) {
  assert.match(withdrawalRecord, new RegExp(`\`${field}\``), `the README fallback must name ${field}`);
}

for (const [file, route] of subordinatePages) {
  const html = await readFile(new URL(`../web/${file}`, import.meta.url), "utf8");
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${file} must have one h1`);
  assert.equal((html.match(/class="desktop-nav"/g) || []).length, 1, `${file} must retain the five-item navigation`);
  const desktopNav = html.match(/<nav class="desktop-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((desktopNav.match(/<a\b/g) || []).length, 5, `${file} desktop nav must contain exactly five links`);
  assert.ok(html.includes(`rel="canonical" href="https://policypool.vercel.app${route}"`), `${file} canonical mismatch`);
  assert.match(html, /id="enrollment-form"/, "provider enrollment must expose the signed policy form");
  assert.match(html, /Shared reserve<\/dt><dd>Off by default/, "provider enrollment must disclose that shared reserve is disabled");
  assert.match(html, /id="connect-wallet"[^>]*disabled/, "provider enrollment must fail closed before the manifest enables it");
  assert.match(html, /name="twitter:title"/, "provider enrollment must include a Twitter title");
  assert.match(html, /name="twitter:description"/, "provider enrollment must include a Twitter description");
  assert.match(html, /name="twitter:image"/, "provider enrollment must include a Twitter image");
}

console.log("PolicyPool product-site gate passed: five routes, shared navigation, metadata, and legacy redirect.");
