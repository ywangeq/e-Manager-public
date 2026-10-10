import { configuredEmployeeProviderRouteId } from "../../agent-runtime/employee-provider-route.mjs";
import crypto from "node:crypto";
import {
  EMPLOYEE_ID,
  SOURCE_SYSTEM_ID,
  cleanShortText,
  cleanText,
} from "../../feishu-integration-support.mjs";
import { createDigitalEmployeeAgentExecutionService } from "../../agent-runtime/digital-employee-agent-execution-service.mjs";
import { normalizeModelInputText } from "../../agent-runtime/context-assembler.mjs";
import { assembleDigitalEmployeeDependencyContext } from "../../agent-runtime/dependency-context.mjs";
import { createContextEngine } from "../../agent-runtime/runtime-context-engine.mjs";
import { createManagedContextCompactor } from "../../agent-runtime/managed-context-compactor.mjs";
import { createDefaultProviderAdapterRegistry } from "../../agent-runtime/openai-responses-provider-adapter.mjs";
import { resolveManagedProviderLease } from "../../agent-runtime/provider-lease-resolver.mjs";
import { createProviderRequestQueue } from "../../agent-runtime/provider-request-queue.mjs";
import { createResponsesAgentRunner } from "../../agent-runtime/responses-agent-runner.mjs";
import { executeRuntimeToolActivity } from "../../agent-runtime/runtime-tool-activity-executor.mjs";
import { resolveSkillToolCompletionContract } from "../../agent-runtime/skill-tool-completion-policy.mjs";
import {
  assembleRuntimeConversationHistory,
  assertRuntimeConversationContext,
  projectRuntimeSessionWorkflowEvidence,
} from "../../agent-runtime/runtime-context-session.mjs";
import { createTiktokenEstimatorRegistry } from "../../agent-runtime/token-estimator-registry.mjs";
import { toolParameterCardDraftsFromRuntime } from "../../agent-runtime/tool-parameter-card.mjs";
import { toolConfirmationRequestsFromRuntime } from "../../agent-runtime/tool-call-confirmation-request.mjs";
import { enrichFeishuReplyWithToolPresentation } from "./reply-presentation.mjs";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_MAX_OUTPUT_TOKENS = 1600;
const DEFAULT_AGENT_LOOP_POLICY = {
  maxDurationMs: 30 * 60 * 1000,
  maxTotalTokens: 0,
  repeatedToolThreshold: 3,
};

