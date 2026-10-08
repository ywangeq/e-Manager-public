import crypto from "node:crypto";
import { configuredEmployeeProviderRouteId } from "../agent-runtime/employee-provider-route.mjs";
import { normalizeModelInputText } from "../agent-runtime/context-assembler.mjs";
import { normalizeRuntimeAdapterId } from "../external-employee-runtime-declaration.mjs";
import { resolveManagedProviderLease } from "../agent-runtime/provider-lease-resolver.mjs";
import { operationReceiptContextForExecutionOwnership } from "../agent-runtime/operation-receipt-context.mjs";
import { managedOpenApiToolInvocationCheck } from "../agent-runtime/managed-openapi-tool-executor.mjs";
import {
  normalizeApprovedToolConfirmation as normalizeToolConfirmation,
  toolConfirmationRequestsFromRuntime,
} from "../agent-runtime/tool-call-confirmation-request.mjs";
import {
  FXIAOKE_CRM_TOOL_ID,
  fxiaokeCrmToolInvocationCheck,
} from "../agent-runtime/fxiaoke-crm-readonly-tool-executor.mjs";
import {
  authorizeWorkspaceMutationApproval,
  workspaceMutationToolContract,
} from "../agent-runtime/workspace-operations-v1.mjs";

const ASSISTANT_EMPLOYEE_ID = "enterprise-ai-copilot";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "medium";

export function desktopMaterialContractsCurrent(items = [], contracts = []) {
  const current = new Map((contracts || []).map((contract) => [
    `${contract.skillId}\0${contract.contractId}\0${contract.contractDigest}`,
    contract,
  ]));
  return (Array.isArray(items) ? items : []).every((item) => {
    const provenance = item?.materialContract;
    if (!provenance) return true;
    const contract = current.get(`${provenance.skillId}\0${provenance.contractId}\0${provenance.contractDigest}`);
    if (!contract) return false;
    const baseName = String(item.name || "").toLowerCase();
    if (contract.transfer === "archive_snapshot") {
      const snapshot = contract.archiveSnapshot;
      return Boolean(
        snapshot &&
        provenance.selectorId === snapshot.snapshotId &&
        baseName === String(snapshot.snapshotFileName || "").toLowerCase()
      );
    }
    const selector = contract.selectors?.find((candidate) => candidate.selectorId === provenance.selectorId);
    return Boolean(selector && selector.exactBaseNames.some((name) => name.toLowerCase() === baseName));
  });
}

export function sanitizeDesktopMaterialContext(value = null, { expectedEmployeeId = "", runtimeReadable = false } = {}) {
  if (!value || value.contractVersion !== "desktop-material-context.v1") return null;
  const authorizedEmployeeId = cleanEmployeeId(value.authorization?.employeeId);
  if (
    value.authorization?.status !== "authorized" ||
    value.authorization?.scope !== "selected_employee_current_turn" ||
    !authorizedEmployeeId ||
    (expectedEmployeeId && authorizedEmployeeId !== cleanEmployeeId(expectedEmployeeId))
  ) return null;
  const manifest = value.manifest;
  if (!manifest || manifest.contractVersion !== "material-manifest.v1") return null;
  const fileCount = boundedInteger(manifest.fileCount, 1, 20);
  const totalBytes = boundedInteger(manifest.totalBytes, 1, 20 * 2 * 1024 * 1024 * 1024);
  const contentDigest = /^sha256:[a-f0-9]{64}$/.test(String(manifest.contentDigest || ""))
    ? String(manifest.contentDigest)
    : "";
  if (!fileCount || !totalBytes || !contentDigest) return null;
  const typeDistribution = {};
  for (const kind of ["image", "document", "archive", "file"]) {
    const count = boundedInteger(manifest.typeDistribution?.[kind], 0, fileCount);
    if (count) typeDistribution[kind] = count;
  }
  return {
    contractVersion: "desktop-material-context.v1",
    status: "prepared_local",
    availability: runtimeReadable ? "center_ephemeral_workspace" : "local_device_only",
    authorization: {
      status: "authorized",
      scope: "selected_employee_current_turn",
      employeeId: authorizedEmployeeId,
    },
    executionRequired: true,
    transferRequired: false,
    runtimeReadable: runtimeReadable === true,
    retention: runtimeReadable ? "ephemeral_workspace_1h" : "local_grant_1h",
    manifest: {
      contractVersion: "material-manifest.v1",
      manifestId: cleanSafeText(manifest.manifestId || "", 120),
      source: "desktop_local_selection",
      status: "prepared_local",
      fileCount,
      totalBytes,
      typeDistribution,
      contentDigest,
      createdAt: cleanSafeText(manifest.createdAt || "", 40),
    },
  };
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return 0;
  return number;
}

