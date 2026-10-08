import {
  normalizeCurrentOperationAuthorization,
  normalizeOperationEffectOutcome,
  normalizeOperationReceipt,
  normalizeOperationReceiptRequest,
  operationReceiptError,
  operationReceiptIdentity,
  sameOperationReceiptIdentity,
} from "./operation-receipt-contract-v1.mjs";
import { classifiedOperationEffectOutcome } from "./classified-operation-effect-error.mjs";

function createIdempotentEffectService({ repository } = {}) {
  assertRepository(repository);

  async function execute({
    authorizeCurrentOperation,
    effect,
    recover = null,
    repositoryContext = {},
    request,
  } = {}) {
    const normalizedRequest = normalizeOperationReceiptRequest(request);
    if (typeof authorizeCurrentOperation !== "function") {
      throw operationReceiptError("operation_receipt_authorizer_required", "current operation authorization callback is required");
    }
    if (typeof effect !== "function") {
      throw operationReceiptError("operation_receipt_effect_required", "operation effect callback is required");
    }
    await requireCurrentAuthorization(authorizeCurrentOperation, normalizedRequest);

    const existing = await repository.readOperationReceiptExact(operationReceiptIdentity(normalizedRequest));
    if (existing) return handleExisting({ existing, normalizedRequest, recover, repositoryContext });

    const prepared = await repository.prepareOperationReceiptWithLease({
      ...repositoryContext,
      ...normalizedRequest,
    });
    if (!prepared) throw ownershipLostError();
    const receipt = requireMatchingReceipt(prepared.receipt, normalizedRequest);
    if (!prepared.created) return handleExisting({ existing: receipt, normalizedRequest, recover, repositoryContext });
    if (receipt.status !== "prepared") {
      throw operationReceiptError("operation_receipt_repository_state_invalid", "a newly prepared receipt must be prepared");
    }
    return runNewEffect({ effect, normalizedRequest, repositoryContext });
  }

  async function handleExisting({ existing, normalizedRequest, recover, repositoryContext }) {
    const receipt = requireMatchingReceipt(existing, normalizedRequest);
    if (receipt.status !== "prepared") return serviceResult(receipt, { replayed: true });
    if (receipt.recoveryMode === "none" || typeof recover !== "function") {
      const unknown = await markUnknown(normalizedRequest, repositoryContext, "external_effect_recovery_unavailable");
      return serviceResult(unknown, { replayed: true });
    }
    let outcome;
    try {
      outcome = normalizeOperationEffectOutcome(await recover({ request: normalizedRequest, receipt }));
    } catch (error) {
      outcome = normalizeOperationEffectOutcome(classifiedOperationEffectOutcome(error) || {
        status: "unknown",
        safeResultCode: "external_effect_recovery_failed",
        receiptPayload: null,
      });
    }
    const committed = await commitOutcome(normalizedRequest, repositoryContext, outcome);
    return serviceResult(committed, { recovered: true });
  }

  async function runNewEffect({ effect, normalizedRequest, repositoryContext }) {
    let outcome;
    try {
      outcome = normalizeOperationEffectOutcome(await effect({ request: normalizedRequest }));
    } catch (error) {
      outcome = normalizeOperationEffectOutcome(classifiedOperationEffectOutcome(error) || {
        status: "unknown",
        safeResultCode: "external_effect_outcome_unknown",
        receiptPayload: null,
      });
    }
    const committed = await commitOutcome(normalizedRequest, repositoryContext, outcome);
    return serviceResult(committed, { executed: true });
  }

  async function commitOutcome(request, repositoryContext, outcome) {
    if (outcome.status === "unknown") {
      return markUnknown(request, repositoryContext, outcome.safeResultCode);
    }
    const receipt = await repository.commitOperationReceiptWithLease({
      ...repositoryContext,
      ...operationReceiptIdentity(request),
      status: outcome.status,
      safeResultCode: outcome.safeResultCode,
      receiptPayload: outcome.receiptPayload,
    });
    if (!receipt) throw ownershipLostError();
    const normalized = requireMatchingReceipt(receipt, request);
    if (normalized.status !== outcome.status) {
      throw operationReceiptError("operation_receipt_repository_state_invalid", "repository committed an unexpected receipt status");
    }
    return normalized;
  }

  async function markUnknown(request, repositoryContext, safeResultCode) {
    const receipt = await repository.markPreparedOperationUnknownWithLease({
      ...repositoryContext,
      ...operationReceiptIdentity(request),
      safeResultCode,
    });
    if (!receipt) throw ownershipLostError();
    const normalized = requireMatchingReceipt(receipt, request);
    if (normalized.status !== "unknown") {
      throw operationReceiptError("operation_receipt_repository_state_invalid", "repository did not mark the prepared receipt unknown");
    }
    return normalized;
  }

  return Object.freeze({ execute });
}

async function requireCurrentAuthorization(authorizeCurrentOperation, request) {
  let decision;
  try {
    decision = normalizeCurrentOperationAuthorization(await authorizeCurrentOperation(request));
  } catch (error) {
    if (error?.code?.startsWith("operation_receipt_")) throw error;
    throw operationReceiptError("operation_receipt_authorization_failed", "current operation authorization could not be verified");
  }
  if (decision.status !== "allowed") {
    throw operationReceiptError("operation_receipt_authorization_denied", "current operation authorization denied the effect");
  }
  if (decision.authorizationDigest !== request.authorizationDigest) {
    throw operationReceiptError("operation_receipt_authorization_changed", "current operation authorization does not match the prepared operation");
  }
}

function requireMatchingReceipt(value, request) {
  const receipt = normalizeOperationReceipt(value);
  if (!sameOperationReceiptIdentity(receipt, request)) {
    throw operationReceiptError("operation_receipt_idempotency_conflict", "receipt identity conflicts with the requested operation");
  }
  return receipt;
}

function serviceResult(receipt, flags = {}) {
  return Object.freeze({
    status: receipt.status,
    executed: Boolean(flags.executed),
    recovered: Boolean(flags.recovered),
    replayed: Boolean(flags.replayed),
    receipt,
  });
}

function ownershipLostError() {
  return operationReceiptError("operation_receipt_ownership_lost", "current task lease no longer owns the operation receipt transition");
}

function assertRepository(repository) {
  for (const method of [
    "commitOperationReceiptWithLease",
    "markPreparedOperationUnknownWithLease",
    "prepareOperationReceiptWithLease",
    "readOperationReceiptExact",
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`idempotent effect service requires repository.${method}`);
    }
  }
}

export { createIdempotentEffectService };
