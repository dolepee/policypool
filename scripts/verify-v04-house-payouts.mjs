import assert from "node:assert/strict";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { PAYMENT, XLAYER } from "../api/lib/config.js";

const ADDRESSES = {
  manager: getAddress("0xb6c94274f8d7F7f7eBb600B3C848605e0b786468"),
  vault: getAddress("0x9BECf4688011a2Ee6b07bfdBe7596e96DEB411ff"),
  escrow: getAddress("0xEfeD21a5D82E3b91C9501cb8d9D9d3bF864E7b76"),
  provider: getAddress("0x4ABBAe03affF90F50d4F6B42b3E362f5228aD4C7"),
  buyer: getAddress("0x20674015759fD2C33295b329b3d03C645FD08442"),
};

const PAYOUT_ATOMIC = 500_000n;
const SEPARATE_PROVIDER_REFUND_ATOMIC = 200_000n;
const PAID_STATE = 5;

const managerAbi = parseAbi([
  "function SETTLEMENT_CHALLENGE_PERIOD() view returns (uint256)",
  "function getCovenant(bytes32 covenantId) view returns ((bytes32 id,bytes32 policyId,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 issuedAt,uint64 startAt,uint64 deadline,uint64 enrollmentExpiresAt,uint64 payoutDueAt,uint64 completedAt,uint64 recoveryObservedAt,uint32 slaSeconds,uint8 payoutBasis,uint8 clockMode,uint8 state,uint128 payoutAtomic,bytes32 acceptanceEvidenceHash,bytes32 breachEvidenceHash,bytes32 recoveryEvidenceHash,bytes32 feeAuthorizationHash,uint64 feeAuthorizationValidBefore,bool recoveryFinalized))",
  "event CovenantSettled(bytes32 indexed covenantId,uint256 payoutAtomic,uint256 escrowRefundAtomic,uint256 otherRecoveryAtomic,uint256 recoveryObservedAt,bool recoveryFinalized,bytes32 recoveryEvidenceHash,bytes32 evidenceDigest,uint8 finalState)",
]);

const vaultAbi = parseAbi([
  "function account(address provider) view returns ((uint256 balance,uint256 locked,uint256 queuedWithdrawal,uint64 withdrawalReadyAt))",
  "function covenantLocks(bytes32 covenantId) view returns (address provider,uint256 amount,bool active)",
  "event BondSlashed(bytes32 indexed covenantId,address indexed provider,address indexed recipient,uint256 payout,uint256 unlockedRemainder)",
]);

const escrowAbi = parseAbi([
  "function totalEscrowedAtomic() view returns (uint256)",
]);

const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

const proofs = [
  {
    label: "fixed SLA credit A",
    covenantId: "0x0eb81403450dc748d4936882e887ca525958fff8f458c9c1ebfd2fda50061b96",
    transactionHash: "0x1b65afdc6f50e18a0dca2dd026b6450407234e0860e4e547b02a8c98dcc3e631",
  },
  {
    label: "fixed SLA credit B",
    covenantId: "0x165b3d119fa823120143b36bd82a58542484252b6d39ea4556d0eb81df2be9cb",
    transactionHash: "0x14529d6d09489f8e446db8fa8cc70aac71e21aa529864a726dce04c5946aa44b",
  },
];

const separateProviderRefund = {
  transactionHash: "0x85f200d583e99f9160f0f1040602bb6b78cdd515524efd690c6804b71874afa0",
};

const client = createPublicClient({
  chain: {
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [XLAYER.rpcUrl] } },
  },
  transport: http(XLAYER.rpcUrl),
});

const challengePeriod = await client.readContract({
  address: ADDRESSES.manager,
  abi: managerAbi,
  functionName: "SETTLEMENT_CHALLENGE_PERIOD",
});
assert.equal(challengePeriod, 86_400n, "manager settlement challenge must be exactly 24 hours");

function oneEvent(receipt, address, abi, eventName) {
  const matches = receipt.logs
    .filter((log) => getAddress(log.address) === getAddress(address))
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi, eventName, data: log.data, topics: log.topics, strict: true });
        return decoded.eventName === eventName ? [decoded.args] : [];
      } catch {
        return [];
      }
    });
  assert.equal(matches.length, 1, `${eventName} must appear exactly once`);
  return matches[0];
}