function createFeishuEmployeeAgentRuntime({
  employeeId,
  aiProviderCredentials = [],
  aiProviderRoutes = [],
  businessSkills = [],
  agentExecutionService = null,
  agentRunner = null,
  contextCompactionPolicy = null,
  contextCompactor = null,
  contextEngine = null,
  digitalEmployees = [],
  fetch = globalThis.fetch,
  getAiProviderCredentials = () => aiProviderCredentials,
  getAiProviderRoutes = () => aiProviderRoutes,
  getDigitalEmployees = () => digitalEmployees,
  getBusinessSkills,
  isTaskCancellationRequested = () => false,
  loopPolicy,
  now = () => Date.now(),
  providerAdapterRegistry = null,
  providerRequestQueue = createProviderRequestQueue(),
  providerCredentialSecretStore,
  recordRuntimeActivity = null,
  recordRuntimeEvidence = null,
  recordRuntimeEfficiency = null,
  recordRuntimeProvenance = null,
  retryPolicy,
  sleep,
  tokenEstimatorRegistry = null,
} = {}) {
  const runtimeEmployeeId = requireEmployeeId(employeeId);
  if (recordRuntimeProvenance !== null && typeof recordRuntimeProvenance !== "function") {
    throw new TypeError("Feishu employee Agent runtime recordRuntimeProvenance must be a function");
  }
  if (recordRuntimeActivity !== null && typeof recordRuntimeActivity !== "function") {
    throw new TypeError("Feishu employee Agent runtime recordRuntimeActivity must be a function");
  }
  const effectiveLoopPolicy = normalizeAgentLoopPolicy(loopPolicy);
  const effectiveProviderAdapterRegistry = providerAdapterRegistry || createDefaultProviderAdapterRegistry({ fetch });
  const effectiveTokenEstimatorRegistry = tokenEstimatorRegistry || createTiktokenEstimatorRegistry();
  const effectiveContextEngine = contextEngine || createContextEngine({ estimators: effectiveTokenEstimatorRegistry });
  const responsesAgentRunner = agentRunner || createResponsesAgentRunner({
    buildPartialText: buildFeishuPartialText,
    formatOutput: formatFeishuPlainTextReply,
    isTaskCancellationRequested,
    loopPolicy: effectiveLoopPolicy,
    now,
    projectToolArguments: safeToolArguments,
    providerAdapterRegistry: effectiveProviderAdapterRegistry,
    providerRequestQueue,
    recordRuntimeEvidence,
    recordRuntimeEfficiency,
    retryPolicy,
    sleep,
  });
  const effectiveAgentExecutionService = agentExecutionService || createDigitalEmployeeAgentExecutionService({
    agentRunner: responsesAgentRunner,
    recordRuntimeProvenance,
  });
  async function runTurn({
    materialToolExecutor = null,
    onTextDelta = null,
    operationReceiptContext = null,
    runtimeContext = {},
    runtimeTask = null,
    signal = null,
    toolExecutor = null,
  } = {}) {
    const employee = findEmployee();
    const userText = normalizeModelInputText(runtimeContext.currentTurn?.text);
    const inputSafeContext = runtimeContext.safeContext || {};
    const safeContext = {
      ...inputSafeContext,
      dependencyContext: {
        ...(inputSafeContext.dependencyContext || {}),
        employee: {
          id: employee.id || runtimeEmployeeId,
          name: employeeDisplayName(employee, runtimeEmployeeId),
          title: employee.title,
          objective: employee.objective,
          configuredFunctions: employee.configuredFunctions,
          identityBoundaries: employee.identityBoundaries,
          ...(inputSafeContext.dependencyContext?.employee || {}),
          id: employee.id || runtimeEmployeeId,
        },
      },
    };
    const effectiveToolExecutor = toolExecutor || materialToolExecutor;
    const completionContract = effectiveToolExecutor?.completionContractFor?.({ userText }) ||
      resolveSkillToolCompletionContract({
        callableSkills: safeContext.dependencyContext?.callableSkills,
        userText,
      });
    if (completionContract?.requiredEvidence?.length) {
      console.info("[skill-tool-completion] Feishu turn requires evidence", {
        employeeId: employee.id || runtimeEmployeeId,
        requiredEvidence: completionContract.requiredEvidence,
      });
    }
    const submittedToolParameterCard = runtimeContext.toolParameterContinuation
      ? effectiveToolExecutor?.validateParameterCardSubmission?.(runtimeContext.toolParameterContinuation) || null
      : null;
    if (runtimeContext.toolParameterContinuation && !submittedToolParameterCard) {
      return parameterCardFailureTurn("tool_parameter_card_validator_unavailable");
    }
    if (submittedToolParameterCard && !submittedToolParameterCard.ok) {
      return parameterCardFailureTurn(submittedToolParameterCard.error || "tool_parameter_card_invalid");
    }
    const currentNow = now();
    const promptRuntimeContext = {
      currentTurn: { text: userText },
      channelPresentationEvidence: runtimeContext.channelPresentationEvidence || null,
      toolParameterContinuation: submittedToolParameterCard?.value || null,
      sessionWorkflowEvidence: projectRuntimeSessionWorkflowEvidence(runtimeContext.contextSource, {
        now: currentNow,
        workflowEvidenceTtlMs: runtimeContext.workflowEvidenceTtlMs,
      }),
    };
    if (process.env.FEISHU_ALGORITHM_AGENT_MOCK === "1") {
      const lease = resolveProviderLease(employee) || mockProviderLease(employee);
      await runMockMaterialToolPlan(materialToolExecutor);
      const effectiveTask = taskWithMaterialToolResults(runtimeTask, materialToolExecutor);
      const effectiveSafeContext = withRuntimeTask(safeContext, effectiveTask);
      return {
        ok: true,
        status: "agent_reply_ready",
        reason: "mock_agent_runtime",
        text: mockAgentReply({ employee, employeeId: runtimeEmployeeId, userText, safeContext: effectiveSafeContext }),
        safeSummary: {
          employeeId: runtimeEmployeeId,
          employee: safeEmployeeSummary(employee, runtimeEmployeeId),
          runtime: "mock_agent_runtime",
          providerRouteId: lease.providerRouteId,
          providerCredentialId: lease.providerCredentialId,
          model: lease.model,
          reasoningEffort: lease.reasoningEffort,
          agentRuntime: {
            mode: "mock_agent_runtime",
            adapter: "scripted_mock_material_plan",
            realModelRequested: false,
            status: "mock_no_model_request",
            requestCount: 0,
            toolCallCount: materialToolExecutor?.taskPatch?.()?.toolResults?.length || 0,
            model: lease.model,
            reasoningEffort: lease.reasoningEffort,
          },
        },
      };
    }

    const lease = resolveProviderLease(employee);
    if (!lease) {
      return {
        ok: false,
        status: "agent_runtime_unavailable",
        reason: "provider_connection_lease_missing",
        text: formatFeishuPlainTextReply([
          `「${employeeDisplayName(employee, runtimeEmployeeId)}」的 AI agent runtime 还没有可用服务端租约。`,
          "这条飞书 Channel 已收到消息，但不能冒充在职 agent 回答。",
          "请先在模型供应商与连接中为该员工配置 Provider Route 和服务端 Credential。",
        ].join("\n")),
        safeSummary: {
          employeeId: runtimeEmployeeId,
          employee: safeEmployeeSummary(employee, runtimeEmployeeId),
          runtime: "missing_provider_connection_lease",
          model: employee?.modelBinding?.model || DEFAULT_MODEL,
          agentRuntime: {
            mode: "missing_provider_connection_lease",
            realModelRequested: false,
            status: "blocked_before_model_request",
            requestCount: 0,
            toolCallCount: 0,
            blockedReason: "provider_connection_lease_missing",
          },
        },
      };
    }

    const budgetProbe = buildAgentPrompt({
      completionContract,
      conversationHistory: [],
      employee,
      userText,
      safeContext,
      lease,
      runtimeContext: promptRuntimeContext,
      toolExecutor: effectiveToolExecutor,
    });
    const contextSelection = await assembleRuntimeConversationHistory({
      capability: lease.contextCapability,
      compactionPolicy: contextCompactionPolicy,
      contextCompactor: contextCompactor || managedContextCompactor(lease, signal, runtimeTask),
      contextEngine: effectiveContextEngine,
      currentTurnItems: budgetProbe.input,
      fixedItems: [{ type: "instructions", content: budgetProbe.instructions }],
      now: currentNow,
      source: runtimeContext.contextSource,
      toolDefinitions: budgetProbe.tools || [],
      workflowEvidenceTtlMs: runtimeContext.workflowEvidenceTtlMs,
    });
    assertRuntimeConversationContext(contextSelection);
    const prompt = buildAgentPrompt({
      completionContract,
      conversationHistory: contextSelection.conversationHistory,
      employee,
      userText,
      safeContext: {
        ...safeContext,
        contextAssembly: contextSelection.summary,
      },
      lease,
      runtimeContext: promptRuntimeContext,
      toolDefinitions: budgetProbe.tools || [],
      toolExecutor: effectiveToolExecutor,
    });
    const modelRun = await effectiveAgentExecutionService.execute({
      lease,
      onTextDelta,
      operationReceiptContext,
      prompt,
      runtimeTask,
      signal,
      toolExecutor: effectiveToolExecutor,
    });
    modelRun.text = formatFeishuPlainTextReply(enrichFeishuReplyWithToolPresentation(
      modelRun.text,
      [
        ...(modelRun.agentRuntime?.toolCalls || []),
        ...(runtimeContext.channelPresentationEvidence ? [{ result: runtimeContext.channelPresentationEvidence }] : []),
      ],
    ));
    const partial = Boolean(modelRun.partial);
    const agentRuntime = safeAgentRuntimeSummary({
      ...modelRun.agentRuntime,
      mode: "responses_api_agent_runtime",
      provider: lease.provider,
      providerAdapter: effectiveProviderAdapterRegistry.adapterIdFor(lease),
      apiProtocol: lease.apiProtocol,
      upstreamDialect: lease.upstreamDialect,
      model: lease.model,
      reasoningEffort: lease.reasoningEffort,
      leaseRef: lease.leaseRef,
    });
    return {
      ok: !partial,
      status: partial ? "agent_partial_ready" : "agent_reply_ready",
      reason: modelRun.reason || "model_agent_runtime",
      text: modelRun.text,
      toolCalls: agentRuntime.toolCalls,
      toolConfirmationRequests: toolConfirmationRequestsFromRuntime(modelRun.agentRuntime),
      toolParameterCards: toolParameterCardDraftsFromRuntime(modelRun.agentRuntime),
      safeSummary: {
        employeeId: runtimeEmployeeId,
        employee: safeEmployeeSummary(employee, runtimeEmployeeId),
        runtime: "responses_api_agent_runtime",
        providerRouteId: lease.providerRouteId,
        providerCredentialId: lease.providerCredentialId,
        provider: lease.provider,
        model: lease.model,
        reasoningEffort: lease.reasoningEffort,
        leaseRef: lease.leaseRef,
        contextAssembly: contextSelection.summary,
        agentRuntime,
      },
    };
  }

  async function runApprovedToolCall({
    approvedToolCall = null,
    operationReceiptContext = null,
    runtimeContext = {},
    runtimeTask = null,
    signal = null,
    toolExecutor = null,
  } = {}) {
    const employee = findEmployee();
    if (!approvedToolCall?.name || !approvedToolCall.arguments || typeof toolExecutor?.execute !== "function") {
      return toolConfirmationExecutionFailureTurn({
        employee,
        reason: "approved_tool_call_unavailable",
        text: "确认已收到，但本次确认记录已失效或与当前上下文不匹配；系统不会执行外部写操作。请重新发起并使用最新确认卡。",
      });
    }
    if (!runtimeTask?.taskId && !runtimeTask?.id) {
      return toolConfirmationExecutionFailureTurn({
        employee,
        reason: "approved_tool_call_task_missing",
        text: "确认已收到，但当前运行任务缺少可验证执行身份；系统不会执行外部写操作。",
      });
    }
    await effectiveAgentExecutionService.recordProvenance({
      dependencyContext: runtimeContext.safeContext?.dependencyContext || { contractVersion: "digital-employee-runtime-dependency-context.v2" },
      runtimeTask,
    });
    let activityExecution;
    try {
      activityExecution = await executeRuntimeToolActivity({
        activitySnapshot: runtimeTask.activitySnapshot || runtimeTask.runtimeEvidence?.activitySnapshot || null,
        confirmedToolCall: true,
        operationReceiptContext,
        persistActivity: recordRuntimeActivity ? async ({ activitySnapshot }) => (
          recordRuntimeActivity({ activitySnapshot, runtimeTask })
        ) : null,
        persistEfficiency: recordRuntimeEfficiency ? async ({ activity, executorRetryCount, repeatThreshold, result, toolCall }) => (
          recordRuntimeEfficiency({
            runtimeTask,
            mutation: {
              type: "tool_call_terminal",
              repeatThreshold,
              activity,
              executorRetryCount,
              result,
              toolCall,
            },
          })
        ) : null,
        repeatThreshold: effectiveLoopPolicy.repeatedToolThreshold,
        runtimeTask,
        signal,
        timeoutMs: resolveProviderLease(employee)?.toolExecutionTimeoutMs || 300_000,
        toolCall: approvedToolCall,
        toolExecutor,
      });
    } catch (error) {
      return toolConfirmationExecutionFailureTurn({
        employee,
        reason: cleanShortText(error?.code || "approved_tool_call_execution_failed"),
        text: "确认已收到，但本次 Tool 执行未能在安全边界内完成；系统不会复用本次确认。",
      });
    }
    return toolConfirmationExecutionTurn({ activityExecution, approvedToolCall, employee });
  }

  function resolveDependencyContext({ connection = {}, employee = findEmployee(), runtimeTask = null } = {}) {
    return assembleDigitalEmployeeDependencyContext({
      businessSkills,
      channel: {
        channel: "feishu",
        sourceSystemId: SOURCE_SYSTEM_ID,
        status: connection.status,
        receiveMode: connection.eventSubscription?.receiveMode,
      },
      employee,
      getBusinessSkills,
      runtimeTask,
      workerBinding: connection.workerBinding || {},
    });
  }

  function findEmployee() {
    return getDigitalEmployees().find((employee) => employee.id === runtimeEmployeeId) || {};
  }

  function resolveProviderLease(employee = {}) {
    const providerRoute = providerRouteForEmployee(employee);
    const providerCredential = getAiProviderCredentials().find((credential) => credential.id === providerRoute.credentialId) || {};
    const providerCredentialSecret = providerCredentialSecretStore?.getSecret?.(providerCredential.id) || null;
    const selected = resolveManagedProviderLease({ employee, providerCredential, providerCredentialSecret, providerRoute });
    if (!selected) return null;
    return {
      authSecret: selected.authSecret,
      baseUrl: selected.baseUrl,
      providerRouteId: selected.providerRouteId,
      providerCredentialId: selected.providerCredentialId,
      workerPoolId: selected.workerPoolId,
      provider: selected.provider || "codex",
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
      model: employee.modelBinding?.model || DEFAULT_MODEL,
      reasoningEffort: employee.modelBinding?.modelLevelId || DEFAULT_REASONING_EFFORT,
      leaseRef: `lease://ai/${leaseRefSegment(selected.provider || "provider")}/${leaseRefSegment(runtimeEmployeeId)}/${crypto.randomUUID()}`,
    };
  }

  function mockProviderLease(employee = {}) {
    const providerRoute = providerRouteForEmployee(employee);
    return {
      providerRouteId: providerRoute.id || "mock-provider-route",
      providerCredentialId: "mock-provider-credential",
      model: employee.modelBinding?.model || DEFAULT_MODEL,
      reasoningEffort: employee.modelBinding?.modelLevelId || DEFAULT_REASONING_EFFORT,
    };
  }

  function managedContextCompactor(lease, signal = null, runtimeTask = null) {
    return createManagedContextCompactor({
      capability: lease.contextCapability,
      estimatorRegistry: effectiveTokenEstimatorRegistry,
      runPrompt: async (prompt) => {
        const result = await responsesAgentRunner.run({
          lease,
          persistRuntimeEvidence: false,
          prompt: {
            ...prompt,
            model: lease.model,
            stream: true,
            store: false,
            max_output_tokens: Math.min(prompt.max_output_tokens, lease.contextCapability.reserve.outputTokens),
          },
          runtimeTask,
          signal,
        });
        if (signal?.aborted || result.reason === "agent_turn_canceled") throw agentCancellationError();
        return result.text;
      },
    });
  }

  function providerRouteForEmployee(employee = {}) {
    const preferredId = configuredEmployeeProviderRouteId(employee) || "codex-digital-office-route";
    return getAiProviderRoutes().find((route) => route.id === preferredId) || {
      id: preferredId,
      provider: employee.runtimeBinding?.provider || employee.modelBinding?.provider || "codex",
    };
  }

  function buildAgentPrompt({ completionContract = null, conversationHistory = [], employee = {}, userText = "", safeContext = {}, lease = {}, runtimeContext = {}, toolExecutor = null } = {}) {
    return effectiveAgentExecutionService.buildPrompt({
      completionContract,
      conversationHistory: conversationHistory.flatMap(historyInputItems),
      dependencyContext: safeContext.dependencyContext,
      employeeIdentity: {
        id: employee.id || runtimeEmployeeId,
        name: employeeDisplayName(employee, runtimeEmployeeId),
        title: employee.title,
        objective: employee.objective,
        configuredFunctions: employee.configuredFunctions,
        identityBoundaries: employee.identityBoundaries,
      },
      references: safeContext.priorSessionReferences || [],
      runtimeContext: {
        currentTurn: { text: userText },
        channelPresentationEvidence: runtimeContext.channelPresentationEvidence || null,
        toolParameterContinuation: runtimeContext.toolParameterContinuation || null,
        sessionWorkflowEvidence: runtimeContext.sessionWorkflowEvidence || null,
      },
      safeContext,
      toolExecutor,
      lease,
      maxOutputTokens: managedMaxOutputTokens(employee),
      stream: true,
    });
  }

  function managedMaxOutputTokens(employee = {}) {
    const configured = Number(employee.runtimeBinding?.maxOutputTokens);
    if (!Number.isFinite(configured)) return DEFAULT_MAX_OUTPUT_TOKENS;
    return Math.min(4000, Math.max(256, Math.round(configured)));
  }

  function parameterCardFailureTurn(reason) {
    return {
      ok: false,
      status: "tool_parameter_card_invalid",
      reason,
      text: "这张参数卡对应的 Tool 合同已经变化，或参数不再符合当前合同。请重新生成参数卡。",
      safeSummary: {
        employeeId: runtimeEmployeeId,
        runtime: "tool_parameter_card_validation",
        blockedReason: reason,
        agentRuntime: {
          mode: "tool_parameter_card_validation",
          realModelRequested: false,
          status: reason,
          requestCount: 0,
          toolCallCount: 0,
        },
      },
    };
  }

  async function runMockMaterialToolPlan(materialToolExecutor = null) {
    if (!materialToolExecutor) return;
    for (const inputId of materialToolExecutor.availableInputIds()) {
      const prepared = await materialToolExecutor.execute({ name: "prepare_channel_input", arguments: { inputId } });
      if (prepared.status !== "temporary_material_ready") continue;
      const skillId = materialToolExecutor.harnessSkillIds.find(Boolean);
      if (skillId) await materialToolExecutor.execute({ name: "run_mounted_skill", arguments: { inputId, skillId } });
    }
  }

  function historyInputItems(turn = {}) {
    const role = cleanShortText(turn.role);
    const content = normalizeModelInputText(turn.content);
    if (["user", "assistant"].includes(role) && content) return [{ role, content }];
    const items = [];
    if (turn.userText) items.push({ role: "user", content: turn.userText });
    for (const call of turn.toolCalls || []) {
      const callId = cleanShortText(call.callId);
      const name = cleanShortText(call.name);
      if (!callId || !name) continue;
      items.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(safeToolArguments(call.arguments)),
      });
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(call.result || {}),
      });
    }
    if (turn.assistantText) items.push({ role: "assistant", content: turn.assistantText });
    return items;
  }

  function safeToolArguments(value = {}) {
    return {
      inputId: cleanShortText(value.inputId),
      operationId: cleanShortText(value.operationId),
      skillId: cleanShortText(value.skillId),
    };
  }

  function safeAgentRuntimeSummary(runtime = {}) {
    return {
      ...runtime,
      toolCalls: (Array.isArray(runtime.toolCalls) ? runtime.toolCalls : []).slice(0, 20).map((call) => ({
        callId: cleanShortText(call.callId),
        name: cleanShortText(call.name),
        arguments: safeToolArguments(call.arguments),
        result: {
          toolId: cleanShortText(call.result?.toolId),
          operationId: cleanShortText(call.result?.operationId || call.arguments?.operationId),
          skillId: cleanShortText(call.result?.skillId),
          status: cleanShortText(call.result?.status || call.status),
          summary: cleanShortText(call.result?.summary || call.summary),
          nextGate: cleanShortText(call.result?.nextGate),
        },
        status: cleanShortText(call.status),
        skillId: cleanShortText(call.skillId),
      })).filter((call) => call.name),
    };
  }

  function toolConfirmationExecutionTurn({ activityExecution = {}, approvedToolCall = {}, employee = {} } = {}) {
    const result = activityExecution.result || {};
    const ok = result?.ok === true;
    const reason = ok
      ? "tool_confirmation_executed"
      : result?.confirmationRequest?.contractVersion === "tool-call-confirmation.v1"
        ? "tool_confirmation_execution_not_verified"
        : result?.authorizationAction?.contractVersion === "current-user-tool-authorization-action.v1"
          ? "tool_authorization_required"
          : result?.turnDisposition === "target_rejected" || result?.status === "target_rejected"
            ? "tool_target_rejected"
            : cleanShortText(result?.error || result?.status || "approved_tool_call_failed");
    const toolCalls = [{
      callId: cleanShortText(approvedToolCall.callId),
      name: cleanShortText(approvedToolCall.name),
      arguments: safeToolArguments(approvedToolCall.arguments),
      result,
      status: cleanShortText(result.status),
      skillId: cleanShortText(result.skillId),
    }];
    const agentRuntime = safeAgentRuntimeSummary({
      adapter: "governed_tool_execution",
      mode: "tool_confirmation_direct_execution",
      realModelRequested: false,
      status: ok ? "tool_call_completed" : reason,
      blockedReason: ok ? "" : reason,
      requestCount: 0,
      toolCallCount: 1,
      toolCalls,
      usage: {},
    });
    return {
      ok,
      status: ok ? "agent_reply_ready" : "agent_turn_blocked",
      reason,
      text: formatFeishuPlainTextReply(ok
        ? "已按确认卡执行本卡绑定的操作。运行台账已记录安全结果；如需查看详情，请打开对应审批或运行台账。"
        : toolConfirmationFailureText(reason, result)),
      toolCalls: agentRuntime.toolCalls,
      safeSummary: {
        employeeId: runtimeEmployeeId,
        employee: safeEmployeeSummary(employee, runtimeEmployeeId),
        runtime: "tool_confirmation_direct_execution",
        agentRuntime,
      },
    };
  }

  function toolConfirmationExecutionFailureTurn({ employee = {}, reason = "approved_tool_call_failed", text = "" } = {}) {
    const safeReason = cleanShortText(reason) || "approved_tool_call_failed";
    return {
      ok: false,
      status: "agent_turn_blocked",
      reason: safeReason,
      text: formatFeishuPlainTextReply(text || "确认已收到，但本次操作未能继续执行；请重新发起，系统不会复用本次确认。"),
      safeSummary: {
        employeeId: runtimeEmployeeId,
        employee: safeEmployeeSummary(employee, runtimeEmployeeId),
        runtime: "tool_confirmation_direct_execution",
        agentRuntime: {
          adapter: "governed_tool_execution",
          mode: "tool_confirmation_direct_execution",
          realModelRequested: false,
          status: safeReason,
          blockedReason: safeReason,
          requestCount: 0,
          toolCallCount: 0,
          usage: {},
        },
      },
    };
  }

  function toolConfirmationFailureText(reason = "", result = {}) {
    if (reason === "tool_authorization_required") {
      return "请先在授权卡中完成飞书个人授权，然后重新发送刚才的请求。";
    }
    if (reason === "tool_target_rejected") {
      const diagnostics = targetRejectionDiagnosticText(result);
      return [
        "目标系统未接受本次操作。请检查目标系统的权限、参数或业务前置条件后重试。",
        diagnostics ? `安全诊断：${diagnostics}` : "",
      ].filter(Boolean).join("\n");
    }
    if (reason === "tool_confirmation_execution_not_verified") {
      return "确认已收到，但本次确认记录已失效、已使用或与当前执行上下文不匹配；系统不会执行外部写操作。请重新发起并使用最新确认卡。";
    }
    return cleanText(result?.message || result?.nextGate) ||
      "确认已收到，但目标 Tool 未返回成功结果；系统已停止，不会复用本次确认。请在运行台账查看安全状态后重新发起。";
  }

  function targetRejectionDiagnosticText(result = {}) {
    const httpStatus = Number(result?.httpStatus || 0);
    const xErrorCode = safeDiagnosticText(result?.xErrorCode, 120);
    const code = safeDiagnosticText(result?.code, 120);
    const msg = safeDiagnosticText(result?.msg, 240);
    const parts = [
      Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? `HTTP ${httpStatus}` : "",
      xErrorCode ? `目标错误码 ${xErrorCode}` : "",
      code ? `业务码 ${code}` : "",
      msg ? `目标短消息 ${msg}` : "",
    ];
    return parts.filter(Boolean).join("；");
  }

  function taskWithMaterialToolResults(runtimeTask = null, materialToolExecutor = null) {
    if (!runtimeTask || !materialToolExecutor) return runtimeTask;
    const materialPatch = materialToolExecutor.taskPatch();
    return {
      ...runtimeTask,
      materialRefs: (runtimeTask.materialRefs || []).map((item) => ({
        ...item,
        intakeStatus: materialPatch.statusByDigest[item.refDigest] || item.intakeStatus,
      })),
      materialProcessing: materialPatch.toolResults,
    };
  }

  function withRuntimeTask(safeContext = {}, runtimeTask = null) {
    if (!runtimeTask) return safeContext;
    return {
      ...safeContext,
      task: {
        id: runtimeTask.id,
        taskType: runtimeTask.taskType,
        status: runtimeTask.status,
        statusLabel: runtimeTask.statusLabel,
        nextGate: runtimeTask.nextGate,
        materialIntake: (runtimeTask.materialRefs || []).map((item) => ({
          refDigest: cleanShortText(item.refDigest),
          type: cleanShortText(item.type),
          intakeStatus: cleanShortText(item.intakeStatus),
        })),
        materialProcessing: (runtimeTask.materialProcessing || []).map((item) => ({
          toolId: cleanShortText(item.toolId),
          skillId: cleanShortText(item.skillId),
          status: cleanShortText(item.status),
          summary: cleanText(item.summary),
          groundTruthSource: cleanShortText(item.groundTruthSource),
          dataset: item.dataset || {},
          labels: Array.isArray(item.labels) ? item.labels.slice(0, 20) : [],
          riskCounts: item.riskCounts || {},
          risks: Array.isArray(item.risks) ? item.risks.slice(0, 8) : [],
          visualReview: item.visualReview || {},
          nextGate: cleanText(item.nextGate),
        })),
      },
    };
  }

  return {
    employeeId: runtimeEmployeeId,
    id: "responses-api",
    kind: "responses_api_agent_runtime",
    resolveDependencyContext,
    runApprovedToolCall,
    runTurn,
    status: "registered",
  };
}

