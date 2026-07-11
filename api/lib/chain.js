import {
  createPublicClient,
  decodeAbiParameters,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  toHex,
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
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

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

export function validateServiceBinding(policy, serviceHash) {
  if (!isBytes32(serviceHash)) throw new EvidenceError("target_service_hash_invalid");
  const serviceType = String(policy?.serviceType || "").trim().toUpperCase();
  const normalizedHash = serviceHash.toLowerCase();
  if (serviceType === "A2A" && normalizedHash === ZERO_BYTES32) {
    throw new EvidenceError("target_service_hash_missing_for_a2a");
  }
  if (serviceType === "A2MCP" && normalizedHash !== ZERO_BYTES32) {
    throw new EvidenceError("target_service_hash_unexpected_for_a2mcp");
  }
  if (serviceType !== "A2A" && serviceType !== "A2MCP") {
    throw new EvidenceError("target_service_type_unsupported");
  }
  return {
    serviceHash,
    serviceType,
    serviceTypeVerified: true,
    listedServiceIdMapping: "manual_external_evidence_required",
  };
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

  async function firstBlockAtOrAfter(timestampSeconds) {
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
      throw new EvidenceError("target_event_timestamp_invalid");
    }
    let low = 0n;
    let high;
    try {
      high = await publicClient.getBlockNumber();
    } catch (error) {
      throw new EvidenceError("target_chain_head_unavailable", error instanceof Error ? error.message : String(error));
    }
    while (low < high) {
      const middle = (low + high) / 2n;
      let block;
      try {
        block = await publicClient.getBlock({ blockNumber: middle });
      } catch (error) {
        throw new EvidenceError("target_block_lookup_failed", error instanceof Error ? error.message : String(error));
      }
      if (block.timestamp < BigInt(timestampSeconds)) low = middle + 1n;
      else high = middle;
    }
    return low;
  }

  async function estimateBlocksAtTimestamps(timestamps) {
    const latestBlock = await publicClient.getBlock();
    if (latestBlock.number === null) throw new EvidenceError("target_block_calibration_failed");
    const latestNumber = latestBlock.number;
    return {
      latestNumber,
      estimates: timestamps.map((timestampSeconds) => {
        const ageSeconds = Number(latestBlock.timestamp) - timestampSeconds;
        // X Layer currently advances one sequencer block per second. A bounded
        // event scan verifies the estimate; the binary-search fallback preserves
        // correctness if that cadence changes.
        const offset = BigInt(Math.max(0, ageSeconds));
        return offset < latestNumber ? latestNumber - offset : 0n;
      }),
    };
  }

  async function findEventNearBlock({ eventTopic, jobId, centerBlock, latest, radius = 8n }) {
    const start = centerBlock > radius ? centerBlock - radius : 0n;
    const end = centerBlock + radius < latest ? centerBlock + radius : latest;
    const requests = [];
    for (let fromBlock = start; fromBlock <= end; fromBlock += 100n) {
      const toBlock = fromBlock + 99n < end ? fromBlock + 99n : end;
      requests.push(publicClient.request({
        method: "eth_getLogs",
        params: [{
          address: OKX_TASK.escrow,
          fromBlock: toHex(fromBlock),
          toBlock: toHex(toBlock),
          topics: [eventTopic, jobId],
        }],
      }));
    }
    let matches;
    try {
      matches = (await Promise.all(requests)).flat();
    } catch (error) {
      throw new EvidenceError("target_event_lookup_failed", error instanceof Error ? error.message : String(error));
    }
    if (matches.length !== 1) {
      throw new EvidenceError(matches.length ? "target_event_ambiguous" : "target_event_not_found");
    }
    return matches[0];
  }

  async function resolveTargetOrderEvidence({ jobId, createdAt, acceptedAt }) {
    if (!isBytes32(jobId)) throw new EvidenceError("invalid_target_job_id");
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
    if (!Number.isSafeInteger(createdAtSeconds) || !Number.isSafeInteger(acceptedAtSeconds)) {
      throw new EvidenceError("target_event_timestamp_invalid");
    }
    if (acceptedAtSeconds < createdAtSeconds) {
      throw new EvidenceError("target_event_timeline_invalid");
    }

    let calibration;
    try {
      calibration = await estimateBlocksAtTimestamps([createdAtSeconds, acceptedAtSeconds]);
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError("target_block_calibration_failed", error instanceof Error ? error.message : String(error));
    }

    async function resolveEvent(eventTopic, estimatedBlock, timestampSeconds) {
      try {
        return await findEventNearBlock({
          eventTopic,
          jobId,
          centerBlock: estimatedBlock,
          latest: calibration.latestNumber,
        });
      } catch (error) {
        if (!(error instanceof EvidenceError) || error.code !== "target_event_not_found") throw error;
        const exactBlock = await firstBlockAtOrAfter(timestampSeconds);
        return findEventNearBlock({
          eventTopic,
          jobId,
          centerBlock: exactBlock,
          latest: calibration.latestNumber,
        });
      }
    }

    const [createdLog, acceptedLog] = await Promise.all([
      resolveEvent(OKX_TASK.createdTopic, calibration.estimates[0], createdAtSeconds),
      resolveEvent(OKX_TASK.acceptedTopic, calibration.estimates[1], acceptedAtSeconds),
    ]);
    if (createdLog.topics.length < 3) throw new EvidenceError("target_creation_evidence_missing");
    return {
      jobId,
      buyer: topicAddress(createdLog.topics[2]),
      creationTxHash: createdLog.transactionHash,
      acceptanceTxHash: acceptedLog.transactionHash,
      creationBlock: BigInt(createdLog.blockNumber).toString(),
      acceptanceBlock: BigInt(acceptedLog.blockNumber).toString(),
    };
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
    const serviceBinding = validateServiceBinding(policy, serviceHash);

    const status = await getJobStatus(jobId);
    if (!allowedStatuses.includes(status)) throw new EvidenceError(`target_job_not_accepted:${status}`);
    const [creationBlock, acceptanceBlock] = await Promise.all([
      publicClient.getBlock({ blockNumber: creationReceipt.blockNumber }),
      publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    return {
      jobId,
      creationTxHash,
      acceptanceTxHash,
      creationBlock: creationReceipt.blockNumber.toString(),
      acceptanceBlock: receipt.blockNumber.toString(),
      createdAt: new Date(Number(creationBlock.timestamp) * 1000).toISOString(),
      acceptedAt: new Date(Number(acceptanceBlock.timestamp) * 1000).toISOString(),
      buyer: targetBuyer,
      provider,
      agentId: String(agentId),
      asset: getAddress(asset),
      amountAtomic: amount.toString(),
      ...serviceBinding,
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
    resolveTargetOrderEvidence,
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
