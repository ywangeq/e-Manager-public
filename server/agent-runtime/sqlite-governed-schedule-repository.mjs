import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeGovernedScheduleRegistration } from "./governed-schedule-registry.mjs";

const GOVERNED_SCHEDULE_REPOSITORY_CONTRACT_VERSION = "governed-schedule-repository.v1";

function createSqliteGovernedScheduleRepository({ databasePath } = {}) {
  const safePath = requiredDatabasePath(databasePath);
  if (safePath !== ":memory:") fs.mkdirSync(path.dirname(safePath), { recursive: true });
  const database = new DatabaseSync(safePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS governed_schedule_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO governed_schedule_schema (singleton, version) VALUES (1, 1)
      ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS governed_schedules (
      tenant_scope TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      registration_version INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_scope, employee_id, schedule_id)
    );
    CREATE INDEX IF NOT EXISTS governed_schedules_tenant_employee_idx
      ON governed_schedules (tenant_scope, employee_id, schedule_id);
  `);
  const schema = database.prepare("SELECT version FROM governed_schedule_schema WHERE singleton = 1").get();
  if (schema?.version !== 1) throw new TypeError("unsupported governed schedule SQLite schema version");

  function upsert(value, { expectedRegistrationVersion } = {}) {
    const record = normalizeGovernedScheduleRegistration(value);
    const expected = boundedInteger(expectedRegistrationVersion, 0, Number.MAX_SAFE_INTEGER);
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = readRow(record.tenantScope, record.employeeId, record.id);
      const currentVersion = Number(current?.registration_version || 0);
      if (currentVersion !== expected || record.registrationVersion !== expected + 1) {
        throw repositoryError("governed_schedule_version_conflict");
      }
      database.prepare(`
        INSERT INTO governed_schedules (
          tenant_scope, employee_id, schedule_id, registration_version, record_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_scope, employee_id, schedule_id) DO UPDATE SET
          registration_version = excluded.registration_version,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `).run(
        record.tenantScope,
        record.employeeId,
        record.id,
        record.registrationVersion,
        JSON.stringify(record),
        record.updatedAt,
      );
      database.exec("COMMIT");
      return Object.freeze({ created: !current, schedule: record });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  function get(scheduleId, { employeeId, tenantScope } = {}) {
    const row = readRow(requiredToken(tenantScope), requiredToken(employeeId), requiredToken(scheduleId));
    return row ? rowToSchedule(row) : null;
  }

  function list({ employeeId = "", tenantScope } = {}) {
    const safeTenant = requiredToken(tenantScope);
    const safeEmployee = employeeId ? requiredToken(employeeId) : "";
    return database.prepare(`
      SELECT record_json
      FROM governed_schedules
      WHERE tenant_scope = ? AND (? = '' OR employee_id = ?)
      ORDER BY employee_id ASC, schedule_id ASC
    `).all(safeTenant, safeEmployee, safeEmployee).map(rowToSchedule);
  }

  function readRow(tenantScope, employeeId, scheduleId) {
    return database.prepare(`
      SELECT registration_version, record_json
      FROM governed_schedules
      WHERE tenant_scope = ? AND employee_id = ? AND schedule_id = ?
    `).get(tenantScope, employeeId, scheduleId) || null;
  }

  return Object.freeze({
    adapterKind: "sqlite_durable_safe_schedule_registry",
    close: () => database.close(),
    contractVersion: GOVERNED_SCHEDULE_REPOSITORY_CONTRACT_VERSION,
    get,
    list,
    upsert,
  });
}

function rowToSchedule(row) {
  try {
    return normalizeGovernedScheduleRegistration(JSON.parse(row.record_json));
  } catch (error) {
    if (error?.code) throw error;
    throw repositoryError("governed_schedule_record_invalid");
  }
}

function requiredDatabasePath(value) {
  const result = String(value || "").trim();
  if (result === ":memory:") return result;
  if (!result || !path.isAbsolute(result)) throw new TypeError("governed schedule databasePath must be absolute or :memory:");
  return path.normalize(result);
}

function requiredToken(value) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(result)) throw repositoryError("governed_schedule_reference_invalid");
  return result;
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw repositoryError("governed_schedule_version_invalid");
  }
  return number;
}

function repositoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { GOVERNED_SCHEDULE_REPOSITORY_CONTRACT_VERSION, createSqliteGovernedScheduleRepository };
