import { cp } from "node:fs/promises";
import path from "node:path";
import { assembleDigitalEmployeeDependencyContext } from "../../agent-runtime/dependency-context.mjs";
import { createEmployeeToolExecutor } from "../../agent-runtime/employee-tool-executor.mjs";
import {
  FXIAOKE_CRM_TOOL_NAMES,
  createFxiaokeCrmReadonlyToolExecutor,
} from "../../agent-runtime/fxiaoke-crm-readonly-tool-executor.mjs";
import { createMaterialToolExecutor } from "../../agent-runtime/material-tool-executor.mjs";
import { resolveSkillRuntimeProjection } from "../../agent-runtime/skill-runtime-projection.mjs";
import { hasCompleteVerifiedSkillRuntimeDocuments } from "../../agent-runtime/verified-skill-runtime-documents.mjs";

const RESOURCE_CONTRACT_VERSION = "fxiaoke-trigger-subject-agent-resources.v1";
const SUBJECT_TOOL_POLICY = Object.freeze(new Map([
  ["describe_current_object", Object.freeze({
    name: "fxiaoke_crm__describeCurrentObject",
    action: "describe_current_object",
    risk: "read_only",
    scope: Object.freeze(["current_subject:schema:read"]),
    writebackBoundary: "none",
  })],
  ["read_current_object", Object.freeze({
    name: "fxiaoke_crm__readCurrentObject",
    action: "read_current_object",
    risk: "read_only",
    scope: Object.freeze(["current_subject:record:read"]),
    writebackBoundary: "none",
  })],
  ["prepare_current_object_material", Object.freeze({
    name: "fxiaoke_crm__prepareCurrentObjectMaterial",
    action: "prepare_current_object_material",
    risk: "read_only",
    scope: Object.freeze(["current_subject:material:prepare"]),
    writebackBoundary: "ephemeral_task_workspace_only",
  })],
]));
const MATERIAL_TOOL_NAMES = Object.freeze(new Set([
  "inspect_workspace_file",
  "inspect_workspace_image",
  "list_workspace_files",
  "read_workspace_text",
  "run_mounted_skill",
]));
const OBSERVED_TOOL_NAMES = Object.freeze(new Set([
  ...[...SUBJECT_TOOL_POLICY.values()].map((operation) => operation.name),
  ...MATERIAL_TOOL_NAMES,
]));
const SAFE_CODE = /^(?:crm_|trigger_|skill_|material_|tool_|workspace_|agent_)[a-z0-9_]{1,110}$/;