function cleanSafeText(value, maxLength) {
  return String(value || "").replace(/[\r\n\0]/g, "").trim().slice(0, maxLength);
}

function credentialEventsFromRuntime(runtime = {}) {
  const events = [];
  for (const call of Array.isArray(runtime.toolCalls) ? runtime.toolCalls : []) {
    const result = call?.result || {};
    const authorizationAction = safeCurrentUserAuthorizationAction(result.authorizationAction);
    if (!result.toolId || (!result.credentialStatus && !authorizationAction)) continue;
    events.push({
      toolId: cleanEmployeeId(result.toolId),
      status: cleanEmployeeId(result.credentialStatus || "authorization_required"),
      clear: result.clearCredential === true,
      ...(authorizationAction ? { authorizationAction } : {}),
    });
  }
  return events;
}

function safeCurrentUserAuthorizationAction(value = null) {
  if (!value || value.contractVersion !== "current-user-tool-authorization-action.v1" || value.kind !== "open_url") return null;
  try {
    const url = new URL(String(value.url || ""));
    const expiresAt = new Date(value.expiresAt);
    if (url.origin !== "https://accounts.feishu.cn" || url.pathname !== "/open-apis/authen/v1/authorize" || url.hash ||
      url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{32,180}$/.test(url.searchParams.get("state") || "") ||
      !/^[A-Za-z0-9_-]{32,180}$/.test(url.searchParams.get("code_challenge") || "") ||
      !Number.isFinite(expiresAt.getTime())) return null;
    return Object.freeze({
      contractVersion: value.contractVersion,
      kind: value.kind,
      label: cleanSafeText(value.label || "前往飞书授权", 80),
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch {
    return null;
  }
}

function safeRuntimeEventSummary(event = null) {
  if (!event) return null;
  return {
    id: event.id,
    contractVersion: event.contractVersion,
    employeeId: event.employeeId,
    eventType: event.eventType,
    outcome: event.outcome,
    taskType: event.taskType,
    sourceSystemId: event.sourceSystemId,
    channelId: event.channelId,
    occurredAt: event.occurredAt,
  };
}

function safeAgentRuntimeExecutionSummary(runtime = {}) {
  return {
    adapter: String(runtime.adapter || "").slice(0, 80),
    status: String(runtime.status || "").slice(0, 80),
    realModelRequested: Boolean(runtime.realModelRequested),
    requestCount: Math.max(0, Number(runtime.requestCount || 0)),
    toolCallCount: Math.max(0, Number(runtime.toolCallCount || 0)),
  };
}

function runtimeTaskAgentEvidence(runtime = {}, lease = {}) {
  const usage = runtime.usage && typeof runtime.usage === "object" ? runtime.usage : {};
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = Number(usage.totalTokens ?? usage.total_tokens);
  return {
    ...safeAgentRuntimeExecutionSummary(runtime),
    mode: runtime.mode || "center_managed_employee_runtime",
    provider: lease.provider || runtime.provider || "",
    model: lease.model || runtime.model || "",
    reasoningEffort: lease.reasoningEffort || runtime.reasoningEffort || "",
    leaseRef: lease.leaseRef || runtime.leaseRef || "",
    usage: {
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : undefined,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : undefined,
    },
  };
}

function resolveRuntimeAdapter(employee = {}) {
  return (
    (cleanEmployeeId(employee.id) === ASSISTANT_EMPLOYEE_ID ? process.env.ENTERPRISE_ASSISTANT_RUNTIME_ADAPTER : "") ||
    normalizeRuntimeAdapterId(employee.runtimeBinding?.runtimeAdapter) ||
    "responses_api"
  );
}

function chunkText(text, size = 96) {
  const chunks = [];
  const value = String(text || "");
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [""];
}

function resolveProviderLease(employee = {}, providerRoute = {}, providerCredential = {}, providerCredentialSecret = null) {
  const model = requestedModel(employee);
  const reasoningEffort = employee.modelBinding?.modelLevelId || process.env.ENTERPRISE_ASSISTANT_REASONING_EFFORT || DEFAULT_REASONING_EFFORT;
  const selected = resolveManagedProviderLease({ employee, providerCredential, providerCredentialSecret, providerRoute });
  if (!selected) return null;

  return {
    authSecret: selected.authSecret,
    baseUrl: selected.baseUrl,
    providerRouteId: selected.providerRouteId,
    providerCredentialId: selected.providerCredentialId,
    workerPoolId: selected.workerPoolId,
    provider: selected.provider || providerRoute.provider || "codex",
    apiProtocol: selected.apiProtocol,
    authMode: selected.authMode,
    upstreamDialect: selected.upstreamDialect,
    compat: selected.compat,
    capabilityProfileVersion: selected.capabilityProfileVersion,
    contextCapability: selected.contextCapability,
    timeoutPolicy: selected.timeoutPolicy,
    timeoutMs: selected.timeoutMs,
    retryCount: selected.retryCount,
    fallbackRouteId: selected.fallbackRouteId,
    model,
    reasoningEffort,
    agentRuntimeId: employee.runtimeBinding?.agentRuntimeId || "",
    workerLane: employee.runtimeBinding?.workerLane || "",
    workerPoolMode: employee.runtimeBinding?.workerPoolMode || "runtime_allocated",
    consumesSharedWorkerQuota: employee.runtimeBinding?.consumesSharedWorkerQuota !== false,
    leaseRef: `lease://ai/${selected.provider || providerRoute.provider || "codex"}/${cleanProviderId(employee.id || "digital-employee")}/${crypto.randomUUID()}`,
  };
}

function providerRouteForEmployee(employee = {}, providerRoutes = []) {
  const preferredId = configuredEmployeeProviderRouteId(employee) || "codex-digital-office-route";
  return (
    providerRoutes.find((route) => route.id === preferredId) || {
      id: preferredId,
      name: "数字化中心 Codex",
      provider: employee.runtimeBinding?.provider || employee.modelBinding?.provider || "codex",
      health: "configured",
    }
  );
}

function safeProviderConnectionSummary(providerRoute = {}, providerCredential = {}, lease = null) {
  return {
    providerRouteId: cleanProviderId(providerRoute.id || "codex-digital-office-route"),
    name: String(providerRoute.name || "数字化中心 Codex").slice(0, 80),
    provider: String(providerRoute.provider || "codex").slice(0, 40),
    providerCredentialId: cleanProviderId(providerCredential.id || ""),
    departmentId: String(providerCredential.departmentId || "digital-office").slice(0, 60),
    health: String(providerRoute.health || "configured").slice(0, 40),
    leaseStatus: lease ? "leased" : "missing_server_secret",
    credentialVisibility: "server_only",
  };
}

function safeWorkerPoolSummary(employee = {}, workerPool = null, lease = null) {
  const runtime = employee.runtimeBinding || {};
  const resource = workerPool || {};
  return {
    workerPoolId: cleanProviderId(resource.id || lease?.workerPoolId || ""),
    providerRouteId: cleanProviderId(lease?.providerRouteId || runtime.preferredProviderRouteId || "codex-digital-office-route"),
    agentRuntimeId: String(runtime.agentRuntimeId || lease?.agentRuntimeId || "").slice(0, 80),
    workerLane: String(runtime.workerLane || lease?.workerLane || "").slice(0, 80),
    workerPoolMode: String(runtime.workerPoolMode || lease?.workerPoolMode || "runtime_allocated").slice(0, 80),
    consumesSharedWorkerQuota: runtime.consumesSharedWorkerQuota !== false && lease?.consumesSharedWorkerQuota !== false,
    totalWorkerSlots: Number(resource.totalWorkerSlots || 0),
    sharedWorkerSlots: Number(resource.sharedWorkerSlots || 0),
    reservedWorkerSlots: Number(resource.reservedWorkerSlots || 0),
  };
}

function workerQuotaLabel(lease = {}) {
  return lease.consumesSharedWorkerQuota === false ? "专属 Worker 不占共享额度" : "占用共享 Worker 额度";
}

function runtimeScopeInstruction(employee = {}) {
  if (employee.managementCapabilityPlan) {
    return "当前阶段只允许分析、资料查询、功能索引、API/任务草案和管理动作草案。";
  }
  return "当前阶段只允许在已声明能力、输入输出契约和写回边界内进行分析与草案输出。";
}

function authorizeDesktopMaterialToolCall(toolCall = {}, skillScope = {}, expiresAt = "", {
  confirmation = null,
  confirmationContext = {},
  confirmationService = null,
} = {}) {
  if (Number.isFinite(Date.parse(expiresAt)) && Date.now() >= Date.parse(expiresAt)) {
    return { status: "blocked", nextGate: "本轮 Desktop 临时 workspace 已超过 1 小时保留期，请重新发送材料。" };
  }
  const workspaceContract = workspaceMutationToolContract(toolCall.name);
  if (workspaceContract) {
    return authorizeWorkspaceMutationApproval({
      confirmation,
      confirmationContext,
      confirmationService,
      toolCall,
    });
  }
  const allowedTools = new Set([
    "prepare_channel_input",
    "list_workspace_files",
    "read_workspace_text",
    "inspect_workspace_image",
    "inspect_workspace_file",
    "export_visual_evidence",
    "write_workspace_text",
    "write_report_bundle",
    "run_mounted_skill",
  ]);
  if (!allowedTools.has(toolCall.name)) {
    return { status: "blocked", nextGate: "该 Device Tool 不在当前 Desktop 材料桥合同内。" };
  }
  if (toolCall.name === "run_mounted_skill") {
    const deterministicHarnessSkillIds = new Set(Array.isArray(skillScope?.deterministicHarnessSkillIds) ? skillScope.deterministicHarnessSkillIds : []);
    if (!deterministicHarnessSkillIds.has(String(toolCall.arguments?.skillId || ""))) {
      return { status: "blocked", nextGate: "该 Skill 不是当前员工已治理的确定性 Harness 能力。" };
    }
  }
  return {
    status: "allowed",
    action: toolCall.name,
    risk: toolCall.name.startsWith("write_") ? "local_workspace_write" : "ephemeral_material_read",
    scope: "selected_employee_current_turn",
    writebackBoundary: "ephemeral_workspace_only",
  };
}

function employeeRuntimeInvocationCheck(employee = {}) {
  if (!["在线", "试运行"].includes(String(employee.status || "").trim())) {
    return {
      status: "blocked",
      outcome: "employee_not_enabled",
      reason: "digital_employee_not_enabled",
      nextGate: "该数字员工尚未达到在线或试运行状态。",
    };
  }
  return {
    status: "allowed",
    outcome: "managed_chat_allowed",
    reason: "digital_employee_runtime_ready",
    nextGate: "已进入通用数字员工 Agent Runtime。",
  };
}

function safeDependencyContextSummary(context = {}) {
  return {
    contractVersion: context.contractVersion || "digital-employee-runtime-dependency-context.v2",
    injectedIntoRuntime: true,
    employeeId: context.employee?.id || "",
    skillScopeContractVersion: context.skillScope?.contractVersion || "",
    callableSkillCount: Array.isArray(context.callableSkills) ? context.callableSkills.length : 0,
    declaredToolCount: Array.isArray(context.declaredTools) ? context.declaredTools.length : 0,
    capabilityStatus: context.capabilityScope?.status || "lookup_required",
  };
}

function employeeDisplayName(employee = {}) {
  return String(employee.name || employee.title || employee.id || "数字员工").slice(0, 120);
}

function managedChatMaxOutputTokens(employee = {}) {
  const configured = Number(employee.runtimeBinding?.maxOutputTokens);
  if (!Number.isFinite(configured)) return 1600;
  return Math.min(4000, Math.max(256, Math.round(configured)));
}

function providerBudgetedMaxOutputTokens(employee = {}, lease = {}) {
  const managed = managedChatMaxOutputTokens(employee);
  const reserved = Number(lease.contextCapability?.reserve?.outputTokens);
  return Number.isInteger(reserved) && reserved > 0 ? Math.min(managed, reserved) : managed;
}

function requestedModel(employee = {}) {
  const legacyAssistantModel = cleanEmployeeId(employee.id) === ASSISTANT_EMPLOYEE_ID
    ? process.env.ENTERPRISE_ASSISTANT_MODEL_API_NAME || process.env.ENTERPRISE_ASSISTANT_MODEL
    : "";
  return employee.modelBinding?.model || legacyAssistantModel || DEFAULT_MODEL;
}

function normalizeSessionTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((turn) => {
    const role = String(turn?.role || "").trim();
    const content = String(turn?.content || "").trim();
    if (["user", "assistant"].includes(role) && content) {
      return [{ role, content }];
    }
    const messages = [];
    const userText = normalizeModelInputText(turn?.userText);
    const assistantText = normalizeModelInputText(turn?.assistantText);
    if (userText) messages.push({ role: "user", content: userText });
    for (const call of Array.isArray(turn?.toolCalls) ? turn.toolCalls : []) {
      const callId = cleanSafeText(call?.callId, 240);
      const name = cleanSafeText(call?.name, 240);
      if (!callId || !name) continue;
      messages.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(safeSessionToolArguments(call?.arguments)),
      });
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(call?.result || {}),
      });
    }
    if (assistantText) messages.push({ role: "assistant", content: assistantText });
    return messages;
  });
}

