import {
  EMPLOYEE_ID,
  SOURCE_SYSTEM_ID,
  cleanShortText,
} from "../../feishu-integration-support.mjs";

export function withAlgorithmRuntimeEvidence(employees = [], { store } = {}) {
  return withFeishuEmployeeRuntimeEvidence(employees, { employeeId: EMPLOYEE_ID, store });
}

export function withFeishuRuntimeEvidence(employees = [], { store } = {}) {
  const connections = typeof store?.readConnections === "function" ? store.readConnections() : {};
  // Reuse these reads only within this projection; the next call sees fresh state.
  let sharedRecords;
  return employees.map((employee) => {
    const connection = connections[employee.id];
    if (!connection) return employee;
    sharedRecords ??= {
      messageTests: typeof store?.readMessageTests === "function" ? store.readMessageTests() : [],
      runtimeTasks: typeof store?.readRuntimeTasks === "function" ? store.readRuntimeTasks() : [],
    };
    const evidence = buildEmployeeRuntimeEvidence({ employeeId: employee.id, connection, ...sharedRecords });
    return {
      ...employee,
      feishuApplicationEnabled: Boolean(connection.applicationEnabled),
      feishuAccessEnabled: Boolean(connection.applicationEnabled),
      channelConfig: {
        ...(employee.channelConfig || {}),
        feishu: {
          ...(employee.channelConfig?.feishu || {}),
          applicationEnabled: Boolean(connection.applicationEnabled),
          accessEnabled: Boolean(connection.applicationEnabled),
          sourceSystemId: SOURCE_SYSTEM_ID,
          ...(evidence ? {
            status: evidence.feishuStatus,
            connectionStatus: evidence.channelStatus,
            lastRealTestStatus: evidence.runtimeStatus,
            lastRealTestAt: evidence.testedAt,
            statusSource: evidence.statusSource,
          } : {}),
        },
      },
      ...(evidence ? { runtimeEvidence: evidence, runtimeUsage: evidence.runtimeUsage } : {}),
    };
  });
}

export function withFeishuEmployeeRuntimeEvidence(employees = [], { employeeId, store } = {}) {
  const targetEmployeeId = requireEmployeeId(employeeId);
  const evidence = buildFeishuEmployeeRuntimeEvidence({ employeeId: targetEmployeeId, store });
  if (!evidence) return employees;
  return employees.map((employee) => {
    if (employee.id !== targetEmployeeId) return employee;
    return {
      ...employee,
      channelConfig: {
        ...(employee.channelConfig || {}),
        feishu: {
          ...(employee.channelConfig?.feishu || {}),
          status: evidence.feishuStatus,
          connectionStatus: evidence.channelStatus,
          lastRealTestStatus: evidence.runtimeStatus,
          lastRealTestAt: evidence.testedAt,
          statusSource: evidence.statusSource,
        },
      },
      runtimeEvidence: evidence,
      runtimeUsage: evidence.runtimeUsage,
    };
  });
}

export function buildAlgorithmEmployeeRuntimeEvidence({ store } = {}) {
  return buildFeishuEmployeeRuntimeEvidence({ employeeId: EMPLOYEE_ID, store });
}

export function buildFeishuEmployeeRuntimeEvidence({ employeeId, store } = {}) {
  const targetEmployeeId = requireEmployeeId(employeeId);
  const messageTests = typeof store?.readMessageTests === "function" ? store.readMessageTests() : [];
  const runtimeTasks = typeof store?.readRuntimeTasks === "function" ? store.readRuntimeTasks() : [];
  const connection = typeof store?.readConnection === "function" ? store.readConnection(targetEmployeeId) : {};
  return buildEmployeeRuntimeEvidence({ employeeId: targetEmployeeId, messageTests, runtimeTasks, connection });
}