function createFxiaokeTriggerSubjectAgentResourceBuilder({
  businessSkills = [],
  credentialConfigured = false,
  credentialProvider,
  diagnosticLogger = null,
  fetchImpl = globalThis.fetch,
  getBusinessSkills = null,
  materialAdapter,
  requestTimeoutMs = 10_000,
  serviceClient = null,
  skillHarnessRunner,
  skillId,
  skillPolicyRef,
  subjectRecordObserver = null,
  taskWorkspaceManager,
  toolPolicyRef,
  workspaceService,
} = {}) {
  requireMethod(materialAdapter, "acquireSubjectMaterial");
  requireMethod(materialAdapter, "resolveSubjectDownloadUrls");
  requireMethod(skillHarnessRunner, "inspectHarnessReadiness");
  requireMethod(skillHarnessRunner, "run");
  requireMethod(taskWorkspaceManager, "cleanupTaskWorkspace");
  requireMethod(taskWorkspaceManager, "createTaskInputDirectory");
  requireMethod(taskWorkspaceManager, "workspaceForTask");
  requireMethod(workspaceService, "prepare");
  if (diagnosticLogger !== null && typeof diagnosticLogger !== "function") {
    throw new TypeError("Fxiaoke Trigger subject resources diagnosticLogger must be a function");
  }
  if (subjectRecordObserver !== null && typeof subjectRecordObserver !== "function") {
    throw new TypeError("Fxiaoke Trigger subjectRecordObserver must be a function");
  }
  const exactSkillId = reference(skillId);
  const exactSkillPolicyRef = reference(skillPolicyRef);
  const exactToolPolicyRef = reference(toolPolicyRef);

  return async function buildExecutionResources({
    employee,
    signal,
    task,
    taskDefinition,
    triggerEvent,
  } = {}) {
    assertFrozenPolicy({ taskDefinition, triggerEvent }, {
      skillPolicyRef: exactSkillPolicyRef,
      toolPolicyRef: exactToolPolicyRef,
    });
    const taskId = reference(task?.taskId);
    const subject = normalizeSubject(triggerEvent?.event?.subject);
    const diagnosticContext = Object.freeze({
      eventRef: reference(triggerEvent?.event?.eventId || triggerEvent?.triggerEventId),
      taskRef: taskId,
    });
    const observation = {
      materialOutcome: "not_requested",
      selectedToolCount: 0,
      describedSubject: false,
      preparedMaterial: false,
      readSubject: false,
      ranMountedSkill: false,
    };
    const emitDiagnostic = (detail) => emitSubjectMaterialDiagnostic(
      diagnosticLogger,
      diagnosticContext,
      detail,
    );
    const observeSubjectRecord = async ({ record, subject: observedSubject = subject }) => {
      if (!subjectRecordObserver) return;
      try {
        const outcome = await subjectRecordObserver(Object.freeze({
          record,
          subject: observedSubject,
          taskId,
          triggerEventId: triggerEvent.triggerEventId,
        }));
        emitDiagnostic({
          outcome: ["recorded", "already_recorded"].includes(outcome?.status) ? "completed" : "ignored",
          stage: "business_locator",
        });
      } catch (error) {
        emitDiagnostic({
          outcome: "failed",
          safeCode: safeDiagnosticCode(error),
          stage: "business_locator",
        });
      }
    };
    await taskWorkspaceManager.cleanupTaskWorkspace(taskId);
    const workspace = await taskWorkspaceManager.workspaceForTask(taskId, { create: true });
    const currentSkills = typeof getBusinessSkills === "function"
      ? getBusinessSkills({ task })
      : businessSkills;
    const dependencyContext = assembleDigitalEmployeeDependencyContext({
      businessSkills: currentSkills,
      channel: {
        channel: "trigger",
        sourceSystemId: "fxiaoke-crm",
        status: "active",
        receiveMode: "server_subject_grant",
      },
      employee,
      workerBinding: {
        employeeId: employee?.id,
        selectedSkillIds: [exactSkillId],
        skillScopeMode: "restricted",
      },
    });
    const sourceSkill = currentSkills.find((item) => item?.id === exactSkillId);
    const runtimeSkill = dependencyContext.callableSkills.find((item) => item?.id === exactSkillId);
    if (!dependencyContext.skillScope.callableSkillIds.includes(exactSkillId) ||
      !hasCompleteVerifiedSkillRuntimeDocuments({
        sourceSkill,
        runtimeSkill,
        skillPolicyRef: exactSkillPolicyRef,
      })) {
      throw resourceError("trigger_agent_skill_policy_unavailable");
    }
    const skillRuntimeProjection = await resolveSkillRuntimeProjection({
      skillHarnessRunner,
      runtimeTask: task,
      skillScope: dependencyContext.skillScope,
    });
    const materialToolExecutor = createMaterialToolExecutor({
      authorizeToolCall: (toolCall) => authorizeMaterialToolCall(toolCall, exactSkillId),
      channelInputs: [],
      channelMaterialIntakeAllowed: false,
      completionEvidenceCapabilities: skillRuntimeProjection.completionEvidenceCapabilities,
      connection: { channelId: "trigger", sourceSystemId: "fxiaoke-crm" },
      employee,
      materialInputContracts: skillRuntimeProjection.materialInputContracts,
      skillHarnessRunner: skillRuntimeProjection.skillHarnessRunner || skillHarnessRunner,
      skillScope: dependencyContext.skillScope,
      verifiedHarnessSkillIds: skillRuntimeProjection.verifiedHarnessSkillIds,
      workspace,
      workspaceInitiallyReady: false,
      workspaceManager: taskWorkspaceManager,
      workspaceTaskId: taskId,
    });
    let prepared = null;
    const crmToolExecutor = createFxiaokeCrmReadonlyToolExecutor({
      accessCheck: (accessContext) => authorizeIntegrationSubjectAccess(accessContext, {
        taskId,
        toolPolicyRef: exactToolPolicyRef,
        triggerEventId: triggerEvent.triggerEventId,
      }),
      accessContext: {
        accessMode: "integration_subject",
        taskId,
        toolPolicyRef: taskDefinition.toolPolicyRef,
        triggerEventId: triggerEvent.triggerEventId,
      },
      authorizeToolCall: (toolCall, operation) => authorizeSubjectToolCall(
        toolCall,
        operation,
        exactToolPolicyRef,
        taskDefinition,
      ),
      credentialConfigured,
      credentialProvider,
      employee,
      fetchImpl,
      observeSubjectRecord,
      prepareSubjectMaterial: async ({ signal: toolSignal, subject: currentSubject }) => {
        if (prepared) return prepared;
        try {
          const material = await materialAdapter.acquireSubjectMaterial({
            signal: toolSignal,
            subject: currentSubject,
          });
          await observeSubjectRecord({ record: material.form, subject: currentSubject });
          emitDiagnostic({
            attachmentCount: material.attachments.length,
            formFieldCount: Object.keys(material.form).length,
            outcome: "completed",
            stage: "material_discovery",
          });
          const downloadUrls = await materialAdapter.resolveSubjectDownloadUrls({
            material,
            signal: toolSignal,
          });
          emitDiagnostic({
            attachmentCount: downloadUrls.length,
            outcome: "completed",
            stage: "attachment_resolution",
          });
          const transient = await workspaceService.prepare({
            downloadUrls,
            material,
            signal: toolSignal,
          });
          try {
          const inputRoot = await taskWorkspaceManager.createTaskInputDirectory(
            taskId,
            `trigger-subject:${triggerEvent.triggerEventId}`,
          );
          await cp(transient.workspacePath, inputRoot, { recursive: true, force: false });
          prepared = Object.freeze({
            status: "completed",
            inputId: path.basename(inputRoot),
            fileCount: material.attachments.length + (Object.keys(material.form).length ? 1 : 0),
          });
          materialToolExecutor.markWorkspaceReady();
          observation.materialOutcome = "completed";
          observation.preparedMaterial = true;
          emitDiagnostic({
            ...safeWorkspaceDiagnosticSummary(transient.diagnosticSummary),
            outcome: "completed",
            stage: "material_workspace",
          });
          return prepared;
          } finally {
            await transient.cleanup();
          }
        } catch (error) {
          observation.materialOutcome = "failed";
          emitDiagnostic({
            outcome: "failed",
            safeCode: safeDiagnosticCode(error),
            stage: "material_prepare",
          });
          throw error;
        }
      },
      requestTimeoutMs,
      serviceClient,
      subjectScope: subject,
    });
    await prefetchSubjectBusinessReference({
      crmToolExecutor,
      emitDiagnostic,
      observation,
      signal,
      subjectRecordObserver,
    });
    const aggregate = await createEmployeeToolExecutor({
      additionalExecutors: [crmToolExecutor, materialToolExecutor],
      employee,
    });
    const observedToolExecutor = observeToolExecutor(aggregate, {
      emitDiagnostic,
      observation,
    });
    let cleaned = false;
    return Object.freeze({
      contractVersion: RESOURCE_CONTRACT_VERSION,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        emitDiagnostic({
          describedSubject: observation.describedSubject,
          materialOutcome: observation.materialOutcome,
          outcome: "completed",
          preparedMaterial: observation.preparedMaterial,
          ranMountedSkill: observation.ranMountedSkill,
          readSubject: observation.readSubject,
          selectedToolCount: observation.selectedToolCount,
          stage: "resource_summary",
        });
        await materialToolExecutor.dispose();
        await taskWorkspaceManager.cleanupTaskWorkspace(taskId);
      },
      dependencyContext,
      employeeIdentity: Object.freeze({
        id: employee.id,
        name: employee.name || employee.displayName || employee.id,
        title: employee.title,
        objective: employee.objective,
        configuredFunctions: employee.configuredFunctions,
        identityBoundaries: employee.identityBoundaries,
      }),
      references: Object.freeze([Object.freeze({
        kind: "trigger_subject",
        sourceSystemId: "fxiaoke-crm",
        triggerEventId: triggerEvent.triggerEventId,
      })]),
      safeContext: Object.freeze({
        channel: "trigger",
        dependencyContext,
        subjectGrant: Object.freeze({
          contractVersion: "crm-subject-access-grant.v1",
          exactSubjectOnly: true,
          sourceSystemId: "fxiaoke-crm",
          toolPolicyRef: exactToolPolicyRef,
        }),
        turn: Object.freeze({
          responsePolicy: "versioned_trigger_output_policy",
          turnIntent: "review_current_trigger_subject",
        }),
      }),
      toolExecutor: observedToolExecutor,
    });
  };
}