function safeSessionToolArguments(value = {}) {
  return Object.fromEntries(["inputId", "operationId", "skillId"].flatMap((key) => {
    const text = cleanSafeText(value?.[key], 240);
    return text ? [[key, text]] : [];
  }));
}

export function extractRecentTaskOutputEvidence(turns = []) {
  if (!Array.isArray(turns)) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    try {
      let evidence = null;
      if (turn?.type === "function_call_output") {
        evidence = JSON.parse(String(turn.output || "{}"));
      } else if (String(turn?.role || "").trim() === "assistant") {
        const content = String(turn?.content || "").trim();
        if (content.startsWith("[受管工具证据]\n")) {
          evidence = JSON.parse(content.slice("[受管工具证据]\n".length));
        }
      }
      if (evidence?.toolId !== "task-output-manifest") continue;
      const safeSummary = typeof evidence.safeSummary === "string" ? evidence.safeSummary.trim() : "";
      if (!safeSummary) continue;
      return {
        contractVersion: "task-delivery-status.v1",
        status: String(evidence.status || "completed").trim() || "completed",
        ...projectTaskOutputEvidenceSummary(safeSummary),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function projectTaskOutputEvidenceSummary(safeSummary = "") {
  const text = String(safeSummary || "");
  const artifactMatch = text.match(/登记\s+(\d+)\s+个可交付文件/);
  const fileCount = artifactMatch ? Math.max(0, Math.min(Number(artifactMatch[1]) || 0, 3)) : 0;
  const resultAvailable = /保存最终回答|文本结果/.test(text);
  if (fileCount > 0) {
    return {
      resultAvailable,
      fileDeliveryStatus: "registered",
      fileCount,
      deliveryEntrypoints: ["同一任务卡片的“查看交付”", "“我的任务”详情"],
      userFacingSummary: `最近任务已有 ${fileCount} 个登记交付物；可在同一任务卡片的“查看交付”或“我的任务”详情查看。`,
    };
  }
  if (/没有登记文件交付物/.test(text)) {
    return {
      resultAvailable: true,
      fileDeliveryStatus: "not_registered",
      fileCount: 0,
      deliveryEntrypoints: ["“我的任务”详情"],
      userFacingSummary: "最近任务已保存文本结果，但没有登记为可直接打开的文件交付物；可在“我的任务”详情查看文本结果。",
    };
  }
  return {
    resultAvailable,
    fileDeliveryStatus: "not_registered",
    fileCount: 0,
    deliveryEntrypoints: ["“我的任务”详情"],
    userFacingSummary: resultAvailable
      ? "最近任务已保存文本结果；可在“我的任务”详情查看。"
      : "最近任务尚未登记可交付结果。",
  };
}

function runtimeSessionKey({ channelId = "management_console", employeeId = "", session = {}, conversationScope = "" } = {}) {
  const actorSubjectId = String(
    session.employeeId || session.email || session.feishuUserId || session.employeeNo || "",
  ).trim();
  const actorIssuer = String(session.identitySource || session.authorization?.identitySource || "").trim();
  if (!actorSubjectId || !actorIssuer) throw new Error("runtime_session_stable_actor_required");
  return [
    "center",
    "v2",
    Buffer.from(actorIssuer, "utf8").toString("base64url"),
    Buffer.from(actorSubjectId, "utf8").toString("base64url"),
    cleanEmployeeId(channelId),
    cleanEmployeeId(employeeId),
    ...(conversationScope ? [Buffer.from(String(conversationScope), "utf8").toString("base64url")] : []),
  ].join(":");
}

function cleanRequestId(value = "") {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/.test(text) ? text : "";
}

function safeRuntimeTaskSummary(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    contractVersion: task.contractVersion,
    employeeId: task.employeeId,
    status: task.status,
    submittedAt: task.submittedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    nextGate: task.nextGate,
  };
}

function safeConversationSessionSummary(session = null) {
  const sessionId = String(session?.sessionId || "").trim().replace(/[^A-Za-z0-9._:-]+/g, "").slice(0, 240);
  if (!sessionId) return null;
  return {
    sessionId,
    revision: Number.isSafeInteger(session.revision) && session.revision > 0 ? session.revision : 0,
    status: ["active", "ended", "archived"].includes(session.status) ? session.status : "",
    updatedAt: Number.isFinite(Date.parse(String(session.updatedAt || ""))) ? String(session.updatedAt) : "",
  };
}

function startSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sendSseError(res, status, code, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: code, message }));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendTaskEventReadError(res, error) {
  const code = safeTaskEventErrorCode(error);
  const status = code === "runtime_task_not_found"
    ? 404
    : code === "task_event_cursor_ahead"
      ? 409
      : 400;
  return sendJson(res, status, { ok: false, error: code });
}

