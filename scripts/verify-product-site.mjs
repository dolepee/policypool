import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = new Map([
  ["home.html", "/"],
  ["coverage.html", "/coverage"],
  ["ledger.html", "/ledger"],
  ["proof.html", "/proof"],
  ["providers.html", "/providers"],
]);
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
assert.match(providers, /LIVE REGISTRY \/ 03 POLICIES/, "provider registry must publish all three policies");
assert.match(providers, /Warden/, "external provider opt-in must be visible");
assert.match(providers, /Clock adapter pending/, "Warden must not be presented as coverable before its clock is verifiable");
assert.match(providers, /0\.5 USD₮0 cap/, "Warden's published cap must be visible");

const coverage = await readFile(new URL("../web/coverage.html", import.meta.url), "utf8");
assert.match(
  coverage,
  /<option value="Warden#3808" disabled>Warden #3808 · opted in, clock adapter pending<\/option>/,
  "coverage form must expose but disable the pending Warden policy",
);

console.log("PolicyPool product-site gate passed: five routes, shared navigation, metadata, and legacy redirect.");
