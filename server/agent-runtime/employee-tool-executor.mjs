import {
  createManagedOpenApiToolExecutor,
  managedOpenApiBinding,
} from "./managed-openapi-tool-executor.mjs";
import { createStructuredInputToolExecutor } from "./structured-input-tool-executor.mjs";
import {
  normalizeSkillToolCompletionPolicies,
  resolveSkillToolCompletionContract,
} from "./skill-tool-completion-policy.mjs";

async function createEmployeeToolExecutor({
  additionalExecutors = [],
  authorizeToolCall,
  currentUserToolCredentialLeaseService = null,
  defaultOperationReceiptContext = null,
  employee = {},
  executionIdentity = null,
  idempotentEffectService = null,
  managedOpenApiTools = [],
  materialInputs = [],
  operationReceiptProjector = null,
  toolCompletionPolicies = [],
  toolCredentials = [],
} = {}) {
  const toolDescriptors = typeof managedOpenApiTools === "function" ? await managedOpenApiTools() : managedOpenApiTools;
  const configuredTools = (Array.isArray(toolDescriptors) ? toolDescriptors : [])
    .filter((tool) => managedOpenApiBinding(employee, tool?.toolId));
  const registeredToolIds = new Set(configuredTools.map((tool) => cleanId(tool?.toolId)).filter(Boolean));
  const normalizedAdditionalExecutors = Array.isArray(additionalExecutors) ? additionalExecutors.filter(Boolean) : [];
  const additionalToolIds = new Set();
  for (const executor of normalizedAdditionalExecutors) {
    const ids = executor.handledToolIds?.() || [];
    if (!Array.isArray(ids)) throw new TypeError("employee_tool_ownership_invalid");
    for (const id of new Set(ids.map(cleanId).filter(Boolean))) {
      if (additionalToolIds.has(id)) throw new Error("employee_tool_ownership_conflict");
      additionalToolIds.add(id);
    }
  }
  if ([...additionalToolIds].some(id => registeredToolIds.has(id))) throw new Error("employee_tool_ownership_conflict");
  const missingManagedOpenApiToolIds = enabledManagedOpenApiBindingIds(employee)
    .filter((toolId) => !registeredToolIds.has(cleanId(toolId)) && !additionalToolIds.has(cleanId(toolId)));
  const managedExecutors = await Promise.all(configuredTools.map(async (tool) => {
    const executor = await createManagedOpenApiToolExecutor({
      ...tool,
      authorizeToolCall,
      credential: toolCredentialFor(toolCredentials, tool?.toolId),
      currentUserToolCredentialLeaseService,
      defaultOperationReceiptContext,
      employee,
      executionIdentity,
      idempotentEffectService,
      materialInputs,
      operationReceiptProjector,
    });
    if (typeof tool.isCurrent !== "function") return executor;
    const invokeCurrent = async (method, call, options) => {
      let current = false;
      try { current = await tool.isCurrent() === true; } catch { /* Fail closed on registry unavailability. */ }
      if (!current) return { ok: false, status: "blocked", error: "tool_asset_no_longer_current",
        message: "Tool 发布版本或连接授权已变化，请使用当前配置重新运行。" };
      if (typeof executor[method] !== "function") return {ok:false,status:"blocked",error:"external_effect_unknown"};
      return executor[method](call, options);
    };
    return { ...executor,
      execute: (call, options) => invokeCurrent("execute", call, options),
      recoverRecordedResult: (call, options) => invokeCurrent("recoverRecordedResult", call, options),
    };
  }));
  const governedToolCompletionPolicies = normalizeSkillToolCompletionPolicies(toolCompletionPolicies);
  const completionEvidenceByContract = new Map();
  const managedCompletionCapabilities = governedToolCompletionPolicies.flatMap((policy) => {
    const toolIndex = configuredTools.findIndex((tool) => cleanId(tool?.toolId) === policy.toolId);
    if (toolIndex < 0) return [];
    const definitions = managedExecutors[toolIndex]?.toolDefinitions?.() || [];
    const invokeDefinition = definitions.find((definition) => String(definition?.name || "").endsWith("__invokeOperation"));
    if (!invokeDefinition) return [];
    return [policy.operationId, ...policy.preparationOperationIds].map((operationId) => ({
      allowedToolNames: definitions.map((definition) => definition.name).filter(Boolean),
      contractId: policy.contractId,
      evidenceMode: policy.evidenceMode,
      evidenceOperationId: policy.operationId,
      fixedArguments: { operationId },
      operationId,
      toolId: policy.toolId,
      toolName: invokeDefinition.name,
    }));
  });
  const privateAgentResults = new WeakMap();
  const hasBusinessTools = managedExecutors.some((executor) => executor.toolDefinitions?.().length) ||
    normalizedAdditionalExecutors.some((executor) => executor.toolDefinitions?.().length);
  const structuredInputSourcePolicies = managedExecutors.flatMap((executor) => executor.structuredInputSourcePolicies?.() || []);
  const executors = [
    ...managedExecutors,
    ...(hasBusinessTools ? [createStructuredInputToolExecutor({ sourcePolicies: structuredInputSourcePolicies })] : []),
    ...normalizedAdditionalExecutors,
  ];

  function currentDefinitionOwners() {
    const owners = new Map();
    for (const executor of executors) {
      for (const definition of executor.toolDefinitions()) {
        if (owners.has(definition.name)) throw new Error("employee_tool_name_conflict");
        owners.set(definition.name, { definition, executor });
      }
    }
    return owners;
  }

  currentDefinitionOwners();

  function toolExecutionPolicy() {
    const requirements = executors.flatMap((executor) => executor.materialRequirements?.() || [])
      .filter((requirement) => requirement?.status === "required" && requirement.kind);
    if (!requirements.length) return { toolChoice: "auto", allowedToolNames: null };
    const requiredKinds = new Set(requirements.map((requirement) => requirement.kind));
    const declaredToolNames = new Set(currentDefinitionOwners().keys());
    const candidates = executors.flatMap((executor) => executor.materialCapabilities?.() || [])
      .filter((capability) => requiredKinds.has(capability?.kind) && capability.toolName)
      .map((capability) => capability.toolName)
      .filter((toolName) => declaredToolNames.has(toolName));
    return candidates.length
      ? { toolChoice: "required", allowedToolNames: [...new Set(candidates)] }
      : { toolChoice: "auto", allowedToolNames: [] };
  }

  async function executeOwned(toolCall = {}, options = {}, recover = false) {
    if (options.signal?.aborted) return canceledToolResult();
    const executionPolicy = toolExecutionPolicy();
    if (executionPolicy.allowedToolNames && !executionPolicy.allowedToolNames.includes(toolCall.name)) {
      return { ok: false, status: "blocked", error: "tool_dependency_not_ready", message: "该 Tool 的必需输入依赖尚未就绪。" };
    }
    const executor = currentDefinitionOwners().get(toolCall.name)?.executor;
    if (!executor) return { ok: false, status: "blocked", error: "tool_not_allowed", message: "该 Tool 未被当前数字员工声明。" };
    if (recover && typeof executor.recoverRecordedResult !== "function") {
      return {ok:false,status:"blocked",error:"external_effect_unknown",message:"该 Tool 不支持确定回执恢复，已停止重放。"};
    }
    const result = await executor[recover ? "recoverRecordedResult" : "execute"](toolCall, options);
    if (options.signal?.aborted) return canceledToolResult(toolCall.name);
    for (const capability of managedCompletionCapabilities) {
      if (toolCall.name === capability.toolName &&
        toolCall.arguments?.operationId === capability.operationId && result?.ok !== true) {
        console.warn("[skill-tool-completion] required operation did not produce evidence", {
          code: String(result?.code || "").slice(0, 180),
          contractId: capability.contractId,
          error: String(result?.error || "tool_operation_failed").slice(0, 120),
          httpStatus: Number(result?.httpStatus || 0),
          message: String(result?.msg || result?.message || "").slice(0, 500),
          operationId: capability.operationId,
          status: String(result?.status || "blocked").slice(0, 40),
          toolId: capability.toolId,
        });
      }
    }
    if (result?.ok === true && result.status === "completed" || targetResponseObserved(result)) {
      for (const capability of managedCompletionCapabilities) {
        if (toolCall.name === capability.toolName &&
          capability.operationId === capability.evidenceOperationId &&
          toolCall.arguments?.operationId === capability.evidenceOperationId &&
          result.operationId === capability.evidenceOperationId &&
          (result?.ok === true || capability.evidenceMode === "target_response_observed")) {
          completionEvidenceByContract.set(capability.contractId, Object.freeze({
            contractId: capability.contractId,
            status: "verified",
          }));
        }
      }
    }
    const safeResult = { ...(result || {}), toolName: toolCall.name };
    const projectedResult = executor.agentResultFor?.(result);
    if (projectedResult && projectedResult !== result && typeof projectedResult === "object") {
      privateAgentResults.set(safeResult, { ...projectedResult, toolName: toolCall.name });
    }
    return safeResult;
  }

  return {
    agentResultFor(result) {
      if (result && typeof result === "object" && privateAgentResults.has(result)) return privateAgentResults.get(result);
      const owner = result?.toolName ? currentDefinitionOwners().get(result.toolName)?.executor : null;
      return owner?.agentResultFor?.(result) || result;
    },
    availableAgentContent() {
      return executors.flatMap((executor) => executor.availableAgentContent?.() || []);
    },
    availableInputIds() {
      return [...new Set(executors.flatMap((executor) => executor.availableInputIds?.() || []))];
    },
    completionEvidence() {
      const evidenceByContract = new Map();
      for (const value of executors.flatMap((executor) => executor.completionEvidence?.() || [])) {
        const contractId = String(value?.contractId || "").trim();
        if (value?.status === "verified" &&
          /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(contractId)) {
          evidenceByContract.set(contractId, Object.freeze({ contractId, status: "verified" }));
        }
      }
      for (const value of completionEvidenceByContract.values()) {
        evidenceByContract.set(value.contractId, value);
      }
      return [...evidenceByContract.values()];
    },
    completionContractFor({ userText = "" } = {}) {
      return resolveSkillToolCompletionContract({
        callableSkills: [{ toolCompletionPolicies: governedToolCompletionPolicies }],
        userText,
      });
    },
    completionEvidenceCapabilities() {
      const capabilities = [];
      const materialCapabilities = executors.flatMap((executor) => executor.materialCapabilities?.() || []);
      for (const value of executors.flatMap((executor) => executor.completionEvidenceCapabilities?.() || [])) {
        const contractId = String(value?.contractId || "").trim();
        const toolName = String(value?.toolName || "").trim();
        const fixedArguments = safeFixedArguments(value?.fixedArguments);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(contractId) ||
          !toolName || !fixedArguments) continue;
        const prerequisiteKinds = new Set(Array.isArray(value.prerequisiteKinds)
          ? value.prerequisiteKinds.map((kind) => String(kind || "").trim()).filter(Boolean)
          : []);
        const allowedToolNames = new Set([toolName]);
        for (const capability of materialCapabilities) {
          if (prerequisiteKinds.has(String(capability?.kind || "").trim()) && capability?.toolName) {
            allowedToolNames.add(String(capability.toolName).trim());
          }
        }
        capabilities.push(Object.freeze({
          allowedToolNames: Object.freeze([...allowedToolNames]),
          contractId,
          fixedArguments,
          toolName,
        }));
      }
      capabilities.push(...managedCompletionCapabilities.map((capability) => Object.freeze({
        allowedToolNames: Object.freeze([...new Set(capability.allowedToolNames)]),
        contractId: capability.contractId,
        fixedArguments: Object.freeze({ ...capability.fixedArguments }),
        toolName: capability.toolName,
      })));
      return capabilities;
    },
    execute: (call, options) => executeOwned(call, options, false),
    recoverRecordedResult: (call, options) => executeOwned(call, options, true),
    safeToolCatalog() {
      const available = new Set(this.toolDefinitions().map((definition) => definition.name));
      return executors.flatMap((executor) => executor.safeToolCatalog?.() || [])
        .filter((tool) => available.has(tool.name));
    },
    runtimeStatus() {
      return [
        ...executors.map((executor) => executor.runtimeStatus?.()).filter(Boolean),
        ...missingManagedOpenApiToolIds.map((toolId) => ({
          toolId,
          status: "unavailable",
          reason: "managed_openapi_tool_registration_missing",
          message: "该员工已启用受管 OpenAPI Tool，但当前执行进程未注册其实现。",
        })),
      ];
    },
    safeActivityDescriptor(toolCall = {}, { result = null } = {}) {
      const executor = currentDefinitionOwners().get(toolCall.name)?.executor;
      return executor?.safeActivityDescriptor?.(toolCall, { result }) || null;
    },
    validateParameterCardSubmission(submission) {
      for (const executor of executors) {
        const result = executor.validateParameterCardSubmission?.(submission);
        if (result?.matched) return result;
      }
      return { matched: false, ok: false, error: "tool_parameter_card_tool_not_allowed" };
    },
    toolDefinitions() {
      const definitions = [...currentDefinitionOwners().values()].map(({ definition }) => definition);
      const policy = toolExecutionPolicy();
      return policy.allowedToolNames
        ? definitions.filter((definition) => policy.allowedToolNames.includes(definition.name))
        : definitions;
    },
    toolExecutionPolicy,
  };
}

function safeFixedArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([key, item]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && typeof item === "string" && item.length <= 240);
  return entries.length ? Object.freeze(Object.fromEntries(entries)) : null;
}

function canceledToolResult(toolName = "") {
  return { ok: false, status: "blocked", error: "agent_turn_canceled", message: "任务已取消，Tool 在最近安全边界停止。", ...(toolName ? { toolName } : {}) };
}

function toolCredentialFor(credentials = [], toolId = "") {
  if (!Array.isArray(credentials)) return "";
  const match = credentials.find((item) => cleanId(item?.toolId) === cleanId(toolId));
  const authorization = String(match?.authorization || "").trim();
  return /^Bearer\s+[^\s]+$/i.test(authorization) && authorization.length <= 8 * 1024 ? authorization : "";
}

function enabledManagedOpenApiBindingIds(employee = {}) {
  const bindings = Array.isArray(employee.toolBindings) ? employee.toolBindings : employee.tools || [];
  return [...new Set(bindings
    .filter((binding) => binding?.enabled !== false &&
      binding?.policyMode === "contract_capability" &&
      /^sha256:[a-f0-9]{64}$/.test(String(binding?.contractDigest || "").trim()))
    .map((binding) => String(binding?.toolId || binding?.id || "").trim())
    .filter(Boolean))];
}

function cleanId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function targetResponseObserved(result = {}) {
  return result?.error === "tool_request_failed" && Number.isInteger(result?.httpStatus) &&
    result.httpStatus >= 400 && Boolean(cleanId(result?.operationId));
}

export { createEmployeeToolExecutor };
