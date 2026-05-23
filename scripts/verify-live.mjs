#!/usr/bin/env node

import { spawn } from "node:child_process";

const steps = [
  ["node", ["--dns-result-order=ipv4first", "scripts/verify-deployment.mjs"], "deployed Hook and pool policy state"],
  ["node", ["--dns-result-order=ipv4first", "scripts/verify-proof.mjs"], "live accepted/refused receipts"],
];

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit",
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

console.log("\nPolicyPool live proof passed.");