function safeTaskEventErrorCode(error) {
  return [
    "execution_task_integer_invalid",
    "runtime_task_not_found",
    "task_event_after_seq_invalid",
    "task_event_cursor_ahead",
  ].includes(error?.code)
    ? error.code
    : "runtime_task_event_read_failed";
}

function writeSse(res, event, data) {
  if (!res || typeof res.write !== "function") return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseWithId(res, id, event, data) {
  if (!res || typeof res.write !== "function") return;
  res.write(`id: ${id}\n`);
  writeSse(res, event, data);
}

function settlementForRecoveredTurn(turn = {}) {
  return {
    status: "blocked",
    lastErrorCode: String(turn.reason || "agent_turn_blocked").replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 120),
    resultSummary: "Persistent text task was blocked by the current runtime policy.",
  };
}

function runtimeRecoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireAdmissionTaskMatch(admission = {}, task = {}) {
  const routeBinding = admission.routeBinding || {};
  const expected = {
    tenantScope: task.tenantScope,
    actorIssuer: task.actorIssuer,
    actorSubjectDigest: task.actorSubjectDigest,
    employeeId: task.employeeId,
    sessionId: task.sessionId,
    entryId: task.executionInputRef?.refId,
  };
  if (admission.taskId !== task.taskId || admission.channelId !== task.channelId ||
    admission.employeeVersion !== task.employeeVersion ||
    Object.entries(expected).some(([field, value]) => routeBinding[field] !== value)) {
    throw runtimeRecoveryError("execution_task_admission_binding_mismatch");
  }
}

