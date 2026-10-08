import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { normalizeServerTriggerBinding } from "./trigger-binding-registry.mjs";
import { normalizeTriggerTaskDefinition } from "./trigger-task-definition-registry.mjs";
import { normalizeTriggerMaterialBinding } from "./trigger-material-binding-registry.mjs";
import { normalizeTriggerWritebackBinding } from "./trigger-writeback-binding-registry.mjs";

const CONTRACT_VERSION = "trigger-config-repository.v1";
const SCHEMA_VERSION = 1;

function createSqliteTriggerConfigRepository({ databasePath, readOnly = false } = {}) {
  const safePath = requiredDatabasePath(databasePath);
  if (!readOnly && safePath !== ":memory:") fs.mkdirSync(path.dirname(safePath), { recursive: true });
  const database = new DatabaseSync(safePath, { readOnly });
  if (!readOnly) initialize(database);

  function seedIfEmpty({ systems = [], credentials = [], bindings = [], taskDefinitions = [], materialBindings = [], writebackBindings = [] } = {}) {
    const seed = { systems, credentials, bindings, taskDefinitions, materialBindings, writebackBindings };
    database.exec("BEGIN IMMEDIATE");
    try {
      const migration = database.prepare("SELECT migration_id FROM trigger_config_migrations WHERE migration_id = ?")
        .get("static-trigger-catalog-to-sqlite-v1");
      if (migration) {
        const current = configurationContainsValidSeed(database, seed);
        database.exec("COMMIT");
        return Object.freeze({ seeded: false, current });
      }
      const existing = configurationRowCount(database);
      if (existing > 0) {
        recordStaticMigration(database);
        const current = configurationContainsValidSeed(database, seed);
        database.exec("COMMIT");
        return Object.freeze({ seeded: false, current });
      }
      const normalized = normalizeSeed(seed);
      for (const item of normalized.systems) insertSystem(item);
      for (const item of normalized.credentials) insertCredential(item);
      for (const item of normalized.taskDefinitions) insertTaskDefinition(item);
      for (const item of normalized.bindings) insertBinding(item, credentialRefForBinding(item, normalized.credentials));
      for (const item of normalized.materialBindings) insertMaterialBinding(item);
      for (const item of normalized.writebackBindings) insertWritebackBinding(item);
      recordStaticMigration(database);
      database.exec("COMMIT");
      return Object.freeze({ seeded: true, current: true });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  function loadPublishedConfiguration() {
    const systems = database.prepare("SELECT * FROM trigger_systems ORDER BY display_name").all().map(rowToSystem);
    const credentials = database.prepare("SELECT * FROM trigger_credentials ORDER BY display_name").all().map(rowToCredential);
    const bindings = database.prepare(`
      SELECT b.*, c.secret_locator
      FROM trigger_bindings b
      JOIN trigger_credentials c ON c.credential_ref = b.credential_ref
      ORDER BY b.binding_id
    `).all().map(rowToBinding);
    const taskDefinitions = database.prepare("SELECT * FROM trigger_task_definitions ORDER BY task_definition_id").all().map(rowToTaskDefinition);
    const materialBindings = database.prepare("SELECT * FROM trigger_material_bindings ORDER BY material_binding_id").all().map(rowToMaterialBinding);
    const writebackBindings = database.prepare("SELECT * FROM trigger_writeback_bindings ORDER BY writeback_binding_id").all().map(rowToWritebackBinding);
    return Object.freeze({ systems, credentials, bindings, taskDefinitions, materialBindings, writebackBindings });
  }

  function applyTaskDefinitionMigration({ migrationId, expectedDefinitions = [], replacement } = {}) {
    const safeMigrationId = token(migrationId);
    const normalizedReplacement = normalizeTriggerTaskDefinition(replacement);
    const normalizedExpectedDefinitions = expectedDefinitions.map(normalizeTriggerTaskDefinition);
    if (!normalizedExpectedDefinitions.length || normalizedExpectedDefinitions.some((definition) => (
      definition.taskDefinitionId !== normalizedReplacement.taskDefinitionId
    ))) {
      throw migrationError("trigger_task_definition_migration_invalid");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const applied = database.prepare("SELECT migration_id FROM trigger_config_migrations WHERE migration_id = ?")
        .get(safeMigrationId);
      if (applied) {
        database.exec("COMMIT");
        return Object.freeze({ migrationId: safeMigrationId, migrated: false, alreadyApplied: true });
      }
      const row = database.prepare("SELECT * FROM trigger_task_definitions WHERE task_definition_id = ?")
        .get(normalizedReplacement.taskDefinitionId);
      if (!row) throw migrationError("trigger_task_definition_migration_target_missing");
      const current = rowToTaskDefinition(row);
      if (sameTaskDefinition(current, normalizedReplacement)) {
        recordMigration(database, safeMigrationId);
        database.exec("COMMIT");
        return Object.freeze({ migrationId: safeMigrationId, migrated: false, alreadyCurrent: true });
      }
      if (!normalizedExpectedDefinitions.some((expected) => sameTaskDefinition(current, expected))) {
        throw migrationError("trigger_task_definition_migration_source_mismatch");
      }
      database.prepare(`UPDATE trigger_task_definitions SET
        contract_version = ?, task_definition_version = ?, handler_version = ?, skill_policy_ref = ?,
        tool_policy_ref = ?, output_policy_ref = ?, writeback_policy_ref = ?, enabled = ?, review_status = ?
        WHERE task_definition_id = ?`
      ).run(
        normalizedReplacement.contractVersion,
        normalizedReplacement.taskDefinitionVersion,
        normalizedReplacement.handlerVersion,
        normalizedReplacement.skillPolicyRef,
        normalizedReplacement.toolPolicyRef,
        normalizedReplacement.outputPolicyRef,
        normalizedReplacement.writebackPolicyRef,
        normalizedReplacement.enabled ? 1 : 0,
        normalizedReplacement.reviewStatus,
        normalizedReplacement.taskDefinitionId,
      );
      recordMigration(database, safeMigrationId);
      database.exec("COMMIT");
      return Object.freeze({ migrationId: safeMigrationId, migrated: true });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  function applyBindingMigration({ migrationId, expectedBindings = [], replacement } = {}) {
    const safeMigrationId = token(migrationId);
    const normalizedReplacement = normalizeServerTriggerBinding(replacement);
    const normalizedExpectedBindings = expectedBindings.map(normalizeServerTriggerBinding);
    if (!normalizedExpectedBindings.length || normalizedExpectedBindings.some((binding) => (
      binding.bindingId !== normalizedReplacement.bindingId
    ))) {
      throw migrationError("trigger_binding_migration_invalid");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const applied = database.prepare("SELECT migration_id FROM trigger_config_migrations WHERE migration_id = ?")
        .get(safeMigrationId);
      if (applied) {
        database.exec("COMMIT");
        return Object.freeze({ migrationId: safeMigrationId, migrated: false, alreadyApplied: true });
      }
      const row = database.prepare(`
        SELECT b.*, c.secret_locator
        FROM trigger_bindings b
        JOIN trigger_credentials c ON c.credential_ref = b.credential_ref
        WHERE b.binding_id = ?
      `).get(normalizedReplacement.bindingId);
      if (!row) throw migrationError("trigger_binding_migration_target_missing");
      const current = rowToBinding(row);
      if (sameBinding(current, normalizedReplacement)) {
        recordMigration(database, safeMigrationId);
        database.exec("COMMIT");
        return Object.freeze({ migrationId: safeMigrationId, migrated: false, alreadyCurrent: true });
      }
      if (!normalizedExpectedBindings.some((expected) => sameBinding(current, expected))) {
        throw migrationError("trigger_binding_migration_source_mismatch");
      }
      const credentialRef = credentialRefForBindingCurrent(database, normalizedReplacement, []);
      database.prepare(`UPDATE trigger_bindings SET
        contract_version = ?, binding_version = ?, source_adapter_id = ?, source_system_id = ?,
        event_type = ?, target_employee_id = ?, task_definition_id = ?, credential_ref = ?,
        enabled = ?, review_status = ?
        WHERE binding_id = ?`
      ).run(
        normalizedReplacement.contractVersion,
        normalizedReplacement.bindingVersion,
        normalizedReplacement.sourceAdapterId,
        normalizedReplacement.sourceSystemId,
        normalizedReplacement.eventType,
        normalizedReplacement.targetEmployeeId,
        normalizedReplacement.taskDefinitionId,
        credentialRef,
        normalizedReplacement.enabled ? 1 : 0,
        normalizedReplacement.reviewStatus,
        normalizedReplacement.bindingId,
      );
      recordMigration(database, safeMigrationId);
      database.exec("COMMIT");
      return Object.freeze({ migrationId: safeMigrationId, migrated: true });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  function applyConfigurationRegistration({
    migrationId,
    systems = [],
    credentials = [],
    bindings = [],
    taskDefinitions = [],
    materialBindings = [],
    writebackBindings = [],
  } = {}) {
    const safeMigrationId = token(migrationId);
    const normalized = normalizeRegistration({
      systems,
      credentials,
      bindings,
      taskDefinitions,
      materialBindings,
      writebackBindings,
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      const applied = database.prepare("SELECT migration_id FROM trigger_config_migrations WHERE migration_id = ?")
        .get(safeMigrationId);
      if (applied) {
        database.exec("COMMIT");
        return Object.freeze({ migrationId: safeMigrationId, registered: false, alreadyApplied: true });
      }
      assertRegistrationReferences(database, normalized);
      let inserted = 0;
      for (const item of normalized.systems) inserted += insertOrVerifySystem(database, item);
      for (const item of normalized.credentials) inserted += insertOrVerifyCredential(database, item);
      for (const item of normalized.taskDefinitions) inserted += insertOrVerifyTaskDefinition(database, item);
      for (const item of normalized.bindings) inserted += insertOrVerifyBinding(database, item, normalized.credentials);
      for (const item of normalized.materialBindings) inserted += insertOrVerifyMaterialBinding(database, item);
      for (const item of normalized.writebackBindings) inserted += insertOrVerifyWritebackBinding(database, item);
      recordMigration(database, safeMigrationId);
      database.exec("COMMIT");
      return Object.freeze({ migrationId: safeMigrationId, registered: inserted > 0, inserted });
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  function safeManagementSnapshot({ credentialStatus = () => false } = {}) {
    const config = loadPublishedConfiguration();
    return Object.freeze({
      contractVersion: "trigger-management-snapshot.v1",
      systems: config.systems,
      credentials: config.credentials.map((item) => Object.freeze({
        credentialRef: item.credentialRef,
        sourceSystemId: item.sourceSystemId,
        credentialType: item.credentialType,
        displayName: item.displayName,
        secretAuthority: item.secretAuthority,
        configured: Boolean(credentialStatus(item)),
        status: item.status,
      })),
      bindings: config.bindings.map((item) => {
        const { secretEnvName: _secretEnvName, ...safeItem } = item;
        return Object.freeze({
          ...safeItem,
          credentialRef: credentialRefForBindingRow(item.bindingId, database),
        });
      }),
      taskDefinitions: config.taskDefinitions,
      materialBindings: config.materialBindings,
      writebackBindings: config.writebackBindings,
      migration: database.prepare("SELECT migration_id, applied_at FROM trigger_config_migrations ORDER BY applied_at DESC LIMIT 1").get() || null,
    });
  }

  if (readOnly) return Object.freeze({ loadPublishedConfiguration, close: () => database.close() });
  return Object.freeze({
    applyBindingMigration,
    applyConfigurationRegistration,
    close: () => database.close(),
    applyTaskDefinitionMigration,
    contractVersion: CONTRACT_VERSION,
    loadPublishedConfiguration,
    safeManagementSnapshot,
    schemaVersion: SCHEMA_VERSION,
    seedIfEmpty,
  });

  function insertSystem(item) {
    database.prepare(`INSERT INTO trigger_systems
      (source_system_id, contract_version, system_type, display_name, adapter_family, homepage_url, owner_label, status, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.sourceSystemId, item.contractVersion, item.systemType, item.displayName, item.adapterFamily,
      item.homepageUrl, item.ownerLabel, item.status, item.reviewStatus);
  }

  function insertCredential(item) {
    database.prepare(`INSERT INTO trigger_credentials
      (credential_ref, contract_version, source_system_id, credential_type, display_name, secret_authority, secret_locator, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.credentialRef, item.contractVersion, item.sourceSystemId, item.credentialType, item.displayName, item.secretAuthority, item.secretLocator, item.status);
  }

  function insertBinding(item, credentialRef) {
    database.prepare(`INSERT INTO trigger_bindings
      (binding_id, contract_version, binding_version, source_adapter_id, source_system_id, event_type,
       target_employee_id, task_definition_id, credential_ref, enabled, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.bindingId, item.contractVersion, item.bindingVersion, item.sourceAdapterId, item.sourceSystemId, item.eventType,
      item.targetEmployeeId, item.taskDefinitionId, credentialRef, item.enabled ? 1 : 0, item.reviewStatus);
  }

  function insertTaskDefinition(item) {
    database.prepare(`INSERT INTO trigger_task_definitions
      (task_definition_id, contract_version, task_definition_version, handler_version, skill_policy_ref,
       tool_policy_ref, output_policy_ref, writeback_policy_ref, enabled, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.taskDefinitionId, item.contractVersion, item.taskDefinitionVersion, item.handlerVersion, item.skillPolicyRef,
      item.toolPolicyRef, item.outputPolicyRef, item.writebackPolicyRef, item.enabled ? 1 : 0, item.reviewStatus);
  }

  function insertMaterialBinding(item) {
    database.prepare(`INSERT INTO trigger_material_bindings
      (material_binding_id, payload_json) VALUES (?, ?)`
    ).run(item.materialBindingId, JSON.stringify(item));
  }

  function insertWritebackBinding(item) {
    database.prepare(`INSERT INTO trigger_writeback_bindings
      (writeback_binding_id, payload_json) VALUES (?, ?)`
    ).run(item.writebackBindingId, JSON.stringify(item));
  }
}

function initialize(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS trigger_config_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version = 1)
    );
    INSERT INTO trigger_config_schema (singleton, version) VALUES (1, 1) ON CONFLICT(singleton) DO NOTHING;
    CREATE TABLE IF NOT EXISTS trigger_systems (
      source_system_id TEXT PRIMARY KEY, contract_version TEXT NOT NULL, system_type TEXT NOT NULL,
      display_name TEXT NOT NULL, adapter_family TEXT NOT NULL, homepage_url TEXT NOT NULL DEFAULT '', owner_label TEXT NOT NULL,
      status TEXT NOT NULL, review_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trigger_credentials (
      credential_ref TEXT PRIMARY KEY, contract_version TEXT NOT NULL, source_system_id TEXT NOT NULL,
      credential_type TEXT NOT NULL, display_name TEXT NOT NULL, secret_authority TEXT NOT NULL,
      secret_locator TEXT NOT NULL, status TEXT NOT NULL,
      FOREIGN KEY (source_system_id) REFERENCES trigger_systems(source_system_id)
    );
    CREATE TABLE IF NOT EXISTS trigger_bindings (
      binding_id TEXT PRIMARY KEY, contract_version TEXT NOT NULL, binding_version TEXT NOT NULL,
      source_adapter_id TEXT NOT NULL, source_system_id TEXT NOT NULL, event_type TEXT NOT NULL,
      target_employee_id TEXT NOT NULL, task_definition_id TEXT NOT NULL, credential_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), review_status TEXT NOT NULL,
      FOREIGN KEY (source_system_id) REFERENCES trigger_systems(source_system_id),
      FOREIGN KEY (credential_ref) REFERENCES trigger_credentials(credential_ref),
      FOREIGN KEY (task_definition_id) REFERENCES trigger_task_definitions(task_definition_id)
    );
    CREATE TABLE IF NOT EXISTS trigger_task_definitions (
      task_definition_id TEXT PRIMARY KEY, contract_version TEXT NOT NULL, task_definition_version TEXT NOT NULL,
      handler_version TEXT NOT NULL, skill_policy_ref TEXT NOT NULL, tool_policy_ref TEXT NOT NULL,
      output_policy_ref TEXT NOT NULL, writeback_policy_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), review_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trigger_material_bindings (
      material_binding_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trigger_writeback_bindings (
      writeback_binding_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trigger_config_migrations (
      migration_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    );
  `);
  ensureColumn(database, "trigger_systems", "homepage_url", "TEXT NOT NULL DEFAULT ''");
  const schema = database.prepare("SELECT version FROM trigger_config_schema WHERE singleton = 1").get();
  if (schema?.version !== SCHEMA_VERSION) throw new TypeError("unsupported Trigger configuration SQLite schema");
}

function normalizeSeed(value) {
  const systems = value.systems.map(normalizeSystem);
  const credentials = value.credentials.map(normalizeCredential);
  const bindings = value.bindings.map(normalizeServerTriggerBinding);
  const taskDefinitions = value.taskDefinitions.map(normalizeTriggerTaskDefinition);
  const materialBindings = value.materialBindings.map(normalizeTriggerMaterialBinding);
  const writebackBindings = value.writebackBindings.map(normalizeTriggerWritebackBinding);
  const systemIds = new Set(systems.map((item) => item.sourceSystemId));
  const taskDefinitionIds = new Set(taskDefinitions.map((item) => item.taskDefinitionId));
  if (credentials.some((item) => !systemIds.has(item.sourceSystemId)) || bindings.some((item) => !systemIds.has(item.sourceSystemId))) {
    throw new TypeError("Trigger seed references an unknown source system");
  }
  if (bindings.some((item) => !taskDefinitionIds.has(item.taskDefinitionId))) {
    throw new TypeError("Trigger seed references an unknown task definition");
  }
  return { systems, credentials, bindings, taskDefinitions, materialBindings, writebackBindings };
}

function normalizeRegistration(value) {
  return {
    systems: value.systems.map(normalizeSystem),
    credentials: value.credentials.map(normalizeCredential),
    bindings: value.bindings.map(normalizeServerTriggerBinding),
    taskDefinitions: value.taskDefinitions.map(normalizeTriggerTaskDefinition),
    materialBindings: value.materialBindings.map(normalizeTriggerMaterialBinding),
    writebackBindings: value.writebackBindings.map(normalizeTriggerWritebackBinding),
  };
}

function assertRegistrationReferences(database, normalized) {
  const systemIds = new Set([
    ...database.prepare("SELECT source_system_id FROM trigger_systems").all()
      .map((row) => row.source_system_id),
    ...normalized.systems.map((item) => item.sourceSystemId),
  ]);
  const taskDefinitionIds = new Set([
    ...database.prepare("SELECT task_definition_id FROM trigger_task_definitions").all()
      .map((row) => row.task_definition_id),
    ...normalized.taskDefinitions.map((item) => item.taskDefinitionId),
  ]);
  if (normalized.credentials.some((item) => !systemIds.has(item.sourceSystemId)) ||
    normalized.bindings.some((item) => !systemIds.has(item.sourceSystemId))) {
    throw migrationError("trigger_configuration_registration_unknown_system");
  }
  if (normalized.bindings.some((item) => !taskDefinitionIds.has(item.taskDefinitionId))) {
    throw migrationError("trigger_configuration_registration_unknown_task_definition");
  }
}

function insertOrVerifySystem(database, item) {
  const row = database.prepare("SELECT * FROM trigger_systems WHERE source_system_id = ?")
    .get(item.sourceSystemId);
  if (row) {
    const current = rowToSystem(row);
    if (!isDeepStrictEqual(current, item)) {
      if (sameSystemExceptHomepageUrl(current, item)) {
        if (!current.homepageUrl && item.homepageUrl) {
          database.prepare("UPDATE trigger_systems SET homepage_url = ? WHERE source_system_id = ?")
            .run(item.homepageUrl, item.sourceSystemId);
          return 1;
        }
        if (current.homepageUrl && !item.homepageUrl) return 0;
      }
      throw migrationError("trigger_configuration_registration_system_mismatch");
    }
    return 0;
  }
  database.prepare(`INSERT INTO trigger_systems
    (source_system_id, contract_version, system_type, display_name, adapter_family, homepage_url, owner_label, status, review_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(item.sourceSystemId, item.contractVersion, item.systemType, item.displayName, item.adapterFamily,
    item.homepageUrl, item.ownerLabel, item.status, item.reviewStatus);
  return 1;
}

function insertOrVerifyCredential(database, item) {
  const row = database.prepare("SELECT * FROM trigger_credentials WHERE credential_ref = ?")
    .get(item.credentialRef);
  if (row) {
    if (!isDeepStrictEqual(rowToCredential(row), item)) {
      throw migrationError("trigger_configuration_registration_credential_mismatch");
    }
    return 0;
  }
  database.prepare(`INSERT INTO trigger_credentials
    (credential_ref, contract_version, source_system_id, credential_type, display_name, secret_authority, secret_locator, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(item.credentialRef, item.contractVersion, item.sourceSystemId, item.credentialType,
    item.displayName, item.secretAuthority, item.secretLocator, item.status);
  return 1;
}

function insertOrVerifyTaskDefinition(database, item) {
  const row = database.prepare("SELECT * FROM trigger_task_definitions WHERE task_definition_id = ?")
    .get(item.taskDefinitionId);
  if (row) {
    if (!sameTaskDefinition(rowToTaskDefinition(row), item)) {
      throw migrationError("trigger_configuration_registration_task_definition_mismatch");
    }
    return 0;
  }
  database.prepare(`INSERT INTO trigger_task_definitions
    (task_definition_id, contract_version, task_definition_version, handler_version, skill_policy_ref,
     tool_policy_ref, output_policy_ref, writeback_policy_ref, enabled, review_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(item.taskDefinitionId, item.contractVersion, item.taskDefinitionVersion, item.handlerVersion,
    item.skillPolicyRef, item.toolPolicyRef, item.outputPolicyRef, item.writebackPolicyRef,
    item.enabled ? 1 : 0, item.reviewStatus);
  return 1;
}

function insertOrVerifyBinding(database, item, newCredentials = []) {
  const row = database.prepare(`
    SELECT b.*, c.secret_locator
    FROM trigger_bindings b
    JOIN trigger_credentials c ON c.credential_ref = b.credential_ref
    WHERE b.binding_id = ?
  `).get(item.bindingId);
  if (row) {
    if (!isDeepStrictEqual(rowToBinding(row), item)) {
      throw migrationError("trigger_configuration_registration_binding_mismatch");
    }
    return 0;
  }
  const credentialRef = credentialRefForBindingCurrent(database, item, newCredentials);
  database.prepare(`INSERT INTO trigger_bindings
    (binding_id, contract_version, binding_version, source_adapter_id, source_system_id, event_type,
     target_employee_id, task_definition_id, credential_ref, enabled, review_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(item.bindingId, item.contractVersion, item.bindingVersion, item.sourceAdapterId,
    item.sourceSystemId, item.eventType, item.targetEmployeeId, item.taskDefinitionId,
    credentialRef, item.enabled ? 1 : 0, item.reviewStatus);
  return 1;
}

function insertOrVerifyMaterialBinding(database, item) {
  const row = database.prepare("SELECT * FROM trigger_material_bindings WHERE material_binding_id = ?")
    .get(item.materialBindingId);
  if (row) {
    if (!isDeepStrictEqual(rowToMaterialBinding(row), item)) {
      throw migrationError("trigger_configuration_registration_material_binding_mismatch");
    }
    return 0;
  }
  database.prepare("INSERT INTO trigger_material_bindings (material_binding_id, payload_json) VALUES (?, ?)")
    .run(item.materialBindingId, JSON.stringify(item));
  return 1;
}

function insertOrVerifyWritebackBinding(database, item) {
  const row = database.prepare("SELECT * FROM trigger_writeback_bindings WHERE writeback_binding_id = ?")
    .get(item.writebackBindingId);
  if (row) {
    if (!isDeepStrictEqual(rowToWritebackBinding(row), item)) {
      throw migrationError("trigger_configuration_registration_writeback_binding_mismatch");
    }
    return 0;
  }
  database.prepare("INSERT INTO trigger_writeback_bindings (writeback_binding_id, payload_json) VALUES (?, ?)")
    .run(item.writebackBindingId, JSON.stringify(item));
  return 1;
}

function configurationRowCount(database) {
  return [
    "trigger_systems",
    "trigger_credentials",
    "trigger_bindings",
    "trigger_task_definitions",
    "trigger_material_bindings",
    "trigger_writeback_bindings",
  ].reduce((total, table) => total + Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0), 0);
}

function configurationContainsSeed(database, normalized) {
  for (const item of normalized.systems) {
    const row = database.prepare("SELECT * FROM trigger_systems WHERE source_system_id = ?").get(item.sourceSystemId);
    if (!row || !isDeepStrictEqual(rowToSystem(row), item)) return false;
  }
  for (const item of normalized.credentials) {
    const row = database.prepare("SELECT * FROM trigger_credentials WHERE credential_ref = ?").get(item.credentialRef);
    if (!row || !isDeepStrictEqual(rowToCredential(row), item)) return false;
  }
  for (const item of normalized.taskDefinitions) {
    const row = database.prepare("SELECT * FROM trigger_task_definitions WHERE task_definition_id = ?")
      .get(item.taskDefinitionId);
    if (!row || !sameTaskDefinition(rowToTaskDefinition(row), item)) return false;
  }
  for (const item of normalized.bindings) {
    const row = database.prepare(`
      SELECT b.*, c.secret_locator
      FROM trigger_bindings b
      JOIN trigger_credentials c ON c.credential_ref = b.credential_ref
      WHERE b.binding_id = ?
    `).get(item.bindingId);
    if (!row || !isDeepStrictEqual(rowToBinding(row), item)) return false;
  }
  for (const item of normalized.materialBindings) {
    const row = database.prepare("SELECT * FROM trigger_material_bindings WHERE material_binding_id = ?")
      .get(item.materialBindingId);
    if (!row || !isDeepStrictEqual(rowToMaterialBinding(row), item)) return false;
  }
  for (const item of normalized.writebackBindings) {
    const row = database.prepare("SELECT * FROM trigger_writeback_bindings WHERE writeback_binding_id = ?")
      .get(item.writebackBindingId);
    if (!row || !isDeepStrictEqual(rowToWritebackBinding(row), item)) return false;
  }
  return true;
}

function configurationContainsValidSeed(database, seed) {
  try {
    return configurationContainsSeed(database, normalizeSeed(seed));
  } catch {
    return false;
  }
}

function recordStaticMigration(database) {
  recordMigration(database, "static-trigger-catalog-to-sqlite-v1");
}

function recordMigration(database, migrationId) {
  database.prepare("INSERT INTO trigger_config_migrations (migration_id, applied_at) VALUES (?, ?)")
    .run(migrationId, new Date().toISOString());
}

function sameTaskDefinition(left, right) {
  return left.contractVersion === right.contractVersion
    && left.taskDefinitionId === right.taskDefinitionId
    && left.taskDefinitionVersion === right.taskDefinitionVersion
    && left.handlerVersion === right.handlerVersion
    && left.skillPolicyRef === right.skillPolicyRef
    && left.toolPolicyRef === right.toolPolicyRef
    && left.outputPolicyRef === right.outputPolicyRef
    && left.writebackPolicyRef === right.writebackPolicyRef
    && left.enabled === right.enabled
    && left.reviewStatus === right.reviewStatus;
}

function sameBinding(left, right) {
  return left.contractVersion === right.contractVersion
    && left.bindingId === right.bindingId
    && left.bindingVersion === right.bindingVersion
    && left.sourceAdapterId === right.sourceAdapterId
    && left.sourceSystemId === right.sourceSystemId
    && left.eventType === right.eventType
    && left.targetEmployeeId === right.targetEmployeeId
    && left.taskDefinitionId === right.taskDefinitionId
    && left.secretEnvName === right.secretEnvName
    && left.enabled === right.enabled
    && left.reviewStatus === right.reviewStatus;
}

function sameSystemExceptHomepageUrl(left, right) {
  return left.contractVersion === right.contractVersion
    && left.sourceSystemId === right.sourceSystemId
    && left.systemType === right.systemType
    && left.displayName === right.displayName
    && left.adapterFamily === right.adapterFamily
    && left.ownerLabel === right.ownerLabel
    && left.status === right.status
    && left.reviewStatus === right.reviewStatus;
}

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeSystem(value = {}) {
  if (value.contractVersion !== "trigger-system.v1") throw new TypeError("invalid Trigger system seed");
  return Object.freeze({
    contractVersion: value.contractVersion,
    sourceSystemId: token(value.sourceSystemId),
    systemType: token(value.systemType),
    displayName: label(value.displayName),
    adapterFamily: token(value.adapterFamily),
    homepageUrl: optionalHomepageUrl(value.homepageUrl),
    ownerLabel: label(value.ownerLabel),
    status: value.status === "active" ? value.status : invalid(),
    reviewStatus: value.reviewStatus === "approved" ? value.reviewStatus : invalid(),
  });
}

function normalizeCredential(value = {}) {
  if (value.contractVersion !== "trigger-credential-reference.v1") throw new TypeError("invalid Trigger credential seed");
  if (!["server_environment", "fxiaoke_crm_credential_vault"].includes(value.secretAuthority)) invalid();
  return Object.freeze({
    contractVersion: value.contractVersion,
    credentialRef: token(value.credentialRef),
    sourceSystemId: token(value.sourceSystemId),
    credentialType: token(value.credentialType),
    displayName: label(value.displayName),
    secretAuthority: value.secretAuthority,
    secretLocator: token(value.secretLocator),
    status: value.status === "active" ? value.status : invalid(),
  });
}

function rowToSystem(row) {
  return normalizeSystem({ contractVersion: row.contract_version, sourceSystemId: row.source_system_id,
    systemType: row.system_type, displayName: row.display_name, adapterFamily: row.adapter_family,
    homepageUrl: row.homepage_url || "", ownerLabel: row.owner_label, status: row.status, reviewStatus: row.review_status });
}

function rowToCredential(row) {
  return normalizeCredential({ contractVersion: row.contract_version, credentialRef: row.credential_ref,
    sourceSystemId: row.source_system_id, credentialType: row.credential_type, displayName: row.display_name,
    secretAuthority: row.secret_authority, secretLocator: row.secret_locator, status: row.status });
}

function rowToBinding(row) {
  return normalizeServerTriggerBinding({ contractVersion: row.contract_version, bindingId: row.binding_id,
    bindingVersion: row.binding_version, sourceAdapterId: row.source_adapter_id, sourceSystemId: row.source_system_id,
    eventType: row.event_type, targetEmployeeId: row.target_employee_id, taskDefinitionId: row.task_definition_id,
    secretEnvName: row.secret_locator, enabled: row.enabled === 1, reviewStatus: row.review_status });
}

function rowToTaskDefinition(row) {
  return normalizeTriggerTaskDefinition({ contractVersion: row.contract_version, taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: row.task_definition_version, handlerVersion: row.handler_version,
    skillPolicyRef: row.skill_policy_ref, toolPolicyRef: row.tool_policy_ref,
    outputPolicyRef: row.output_policy_ref, writebackPolicyRef: row.writeback_policy_ref,
    enabled: row.enabled === 1, reviewStatus: row.review_status });
}

function rowToMaterialBinding(row) { return normalizeTriggerMaterialBinding(JSON.parse(row.payload_json)); }
function rowToWritebackBinding(row) { return normalizeTriggerWritebackBinding(JSON.parse(row.payload_json)); }

function credentialRefForBinding(binding, credentials) {
  const match = credentials.find((item) => item.secretAuthority === "server_environment" && item.secretLocator === binding.secretEnvName);
  if (!match) throw new TypeError("Trigger binding seed has no credential reference");
  return match.credentialRef;
}

function credentialRefForBindingCurrent(database, binding, credentials) {
  const included = credentials.find((item) => item.secretAuthority === "server_environment" &&
    item.secretLocator === binding.secretEnvName && item.sourceSystemId === binding.sourceSystemId);
  if (included) return included.credentialRef;
  const row = database.prepare(`
    SELECT credential_ref
    FROM trigger_credentials
    WHERE secret_authority = 'server_environment' AND secret_locator = ? AND source_system_id = ?
  `).get(binding.secretEnvName, binding.sourceSystemId);
  if (!row?.credential_ref) throw migrationError("trigger_configuration_registration_credential_missing");
  return row.credential_ref;
}

function credentialRefForBindingRow(bindingId, database) {
  return database.prepare("SELECT credential_ref FROM trigger_bindings WHERE binding_id = ?").get(bindingId)?.credential_ref || "";
}

function requiredDatabasePath(value) {
  const text = String(value || "").trim();
  if (text === ":memory:") return text;
  if (!text || !path.isAbsolute(text)) throw new TypeError("Trigger config databasePath must be absolute or :memory:");
  return path.normalize(text);
}
function ensureColumn(database, tableName, columnName, definition) {
  const exists = database.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((row) => row.name === columnName);
  if (!exists) database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
function token(value) { const text = String(value || "").trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/.test(text)) invalid(); return text; }
function label(value) { const text = String(value || "").trim(); if (!text || text.length > 240) invalid(); return text; }
function optionalHomepageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 2048) invalid();
  let url;
  try {
    url = new URL(text);
  } catch {
    invalid();
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  return url.toString();
}
function invalid() { throw new TypeError("invalid Trigger configuration value"); }

export { CONTRACT_VERSION as TRIGGER_CONFIG_REPOSITORY_CONTRACT_VERSION, createSqliteTriggerConfigRepository };
