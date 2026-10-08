import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  appendRuntimeToolEfficiencyCall,
  emptyRuntimeToolEfficiencySource,
  incrementRuntimeToolEfficiencyProviderRetry,
  normalizeRuntimeToolEfficiencySource,
  RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION,
} from "./runtime-tool-efficiency-contract-v1.mjs";

const RUNTIME_TOOL_EFFICIENCY_SCHEMA_V14_SQL = `
  CREATE TABLE execution_task_runtime_tool_efficiency (
    tenant_scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = '${RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION}'),
    source_json TEXT NOT NULL,
    source_hmac TEXT NOT NULL CHECK (
      length(source_hmac) = 64 AND source_hmac NOT GLOB '*[^a-f0-9]*'
    ),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_scope, task_id),
    FOREIGN KEY (tenant_scope, task_id) REFERENCES execution_tasks (tenant_scope, task_id) ON DELETE CASCADE
  );
`;

function createRuntimeToolEfficiencySchemaV14(database) {
  database.exec(RUNTIME_TOOL_EFFICIENCY_SCHEMA_V14_SQL);
}

function writeRuntimeToolEfficiencyMutation(database, {
  fingerprintKey,
  mutation,
  nowIso,
  task,
} = {}) {
  const taskId = task?.taskId || task?.task_id;
  const key = requiredFingerprintKey(fingerprintKey);
  const current = readRuntimeToolEfficiencyState(database, task, { fingerprintKey: key });
  const repeatThreshold = boundedThreshold(mutation?.repeatThreshold);
  let source = current?.sourceSnapshot || emptyRuntimeToolEfficiencySource({ taskId, repeatThreshold });
  if (source.repeatThreshold !== repeatThreshold) throw storeError("runtime_tool_efficiency_threshold_conflict");
  let analysis = null;
  if (mutation?.type === "provider_retry") {
    source = incrementRuntimeToolEfficiencyProviderRetry(source);
  } else if (mutation?.type === "tool_call_terminal") {
    const canonicalActivity = task?.activitySnapshot?.activities?.find(
      (item) => item.activityId === mutation.activity?.activityId,
    );
    if (!canonicalActivity || !isDeepStrictEqual(canonicalActivity, mutation.activity)) {
      throw storeError("runtime_tool_efficiency_activity_identity_conflict");
    }
    const applied = appendRuntimeToolEfficiencyCall(source, {
      activity: mutation.activity,
      executorRetryCount: mutation.executorRetryCount,
      fingerprintKey: key,
      result: mutation.result,
      toolCall: mutation.toolCall,
    });
    source = applied.source;
    analysis = applied.analysis;
  } else {
    throw storeError("runtime_tool_efficiency_mutation_invalid");
  }
  if (current && isDeepStrictEqual(current.sourceSnapshot, source)) {
    return Object.freeze({ ...current, analysis });
  }
  const payload = JSON.stringify(source);
  database.prepare(`
    INSERT INTO execution_task_runtime_tool_efficiency (
      tenant_scope, task_id, contract_version, source_json, source_hmac, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_scope, task_id) DO UPDATE SET
      source_json = excluded.source_json,
      source_hmac = excluded.source_hmac,
      updated_at = excluded.updated_at
  `).run(
    task.tenantScope || task.tenant_scope,
    taskId,
    RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION,
    payload,
    sourceHmac(payload, key),
    normalizedTimestamp(nowIso),
  );
  const stored = readRuntimeToolEfficiencyState(database, task, { fingerprintKey: key });
  return Object.freeze({ ...stored, analysis });
}

function readRuntimeToolEfficiencyState(database, task, { fingerprintKey = null } = {}) {
  const tenantScope = task.tenantScope || task.tenant_scope;
  const taskId = task.taskId || task.task_id;
  const row = database.prepare(`
    SELECT * FROM execution_task_runtime_tool_efficiency
    WHERE tenant_scope = ? AND task_id = ?
  `).get(tenantScope, taskId);
  return row ? rowToState(row, task, requiredFingerprintKey(fingerprintKey)) : null;
}

