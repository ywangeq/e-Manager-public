const TASK_INTENTS = new Set(["task_request"]);

function createAgentTurnDispatcher({
  buildInvocationCheck = () => ({ status: "blocked", reason: "invocation_policy_not_configured" }),
  buildToolInvocationCheck = () => ({ status: "blocked", reason: "tool_invocation_policy_not_configured" }),
  resolveDependencyContext = () => ({}),
  resolveResponsePolicy = null,
  runtimeAdapterRegistry,
} = {}) {
  function prepareTurn({ connection = {}, employee = {}, priorSessionReferences = [], turn = {}, runtimeTask = null } = {}) {
    const dependencyContext = resolveDependencyContext({ connection, employee, turn, runtimeTask });
    const turnIntent = classifyTurnIntent({ turn });
    const defaultResponsePolicy = responsePolicyForIntent(turnIntent);
    const responsePolicy = typeof resolveResponsePolicy === "function"
      ? resolveResponsePolicy({ connection, employee, turn, turnIntent, defaultResponsePolicy }) || defaultResponsePolicy
      : defaultResponsePolicy;
    const taskEligible = TASK_INTENTS.has(turnIntent) && responsePolicy.allowTask;
    const invocationCheck = responsePolicy.allowModel
      ? buildInvocationCheck({ employee, highRisk: false, input: { action: taskEligible ? "draft" : "read" } })
      : directInvocationCheck(turnIntent);
    const runtimeEligible = responsePolicy.allowModel && invocationCheck.status === "allowed";
    return {
      authorizationEmployee: employee,
      dependencyContext,
      connection,
      invocationCheck,
      priorSessionReferences,
      responsePolicy,
      runtimeAdapter: runtimeAdapterRegistry?.defaultAdapterId || "",
      runtimeEligible,
      taskEligible,
      turn,
      turnIntent,
    };
  }

  async function runTurn({ decision = {}, runtimeContext = {}, runtimeInput = {} } = {}) {
    if (decision.responsePolicy?.mode === "direct_feedback") {
      return directTurn("收到，反馈已进入质量闭环。", "feedback_acknowledged", decision);
    }
    if (decision.responsePolicy?.mode === "direct_fixed_reply") {
      return directTurn(
        decision.responsePolicy.fixedReplyText || "该飞书入口当前仅返回已配置的业务入口。",
        "fixed_channel_entry_reply",
        decision,
      );
    }
    if (!decision.responsePolicy?.allowModel) {
      return directTurn("消息中没有可处理的文本或材料。", "empty_turn", decision, false);
    }
    if (!decision.runtimeEligible) {
      return directTurn(
        decision.invocationCheck?.nextGate || "本次任务未通过调用门禁，请联系管理员检查员工状态和调用策略。",
        decision.invocationCheck?.reason || "invocation_blocked",
        decision,
        false,
      );
    }
    return runtimeAdapterRegistry.runTurn({
      adapterId: decision.runtimeAdapter,
      runtimeContext,
      ...runtimeInput,
    });
  }

  function authorizeToolCall({ allOperations = [], decision = {}, operation = null, toolCall = {} } = {}) {
    return buildToolInvocationCheck({
      connection: decision.connection,
      dependencyContext: decision.dependencyContext,
      employee: decision.authorizationEmployee || {},
      allOperations,
      operation,
      toolCall,
      turn: decision.turn,
    });
  }

  return { authorizeToolCall, prepareTurn, runTurn };
}

function classifyTurnIntent({ turn = {} } = {}) {
  if (turn.feedback) return "feedback";
  if (turn.hasMaterial) return "task_request";
  const text = normalizeText(turn.text);
  if (!text) return "unsupported";
  return "conversation";
}

function responsePolicyForIntent(turnIntent = "unsupported") {
  const policies = {
    conversation: { id: "session-agent-loop.v2", mode: "runtime", allowTask: false, allowModel: true, capabilityDisclosure: "only_when_requested_or_blocking" },
    task_request: { id: "governed-runtime-answer.v1", mode: "runtime", allowTask: true, allowModel: true, capabilityDisclosure: "only_when_blocking" },
    feedback: { id: "quality-feedback.v1", mode: "direct_feedback", allowTask: false, allowModel: false, capabilityDisclosure: "never" },
    unsupported: { id: "unsupported-turn.v1", mode: "direct_unsupported", allowTask: false, allowModel: false, capabilityDisclosure: "never" },
  };
  return policies[turnIntent] || policies.unsupported;
}

function directInvocationCheck(turnIntent = "unsupported") {
  return {
    status: "not_required",
    outcome: "handled_without_runtime",
    reason: `${turnIntent}_direct_response`,
    nextGate: "本轮不创建运行时任务，不调用模型。",
  };
}

function directTurn(text, reason, decision, ok = true) {
  return {
    ok,
    status: "agent_reply_ready",
    reason,
    text,
    safeSummary: {
      turnIntent: decision.turnIntent,
      responsePolicy: decision.responsePolicy,
      agentRuntime: {
        mode: "control_plane_direct",
        adapter: "control-plane-direct",
        realModelRequested: false,
        status: reason,
        requestCount: 0,
        toolCallCount: 0,
      },
    },
  };
}

function normalizeText(value = "") {
  return String(value || "")
    .replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
    .replace(/(?:^|\s)@?_user_\d+(?=\s|$)/gi, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export {
  TASK_INTENTS,
  classifyTurnIntent,
  createAgentTurnDispatcher,
  responsePolicyForIntent,
};
