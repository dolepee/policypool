import assert from "node:assert/strict";
import { createProviderBondHandler } from "../api/provider-bond.js";
import { callHandler } from "./lib/fake-vercel.mjs";

const configuration = {
  ready: true,
  policyRegistry: "0x1000000000000000000000000000000000000001",
  bondVault: "0x2000000000000000000000000000000000000002",
};
const values = { minimumBondAtomic: 500_000n, availableBond: 100_000n, allowance: 0n };
const client = {
  async readContract({ functionName }) { return values[functionName]; },
};
const handler = createProviderBondHandler({ configuration, client });
const provider = "0x3000000000000000000000000000000000000003";
const response = await callHandler(handler, {
  method: "POST",
  url: "/api/provider-bond",
  body: { provider, amountUSDT: "0.5" },
});
assert.equal(response.statusCode, 200);
assert.equal(response.json().transactions.length, 2);
assert.equal(response.json().transactions[0].purpose, "approve_provider_bond_vault");
assert.equal(response.json().transactions[1].purpose, "deposit_provider_first_loss_bond");
assert.equal(response.json().resultingAvailableBondAtomic, "600000");

values.allowance = 1_000_000n;
const approved = await callHandler(handler, {
  method: "POST",
  body: { provider, amountUSDT: "0.5" },
});
assert.equal(approved.json().transactions.length, 1);
assert.equal(approved.json().transactions[0].purpose, "deposit_provider_first_loss_bond");

const tooSmall = await callHandler(handler, {
  method: "POST",
  body: { provider, amountUSDT: "0.1" },
});
assert.equal(tooSmall.statusCode, 422);
assert.equal(tooSmall.json().error, "resulting_bond_below_minimum");

values.availableBond = 600_000n;
const existing = await callHandler(handler, {
  method: "POST",
  body: { provider, amountUSDT: "0" },
});
assert.equal(existing.statusCode, 200);
assert.deepEqual(existing.json().transactions, []);
assert.equal(existing.json().resultingAvailableBondAtomic, "600000");

console.log("PolicyPool provider bond passed: existing-bond reuse, minimum check, allowance-aware approve, and non-custodial deposit calldata.");
