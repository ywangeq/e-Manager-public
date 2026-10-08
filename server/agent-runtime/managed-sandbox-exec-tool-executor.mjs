import {
  CURRENT_TASK_WORKSPACE_SCOPE,
  MANAGED_SANDBOX_EXECUTION_ACTION_ID,
} from "./managed-sandbox-profile-registry-v1.mjs";
import {
  MANAGED_SANDBOX_TOOL_ID,
  managedSandboxToolAuthorizationContract,
} from "./managed-sandbox-execution-v1.mjs";

const TOOL_NAME = "managed_sandbox__execute";
const MAX_COMMAND_LENGTH = 12_000;
const DEVICE_SESSION_ID = /^dws_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

// This is a normal Agent Tool executor. It prepares a private dispatch only;
// it neither starts a Runner nor returns command/output data to the model.
function createManagedSandboxExecToolExecutor({
  authorizeToolCall = null,
  deviceSessionId = "",
  employee = {},
  prepareService = null,
  runtimeTask = null,
  session = null,
  taskOwnership = null,
  workspaceInputDigest = "",
} = {}) {
  const binding = managedSandboxBinding(employee);
  const context = readyContext({ deviceSessionId, prepareService, runtimeTask, session, taskOwnership, workspaceInputDigest });
  const available = Boolean(binding && context);

  async function execute(toolCall = {}, { signal = null } = {}) {
    if (!available) return blocked("sandbox_dispatch_context_unavailable", "当前任务没有可用的本地 Sandbox 执行上下文。");
    if (signal?.aborted) return blocked("agent_turn_canceled", "任务已取消，受管 Sandbox 未开始准备。");
    const commandText = commandFor(toolCall);
    if (!commandText) return blocked("tool_arguments_invalid", "受管 Sandbox 命令参数无效。");
    let authorization;
    try {
      authorization = typeof authorizeToolCall === "function"
        ? await authorizeToolCall(governedSandboxToolCall(), sandboxOperation(), [sandboxOperation()])
        : null;
    } catch {
      return blocked("tool_invocation_blocked", "受管 Sandbox 调用未通过执行门禁。");
    }
    if (authorization?.status !== "allowed" || !sameSandboxAuthorization(authorization)) {
      return blocked("tool_invocation_blocked", "受管 Sandbox 调用未通过执行门禁。");
    }
    let prepared;
    try {
      prepared = await prepareService.prepare({
        commandText,
        deviceSessionId: context.deviceSessionId,
        runtimeTask: context.runtimeTask,
        session: context.session,
        taskOwnership: context.taskOwnership,
        // The grant contract excludes invocation UI guidance (reason/nextGate).
        toolAuthorization: Object.freeze({ status: authorization.status, toolContract: authorization.toolContract }),
        workspaceInputDigest: context.workspaceInputDigest,
      }, { signal });
    } catch {
      return blocked("sandbox_dispatch_unavailable", "受管 Sandbox 当前无法准备执行。");
    }
    if (prepared?.reason === "sandbox_execution_unknown") {
      return blocked("external_effect_unknown", "受管 Sandbox 的执行终态未知，已停止自动重放。请核对任务结果后提交新任务。");
    }
    if (prepared?.reason === "sandbox_execution_canceled" || signal?.aborted) {
      return blocked("agent_turn_canceled", "任务已取消，受管 Sandbox 已在安全边界停止。");
    }
    if (prepared?.status !== "completed") {
      return blocked(safePrepareReason(prepared?.reason), "受管 Sandbox 当前未完成执行。");
    }
    return Object.freeze({
      ok: true,
      status: "completed",
      toolId: MANAGED_SANDBOX_TOOL_ID,
      summary: "当前 Desktop 的受管 Sandbox 操作已完成。",
    });
  }

  return Object.freeze({
    agentResultFor: safeAgentResult,
    execute,
    runtimeStatus: () => available
      ? Object.freeze({ toolId: MANAGED_SANDBOX_TOOL_ID, status: "available", writeback: "none" })
      : Object.freeze({ toolId: MANAGED_SANDBOX_TOOL_ID, status: "unavailable", reason: "sandbox_dispatch_context_unavailable", message: "当前任务没有可用的本地 Sandbox 执行上下文。" }),
    safeActivityDescriptor: () => Object.freeze({
      actionCode: "runner.execute",
      kind: "tool",
      subjectId: "managed-runner",
    }),
    safeToolCatalog: () => available ? [Object.freeze({
      name: TOOL_NAME,
      toolId: MANAGED_SANDBOX_TOOL_ID,
      displayName: "运行受管 Sandbox 操作",
    })] : [],
    toolDefinitions: () => available ? [Object.freeze({
      type: "function",
      name: TOOL_NAME,
      description: "在当前任务的 Desktop Device workspace 中准备一次受管 Sandbox 操作。该 workspace 与 Center Agent workspace 隔离：input/ 仅含用户为本任务授权的原始材料，work/、output/、tmp/ 保留同一任务先前 Sandbox 操作创建的文件；Center workspace Tool 创建的文件不会自动出现。命令从 Device workspace 根目录执行，所需脚本须由命令在该 workspace 内创建或以内联方式运行，交付文件应写入 output/。命令、路径、环境变量和原始输出不会进入界面或安全活动记录。",
      strict: true,
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({
          commandText: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: MAX_COMMAND_LENGTH,
            description: "在 Desktop Device workspace 根目录运行的命令。只能依赖 input/ 中的授权原始材料和该任务已存在的本地文件；不要引用 Center Agent workspace 路径。",
          }),
        }),
        required: Object.freeze(["commandText"]),
        additionalProperties: false,
      }),
    })] : [],
  });
}

