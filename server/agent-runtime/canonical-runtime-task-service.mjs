import crypto from "node:crypto";
import { createRuntimeTaskSubmissionProjector } from "./runtime-task-submission-projector.mjs";
import {
  createTaskMaterialBindingSet,
  normalizeMaterialBindingDescriptors,
  taskMaterialBindingSetDescriptorDigest,
} from "./task-material-binding.mjs";
import { DEFAULT_PROVIDER_TIMEOUT_POLICY, constrainProviderTimeoutPolicy, normalizeProviderTimeoutPolicy } from "./provider-timeout-policy.mjs";
import { projectSafeAgentRuntimeEvidence } from "./runtime-safe-activity-projector.mjs";
import { projectSafeRuntimeProvenance } from "./runtime-safe-provenance-projector.mjs";
import { RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION } from "./runtime-safe-activity-contract-v1.mjs";
import { projectRuntimeToolEfficiency } from "./runtime-tool-efficiency-contract-v1.mjs";
import {
  normalizeExcludedTaskTypes,
  normalizeRuntimeTaskQueueReorderRequest,
  projectCurrentUserRuntimeTaskPage,
} from "./current-user-runtime-task-queue-contract-v1.mjs";
import {
  createRuntimeTaskFeedbackDiagnosticChain,
  RUNTIME_TASK_FEEDBACK_DIAGNOSTIC_CHAIN_CONTRACT_VERSION,
} from "./runtime-task-feedback-diagnostic-chain.mjs";

const PUBLIC_TASK_CONTRACT_VERSION = "digital-employee-runtime-task.v2";
const TERMINAL_STATUSES = new Set(["blocked", "canceled", "completed", "failed", "lost", "rejected", "timed_out"]);

