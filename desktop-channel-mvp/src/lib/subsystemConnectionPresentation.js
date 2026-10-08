const PRESENTATION = {
  connected: ["已连接", "success", "认证有效，可供关联员工使用。"],
  authenticated: ["已认证 · 执行待验证", "neutral", "当前账号认证已验证；尚未确认 Group Studio 能复用认证完成业务调用。"],
  disconnected: ["未连接", "neutral", "连接后，关联员工可复用当前账号的认证。"],
  expired: ["登录已失效", "danger", "请重新认证后继续使用。"],
  checking: ["正在检查", "active", "正在确认认证状态…"],
  verification_required: ["待验证", "neutral", "需要检查会话是否仍可自动续期。"],
  account_blocked: ["账号需确认", "attention", "请使用当前企业账号登录，并确认子系统访问权限。"],
  not_configured: ["尚未配置", "neutral", "当前环境尚未提供此系统的认证连接，请联系管理员。"],
  unavailable: ["暂无法验证", "attention", "网络或服务暂不可用，不能确认当前认证状态。"],
  on_demand: ["执行时校验", "neutral", "此系统在实际操作时校验当前用户授权，无需在这里单独登录。"],
  unknown: ["状态暂不可获取", "neutral", "此系统尚未接入认证状态检测。"],
};

export function subsystemConnectionPresentation(connection = {}) {
  const [label, tone, message] = PRESENTATION[connection.state] || PRESENTATION.unknown;
  const needsLogin = ["disconnected", "expired", "account_blocked"].includes(connection.state);
  const action = needsLogin ? "connect" : "check";
  return { label, tone, message, action, actionLabel: needsLogin ? connection.state === "disconnected" ? "连接认证" : "重新认证" : "检查连接",
    actionable: connection.state !== "checking" && (connection.actions || []).includes(action),
    canDisconnect: ["connected", "authenticated"].includes(connection.state) && (connection.actions || []).includes("disconnect"),
  };
}

export function connectionTime(value) {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
    : "暂不可获取";
}