async function prefetchSubjectBusinessReference({
  crmToolExecutor,
  emitDiagnostic,
  observation,
  signal,
  subjectRecordObserver,
}) {
  if (!subjectRecordObserver || signal?.aborted) return;
  try {
    const result = await crmToolExecutor.execute({
      name: FXIAOKE_CRM_TOOL_NAMES.read_current_object,
      arguments: {},
    }, { signal });
    const blocked = toolResultBlocked(result);
    if (!blocked) observation.readSubject = true;
    emitDiagnostic({
      outcome: blocked ? toolResultOutcome(result) : "completed",
      safeCode: blocked ? safeDiagnosticCode(result) : "",
      stage: "business_reference_prefetch",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    emitDiagnostic({
      outcome: "failed",
      safeCode: safeDiagnosticCode(error),
      stage: "business_reference_prefetch",
    });
  }
}

function observeToolExecutor(executor, { emitDiagnostic, observation }) {
  return Object.freeze({
    agentResultFor: (...args) => executor.agentResultFor(...args),
    availableAgentContent: (...args) => executor.availableAgentContent(...args),
    availableInputIds: (...args) => executor.availableInputIds(...args),
    completionEvidence: (...args) => executor.completionEvidence(...args),
    completionEvidenceCapabilities: (...args) => executor.completionEvidenceCapabilities(...args),
    runtimeStatus: (...args) => executor.runtimeStatus(...args),
    safeActivityDescriptor: (...args) => executor.safeActivityDescriptor?.(...args) || null,
    safeToolCatalog: (...args) => executor.safeToolCatalog(...args),
    toolExecutionPolicy: (...args) => executor.toolExecutionPolicy(...args),
    toolDefinitions: (...args) => executor.toolDefinitions(...args),
    async execute(toolCall = {}, options = {}) {
      const toolName = OBSERVED_TOOL_NAMES.has(toolCall.name) ? toolCall.name : "unrecognized";
      observation.selectedToolCount += 1;
      emitDiagnostic({ outcome: "selected", stage: "tool_call", toolName });
      try {
        const result = await executor.execute(toolCall, options);
        const blocked = toolResultBlocked(result);
        if (!blocked) {
          observation.describedSubject ||= toolName === "fxiaoke_crm__describeCurrentObject";
          observation.readSubject ||= toolName === "fxiaoke_crm__readCurrentObject";
          observation.ranMountedSkill ||= toolName === "run_mounted_skill";
        }
        emitDiagnostic({
          outcome: blocked ? "blocked" : "completed",
          safeCode: blocked ? safeDiagnosticCode(result) : "",
          stage: "tool_result",
          toolName,
        });
        return result;
      } catch (error) {
        emitDiagnostic({
          outcome: "failed",
          safeCode: safeDiagnosticCode(error),
          stage: "tool_result",
          toolName,
        });
        throw error;
      }
    },
  });
}

function emitSubjectMaterialDiagnostic(logger, context, detail) {
  if (!logger) return;
  const record = Object.freeze({
    contractVersion: "fxiaoke-subject-material-diagnostic.v1",
    adapterId: RESOURCE_CONTRACT_VERSION,
    eventRef: context.eventRef,
    taskRef: context.taskRef,
    stage: detail.stage,
    outcome: detail.outcome,
    ...(detail.toolName ? { toolName: detail.toolName } : {}),
    ...(detail.safeCode ? { safeCode: detail.safeCode } : {}),
    ...safeCountFields(detail),
    ...safeBooleanFields(detail),
    ...(detail.materialOutcome ? { materialOutcome: detail.materialOutcome } : {}),
  });
  try {
    logger(record);
  } catch {
    // Diagnostics must never change Agent execution or cleanup.
  }
}

function safeWorkspaceDiagnosticSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    ...safeCountFields(value),
    ...safeBooleanFields(value),
  };
}

