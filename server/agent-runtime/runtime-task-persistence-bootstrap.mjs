import crypto from "node:crypto";
import path from "node:path";
import { createWorkItemDisplayRepository } from "../work-item-display.mjs";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";
import { createSqliteExecutionAdmissionRepository } from "./execution-admission-repository.mjs";
import { createRuntimeTaskActorDisplaySnapshotRepository } from "../auth/runtime-task-actor-display-snapshot-repository.mjs";
import { createIdempotentEffectService } from "./idempotent-effect-service.mjs";
import { createOperationReceiptProjector } from "./operation-receipt-projector.mjs";
import { createSqliteExecutionTaskRepository } from "./sqlite-runtime-task-repository.mjs";
import { createSqliteTaskMaterialBindingRepository } from "./sqlite-task-material-binding-repository.mjs";
import { createSqliteToolCallConfirmationRepository } from "./sqlite-tool-call-confirmation-repository.mjs";
import { createSqliteToolParameterContinuationRepository } from "./sqlite-tool-parameter-continuation-repository.mjs";
import { bindTaskSkillPublications } from "../skill-publication-task-bindings.mjs";
import { normalizeExecutionTaskSubmission } from "./runtime-task-contract-v1.mjs";

const EXECUTION_TASK_DATABASE_FILE = "execution-tasks.sqlite";
const EXECUTION_ADMISSION_DATABASE_FILE = "execution-admissions.sqlite";
const RUNTIME_TASK_ACTOR_DISPLAY_SNAPSHOT_DATABASE_FILE = "runtime-task-actor-display-snapshots.sqlite";
const TASK_MATERIAL_BINDING_DATABASE_FILE = "task-material-bindings.sqlite";
const TOOL_CALL_CONFIRMATION_DATABASE_FILE = "tool-call-confirmations.sqlite";
const TOOL_PARAMETER_CONTINUATION_DATABASE_FILE = "tool-parameter-continuations.sqlite";
const ARTIFACT_OBJECT_DIRECTORY = "artifact-objects";