function runtimePermissionDigest(session = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    permissionVersion: session.authorization?.permissionVersion || "",
    permissions: [...(session.permissions || [])].sort(),
    role: session.role || "",
  })).digest("hex");
}

function safeCredentialChallengeError(error) {
  const code = String(error?.code || "").trim();
  return [
    "current_user_tool_credential_challenge_actor_invalid",
    "current_user_tool_credential_challenge_actor_mismatch",
    "current_user_tool_credential_challenge_expired",
    "current_user_tool_credential_challenge_not_found",
    "current_user_tool_credential_challenge_response_invalid",
    "current_user_tool_credential_challenge_timeout",
  ].includes(code) ? code : "current_user_tool_credential_challenge_invalid";
}

function currentUserToolExecutionIdentity(session = {}, route = {}) {
  const identitySource = String(session.authorization?.identitySource || session.identitySource || "").trim();
  const verifiedEmail = identitySource === "fortress-sso-v3" ? String(session.email || "").trim().toLowerCase() : "";
  const subjectDisplayName = cleanSafeText(session.name || "", 120);
  const departmentRefs = [...new Set([
    session.departmentId,
    session.department,
    session.departmentPath,
  ].map((value) => cleanSafeText(value, 160)).filter(Boolean))].slice(0, 20);
  const authorizationValidUntil = earliestValidUntil([
    session.authorization?.validUntil,
    session.expiresAt,
  ]);
  if (!verifiedEmail || !authorizationValidUntil) return null;
  return Object.freeze({
    contractVersion: "current-user-tool-execution-identity.v1",
    accountStatus: session.authorization?.accountStatus || "",
    tenantScope: String(route.tenantScope || "").trim(),
    actorIssuer: String(route.actorIssuer || "").trim(),
    actorSubjectDigest: String(route.actorSubjectDigest || "").trim(),
    identitySource,
    subjectId: verifiedEmail,
    subjectIdType: "verified_email_alias",
    ...(subjectDisplayName ? { subjectDisplayName } : {}),
    departmentRefs,
    permissionVersion: String(session.authorization?.permissionVersion || "").trim(),
    authorizationValidUntil,
  });
}

