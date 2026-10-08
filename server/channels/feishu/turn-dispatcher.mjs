import { assembleDigitalEmployeeDependencyContext } from "../../agent-runtime/dependency-context.mjs";
import { createRuntimeAdapterRegistry } from "../../agent-runtime/runtime-adapter-registry.mjs";
import { createAgentTurnDispatcher } from "../../agent-runtime/turn-dispatcher.mjs";
import { createToolCallConfirmationService } from "../../agent-runtime/tool-call-confirmation-service.mjs";
import {
  authorizeWorkspaceMutationApproval,
  workspaceMutationToolContract,
} from "../../agent-runtime/workspace-operations-v1.mjs";
import { managedOpenApiToolInvocationCheck } from "../../agent-runtime/managed-openapi-tool-executor.mjs";
import {
  SOURCE_SYSTEM_ID,
} from "../../feishu-integration-support.mjs";
import { responsePolicyForFeishuChannelExtension } from "./channel-extension-policy.mjs";

function createFeishuTurnDispatcher({
  agentRuntime,
  businessSkills = [],
  confirmationRepository = null,
  confirmationService = null,
  getBusinessSkills,
} = {}) {
  const effectiveConfirmationService = confirmationService || createToolCallConfirmationService({ repository: confirmationRepository });
  const runtimeAdapterRegistry = createRuntimeAdapterRegistry({
    adapters: [agentRuntime],
    defaultAdapterId: agentRuntime?.id || "responses-api",
  });
  const dispatcher = createAgentTurnDispatcher({
    buildInvocationCheck: ({ employee = {}, input = {} } = {}) => (
      buildFeishuInvocationCheck({ employee, input })
    ),
    buildToolInvocationCheck: ({ allOperations = [], dependencyContext = {}, employee = {}, operation = null, toolCall = {}, turn = {} } = {}) => (
      buildFeishuToolInvocationCheck({
        allOperations,
        confirmation: turn.toolConfirmation,
        confirmationContext: turn.confirmationContext,
        confirmationService: effectiveConfirmationService,
        dependencyContext,
        employee,
        operation,
        toolCall,
      })
    ),
    resolveDependencyContext: ({ connection = {}, employee = {} } = {}) => assembleDigitalEmployeeDependencyContext({
      businessSkills,
      channel: {
        channel: "feishu",
        sourceSystemId: SOURCE_SYSTEM_ID,
        status: connection.status,
        receiveMode: connection.eventSubscription?.receiveMode,
      },
      employee,
      getBusinessSkills,
      workerBinding: connection.workerBinding || {},
    }),
    resolveResponsePolicy: responsePolicyForFeishuChannelExtension,
    runtimeAdapterRegistry,
  });
  return {
    ...dispatcher,
    approvedToolCall: (input) => effectiveConfirmationService.approvedToolCall(input),
    pendingToolConfirmationRequests: (context) => effectiveConfirmationService.pendingRequests(context),
    runApprovedToolCall: async ({ approvedToolCall = null, decision = {}, runtimeContext = {}, runtimeInput = {} } = {}) => {
      if (!decision.runtimeEligible) {
        return {
          ok: false,
          status: "agent_turn_blocked",
          reason: decision.invocationCheck?.reason || "invocation_blocked",
          text: decision.invocationCheck?.nextGate || "本次任务未通过调用门禁，请联系管理员检查员工状态和调用策略。",
        };
      }
      if (typeof agentRuntime?.runApprovedToolCall !== "function") {
        return {
          ok: false,
          status: "agent_turn_blocked",
          reason: "approved_tool_call_runtime_unavailable",
          text: "确认已收到，但当前运行器不能执行已确认 Tool；系统不会复用本次确认。",
        };
      }
      return agentRuntime.runApprovedToolCall({
        approvedToolCall,
        runtimeContext,
        ...runtimeInput,
      });
    },
  };
}

function buildFeishuInvocationCheck({ employee = {}, input = {} } = {}) {
  if (employee.status !== "在线" && employee.status !== "试运行") {
    return {
      status: "blocked",
      outcome: "employee_not_enabled",
      reason: "employee_not_enabled",
      nextGate: "该数字员工尚未启用；请完成员工配置后再接收对话。",
    };
  }
  return {
    status: "allowed",
    outcome: "employee_runtime_admitted",
    reason: "feishu_channel_admission_passed",
    requested: {
      action: String(input.action || "read").trim(),
      skillId: String(input.skillId || "").trim(),
    },
    nextGate: "消息已进入该员工的统一 Agent Runtime；Provider 由当前运行租约选择，Tool 调用在执行时独立授权。",
  };
}