function safeCountFields(value) {
  const result = {};
  for (const field of [
    "attachmentCount",
    "extractedDocumentCount",
    "failedExtractionCount",
    "formFieldCount",
    "selectedToolCount",
  ]) {
    if (Number.isSafeInteger(value?.[field]) && value[field] >= 0 && value[field] <= 100_000) {
      result[field] = value[field];
    }
  }
  return result;
}

function safeBooleanFields(value) {
  const result = {};
  for (const field of [
    "contractTextAvailable",
    "describedSubject",
    "preparedMaterial",
    "ranMountedSkill",
    "readSubject",
  ]) {
    if (typeof value?.[field] === "boolean") result[field] = value[field];
  }
  return result;
}

function safeDiagnosticCode(value) {
  const candidate = String(value?.code || value?.errorCode || value?.error || value?.status || "");
  return SAFE_CODE.test(candidate) ? candidate : "trigger_subject_material_operation_failed";
}

function toolResultBlocked(value) {
  if (value?.ok === false) return true;
  const status = String(value?.status || "").toLowerCase();
  return ["blocked", "failed", "rejected"].includes(status) ||
    /(?:^blocked_|_blocked$|_unavailable$|_not_prepared$|_not_ready$|_mismatch$|_failed$|_canceled$|_timed_out$|_rejected$|_requires_explicit_request$)/.test(status);
}