function earliestValidUntil(values = []) {
  const timestamps = values.map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : "";
}

function step(id, status, label, kind = "runtime") {
  return { id, status, label, kind };
}

function agentToolActivityStep(activity = {}) {
  const sequence = Math.max(1, Number(activity.sequence || 1));
  if (activity.status === "target_rejected") {
    return step(`tool-${sequence}`, "blocked", "目标系统未接受本次 Tool 操作", "tool");
  }
  const status = ["done", "blocked"].includes(activity.status) ? activity.status : "running";
  const label = status === "running"
    ? "正在执行已声明 Tool"
    : status === "blocked"
      ? "执行已声明 Tool 受阻"
      : "已执行已声明 Tool";
  return step(`tool-${sequence}`, status, label, "tool");
}

export function appendTaskToolProgress(ownership, activity = {}) {
  if (typeof ownership?.appendProgress !== "function") return null;
  const sequence = Math.max(1, Number(activity.sequence || 1));
  if (activity.status === "target_rejected") {
    return ownership.appendProgress({
      eventKey: `tool:${sequence}:target_rejected`,
      stage: "tool",
      status: "blocked",
      code: "tool_target_rejected",
    });
  }
  const activityStatus = ["done", "blocked"].includes(activity.status) ? activity.status : "running";
  const status = activityStatus === "done" ? "completed" : activityStatus;
  const code = activityStatus === "done"
    ? "tool_completed"
    : activityStatus === "blocked"
      ? "tool_blocked"
      : "tool_started";
  return ownership.appendProgress({
    eventKey: `tool:${sequence}:${activityStatus}`,
    stage: "tool",
    status,
    code,
  });
}

