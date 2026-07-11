import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";

const directory = mkdtempSync(join(tmpdir(), "policypool-payout-run-"));
process.env.POLICYPOOL_PAYOUT_RUN_DIRECTORY = directory;

const { __test } = await import("./settle-controlled-breach.mjs");

const receiptId = "ppc-1234567890abcdef";
const reserveWallet = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const amountAtomic = 500000n;
const serializedTransaction = "0x02f86c";
let prepareCalls = 0;
let signCalls = 0;

const publicClient = {
  async prepareTransactionRequest(request) {
    prepareCalls += 1;
    return { ...request, chainId: 196, nonce: 7, gas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  },
};
const account = {
  async signTransaction() {
    signCalls += 1;
    return serializedTransaction;
  },
};

try {
  const prepared = await __test.preparePayoutRun({
    publicClient,
    account,
    receiptId,
    reserveWallet,
    recipient,
    amountAtomic,
  });
  assert.equal(prepared.transaction, keccak256(serializedTransaction));
  assert.equal(prepareCalls, 1);
  assert.equal(signCalls, 1);

  const recovered = await __test.preparePayoutRun({
    publicClient,
    account,
    receiptId,
    reserveWallet,
    recipient,
    amountAtomic,
  });
  assert.deepEqual(recovered, prepared);
  assert.equal(prepareCalls, 1, "a retry must reuse the journaled transaction request");
  assert.equal(signCalls, 1, "a retry must never sign a second payout transaction");

  const stored = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8"));
  assert.equal(stored.transaction, prepared.transaction);

  await assert.rejects(
    __test.preparePayoutRun({
      publicClient,
      account,
      receiptId,
      reserveWallet,
      recipient,
      amountAtomic: amountAtomic + 1n,
    }),
    /payout_run_amount_mismatch/,
  );

  let broadcasts = 0;
  const broadcastClient = {
    async sendRawTransaction() {
      broadcasts += 1;
      return prepared.transaction;
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  };
  assert.equal(await __test.broadcastPayoutRun(broadcastClient, prepared), prepared.transaction);
  assert.equal(broadcasts, 1);

  const alreadyKnownClient = {
    async sendRawTransaction() {
      throw new Error("already known");
    },
    async getTransaction({ hash }) {
      return { hash };
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  };
  assert.equal(await __test.broadcastPayoutRun(alreadyKnownClient, prepared), prepared.transaction);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("PolicyPool payout runner passed: signed transaction journaling, mismatch rejection, and retry recovery prevent double payment.");