function agentCancellationError() {
  const error = new Error("agent_turn_canceled");
  error.code = "agent_turn_canceled";
  return error;
}

function createFeishuAlgorithmAgentRuntime(options = {}) {
  return createFeishuEmployeeAgentRuntime({ ...options, employeeId: EMPLOYEE_ID });
}

function extractTextMessageContent(content = "") {
  if (!content || typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    return normalizeModelInputText(parsed?.text || parsed?.content || "");
  } catch {
    return normalizeModelInputText(content);
  }
}

function mockAgentReply({ employee = {}, employeeId = "", userText = "", safeContext = {} } = {}) {
  const dependencyContext = safeContext.dependencyContext || safeContext;
  const taskLine = safeContext.task?.id ? `任务编号：${safeContext.task.id}` : "";
  const callableSkills = dependencyContext.callableSkills || [];
  const mountedSkillNames = callableSkills.map((skill) => skill.name || skill.id).filter(Boolean);
  const skillLine = mountedSkillNames.length
    ? `当前飞书入口已开启：${mountedSkillNames.join(" / ")}`
    : "";
  const activeCapabilities = uniqueList(callableSkills.flatMap((skill) => skill.capabilities || []));
  const capabilityLines = activeCapabilities.length
    ? activeCapabilities.map((capability, index) => `${index + 1}. ${capability}`)
    : [];
  return formatFeishuPlainTextReply([
    `我是${employeeDisplayName(employee, employeeId)}，已通过 AI agent runtime 接手这条飞书消息。`,
    "",
    taskLine,
    /能|能够|可以|帮助|help/i.test(userText)
      ? capabilityLines.length
        ? ["我可以帮你：", ...capabilityLines].join("\n")
        : "当前入口还没有可确认的已开启能力，需要先查询控制面能力目录或补齐 Skill 绑定。"
      : activeCapabilities.length
        ? "我会先按当前开启 Skill 整理 evidenceRef、复现条件、输入输出和人工复核点。"
        : "我会先整理问题摘要，并提示需要查询控制面能力目录或挂载状态后再展开。",
    skillLine,
    "",
    "涉及远程执行、写回、代码提交或客户承诺时，我会先给出审批与人工复核步骤。",
  ].filter(Boolean).join("\n"));
}