function safeModelError(error) {
  const code = String(error?.code || error?.message || error || "");
  const safeMessage = {
    model_provider_unavailable: "模型服务暂时不可用，本次任务未完成。请稍后重新发起任务。",
    model_rate_limited: "模型服务当前繁忙，本次任务未完成。请稍后重新发起任务。",
    model_response_contract_invalid: "模型服务返回异常，本次任务未完成。请稍后重新发起任务。",
    model_request_invalid: "当前模型请求配置不受支持，请联系管理员检查 Provider Route。",
    provider_adapter_not_registered: "当前 Provider Route 没有匹配的运行适配器，请联系管理员检查配置。",
  }[code];
  if (safeMessage) return safeMessage;
  return String(error?.message || error || "模型调用失败").replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]").slice(0, 420);
}

export function executionTaskWaitHandoffPresentation(error) {
  if (String(error?.code || error?.message || error || "") !== "execution_task_wait_timeout") return null;
  return Object.freeze({
    activity: step("task-follow", "running", "任务仍在后台执行，正在恢复进度跟踪", "runtime"),
    done: Object.freeze({ ok: false, followTask: true }),
  });
}

export function executionTaskEventActivity(event = {}) {
  if (event?.eventType === "task.result_available") {
    return step("result", "done", "任务结果已安全保存", "runtime");
  }
  const code = String(event?.data?.code || "");
  const byCode = {
    task_submitted: step("task-queue", "running", "任务已接收，等待运行资源", "runtime"),
    worker_claimed: step("task-queue", "done", "运行资源已就绪", "runtime"),
    provider_started: step("model", "running", "模型正在生成", "model"),
    tool_started: step("task-tool", "running", "正在调用已声明 Tool", "tool"),
    tool_completed: step("task-tool", "done", "已完成 Tool 调用", "tool"),
    tool_blocked: step("task-tool", "blocked", "Tool 调用已被运行门禁阻断", "tool"),
    tool_target_rejected: step("task-tool", "blocked", "目标系统未接受本次 Tool 操作", "tool"),
    provider_completed: step("model", "done", "模型生成完成", "model"),
    worker_settled: step("task-runtime", "done", "后台任务执行已结束", "runtime"),
  };
  const status = String(event?.data?.status || "");
  if (code === "worker_settled" && ["blocked", "failed", "lost", "rejected", "timed_out"].includes(status)) {
    return step("task-runtime", "blocked", "任务执行未完成", "runtime");
  }
  if (byCode[code]) return byCode[code];
  if (event?.eventType !== "task.state_changed") return null;
  if (status === "waiting") return step("task-queue", "running", "任务正在等待可用资源", "runtime");
  if (status === "running") return step("task-runtime", "running", "后台任务正在执行", "runtime");
  return null;
}

