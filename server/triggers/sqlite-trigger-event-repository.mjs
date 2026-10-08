import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { normalizeTriggerEvent } from "./trigger-event-contract-v1.mjs";

const TRIGGER_EVENT_REPOSITORY_CONTRACT_VERSION = "trigger-event-repository.v4";
const TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION = "trigger-execution-snapshot.v3";
const EXECUTION_SNAPSHOT_FIELDS = new Set([
  "bindingId",
  "bindingVersion",
  "contractVersion",
  "handlerVersion",
  "outputPolicyRef",
  "sourceAdapterId",
  "sourceSystemId",
  "skillPolicyRef",
  "targetEmployeeId",
  "targetEmployeeVersion",
  "taskDefinitionId",
  "taskDefinitionVersion",
  "toolPolicyRef",
  "writebackPolicyRef",
]);

function createSqliteTriggerEventRepository({ databasePath } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeDatabase(database);

  function saveOrGet(value, { tenantScope, bindingId, executionSnapshot } = {}) {
    const event = normalizeTriggerEvent(value);
    const safeTenantScope = requiredReference(tenantScope);
    const safeBindingId = requiredReference(bindingId);
    const snapshot = normalizeTriggerExecutionSnapshot(executionSnapshot);
    if (snapshot.bindingId !== safeBindingId) {
      throw repositoryError("trigger_event_execution_snapshot_binding_mismatch");
    }
    const triggerEventId = deriveTriggerEventId(safeTenantScope, safeBindingId, event.eventId);

    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readByExternalIdentity(safeTenantScope, safeBindingId, event.eventId);
      if (existingRow) {
        const existing = rowToTriggerEvent(existingRow);
        if (!isDeepStrictEqual(existing.event, event)) {
          throw repositoryError("trigger_event_idempotency_conflict");
        }
        if (!isDeepStrictEqual(existing.executionSnapshot, snapshot)) {
          throw repositoryError("trigger_event_execution_snapshot_conflict");
        }
        database.exec("COMMIT");
        return Object.freeze({ created: false, triggerEvent: existing });
      }

      database.prepare(`
        INSERT INTO trigger_events (
          trigger_event_id, tenant_scope, binding_id, external_event_id,
          contract_version, event_type, occurred_at, source_tenant_id,
          object_api_name, object_id, approval_instance_id, node_api_name,
          execution_snapshot_contract_version, binding_version, task_definition_id,
          task_definition_version, handler_version,
          skill_policy_ref, tool_policy_ref, output_policy_ref, writeback_policy_ref,
          target_employee_id, target_employee_version, source_adapter_id, source_system_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        triggerEventId,
        safeTenantScope,
        safeBindingId,
        event.eventId,
        event.contractVersion,
        event.eventType,
        event.occurredAt,
        event.sourceTenantId,
        event.subject.objectApiName,
        event.subject.objectId,
        event.subject.approvalInstanceId,
        event.subject.nodeApiName,
        snapshot.contractVersion,
        snapshot.bindingVersion,
        snapshot.taskDefinitionId,
        snapshot.taskDefinitionVersion,
        snapshot.handlerVersion,
        snapshot.skillPolicyRef,
        snapshot.toolPolicyRef,
        snapshot.outputPolicyRef,
        snapshot.writebackPolicyRef,
        snapshot.targetEmployeeId,
        snapshot.targetEmployeeVersion,
        snapshot.sourceAdapterId,
        snapshot.sourceSystemId,
      );
      database.exec("COMMIT");
      return Object.freeze({
        created: true,
        triggerEvent: createStoredTriggerEvent({
          bindingId: safeBindingId,
          event,
          executionSnapshot: snapshot,
          tenantScope: safeTenantScope,
          triggerEventId,
        }),
      });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function get(triggerEventId, { tenantScope } = {}) {
    const safeTriggerEventId = requiredReference(triggerEventId);
    const safeTenantScope = requiredReference(tenantScope);
    const row = database.prepare(`
      SELECT *
      FROM trigger_events
      WHERE trigger_event_id = ? AND tenant_scope = ?
    `).get(safeTriggerEventId, safeTenantScope);
    return row ? rowToTriggerEvent(row) : null;
  }

  function list({ tenantScope, bindingId = null, limit = 100 } = {}) {
    const safeTenantScope = requiredReference(tenantScope);
    const safeBindingId = bindingId === null ? null : requiredReference(bindingId);
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
    return database.prepare(`
      SELECT * FROM trigger_events
      WHERE tenant_scope = ? AND (? IS NULL OR binding_id = ?)
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(safeTenantScope, safeBindingId, safeBindingId, safeLimit).map(rowToTriggerEvent);
  }

  function readByExternalIdentity(tenantScope, bindingId, externalEventId) {
    return database.prepare(`
      SELECT *
      FROM trigger_events
      WHERE tenant_scope = ? AND binding_id = ? AND external_event_id = ?
    `).get(tenantScope, bindingId, externalEventId) || null;
  }

  return Object.freeze({
    adapterKind: "sqlite_durable_safe_trigger_event",
    close: () => database.close(),
    contractVersion: TRIGGER_EVENT_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    get,
    list,
    saveOrGet,
    schemaVersion: 4,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS trigger_event_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO trigger_event_schema (singleton, version)
    VALUES (1, 4)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS trigger_events (
      trigger_event_id TEXT PRIMARY KEY,
      tenant_scope TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_tenant_id TEXT NOT NULL,
      object_api_name TEXT NOT NULL,
      object_id TEXT NOT NULL,
      approval_instance_id TEXT,
      node_api_name TEXT,
      execution_snapshot_contract_version TEXT,
      binding_version TEXT,
      task_definition_id TEXT,
      task_definition_version TEXT,
      handler_version TEXT,
      skill_policy_ref TEXT,
      tool_policy_ref TEXT,
      output_policy_ref TEXT,
      writeback_policy_ref TEXT,
      target_employee_id TEXT,
      target_employee_version TEXT,
      source_adapter_id TEXT,
      source_system_id TEXT,
      UNIQUE (tenant_scope, binding_id, external_event_id)
    );
    CREATE INDEX IF NOT EXISTS trigger_events_tenant_binding_idx
      ON trigger_events (tenant_scope, binding_id, external_event_id);
  `);
  let schema = database.prepare(
    "SELECT version FROM trigger_event_schema WHERE singleton = 1",
  ).get();
  if (schema?.version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE trigger_events ADD COLUMN execution_snapshot_contract_version TEXT;
      ALTER TABLE trigger_events ADD COLUMN binding_version TEXT;
      ALTER TABLE trigger_events ADD COLUMN task_definition_id TEXT;
      ALTER TABLE trigger_events ADD COLUMN target_employee_id TEXT;
      ALTER TABLE trigger_events ADD COLUMN target_employee_version TEXT;
      ALTER TABLE trigger_events ADD COLUMN source_adapter_id TEXT;
      ALTER TABLE trigger_events ADD COLUMN source_system_id TEXT;
      UPDATE trigger_event_schema SET version = 2 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 2 };
  }
  if (schema?.version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE trigger_events ADD COLUMN task_definition_version TEXT;
      ALTER TABLE trigger_events ADD COLUMN handler_version TEXT;
      ALTER TABLE trigger_events ADD COLUMN skill_policy_ref TEXT;
      ALTER TABLE trigger_events ADD COLUMN output_policy_ref TEXT;
      ALTER TABLE trigger_events ADD COLUMN writeback_policy_ref TEXT;
      UPDATE trigger_event_schema SET version = 3 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 3 };
  }
  if (schema?.version === 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE trigger_events ADD COLUMN tool_policy_ref TEXT;
      UPDATE trigger_event_schema SET version = 4 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 4 };
  }
  if (schema?.version !== 4) throw new TypeError("unsupported trigger event SQLite schema version");
  const columns = new Set(database.prepare("PRAGMA table_info(trigger_events)").all()
    .map((column) => column.name));
  const requiredColumns = [
    "trigger_event_id", "tenant_scope", "binding_id", "external_event_id",
    "contract_version", "event_type", "occurred_at", "source_tenant_id",
    "object_api_name", "object_id", "approval_instance_id", "node_api_name",
    "execution_snapshot_contract_version", "binding_version", "task_definition_id",
    "task_definition_version", "handler_version", "skill_policy_ref", "tool_policy_ref",
    "output_policy_ref", "writeback_policy_ref", "target_employee_id",
    "target_employee_version", "source_adapter_id", "source_system_id",
  ];
  if (columns.size !== requiredColumns.length || requiredColumns.some((column) => !columns.has(column))) {
    throw new TypeError("invalid trigger event SQLite schema v4");
  }
}

function rowToTriggerEvent(row) {
  const tenantScope = requiredReference(row.tenant_scope);
  const bindingId = requiredReference(row.binding_id);
  const triggerEventId = requiredReference(row.trigger_event_id);
  const event = normalizeTriggerEvent({
    contractVersion: row.contract_version,
    eventId: row.external_event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    sourceTenantId: row.source_tenant_id,
    subject: {
      objectApiName: row.object_api_name,
      objectId: row.object_id,
      approvalInstanceId: row.approval_instance_id,
      nodeApiName: row.node_api_name,
    },
  });
  const executionSnapshot = snapshotFromRow(row, bindingId);
  const expectedTriggerEventId = deriveTriggerEventId(tenantScope, bindingId, event.eventId);
  if (triggerEventId !== expectedTriggerEventId) {
    throw repositoryError("trigger_event_record_invalid");
  }
  return createStoredTriggerEvent({
    bindingId,
    event,
    executionSnapshot,
    tenantScope,
    triggerEventId,
  });
}

function createStoredTriggerEvent({ bindingId, event, executionSnapshot, tenantScope, triggerEventId }) {
  return Object.freeze({
    bindingId,
    event,
    executionSnapshot,
    externalEventId: event.eventId,
    tenantScope,
    triggerEventId,
  });
}

function snapshotFromRow(row, bindingId) {
  const legacyValues = [
    row.execution_snapshot_contract_version,
    row.binding_version,
    row.task_definition_id,
    row.target_employee_id,
    row.target_employee_version,
    row.source_adapter_id,
    row.source_system_id,
  ];
  if (legacyValues.every((value) => value === null || value === undefined)) {
    throw repositoryError("trigger_event_execution_snapshot_unavailable");
  }
  if (row.execution_snapshot_contract_version !== TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION) {
    throw repositoryError("trigger_event_execution_snapshot_legacy");
  }
  const values = [
    ...legacyValues,
    row.task_definition_version,
    row.handler_version,
    row.skill_policy_ref,
    row.tool_policy_ref,
    row.output_policy_ref,
    row.writeback_policy_ref,
  ];
  if (values.some((value) => value === null || value === undefined)) {
    throw repositoryError("trigger_event_execution_snapshot_invalid");
  }
  return normalizeTriggerExecutionSnapshot({
    contractVersion: row.execution_snapshot_contract_version,
    bindingId,
    bindingVersion: row.binding_version,
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: row.task_definition_version,
    handlerVersion: row.handler_version,
    skillPolicyRef: row.skill_policy_ref,
    toolPolicyRef: row.tool_policy_ref,
    outputPolicyRef: row.output_policy_ref,
    writebackPolicyRef: row.writeback_policy_ref,
    targetEmployeeId: row.target_employee_id,
    targetEmployeeVersion: row.target_employee_version,
    sourceAdapterId: row.source_adapter_id,
    sourceSystemId: row.source_system_id,
  });
}

function normalizeTriggerExecutionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== EXECUTION_SNAPSHOT_FIELDS.size ||
    Object.keys(value).some((field) => !EXECUTION_SNAPSHOT_FIELDS.has(field)) ||
    [...EXECUTION_SNAPSHOT_FIELDS].some((field) => !Object.hasOwn(value, field))) {
    throw repositoryError("trigger_event_execution_snapshot_invalid");
  }
  if (value.contractVersion !== TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION) {
    throw repositoryError("trigger_event_execution_snapshot_invalid");
  }
  return Object.freeze({
    contractVersion: TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION,
    bindingId: requiredSnapshotReference(value.bindingId),
    bindingVersion: requiredSnapshotReference(value.bindingVersion),
    taskDefinitionId: requiredSnapshotReference(value.taskDefinitionId),
    taskDefinitionVersion: requiredSnapshotReference(value.taskDefinitionVersion),
    handlerVersion: requiredSnapshotReference(value.handlerVersion),
    skillPolicyRef: requiredSnapshotReference(value.skillPolicyRef, 240),
    toolPolicyRef: requiredSnapshotReference(value.toolPolicyRef, 240),
    outputPolicyRef: requiredSnapshotReference(value.outputPolicyRef, 240),
    writebackPolicyRef: requiredSnapshotReference(value.writebackPolicyRef, 240),
    targetEmployeeId: requiredSnapshotReference(value.targetEmployeeId),
    targetEmployeeVersion: requiredSnapshotReference(value.targetEmployeeVersion),
    sourceAdapterId: requiredSnapshotReference(value.sourceAdapterId),
    sourceSystemId: requiredSnapshotReference(value.sourceSystemId),
  });
}

function requiredSnapshotReference(value, maximum = 160) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
    value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    throw repositoryError("trigger_event_execution_snapshot_invalid");
  }
  return value;
}

function deriveTriggerEventId(tenantScope, bindingId, externalEventId) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([tenantScope, bindingId, externalEventId]), "utf8")
    .digest("hex");
  return `trigger_event_${digest}`;
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) {
    throw new TypeError("trigger event databasePath must be absolute or :memory:");
  }
  return path.normalize(text);
}

function requiredReference(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text)) {
    throw repositoryError("trigger_event_reference_invalid");
  }
  return text;
}

function rollbackIfActive(database) {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function repositoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  TRIGGER_EVENT_REPOSITORY_CONTRACT_VERSION,
  TRIGGER_EXECUTION_SNAPSHOT_CONTRACT_VERSION,
  createSqliteTriggerEventRepository,
  normalizeTriggerExecutionSnapshot,
};