function safeEmployeeSummary(employee = {}, employeeId = "") {
  return {
    id: cleanShortText(employee.id || employeeId),
    name: cleanShortText(employeeDisplayName(employee, employeeId)),
    version: cleanShortText(employee.version),
    promptVersion: cleanShortText(employee.promptVersion),
  };
}

function employeeDisplayName(employee = {}, employeeId = "") {
  return cleanShortText(employee.name || employee.displayName || employee.id || employeeId);
}

function requireEmployeeId(value) {
  const employeeId = cleanShortText(value);
  if (!employeeId) throw new TypeError("feishu_employee_agent_runtime_employee_id_required");
  return employeeId;
}

function leaseRefSegment(value) {
  return encodeURIComponent(cleanShortText(value));
}

function safeDiagnosticText(value = "", max = 240) {
  if (!["string", "number", "boolean"].includes(typeof value)) return "";
  return cleanText(value, max)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?)(authorization|token|password|secret|credential|cookie|api[-_ ]?key)\1\s*(?:[:=]|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2$1=[REDACTED]")
    .slice(0, max);
}

function uniqueList(items = []) {
  return [...new Set(items.map(cleanText).filter(Boolean))];
}

function buildFeishuPartialText({ reason = "agent_run_budget_reached", toolCallCount = 0 } = {}) {
  const reasonText = {
    agent_turn_canceled: "管理员已取消本次任务，运行已在安全边界停止。",
    agent_run_time_budget_reached: "本次任务已达到运行时间预算，系统已停止继续调用工具。",
    agent_run_token_budget_reached: "本次任务已达到模型用量预算，系统已停止继续调用工具。",
    agent_tool_loop_no_progress: "检测到重复的 Tool 调用与相同结果，系统已熔断无进展循环。",
  }[reason] || "本次任务已达到运行治理边界，系统已停止继续调用工具。";
  return [
    reasonText,
    toolCallCount ? `已保留 ${toolCallCount} 次受控 Tool/Skill 处理的安全证据。` : "任务尚未产生可确认的 Tool/Skill 结果。",
    reason === "agent_turn_canceled"
      ? "如需继续，请重新提交任务。"
      : "任务已标记为部分完成，可在任务监控复核后继续处理或取消。",
  ].join("\n");
}

