#!/usr/bin/env node

import { spawn } from "node:child_process";

const steps = [
  ["forge", ["fmt", "--check"], "format check"],
  ["forge", ["build", "--sizes"], "contract build"],
  ["forge", ["test", "-q"], "contract tests"],
  ["npm", ["run", "build", "--prefix", "web"], "web build"],
  ["node", ["--dns-result-order=ipv4first", "scripts/verify-deployment.mjs"], "live deployment verifier"],
  ["node", ["--dns-result-order=ipv4first", "scripts/verify-proof.mjs"], "live proof verifier"],
  ["node", ["--dns-result-order=ipv4first", "scripts/verify-surge.mjs"], "live surge verifier"],
];

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

for (const [command, args, label] of steps) {
  await run(command, args, label);
}

console.log("\nPolicyPool full verification passed.");