function readRuntimeToolEfficiencyForTasks(database, tasks, { fingerprintKey = null } = {}) {
  if (!tasks.length) return new Map();
  const tenantScope = tasks[0].tenantScope || tasks[0].tenant_scope;
  if (tasks.some((task) => (task.tenantScope || task.tenant_scope) !== tenantScope)) {
    throw storeError("runtime_tool_efficiency_tenant_mismatch");
  }
  const placeholders = tasks.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT * FROM execution_task_runtime_tool_efficiency
    WHERE tenant_scope = ? AND task_id IN (${placeholders})
  `).all(tenantScope, ...tasks.map((task) => task.taskId || task.task_id));
  if (!rows.length) return new Map();
  const key = requiredFingerprintKey(fingerprintKey);
  const taskById = new Map(tasks.map((task) => [task.taskId || task.task_id, task]));
  return new Map(rows.map((row) => [row.task_id, rowToState(row, taskById.get(row.task_id), key)]));
}

function validateRuntimeToolEfficiencySchemaV14(database, { fingerprintKey = null } = {}) {
  const objects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'execution_task_runtime_tool_efficiency'
    ORDER BY type, name
  `).all();
  const names = objects.map((item) => item.name).sort();
  const foreignKeys = database.prepare(
    "PRAGMA foreign_key_list(execution_task_runtime_tool_efficiency)",
  ).all();
  const rows = database.prepare(`
    SELECT efficiency.*, task.task_id AS canonical_task_id
    FROM execution_task_runtime_tool_efficiency efficiency
    INNER JOIN execution_tasks task
      ON task.tenant_scope = efficiency.tenant_scope AND task.task_id = efficiency.task_id
    ORDER BY efficiency.tenant_scope, efficiency.task_id
  `).all();
  let rowsValid = true;
  try {
    if (rows.length) {
      const key = requiredFingerprintKey(fingerprintKey);
      for (const row of rows) rowToState(row, {
        tenant_scope: row.tenant_scope,
        task_id: row.canonical_task_id,
      }, key);
    }
  } catch {
    rowsValid = false;
  }
  const valid = isDeepStrictEqual(names, [
    "execution_task_runtime_tool_efficiency",
    "sqlite_autoindex_execution_task_runtime_tool_efficiency_1",
  ].sort()) &&
    objects.filter((item) => item.type === "table").length === 1 &&
    objects.filter((item) => item.type === "trigger" || item.type === "view").length === 0 &&
    objects.every((item) => item.name.startsWith("sqlite_autoindex_") ||
      normalizeSchemaSql(item.sql) === normalizeSchemaSql(RUNTIME_TOOL_EFFICIENCY_SCHEMA_V14_SQL)) &&
    foreignKeys.length === 2 && foreignKeys.every((item) =>
      item.table === "execution_tasks" && item.on_delete === "CASCADE") &&
    rowsValid;
  if (!valid) throw storeError("execution_task_schema_v14_efficiency_invalid");
}

function rowToState(row, task, fingerprintKey) {
  if (!task) throw storeError("runtime_tool_efficiency_task_missing");
  if (row.contract_version !== RUNTIME_TOOL_EFFICIENCY_SOURCE_CONTRACT_VERSION) {
    throw storeError("runtime_tool_efficiency_row_contract_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(row.source_json);
  } catch {
    throw storeError("runtime_tool_efficiency_row_json_invalid");
  }
  const sourceSnapshot = normalizeRuntimeToolEfficiencySource(parsed, {
    expectedTaskId: task.taskId || task.task_id,
  });
  const canonicalPayload = JSON.stringify(sourceSnapshot);
  if (canonicalPayload !== row.source_json ||
    !safeEqualHex(sourceHmac(canonicalPayload, fingerprintKey), row.source_hmac)) {
    throw storeError("runtime_tool_efficiency_row_integrity_invalid");
  }
  return Object.freeze({
    sourceSnapshot,
    updatedAt: normalizedTimestamp(row.updated_at),
  });
}

function sourceHmac(payload, key) {
  return crypto.createHmac("sha256", key)
    .update("runtime-tool-efficiency-source-integrity.v1\0", "utf8")
    .update(payload, "utf8")
    .digest("hex");
}

function safeEqualHex(expected, actual) {
  if (!/^[a-f0-9]{64}$/.test(String(actual || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function requiredFingerprintKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError("efficiencyFingerprintKey must contain exactly 32 bytes");
  }
  return value;
}

function boundedThreshold(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 2 || number > 20) {
    throw storeError("runtime_tool_efficiency_threshold_invalid");
  }
  return number;
}

function normalizedTimestamp(value) {
  const text = String(value || "");
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    throw storeError("runtime_tool_efficiency_timestamp_invalid");
  }
  return text;
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
  RUNTIME_TOOL_EFFICIENCY_SCHEMA_V14_SQL,
  createRuntimeToolEfficiencySchemaV14,
  readRuntimeToolEfficiencyForTasks,
  readRuntimeToolEfficiencyState,
  validateRuntimeToolEfficiencySchemaV14,
  writeRuntimeToolEfficiencyMutation,
};
