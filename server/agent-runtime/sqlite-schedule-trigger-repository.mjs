import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEDULE_TRIGGER_CONTRACT_VERSION,
  normalizeScheduleTrigger,
} from "./schedule-trigger-service.mjs";

const SCHEDULE_TRIGGER_REPOSITORY_CONTRACT_VERSION = "schedule-trigger-repository.v3";

function createSqliteScheduleTriggerRepository({ databasePath } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  try { initializeDatabase(database); } catch (error) { database.close(); throw error; }

  function saveOrGet(value) {
    const trigger = normalizeScheduleTrigger(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = readBySlot(trigger.tenantScope, trigger.employeeId, trigger.scheduleId, trigger.scheduledFor, trigger.manualRequestDigest);
      if (existingRow) {
        const existing = rowToTrigger(existingRow);
        if (!isDeepStrictEqual(existing, trigger)) throw repositoryError("schedule_trigger_idempotency_conflict");
        database.exec("COMMIT");
        return Object.freeze({ created: false, trigger: existing });
      }
      database.prepare(`
        INSERT INTO schedule_triggers (
          trigger_id, contract_version, tenant_scope,
          schedule_id, schedule_version, scheduled_for,
          actor_issuer, actor_subject_digest, authorization_digest,
          employee_id, employee_version, task_definition_id,
          execution_contract_digest, permission_digest, schedule_policy_digest,
          execution_task_id, run_configuration_digest, manual_request_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trigger.triggerId,
        trigger.contractVersion,
        trigger.tenantScope,
        trigger.scheduleId,
        trigger.scheduleVersion,
        trigger.scheduledFor,
        trigger.actorIssuer,
        trigger.actorSubjectDigest,
        trigger.authorizationDigest,
        trigger.employeeId,
        trigger.employeeVersion,
        trigger.taskDefinitionId,
        trigger.executionContractDigest,
        trigger.permissionDigest,
        trigger.schedulePolicyDigest,
        trigger.executionTaskId,
        trigger.runConfigurationDigest ?? null,
        trigger.manualRequestDigest ?? null,
      );
      database.exec("COMMIT");
      return Object.freeze({ created: true, trigger });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function get(triggerId, { tenantScope } = {}) {
    return readByTriggerId(
      requiredToken(triggerId, "triggerId", 160),
      requiredToken(tenantScope, "tenantScope", 160),
    );
  }

  function list({ tenantScope, employeeId = null, scheduleId = null, limit = 100 } = {}) {
    const safeTenantScope = requiredToken(tenantScope, "tenantScope", 160);
    const safeEmployeeId = employeeId === null ? null : requiredToken(employeeId, "employeeId", 160);
    const safeScheduleId = scheduleId === null ? null : requiredToken(scheduleId, "scheduleId", 160);
    const safeLimit = boundedInteger(limit, 1, 500);
    return database.prepare(`
      SELECT *
      FROM schedule_triggers
      WHERE tenant_scope = ?
        AND (? IS NULL OR employee_id = ?)
        AND (? IS NULL OR schedule_id = ?)
        AND contract_version = ?
      ORDER BY scheduled_for ASC, trigger_id ASC
      LIMIT ?
    `).all(
      safeTenantScope,
      safeEmployeeId,
      safeEmployeeId,
      safeScheduleId,
      safeScheduleId,
      SCHEDULE_TRIGGER_CONTRACT_VERSION,
      safeLimit,
    ).map(rowToTrigger);
  }

  function readByTriggerId(triggerId, tenantScope) {
    const row = database.prepare(
      "SELECT * FROM schedule_triggers WHERE trigger_id = ? AND tenant_scope = ?",
    ).get(triggerId, tenantScope);
    return row ? rowToTrigger(row) : null;
  }

  function readBySlot(tenantScope, employeeId, scheduleId, scheduledFor, manualRequestDigest) {
    if (manualRequestDigest !== undefined) return database.prepare("SELECT * FROM schedule_triggers WHERE tenant_scope=? AND employee_id=? AND schedule_id=? AND manual_request_digest=?").get(tenantScope, employeeId, scheduleId, manualRequestDigest) || null;
    return database.prepare(`
      SELECT *
      FROM schedule_triggers
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ? AND scheduled_for = ? AND manual_request_digest IS NULL
    `).get(tenantScope, employeeId, scheduleId, scheduledFor) || null;
  }

  return Object.freeze({
    adapterKind: "sqlite_durable_safe_summary",
    close: () => database.close(),
    contractVersion: SCHEDULE_TRIGGER_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    get,
    list,
    saveOrGet,
  });
}

function initializeDatabase(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS schedule_trigger_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schedule_trigger_schema (singleton, version)
    VALUES (1, 3)
    ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS schedule_triggers (
      trigger_id TEXT PRIMARY KEY,
      contract_version TEXT NOT NULL,
      tenant_scope TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      schedule_version TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      actor_issuer TEXT NOT NULL,
      actor_subject_digest TEXT NOT NULL,
      authorization_digest TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      employee_version TEXT NOT NULL,
      task_definition_id TEXT NOT NULL,
      execution_contract_digest TEXT NOT NULL,
      permission_digest TEXT NOT NULL,
      schedule_policy_digest TEXT NOT NULL,
      execution_task_id TEXT NOT NULL UNIQUE,
      UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)
    );
    CREATE INDEX IF NOT EXISTS schedule_triggers_schedule_idx
      ON schedule_triggers (tenant_scope, employee_id, schedule_id, scheduled_for);
  `);
  let schema = database.prepare("SELECT version FROM schedule_trigger_schema WHERE singleton = 1").get();
  if (schema?.version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_triggers ADD COLUMN authorization_digest TEXT;
      ALTER TABLE schedule_triggers ADD COLUMN execution_contract_digest TEXT;
      ALTER TABLE schedule_triggers ADD COLUMN schedule_policy_digest TEXT;
      UPDATE schedule_trigger_schema SET version = 2 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 2 };
  }
  if (schema?.version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE schedule_triggers RENAME TO schedule_triggers_v2;
      CREATE TABLE schedule_triggers (
        trigger_id TEXT PRIMARY KEY,
        contract_version TEXT NOT NULL,
        tenant_scope TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        schedule_version TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        actor_issuer TEXT NOT NULL,
        actor_subject_digest TEXT NOT NULL,
        authorization_digest TEXT,
        employee_id TEXT NOT NULL,
        employee_version TEXT NOT NULL,
        task_definition_id TEXT NOT NULL,
        execution_contract_digest TEXT,
        permission_digest TEXT NOT NULL,
        schedule_policy_digest TEXT,
        execution_task_id TEXT NOT NULL UNIQUE,
        UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)
      );
      INSERT INTO schedule_triggers (
        trigger_id, contract_version, tenant_scope,
        schedule_id, schedule_version, scheduled_for,
        actor_issuer, actor_subject_digest, authorization_digest,
        employee_id, employee_version, task_definition_id,
        execution_contract_digest, permission_digest, schedule_policy_digest,
        execution_task_id
      )
      SELECT
        trigger_id, contract_version, tenant_scope,
        schedule_id, schedule_version, scheduled_for,
        actor_issuer, actor_subject_digest, authorization_digest,
        employee_id, employee_version, task_definition_id,
        execution_contract_digest, permission_digest, schedule_policy_digest,
        execution_task_id
      FROM schedule_triggers_v2;
      DROP TABLE schedule_triggers_v2;
      CREATE INDEX schedule_triggers_schedule_idx
        ON schedule_triggers (tenant_scope, employee_id, schedule_id, scheduled_for);
      UPDATE schedule_trigger_schema SET version = 3 WHERE singleton = 1;
      COMMIT;
    `);
    schema = { version: 3 };
  }
  if (schema?.version === 3) {
    if (database.prepare("PRAGMA table_info(schedule_triggers)").all().some(column => column.name === "run_configuration_digest")) {
      throw new TypeError("unsafe preexisting schedule trigger configuration column");
    }
    try {
      database.exec(`BEGIN IMMEDIATE;
        ALTER TABLE schedule_triggers ADD COLUMN run_configuration_digest TEXT;
        UPDATE schedule_trigger_schema SET version=4 WHERE singleton=1 AND version=3;
        COMMIT;`);
    } catch (error) { rollbackIfActive(database); throw error; }
    schema = { version: 4 };
  }
  if (schema?.version === 4) {
    if (database.prepare("PRAGMA table_info(schedule_triggers)").all().some(c => c.name === "manual_request_digest")) throw new TypeError("unsafe preexisting schedule trigger manual schema");
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_triggers'").get().sql;
    const columns = database.prepare("PRAGMA table_info(schedule_triggers)").all().map(c => c.name).join(",");
    const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='schedule_triggers' AND sql IS NOT NULL").all();
    const updated = sql.replace("UNIQUE (tenant_scope, employee_id, schedule_id, scheduled_for)", "manual_request_digest TEXT");
    if (updated === sql) throw new TypeError("unsupported schedule trigger migration shape");
    try {
      database.exec("BEGIN IMMEDIATE; ALTER TABLE schedule_triggers RENAME TO schedule_triggers_v4");
      database.exec(updated);
      database.exec(`INSERT INTO schedule_triggers (${columns}) SELECT ${columns} FROM schedule_triggers_v4`);
      database.exec("DROP TABLE schedule_triggers_v4");
      for (const index of indexes) database.exec(index.sql);
      database.exec(`CREATE UNIQUE INDEX schedule_triggers_slot_idx ON schedule_triggers (tenant_scope, employee_id, schedule_id, scheduled_for) WHERE manual_request_digest IS NULL;
        CREATE UNIQUE INDEX schedule_triggers_manual_idx ON schedule_triggers (tenant_scope, employee_id, schedule_id, manual_request_digest) WHERE manual_request_digest IS NOT NULL;
        UPDATE schedule_trigger_schema SET version=5 WHERE singleton=1 AND version=4; COMMIT;`);
    } catch (error) { rollbackIfActive(database); throw error; }
    schema = { version: 5 };
  }
  if (schema?.version !== 5) throw new TypeError("unsupported schedule trigger SQLite schema version");
  if (!database.prepare("PRAGMA table_info(schedule_triggers)").all().some(column => column.name === "run_configuration_digest")) {
    throw new TypeError("incomplete schedule trigger configuration schema");
  }
}

function rowToTrigger(row) {
  if (row.contract_version !== SCHEDULE_TRIGGER_CONTRACT_VERSION) {
    throw repositoryError("schedule_trigger_legacy_governance_unavailable");
  }
  return normalizeScheduleTrigger({
    contractVersion: row.contract_version,
    triggerId: row.trigger_id,
    tenantScope: row.tenant_scope,
    scheduleId: row.schedule_id,
    scheduleVersion: row.schedule_version,
    scheduledFor: row.scheduled_for,
    actorIssuer: row.actor_issuer,
    actorSubjectDigest: row.actor_subject_digest,
    authorizationDigest: row.authorization_digest,
    employeeId: row.employee_id,
    employeeVersion: row.employee_version,
    taskDefinitionId: row.task_definition_id,
    executionContractDigest: row.execution_contract_digest,
    permissionDigest: row.permission_digest,
    schedulePolicyDigest: row.schedule_policy_digest,
    executionTaskId: row.execution_task_id,
    ...(row.manual_request_digest != null ? { manualRequestDigest: row.manual_request_digest } : {}),
    ...(row.run_configuration_digest !== null ? { runConfigurationDigest: row.run_configuration_digest } : {}),
  });
}

function rollbackIfActive(database) {
  if (database.isTransaction) database.exec("ROLLBACK");
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) throw new TypeError("schedule trigger databasePath must be absolute or :memory:");
  return path.normalize(text);
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw repositoryError("schedule_trigger_reference_invalid", `${field} must be a bounded opaque identifier`);
  }
  return text;
}

function boundedInteger(value, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw repositoryError("schedule_trigger_limit_invalid");
  }
  return result;
}

function repositoryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  SCHEDULE_TRIGGER_REPOSITORY_CONTRACT_VERSION,
  createSqliteScheduleTriggerRepository,
};
