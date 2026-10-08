import { feishuApplicationEnabled, feishuChannelConfigured } from "./digitalEmployeeOverview.js";

function text(value) {
  return String(value || "").trim();
}

function includesAny(value, patterns = []) {
  const normalized = text(value).toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

function firstText(...values) {
  return values.map(text).find(Boolean) || "";
}

function hasRealTestEvidence(...values) {
  return values.some((value) => Boolean(text(value)));
}

function statusPassed(value) {
  return includesAny(value, ["ok", "pass", "passed", "healthy", "connected", "online", "sent", "通过", "正常", "已连接"]);
}

function statusFailed(value) {
  return includesAny(value, ["fail", "failed", "error", "blocked", "down", "offline", "timeout", "失败", "异常", "不可用", "离线"]);
}

function modelHealth(modelBinding = {}, runtimeEvidence = {}) {
  const modelId = text(modelBinding.modelId || modelBinding.model);
  const testStatus = firstText(
    runtimeEvidence.healthStatus,
    runtimeEvidence.modelStatus,
    runtimeEvidence.runtimeStatus,
    modelBinding.healthStatus,
    modelBinding.lastProbeStatus,
    modelBinding.lastTestStatus,
    modelBinding.runtimeTestStatus,
  );
  const testedAt = firstText(
    runtimeEvidence.testedAt,
    runtimeEvidence.lastSuccessfulConversationAt,
    modelBinding.healthCheckedAt,
    modelBinding.lastProbeAt,
    modelBinding.lastTestedAt,
    modelBinding.runtimeTestedAt,
  );
  const hasTest = hasRealTestEvidence(testedAt) || modelBinding.statusSource === "real_test" || runtimeEvidence.statusSource === "real_conversation";

  if (!modelId) {
    return {
      id: "model",
      label: "模型",
      value: "未绑定",
      tone: "bad",
      detail: "缺少模型绑定，不能进入运行态。",
      requiresTest: false,
    };
  }

  if (hasTest && statusFailed(testStatus)) {
    return {
      id: "model",
      label: "模型",
      value: "模型异常",
      tone: "bad",
      detail: testStatus || "模型真实探活失败。",
      testedAt,
      requiresTest: false,
    };
  }

  if (hasTest && statusPassed(testStatus)) {
    return {
      id: "model",
      label: "模型",
      value: "模型 OK",
      tone: "good",
      detail: runtimeEvidence.evidenceLabel || `${runtimeEvidence.model || modelBinding.model || modelId}${modelBinding.modelLevelLabel ? ` · ${modelBinding.modelLevelLabel}` : ""}`,
      testedAt,
      requiresTest: false,
    };
  }

  return {
    id: "model",
    label: "模型",
    value: "待真实测试",
    tone: "warn",
    detail: `${modelBinding.model || modelId}${modelBinding.modelLevelLabel ? ` · ${modelBinding.modelLevelLabel}` : ""} 已配置，尚无真实探活证据。`,
    requiresTest: true,
  };
}

function feishuHealth(employee = {}, runtimeEvidence = {}) {
  const config = employee.channelConfig?.feishu || {};
  const hasRuntimeEvidence = runtimeEvidence.employeeId === employee.id &&
    (runtimeEvidence.sourceSystemId === "feishu-digital-employee-entry" || runtimeEvidence.channelStatus || runtimeEvidence.feishuStatus);
  const hasFeishuEntry = (feishuApplicationEnabled(employee) && feishuChannelConfigured(employee)) || hasRuntimeEvidence;
  const testStatus = firstText(
    runtimeEvidence.feishuStatus,
    runtimeEvidence.channelStatus,
    config.lastRealTestStatus,
    config.lastWebhookTestStatus,
    config.lastConnectionTestStatus,
    config.connectionStatus,
  );
  const testedAt = firstText(
    runtimeEvidence.lastSuccessfulConversationAt,
    runtimeEvidence.testedAt,
    config.lastRealTestAt,
    config.lastWebhookTestAt,
    config.lastConnectionTestAt,
    config.connectionCheckedAt,
  );
  const hasTest = hasRealTestEvidence(testedAt) ||
    config.statusSource === "real_test" ||
    runtimeEvidence.statusSource === "real_conversation";

  if (!hasFeishuEntry) {
    return null;
  }

  if (hasTest && statusPassed(testStatus)) {
    return {
      id: "feishu",
      label: "飞书",
      value: "已连接",
      tone: "good",
      detail: runtimeEvidence.channelLabel || config.sourceSystemId || "飞书入口已完成真实回合。",
      testedAt,
      requiresTest: false,
    };
  }

  if (hasTest && statusFailed(testStatus)) {
    return {
      id: "feishu",
      label: "飞书",
      value: "连接失败",
      tone: "bad",
      detail: testStatus || "飞书真实连接测试失败。",
      testedAt,
      requiresTest: false,
    };
  }

  return {
    id: "feishu",
    label: "飞书",
    value: "待真实测试",
    tone: "warn",
    detail: config.defaultDeliveryMode === "dry_run"
      ? "当前只有 dry-run 消息测试，不表达真实连接 OK/离线。"
      : "需要真实验证飞书机器人、事件订阅或 webhook 后再表达状态。",
    requiresTest: true,
  };
}

function lifecycleHealth(employee = {}) {
  if (employee.status === "在线") {
    return {
      id: "lifecycle",
      label: "运行门禁",
      value: "可运行",
      tone: "good",
      detail: "员工生命周期状态为在线。",
    };
  }

  if (employee.status === "试运行") {
    return {
      id: "lifecycle",
      label: "运行门禁",
      value: "试运行",
      tone: "warn",
      detail: "仍需按灰度、质量和调用门禁观察。",
    };
  }

  if (employee.status === "待人员审批") {
    return {
      id: "lifecycle",
      label: "运行门禁",
      value: "待审批",
      tone: "warn",
      detail: "人员审批通过前不可作为真实运行入口。",
      requiresTest: false,
    };
  }

  if (employee.status === "规划中") {
    return {
      id: "lifecycle",
      label: "运行门禁",
      value: "未上线",
      tone: "warn",
      detail: "规划中资产不能进入运行态。",
      requiresTest: false,
    };
  }

  return {
    id: "lifecycle",
    label: "运行门禁",
    value: employee.status || "待确认",
    tone: "warn",
    detail: "需要确认生命周期状态。",
  };
}

function overallHealth(items = []) {
  if (items.some((item) => item.tone === "bad")) {
    return {
      state: "offline",
      label: "离线",
      tone: "bad",
      detail: "真实测试存在失败项。",
    };
  }

  if (items.some((item) => item.requiresTest)) {
    return {
      state: "untested",
      label: "待检测",
      tone: "warn",
      detail: "需要真实测试后才表达在线或离线。",
    };
  }

  if (items.some((item) => item.tone === "warn")) {
    return {
      state: "degraded",
      label: "受限",
      tone: "warn",
      detail: "可继续配置或试运行观察。",
    };
  }

  return {
    state: "online",
    label: "在线",
    tone: "good",
    detail: "关键运行项均已配置。",
  };
}

export function employeeRuntimeHealth(employee = {}, modelBinding = employee.modelBinding || {}, runtimeEvidence = {}) {
  const items = [
    modelHealth(modelBinding, runtimeEvidence),
    feishuHealth(employee, runtimeEvidence),
    lifecycleHealth(employee),
  ].filter(Boolean);
  const overall = overallHealth(items);
  const blockingItems = items.filter((item) => item.tone === "bad");
  const attentionItems = items.filter((item) => item.tone !== "good");
  const attentionLabels = [...new Set(attentionItems.map((item) => item.value).filter(Boolean))];

  return {
    overall,
    items,
    blockingItems,
    attentionItems,
    summaryLabel: attentionLabels.length ? attentionLabels.join(" / ") : overall.detail,
  };
}

export function employeeDisplayStatus(employee = {}, health = employeeRuntimeHealth(employee)) {
  if (health.overall?.state === "offline") return health.overall.label;
  return employee.status || health.overall?.label || "待确认";
}

export function employeeRuntimeStatusDetail(health = {}) {
  const overall = health.overall || {};
  if (overall.state === "online") return "";
  const detail = health.summaryLabel || overall.detail || overall.label || "";
  if (!detail) return "";
  if (overall.state === "offline") return detail;
  return `运行检测：${detail}`;
}