function buildEmployeeRuntimeEvidence({ employeeId, messageTests, runtimeTasks, connection }) {
  const targetEmployeeId = requireEmployeeId(employeeId);
  const agentReplies = messageTests.filter((messageTest) => isEmployeeAgentReplyMessageTest(messageTest, targetEmployeeId));
  const successfulReplies = agentReplies.filter(isSuccessfulAgentReply);
  const latestReply = successfulReplies[0] || null;
  const latestEventAt = cleanShortText(
    latestReply?.updatedAt ||
    latestReply?.submittedAt ||
    connection.eventSubscription?.lastEventAt ||
    connection.lastEventSummary?.receivedAt
  );
  if (!latestReply && connection.status !== "connected") return null;

  const channelStatus = latestReply?.status || connection.lastEventSummary?.replyStatus || connection.status;
  const runtimeUsage = buildEmployeeRuntimeUsage(successfulReplies, runtimeTasks, targetEmployeeId);
  return {
    employeeId: targetEmployeeId,
    sourceSystemId: SOURCE_SYSTEM_ID,
    statusSource: latestReply ? "real_conversation" : "feishu_connection",
    healthStatus: "passed",
    modelStatus: "passed",
    runtimeStatus: latestReply ? "agent_reply_sent" : connection.status,
    feishuStatus: connection.status === "connected" ? "connected" : "agent_reply_sent",
    channelStatus,
    channelLabel: "飞书 AI agent 已完成真实回复",
    evidenceLabel: "飞书 AI agent 已完成真实回复",
    testedAt: latestEventAt,
    lastSuccessfulConversationAt: latestEventAt,
    recentConversationCount: successfulReplies.length,
    runtimeUsage,
  };
}

function isAlgorithmAgentReplyMessageTest(messageTest = {}) {
  return isEmployeeAgentReplyMessageTest(messageTest, EMPLOYEE_ID);
}

function isEmployeeAgentReplyMessageTest(messageTest = {}, employeeId = "") {
  return messageTest.employeeId === requireEmployeeId(employeeId) &&
    (messageTest.delivery?.mode === "feishu_ai_agent_reply" || messageTest.invocationCheck?.outcome === "ai_agent_runtime_reply");
}

function isSuccessfulAgentReply(messageTest = {}) {
  const status = cleanShortText(messageTest.status || messageTest.delivery?.status);
  return Boolean(messageTest.delivery?.sent) ||
    ["agent_reply_sent", "send_skipped_for_local_test"].includes(status) ||
    /sent|passed|通过|发送/.test(status);
}

function buildAlgorithmRuntimeUsage(successfulReplies = [], runtimeTasks = []) {
  return buildEmployeeRuntimeUsage(successfulReplies, runtimeTasks, EMPLOYEE_ID);
}

function buildEmployeeRuntimeUsage(successfulReplies = [], runtimeTasks = [], employeeId = "") {
  const targetEmployeeId = requireEmployeeId(employeeId);
  const dates = successfulReplies
    .map((reply) => cleanShortText(reply.updatedAt || reply.submittedAt))
    .filter(Boolean);
  const companionDays = new Set(dates.map((value) => value.slice(0, 10)).filter(Boolean)).size || undefined;
  return {
    source: "feishu_agent_runtime",
    sourceLabel: "飞书真实回合",
    windowLabel: "近 12 周",
    companionDays,
    recentMessages: successfulReplies.length,
    completedTasks: undefined,
    runtimeTaskDrafts: runtimeTasks.filter((task) => task.employeeId === targetEmployeeId).length,
    updatedAt: dates[0] || "",
    dailyActivity: activityGridFromDates(dates),
  };
}

function requireEmployeeId(value = "") {
  const employeeId = cleanShortText(value);
  if (!employeeId) throw new Error("feishu runtime evidence employeeId required");
  return employeeId;
}

function activityGridFromDates(dates = [], now = new Date()) {
  const latestWeekIndex = 12;
  return dates.flatMap((value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return [];
    const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
    if (diffDays < 0 || diffDays >= 7 * 13) return [];
    return [{
      dayIndex: date.getDay(),
      weekIndex: latestWeekIndex - Math.floor(diffDays / 7),
      count: 1,
    }];
  });
}

function startOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
