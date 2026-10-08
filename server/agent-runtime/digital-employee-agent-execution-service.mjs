import { normalizeAgentExecutionBudget } from "./agent-execution-budget.mjs";
import { normalizedOutputFormat } from "./agent-output-format.mjs";
import { buildDigitalEmployeeAgentPrompt } from "./digital-employee-agent-prompt.mjs";
import { normalizeAgentCompletionContract } from "./agent-completion-contract.mjs";
import { projectRuntimeSafeProvenanceSource } from "./runtime-safe-provenance-projector.mjs";
import { prepareSkillDocumentContext } from "./skill-document-tool-executor.mjs";

const EXECUTION_SERVICE_VERSION = "digital-employee-agent-execution-service.v1";

function createDigitalEmployeeAgentExecutionService({ agentRunner, recordRuntimeProvenance = null } = {}) {
  if (typeof agentRunner?.run !== "function") {
    throw new TypeError("digital employee Agent execution service requires agentRunner.run");
  }
  if (recordRuntimeProvenance !== null && typeof recordRuntimeProvenance !== "function") {
    throw new TypeError("digital employee Agent execution service recordRuntimeProvenance must be a function");
  }
  const executorByPrompt = new WeakMap();

  function buildPrompt({
    authorizeSkillRead = null,
    candidateEvaluator = null,
    completionContract = null,
    conversationHistory = [],
    dependencyContext,
    employeeIdentity,
    lease,
    maxOutputTokens,
    outputFormat = null,
    executionBudget = null,
    references = [],
    runtimeContext,
    safeContext,
    stream = false,
    toolExecutor = null,
  } = {}) {
    requirePlainObject(employeeIdentity, "employeeIdentity");
    requirePlainObject(dependencyContext, "dependencyContext");
    if (dependencyContext.contractVersion !== "digital-employee-runtime-dependency-context.v2") {
      throw new TypeError("digital employee Agent execution dependencyContext is invalid");
    }
    if (String(dependencyContext.employee?.id || "").trim() !==
      String(employeeIdentity.id || "").trim()) {
      throw new TypeError("digital employee Agent execution employee identity mismatch");
    }
    requirePlainObject(lease, "lease");
    requirePlainObject(runtimeContext, "runtimeContext");
    requirePlainObject(safeContext, "safeContext");
    if (candidateEvaluator !== null && typeof candidateEvaluator !== "function") {
      throw new TypeError("digital employee Agent execution candidateEvaluator must be a function");
    }
    const normalizedCompletionContract = normalizeAgentCompletionContract(completionContract);
    const preparedContext = prepareSkillDocumentContext(dependencyContext, toolExecutor, authorizeSkillRead);
    const executionTools = preparedContext.toolExecutor;
    const toolDefinitions = executionTools?.toolDefinitions?.() || [];
    const availableTools = executionTools?.safeToolCatalog?.() || [];
    const toolRuntime = toolExecutor?.runtimeStatus?.() || [];
    const completionCapabilities = executionTools?.completionEvidenceCapabilities?.() || [];
    const runtimeSafeContext = {
      ...safeContext,
      dependencyContext: preparedContext.dependencyContext,
      toolRuntime: Array.isArray(toolRuntime) ? toolRuntime : [],
      toolAccess: {
        mode: availableTools.length ? "agent_selected_governed_tools" : "no_available_tools",
        availableTools: Array.isArray(availableTools) ? availableTools : [],
        inputIds: toolExecutor?.availableInputIds?.() || [],
      },
      completionRequirements: normalizedCompletionContract,
      completionCapabilities: Array.isArray(completionCapabilities) ? completionCapabilities : [],
    };
    const prompt = buildDigitalEmployeeAgentPrompt({
      conversationHistory,
      employeeIdentity,
      references,
      runtimeContext,
      safeContext: runtimeSafeContext,
      toolDefinitions,
    });
    const budget = normalizeAgentExecutionBudget(executionBudget);
    const prepared = Object.freeze({
      ...prompt,
      model: requiredText(lease.model, "lease.model"),
      stream: Boolean(stream),
      store: false,
      reasoning: {
        effort: requiredText(lease.reasoningEffort, "lease.reasoningEffort"),
        summary: "auto",
      },
      max_output_tokens: Math.min(boundedPositiveInteger(maxOutputTokens, "maxOutputTokens"), budget?.maxTotalTokens ?? Infinity),
      ...(outputFormat ? { text: { format: normalizedOutputFormat(outputFormat) } } : {}),
    });
    executorByPrompt.set(prepared, Object.freeze({
      candidateEvaluator,
      executionBudget: budget,
      completionContract: normalizedCompletionContract,
      dependencyContext,
      toolParameterContinuation: runtimeContext.toolParameterContinuation || null,
      toolExecutor,
      executionTools,
    }));
    return prepared;
  }

  async function execute({
    lease,
    onTextDelta = null,
    onToolActivity = null,
    operationReceiptContext = null,
    prompt,
    runtimeTask = null,
    signal = null,
    toolExecutor = null,
  } = {}) {
    requirePlainObject(lease, "lease");
    requirePlainObject(prompt, "prompt");
    const binding = executorByPrompt.get(prompt);
    if (!binding || binding.toolExecutor !== toolExecutor) {
      throw new TypeError("digital employee Agent execution prompt and Tool executor do not match");
    }
    if (onToolActivity !== null && typeof onToolActivity !== "function") {
      throw new TypeError("digital employee Agent execution onToolActivity must be a function");
    }
    if (onTextDelta !== null && typeof onTextDelta !== "function") {
      throw new TypeError("digital employee Agent execution onTextDelta must be a function");
    }
    await recordProvenance({
      dependencyContext: binding.dependencyContext,
      runtimeTask,
    });
    return agentRunner.run({
      lease,
      candidateEvaluator: binding.candidateEvaluator,
      executionBudget: binding.executionBudget,
      completionContract: binding.completionContract,
      ...(onToolActivity ? { onToolActivity } : {}),
      ...(onTextDelta ? { onTextDelta } : {}),
      operationReceiptContext,
      prompt,
      runtimeTask,
      signal,
      ...(binding.toolParameterContinuation ? { toolParameterContinuation: binding.toolParameterContinuation } : {}),
      toolExecutor: binding.executionTools,
    });
  }

  async function recordProvenance({ dependencyContext, runtimeTask = null } = {}) {
    if (!recordRuntimeProvenance || !runtimeTask) return null;
    const sourceSnapshot = projectRuntimeSafeProvenanceSource({ dependencyContext, runtimeTask });
    return recordRuntimeProvenance({ runtimeTask, sourceSnapshot });
  }

  return Object.freeze({
    contractVersion: EXECUTION_SERVICE_VERSION,
    buildPrompt,
    execute,
    recordProvenance,
  });
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`digital employee Agent execution ${name} must be a plain object`);
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240) {
    throw new TypeError(`digital employee Agent execution ${name} is invalid`);
  }
  return value;
}

function boundedPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    throw new TypeError(`digital employee Agent execution ${name} is invalid`);
  }
  return value;
}

export {
  EXECUTION_SERVICE_VERSION as DIGITAL_EMPLOYEE_AGENT_EXECUTION_SERVICE_VERSION,
  createDigitalEmployeeAgentExecutionService,
};