function createCanonicalRuntimeTaskService({
  executionTaskRepository,
  admissionRepository = null,
  feedbackStore = null,
  materialBindingRepository = null,
  qualityEventStore = null,
  resolveActorRoute,
  resolveEmployeeIdentity = defaultEmployeeIdentity,
  routeVerifier,
  workerPump,
  providerTimeoutPolicy = DEFAULT_PROVIDER_TIMEOUT_POLICY,
  resolveProviderTimeoutPolicy = null,
  now = () => new Date().toISOString(),
} = {}) {
  assertDependencies({ executionTaskRepository, resolveActorRoute, routeVerifier, workerPump });
  const governedProviderTimeoutPolicy = normalizeProviderTimeoutPolicy(providerTimeoutPolicy);
  const resolveGovernedProviderTimeoutPolicy = typeof resolveProviderTimeoutPolicy === "function"
    ? resolveProviderTimeoutPolicy
    : () => governedProviderTimeoutPolicy;
  const projector = createRuntimeTaskSubmissionProjector({
    defaultProviderTimeoutPolicy: governedProviderTimeoutPolicy,
    verifyRoute: routeVerifier,
  });
  const activeOwnership = new Map();

  function employeeIdentity(employeeId = "") {
    const identity = resolveEmployeeIdentity(employeeId);
    const canonicalEmployeeId = String(identity?.canonicalEmployeeId || "").trim();
    const readEmployeeIds = Array.from(new Set(Array.isArray(identity?.readEmployeeIds) ? identity.readEmployeeIds : []));
    if (!canonicalEmployeeId || !readEmployeeIds.length || !readEmployeeIds.includes(canonicalEmployeeId)) {
      throw serviceError("digital_employee_identity_resolution_invalid");
    }
    return Object.freeze({ canonicalEmployeeId, readEmployeeIds: Object.freeze(readEmployeeIds) });
  }

  function projectCanonicalTask(task, options = {}) {
    if (!task) return null;
    return projectTask(task, {
      ...options,
      employeeId: employeeIdentity(task.employeeId).canonicalEmployeeId,
    });
  }

  function createConversationTask({
    actorLocator,
    employee = {},
    executionInput,
    requestId,
    route,
    sourceSystemId,
    taskType = "digital_employee_chat",
    permissionDigest,
    materialBinding = null,
    materialBindings = [],
    beforeWorkerWake = null,
    commitSubmission = null,
    taskExecutionMaxMs = null,
  } = {}) {
    if (!Array.isArray(materialBindings)) throw serviceError("task_material_binding_set_invalid");
    if (materialBinding !== null && materialBindings.length) throw serviceError("task_material_binding_set_invalid");
    if (beforeWorkerWake !== null && typeof beforeWorkerWake !== "function") {
      throw serviceError("runtime_task_before_worker_wake_invalid");
    }
    const materialBindingDescriptors = (materialBindings.length || materialBinding !== null)
      ? normalizeMaterialBindingDescriptors(materialBindings.length ? materialBindings : [materialBinding])
      : [];
    const taskProviderTimeoutPolicy = constrainProviderTimeoutPolicy(resolveGovernedProviderTimeoutPolicy({ employee }), taskExecutionMaxMs);
    const submission = projector.project({
      employeeVersion: employee.version,
      requestId,
      route,
      materialBindingsDigest: materialBindingDescriptors.length
        ? taskMaterialBindingSetDescriptorDigest(materialBindingDescriptors)
        : null,
      sessionId: executionInput?.session?.sessionId,
      sourceSystemId,
      taskType,
      transcriptEntry: executionInput?.entry,
    }, { providerTimeoutPolicy: taskProviderTimeoutPolicy });
    if (materialBindingDescriptors.length) {
      executionTaskRepository.assertSubmissionCompatible?.(submission);
      if (!materialBindingRepository?.saveSetOrGet) throw serviceError("task_material_binding_repository_unavailable");
      materialBindingRepository.saveSetOrGet(createTaskMaterialBindingSet({
        descriptors: materialBindingDescriptors,
        routeDigest: route.routeDigest,
        submission,
        transcriptEntryId: executionInput?.entry?.entryId,
      }));
    }
    executionTaskRepository.prepareSubmission?.(submission);
    if (admissionRepository) {
      admissionRepository.saveOrGet({
        contractVersion: "execution-admission.v1",
        taskId: submission.taskId,
        actorLocator,
        routeBinding: {
          tenantScope: submission.tenantScope,
          routeDigest: route.routeDigest,
          actorIssuer: submission.actorIssuer,
          actorSubjectDigest: submission.actorSubjectDigest,
          employeeId: submission.employeeId,
          sessionId: submission.sessionId,
          entryId: submission.executionInputRef.refId,
        },
        employeeVersion: submission.employeeVersion,
        channelId: submission.channelId,
        permissionDigest,
        createdAt: submission.createdAt,
        expiresAt: new Date(Date.parse(submission.createdAt) + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    if (commitSubmission !== null && typeof commitSubmission !== "function") throw serviceError("runtime_task_submission_commit_invalid");
    const result = commitSubmission ? commitSubmission(submission) : executionTaskRepository.submitOrGet(submission);
    if (!result?.task) throw serviceError("runtime_task_submission_fenced");
    beforeWorkerWake?.(result.task);
    workerPump.wake?.();
    return projectTask(result.task, { employeeName: employee.name || employee.displayName });
  }

  function readExecutionAdmission(taskId) {
    return admissionRepository?.get?.(taskId) || null;
  }

  function readCanonicalExecutionTask(taskId, { tenantScope = "" } = {}) {
    return executionTaskRepository.get?.(taskId, { tenantScope }) || null;
  }

  function readTaskMaterialBinding(taskId, { tenantScope = "" } = {}) {
    return materialBindingRepository?.get?.(taskId, { tenantScope }) || null;
  }

  function readTaskMaterialBindings(taskId, { tenantScope = "" } = {}) {
    return materialBindingRepository?.getSet?.(taskId, { tenantScope })?.bindings || [];
  }

  function findRecentCompletedMaterialSource({ route, sessionId } = {}) {
    if (!materialBindingRepository?.listRecent || !executionTaskRepository?.get) return null;
    const identity = employeeIdentity(route?.employeeId);
    const candidates = materialBindingRepository.listRecent({
      actorIssuer: route?.actorIssuer,
      actorSubjectDigest: route?.actorSubjectDigest,
      channelId: route?.channelId,
      employeeIds: identity.readEmployeeIds,
      sessionId,
      tenantScope: route?.tenantScope,
    });
    for (const bindingSet of candidates) {
      const binding = bindingSet.bindings[0];
      const task = executionTaskRepository.get(binding?.taskId, { tenantScope: binding?.tenantScope });
      if (bindingSet.bindings.length === 1 && task?.status === "completed" && task.actorIssuer === binding.actorIssuer &&
        task.actorSubjectDigest === binding.actorSubjectDigest && identity.readEmployeeIds.includes(task.employeeId) &&
        identity.readEmployeeIds.includes(binding.employeeId) &&
        task.sessionId === binding.sessionId && task.channelId === binding.channelId) {
        return binding;
      }
    }
    return null;
  }

  async function runConversationTask(task, run) {
    if (!task?.id) throw serviceError("runtime_task_required");
    const result = await workerPump.execute(task.id, async (ownership) => {
      activeOwnership.set(task.id, ownership);
      try {
        const value = await run(ownership);
        return {
          ...value,
          settlement: settlementFromAgentValue(value),
        };
      } finally {
        if (activeOwnership.get(task.id) === ownership) activeOwnership.delete(task.id);
      }
    });
    if (result.task?.status === "canceled") throw serviceError("agent_turn_canceled");
    if (result.task?.status === "timed_out") throw serviceError(result.task.lastErrorCode || "task_execution_timeout");
    if (result.ownershipLost) throw serviceError("runtime_task_settlement_fenced");
    if (result.task?.status === "failed" && result.value === null) throw serviceError("runtime_task_worker_execution_failed");
    return Object.freeze({
      settled: result.settled,
      task: projectCanonicalTask(result.task),
      value: result.value,
    });
  }

  async function waitForConversationTask(task, { onEvent = null, timeoutMs = 120_000 } = {}) {
    if (!task?.id) throw serviceError("runtime_task_required");
    const canonical = await workerPump.waitForTerminal(task.id, { onEvent, timeoutMs });
    if (canonical.status === "canceled") throw serviceError("agent_turn_canceled");
    if (canonical.status !== "completed") throw serviceError(canonical.lastErrorCode || `runtime_task_${canonical.status}`);
    return projectCanonicalTask(canonical);
  }

  function listTasks(employeeId = "", { actor = null, includeAll = true, limit = 500, offset = 0, order = "queue" } = {}) {
    const identity = employeeIdentity(employeeId);
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: identity.canonicalEmployeeId });
    const taskRows = executionTaskRepository.list({
      tenantScope: route.tenantScope,
      employeeIds: identity.readEmployeeIds,
      limit: includeAll ? limit : 500,
      offset: includeAll ? offset : 0,
      order,
    }).filter((task) => includeAll || task.actorIssuer === route.actorIssuer && task.actorSubjectDigest === route.actorSubjectDigest);
    const visibleTaskRows = includeAll ? taskRows : taskRows.slice(offset, offset + limit);
    return visibleTaskRows
      .map((task) => projectCanonicalTask(task, { feedback: feedbackForTask(task.taskId) }));
  }

  function listCurrentUserTasks({ actor = null, employees = [], limit = 100, excludedTaskTypes = [] } = {}) {
    excludedTaskTypes = normalizeExcludedTaskTypes(excludedTaskTypes);
    if (!Array.isArray(employees) || employees.length === 0) {
      return projectCurrentUserRuntimeTaskPage({
        tasks: [],
        employeeDirectory: [],
        projectTask: () => null,
      });
    }
    const context = currentUserTaskContext(actor, employees);
    const active = executionTaskRepository.listByActor({
      ...context.actorIdentity,
      employeeIds: context.physicalEmployeeIds,
      statuses: ["queued", "running", "waiting"],
      order: "queue",
      limit: 500,
    });
    const history = executionTaskRepository.listByActor({
      ...context.actorIdentity,
      employeeIds: context.physicalEmployeeIds,
      statuses: Array.from(TERMINAL_STATUSES),
      excludedTaskTypes,
      order: "recent",
      limit: Math.max(1, Math.min(200, Number(limit) || 100)),
    });
    const tasks = [...active, ...history].map((task) => mapCurrentUserTaskEmployee(task, context));
    assertActiveEmployeeAliasesStable(tasks);
    return projectCurrentUserRuntimeTaskPage({
      tasks,
      employeeDirectory: context.employees,
      projectTask: (task, employee) => projectTask(task, {
        employeeId: employee.id,
        employeeName: employee.name,
        feedback: feedbackForTask(task.taskId),
      }),
      queueSnapshotComplete: active.length < 500,
      excludedTaskTypes,
    });
  }

  function reorderCurrentUserQueue({ actor = null, employees = [], request, excludedTaskTypes = [] } = {}) {
    excludedTaskTypes = normalizeExcludedTaskTypes(excludedTaskTypes);
    const normalized = normalizeRuntimeTaskQueueReorderRequest(request);
    if (!Array.isArray(employees) || employees.length === 0) {
      throw serviceError("runtime_task_queue_employee_not_found");
    }
    const context = currentUserTaskContext(actor, employees);
    const employee = context.employees.find((item) => item.id === normalized.employeeId);
    if (!employee) throw serviceError("runtime_task_queue_employee_not_found");
    const physicalIds = context.physicalIdsByCanonical.get(employee.id) || [];
    const queued = executionTaskRepository.listByActor({
      ...context.actorIdentity,
      employeeIds: physicalIds,
      statuses: ["queued"],
      order: "queue",
      limit: 101,
    });
    if (queued.length > 100) throw serviceError("runtime_task_queue_lane_too_large");
    if (queued.some(task => excludedTaskTypes.includes(task.taskType))) throw serviceError("runtime_task_queue_set_conflict");
    const activePhysicalIds = new Set(queued.map((task) => task.employeeId));
    if (activePhysicalIds.size !== 1) throw serviceError("runtime_task_queue_employee_identity_conflict");
    const result = executionTaskRepository.reorderQueuedByActor({
      ...context.actorIdentity,
      employeeIds: physicalIds,
      expectedRevision: normalized.expectedRevision,
      orderedTaskIds: normalized.orderedTaskIds,
    });
    if (result.changed) workerPump.wake?.();
    return listCurrentUserTasks({ actor, employees, excludedTaskTypes });
  }

  function currentUserTaskContext(actor, employees) {
    if (!Array.isArray(employees) || employees.length === 0) {
      throw serviceError("runtime_task_queue_employee_directory_empty");
    }
    const canonicalEmployees = [];
    const physicalIdsByCanonical = new Map();
    const canonicalByPhysical = new Map();
    let actorIdentity = null;
    for (const employee of employees) {
      const identity = employeeIdentity(employee?.id);
      if (physicalIdsByCanonical.has(identity.canonicalEmployeeId)) continue;
      const route = resolveActorRoute({
        actor,
        channelId: "desktop",
        employeeId: identity.canonicalEmployeeId,
      });
      const nextActorIdentity = {
        tenantScope: route.tenantScope,
        actorIssuer: route.actorIssuer,
        actorSubjectDigest: route.actorSubjectDigest,
      };
      if (actorIdentity && Object.keys(actorIdentity).some((key) =>
        actorIdentity[key] !== nextActorIdentity[key])) {
        throw serviceError("runtime_task_queue_actor_identity_drift");
      }
      actorIdentity ||= nextActorIdentity;
      const employeeName = String(employee.name || employee.displayName || "").trim();
      const safeEmployee = Object.freeze({
        id: identity.canonicalEmployeeId,
        name: employeeName || identity.canonicalEmployeeId,
        version: String(employee.version || "").trim(),
      });
      canonicalEmployees.push(safeEmployee);
      physicalIdsByCanonical.set(safeEmployee.id, identity.readEmployeeIds);
      for (const physicalId of identity.readEmployeeIds) {
        const previous = canonicalByPhysical.get(physicalId);
        if (previous && previous !== safeEmployee.id) {
          throw serviceError("runtime_task_queue_employee_identity_conflict");
        }
        canonicalByPhysical.set(physicalId, safeEmployee.id);
      }
    }
    return {
      actorIdentity,
      canonicalByPhysical,
      employees: canonicalEmployees,
      physicalEmployeeIds: Array.from(canonicalByPhysical.keys()),
      physicalIdsByCanonical,
    };
  }

  function mapCurrentUserTaskEmployee(task, context) {
    const canonicalEmployeeId = context.canonicalByPhysical.get(task.employeeId);
    if (!canonicalEmployeeId) throw serviceError("runtime_task_queue_employee_mismatch");
    return Object.freeze({ ...task, employeeId: canonicalEmployeeId, physicalEmployeeId: task.employeeId });
  }

  function assertActiveEmployeeAliasesStable(tasks) {
    const physicalIdsByCanonical = new Map();
    for (const task of tasks.filter((item) => ["queued", "running", "waiting"].includes(item.status))) {
      const ids = physicalIdsByCanonical.get(task.employeeId) || new Set();
      ids.add(task.physicalEmployeeId);
      physicalIdsByCanonical.set(task.employeeId, ids);
    }
    if (Array.from(physicalIdsByCanonical.values()).some((ids) => ids.size > 1)) {
      throw serviceError("runtime_task_queue_employee_identity_conflict");
    }
  }

  function findTask(employeeId = "", taskId = "", { actor = null } = {}) {
    const identity = employeeIdentity(employeeId);
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: identity.canonicalEmployeeId });
    const task = executionTaskRepository.get(taskId, { tenantScope: route.tenantScope });
    return identity.readEmployeeIds.includes(task?.employeeId) ? projectCanonicalTask(task, { feedback: feedbackForTask(task.taskId) }) : null;
  }

  function readTaskEvents({
    actor = null,
    employeeId = "",
    taskId = "",
    afterSeq = 0,
    limit = 100,
    includeAll = false,
  } = {}) {
    const identity = employeeIdentity(employeeId);
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: identity.canonicalEmployeeId });
    const task = executionTaskRepository.get(taskId, { tenantScope: route.tenantScope });
    if (!task || !identity.readEmployeeIds.includes(task.employeeId)) throw serviceError("runtime_task_not_found");
    if (!includeAll && (task.actorIssuer !== route.actorIssuer || task.actorSubjectDigest !== route.actorSubjectDigest)) {
      throw serviceError("runtime_task_not_found");
    }
    const page = executionTaskRepository.listEvents({
      tenantScope: route.tenantScope,
      taskId,
      afterSeq,
      limit,
    });
    return Object.freeze({
      contractVersion: "digital-employee-task-events.v1",
      task: projectCanonicalTask(task),
      events: page.events,
      nextAfterSeq: page.nextAfterSeq,
      latestSeq: page.latestSeq,
      minAvailableSeq: page.minAvailableSeq,
      terminal: page.terminal,
      hasMore: page.hasMore,
      resetRequired: page.resetRequired,
    });
  }

  function readTaskResultReference({ actor = null, employeeId = "", taskId = "" } = {}) {
    const identity = employeeIdentity(employeeId);
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: identity.canonicalEmployeeId });
    const task = executionTaskRepository.get(taskId, { tenantScope: route.tenantScope });
    if (!task || !identity.readEmployeeIds.includes(task.employeeId) ||
      task.actorIssuer !== route.actorIssuer || task.actorSubjectDigest !== route.actorSubjectDigest) {
      throw serviceError("runtime_task_not_found");
    }
    if (task.status !== "completed" || !task.sessionId || !executionTaskRepository.hasResultAvailable({
      tenantScope: route.tenantScope,
      taskId,
    })) throw serviceError("runtime_task_result_not_available");
    return Object.freeze({
      actorIssuer: task.actorIssuer,
      actorSubjectDigest: task.actorSubjectDigest,
      channelId: task.channelId,
      employeeId: identity.canonicalEmployeeId,
      executionEmployeeId: task.employeeId,
      sessionId: task.sessionId,
      status: task.status,
      taskId: task.taskId,
    });
  }

  function cancelTask({ actor = {}, employeeId = "", reasonCode = "operator_requested", taskId = "" } = {}) {
    const identity = employeeIdentity(employeeId);
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: identity.canonicalEmployeeId });
    const current = executionTaskRepository.get(taskId, { tenantScope: route.tenantScope });
    if (!current || !identity.readEmployeeIds.includes(current.employeeId)) return failure(404, "runtime_task_not_found", "未找到该数字员工任务。");
    if (current.status === "canceled") return success("runtime_task_already_canceled", projectCanonicalTask(current), "任务已经取消。");
    const normalizedReason = ["operator_requested", "stale_task", "wrong_input", "resource_reclaimed"].includes(reasonCode)
      ? reasonCode
      : "operator_requested";
    // Abort while the task still owns its live lease. Operation-specific abort
    // listeners use that exact fence to close in-flight dispatches before the
    // canonical cancellation clears the lease.
    workerPump.abortTask(taskId);
    const result = executionTaskRepository.cancel({
      tenantScope: route.tenantScope,
      taskId,
      reasonCode: normalizedReason,
    });
    if (!result.changed) return failure(409, "runtime_task_not_cancelable", "只有排队、等待或运行中的任务可以取消。", projectCanonicalTask(result.task));
    return success("runtime_task_canceled", projectCanonicalTask(result.task), "任务已取消，运行器将在最近的安全边界停止。");
  }

  function isCancellationRequested(task = null) {
    if (!task?.id) return false;
    if (activeOwnership.get(task.id)?.isCancellationRequested?.()) return true;
    const route = resolveActorRoute({ actor: null, channelId: task.trigger?.channel || "management_console", employeeId: task.employeeId });
    return executionTaskRepository.get(task.id, { tenantScope: route.tenantScope })?.status === "canceled";
  }

  function isTaskOwnedBy(task = null, actor = {}) {
    if (!task?.id) return false;
    const route = resolveActorRoute({ actor, channelId: "management_console", employeeId: task.employeeId });
    const canonical = executionTaskRepository.get(task.id, { tenantScope: route.tenantScope });
    return canonical?.actorIssuer === route.actorIssuer && canonical?.actorSubjectDigest === route.actorSubjectDigest;
  }

  function submitFeedback({
    actor = {},
    employee = {},
    expectedRevision = null,
    idempotencyKey = "",
    rating = "",
    reasonCode = "",
    sourceChannel = "management_console",
    taskId = "",
  } = {}) {
    const identity = employeeIdentity(employee.id);
    const route = resolveActorRoute({ actor, channelId: sourceChannel, employeeId: employee.id });
    const current = executionTaskRepository.get(taskId, { tenantScope: route.tenantScope });
    if (!current || !identity.readEmployeeIds.includes(current.employeeId)) {
      return failure(404, "runtime_task_not_found", "未找到该数字员工任务。");
    }
    const task = projectCanonicalTask(current);
    if (task.status !== "completed") return failure(409, "runtime_task_feedback_not_ready", "只有已完成的任务可以记录回答质量反馈。", task);
    if (!["helpful", "not_helpful"].includes(rating)) return failure(422, "invalid_runtime_task_feedback_rating", "反馈只能是 helpful 或 not_helpful。", task);
    if (typeof feedbackStore?.readCardFeedback !== "function" || typeof feedbackStore?.saveCardFeedback !== "function") {
      return failure(503, "runtime_task_feedback_store_unavailable", "任务反馈暂不可用，请稍后重试。", task);
    }
    const normalizedReasonCode = ["not_resolved", "missing_context", "needs_human_review", "other"].includes(reasonCode)
      ? reasonCode
      : "";
    if (reasonCode && !normalizedReasonCode) {
      return failure(422, "invalid_runtime_task_feedback_reason", "任务反馈原因无效。", task);
    }
    const normalizedExpectedRevision = optionalPositiveInteger(expectedRevision);
    if (expectedRevision !== null && expectedRevision !== undefined && !normalizedExpectedRevision) {
      return failure(422, "invalid_runtime_task_feedback_revision", "任务反馈版本无效。", task);
    }
    if (normalizedExpectedRevision && normalizedExpectedRevision !== current.revision) {
      return failure(409, "runtime_task_feedback_revision_conflict", "任务状态已经变化，请刷新后重试。", task);
    }
    const clientIdempotencyKey = optionalFeedbackIdempotencyKey(idempotencyKey);
    if (idempotencyKey && !clientIdempotencyKey) {
      return failure(422, "invalid_runtime_task_feedback_idempotency_key", "任务反馈幂等键无效。", task);
    }
    const answerId = `ans-${digest(task.id).slice(0, 16)}`;
    const duplicate = feedbackStore?.readCardFeedback?.().find((item) => item.answerId === answerId && item.operatorIdDigest === route.actorSubjectDigest);
    const effectiveIdempotencyKey = clientIdempotencyKey || digest(`${answerId}:${route.actorSubjectDigest}:${rating}:${normalizedReasonCode}`);
    if (duplicate) {
      const exactReplay = duplicate.rating === rating && duplicate.reasonCode === normalizedReasonCode &&
        duplicate.idempotencyKey === effectiveIdempotencyKey;
      if (!exactReplay) return failure(409, "runtime_task_feedback_conflict", "该任务已经记录了另一条反馈。", projectCanonicalTask(current, { feedback: feedbackForTask(taskId) }));
      return {
        ...success("runtime_task_feedback_duplicate", projectCanonicalTask(current, { feedback: feedbackForTask(taskId) }), "已收到这条任务的反馈。"),
        feedback: duplicate,
      };
    }
    const timestamp = now();
    let qualityEvent = null;
    let diagnosticChain = null;
    if (rating === "not_helpful") {
      if (typeof qualityEventStore?.saveQualityEvent !== "function") {
        return failure(503, "runtime_task_feedback_quality_unavailable", "质量闭环暂不可用，请稍后重试。", task);
      }
      diagnosticChain = createFeedbackDiagnosticChain({ current, task });
      try {
        qualityEvent = qualityEventStore.saveQualityEvent({
          id: `QEFDBK-${digest(`${taskId}:${route.actorSubjectDigest}`).slice(0, 20)}`,
          sourceSystemId: task.sourceSystemId,
          sourceEventId: `runtime-task-feedback:${taskId}:${route.actorSubjectDigest}`,
          eventType: "badcase_summary",
          occurredAt: timestamp,
          reportedAt: timestamp,
          entityType: "数字员工",
          entityId: employee.id,
          entityVersion: employee.version,
          severity: "P2",
          status: "待平台质量复盘",
          errorDomain: "user_feedback",
          errorCode: "RUNTIME_TASK_ANSWER_NOT_HELPFUL",
          evidenceSummary: "已完成任务收到负向质量反馈；诊断链只引用 canonical 安全证据。",
          evalCandidate: true,
          reviewGate: "质量治理确认根因和回归候选后入库。",
          diagnosticChain,
          tags: ["runtime-task-feedback", sourceChannel, normalizedReasonCode || "no-reason-code"],
          warnings: ["未保存 Channel 原话、回答原文、raw prompt、模型 trace、Tool payload、命令、路径、凭据或原始异常。"],
          updatedAt: timestamp,
        });
      } catch {
        return failure(503, "runtime_task_feedback_quality_write_failed", "质量闭环暂不可用，请稍后重试。", task);
      }
      if (!qualityEvent?.id || qualityEvent.diagnosticChain?.contractVersion !== RUNTIME_TASK_FEEDBACK_DIAGNOSTIC_CHAIN_CONTRACT_VERSION) {
        return failure(503, "runtime_task_feedback_quality_write_failed", "质量闭环暂不可用，请稍后重试。", task);
      }
    }
    const feedback = feedbackStore?.saveCardFeedback?.({
      id: `FDBK-${digest(`${answerId}:${route.actorSubjectDigest}`).slice(0, 20).toUpperCase()}`,
      contractVersion: "runtime-task-feedback.v1",
      answerId,
      rating,
      employeeId: employee.id,
      employeeVersion: employee.version,
      taskId,
      taskRevision: current.revision,
      operatorIdDigest: route.actorSubjectDigest,
      idempotencyKey: effectiveIdempotencyKey,
      sourceChannel,
      reasonCode: normalizedReasonCode,
      qualityEventId: qualityEvent?.id || "",
      diagnosticChainVersion: diagnosticChain?.contractVersion || "",
      qualityStatus: rating === "not_helpful" ? "pending_quality_review" : "quality_ok",
      receivedAt: timestamp,
      updatedAt: timestamp,
    }) || null;
    if (!feedback) return failure(503, "runtime_task_feedback_store_unavailable", "任务反馈暂不可用，请稍后重试。", task);
    return {
      ...success(
        rating === "not_helpful" ? "runtime_task_feedback_issue_recorded" : "runtime_task_feedback_ok_recorded",
        projectCanonicalTask(current, { feedback: feedbackForTask(taskId) }),
        "已记录任务反馈。",
      ),
      feedback,
    };
  }

  function createFeedbackDiagnosticChain({ current, task }) {
    return createRuntimeTaskFeedbackDiagnosticChain({
      task,
      eventsPage: executionTaskRepository.listEvents({
        tenantScope: current.tenantScope,
        taskId: current.taskId,
        afterSeq: current.eventsPrunedThroughSeq || 0,
        limit: 200,
      }),
      artifacts: executionTaskRepository.listArtifacts?.({
        tenantScope: current.tenantScope,
        taskId: current.taskId,
      }) || [],
      operationReceiptSummary: executionTaskRepository.summarizeOperationReceipts?.({
        tenantScope: current.tenantScope,
        taskId: current.taskId,
      }) || null,
    });
  }

  function feedbackForTask(taskId) {
    const records = feedbackStore?.readCardFeedback?.() || [];
    const feedback = records.find((item) => item.taskId === taskId);
    if (!feedback) return null;
    return {
      contractVersion: feedback.contractVersion,
      sourceChannel: feedback.sourceChannel,
      availability: "available",
      status: feedback.qualityStatus || (feedback.rating === "not_helpful" ? "pending_quality_review" : "quality_ok"),
      rating: feedback.rating,
      qualityEventId: feedback.qualityEventId,
      diagnosticChainVersion: feedback.diagnosticChainVersion,
      receivedAt: feedback.receivedAt,
      updatedAt: feedback.updatedAt,
    };
  }

  return Object.freeze({
    cancelTask,
    createConversationTask,
    findTask,
    findRecentCompletedMaterialSource,
    isCancellationRequested,
    isTaskOwnedBy,
    listCurrentUserTasks,
    listTasks,
    readTaskEvents,
    readTaskResultReference,
    readCanonicalExecutionTask,
    readExecutionAdmission,
    readTaskMaterialBinding,
    readTaskMaterialBindings,
    runConversationTask,
    reorderCurrentUserQueue,
    submitFeedback,
    waitForConversationTask,
  });
}