function toolResultOutcome(value) {
  const status = String(value?.status || "").toLowerCase();
  return status === "failed" ? "failed" : "blocked";
}

function authorizeIntegrationSubjectAccess(value, expected) {
  return value?.accessMode === "integration_subject" &&
    value.taskId === expected.taskId &&
    value.toolPolicyRef === expected.toolPolicyRef &&
    value.triggerEventId === expected.triggerEventId
    ? { status: "allowed", reason: "frozen_trigger_subject_grant" }
    : { status: "blocked", reason: "trigger_subject_grant_mismatch" };
}

function authorizeSubjectToolCall(toolCall, operation, policyRef, taskDefinition) {
  const expected = SUBJECT_TOOL_POLICY.get(operation?.operationId);
  if (!expected || taskDefinition?.toolPolicyRef !== policyRef ||
    toolCall?.toolId !== "fxiaoke-crm-readonly" ||
    toolCall?.operationId !== operation.operationId ||
    toolCall?.name !== expected.name || toolCall?.action !== expected.action ||
    toolCall?.risk !== expected.risk || toolCall?.writebackBoundary !== expected.writebackBoundary ||
    !sameList(toolCall?.scope, expected.scope)) {
    return { status: "blocked", nextGate: "当前调用不符合冻结的 Trigger subject Tool Policy。" };
  }
  return { status: "allowed", reason: "frozen_trigger_subject_tool_policy" };
}

function authorizeMaterialToolCall(toolCall, skillId) {
  if (!MATERIAL_TOOL_NAMES.has(toolCall?.name)) {
    return { status: "blocked", nextGate: "当前 Trigger 只开放只读 workspace 与已挂载 Skill。" };
  }
  if (toolCall.name === "run_mounted_skill" && toolCall.arguments?.skillId !== skillId) {
    return { status: "blocked", nextGate: "当前 Trigger 只能运行任务定义冻结的 mounted Skill。" };
  }
  return { status: "allowed", reason: "trigger_material_tool_policy" };
}

function assertFrozenPolicy({ taskDefinition, triggerEvent }, expected) {
  const snapshot = triggerEvent?.executionSnapshot;
  if (taskDefinition?.skillPolicyRef !== expected.skillPolicyRef ||
    taskDefinition?.toolPolicyRef !== expected.toolPolicyRef ||
    snapshot?.skillPolicyRef !== expected.skillPolicyRef ||
    snapshot?.toolPolicyRef !== expected.toolPolicyRef ||
    snapshot?.taskDefinitionVersion !== taskDefinition?.taskDefinitionVersion ||
    snapshot?.handlerVersion !== taskDefinition?.handlerVersion) {
    throw resourceError("trigger_agent_policy_snapshot_mismatch");
  }
}

function normalizeSubject(value) {
  const objectApiName = reference(value?.objectApiName);
  const objectId = reference(value?.objectId);
  return Object.freeze({ objectApiName, objectId });
}


function sameList(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw resourceError("trigger_agent_resource_reference_invalid");
  }
  return value;
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`Fxiaoke Trigger subject resources require ${method}`);
  }
}

function resourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  RESOURCE_CONTRACT_VERSION as FXIAOKE_TRIGGER_SUBJECT_AGENT_RESOURCES_VERSION,
  createFxiaokeTriggerSubjectAgentResourceBuilder,
};
