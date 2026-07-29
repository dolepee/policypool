import { authorizationTypes } from "@x402/evm";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  toHex,
} from "viem";
import { COVERAGE, EVIDENCE_RESOLVER, OKX_TASK, PAYMENT, XLAYER } from "./config.js";
import { isBytes32 } from "./utils.js";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
const JOB_ABI = parseAbi([
  "function getJobStatus(bytes32 jobId) view returns (uint8)",
]);
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const MAX_PROVIDER_SETTLEMENT_SEARCH_SECONDS = 20 * 60;
// X Layer's public RPC rejects eth_getLogs ranges larger than 100 blocks.
// Keep the scan portable across providers while preserving the exact bounded window.
const MAX_LOG_SCAN_BLOCKS = 100n;
const MAX_ACCEPTANCE_SCAN_BLOCKS = BigInt(EVIDENCE_RESOLVER.maxAutomaticAcceptanceScanBlocks);
// The public X Layer RPC rate-limits small concurrent bursts, especially when
// CI runs the push and pull-request workflows together. One request at a time
// trades a little latency for deterministic availability.
const LOG_SCAN_CONCURRENCY = 1;
let eventLogRequestTail = Promise.resolve();

function enqueueEventLogRequest(request) {
  const result = eventLogRequestTail.then(request, request);
  // A failed RPC call must reject its own resolver without poisoning the queue
  // for every later request in this server process.
  eventLogRequestTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export class EvidenceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "EvidenceError";
    this.code = code;
  }
}