for (const proof of proofs) {
  const [receipt, covenant, lock] = await Promise.all([
    client.getTransactionReceipt({ hash: proof.transactionHash }),
    client.readContract({
      address: ADDRESSES.manager,
      abi: managerAbi,
      functionName: "getCovenant",
      args: [proof.covenantId],
    }),
    client.readContract({
      address: ADDRESSES.vault,
      abi: vaultAbi,
      functionName: "covenantLocks",
      args: [proof.covenantId],
    }),
  ]);

  assert.equal(receipt.status, "success", `${proof.label} receipt must succeed`);
  assert.equal(getAddress(receipt.to), ADDRESSES.manager, `${proof.label} must execute through the manager`);
  const settlementBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  assert.ok(
    settlementBlock.timestamp > covenant.payoutDueAt + challengePeriod,
    `${proof.label} must settle only after the complete challenge period`,
  );

  const transfer = oneEvent(receipt, PAYMENT.asset, tokenAbi, "Transfer");
  assert.equal(getAddress(transfer.from), ADDRESSES.vault, `${proof.label} transfer source`);
  assert.equal(getAddress(transfer.to), ADDRESSES.buyer, `${proof.label} transfer recipient`);
  assert.equal(transfer.value, PAYOUT_ATOMIC, `${proof.label} transfer amount`);

  const slash = oneEvent(receipt, ADDRESSES.vault, vaultAbi, "BondSlashed");
  assert.equal(slash.covenantId, proof.covenantId, `${proof.label} slashed covenant`);
  assert.equal(getAddress(slash.provider), ADDRESSES.provider, `${proof.label} slashed provider`);
  assert.equal(getAddress(slash.recipient), ADDRESSES.buyer, `${proof.label} slash recipient`);
  assert.equal(slash.payout, PAYOUT_ATOMIC, `${proof.label} slashed amount`);
  assert.equal(slash.unlockedRemainder, 0n, `${proof.label} unlocked remainder`);

  const settled = oneEvent(receipt, ADDRESSES.manager, managerAbi, "CovenantSettled");
  assert.equal(settled.covenantId, proof.covenantId, `${proof.label} settled covenant`);
  assert.equal(settled.payoutAtomic, PAYOUT_ATOMIC, `${proof.label} event payout`);
  assert.equal(settled.escrowRefundAtomic, 0n, `${proof.label} escrow recovery`);
  assert.equal(settled.otherRecoveryAtomic, 0n, `${proof.label} other recovery`);
  assert.equal(settled.recoveryFinalized, true, `${proof.label} recovery finality`);
  assert.equal(Number(settled.finalState), PAID_STATE, `${proof.label} event final state`);

  assert.equal(covenant.id, proof.covenantId, `${proof.label} covenant id`);
  assert.equal(getAddress(covenant.provider), ADDRESSES.provider, `${proof.label} covenant provider`);
  assert.equal(getAddress(covenant.buyer), ADDRESSES.buyer, `${proof.label} covenant buyer`);
  assert.equal(Number(covenant.payoutBasis), 1, `${proof.label} payout basis`);
  assert.equal(Number(covenant.state), PAID_STATE, `${proof.label} on-chain state`);
  assert.equal(covenant.payoutAtomic, PAYOUT_ATOMIC, `${proof.label} on-chain payout`);
  assert.equal(covenant.recoveryFinalized, true, `${proof.label} on-chain recovery finality`);

  assert.equal(getAddress(lock[0]), ADDRESSES.provider, `${proof.label} lock provider`);
  assert.equal(lock[1], PAYOUT_ATOMIC, `${proof.label} original lock amount`);
  assert.equal(lock[2], false, `${proof.label} lock must be inactive`);

  console.log(`✓ ${proof.label}: Paid 0.5 USD₮0 (${proof.transactionHash})`);
}

const refundReceipt = await client.getTransactionReceipt({ hash: separateProviderRefund.transactionHash });
assert.equal(refundReceipt.status, "success", "separate provider refund receipt must succeed");
const refundTransfer = oneEvent(refundReceipt, PAYMENT.asset, tokenAbi, "Transfer");
assert.equal(getAddress(refundTransfer.from), ADDRESSES.provider, "separate refund source");
assert.equal(getAddress(refundTransfer.to), ADDRESSES.buyer, "separate refund recipient");
assert.equal(refundTransfer.value, SEPARATE_PROVIDER_REFUND_ATOMIC, "separate refund amount");

const [providerAccount, vaultBalance, escrowBalance, escrowAccounting] = await Promise.all([
  client.readContract({
    address: ADDRESSES.vault,
    abi: vaultAbi,
    functionName: "account",
    args: [ADDRESSES.provider],
  }),
  client.readContract({
    address: PAYMENT.asset,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [ADDRESSES.vault],
  }),
  client.readContract({
    address: PAYMENT.asset,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [ADDRESSES.escrow],
  }),
  client.readContract({
    address: ADDRESSES.escrow,
    abi: escrowAbi,
    functionName: "totalEscrowedAtomic",
  }),
]);

assert.equal(providerAccount.balance, 0n, "house provider bond balance must be zero");
assert.equal(providerAccount.locked, 0n, "house provider locked bond must be zero");
assert.equal(providerAccount.queuedWithdrawal, 0n, "house provider queued withdrawal must be zero");
assert.equal(vaultBalance, 0n, "canonical bond vault token balance must be zero");
assert.equal(escrowBalance, 0n, "fee escrow token balance must be zero");
assert.equal(escrowAccounting, 0n, "fee escrow accounting must be zero");

console.log("✓ separate 0.2 USD₮0 provider refund verified and not netted against either fixed SLA credit");
console.log("PolicyPool v0.4 house payout proof passed: both 24-hour challenges held, both fixed credits paid, and covenant custody closed.");
