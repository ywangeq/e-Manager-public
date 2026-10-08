import crypto from "node:crypto";
import {
  createAppliedModelAssignments,
  modelAssignmentsForEmployee,
  normalizeAppliedModelAssignments,
  primaryModelBindingFromAssignments,
} from "./digital-employee-model-assignments.mjs";
import { normalizeAgentRuntimeId, normalizeRuntimeAdapterId } from "./external-employee-runtime-declaration.mjs";

const CONTRACT_VERSION = "digital-employee-runtime-config.v1";
const SENSITIVE_TEXT = /(?:sk-[a-z0-9_-]{12,}|(?:api|app)[ _-]?(?:key|secret)\s*[:=])/i;

export function createDigitalEmployeeRuntimeConfigService({ aiModelCatalog = [], store } = {}) {
  function withAppliedProfiles(employees = []) {
    const profiles = store.readState().appliedProfiles;
    return employees.map((employee) => projectEmployee(employee, profiles[employee.id]));
  }

  function projectEmployee(employee = {}, profile = null) {
    const assignmentProjection = safeAssignmentsForEmployee(employee, profile);
    const { modelAssignments, modelAssignmentError } = assignmentProjection;
    const modelBinding = primaryModelBindingFromAssignments(modelAssignments, { aiModelCatalog });
    const { modelBinding: _legacyModelBinding, modelAssignments: _legacyModelAssignments, ...employeeWithoutLegacyModelAuthority } = employee;
    if (!profile) {
      return {
        ...employeeWithoutLegacyModelAuthority,
        ...(modelBinding ? { modelBinding } : {}),
        modelAssignments,
        runtimeBinding: normalizeRuntimeBinding(employee.runtimeBinding, employee.id),
        runtimeConfig: {
          contractVersion: CONTRACT_VERSION,
          appliedVersion: 0,
          source: "legacy_projection",
          status: modelAssignmentError ? "model_assignment_invalid" : "applied_legacy_compatibility",
          ...(modelAssignmentError ? { blockingReason: modelAssignmentError } : {}),
        },
      };
    }
    return {
      ...employeeWithoutLegacyModelAuthority,
      ...(modelBinding ? { modelBinding } : {}),
      modelAssignments,
      runtimeBinding: normalizeRuntimeBinding({
        ...(employee.runtimeBinding || {}),
        ...(profile.runtimeBinding || {}),
      }, employee.id),
      runtimeConfig: {
        contractVersion: CONTRACT_VERSION,
        appliedVersion: Number(profile.appliedVersion || 0),
        appliedAt: text(profile.appliedAt),
        appliedBy: text(profile.appliedBy),
        source: text(profile.source || "canonical_runtime_config"),
        status: modelAssignmentError ? "model_assignment_invalid" : "applied",
        ...(modelAssignmentError ? { blockingReason: modelAssignmentError } : {}),
      },
    };
  }

  function submitModelBinding({ employee, modelId, modelLevelId, actor, surface, applyImmediately = false }) {
    return submitRuntimeConfig({ employee, modelId, modelLevelId, actor, surface, applyImmediately });
  }

  function submitRuntimeConfig({ employee, modelId, modelLevelId, assignedRequestTypes, actor, surface, applyImmediately = false }) {
    if (!employee?.id) return invalid("digital_employee_not_found", "数字员工不存在。");
    const model = aiModelCatalog.find((item) => item.id === text(modelId) && Number.isInteger(item.digitalEmployeeMenuOrder));
    if (!model) return invalid("digital_employee_model_invalid", "请选择目录中可用于数字员工的模型。");
    if (!model.supportedLevelIds?.includes(text(modelLevelId)) || text(modelLevelId) === "none") {
      return invalid("digital_employee_reasoning_invalid", "请选择该模型支持的推理强度。");
    }
    const normalizedRequestTypes = assignedRequestTypes === undefined
      ? undefined
      : safeTextList(assignedRequestTypes, 24, 60);
    if (assignedRequestTypes !== undefined && !normalizedRequestTypes?.length) {
      return invalid("digital_employee_request_type_required", "至少保留一种 Request 类型。");
    }
    const state = store.readState();
    const currentProfile = state.appliedProfiles[employee.id];
    const baseAppliedVersion = Number(currentProfile?.appliedVersion || 0);
    const modelAssignments = replacePrimaryAssignment({
      current: assignmentsForEmployee(employee, currentProfile),
      modelId: model.id,
      modelLevelId: text(modelLevelId),
      nextAppliedVersion: baseAppliedVersion + 1,
    });
    const proposedProfile = profileForEmployee(employee, currentProfile, {
      modelAssignments,
      ...(normalizedRequestTypes ? {
        runtimeBinding: { assignedRequestTypes: normalizedRequestTypes },
      } : {}),
    });
    return submitRevision({
      employee,
      proposedProfile,
      actor,
      surface,
      applyImmediately,
      changeSummary: normalizedRequestTypes
        ? `模型调整为 ${model.model} / ${modelLevelId}；Request 类型更新为 ${normalizedRequestTypes.join("、")}`
        : `模型调整为 ${model.model} / ${modelLevelId}`,
    });
  }

  function submitModelAssignments({
    employee,
    items,
    expectedAppliedVersion,
    actor,
    surface,
    applyImmediately = false,
  } = {}) {
    if (!employee?.id) return invalid("digital_employee_not_found", "数字员工不存在。");
    const state = store.readState();
    const currentProfile = state.appliedProfiles[employee.id];
    const currentVersion = Number(currentProfile?.appliedVersion || 0);
    const expectedVersion = Number(expectedAppliedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return invalid("digital_employee_runtime_config_version_invalid", "请刷新后重新提交模型分配。");
    }
    if (expectedVersion !== currentVersion) return versionConflict();
    let modelAssignments;
    try {
      modelAssignments = createAppliedModelAssignments({
        aiModelCatalog,
        appliedVersion: currentVersion + 1,
        items,
      });
    } catch (error) {
      return invalid(error?.code || "digital_employee_model_assignments_invalid", "模型分配未通过目录或角色校验。");
    }
    const proposedProfile = profileForEmployee(employee, currentProfile, { modelAssignments });
    return submitRevision({
      employee,
      proposedProfile,
      actor,
      surface,
      applyImmediately,
      expectedAppliedVersion: expectedVersion,
      changeSummary: `模型分配集更新为 ${modelAssignments.items.length} 项`,
    });
  }

  function applyPrimaryWorkerConfig({ employee, config, actor, surface = "system_worker_overview" }) {
    if (!employee?.id) return invalid("digital_employee_not_found", "Worker 未绑定有效数字员工。");
    const model = aiModelCatalog.find((item) => item.provider === text(config.provider) && item.model === text(config.model));
    if (!model || !model.supportedLevelIds?.includes(text(config.reasoningEffort))) {
      return invalid("system_worker_model_invalid", "请选择当前 Provider 支持的模型和推理强度。");
    }
    const assignedRequestTypes = safeTextList(config.assignedRequestTypes, 24, 60);
    if (!assignedRequestTypes.length) return invalid("digital_employee_request_type_required", "至少保留一种 Request 类型。");
    const state = store.readState();
    const currentProfile = state.appliedProfiles[employee.id];
    const baseAppliedVersion = Number(currentProfile?.appliedVersion || 0);
    const modelAssignments = replacePrimaryAssignment({
      current: assignmentsForEmployee(employee, currentProfile),
      modelId: model.id,
      modelLevelId: text(config.reasoningEffort),
      nextAppliedVersion: baseAppliedVersion + 1,
    });
    const proposedProfile = profileForEmployee(employee, currentProfile, {
      modelAssignments,
      runtimeBinding: {
        provider: text(config.provider),
        preferredProviderRouteId: text(config.preferredProviderRouteId),
        credentialLeasePolicy: safeText(config.credentialPolicy, 360),
        workerLane: text(config.lane || employee.runtimeBinding?.workerLane || `${employee.id}-runtime`),
        workerPoolMode: text(config.workerPoolMode || "runtime_allocated"),
        consumesSharedWorkerQuota: config.consumesSharedWorkerQuota !== false,
        triggerMode: text(config.triggerMode),
        triggerPolicy: safeText(config.triggerPolicy, 360),
        schedule: text(config.schedule),
        maxWorkersPerEmployee: positiveInteger(config.maxWorkersPerEmployee, 1),
        maxParallelWorkers: positiveInteger(config.maxParallelWorkers, 1),
        batchSize: positiveInteger(config.batchSize, 1),
        taskBufferQueueSize: positiveInteger(config.taskBufferQueueSize, 0, 0),
        taskBufferMinutes: positiveInteger(config.taskBufferMinutes, 240),
        taskExecutionTimeoutMinutes: positiveInteger(config.taskExecutionTimeoutMinutes, 60),
        assignedRequestTypes,
      },
    });
    if (containsInvalidText(proposedProfile)) {
      return invalid("digital_employee_runtime_config_invalid", "运行配置不能包含密钥格式或超长内容。");
    }
    return submitRevision({
      employee,
      proposedProfile,
      actor,
      surface,
      applyImmediately: true,
      changeSummary: `管理员从 Worker 总览应用 ${model.model} / ${config.reasoningEffort} 及队列配置`,
    });
  }

  function submitRevision({ employee, proposedProfile, actor, surface, applyImmediately, changeSummary, expectedAppliedVersion }) {
    const state = store.readState();
    const current = state.appliedProfiles[employee.id];
    const baseAppliedVersion = Number(current?.appliedVersion || 0);
    if (expectedAppliedVersion !== undefined && Number(expectedAppliedVersion) !== baseAppliedVersion) {
      return versionConflict();
    }
    const now = new Date().toISOString();
    const revision = {
      id: `DERC-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      contractVersion: CONTRACT_VERSION,
      employeeId: text(employee.id),
      employeeName: text(employee.name || employee.id),
      baseAppliedVersion,
      status: applyImmediately ? "applied" : "pending_review",
      sourceSurface: text(surface),
      changeSummary: safeText(changeSummary, 240),
      proposedProfile,
      submittedAt: now,
      submittedBy: text(actor),
      ...(applyImmediately ? { decidedAt: now, decidedBy: text(actor), decision: "approved" } : {}),
    };
    if (!applyImmediately) {
      const saved = store.saveRevision(revision);
      return saved.ok ? { ok: true, status: revision.status, revision } : saved;
    }
    const profile = appliedProfile(canonicalProfile(proposedProfile, baseAppliedVersion + 1), baseAppliedVersion + 1, actor, surface, now);
    const saved = store.saveAppliedRevision(revision, profile);
    return saved.ok ? { ok: true, status: "applied", revision, profile } : saved;
  }

  function decideRevision({ revisionId, decision, actor, expectedBaseVersion }) {
    const state = store.readState();
    const revision = state.revisions.find((item) => item.id === revisionId);
    if (!revision) return invalid("digital_employee_runtime_config_revision_not_found", "运行配置变更不存在。");
    if (revision.status !== "pending_review") return invalid("digital_employee_runtime_config_revision_decided", "运行配置变更已经处理。");
    const currentVersion = Number(state.appliedProfiles[revision.employeeId]?.appliedVersion || 0);
    const expected = expectedBaseVersion === undefined ? Number(revision.baseAppliedVersion || 0) : Number(expectedBaseVersion);
    if (currentVersion !== expected || currentVersion !== Number(revision.baseAppliedVersion || 0)) {
      return { ok: false, statusCode: 409, error: "digital_employee_runtime_config_version_conflict", message: "生效配置已经变化，请刷新后重新提交。" };
    }
    if (!new Set(["approved", "rejected"]).has(decision)) {
      return invalid("digital_employee_runtime_config_decision_required", "请选择通过或驳回。");
    }
    const now = new Date().toISOString();
    const decidedRevision = {
      ...revision,
      status: decision === "approved" ? "applied" : "rejected",
      decision,
      decidedAt: now,
      decidedBy: text(actor),
    };
    const profile = decision === "approved"
      ? appliedProfile(canonicalProfile(revision.proposedProfile, currentVersion + 1), currentVersion + 1, actor, revision.sourceSurface, now)
      : null;
    const saved = profile
      ? store.saveAppliedRevision(decidedRevision, profile)
      : store.saveRevisionDecision(decidedRevision);
    return saved.ok ? { ok: true, status: decidedRevision.status, revision: decidedRevision, profile } : saved;
  }

  function revisionsForEmployee(employeeId) {
    return store.readState().revisions
      .filter((revision) => !employeeId || revision.employeeId === employeeId)
      .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
  }

  return {
    applyPrimaryWorkerConfig,
    decideRevision,
    revisionsForEmployee,
    submitModelBinding,
    submitModelAssignments,
    submitRuntimeConfig,
    withAppliedProfiles,
  };

  function assignmentsForEmployee(employee = {}, profile = null) {
    if (profile?.modelAssignments) {
      return normalizeAppliedModelAssignments(profile.modelAssignments, { aiModelCatalog });
    }
    return modelAssignmentsForEmployee({
      modelBinding: {
        ...(employee.modelBinding || {}),
        ...(profile?.modelBinding || {}),
      },
    }, { aiModelCatalog });
  }

  function safeAssignmentsForEmployee(employee = {}, profile = null) {
    try {
      return { modelAssignments: assignmentsForEmployee(employee, profile), modelAssignmentError: "" };
    } catch (error) {
      return {
        modelAssignments: createAppliedModelAssignments({
          aiModelCatalog,
          appliedVersion: Number(profile?.appliedVersion || 0),
          items: [],
          source: profile ? "canonical_runtime_config" : "legacy_model_binding_projection",
        }),
        modelAssignmentError: text(error?.code || "digital_employee_model_assignments_invalid"),
      };
    }
  }

  function profileForEmployee(employee = {}, currentProfile = null, patch = {}) {
    return {
      employeeId: text(employee.id),
      modelAssignments: patch.modelAssignments || assignmentsForEmployee(employee, currentProfile),
      runtimeBinding: normalizeRuntimeBinding({
        ...(employee.runtimeBinding || {}),
        ...(currentProfile?.runtimeBinding || {}),
        ...(patch.runtimeBinding || {}),
      }, employee.id),
    };
  }

  function replacePrimaryAssignment({ current, modelId, modelLevelId, nextAppliedVersion }) {
    const requestedItems = [];
    let targetFound = false;
    for (const item of current.items) {
      const matchesTarget = item.modelId === modelId && item.modelLevelId === modelLevelId;
      if (item.roles.primary && !matchesTarget && !item.roles.taskDefinitionIds.length) continue;
      const primary = matchesTarget;
      if (primary) targetFound = true;
      requestedItems.push({
        assignmentId: item.assignmentId,
        modelId: item.modelId,
        modelLevelId: item.modelLevelId,
        roles: { primary, taskDefinitionIds: item.roles.taskDefinitionIds },
      });
    }
    if (!targetFound) {
      requestedItems.push({
        assignmentId: `model-assignment-${crypto.randomUUID()}`,
        modelId,
        modelLevelId,
        roles: { primary: true, taskDefinitionIds: [] },
      });
    }
    return createAppliedModelAssignments({
      aiModelCatalog,
      appliedVersion: nextAppliedVersion,
      items: requestedItems,
    });
  }

  function canonicalProfile(profile = {}, appliedVersion) {
    let assignments;
    if (profile.modelAssignments) {
      const current = normalizeAppliedModelAssignments(profile.modelAssignments, { aiModelCatalog });
      assignments = createAppliedModelAssignments({
        aiModelCatalog,
        appliedVersion,
        items: current.items.map(requestedAssignment),
      });
    } else {
      const legacy = modelAssignmentsForEmployee({ modelBinding: profile.modelBinding }, { aiModelCatalog });
      assignments = createAppliedModelAssignments({
        aiModelCatalog,
        appliedVersion,
        items: legacy.items.map(requestedAssignment),
      });
    }
    return {
      employeeId: text(profile.employeeId),
      modelAssignments: assignments,
      runtimeBinding: normalizeRuntimeBinding(profile.runtimeBinding, profile.employeeId),
    };
  }
}

function normalizeRuntimeBinding(binding = {}, employeeId = "") {
  return {
    ...binding,
    runtimeAdapter: normalizeRuntimeAdapterId(binding.runtimeAdapter || "responses_api"),
    agentRuntimeId: normalizeAgentRuntimeId(binding.agentRuntimeId || (employeeId ? `${employeeId}-runtime` : "")),
  };
}

function appliedProfile(profile, appliedVersion, actor, source, appliedAt) {
  return {
    ...profile,
    appliedVersion,
    appliedAt,
    appliedBy: text(actor),
    source: text(source || "canonical_runtime_config"),
  };
}

function requestedAssignment(item) {
  return {
    assignmentId: item.assignmentId,
    modelId: item.modelId,
    modelLevelId: item.modelLevelId,
    roles: item.roles,
  };
}

function versionConflict() {
  return {
    ok: false,
    statusCode: 409,
    error: "digital_employee_runtime_config_version_conflict",
    message: "生效配置已经变化，请刷新后重新提交。",
  };
}

function positiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function safeText(value, limit) {
  const normalized = text(value);
  if (normalized.length > limit || SENSITIVE_TEXT.test(normalized)) return "";
  return normalized;
}

function safeTextList(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => safeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function containsInvalidText(profile = {}) {
  return [profile.runtimeBinding?.credentialLeasePolicy, profile.runtimeBinding?.triggerPolicy].some((value) => SENSITIVE_TEXT.test(text(value)));
}

function invalid(error, message) {
  return { ok: false, statusCode: 422, error, ...(message ? { message } : {}) };
}

function text(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, "");
}
