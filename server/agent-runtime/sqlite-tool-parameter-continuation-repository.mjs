import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase, initializeSqliteDatabase } from "../sqlite-lifecycle.mjs";
import {
  DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS,
  TOOL_PARAMETER_CARD_CONTRACT_VERSION,
  publicToolParameterCard,
  toolParameterCardDraftForPersistence,
} from "./tool-parameter-card.mjs";

const REPOSITORY_CONTRACT_VERSION = "tool-parameter-continuation-repository.v1";

function createSqliteToolParameterContinuationRepository({ databasePath, encryptionKey, now = () => Date.now(), ttlMs = DEFAULT_TOOL_PARAMETER_CONTINUATION_TTL_MS } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const key = exactKey(encryptionKey);
  const safeTtlMs = positiveInteger(ttlMs, "ttlMs");
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeSqliteDatabase(database, initialize);

  function saveDraft({ card, employeeId, routeDigest, sessionId, sourceTaskId } = {}) {
    const issuedAt = new Date(now()).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + safeTtlMs).toISOString();
    const persistenceCard = toolParameterCardDraftForPersistence(card);
    if (!persistenceCard) throw repositoryError("tool_parameter_card_invalid");
    const baseCard = publicToolParameterCard({
      ...persistenceCard,
      createdAt: issuedAt,
      id: deterministicCardId({ employeeId, schemaDigest: persistenceCard.schemaDigest, sessionId, sourceTaskId, toolId: persistenceCard.toolId, operationId: persistenceCard.operationId }),
      expiresAt,
    });
    if (!baseCard) throw repositoryError("tool_parameter_card_invalid");
    const identity = normalizeIdentity({ employeeId, routeDigest, sessionId });
    const record = {
      contractVersion: "tool-parameter-continuation-record.v1",
      card: baseCard,
      ...(persistenceCard.protectedSelectionEvidence ? { protectedSelectionEvidence: structuredClone(persistenceCard.protectedSelectionEvidence) } : {}),
      identity,
      sourceTaskId: requiredToken(sourceTaskId, "sourceTaskId", 160),
      createdAt: issuedAt,
      expiresAt,
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readRecord(baseCard.id);
      if (existing) {
        if (!sameDraft(existing, record)) throw repositoryError("tool_parameter_card_idempotency_conflict");
        database.exec("COMMIT");
        return storedCard(existing, safeTtlMs);
      }
      supersedePriorOperationDrafts(record);
      database.prepare(`
        INSERT INTO tool_parameter_continuations
          (card_id, employee_id, session_id, route_digest, status, execution_input_ref_id, expires_at, ciphertext)
        VALUES (?, ?, ?, ?, 'draft', '', ?, ?)
      `).run(baseCard.id, identity.employeeId, identity.sessionId, identity.routeDigest, expiresAt, seal(record, key, aad(baseCard.id)));
      database.exec("COMMIT");
      return storedCard(record, safeTtlMs);
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function submit({ arguments: argumentsValue, cardId, employeeId, executionInputRefId, routeDigest, schemaDigest, sessionId } = {}) {
    const safeCardId = requiredToken(cardId, "cardId", 240);
    const identity = normalizeIdentity({ employeeId, routeDigest, sessionId });
    const safeExecutionInputRefId = requiredToken(executionInputRefId, "executionInputRefId", 240);
    const safeSchemaDigest = requiredDigest(schemaDigest, "schemaDigest");
    const safeArguments = normalizeArguments(argumentsValue);
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = readRow(safeCardId);
      if (!row) throw repositoryError("tool_parameter_card_not_found");
      const record = open(row, key);
      requireIdentity(record.identity, identity);
      if (effectiveExpiresAt(record, safeTtlMs) <= new Date(now()).toISOString()) throw repositoryError("tool_parameter_card_expired");
      if (record.card.schemaDigest !== safeSchemaDigest) throw repositoryError("tool_parameter_card_schema_stale");
      if (!agentManagedArgumentsMatch(record.card.argumentSchema, record.card.initialArguments, safeArguments)) {
        throw repositoryError("tool_parameter_card_agent_managed_argument_mismatch");
      }
      const continuation = {
        contractVersion: "tool-parameter-continuation.v1",
        cardId: safeCardId,
        toolId: record.card.toolId,
        operationId: record.card.operationId,
        schemaDigest: safeSchemaDigest,
        arguments: safeArguments,
        ...selectionEvidenceForSubmission(record, safeArguments),
        ...(record.card.inputSource ? { inputSource: structuredClone(record.card.inputSource) } : {}),
        submittedAt: row.status === "submitted" ? record.continuation?.submittedAt : new Date(now()).toISOString(),
      };
      const submitted = {
        ...record,
        card: { ...record.card, status: "submitted" },
        continuation,
        executionInputRefId: safeExecutionInputRefId,
        ...presentationEvidenceForSubmission(record, safeArguments),
      };
      const continuationWithPresentation = continuationWithPresentationEvidence(continuation, submitted.presentationEvidence);
      if (row.status === "submitted") {
        if (row.execution_input_ref_id !== safeExecutionInputRefId || !isDeepStrictEqual(record.continuation, continuation)) {
          throw repositoryError("tool_parameter_card_already_submitted");
        }
        database.exec("COMMIT");
        return continuationWithPresentation;
      }
      database.prepare(`
        UPDATE tool_parameter_continuations
        SET status = 'submitted', execution_input_ref_id = ?, ciphertext = ?
        WHERE card_id = ? AND status = 'draft'
      `).run(safeExecutionInputRefId, seal(submitted, key, aad(safeCardId)), safeCardId);
      database.exec("COMMIT");
      return continuationWithPresentation;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  function continuationForExecutionInput(executionInputRefId, identityValue = {}) {
    const safeRef = requiredToken(executionInputRefId, "executionInputRefId", 240);
    const row = database.prepare(`
      SELECT * FROM tool_parameter_continuations
      WHERE execution_input_ref_id = ? AND status = 'submitted'
    `).get(safeRef);
    if (!row) return null;
    const record = open(row, key);
    requireIdentity(record.identity, normalizeIdentity(identityValue));
    if (effectiveExpiresAt(record, safeTtlMs) <= new Date(now()).toISOString()) return null;
    return continuationWithPresentationEvidence(record.continuation, record.presentationEvidence);
  }

  function presentationEvidenceForExecutionInput(executionInputRefId, identityValue = {}) {
    const safeRef = requiredToken(executionInputRefId, "executionInputRefId", 240);
    const row = database.prepare(`
      SELECT * FROM tool_parameter_continuations
      WHERE execution_input_ref_id = ? AND status = 'submitted'
    `).get(safeRef);
    if (!row) return null;
    const record = open(row, key);
    requireIdentity(record.identity, normalizeIdentity(identityValue));
    if (effectiveExpiresAt(record, safeTtlMs) <= new Date(now()).toISOString()) return null;
    return record.presentationEvidence ? structuredClone(record.presentationEvidence) : null;
  }

  function latestPresentationEvidence(identityValue = {}) {
    const identity = normalizeIdentity(identityValue);
    const nowIso = new Date(now()).toISOString();
    const rows = database.prepare(`
      SELECT * FROM tool_parameter_continuations
      WHERE employee_id = ? AND session_id = ? AND route_digest = ? AND status = 'submitted' AND expires_at > ?
      ORDER BY expires_at DESC, execution_input_ref_id DESC
    `).all(identity.employeeId, identity.sessionId, identity.routeDigest, nowIso);
    const latest = rows
      .map((row) => open(row, key))
      .filter((record) => effectiveExpiresAt(record, safeTtlMs) > nowIso && record.presentationEvidence)
      .sort((left, right) => submissionTimestampMs(right) - submissionTimestampMs(left))[0];
    return latest?.presentationEvidence ? structuredClone(latest.presentationEvidence) : null;
  }

  function listDrafts({ employeeId, routeDigest, sessionId, sourceTaskId = "" } = {}) {
    const identity = normalizeIdentity({ employeeId, routeDigest, sessionId });
    const nowIso = new Date(now()).toISOString();
    database.prepare("DELETE FROM tool_parameter_continuations WHERE expires_at <= ?").run(nowIso);
    const records = database.prepare(`
      SELECT * FROM tool_parameter_continuations
      WHERE employee_id = ? AND session_id = ? AND route_digest = ? AND status = 'draft'
      ORDER BY card_id ASC
    `).all(identity.employeeId, identity.sessionId, identity.routeDigest).map((row) => open(row, key));
    const expiredIds = records.filter((record) => effectiveExpiresAt(record, safeTtlMs) <= nowIso).map((record) => record.card.id);
    for (const cardId of expiredIds) database.prepare("DELETE FROM tool_parameter_continuations WHERE card_id = ?").run(cardId);
    return records
      .filter((record) => !expiredIds.includes(record.card.id) && (!sourceTaskId || record.sourceTaskId === sourceTaskId))
      .map((record) => storedCard(record, safeTtlMs));
  }

  function readRecord(cardId) {
    const row = readRow(cardId);
    return row ? open(row, key) : null;
  }

  function readRow(cardId) {
    return database.prepare("SELECT * FROM tool_parameter_continuations WHERE card_id = ?").get(cardId);
  }

  function supersedePriorOperationDrafts(record) {
    const rows = database.prepare(`
      SELECT * FROM tool_parameter_continuations
      WHERE employee_id = ? AND session_id = ? AND route_digest = ? AND status = 'draft' AND card_id <> ?
    `).all(record.identity.employeeId, record.identity.sessionId, record.identity.routeDigest, record.card.id);
    for (const row of rows) {
      const prior = open(row, key);
      if (prior.card.toolId === record.card.toolId && prior.card.operationId === record.card.operationId) {
        database.prepare("DELETE FROM tool_parameter_continuations WHERE card_id = ? AND status = 'draft'").run(row.card_id);
      }
    }
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_tool_parameter_continuation",
    close: () => closeSqliteDatabase(database),
    contractVersion: REPOSITORY_CONTRACT_VERSION,
    continuationForExecutionInput,
    latestPresentationEvidence,
    listDrafts,
    presentationEvidenceForExecutionInput,
    purgeExpired: () => database.prepare("DELETE FROM tool_parameter_continuations WHERE expires_at <= ?").run(new Date(now()).toISOString()).changes,
    saveDraft,
    submit,
  });
}

function initialize(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS tool_parameter_continuations (
      card_id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      route_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
      execution_input_ref_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ciphertext TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_parameter_continuation_input_idx
      ON tool_parameter_continuations (execution_input_ref_id)
      WHERE execution_input_ref_id <> '';
    CREATE INDEX IF NOT EXISTS tool_parameter_continuation_session_idx
      ON tool_parameter_continuations (employee_id, session_id, route_digest, status, expires_at);
  `);
}

function deterministicCardId(value) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `tool-card-${digest}`;
}

function sameDraft(left, right) {
  return left.contractVersion === right.contractVersion && left.sourceTaskId === right.sourceTaskId &&
    isDeepStrictEqual(left.identity, right.identity) &&
    isDeepStrictEqual(left.protectedSelectionEvidence, right.protectedSelectionEvidence) &&
    isDeepStrictEqual(stableDraftCard(left.card), stableDraftCard(right.card));
}

function selectedProtectedOption(record = {}, argumentsValue = {}) {
  const evidence = record.protectedSelectionEvidence;
  const selectedValue = evidence?.fieldId ? argumentsValue?.[evidence.fieldId] : undefined;
  return typeof selectedValue === "string"
    ? evidence?.options?.find((option) => option?.value === selectedValue) || null
    : null;
}

function selectionEvidenceForSubmission(record = {}, argumentsValue = {}) {
  const option = selectedProtectedOption(record, argumentsValue);
  return option?.safeContext ? {
    selectionEvidence: {
      contractVersion: "tool-parameter-selection-evidence.v1",
      fields: structuredClone(option.safeContext),
    },
  } : {};
}

function presentationEvidenceForSubmission(record = {}, argumentsValue = {}) {
  const links = selectedProtectedOption(record, argumentsValue)?.presentationLinks;
  return Array.isArray(links) && links.length ? {
    presentationEvidence: {
      contractVersion: "channel-presentation-evidence.v1",
      links: structuredClone(links),
    },
  } : {};
}

function continuationWithPresentationEvidence(continuation = {}, presentationEvidence = null) {
  const value = structuredClone(continuation);
  const evidence = presentationEvidence?.contractVersion === "channel-presentation-evidence.v1"
    ? structuredClone(presentationEvidence)
    : null;
  if (evidence) {
    Object.defineProperty(value, "presentationEvidence", {
      configurable: true,
      enumerable: false,
      value: evidence,
      writable: false,
    });
  }
  return value;
}

function stableDraftCard(card = {}) {
  const { createdAt: _createdAt, expiresAt: _expiresAt, ...stable } = card;
  return stable;
}

function effectiveExpiresAt(record = {}, ttlMs) {
  const createdAtMs = Date.parse(String(record.card?.createdAt || record.createdAt || ""));
  const storedExpiresAtMs = Date.parse(String(record.expiresAt || record.card?.expiresAt || ""));
  if (!Number.isFinite(createdAtMs)) return new Date(storedExpiresAtMs).toISOString();
  return new Date(Math.min(storedExpiresAtMs, createdAtMs + ttlMs)).toISOString();
}

function storedCard(record = {}, ttlMs) {
  return {
    ...record.card,
    createdAt: record.card?.createdAt || record.createdAt,
    expiresAt: effectiveExpiresAt(record, ttlMs),
  };
}

function submissionTimestampMs(record = {}) {
  const candidates = [
    record.continuation?.submittedAt,
    record.card?.createdAt,
    record.createdAt,
  ];
  for (const value of candidates) {
    const ms = Date.parse(String(value || ""));
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function normalizeIdentity(value = {}) {
  return {
    employeeId: requiredToken(value.employeeId, "employeeId", 180),
    sessionId: requiredToken(value.sessionId, "sessionId", 180),
    routeDigest: requiredDigest(value.routeDigest, "routeDigest"),
  };
}

function requireIdentity(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw repositoryError("tool_parameter_card_identity_mismatch");
}

function normalizeArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw repositoryError("tool_parameter_card_arguments_invalid");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) throw repositoryError("tool_parameter_card_arguments_too_large");
  const parsed = JSON.parse(json);
  if (containsSensitiveKey(parsed)) throw repositoryError("tool_parameter_card_sensitive_argument_forbidden");
  return parsed;
}

function containsSensitiveKey(value, depth = 0) {
  if (depth > 6) return true;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => /authorization|bearer|token|secret|password|cookie|api[-_]?key|credential/i.test(key) || containsSensitiveKey(item, depth + 1));
}

function agentManagedArgumentsMatch(schema = {}, expected, actual) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  if (schema["x-agent-managed"] === true) return isDeepStrictEqual(expected, actual);
  if (schema.type !== "object" && !schema.properties) return true;
  return Object.entries(schema.properties || {}).every(([key, child]) => (
    agentManagedArgumentsMatch(child, expected?.[key], actual?.[key])
  ));
}

function seal(value, key, authenticatedData) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(authenticatedData, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: body.toString("base64") });
}

function open(row, key) {
  try {
    const envelope = JSON.parse(row.ciphertext);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(aad(row.card_id), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    if (record.card?.contractVersion !== TOOL_PARAMETER_CARD_CONTRACT_VERSION || record.card.id !== row.card_id ||
      record.identity?.employeeId !== row.employee_id || record.identity?.sessionId !== row.session_id ||
      record.identity?.routeDigest !== row.route_digest || record.expiresAt !== row.expires_at ||
      record.card?.status !== row.status) throw new Error("row binding mismatch");
    return record;
  } catch (error) {
    if (error?.code?.startsWith?.("tool_parameter_")) throw error;
    throw repositoryError("tool_parameter_card_decryption_failed");
  }
}

function aad(cardId) { return `tool-parameter-continuation.v1:${cardId}`; }
function rollback(database) { try { database.exec("ROLLBACK"); } catch { /* no active transaction */ } }
function exactKey(value) { if (!Buffer.isBuffer(value) || value.length !== 32) throw new TypeError("tool parameter continuation repository requires a 32-byte encryption key"); return value; }
function positiveInteger(value, field) { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`); return value; }
function requiredDatabasePath(value) { const text = String(value || "").trim(); if (text !== ":memory:" && !path.isAbsolute(text)) throw new TypeError("tool parameter continuation databasePath must be absolute or :memory:"); return text; }
function requiredDigest(value, field) { const text = String(value || "").trim(); if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(text)) throw repositoryError(`tool_parameter_card_${field}_invalid`); return text; }
function requiredToken(value, field, max) { const text = String(value || "").trim(); if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw repositoryError(`tool_parameter_card_${field}_invalid`); return text; }
function repositoryError(code) { const error = new Error(code); error.code = code; return error; }

export {
  REPOSITORY_CONTRACT_VERSION,
  createSqliteToolParameterContinuationRepository,
};