function settlementFromAgentValue(value) {
  if (value?.settlement) return value.settlement;
  const turn = value?.turnResult || value?.agentTurn || value;
  if (turn?.partial && turn?.reason === "agent_turn_canceled") {
    return { status: "blocked", lastErrorCode: "agent_turn_canceled", resultSummary: "Agent turn stopped at a cancellation boundary." };
  }
  if (turn?.ok === false || turn?.status === "agent_turn_blocked") {
    return { status: "blocked", lastErrorCode: turn?.reason || "agent_turn_blocked", resultSummary: "Agent turn was blocked by runtime policy." };
  }
  return { status: "completed", resultSummary: "Agent turn completed." };
}

function projectTask(task, { employeeId = task?.employeeId || "", employeeName = "", feedback = null } = {}) {
  if (!task) return null;
  const safeAgentRuntime = projectSafeAgentRuntimeEvidence(task.runtimeEvidence, {
    activitySnapshot: task.activitySnapshot,
    activityUpdatedAt: task.activityUpdatedAt,
    taskId: task.taskId,
  });
  const safeSkillProvenance = task.provenanceSource
    ? projectSafeRuntimeProvenance({
      activitySnapshot: task.activitySnapshot,
      sourceSnapshot: task.provenanceSource,
    })
    : null;
  const safeToolLoopEfficiency = task.activitySnapshot || task.toolEfficiencySource
    ? projectRuntimeToolEfficiency({
      activitySnapshot: task.activitySnapshot || {
        contractVersion: RUNTIME_SAFE_ACTIVITY_SNAPSHOT_CONTRACT_VERSION,
        taskId: task.taskId,
        activities: [],
      },
      sourceSnapshot: task.toolEfficiencySource,
      task,
    })
    : null;
  const status = task.status === "timed_out"
    ? "timeout"
    : task.status === "waiting" && ["pending_file_intake", "pending_remote_resource", "pending_invocation_check"].includes(task.waitReasonCode)
      ? task.waitReasonCode
      : task.status;
  return Object.freeze({
    id: task.taskId,
    contractVersion: PUBLIC_TASK_CONTRACT_VERSION,
    revision: task.revision,
    employeeId,
    employeeName,
    employeeVersion: task.employeeVersion || "",
    sourceSystemId: task.sourceSystemId,
    taskType: task.taskType,
    taskTitle: `${employeeName || "数字员工"}执行任务`,
    problemSummary: "任务只保存安全执行引用，不保存用户原话或回复正文。",
    queueLane: "execution_task_v1",
    status,
    statusLabel: taskStatusLabel(status),
    waitReasonCode: task.waitReasonCode || "",
    submittedBy: { id: task.actorSubjectDigest.slice(0, 20), role: "member", identitySource: task.actorIssuer },
    submittedAt: task.createdAt,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt || "",
    completedAt: status === "completed" ? task.finishedAt || "" : "",
    failedAt: ["failed", "lost", "timeout"].includes(status) ? task.finishedAt || "" : "",
    canceledAt: status === "canceled" ? task.finishedAt || "" : "",
    updatedAt: task.updatedAt,
    nextGate: nextGateForTask(task),
    ...(feedback ? { feedback } : {}),
    trigger: { channel: task.channelId, receiveMode: "governed_execution_task", eventType: "task_request" },
    execution: {
      mode: "execution_task_v1_worker",
      status,
      resultSummary: task.resultSummary || "",
      ...(safeAgentRuntime ? { agentRuntime: safeAgentRuntime } : {}),
      ...(safeSkillProvenance ? { skillProvenance: safeSkillProvenance } : {}),
      ...(safeToolLoopEfficiency ? { toolLoopEfficiency: safeToolLoopEfficiency } : {}),
    },
    warnings: ["任务台账不保存用户原话、回复正文、raw prompt、模型 trace、Tool 凭证或执行 payload。"],
  });
}