function buildFeishuToolInvocationCheck({
  allOperations = [],
  confirmation = null,
  confirmationContext = {},
  confirmationService = null,
  dependencyContext = {},
  employee = {},
  operation = null,
  toolCall = {},
} = {}) {
  const toolName = String(toolCall.name || "").trim();
  if (operation?.toolId) {
    return managedOpenApiToolInvocationCheck({
      allOperations,
      confirmation,
      confirmationContext,
      confirmationService,
      employee,
      operation,
      toolCall,
    });
  }
  const workspaceContract = workspaceMutationToolContract(toolName);
  const contracts = {
    prepare_channel_input: {
      toolId: "safe-archive-intake",
      action: "read",
      risk: "medium",
      scope: "current_turn_authorized_channel_attachment",
      writeback: "none",
      providerDataScope: "ephemeral_model_input_or_workspace_reference",
    },
    list_workspace_files: {
      toolId: "workspace-files",
      action: "read",
      risk: "low",
      scope: "current_agent_session_workspace",
      writeback: "none",
      providerDataScope: "workspace_metadata_only",
    },
    read_workspace_text: {
      toolId: "workspace-files",
      action: "read",
      risk: "low",
      scope: "current_agent_session_workspace",
      writeback: "none",
      providerDataScope: "requested_workspace_text_ephemeral",
    },
    inspect_workspace_image: {
      toolId: "workspace-files",
      action: "read",
      risk: "low",
      scope: "current_agent_session_workspace",
      writeback: "none",
      providerDataScope: "requested_workspace_image_ephemeral",
    },
    inspect_workspace_file: {
      toolId: "workspace-files",
      action: "read",
      risk: "low",
      scope: "current_agent_session_workspace",
      writeback: "none",
      providerDataScope: "requested_workspace_file_ephemeral",
    },
    export_visual_evidence: {
      toolId: "workspace-files",
      action: "draft",
      risk: "medium",
      scope: "current_agent_session_visual_evidence_output",
      writeback: "channel_attachment_after_agent_request",
      providerDataScope: "ephemeral_visual_evidence_placeholders_only",
    },
    write_workspace_text: {
      toolId: "workspace-files",
      action: "draft",
      risk: "medium",
      scope: "current_agent_session_workspace_output",
      writeback: "channel_attachment_after_agent_request",
      providerDataScope: "model_generated_text_only",
    },
    write_report_bundle: {
      toolId: "workspace-files",
      action: "draft",
      risk: "medium",
      scope: "current_agent_session_report_bundle_output",
      writeback: "channel_attachment_after_agent_request",
      providerDataScope: "model_generated_html_and_ephemeral_visual_evidence_placeholders",
    },
    run_mounted_skill: {
      toolId: "mounted-skill-harness",
      action: "draft",
      risk: "medium",
      scope: "current_turn_prepared_material",
      writeback: "none",
      providerDataScope: "skill_declared_ephemeral_evidence_only",
    },
  };
  const contract = workspaceContract || contracts[toolName];
  if (!contract) {
    return {
      status: "rejected",
      outcome: "tool_not_declared",
      reason: "tool_not_declared_for_feishu_runtime",
      nextGate: "该 Tool 未在当前飞书数字员工运行契约中声明。",
    };
  }
  const requestedSkillId = String(toolCall.arguments?.skillId || "").trim();
  if (toolName === "run_mounted_skill" && !dependencyContext.skillScope?.callableSkillIds?.includes(requestedSkillId)) {
    return {
      status: "rejected",
      outcome: "skill_scope_rejected",
      reason: "skill_not_callable_in_current_scope",
      nextGate: "该 Skill 不在当前员工、Channel 与治理状态共同允许的调用范围内。",
    };
  }
  if (toolName === "run_mounted_skill" && !dependencyContext.skillScope?.deterministicHarnessSkillIds?.includes(requestedSkillId)) {
    return {
      status: "rejected",
      outcome: "skill_execution_mode_rejected",
      reason: "skill_not_deterministic_harness",
      nextGate: "该 Skill 是执行指引或 Tool 工作流，不能作为确定性 Harness 直接运行。",
    };
  }
  const decision = buildFeishuInvocationCheck({
    employee,
    input: { action: contract.policyAction || contract.action, skillId: requestedSkillId },
  });
  if (workspaceContract && decision.status === "allowed") {
    const approval = authorizeWorkspaceMutationApproval({
      confirmation,
      confirmationContext,
      confirmationService,
      toolCall,
    });
    if (approval.status !== "allowed") return { ...decision, ...approval, toolContract: contract };
  }
  return { ...decision, toolContract: contract };
}

export { buildFeishuInvocationCheck, buildFeishuToolInvocationCheck, createFeishuTurnDispatcher };
