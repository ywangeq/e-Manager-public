import { projectRunnableGovernedScheduleFromActivationSnapshot } from "./schedule-activation-snapshot.mjs";
import { assertDependencyContextStorageBoundary } from "./dependency-context.mjs";
import crypto from "node:crypto";
import { normalizeTaskModelBinding } from "./governed-schedule-registry.mjs";
import { normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";

// Owned by the existing control database and its transaction. No independent
// connection, scheduler, current-configuration authority or credential storage.
export const SCHEDULE_RUN_CONFIGURATION_TABLE_SQL = `CREATE TABLE schedule_run_configurations (
  tenant_scope TEXT NOT NULL,
  run_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (tenant_scope, run_id)
)`;
const fields = ["dependencyContext", "providerTimeoutPolicy", "taskModelBinding"];

export function createScheduleRunConfigurationStore({ database, encryptionKeys, currentEncryptionKeyId, stableIntegrityHmacKey } = {}) {
  const keys = new Map(Object.entries(encryptionKeys || {}).map(([id, value]) => [token(id), key(value)]));
  const currentKeyId = token(currentEncryptionKeyId);
  if (!keys.has(currentKeyId)) throw failure("schedule_run_configuration_key_unavailable");
  const integrityKey = key(stableIntegrityHmacKey);

  function bindingFor(intent) {
    return {
      tenantScope: token(intent.tenantScope), runId: token(intent.runId), employeeId: token(intent.employeeId),
      scheduleId: token(intent.scheduleId), activationSnapshotDigest: digest(intent.activationSnapshotDigest),
      executionContractDigest: digest(intent.executionContractDigest), scheduledFor: timestamp(intent.scheduledFor),
      executionTaskId: token(intent.expectedExecutionTaskId),
    };
  }
  function contentDigest(binding, configuration) {
    return crypto.createHmac("sha256", integrityKey).update(canonical({ binding, configuration })).digest("hex");
  }
  function read(intent) {
    const binding = bindingFor(intent);
    const row = database.prepare("SELECT * FROM schedule_run_configurations WHERE tenant_scope = ? AND run_id = ?")
      .get(binding.tenantScope, binding.runId);
    if (!row) return null;
    if (row.binding_json !== canonical(binding)) throw failure("schedule_run_configuration_binding_mismatch");
    const encryptionKey = keys.get(row.encryption_key_id);
    if (!encryptionKey) throw failure("schedule_run_configuration_key_unavailable");
    let configuration;
    try {
      const packed = Buffer.from(row.ciphertext, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(canonical({ binding, digest: row.content_digest, keyId: row.encryption_key_id })));
      decipher.setAuthTag(packed.subarray(12, 28));
      configuration = normalizeConfiguration(JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8")), binding);
    } catch { throw failure("schedule_run_configuration_integrity_failed"); }
    if (contentDigest(binding, configuration) !== row.content_digest) throw failure("schedule_run_configuration_integrity_failed");
    return freeze({ contractVersion: "schedule-run-configuration.v1", binding, configuration, configurationDigest: row.content_digest });
  }
  function seal(intent, value) {
    if (!database.isTransaction) throw failure("schedule_run_configuration_transaction_required");
    // Existing slot wins before consulting any mutable employee configuration.
    const existing = read(intent);
    if (existing) return existing;
    const binding = bindingFor(intent);
    const configuration = normalizeConfiguration(value, binding);
    const content = contentDigest(binding, configuration);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(currentKeyId), nonce);
    cipher.setAAD(Buffer.from(canonical({ binding, digest: content, keyId: currentKeyId })));
    const encrypted = Buffer.concat([cipher.update(canonical(configuration), "utf8"), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    database.prepare("INSERT INTO schedule_run_configurations VALUES (?, ?, ?, ?, ?, ?)")
      .run(binding.tenantScope, binding.runId, canonical(binding), content, currentKeyId, ciphertext);
    return read(intent);
  }
  return Object.freeze({ read, seal });
}

// One projection owns the transition from activation policy to this run's
// effective execution configuration. Missing content is never a legacy fallback.
export function projectScheduleFromRunConfiguration(snapshot, record, intent) {
  if (!record || record.contractVersion !== "schedule-run-configuration.v1") throw failure("schedule_run_configuration_required");
  const binding = record.binding;
  if (binding?.tenantScope !== snapshot.tenantScope || binding.employeeId !== snapshot.employeeId ||
    binding.scheduleId !== snapshot.scheduleId || binding.activationSnapshotDigest !== snapshot.snapshotDigest ||
    binding.executionContractDigest !== snapshot.executionContractDigest ||
    (intent && (binding.runId !== intent.runId || binding.executionTaskId !== intent.expectedExecutionTaskId || binding.scheduledFor !== intent.scheduledFor))) {
    throw failure("schedule_run_configuration_binding_mismatch");
  }
  const configuration = normalizeConfiguration(record.configuration, binding);
  if (configuration.taskModelBinding.taskId !== snapshot.taskDefinitionId) throw failure("schedule_run_configuration_task_mismatch");
  if (configuration.providerTimeoutPolicy.taskExecutionTotalMs > snapshot.timeoutSeconds * 1000) throw failure("schedule_run_configuration_budget_exceeded");
  return Object.freeze({ ...projectRunnableGovernedScheduleFromActivationSnapshot(snapshot),
    employeeVersion: configuration.dependencyContext.employee.version,
    providerTimeoutPolicy: configuration.providerTimeoutPolicy,
    runConfigurationDigest: digest(record.configurationDigest),
  });
}

function normalizeConfiguration(value, binding) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== [...fields].sort().join()) throw failure("schedule_run_configuration_invalid");
  const context = value.dependencyContext;
  if (context?.contractVersion !== "digital-employee-runtime-dependency-context.v2" ||
    context.employee?.id !== binding.employeeId || !context.employee?.version ||
    context.channelBinding?.channel !== "schedule" || context.channelBinding?.sourceSystemId !== "digital-workforce-scheduler" ||
    !Array.isArray(context.skillScope?.blockedSkills) || context.skillScope.blockedSkills.length) {
    throw failure("schedule_run_configuration_dependency_invalid");
  }
  assertDependencyContextStorageBoundary(context);
  token(context.employee.version);
  // Only the assembled execution context is accepted; raw employee/catalog objects
  // and Provider credentials are not members of this contract.
  const normalized = { dependencyContext: context,
    taskModelBinding: normalizeTaskModelBinding(value.taskModelBinding),
    providerTimeoutPolicy: normalizeProviderTimeoutPolicy(value.providerTimeoutPolicy) };
  validateJson(normalized);
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw failure("schedule_run_configuration_too_large");
  return JSON.parse(encoded);
}
function validateJson(value, depth = 0, budget = { remaining: 25000 }) {
  if (--budget.remaining < 0 || depth > 32) throw failure("schedule_run_configuration_too_large");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1, budget); return; }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [name, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(name)) throw failure("schedule_run_configuration_invalid");
      validateJson(item, depth + 1, budget);
    }
    return;
  }
  throw failure("schedule_run_configuration_invalid");
}
function token(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value)) throw failure("schedule_run_configuration_identity_invalid"); return value; }
function digest(value) { if (!/^[a-f0-9]{64}$/.test(value || "")) throw failure("schedule_run_configuration_digest_invalid"); return value; }
function timestamp(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure("schedule_run_configuration_time_invalid"); return value; }
function key(value) { if (!Buffer.isBuffer(value) || value.length !== 32) throw failure("schedule_run_configuration_key_invalid"); return Buffer.from(value); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`; return JSON.stringify(value); }
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