function nextGateForTask(task) {
  if (task.status === "queued") return task.waitReasonCode === "awaiting_worker" ? "任务已入队，等待 Worker 领取。" : `任务等待：${task.waitReasonCode}。`;
  if (task.status === "waiting") return `任务等待前置条件：${task.waitReasonCode}。`;
  if (task.status === "running") return "Worker 已领取任务，正在执行。";
  if (task.status === "completed") return "任务已完成。";
  if (task.status === "canceled") return "任务已取消；如需继续，请重新提交。";
  if (task.status === "lost") return "Worker 恢复预算已耗尽，需要人工复核。";
  return "任务未完成；请查看安全错误分类。";
}

function taskStatusLabel(status) {
  return ({ queued: "排队中", waiting: "等待中", pending_file_intake: "等待文件", pending_remote_resource: "等待运行资源", pending_invocation_check: "等待调用检查", running: "运行中", completed: "已完成", failed: "已失败", blocked: "已阻断", canceled: "已取消", lost: "已丢失", timeout: "已超时", rejected: "未接收" })[status] || status;
}

function assertDependencies({ executionTaskRepository, resolveActorRoute, routeVerifier, workerPump }) {
  if (!executionTaskRepository || typeof executionTaskRepository.submitOrGet !== "function") throw new TypeError("canonical runtime task service requires executionTaskRepository");
  if (typeof executionTaskRepository.listEvents !== "function") throw new TypeError("canonical runtime task service requires task event reads");
  if (typeof executionTaskRepository.hasResultAvailable !== "function") throw new TypeError("canonical runtime task service requires task result receipts");
  if (typeof executionTaskRepository.listByActor !== "function" ||
    typeof executionTaskRepository.reorderQueuedByActor !== "function") {
    throw new TypeError("canonical runtime task service requires current-user queue authority");
  }
  if (typeof resolveActorRoute !== "function") throw new TypeError("canonical runtime task service requires resolveActorRoute");
  if (typeof routeVerifier !== "function") throw new TypeError("canonical runtime task service requires routeVerifier");
  if (!workerPump || typeof workerPump.execute !== "function" || typeof workerPump.waitForTerminal !== "function" || typeof workerPump.abortTask !== "function") throw new TypeError("canonical runtime task service requires workerPump");
}

function success(status, task, message) {
  return { ok: true, statusCode: 200, status, task, message };
}

function failure(statusCode, error, message, task = null) {
  return { ok: false, statusCode, error, message, ...(task ? { task } : {}) };
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function optionalPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function optionalFeedbackIdempotencyKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(normalized) ? normalized : "";
}

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultEmployeeIdentity(employeeId = "") {
  const normalized = String(employeeId || "").trim();
  return normalized ? { canonicalEmployeeId: normalized, readEmployeeIds: [normalized] } : null;
}

export { PUBLIC_TASK_CONTRACT_VERSION, createCanonicalRuntimeTaskService, projectTask };
