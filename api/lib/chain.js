import {
  createPublicClient,
  decodeAbiParameters,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";
import { COVERAGE, OKX_TASK, PAYMENT, XLAYER } from "./config.js";
import { isBytes32 } from "./utils.js";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const JOB_ABI = parseAbi([
  "function getJobStatus(bytes32 jobId) view returns (uint8)",
]);

export class EvidenceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "EvidenceError";
    this.code = code;
  }
}

function topicAddress(value) {
  return getAddress(`0x${String(value).slice(-40)}`);
}

function topicUint(value) {
  return BigInt(value);
}

export function createChainService({ rpcUrl = XLAYER.rpcUrl, client } = {}) {
  const chain = defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = client || createPublicClient({ chain, transport: http(rpcUrl) });

  async function getReceipt(hash) {
    try {
      return await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 15_000 });
    } catch (error) {
      throw new EvidenceError("transaction_unconfirmed", error instanceof Error ? error.message : String(error));
    }
  }

  async function getJobStatus(jobId) {
    if (!isBytes32(jobId)) throw new EvidenceError("invalid_target_job_id");
    try {
      return Number(await publicClient.readContract({
        address: OKX_TASK.escrow,
        abi: JOB_ABI,
        functionName: "getJobStatus",
        args: [jobId],
      }));
    } catch (error) {
      throw new EvidenceError("target_job_status_unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  async function verifyTargetOrder({
    jobId,
    creationTxHash,
    acceptanceTxHash,
    buyer,
    policy,
    allowedStatuses = [1],
  }) {
    if (!isBytes32(jobId)) throw new EvidenceError("invalid_target_job_id");
    if (!isBytes32(creationTxHash)) throw new EvidenceError("invalid_target_creation_tx");
    if (!isBytes32(acceptanceTxHash)) throw new EvidenceError("invalid_target_acceptance_tx");
    const creationReceipt = await getReceipt(creationTxHash);
    if (creationReceipt.status !== "success") throw new EvidenceError("target_creation_tx_reverted");
    const jobTopic = jobId.toLowerCase();
    const createdLog = creationReceipt.logs.find((log) => (
      log.address.toLowerCase() === OKX_TASK.escrow.toLowerCase()
      && log.topics[0]?.toLowerCase() === OKX_TASK.createdTopic
      && log.topics[1]?.toLowerCase() === jobTopic
    ));
    if (!createdLog || createdLog.topics.length < 3) throw new EvidenceError("target_creation_evidence_missing");
    const targetBuyer = topicAddress(createdLog.topics[2]);
    if (!buyer || targetBuyer.toLowerCase() !== buyer.toLowerCase()) {
      throw new EvidenceError("coverage_buyer_does_not_own_target_job");
    }

    const receipt = await getReceipt(acceptanceTxHash);
    if (receipt.status !== "success") throw new EvidenceError("target_acceptance_tx_reverted");
    const statusLog = receipt.logs.find((log) => (
      log.address.toLowerCase() === OKX_TASK.escrow.toLowerCase()
      && log.topics[0]?.toLowerCase() === OKX_TASK.statusChangedTopic
      && log.topics[1]?.toLowerCase() === jobTopic
      && topicUint(log.topics[2]) === 0n
      && topicUint(log.topics[3]) === 1n
    ));
    if (!statusLog) throw new EvidenceError("target_acceptance_status_event_missing");

    const acceptedLog = receipt.logs.find((log) => (
      log.address.toLowerCase() === OKX_TASK.escrow.toLowerCase()
      && log.topics[0]?.toLowerCase() === OKX_TASK.acceptedTopic
      && log.topics[1]?.toLowerCase() === jobTopic
    ));
    if (!acceptedLog || acceptedLog.topics.length < 3) {
      throw new EvidenceError("target_acceptance_evidence_missing");
    }

    const provider = topicAddress(acceptedLog.topics[2]);
    const [agentId, asset, amount, serviceHash] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      acceptedLog.data,
    );
    if (String(agentId) !== policy.agentId) throw new EvidenceError("target_agent_id_mismatch");
    if (provider.toLowerCase() !== policy.providerWallet.toLowerCase()) {
      throw new EvidenceError("target_provider_wallet_mismatch");
    }
    if (asset.toLowerCase() !== PAYMENT.asset.toLowerCase()) throw new EvidenceError("target_payment_asset_mismatch");
    if (amount <= 0n) throw new EvidenceError("target_payment_amount_missing");

    const status = await getJobStatus(jobId);
    if (!allowedStatuses.includes(status)) throw new EvidenceError(`target_job_not_accepted:${status}`);
    return {
      jobId,
      creationTxHash,
      acceptanceTxHash,
      creationBlock: creationReceipt.blockNumber.toString(),
      acceptanceBlock: receipt.blockNumber.toString(),
      buyer: targetBuyer,
      provider,
      agentId: String(agentId),
      asset: getAddress(asset),
      amountAtomic: amount.toString(),
      serviceHash,
      status,
      statusLabel: status === 1 ? "accepted" : `status_${status}`,
    };
  }

  async function getReserveBalance() {
    return publicClient.readContract({
      address: PAYMENT.asset,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [COVERAGE.reserveWallet],
    });
  }

  async function verifyTransfer({ txHash, from, to, amountAtomic }) {
    if (!isBytes32(txHash)) throw new EvidenceError("invalid_transfer_tx_hash");
    const receipt = await getReceipt(txHash);
    if (receipt.status !== "success") throw new EvidenceError("transfer_tx_reverted");
    const transfer = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== PAYMENT.asset.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        return decoded.eventName === "Transfer"
          && decoded.args.from.toLowerCase() === from.toLowerCase()
          && decoded.args.to.toLowerCase() === to.toLowerCase()
          && decoded.args.value === BigInt(amountAtomic);
      } catch {
        return false;
      }
    });
    if (!transfer) throw new EvidenceError("verified_transfer_event_missing");
    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      asset: PAYMENT.asset,
      from: getAddress(from),
      to: getAddress(to),
      amountAtomic: String(amountAtomic),
    };
  }

  return {
    getJobStatus,
    getReserveBalance,
    verifySettlement: ({ txHash, payer, amountAtomic }) => verifyTransfer({
      txHash,
      from: payer,
      to: PAYMENT.payTo,
      amountAtomic,
    }),
    verifyPayout: ({ txHash, buyer, amountAtomic }) => verifyTransfer({
      txHash,
      from: COVERAGE.reserveWallet,
      to: buyer,
      amountAtomic,
    }),
    verifyTargetOrder,
  };
}
