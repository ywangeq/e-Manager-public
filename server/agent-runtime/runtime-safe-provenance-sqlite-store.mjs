import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeRuntimeSafeProvenanceSource,
  RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
} from "./runtime-safe-provenance-contract-v1.mjs";

const RUNTIME_SAFE_PROVENANCE_SCHEMA_V13_SQL = `
  CREATE TABLE execution_task_runtime_provenance (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = '${RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION}'),
    source_json TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK (
      length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'
    ),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, task_id),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE
  );
`;

function createRuntimeSafeProvenanceSchemaV13(database) {
  database.exec(RUNTIME_SAFE_PROVENANCE_SCHEMA_V13_SQL);
}

function writeRuntimeSafeProvenanceSource(database, { nowIso, sourceSnapshot, task }) {
  const source = normalizedSourceForTask(sourceSnapshot, task);
  const payload = JSON.stringify(source);
  const digest = sourceDigest(payload);
  const existing = readRuntimeSafeProvenanceState(database, task);
  if (existing) {
    if (!isDeepStrictEqual(existing.sourceSnapshot, source)) {
      throw storeError("runtime_safe_provenance_idempotency_conflict");
    }
    return existing;
  }
  database.prepare(`
    INSERT INTO execution_task_runtime_provenance (
      tenant_scope, task_id, contract_version, source_json, source_digest, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    task.tenantScope || task.tenant_scope,
    task.taskId || task.task_id,
    RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION,
    payload,
    digest,
    nowIso,
  );
  return readRuntimeSafeProvenanceState(database, task);
}

function readRuntimeSafeProvenanceState(database, task) {
  const tenantScope = task.tenantScope || task.tenant_scope;
  const taskId = task.taskId || task.task_id;
  const row = database.prepare(`
    SELECT * FROM execution_task_runtime_provenance
    WHERE tenant_scope = ? AND task_id = ?
  `).get(tenantScope, taskId);
  return row ? rowToState(row, task) : null;
}

function readRuntimeSafeProvenanceForTasks(database, tasks) {
  if (!tasks.length) return new Map();
  const tenantScope = tasks[0].tenantScope || tasks[0].tenant_scope;
  if (tasks.some((task) => (task.tenantScope || task.tenant_scope) !== tenantScope)) {
    throw storeError("runtime_safe_provenance_tenant_mismatch");
  }
  const placeholders = tasks.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT * FROM execution_task_runtime_provenance
    WHERE tenant_scope = ? AND task_id IN (${placeholders})
  `).all(tenantScope, ...tasks.map((task) => task.taskId || task.task_id));
  const taskById = new Map(tasks.map((task) => [task.taskId || task.task_id, task]));
  return new Map(rows.map((row) => [row.task_id, rowToState(row, taskById.get(row.task_id))]));
}

function validateRuntimeSafeProvenanceSchemaV13(database) {
  const objects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'execution_task_runtime_provenance'
    ORDER BY type, name
  `).all();
  const names = objects.map((item) => item.name).sort();
  const foreignKeys = database.prepare(
    "PRAGMA foreign_key_list(execution_task_runtime_provenance)",
  ).all();
  const rows = database.prepare(`
    SELECT provenance.*, task.employee_id, task.employee_version
    FROM execution_task_runtime_provenance provenance
    INNER JOIN execution_tasks task
      ON task.tenant_scope = provenance.tenant_scope AND task.task_id = provenance.task_id
    ORDER BY provenance.tenant_scope, provenance.task_id
  `).all();
  let rowsValid = true;
  try {
    for (const row of rows) rowToState(row, {
      tenant_scope: row.tenant_scope,
      task_id: row.task_id,
      employee_id: row.employee_id,
      employee_version: row.employee_version,
    });
  } catch {
    rowsValid = false;
  }
  const valid = isDeepStrictEqual(names, [
    "execution_task_runtime_provenance",
    "sqlite_autoindex_execution_task_runtime_provenance_1",
  ].sort()) &&
    objects.filter((item) => item.type === "table").length === 1 &&
    objects.filter((item) => item.type === "trigger" || item.type === "view").length === 0 &&
    objects.every((item) => item.name.startsWith("sqlite_autoindex_") ||
      normalizeSchemaSql(item.sql) === normalizeSchemaSql(RUNTIME_SAFE_PROVENANCE_SCHEMA_V13_SQL)) &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    rowsValid;
  if (!valid) throw storeError("execution_task_schema_v13_provenance_invalid");
}

function rowToState(row, task) {
  if (!task) throw storeError("runtime_safe_provenance_task_missing");
  if (row.contract_version !== RUNTIME_SAFE_PROVENANCE_SOURCE_CONTRACT_VERSION) {
    throw storeError("runtime_safe_provenance_row_contract_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(row.source_json);
  } catch {
    throw storeError("runtime_safe_provenance_row_json_invalid");
  }
  const sourceSnapshot = normalizedSourceForTask(parsed, task);
  const canonicalPayload = JSON.stringify(sourceSnapshot);
  if (canonicalPayload !== row.source_json || sourceDigest(canonicalPayload) !== row.source_digest) {
    throw storeError("runtime_safe_provenance_row_integrity_invalid");
  }
  return Object.freeze({
    sourceSnapshot,
    recordedAt: normalizedTimestamp(row.recorded_at),
  });
}

function normalizedSourceForTask(sourceSnapshot, task) {
  return normalizeRuntimeSafeProvenanceSource(sourceSnapshot, {
    expectedTaskId: task.taskId || task.task_id,
    expectedEmployeeId: task.employeeId || task.employee_id,
    expectedEmployeeVersion: task.employeeVersion || task.employee_version,
  });
}

function normalizedTimestamp(value) {
  const text = String(value || "");
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    throw storeError("runtime_safe_provenance_timestamp_invalid");
  }
  return text;
}

function sourceDigest(payload) {
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function normalizeSchemaSql(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
}

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RUNTIME_SAFE_PROVENANCE_SCHEMA_V13_SQL,
  createRuntimeSafeProvenanceSchemaV13,
  readRuntimeSafeProvenanceForTasks,
  readRuntimeSafeProvenanceState,
  validateRuntimeSafeProvenanceSchemaV13,
  writeRuntimeSafeProvenanceSource,
};