function errorIs(error, ErrorType, name) {
  return error instanceof ErrorType || error?.name === name;
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
    // Test doubles created before receipt classification exposed only the
    // waiter. Preserve that narrow injection contract while production clients
    // use the explicit lookup path below.
    if (
      typeof publicClient.getTransactionReceipt !== "function"
      || typeof publicClient.getTransaction !== "function"
    ) {
      try {
        return await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 15_000 });
      } catch (error) {
        throw new EvidenceError("transaction_unconfirmed", error instanceof Error ? error.message : String(error));
      }
    }

    const receiptLookup = async () => {
      try {
        return (await publicClient.getTransactionReceipt({ hash })) || null;
      } catch (error) {
        if (errorIs(error, TransactionReceiptNotFoundError, "TransactionReceiptNotFoundError")) return null;
        throw new EvidenceError("transaction_lookup_unavailable", error instanceof Error ? error.message : String(error));
      }
    };
    const transactionLookup = async () => {
      try {
        return (await publicClient.getTransaction({ hash })) || null;
      } catch (error) {
        if (errorIs(error, TransactionNotFoundError, "TransactionNotFoundError")) return null;
        throw new EvidenceError("transaction_lookup_unavailable", error instanceof Error ? error.message : String(error));
      }
    };

    const initialReceipt = await receiptLookup();
    if (initialReceipt) return initialReceipt;
    const initiallyVisible = Boolean(await transactionLookup());

    try {
      return await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 15_000 });
    } catch (error) {
      if (!errorIs(error, WaitForTransactionReceiptTimeoutError, "WaitForTransactionReceiptTimeoutError")) {
        throw new EvidenceError("transaction_lookup_unavailable", error instanceof Error ? error.message : String(error));
      }
    }

    // A valid transaction can be absent from one-shot reads while it propagates.
    // Poll for the full grace period first, then re-read both objects before
    // deciding whether the caller supplied a bad hash.
    const finalReceipt = await receiptLookup();
    if (finalReceipt) return finalReceipt;
    const finallyVisible = Boolean(await transactionLookup());
    if (initiallyVisible || finallyVisible) {
      throw new EvidenceError("transaction_unconfirmed");
    }
    throw new EvidenceError("transaction_not_found");
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

  async function calibrateBlockTiming() {
    const latestBlock = await publicClient.getBlock();
    if (latestBlock.number === null) throw new EvidenceError("target_block_calibration_failed");
    return {
      latestNumber: latestBlock.number,
      latestTimestamp: latestBlock.timestamp,
    };
  }

  function eventLogRanges(fromBlock, toBlock) {
    if (toBlock < fromBlock) throw new EvidenceError("target_event_search_window_invalid");
    const ranges = [];
    for (let start = fromBlock; start <= toBlock; start += MAX_LOG_SCAN_BLOCKS) {
      ranges.push({
        fromBlock: start,
        toBlock: start + MAX_LOG_SCAN_BLOCKS - 1n < toBlock
          ? start + MAX_LOG_SCAN_BLOCKS - 1n
          : toBlock,
      });
    }
    return ranges;
  }

  async function requestEventLogBatch({ eventTopic, jobId, ranges }) {
    try {
      const responses = await Promise.all(ranges.map((range) => enqueueEventLogRequest(
        () => publicClient.request({
          method: "eth_getLogs",
          params: [{
            address: OKX_TASK.escrow,
            fromBlock: toHex(range.fromBlock),
            toBlock: toHex(range.toBlock),
            topics: [eventTopic, jobId],
          }],
        }),
      )));
      return responses.flat().filter((log) => log?.removed !== true);
    } catch (error) {
      throw new EvidenceError("target_event_lookup_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function eventLogsInRange({ eventTopic, jobId, fromBlock, toBlock }) {
    const ranges = eventLogRanges(fromBlock, toBlock);
    const matches = [];
    for (let offset = 0; offset < ranges.length; offset += LOG_SCAN_CONCURRENCY) {
      matches.push(...await requestEventLogBatch({
        eventTopic,
        jobId,
        ranges: ranges.slice(offset, offset + LOG_SCAN_CONCURRENCY),
      }));
    }
    return matches;
  }

  // Job acceptance is the escrow's one-way 0 -> 1 transition. Stop after the
  // first matching batch instead of querying the remaining 30-minute window;
  // verifyTargetOrder then fetches that transaction receipt and independently
  // proves both the transition and current accepted state. Multiple matches in
  // the same batch still fail closed.
  async function firstEventInRange({ eventTopic, jobId, fromBlock, toBlock }) {
    const ranges = eventLogRanges(fromBlock, toBlock);
    for (let offset = 0; offset < ranges.length; offset += LOG_SCAN_CONCURRENCY) {
      const matches = await requestEventLogBatch({
        eventTopic,
        jobId,
        ranges: ranges.slice(offset, offset + LOG_SCAN_CONCURRENCY),
      });
      if (matches.length > 1) throw new EvidenceError("target_event_ambiguous");
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  async function findEventNearBlock({ eventTopic, jobId, centerBlock, latest, radius = 8n }) {
    const start = centerBlock > radius ? centerBlock - radius : 0n;
    const end = centerBlock + radius < latest ? centerBlock + radius : latest;
    const matches = await eventLogsInRange({
      eventTopic,
      jobId,
      fromBlock: start,
      toBlock: end,
    });
    if (matches.length !== 1) {
      throw new EvidenceError(matches.length ? "target_event_ambiguous" : "target_event_not_found");
    }
    return matches[0];
  }

  async function eventAtTimestamp({ eventTopic, jobId, timestampSeconds, calibration, radius = 8n }) {
    const ageSeconds = Number(calibration.latestTimestamp) - timestampSeconds;
    // X Layer currently advances roughly one sequencer block per second. The
    // bounded scan verifies this estimate; binary search below preserves
    // correctness if the cadence drifts.
    const offset = BigInt(Math.max(0, ageSeconds));
    const estimatedBlock = offset < calibration.latestNumber
      ? calibration.latestNumber - offset
      : 0n;
    try {
      return await findEventNearBlock({
        eventTopic,
        jobId,
        centerBlock: estimatedBlock,
        latest: calibration.latestNumber,
        radius,
      });
    } catch (error) {
      if (!(error instanceof EvidenceError) || error.code !== "target_event_not_found") throw error;
      const exactBlock = await firstBlockAtOrAfter(timestampSeconds);
      return findEventNearBlock({
        eventTopic,
        jobId,
        centerBlock: exactBlock,
        latest: calibration.latestNumber,
        radius,
      });
    }
  }

  function evidenceFromTaskLogs(jobId, createdLog, acceptedLog) {
    if (createdLog.topics.length < 3) throw new EvidenceError("target_creation_evidence_missing");
    if (acceptedLog.topics.length < 3) throw new EvidenceError("target_acceptance_evidence_missing");
    if (!isBytes32(createdLog.transactionHash)) throw new EvidenceError("target_creation_transaction_missing");
    if (!isBytes32(acceptedLog.transactionHash)) throw new EvidenceError("target_acceptance_transaction_missing");
    const creationBlock = BigInt(createdLog.blockNumber);
    const acceptanceBlock = BigInt(acceptedLog.blockNumber);
    if (acceptanceBlock < creationBlock) throw new EvidenceError("target_event_timeline_invalid");
    return {
      jobId,
      buyer: topicAddress(createdLog.topics[2]),
      creationTxHash: createdLog.transactionHash,
      acceptanceTxHash: acceptedLog.transactionHash,
      creationBlock: creationBlock.toString(),
      acceptanceBlock: acceptanceBlock.toString(),
    };
  }

  async function resolveTargetOrderEvidenceAtTimes({ jobId, createdAt, acceptedAt }, radius) {
    if (!isBytes32(jobId)) throw new EvidenceError("invalid_target_job_id");
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
    if (
      !Number.isSafeInteger(createdAtSeconds)
      || !Number.isSafeInteger(acceptedAtSeconds)
      || createdAtSeconds <= 0
      || acceptedAtSeconds <= 0
    ) {
      throw new EvidenceError("target_event_timestamp_invalid");
    }
    if (acceptedAtSeconds < createdAtSeconds) {
      throw new EvidenceError("target_event_timeline_invalid");
    }

    let calibration;
    try {
      calibration = await calibrateBlockTiming();
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError("target_block_calibration_failed", error instanceof Error ? error.message : String(error));
    }
    const latestTimestamp = Number(calibration.latestTimestamp);
    if (createdAtSeconds > latestTimestamp + 120) {
      throw new EvidenceError("target_creation_time_hint_in_future");
    }
    if (acceptedAtSeconds > latestTimestamp + 120) {
      throw new EvidenceError("target_acceptance_time_hint_in_future");
    }

    // The public X Layer endpoint rate-limits concurrent eth_getLogs calls.
    // Keep the two independently hinted searches serial as well as each search's
    // internal batches, otherwise the late-acceptance fallback can still fail
    // even though LOG_SCAN_CONCURRENCY is one.
    const createdLog = await eventAtTimestamp({
      eventTopic: OKX_TASK.createdTopic,
      jobId,
      timestampSeconds: createdAtSeconds,
      calibration,
      radius,
    });
    const acceptedLog = await eventAtTimestamp({
      eventTopic: OKX_TASK.acceptedTopic,
      jobId,
      timestampSeconds: acceptedAtSeconds,
      calibration,
      radius,
    });
    return evidenceFromTaskLogs(jobId, createdLog, acceptedLog);
  }

  async function resolveTargetOrderEvidence(args) {
    return resolveTargetOrderEvidenceAtTimes(args, 8n);
  }

  async function resolveTargetOrderEvidenceFromHints({ jobId, createdAt, acceptedAt = "" }) {
    if (acceptedAt) {
      return resolveTargetOrderEvidenceAtTimes(
        { jobId, createdAt, acceptedAt },
        BigInt(EVIDENCE_RESOLVER.creationHintRadiusBlocks),
      );
    }
    if (!isBytes32(jobId)) throw new EvidenceError("invalid_target_job_id");
    const createdAtSeconds = Math.floor(Date.parse(createdAt) / 1000);
    if (!Number.isSafeInteger(createdAtSeconds) || createdAtSeconds <= 0) {
      throw new EvidenceError("target_event_timestamp_invalid");
    }

    let latestBlock;
    try {
      latestBlock = await publicClient.getBlock();
    } catch (error) {
      throw new EvidenceError("target_block_calibration_failed", error instanceof Error ? error.message : String(error));
    }
    if (latestBlock.number === null) throw new EvidenceError("target_block_calibration_failed");
    if (createdAtSeconds > Number(latestBlock.timestamp) + 120) {
      throw new EvidenceError("target_creation_time_hint_in_future");
    }

    const createdLog = await eventAtTimestamp({
      eventTopic: OKX_TASK.createdTopic,
      jobId,
      timestampSeconds: createdAtSeconds,
      calibration: {
        latestNumber: latestBlock.number,
        latestTimestamp: latestBlock.timestamp,
      },
      radius: BigInt(EVIDENCE_RESOLVER.creationHintRadiusBlocks),
    });
    const creationBlock = BigInt(createdLog.blockNumber);
    const currentStatus = await getJobStatus(jobId);
    if (currentStatus === 0) throw new EvidenceError("target_job_not_accepted:0");
    const scanEnd = creationBlock + MAX_ACCEPTANCE_SCAN_BLOCKS - 1n < latestBlock.number
      ? creationBlock + MAX_ACCEPTANCE_SCAN_BLOCKS - 1n
      : latestBlock.number;
    const acceptedLog = await firstEventInRange({
      eventTopic: OKX_TASK.acceptedTopic,
      jobId,
      fromBlock: creationBlock,
      toBlock: scanEnd,
    });
    if (!acceptedLog) {
      throw new EvidenceError("target_acceptance_time_hint_required");
    }
    return evidenceFromTaskLogs(jobId, createdLog, acceptedLog);
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

  async function verifyProviderPaymentAuthorization({
    payer,
    asset,
    name,
    version,
    authorization,
    signature,
  }) {
    let valid;
    try {
      valid = await publicClient.verifyTypedData({
        address: getAddress(payer),
        domain: {
          name,
          version,
          chainId: XLAYER.id,
          verifyingContract: getAddress(asset),
        },
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          from: getAddress(authorization.from),
          to: getAddress(authorization.to),
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw new EvidenceError("provider_payment_signature_invalid");
    return true;
  }

  async function verifyTransfer({
    txHash,
    from,
    to,
    amountAtomic,
    asset = PAYMENT.asset,
    authorizationNonce,
  }) {
    if (!isBytes32(txHash)) throw new EvidenceError("invalid_transfer_tx_hash");
    let expectedAsset;
    try {
      expectedAsset = getAddress(asset);
    } catch {
      throw new EvidenceError("invalid_transfer_asset");
    }
    const receipt = await getReceipt(txHash);
    if (receipt.status !== "success") throw new EvidenceError("transfer_tx_reverted");
    const isExpectedTransfer = (log) => {
      if (log.address.toLowerCase() !== expectedAsset.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        return decoded.eventName === "Transfer"
          && decoded.args.from.toLowerCase() === from.toLowerCase()
          && decoded.args.to.toLowerCase() === to.toLowerCase()
          && decoded.args.value === BigInt(amountAtomic);
      } catch {
        return false;
      }
    };
    let transfer;
    if (authorizationNonce) {
      const authorizationMatches = receipt.logs
        .map((log, index) => ({ log, index }))
        .filter(({ log }) => {
          if (log.address.toLowerCase() !== expectedAsset.toLowerCase()) return false;
          try {
            const decoded = decodeEventLog({
              abi: [AUTHORIZATION_USED_EVENT],
              data: log.data,
              topics: log.topics,
            });
            return decoded.eventName === "AuthorizationUsed"
              && decoded.args.authorizer.toLowerCase() === from.toLowerCase()
              && decoded.args.nonce.toLowerCase() === authorizationNonce.toLowerCase();
          } catch {
            return false;
          }
        });
      if (authorizationMatches.length === 0) {
        throw new EvidenceError("provider_payment_authorization_event_missing");
      }
      if (authorizationMatches.length !== 1) {
        throw new EvidenceError("provider_payment_authorization_event_ambiguous");
      }
      // USD₮0 emits AuthorizationUsed immediately before the Transfer executed by that
      // authorization. Requiring the ordered pair prevents a later batch transfer from
      // being substituted for the signed nonce's actual recipient.
      const authorizationIndex = authorizationMatches[0].index;
      transfer = receipt.logs[authorizationIndex + 1];
      if (!transfer || !isExpectedTransfer(transfer)) {
        throw new EvidenceError("provider_payment_authorization_transfer_mismatch");
      }
    } else {
      transfer = receipt.logs.find(isExpectedTransfer);
      if (!transfer) throw new EvidenceError("verified_transfer_event_missing");
    }
    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      asset: expectedAsset,
      from: getAddress(from),
      to: getAddress(to),
      amountAtomic: String(amountAtomic),
      authorizationNonce: authorizationNonce || null,
    };
  }

  async function findProviderSettlement({
    payer,
    payTo,
    asset = PAYMENT.asset,
    amountAtomic,
    authorizationNonce,
    notBeforeTimestamp,
    notAfterTimestamp,
  }) {
    let expectedPayer;
    let expectedPayTo;
    let expectedAsset;
    try {
      expectedPayer = getAddress(payer);
      expectedPayTo = getAddress(payTo);
      expectedAsset = getAddress(asset);
    } catch {
      throw new EvidenceError("provider_settlement_search_address_invalid");
    }
    if (!isBytes32(authorizationNonce)) {
      throw new EvidenceError("provider_settlement_search_nonce_invalid");
    }
    const fromTimestamp = Number(notBeforeTimestamp);
    const throughTimestamp = Number(notAfterTimestamp);
    if (
      !Number.isSafeInteger(fromTimestamp)
      || !Number.isSafeInteger(throughTimestamp)
      || fromTimestamp <= 0
      || throughTimestamp < fromTimestamp
      || throughTimestamp - fromTimestamp > MAX_PROVIDER_SETTLEMENT_SEARCH_SECONDS
    ) throw new EvidenceError("provider_settlement_search_window_invalid");

    let latest;
    try {
      latest = await publicClient.getBlock();
    } catch (error) {
      throw new EvidenceError("provider_settlement_search_head_unavailable", error instanceof Error ? error.message : String(error));
    }
    if (latest.number === null || Number(latest.timestamp) < fromTimestamp) return null;
    const boundedThrough = Math.min(throughTimestamp, Number(latest.timestamp));
    const firstEligibleBlock = await firstBlockAtOrAfter(fromTimestamp);
    // Include the boundary block in case wall-clock issuance is just ahead of its block timestamp.
    const fromBlock = firstEligibleBlock > 0n ? firstEligibleBlock - 1n : 0n;
    const throughBlock = boundedThrough === Number(latest.timestamp)
      ? latest.number
      : await firstBlockAtOrAfter(boundedThrough);
    const matches = [];
    try {
      for (let chunkStart = fromBlock; chunkStart <= throughBlock; chunkStart += MAX_LOG_SCAN_BLOCKS) {
        const chunkEnd = chunkStart + MAX_LOG_SCAN_BLOCKS - 1n < throughBlock
          ? chunkStart + MAX_LOG_SCAN_BLOCKS - 1n
          : throughBlock;
        matches.push(...await publicClient.getLogs({
          address: expectedAsset,
          event: AUTHORIZATION_USED_EVENT,
          args: { authorizer: expectedPayer, nonce: authorizationNonce },
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        }));
      }
    } catch (error) {
      throw new EvidenceError("provider_settlement_search_failed", error instanceof Error ? error.message : String(error));
    }
    if (matches.length === 0) return null;
    if (matches.length !== 1 || !isBytes32(matches[0].transactionHash)) {
      throw new EvidenceError("provider_settlement_search_ambiguous");
    }
    const transfer = await verifyTransfer({
      txHash: matches[0].transactionHash,
      from: expectedPayer,
      to: expectedPayTo,
      asset: expectedAsset,
      amountAtomic,
      authorizationNonce,
    });
    let settlementBlock;
    try {
      settlementBlock = await publicClient.getBlock({ blockNumber: BigInt(matches[0].blockNumber) });
    } catch (error) {
      throw new EvidenceError("provider_settlement_block_unavailable", error instanceof Error ? error.message : String(error));
    }
    return {
      ...transfer,
      settledAt: new Date(Number(settlementBlock.timestamp) * 1_000).toISOString(),
    };
  }

  return {
    getJobStatus,
    getReserveBalance,
    findProviderSettlement,
    resolveTargetOrderEvidence,
    resolveTargetOrderEvidenceFromHints,
    verifyProviderPaymentAuthorization,
    verifySettlement: ({ txHash, payer, amountAtomic }) => verifyTransfer({
      txHash,
      from: payer,
      to: PAYMENT.payTo,
      amountAtomic,
    }),
    verifyProviderSettlement: ({ txHash, payer, payTo, asset, amountAtomic, authorizationNonce }) => verifyTransfer({
      txHash,
      from: payer,
      to: payTo,
      asset,
      amountAtomic,
      authorizationNonce,
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
