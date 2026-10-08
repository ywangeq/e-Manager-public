import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteDatabase, initializeSqliteDatabase } from "../sqlite-lifecycle.mjs";
import {
  normalizeTaskMaterialBinding,
  normalizeTaskMaterialBindingSet,
} from "./task-material-binding.mjs";

const TASK_MATERIAL_BINDING_REPOSITORY_CONTRACT_VERSION = "task-material-binding-repository.v2";
const TASK_MATERIAL_BINDING_SCHEMA_VERSION = 2;

function createSqliteTaskMaterialBindingRepository({ databasePath, encryptionKey } = {}) {
  const safeDatabasePath = requiredDatabasePath(databasePath);
  const key = normalizedEncryptionKey(encryptionKey);
  if (safeDatabasePath !== ":memory:") fs.mkdirSync(path.dirname(safeDatabasePath), { recursive: true });
  const database = new DatabaseSync(safeDatabasePath);
  initializeSqliteDatabase(database, db => initializeDatabase(db, key));

  function saveOrGet(value) {
    const binding = normalizeTaskMaterialBinding(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRows = readRows(binding.taskId);
      if (existingRows.length) {
        if (existingRows.length !== 1) throw repositoryError("task_material_binding_set_unsupported");
        const existing = decryptRow(existingRows[0], key);
        if (!isDeepStrictEqual(existing, binding)) throw repositoryError("task_material_binding_idempotency_conflict");
        database.exec("COMMIT");
        return Object.freeze({ binding: deepFreeze(structuredClone(existing)), created: false });
      }
      saveBinding(binding);
      database.exec("COMMIT");
      return Object.freeze({ binding: deepFreeze(structuredClone(binding)), created: true });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function get(taskId, { tenantScope = "", now = new Date() } = {}) {
    const safeTaskId = requiredToken(taskId, "taskId", 128);
    const rows = readRows(safeTaskId);
    if (!rows.length) return null;
    if (rows.length !== 1) throw repositoryError("task_material_binding_set_unsupported");
    const row = rows[0];
    if (tenantScope && row.tenant_scope !== requiredToken(tenantScope, "tenantScope", 160)) return null;
    const binding = decryptRow(row, key);
    if (binding.expiresAt <= normalizedNow(now)) return null;
    return deepFreeze(structuredClone(binding));
  }

  function saveSetOrGet(value) {
    const bindingSet = normalizeTaskMaterialBindingSet(value);
    const first = bindingSet.bindings[0];
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRows = readRows(first.taskId);
      if (existingRows.length) {
        const existing = bindingSetFromRows(existingRows, key);
        if (!isDeepStrictEqual(existing, bindingSet)) throw repositoryError("task_material_binding_set_idempotency_conflict");
        database.exec("COMMIT");
        return Object.freeze({ bindingSet: deepFreeze(structuredClone(existing)), created: false });
      }
      bindingSet.bindings.forEach(saveBinding);
      database.exec("COMMIT");
      return Object.freeze({ bindingSet: deepFreeze(structuredClone(bindingSet)), created: true });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function getSet(taskId, { tenantScope = "", now = new Date() } = {}) {
    const safeTaskId = requiredToken(taskId, "taskId", 128);
    const rows = readRows(safeTaskId);
    if (!rows.length) return null;
    if (tenantScope && rows.some((row) => row.tenant_scope !== requiredToken(tenantScope, "tenantScope", 160))) return null;
    const bindingSet = bindingSetFromRows(rows, key);
    if (bindingSet.bindings.some((binding) => binding.expiresAt <= normalizedNow(now))) return null;
    return deepFreeze(structuredClone(bindingSet));
  }

  function listRecent({ actorIssuer, actorSubjectDigest, channelId, employeeId = null, employeeIds = null, limit = 20, sessionId, tenantScope, now = new Date() } = {}) {
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) throw repositoryError("task_material_binding_limit_invalid");
    if (employeeId !== null && employeeIds !== null) throw repositoryError("task_material_binding_employee_filter_conflict");
    const safeEmployeeIds = employeeIds === null
      ? [requiredToken(employeeId, "employeeId", 160)]
      : Array.from(new Set((Array.isArray(employeeIds) ? employeeIds : []).map((value) => requiredToken(value, "employeeId", 160))));
    if (!safeEmployeeIds.length) throw repositoryError("task_material_binding_employee_filter_empty");
    const employeePlaceholders = safeEmployeeIds.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT task_id, MAX(created_at) AS created_at FROM task_material_bindings
      WHERE tenant_scope = ? AND actor_issuer = ? AND actor_subject_digest = ?
        AND employee_id IN (${employeePlaceholders}) AND session_id = ? AND channel_id = ?
      GROUP BY task_id
      HAVING MIN(expires_at) > ?
      ORDER BY created_at DESC, task_id DESC
      LIMIT ?
    `).all(
      requiredToken(tenantScope, "tenantScope", 160),
      requiredToken(actorIssuer, "actorIssuer", 160),
      requiredDigest(actorSubjectDigest, "actorSubjectDigest"),
      ...safeEmployeeIds,
      requiredToken(sessionId, "sessionId", 160),
      requiredToken(channelId, "channelId", 120),
      normalizedNow(now),
      safeLimit,
    );
    return Object.freeze(rows
      .map((row) => getSet(row.task_id, { tenantScope, now }))
      .filter(Boolean)
      .map(withLegacyTaskId));
  }

  function purgeExpired({ now = new Date() } = {}) {
    return database.prepare("DELETE FROM task_material_bindings WHERE expires_at <= ?").run(normalizedNow(now)).changes;
  }

  // Group input references are durable opaque links into the existing Desktop
  // intake authority. Only bounded ids/digests and a digest of the live
  // session key are persisted; file paths, bytes and grants remain elsewhere.
  function saveGroupReferenceOrGet(value) {
    const reference = normalizeGroupReference(value);
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database.prepare(`SELECT * FROM group_material_references
        WHERE tenant_scope=? AND actor_issuer=? AND actor_subject_digest=? AND employee_id=? AND intake_id=? AND manifest_digest=?
      `).get(reference.tenantScope, reference.actorIssuer, reference.actorSubjectDigest, reference.employeeId, reference.intakeId, reference.manifestDigest);
      if (existing) {
        const decoded = decryptGroupReference(existing, key);
        database.exec("COMMIT");
        return Object.freeze({ reference: structuredClone(decoded), created: false });
      }
      database.prepare(`INSERT INTO group_material_references
        (ref_id,tenant_scope,actor_issuer,actor_subject_digest,employee_id,employee_version,intake_id,manifest_digest,session_key_digest,created_at,expires_at,reference_ciphertext)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(reference.refId, reference.tenantScope, reference.actorIssuer, reference.actorSubjectDigest,
        reference.employeeId, reference.employeeVersion, reference.intakeId, reference.manifestDigest,
        reference.sessionKeyDigest, reference.createdAt, reference.expiresAt,
        encryptJson(reference, key, groupReferenceAad(reference)));
      database.exec("COMMIT");
      return Object.freeze({ reference: structuredClone(reference), created: true });
    } catch (error) {
      rollbackIfActive(database);
      throw error;
    }
  }

  function getGroupReference(refId, { now = new Date() } = {}) {
    const safeRefId = requiredToken(refId, "refId", 180);
    const row = database.prepare("SELECT * FROM group_material_references WHERE ref_id=?").get(safeRefId);
    if (!row || row.expires_at <= normalizedNow(now)) return null;
    return Object.freeze(structuredClone(decryptGroupReference(row, key)));
  }

  function purgeGroupReferences({ now = new Date() } = {}) {
    return database.prepare("DELETE FROM group_material_references WHERE expires_at <= ?").run(normalizedNow(now)).changes;
  }

  function readRows(taskId) {
    return database.prepare("SELECT * FROM task_material_bindings WHERE task_id = ? ORDER BY descriptor_digest ASC").all(taskId);
  }

  function saveBinding(binding) {
    const sourceConflict = binding.sourceKind === "channel_resource"
      ? database.prepare(`
        SELECT task_id FROM task_material_bindings
        WHERE tenant_scope = ? AND adapter_id = ? AND source_identity_digest = ?
      `).get(binding.tenantScope, binding.adapterId, binding.sourceIdentityDigest)
      : null;
    if (sourceConflict) throw repositoryError("task_material_source_already_bound");
    database.prepare(`
      INSERT INTO task_material_bindings (
        task_id, descriptor_digest, tenant_scope, actor_issuer, actor_subject_digest, employee_id,
        session_id, channel_id, adapter_id, source_kind, source_identity_digest,
        created_at, expires_at, binding_digest, binding_ciphertext
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.taskId,
      binding.descriptorDigest,
      binding.tenantScope,
      binding.actorIssuer,
      binding.actorSubjectDigest,
      binding.employeeId,
      binding.sessionId,
      binding.channelId,
      binding.adapterId,
      binding.sourceKind,
      binding.sourceIdentityDigest,
      binding.createdAt,
      binding.expiresAt,
      binding.bindingDigest,
      encryptJson(binding, key, bindingAad(binding.taskId, binding.descriptorDigest, binding.bindingDigest)),
    );
  }

  return Object.freeze({
    adapterKind: "sqlite_encrypted_durable",
    close: () => closeSqliteDatabase(database),
    contractVersion: TASK_MATERIAL_BINDING_REPOSITORY_CONTRACT_VERSION,
    deploymentScope: "single_center",
    distributedCoordination: false,
    get,
    getSet,
    listRecent,
    getGroupReference,
    purgeGroupReferences,
    purgeExpired,
    saveGroupReferenceOrGet,
    saveOrGet,
    saveSetOrGet,
  });
}

function initializeDatabase(database, key) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS task_material_binding_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO task_material_binding_schema (singleton, version)
    VALUES (1, ${TASK_MATERIAL_BINDING_SCHEMA_VERSION})
    ON CONFLICT(singleton) DO NOTHING;
  `);
  const schema = database.prepare("SELECT version FROM task_material_binding_schema WHERE singleton = 1").get();
  if (schema?.version === 1) {
    migrateTaskMaterialBindingSchemaV1ToV2(database, key);
  }
  const currentSchema = database.prepare("SELECT version FROM task_material_binding_schema WHERE singleton = 1").get();
  if (currentSchema?.version === 2 && materialBindingSessionColumnRequiresMigration(database)) {
    migrateTaskMaterialBindingSchemaV2ToV3(database);
  } else if (currentSchema?.version !== TASK_MATERIAL_BINDING_SCHEMA_VERSION) {
    throw new TypeError("unsupported task material binding SQLite schema version");
  }
  createTaskMaterialBindingSchemaV2(database);
}

function migrateTaskMaterialBindingSchemaV2ToV3(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE task_material_bindings_v3_next (
        task_id TEXT NOT NULL,
        descriptor_digest TEXT NOT NULL,
        tenant_scope TEXT NOT NULL,
        actor_issuer TEXT NOT NULL,
        actor_subject_digest TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        session_id TEXT,
        channel_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_identity_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        binding_digest TEXT NOT NULL,
        binding_ciphertext TEXT NOT NULL,
        PRIMARY KEY (task_id, descriptor_digest)
      );
      INSERT INTO task_material_bindings_v3_next SELECT * FROM task_material_bindings;
      DROP INDEX IF EXISTS task_material_bindings_channel_source_idx;
      DROP INDEX IF EXISTS task_material_bindings_owner_idx;
      DROP INDEX IF EXISTS task_material_bindings_expiry_idx;
      DROP TABLE task_material_bindings;
      ALTER TABLE task_material_bindings_v3_next RENAME TO task_material_bindings;
      CREATE UNIQUE INDEX task_material_bindings_channel_source_idx
        ON task_material_bindings (tenant_scope, adapter_id, source_identity_digest)
        WHERE source_kind = 'channel_resource';
      CREATE INDEX task_material_bindings_owner_idx
        ON task_material_bindings (tenant_scope, actor_issuer, actor_subject_digest, employee_id, session_id, channel_id, created_at DESC);
      CREATE INDEX task_material_bindings_expiry_idx ON task_material_bindings (expires_at);
      UPDATE task_material_binding_schema SET version = 2 WHERE singleton = 1 AND version = 2;
    `);
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    throw error;
  }
}

function materialBindingSessionColumnRequiresMigration(database) {
  const column = database.prepare("PRAGMA table_info(task_material_bindings)").all().find((item) => item.name === "session_id");
  return Boolean(column && Number(column.notnull) === 1);
}

function createTaskMaterialBindingSchemaV2(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_material_bindings (
      task_id TEXT NOT NULL,
      descriptor_digest TEXT NOT NULL,
      tenant_scope TEXT NOT NULL,
      actor_issuer TEXT NOT NULL,
      actor_subject_digest TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      session_id TEXT,
      channel_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_identity_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      binding_ciphertext TEXT NOT NULL,
      PRIMARY KEY (task_id, descriptor_digest)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_material_bindings_channel_source_idx
      ON task_material_bindings (tenant_scope, adapter_id, source_identity_digest)
      WHERE source_kind = 'channel_resource';
    CREATE INDEX IF NOT EXISTS task_material_bindings_owner_idx
      ON task_material_bindings (tenant_scope, actor_issuer, actor_subject_digest, employee_id, session_id, channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS task_material_bindings_expiry_idx
      ON task_material_bindings (expires_at);
    CREATE TABLE IF NOT EXISTS group_material_references (
      ref_id TEXT PRIMARY KEY,
      tenant_scope TEXT NOT NULL,
      actor_issuer TEXT NOT NULL,
      actor_subject_digest TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      employee_version TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      session_key_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      reference_ciphertext TEXT NOT NULL,
      UNIQUE(tenant_scope, actor_issuer, actor_subject_digest, employee_id, intake_id, manifest_digest)
    );
    CREATE INDEX IF NOT EXISTS group_material_references_expiry_idx
      ON group_material_references (expires_at);
  `);
}

function migrateTaskMaterialBindingSchemaV1ToV2(database, key) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare("SELECT * FROM task_material_bindings ORDER BY task_id ASC").all();
    database.exec(`
      CREATE TABLE task_material_bindings_v2_next (
        task_id TEXT NOT NULL,
        descriptor_digest TEXT NOT NULL,
        tenant_scope TEXT NOT NULL,
        actor_issuer TEXT NOT NULL,
        actor_subject_digest TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        session_id TEXT,
        channel_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_identity_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        binding_digest TEXT NOT NULL,
        binding_ciphertext TEXT NOT NULL,
        PRIMARY KEY (task_id, descriptor_digest)
      );
    `);
    const insert = database.prepare(`
      INSERT INTO task_material_bindings_v2_next (
        task_id, descriptor_digest, tenant_scope, actor_issuer, actor_subject_digest, employee_id,
        session_id, channel_id, adapter_id, source_kind, source_identity_digest,
        created_at, expires_at, binding_digest, binding_ciphertext
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const binding = decryptLegacyV1Row(row, key);
      insert.run(
        binding.taskId,
        binding.descriptorDigest,
        binding.tenantScope,
        binding.actorIssuer,
        binding.actorSubjectDigest,
        binding.employeeId,
        binding.sessionId,
        binding.channelId,
        binding.adapterId,
        binding.sourceKind,
        binding.sourceIdentityDigest,
        binding.createdAt,
        binding.expiresAt,
        binding.bindingDigest,
        encryptJson(binding, key, bindingAad(binding.taskId, binding.descriptorDigest, binding.bindingDigest)),
      );
    }
    database.exec(`
      DROP INDEX IF EXISTS task_material_bindings_channel_source_idx;
      DROP INDEX IF EXISTS task_material_bindings_owner_idx;
      DROP INDEX IF EXISTS task_material_bindings_expiry_idx;
      DROP TABLE task_material_bindings;
      ALTER TABLE task_material_bindings_v2_next RENAME TO task_material_bindings;
      CREATE UNIQUE INDEX task_material_bindings_channel_source_idx
        ON task_material_bindings (tenant_scope, adapter_id, source_identity_digest)
        WHERE source_kind = 'channel_resource';
      CREATE INDEX task_material_bindings_owner_idx
        ON task_material_bindings (tenant_scope, actor_issuer, actor_subject_digest, employee_id, session_id, channel_id, created_at DESC);
      CREATE INDEX task_material_bindings_expiry_idx
        ON task_material_bindings (expires_at);
    `);
    const updated = database.prepare(`
      UPDATE task_material_binding_schema SET version = ${TASK_MATERIAL_BINDING_SCHEMA_VERSION}
      WHERE singleton = 1 AND version = 1
    `).run();
    if (updated.changes !== 1) throw new TypeError("task material binding SQLite schema migration lost its version transition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    throw error;
  }
}

function encryptJson(value, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
}

function decryptRow(row, key) {
  try {
    const envelope = JSON.parse(row.binding_ciphertext);
    if (envelope?.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.data) throw new TypeError("invalid binding envelope");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(bindingAad(row.task_id, row.descriptor_digest, row.binding_digest), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const binding = normalizeTaskMaterialBinding(JSON.parse(plaintext));
    if (binding.taskId !== row.task_id || binding.descriptorDigest !== row.descriptor_digest || binding.tenantScope !== row.tenant_scope ||
      binding.actorIssuer !== row.actor_issuer || binding.actorSubjectDigest !== row.actor_subject_digest ||
      binding.employeeId !== row.employee_id || binding.sessionId !== row.session_id ||
      binding.channelId !== row.channel_id || binding.adapterId !== row.adapter_id ||
      binding.sourceKind !== row.source_kind || binding.sourceIdentityDigest !== row.source_identity_digest ||
      binding.createdAt !== row.created_at || binding.expiresAt !== row.expires_at ||
      binding.bindingDigest !== row.binding_digest) {
      throw new TypeError("task material binding row mismatch");
    }
    return binding;
  } catch (error) {
    if (error?.code?.startsWith?.("task_material_binding_")) throw error;
    throw repositoryError("task_material_binding_decryption_failed");
  }
}

function decryptLegacyV1Row(row, key) {
  try {
    const envelope = JSON.parse(row.binding_ciphertext);
    if (envelope?.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.data) throw new TypeError("invalid binding envelope");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(legacyBindingAad(row.task_id, row.binding_digest), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const binding = normalizeTaskMaterialBinding(JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8")));
    if (binding.taskId !== row.task_id || binding.tenantScope !== row.tenant_scope ||
      binding.actorIssuer !== row.actor_issuer || binding.actorSubjectDigest !== row.actor_subject_digest ||
      binding.employeeId !== row.employee_id || binding.sessionId !== row.session_id ||
      binding.channelId !== row.channel_id || binding.adapterId !== row.adapter_id ||
      binding.sourceKind !== row.source_kind || binding.sourceIdentityDigest !== row.source_identity_digest ||
      binding.createdAt !== row.created_at || binding.expiresAt !== row.expires_at ||
      binding.bindingDigest !== row.binding_digest) {
      throw new TypeError("task material binding legacy row mismatch");
    }
    return binding;
  } catch (error) {
    throw repositoryError("task_material_binding_migration_decryption_failed");
  }
}

function bindingSetFromRows(rows, key) {
  const bindings = rows.map((row) => decryptRow(row, key)).sort((left, right) => left.descriptorDigest.localeCompare(right.descriptorDigest));
  return normalizeTaskMaterialBindingSet({
    bindingSetDigest: bindingSetDigest(bindings),
    bindings,
    contractVersion: "task-material-binding-set.v1",
  });
}

function bindingSetDigest(bindings) {
  return crypto.createHash("sha256").update(JSON.stringify({
    bindingDigests: bindings.map((binding) => binding.bindingDigest),
    contractVersion: "task-material-binding-set.v1",
  })).digest("hex");
}

function withLegacyTaskId(bindingSet) {
  const result = structuredClone(bindingSet);
  Object.defineProperty(result, "taskId", {
    enumerable: false,
    value: result.bindings[0].taskId,
  });
  return deepFreeze(result);
}

function bindingAad(taskId, descriptorDigest, bindingDigest) {
  return `task-material-binding-set.v1:${taskId}:${descriptorDigest}:${bindingDigest}`;
}

function normalizeGroupReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw repositoryError("group_material_reference_invalid");
  const reference = {
    contractVersion: "group-input-reference.v1",
    refId: requiredToken(value.refId, "refId", 180),
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    employeeId: requiredToken(value.employeeId, "employeeId", 160),
    employeeVersion: requiredToken(value.employeeVersion, "employeeVersion", 80),
    intakeId: requiredToken(value.intakeId, "intakeId", 180),
    manifestDigest: requiredDigest(value.manifestDigest, "manifestDigest"),
    sessionKeyDigest: requiredDigest(value.sessionKeyDigest, "sessionKeyDigest"),
    createdAt: normalizedNow(value.createdAt),
    expiresAt: normalizedNow(value.expiresAt),
  };
  if (new Date(reference.expiresAt) <= new Date(reference.createdAt)) throw repositoryError("group_material_reference_expired");
  return deepFreeze(reference);
}

function decryptGroupReference(row, key) {
  try {
    const envelope = JSON.parse(row.reference_ciphertext);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(groupReferenceAad(row), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const reference = normalizeGroupReference(JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")), decipher.final(),
    ]).toString("utf8")));
    if (reference.refId !== row.ref_id || reference.tenantScope !== row.tenant_scope ||
      reference.actorIssuer !== row.actor_issuer || reference.actorSubjectDigest !== row.actor_subject_digest ||
      reference.employeeId !== row.employee_id || reference.employeeVersion !== row.employee_version ||
      reference.intakeId !== row.intake_id || reference.manifestDigest !== row.manifest_digest ||
      reference.sessionKeyDigest !== row.session_key_digest || reference.createdAt !== row.created_at || reference.expiresAt !== row.expires_at) {
      throw new TypeError("group material reference row mismatch");
    }
    return reference;
  } catch { throw repositoryError("group_material_reference_decryption_failed"); }
}

function groupReferenceAad(value) {
  const row = value.refId ? value : {
    refId: value.ref_id, tenantScope: value.tenant_scope, actorIssuer: value.actor_issuer,
    actorSubjectDigest: value.actor_subject_digest, employeeId: value.employee_id,
    intakeId: value.intake_id, manifestDigest: value.manifest_digest,
  };
  return `group-input-reference.v1:${row.refId}:${row.tenantScope}:${row.actorIssuer}:${row.actorSubjectDigest}:${row.employeeId}:${row.intakeId}:${row.manifestDigest}`;
}

function legacyBindingAad(taskId, bindingDigest) {
  return `task-material-binding.v1:${taskId}:${bindingDigest}`;
}

function rollbackIfActive(database) {
  try { database.exec("ROLLBACK"); } catch {}
}

function normalizedEncryptionKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!key || key.length !== 32) throw new TypeError("task material binding encryptionKey must contain exactly 32 bytes");
  return key;
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) throw new TypeError("task material binding databasePath must be absolute or :memory:");
  return path.normalize(text);
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    throw repositoryError("task_material_binding_reference_invalid", `${field} must be a bounded opaque reference`);
  }
  return text;
}

function requiredDigest(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw repositoryError("task_material_binding_digest_invalid", `${field} must be a SHA-256 digest`);
  return text;
}

function normalizedNow(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("task material binding clock is invalid");
  return timestamp.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function repositoryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TASK_MATERIAL_BINDING_REPOSITORY_CONTRACT_VERSION,
  createSqliteTaskMaterialBindingRepository,
};
