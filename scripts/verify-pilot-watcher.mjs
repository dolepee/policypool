// The pilot watcher decides whether it is safe to withhold delivery on a job a
// real buyer has paid for. Its single most important assertion is that the buyer
// is not PolicyPool's own wallet, because that is the whole claim the pilot
// makes. This checks the guard can actually reach that conclusion.
import assert from "node:assert/strict";
import { buyerAddress } from "./pilot-acceptance-watcher.mjs";

const HOUSE = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";
const KEJI = "0x52e19669d7b199531bf689f7ec943632bd211b75";

// Shape one, seen on all three live receipts: targetJob carries a plain address.
assert.equal(
  buyerAddress("0x52E19669d7b199531bF689f7ec943632Bd211B75", { address: KEJI }),
  KEJI,
  "a verified target job reports the buyer as a checksummed string",
);

// Shape two: an unverified target job falls back to a literal with no buyer at
// all, so the only remaining source is receipt.buyer, which is an object. This
// is the case that used to produce "[object Object]" — truthy, and therefore
// silently accepted by both the presence check and the house-wallet check.
assert.equal(
  buyerAddress(undefined, { address: "0x52E19669d7b199531bF689f7ec943632Bd211B75" }),
  KEJI,
  "an object-shaped buyer must resolve to its address, not to its stringification",
);
const stringified = String({ address: KEJI });
assert.notEqual(stringified, KEJI);
assert.notEqual(
  buyerAddress(undefined, { address: KEJI }),
  stringified,
  "the guard must never compare against a stringified object",
);

// The house wallet must still be recognised through either shape, or the pilot
// could confirm a receipt it paid to itself and report it as independent.
assert.equal(buyerAddress({ address: HOUSE }), HOUSE, "the house wallet must resolve through the object shape");
assert.equal(buyerAddress(HOUSE.toUpperCase().replace("0X", "0x")), HOUSE, "comparison must be case-insensitive");

// Anything that is not an address resolves to nothing, so the caller's
// `if (!buyer)` refusal fires instead of a comparison against a shape.
for (const bad of [undefined, null, "", {}, { address: null }, { address: "not-an-address" }, "0x1234", 42, []]) {
  assert.equal(buyerAddress(bad), "", `a buyer of ${JSON.stringify(bad) ?? "undefined"} must resolve to nothing`);
}
// A truncated or over-long address is not an address.
assert.equal(buyerAddress(`${KEJI}00`), "", "an over-long address must be rejected");
assert.equal(buyerAddress(KEJI.slice(0, -1)), "", "a truncated address must be rejected");

// Candidates are tried in order and the first usable one wins, so a present
// targetJob buyer is never overridden by the receipt-level fallback.
assert.equal(buyerAddress(KEJI, { address: HOUSE }), KEJI, "the first usable candidate must win");
assert.equal(buyerAddress(undefined, HOUSE), HOUSE, "an unusable candidate must not stop the search");

console.log(
  "PolicyPool pilot watcher passed: buyer identity resolves from either receipt shape,"
  + " rejects non-addresses, and cannot be satisfied by a stringified object.",
);