function createRuntimeTaskPersistence({ env = process.env, projectRoot, now = new Date(), resolveSkills = null } = {}) {
  const dataDir = resolveDigitalWorkforceDataDir({
    env,
    projectRoot: requiredProjectRoot(projectRoot),
  });
  const databasePath = resolveConfiguredAbsolutePath(
    env.EXECUTION_TASK_DATABASE_PATH,
    path.join(dataDir, EXECUTION_TASK_DATABASE_FILE),
    "EXECUTION_TASK_DATABASE_PATH",
  );
  const admissionDatabasePath = resolveConfiguredAbsolutePath(
    env.EXECUTION_ADMISSION_DATABASE_PATH,
    path.join(dataDir, EXECUTION_ADMISSION_DATABASE_FILE),
    "EXECUTION_ADMISSION_DATABASE_PATH",
  );
  const actorDisplaySnapshotDatabasePath = resolveConfiguredAbsolutePath(
    env.RUNTIME_TASK_ACTOR_DISPLAY_SNAPSHOT_DATABASE_PATH,
    path.join(dataDir, RUNTIME_TASK_ACTOR_DISPLAY_SNAPSHOT_DATABASE_FILE),
    "RUNTIME_TASK_ACTOR_DISPLAY_SNAPSHOT_DATABASE_PATH",
  );
  const taskMaterialBindingDatabasePath = resolveConfiguredAbsolutePath(
    env.TASK_MATERIAL_BINDING_DATABASE_PATH,
    path.join(dataDir, TASK_MATERIAL_BINDING_DATABASE_FILE),
    "TASK_MATERIAL_BINDING_DATABASE_PATH",
  );
  const toolParameterContinuationDatabasePath = resolveConfiguredAbsolutePath(
    env.TOOL_PARAMETER_CONTINUATION_DATABASE_PATH,
    path.join(dataDir, TOOL_PARAMETER_CONTINUATION_DATABASE_FILE),
    "TOOL_PARAMETER_CONTINUATION_DATABASE_PATH",
  );
  const toolCallConfirmationDatabasePath = path.join(dataDir, TOOL_CALL_CONFIRMATION_DATABASE_FILE);
  const artifactObjectRoot = resolveConfiguredAbsolutePath(
    env.ARTIFACT_OBJECT_ROOT,
    path.join(dataDir, ARTIFACT_OBJECT_DIRECTORY),
    "ARTIFACT_OBJECT_ROOT",
  );
  const encryptionRootKey = decodeEncryptionKey(env.SESSION_FOUNDATION_ENCRYPTION_KEY);
  const resources = [];
  const own = repository => { resources.push(repository); return repository; };
  function close() {
    let failure;
    const retry = [];
    while (resources.length) {
      const repository = resources.pop();
      try { repository.close(); } catch (error) { retry.push(repository); failure ||= error; }
    }
    resources.push(...retry.reverse());
    if (failure) throw failure;
  }
  try {
    const workItemDisplayRepository = own(createWorkItemDisplayRepository({ databasePath: path.join(dataDir, "work-item-display.sqlite"), encryptionKey: deriveRuntimeKey(encryptionRootKey, "work-item-display.v1") }));
    const taskRepository = own(createSqliteExecutionTaskRepository({
      databasePath,
      personalAutomationSchemaPhase: "activate",
      efficiencyFingerprintKey: deriveRuntimeKey(encryptionRootKey, "runtime-tool-efficiency-fingerprint.v1"),
      receiptEncryptionKey: deriveRuntimeKey(encryptionRootKey, "execution-operation-receipt.v1"),
    }));
    function prepareSubmission(value) {
      const submission = normalizeExecutionTaskSubmission(value);
      taskRepository.assertSubmissionCompatible(submission);
      if (resolveSkills) bindTaskSkillPublications(submission, resolveSkills());
      return submission;
    }
    const repository = Object.freeze({ ...taskRepository,
      prepareSubmission,
      submitOrGet(value, ...args) {
        return taskRepository.submitOrGet(prepareSubmission(value), ...args);
      },
    });
    // A Center restart restores facts first. Only an explicit, reauthorized
    // Group resume may release another step; existing canonical tasks remain owned
    // by their normal Worker recovery and receipt boundaries.
    repository.groups.requireResumeAfterRestart();
    const admissionRepository = own(createSqliteExecutionAdmissionRepository({
      databasePath: admissionDatabasePath,
      encryptionKey: encryptionRootKey,
    }));
    const personalAutomationOwnerRepository = own(createSqliteExecutionAdmissionRepository({
      databasePath: path.join(dataDir, "personal-automation-owner-bindings.sqlite"),
      encryptionKey: deriveRuntimeKey(encryptionRootKey, "personal-automation-owner.v1"),
      maxTtlMs: 90 * 86400000,
    }));
    const actorDisplaySnapshotRepository = own(createRuntimeTaskActorDisplaySnapshotRepository({
      databasePath: actorDisplaySnapshotDatabasePath,
      encryptionKey: deriveRuntimeKey(encryptionRootKey, "runtime-task-actor-display-snapshot.v1"),
    }));
    const taskMaterialBindingRepository = own(createSqliteTaskMaterialBindingRepository({
      databasePath: taskMaterialBindingDatabasePath,
      encryptionKey: deriveRuntimeKey(encryptionRootKey, "task-material-binding.v1"),
    }));
    const toolParameterContinuationRepository = own(createSqliteToolParameterContinuationRepository({
      databasePath: toolParameterContinuationDatabasePath,
      encryptionKey: deriveRuntimeKey(encryptionRootKey, "tool-parameter-continuation.v1"),
    }));
    const toolCallConfirmationRepository = own(createSqliteToolCallConfirmationRepository({
      databasePath: toolCallConfirmationDatabasePath,
      encryptionKey: deriveRuntimeKey(encryptionRootKey, "tool-call-confirmation.v1"),
    }));
    const idempotentEffectService = createIdempotentEffectService({ repository });
    const operationReceiptProjector = createOperationReceiptProjector({
      digestKey: deriveRuntimeKey(encryptionRootKey, "execution-operation-digest.v1"),
    });
    return Object.freeze({
      authority: Object.freeze({
        kind: "channel_neutral_execution_task_database",
        adapterKind: repository.adapterKind,
        deploymentScope: repository.deploymentScope,
        distributedCoordination: repository.distributedCoordination,
        productionReady: false,
      }),
      admissionDatabasePath,
      admissionRepository,
      personalAutomationOwnerRepository,
      actorDisplaySnapshotDatabasePath,
      actorDisplaySnapshotRepository,
      workItemDisplayRepository,
      close,
      databasePath,
      artifactObjectRoot,
      mode: "sqlite",
      idempotentEffectService,
      operationReceiptProjector,
      productionReady: false,
      repository,
      taskMaterialBindingDatabasePath,
      taskMaterialBindingRepository,
      toolCallConfirmationDatabasePath,
      toolCallConfirmationRepository,
      toolParameterContinuationDatabasePath,
      toolParameterContinuationRepository,
    });
  } catch (error) {
    try { close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "runtime_task_persistence_startup_failed", { cause: error });
    }
    throw error;
  }
}

function deriveRuntimeKey(rootKey, domain) {
  return Buffer.from(crypto.hkdfSync("sha256", rootKey, Buffer.alloc(0), Buffer.from(domain, "utf8"), 32));
}

function decodeEncryptionKey(value) {
  const encoded = String(value || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError("SESSION_FOUNDATION_ENCRYPTION_KEY must be base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new TypeError("SESSION_FOUNDATION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function resolveConfiguredAbsolutePath(value, fallback, environmentName) {
  const configured = String(value || "").trim();
  if (!configured) return path.normalize(fallback);
  if (!path.isAbsolute(configured)) throw new TypeError(`${environmentName} must be an absolute path`);
  return path.normalize(configured);
}

function requiredProjectRoot(value) {
  const projectRoot = String(value || "").trim();
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    throw new TypeError("runtime task persistence requires an absolute projectRoot");
  }
  return path.normalize(projectRoot);
}

export {
  EXECUTION_ADMISSION_DATABASE_FILE,
  RUNTIME_TASK_ACTOR_DISPLAY_SNAPSHOT_DATABASE_FILE,
  EXECUTION_TASK_DATABASE_FILE,
  ARTIFACT_OBJECT_DIRECTORY,
  TASK_MATERIAL_BINDING_DATABASE_FILE,
  TOOL_PARAMETER_CONTINUATION_DATABASE_FILE,
  createRuntimeTaskPersistence,
  resolveConfiguredAbsolutePath,
};