function formatFeishuPlainTextReply(value = "") {
  let text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00A0]+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/[ ]{2,}/g, " ");

  text = text
    .replace(/([。！？；;:：])\s*(\d{1,2}[.、]\s+)/g, "$1\n$2")
    .replace(/\s+(\d{1,2}[.、]\s+)/g, "\n$1")
    .replace(/([。！？；;:：])\s+-\s+(?=\S)/g, "$1\n- ")
    .replace(/\n{3,}/g, "\n\n");

  const lines = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[ ]{2,}/g, " ").trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    lines.push(line);
  }
  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();

  const formatted = lines.join("\n").trim();
  return formatted || "我已收到消息，但本次没有生成可展示的回复。";
}

function normalizeAgentLoopPolicy(input = {}) {
  const envDurationSeconds = Number(process.env.FEISHU_ALGORITHM_AGENT_MAX_RUN_SECONDS);
  const envMaxTotalTokens = Number(process.env.FEISHU_ALGORITHM_AGENT_MAX_TOTAL_TOKENS);
  const envRepeatedToolThreshold = Number(process.env.FEISHU_ALGORITHM_AGENT_REPEATED_TOOL_THRESHOLD);
  return {
    maxDurationMs: clampInteger(
      input?.maxDurationMs,
      Number.isFinite(envDurationSeconds) ? envDurationSeconds * 1000 : DEFAULT_AGENT_LOOP_POLICY.maxDurationMs,
      0,
      48 * 60 * 60 * 1000,
    ),
    maxTotalTokens: clampInteger(
      input?.maxTotalTokens,
      Number.isFinite(envMaxTotalTokens) ? envMaxTotalTokens : DEFAULT_AGENT_LOOP_POLICY.maxTotalTokens,
      0,
      5_000_000,
    ),
    repeatedToolThreshold: clampInteger(
      input?.repeatedToolThreshold,
      Number.isFinite(envRepeatedToolThreshold) ? envRepeatedToolThreshold : DEFAULT_AGENT_LOOP_POLICY.repeatedToolThreshold,
      2,
      20,
    ),
  };
}

