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
assert.match(providers, /Warden/, "external provider opt-in must be visible");
assert.match(providers, /Clock adapter pending/, "Warden must not be presented as coverable before its clock is verifiable");
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

const coverageScript = await readFile(new URL("../web/coverage-site.js", import.meta.url), "utf8");
for (const receiptId of ["ppc-6c3d1dbe749cca96", "ppc-136a34aee2022a42", "ppc-5e59d4e5300b6fc3"]) {
  assert.ok(coverageScript.includes(receiptId), `external proof catalog must include ${receiptId}`);
}
assert.match(coverageScript, /data-copy-link/, "shared product script must support copyable public proof links");
assert.match(coverageScript, /Provider bond free/, "universal preflight results must identify provider-bond funding");

const coverage = await readFile(new URL("../web/coverage.html", import.meta.url), "utf8");
assert.match(
  coverage,
  /<option value="Warden#3808" data-service-id="33461" disabled>Warden #3808 · opted in, clock adapter pending<\/option>/,
  "coverage form must expose but disable the pending Warden policy",
);
assert.match(coverage, /Another OKX\.AI service/, "coverage form must accept demand for an unenrolled service");
assert.match(coverage, /name="targetServiceId"/, "coverage form must bind dynamic policies to a service id");

for (const [file, route] of subordinatePages) {
  const html = await readFile(new URL(`../web/${file}`, import.meta.url), "utf8");
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${file} must have one h1`);
  assert.equal((html.match(/class="desktop-nav"/g) || []).length, 1, `${file} must retain the five-item navigation`);
  const desktopNav = html.match(/<nav class="desktop-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((desktopNav.match(/<a\b/g) || []).length, 5, `${file} desktop nav must contain exactly five links`);
  assert.ok(html.includes(`rel="canonical" href="https://policypool.vercel.app${route}"`), `${file} canonical mismatch`);
  assert.match(html, /id="enrollment-form"/, "provider enrollment must expose the signed policy form");
  assert.match(html, /Shared reserve<\/dt><dd>Off by default/, "provider enrollment must disclose that shared reserve is disabled");
}

console.log("PolicyPool product-site gate passed: five routes, shared navigation, metadata, and legacy redirect.");