function managedSandboxToolInvocationCheck({ employee = {}, operation = null, toolCall = {} } = {}) {
  if (!managedSandboxBinding(employee) || !sameSandboxOperation(operation) || !sameGovernedSandboxToolCall(toolCall)) {
    return Object.freeze({ status: "blocked", reason: "tool_invocation_not_allowed", nextGate: "当前数字员工未授权该受管 Sandbox operation。" });
  }
  return Object.freeze({
    status: "allowed",
    reason: "managed_sandbox_operation_allowed",
    nextGate: "已通过受管 Sandbox Tool、任务工作区和无业务写回边界。",
    toolContract: managedSandboxToolAuthorizationContract(),
  });
}

function managedSandboxBinding(employee = {}) {
  const bindings = Array.isArray(employee?.toolBindings) ? employee.toolBindings : employee?.tools || [];
  return bindings.find((binding) => [binding?.id, binding?.toolId]
    .some((value) => String(value || "").trim() === MANAGED_SANDBOX_TOOL_ID) && binding?.enabled !== false &&
    String(binding?.writebackBoundary || "none") === "none") || null;
}

function sandboxOperation() {
  return Object.freeze({
    action: "run",
    capabilities: Object.freeze([MANAGED_SANDBOX_EXECUTION_ACTION_ID]),
    confirmationPolicy: "task_capability_grant",
    operationId: MANAGED_SANDBOX_EXECUTION_ACTION_ID,
    risk: "controlled_execution",
    scope: Object.freeze([CURRENT_TASK_WORKSPACE_SCOPE]),
    toolId: MANAGED_SANDBOX_TOOL_ID,
    writebackBoundary: "none",
  });
}

function governedSandboxToolCall() {
  const operation = sandboxOperation();
  return Object.freeze({
    name: TOOL_NAME,
    toolId: operation.toolId,
    operationId: operation.operationId,
    action: operation.action,
    capabilities: operation.capabilities,
    confirmationPolicy: operation.confirmationPolicy,
    risk: operation.risk,
    scope: operation.scope,
    writebackBoundary: operation.writebackBoundary,
    arguments: Object.freeze({}),
  });
}