function describeAgentRuntimeFailure(error = {}) {
  switch (cleanShortText(error.code || error.message)) {
    case "model_rate_limited":
      return {
        reason: "model_rate_limited",
        text: "模型服务当前繁忙，本次任务未完成。请稍后重新发起任务；原任务不会重复执行。",
      };
    case "model_provider_unavailable":
      return {
        reason: "model_provider_unavailable",
        text: "模型服务暂时不可用，本次任务未完成。请稍后重新发起任务；原任务不会重复执行。",
      };
    case "model_response_contract_invalid":
      return {
        reason: "model_response_contract_invalid",
        text: "模型网关连续返回了不符合 Responses 协议的响应结构，本次附件工具没有执行。任务和安全材料引用已保留；请在模型服务恢复后重新发送处理指令。",
      };
    case "model_request_invalid":
      return {
        reason: "model_request_invalid",
        text: "模型服务拒绝了当前 Agent Tool 请求契约，本次文件工具没有执行。任务已保留，请由管理员检查 Provider 适配器和 Tool schema。",
      };
    case "model_request_failed":
      return {
        reason: "model_request_failed",
        text: "数字员工本次模型请求未完成，附件工具尚未执行。任务已保留；请稍后重试，若连续出现请由管理员检查 Provider 代理、鉴权和请求大小限制。",
      };
    case "provider_adapter_not_registered":
      return {
        reason: "provider_adapter_not_registered",
        text: "数字员工没有匹配当前 Provider 配置的运行适配器，本次附件工具没有执行。请管理员检查 Provider apiProtocol、authMode 和 upstreamDialect 配置。",
      };
    default:
      return {
        reason: "agent_runtime_error",
        text: "数字员工本次未能完成回复。任务已保留，请稍后重试或联系管理员查看运行状态。",
      };
  }
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

export {
  createFeishuAlgorithmAgentRuntime,
  createFeishuEmployeeAgentRuntime,
  describeAgentRuntimeFailure,
  extractTextMessageContent,
  formatFeishuPlainTextReply,
};