function cleanProviderId(value) {
  return String(value || "provider-route").replace(/[^A-Za-z0-9_-]/g, "-");
}

function employeeToolInvocationCheck(args = {}) {
  if (String(args.operation?.toolId || "").trim() === "managed-sandbox-exec" &&
    typeof args.sandboxInvocationCheck === "function") {
    return args.sandboxInvocationCheck(args);
  }
  const checksByToolId = new Map([
    [FXIAOKE_CRM_TOOL_ID, fxiaokeCrmToolInvocationCheck],
  ]);
  const invocationCheck = checksByToolId.get(String(args.operation?.toolId || "").trim()) || managedOpenApiToolInvocationCheck;
  return invocationCheck(args);
}

function cleanEmployeeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function confirmedExternalEffectStopResult(execution = null, approvedToolCall = null) {
  const reason = execution?.error === "external_effect_unknown"
    ? "external_effect_unknown"
    : execution?.turnDisposition === "target_rejected"
      ? "tool_target_rejected"
      : "";
  if (!reason) return null;
  const targetRejected = reason === "tool_target_rejected";
  return Object.freeze({
    ...(!targetRejected ? { partial: true } : {}),
    reason,
    text: targetRejected
      ? "目标系统未接受本次操作。请检查目标系统的权限、参数或业务前置条件后重试。"
      : "外部写入结果未知，已停止继续执行，请先核对目标系统状态。",
    contextAssembly: null,
    agentRuntime: Object.freeze({
      adapter: "responses_api_stream",
      status: reason,
      ...(targetRejected ? { blockedReason: reason } : {}),
      realModelRequested: false,
      requestCount: 0,
      toolCallCount: 1,
      toolCalls: [Object.freeze({
        callId: String(approvedToolCall?.callId || "").trim().slice(0, 180),
        name: String(approvedToolCall?.name || "").trim().slice(0, 180),
        arguments: {},
        result: execution,
        status: String(execution?.status || "blocked").trim().slice(0, 120),
      })],
      usage: Object.freeze({}),
    }),
  });
}

export { confirmedExternalEffectStopResult, runtimeSessionKey, runtimeTaskAgentEvidence };

export {
  agentToolActivityStep,
  authorizeDesktopMaterialToolCall,
  chunkText,
  cleanEmployeeId,
  cleanRequestId,
  credentialEventsFromRuntime,
  currentUserToolExecutionIdentity,
  employeeDisplayName,
  employeeRuntimeInvocationCheck,
  employeeToolInvocationCheck,
  normalizeSessionTurns,
  normalizeToolConfirmation,
  operationReceiptContextForExecutionOwnership as operationReceiptContextFor,
  providerBudgetedMaxOutputTokens,
  providerRouteForEmployee,
  requestedModel,
  requireAdmissionTaskMatch,
  resolveProviderLease,
  resolveRuntimeAdapter,
  runtimePermissionDigest,
  runtimeRecoveryError,
  runtimeScopeInstruction,
  safeAgentRuntimeExecutionSummary,
  safeConversationSessionSummary,
  safeCredentialChallengeError,
  safeDependencyContextSummary,
  safeModelError,
  safeProviderConnectionSummary,
  safeRuntimeEventSummary,
  safeRuntimeTaskSummary,
  safeWorkerPoolSummary,
  sendJson,
  sendSseError,
  sendTaskEventReadError,
  settlementForRecoveredTurn,
  startSse,
  step,
  toolConfirmationRequestsFromRuntime,
  workerQuotaLabel,
  writeSse,
  writeSseWithId,
};