function readyContext({ deviceSessionId, prepareService, runtimeTask, session, taskOwnership, workspaceInputDigest }) {
  const normalizedDeviceSessionId = String(deviceSessionId || "").trim().toLowerCase();
  const normalizedDigest = String(workspaceInputDigest || "").trim().toLowerCase();
  const taskId = String(runtimeTask?.taskId || runtimeTask?.id || "").trim();
  if (!DEVICE_SESSION_ID.test(normalizedDeviceSessionId) || !SHA256.test(normalizedDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(taskId) || !session || !taskOwnership ||
    typeof prepareService?.prepare !== "function") return null;
  return Object.freeze({
    deviceSessionId: normalizedDeviceSessionId,
    prepareService,
    runtimeTask,
    session,
    taskOwnership,
    workspaceInputDigest: normalizedDigest,
  });
}

function commandFor(toolCall = {}) {
  if (!toolCall || typeof toolCall !== "object" || toolCall.name !== TOOL_NAME ||
    !toolCall.arguments || typeof toolCall.arguments !== "object" || Array.isArray(toolCall.arguments) ||
    Object.keys(toolCall.arguments).length !== 1 || !Object.hasOwn(toolCall.arguments, "commandText")) return "";
  const command = toolCall.arguments.commandText;
  return typeof command === "string" && command.trim() && command.length <= MAX_COMMAND_LENGTH && !command.includes("\0") ? command : "";
}

function sameSandboxAuthorization(value = null) {
  const expected = managedSandboxToolAuthorizationContract();
  const contract = value?.toolContract;
  return value?.status === "allowed" && contract && typeof contract === "object" &&
    contract.contractVersion === expected.contractVersion && contract.toolId === expected.toolId &&
    contract.action === expected.action && contract.policyAction === expected.policyAction &&
    contract.risk === expected.risk && contract.confirmationPolicy === expected.confirmationPolicy &&
    contract.writebackBoundary === expected.writebackBoundary && sameStrings(contract.scope, expected.scope) &&
    sameStrings(contract.capabilities, expected.capabilities);
}

function sameSandboxOperation(value = null) {
  const expected = sandboxOperation();
  return value && value.toolId === expected.toolId && value.operationId === expected.operationId && value.action === expected.action &&
    value.risk === expected.risk && value.confirmationPolicy === expected.confirmationPolicy &&
    value.writebackBoundary === expected.writebackBoundary && sameStrings(value.scope, expected.scope) &&
    sameStrings(value.capabilities, expected.capabilities);
}

function sameGovernedSandboxToolCall(value = null) {
  const expected = governedSandboxToolCall();
  return value && value.name === expected.name && value.toolId === expected.toolId && value.operationId === expected.operationId &&
    value.action === expected.action && value.risk === expected.risk && value.confirmationPolicy === expected.confirmationPolicy &&
    value.writebackBoundary === expected.writebackBoundary && sameStrings(value.scope, expected.scope) &&
    sameStrings(value.capabilities, expected.capabilities) && value.arguments && Object.keys(value.arguments).length === 0;
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function blocked(error, message) {
  return Object.freeze({ ok: false, status: "blocked", toolId: MANAGED_SANDBOX_TOOL_ID, error, message });
}

function safePrepareReason(value) {
  const reason = String(value || "").trim();
  return /^sandbox_[a-z0-9_]{1,120}$/.test(reason) || /^managed_sandbox_[a-z0-9_]{1,120}$/.test(reason) ||
    /^desktop_sandbox_[a-z0-9_]{1,120}$/.test(reason)
    ? reason
    : "sandbox_dispatch_unavailable";
}

function safeAgentResult(result = {}) {
  return result?.ok === true
    ? Object.freeze({ ok: true, status: "completed", toolId: MANAGED_SANDBOX_TOOL_ID, summary: "已准备当前 Desktop 的受管 Sandbox 操作。" })
    : Object.freeze({ ok: false, status: "blocked", toolId: MANAGED_SANDBOX_TOOL_ID, error: String(result?.error || "sandbox_dispatch_unavailable").slice(0, 120) });
}

export {
  MANAGED_SANDBOX_TOOL_ID,
  TOOL_NAME as MANAGED_SANDBOX_EXEC_TOOL_NAME,
  createManagedSandboxExecToolExecutor,
  managedSandboxBinding,
  managedSandboxToolInvocationCheck,
};
