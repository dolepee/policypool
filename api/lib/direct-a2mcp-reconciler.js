import { getAddress, keccak256, stringToHex } from "viem";
import {
  directPolicyFeeSettlementAction,
  finalizeDirectPolicyFee,
} from "./direct-policy-fee.js";
import {
  directPolicyFeeAuthorizationEvidence,
  directProviderAuthorizationEvidence,
} from "./direct-a2mcp.js";
import { MAX_DIRECT_AUTHORIZATION_WINDOW_SECONDS } from "./direct-a2mcp-constants.js";
import { ProviderRelayError, verifyProviderRelayReceipt } from "./provider-relay.js";
import { isBytes32, stableStringify } from "./utils.js";

const COVENANT = {
  none: 0,
  pendingStart: 1,
  active: 2,
  released: 3,
  payoutDue: 4,
  paid: 5,
  recoveredWithoutPayout: 6,
  cancelledUnpaid: 7,
};
const FEE = { none: 0, funded: 1, captured: 2, refunded: 3 };
const SETTLEMENT_CHALLENGE_SECONDS = 24 * 60 * 60;
const CLOCK_START_RECOVERY_SECONDS = 10 * 60;

function evidenceHash(value) {
  return keccak256(stringToHex(stableStringify(value)));
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function terminalCovenant(state) {
  return [
    COVENANT.released,
    COVENANT.paid,
    COVENANT.recoveredWithoutPayout,
    COVENANT.cancelledUnpaid,
  ].includes(Number(state));
}

function validateRelayBinding(record, receipt) {
  if (
    !receipt?.request?.paymentVerified
    || !isBytes32(receipt?.receiptDigest)
    || !isBytes32(receipt?.settlement?.transaction)
    || String(receipt?.covenantId || "").toLowerCase() !== record.covenantId
    || String(receipt?.provider?.targetJobId || "").toLowerCase() !== record.jobId
    || String(receipt?.request?.hash || "").toLowerCase()
      !== String(record.requestHash || "").toLowerCase()
    || String(receipt?.request?.paymentAuthorizationId || "") !== record.providerAuthorizationId
    || String(receipt?.settlement?.authorizationNonce || "").toLowerCase()
      !== record.providerAuthorizationNonce
    || !sameAddress(receipt?.settlement?.payer, record.buyer)
    || !sameAddress(receipt?.settlement?.payTo, record.providerAccepted?.payTo)
    || !sameAddress(receipt?.settlement?.asset, record.providerAccepted?.asset)
    || String(receipt?.settlement?.amountAtomic || "") !== record.servicePriceAtomic
  ) throw new Error("direct_relay_receipt_binding_mismatch");
}

export function createDirectA2mcpReconciler({
  state,
  relayStore,
  relay,
  issuer,
  feeEscrow,
  relaySigner,
  relayVerifier,
  verifyReceipt = verifyProviderRelayReceipt,
  now = () => Date.now(),
} = {}) {
  if (
    !state?.listExecuting
    || !state?.markReconciled
    || !state?.recoveryContext
    || !state?.reconcileCheckpoint
    || !state?.reconcileComplete
  ) {
    throw new Error("direct_reconciler_state_unavailable");
  }
  if (!relayStore?.getRelayReceiptForCovenant) throw new Error("direct_reconciler_relay_store_unavailable");
  if (!relay?.recover) throw new Error("direct_reconciler_relay_unavailable");
  if (
    !issuer?.getCovenant
    || !issuer?.startClock
    || !issuer?.expireUnstarted
    || !issuer?.release
    || !issuer?.markPayoutDue
    || !issuer?.settleNetLoss
    || !issuer?.cancelUnpaid
  ) {
    throw new Error("direct_reconciler_issuer_unavailable");
  }
  if (
    !feeEscrow?.getFee
    || !feeEscrow?.capture
    || !feeEscrow?.findOrphanedPayment
    || !feeEscrow?.refund
    || !feeEscrow?.refundOrphaned
  ) {
    throw new Error("direct_reconciler_fee_escrow_unavailable");
  }
  if (!relaySigner || !relayVerifier) throw new Error("direct_reconciler_relay_identity_unavailable");

  async function checkpoint(record, stage, value, dryRun) {
    if (dryRun || record.execution?.stages?.[stage]) return record;
    return state.reconcileCheckpoint(record.id, record.execution.id, stage, value);
  }

  async function complete(record, result, dryRun) {
    if (!dryRun) await state.reconcileComplete(record.id, record.execution.id, result);
  }

  async function recoverProviderResult(record) {
    const relayGrant = record.execution?.stages?.relayGrant;
    if (!relayGrant?.token) return null;
    const recovery = await state.recoveryContext(record.id, record.execution.id);
    return relay.recover({
      agentId: record.agentId,
      serviceId: record.serviceId,
      targetJobId: record.jobId,
      endpoint: record.endpoint,
      providerRequest: recovery.providerRequest,
      relayGrant: relayGrant.token,
    }, { "payment-signature": recovery.providerPaymentSignature });
  }

  function orphanedFeeSearch(record) {
    return {
      buyer: record.buyer,
      authorizationNonce: record.feeNonce,
      notBeforeTimestamp: Math.max(
        1,
        Number(record.feeValidBefore) - MAX_DIRECT_AUTHORIZATION_WINDOW_SECONDS,
      ),
      notAfterTimestamp: Number(record.feeValidBefore),
    };
  }

  function orphanedFeeAuthorization(record) {
    return {
      buyer: record.buyer,
      policyId: record.policyId,
      jobId: record.jobId,
      providerAuthorizationHash: record.providerAuthorizationHash,
      validAfter: record.feeValidAfter,
      validBefore: record.feeValidBefore,
      nonce: record.feeNonce,
      providerAuthorizationValidBefore: record.providerAuthorizationValidBefore,
    };
  }

  async function recoverOrphanedFee({
    record,
    fee,
    dryRun,
    changes,
    holds,
    recovery,
  }) {
    if (Number(fee.state) !== FEE.none) {
      return { fee, found: false, pending: false, record, recovery };
    }
    const payment = await feeEscrow.findOrphanedPayment(orphanedFeeSearch(record));
    if (!payment) return { fee, found: false, pending: false, record, recovery };

    const nowSeconds = Math.floor(now() / 1_000);
    const refundAvailableAt = Math.max(
      Number(record.feeValidBefore),
      Number(record.providerAuthorizationValidBefore),
    ) + 120;
    if (nowSeconds < refundAvailableAt) {
      holds.push({
        quoteId: record.id,
        reason: "orphaned_policy_fee_refund_delay_active",
        refundAvailableAt,
        paymentTransaction: payment.txHash,
      });
      return { fee, found: true, pending: true, record, recovery };
    }

    changes.push({
      quoteId: record.id,
      action: "refund_orphaned_policy_fee",
      paymentTransaction: payment.txHash,
    });
    if (dryRun) return { fee, found: true, pending: true, record, recovery };

    recovery ||= await state.recoveryContext(record.id, record.execution.id);
    const write = await feeEscrow.refundOrphaned(
      orphanedFeeAuthorization(record),
      {
        feeId: record.feeId,
        covenantId: record.covenantId,
        authorizationNonce: record.feeNonce,
        paymentTransaction: payment.txHash,
        observedAt: nowSeconds,
      },
      {
        directQuote: record.id,
        providerAuthorizationEvidence: directProviderAuthorizationEvidence(
          record,
          recovery.providerPaymentSignature,
        ),
        policyFeeAuthorizationEvidence: directPolicyFeeAuthorizationEvidence(
          record,
          recovery.policyFeePaymentSignature,
          recovery.quoteToken,
        ),
      },
    );
    record = await checkpoint(record, "orphanedFeeRefunded", write, false);
    fee = await feeEscrow.getFee(record.feeId);
    if (Number(fee.state) !== FEE.refunded) {
      throw new Error("orphaned_policy_fee_refund_not_terminal");
    }
    return { fee, found: true, pending: false, record, recovery };
  }

  async function reconcileSettled(record, receipt, dryRun, changes, holds) {
    validateRelayBinding(record, receipt);
    if (!await verifyReceipt(receipt, relaySigner, relayVerifier)) {
      throw new Error("direct_relay_receipt_signature_invalid");
    }
    let covenant = await issuer.getCovenant(record.covenantId);
    let fee = await feeEscrow.getFee(record.feeId);
    if (Number(covenant.state) === COVENANT.cancelledUnpaid) {
      holds.push({
        quoteId: record.id,
        reason: "provider_settled_after_unpaid_cancellation_manual_resolution",
        settlementTransaction: receipt.settlement.transaction,
      });
      return;
    }
    let retained = null;
    if (Number(fee.state) === FEE.none) {
      const orphan = await recoverOrphanedFee({
        record,
        fee,
        dryRun,
        changes,
        holds,
        recovery: retained,
      });
      record = orphan.record;
      fee = orphan.fee;
      retained = orphan.recovery;
      if (orphan.pending) return;
      if (!orphan.found) {
        holds.push({
          quoteId: record.id,
          reason: "policy_fee_missing_after_provider_settlement_manual_resolution",
          settlementTransaction: receipt.settlement.transaction,
        });
        return;
      }
    }
    retained ||= dryRun ? null : await state.recoveryContext(record.id, record.execution.id);
    const lifecycleAttestationContext = dryRun ? null : {
      relayReceipt: receipt,
      directQuote: record.id,
      providerAuthorizationEvidence: directProviderAuthorizationEvidence(
        record,
        retained.providerPaymentSignature,
      ),
    };
    if (Number(covenant.state) === COVENANT.pendingStart) {
      const nowSeconds = Math.floor(now() / 1_000);
      const clockRecoveryEndsAt = Number(covenant.feeAuthorizationValidBefore)
        + CLOCK_START_RECOVERY_SECONDS;
      if (nowSeconds > clockRecoveryEndsAt) {
        if (Number(fee.state) === FEE.captured) {
          holds.push({
            quoteId: record.id,
            reason: "captured_fee_without_started_clock_manual_resolution",
          });
          return;
        }
        changes.push({ quoteId: record.id, action: "expire_unstarted_clock_recovery" });
        if (!dryRun) {
          const write = await issuer.expireUnstarted(record.covenantId);
          record = await checkpoint(record, "coverageExpiredUnstarted", write, false);
          covenant = await issuer.getCovenant(record.covenantId);
        }
        if (Number(fee.state) === FEE.funded) {
          changes.push({ quoteId: record.id, action: "refund_policy_fee" });
          if (!dryRun) {
            const write = await feeEscrow.refund(record.feeId);
            record = await checkpoint(record, "feeRefunded", write, false);
            fee = await feeEscrow.getFee(record.feeId);
          }
        }
        if (!dryRun) {
          covenant = await issuer.getCovenant(record.covenantId);
          fee = await feeEscrow.getFee(record.feeId);
        }
        if (
          Number(covenant.state) === COVENANT.released
          && [FEE.none, FEE.refunded].includes(Number(fee.state))
        ) {
          await complete(record, {
            ok: true,
            reconciled: true,
            quoteId: record.id,
            covenantId: record.covenantId,
            feeId: record.feeId,
            feeState: Number(fee.state),
            feeOutcome: Number(fee.state) === FEE.refunded ? "refunded" : "not_funded",
            coverageState: Number(covenant.state),
            providerRelayReceiptId: receipt.receiptId,
            providerSettlementTransaction: receipt.settlement.transaction,
            outcome: "coverage_clock_recovery_expired",
          }, false);
        }
        return;
      }
      changes.push({ quoteId: record.id, action: "start_clock" });
      if (!dryRun) {
        const write = await issuer.startClock(
          record.covenantId,
          receipt.clock.startedAt,
          receipt.receiptDigest,
          lifecycleAttestationContext,
        );
        record = await checkpoint(record, "clockStarted", write, false);
        covenant = await issuer.getCovenant(record.covenantId);
      }
    }
    if (Number(fee.state) === FEE.funded && Number(covenant.state) !== COVENANT.pendingStart) {
      const feeAction = directPolicyFeeSettlementAction(fee, Math.floor(now() / 1_000));
      changes.push({
        quoteId: record.id,
        action: feeAction === "refund" ? "refund_policy_fee_after_settlement" : "capture_fee",
      });
      if (!dryRun) {
        const feeResolution = await finalizeDirectPolicyFee({
          feeEscrow,
          feeId: record.feeId,
          captureEvidence: {
            feeId: record.feeId,
            covenantId: record.covenantId,
            providerAuthorizationHash: record.providerAuthorizationHash,
            relayReceiptDigest: receipt.receiptDigest,
            providerSettlementTransaction: receipt.settlement.transaction,
            observedAt: Math.floor(now() / 1_000),
          },
          context: lifecycleAttestationContext,
          now,
        });
        fee = feeResolution.fee;
        const feeStage = Number(fee.state) === FEE.captured ? "feeCaptured" : "feeRefunded";
        record = await checkpoint(record, feeStage, feeResolution.write || {
          recoveredFromChain: true,
          state: Number(fee.state),
        }, false);
      }
    }
    if (receipt.clock?.delivered && receipt.clock.completedWithinSla) {
      if (Number(covenant.state) === COVENANT.active) {
        changes.push({ quoteId: record.id, action: "release_coverage" });
        if (!dryRun) {
          const write = await issuer.release(
            record.covenantId,
            receipt.clock.completedAt,
            receipt.receiptDigest,
            lifecycleAttestationContext,
          );
          record = await checkpoint(record, "coverageReleased", write, false);
          covenant = await issuer.getCovenant(record.covenantId);
        }
      }
    } else if (receipt.response?.recovery) {
      holds.push({
        quoteId: record.id,
        reason: "provider_delivery_indeterminate_manual_resolution",
        settlementTransaction: receipt.settlement.transaction,
      });
    } else {
      const nowSeconds = Math.floor(now() / 1_000);
      if (Number(covenant.state) === COVENANT.active && nowSeconds > Number(covenant.deadline)) {
        const breach = {
          protocol: "PolicyPool Direct A2MCP",
          version: "0.4.0",
          quoteId: record.id,
          covenantId: record.covenantId,
          relayReceiptId: receipt.receiptId,
          deadline: Number(covenant.deadline),
          observedAt: nowSeconds,
          providerResponseStatus: receipt.response?.status ?? null,
          providerResponseHash: receipt.response?.hash ?? null,
        };
        changes.push({ quoteId: record.id, action: "mark_payout_due" });
        if (!dryRun) {
          const write = await issuer.markPayoutDue(
            record.covenantId,
            evidenceHash(breach),
            { ...lifecycleAttestationContext, breach },
          );
          record = await checkpoint(record, "payoutDue", write, false);
          covenant = await issuer.getCovenant(record.covenantId);
        }
      }
      if (
        Number(covenant.state) === COVENANT.payoutDue
        && nowSeconds > Number(covenant.payoutDueAt) + SETTLEMENT_CHALLENGE_SECONDS
      ) {
        const recovery = {
          protocol: "PolicyPool Direct A2MCP",
          version: "0.4.0",
          quoteId: record.id,
          covenantId: record.covenantId,
          providerPaymentTransaction: receipt.settlement.transaction,
          marketplaceEscrowRefundAtomic: "0",
          otherRecoveryAtomic: "0",
          directTransferFinal: true,
          observedAt: nowSeconds,
        };
        changes.push({ quoteId: record.id, action: "settle_net_loss" });
        if (!dryRun) {
          const write = await issuer.settleNetLoss(
            record.covenantId,
            "0",
            "0",
            true,
            evidenceHash(recovery),
            { ...lifecycleAttestationContext, recovery },
          );
          record = await checkpoint(record, "coverageSettled", write, false);
          covenant = await issuer.getCovenant(record.covenantId);
        }
      }
    }
    if (!dryRun) {
      covenant = await issuer.getCovenant(record.covenantId);
      fee = await feeEscrow.getFee(record.feeId);
    }
    if (
      [COVENANT.released, COVENANT.paid, COVENANT.recoveredWithoutPayout]
        .includes(Number(covenant.state))
      && [FEE.captured, FEE.refunded].includes(Number(fee.state))
    ) {
      await complete(record, {
        ok: true,
        reconciled: true,
        quoteId: record.id,
        covenantId: record.covenantId,
        feeId: record.feeId,
        feeState: Number(fee.state),
        feeOutcome: Number(fee.state) === FEE.captured
          ? "captured"
          : "refunded_after_provider_settlement",
        coverageState: Number(covenant.state),
        providerRelayReceiptId: receipt.receiptId,
        providerSettlementTransaction: receipt.settlement.transaction,
      }, dryRun);
    }
  }

  async function reconcileUnsettled(record, dryRun, changes, holds) {
    const nowSeconds = Math.floor(now() / 1_000);
    if (nowSeconds <= Number(record.providerAuthorizationValidBefore)) {
      holds.push({ quoteId: record.id, reason: "provider_authorization_still_active" });
      return;
    }
    let covenant = await issuer.getCovenant(record.covenantId);
    let fee = await feeEscrow.getFee(record.feeId);
    const refundReadyAt = Number(fee.refundAvailableAt || Math.max(
      Number(record.feeValidBefore),
      Number(record.providerAuthorizationValidBefore),
    ) + 120);
    if (nowSeconds < refundReadyAt) {
      holds.push({ quoteId: record.id, reason: "fee_refund_delay_active", refundReadyAt });
      return;
    }
    const settlementSearchNotBefore = Math.floor(Number(record.execution?.startedAtMs || 0) / 1_000)
      || Math.max(1, Number(record.providerAuthorizationValidBefore) - 15 * 60);
    const nonSettlement = {
      protocol: "PolicyPool Direct A2MCP",
      version: "0.4.0",
      quoteId: record.id,
      covenantId: record.covenantId,
      buyer: record.buyer,
      provider: record.providerAccepted.payTo,
      amountAtomic: record.servicePriceAtomic,
      providerAuthorizationHash: record.providerAuthorizationHash,
      providerAuthorizationId: record.providerAuthorizationId,
      authorizationNonce: record.providerAuthorizationNonce,
      authorizationValidAfter: record.providerAuthorizationValidAfter,
      authorizationValidBefore: record.providerAuthorizationValidBefore,
      policyFeeAuthorizationHash: record.feeId,
      policyFeeAuthorizationNonce: record.feeNonce,
      policyFeeAuthorizationValidBefore: record.feeValidBefore,
      settlementSearchNotBefore,
      settlementSearchResult: "not_found",
      observedAt: nowSeconds,
    };
    let recovery;
    if (Number(fee.state) === FEE.funded) {
      changes.push({ quoteId: record.id, action: "refund_policy_fee" });
      if (!dryRun) {
        const write = await feeEscrow.refund(record.feeId);
        record = await checkpoint(record, "feeRefunded", write, false);
        fee = await feeEscrow.getFee(record.feeId);
      }
    } else if (Number(fee.state) === FEE.none) {
      const orphan = await recoverOrphanedFee({
        record,
        fee,
        dryRun,
        changes,
        holds,
        recovery,
      });
      record = orphan.record;
      fee = orphan.fee;
      recovery = orphan.recovery;
      if (orphan.pending) return;
    }
    if (![FEE.none, FEE.refunded].includes(Number(fee.state))) {
      holds.push({
        quoteId: record.id,
        reason: "policy_fee_not_refundable_provider_unsettled_manual_resolution",
        feeState: Number(fee.state),
      });
      return;
    }
    if ([COVENANT.pendingStart, COVENANT.active, COVENANT.payoutDue].includes(Number(covenant.state))) {
      changes.push({ quoteId: record.id, action: "cancel_unpaid_coverage" });
      if (!dryRun) {
        recovery ||= await state.recoveryContext(record.id, record.execution.id);
        const write = await issuer.cancelUnpaid(
          record.covenantId,
          record.feeId,
          evidenceHash(nonSettlement),
          {
            nonSettlement,
            directQuote: record.id,
            policyFeeState: Number(fee.state),
            providerAuthorizationEvidence: directProviderAuthorizationEvidence(
              record,
              recovery.providerPaymentSignature,
            ),
            policyFeeAuthorizationEvidence: directPolicyFeeAuthorizationEvidence(
              record,
              recovery.policyFeePaymentSignature,
              recovery.quoteToken,
            ),
            providerSettlementSearch: {
              payer: record.buyer,
              payTo: record.providerAccepted.payTo,
              asset: record.providerAccepted.asset,
              amountAtomic: record.servicePriceAtomic,
              authorizationNonce: record.providerAuthorizationNonce,
              notBeforeTimestamp: settlementSearchNotBefore,
              notAfterTimestamp: Number(record.providerAuthorizationValidBefore),
            },
          },
        );
        record = await checkpoint(record, "coverageCancelledUnpaid", write, false);
        covenant = await issuer.getCovenant(record.covenantId);
      }
    }
    if (!dryRun) {
      covenant = await issuer.getCovenant(record.covenantId);
      fee = await feeEscrow.getFee(record.feeId);
    }
    if (
      [COVENANT.none, COVENANT.cancelledUnpaid].includes(Number(covenant.state))
      && [FEE.none, FEE.refunded].includes(Number(fee.state))
    ) {
      await complete(record, {
        ok: false,
        reconciled: true,
        quoteId: record.id,
        covenantId: record.covenantId,
        feeId: record.feeId,
        feeState: Number(fee.state),
        coverageState: Number(covenant.state),
        providerPaymentStatus: "not_settled",
        outcome: "cancelled_without_charge",
      }, dryRun);
    }
  }

  async function reconcile({ dryRun = false, limit = 100 } = {}) {
    const records = await state.listExecuting(limit);
    const changes = [];
    const holds = [];
    const failures = [];
    for (const record of records) {
      try {
        let receipt = await relayStore.getRelayReceiptForCovenant(record.covenantId);
        if (!receipt) {
          if (dryRun) {
            holds.push({ quoteId: record.id, reason: "provider_recovery_not_run_in_dry_run" });
            continue;
          }
          try {
            const recovered = await recoverProviderResult(record);
            receipt = recovered?.receipt || null;
          } catch (error) {
            if (
              !(error instanceof ProviderRelayError)
              || error.code !== "provider_payment_settlement_not_found"
            ) throw error;
          }
        }
        if (receipt) await reconcileSettled(record, receipt, dryRun, changes, holds);
        else await reconcileUnsettled(record, dryRun, changes, holds);
      } catch (error) {
        failures.push({
          quoteId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!dryRun) {
          try {
            await state.markReconciled(record.id);
          } catch (error) {
            failures.push({
              quoteId: record.id,
              error: `direct_execution_index_rotation_failed:${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      }
    }
    return {
      ok: failures.length === 0,
      version: "0.4.0",
      dryRun,
      scanned: records.length,
      changes,
      holds,
      failures,
    };
  }

  return { reconcile };
}
