import {
  FEISHU_REPLY_MESSAGE_URL,
  cleanShortText,
  cleanText,
  maskIdentifier,
  normalizeAllowedChatRefs,
} from "../../feishu-integration-support.mjs";

const FEISHU_CONNECTION_TEST_COOLDOWN_MS = 10_000;

function createFeishuConnectionTester({
  employeeId,
  employeeName = "数字员工",
  fetch = globalThis.fetch,
  store,
  validateFeishuCredentials,
} = {}) {
  const targetEmployeeId = cleanShortText(employeeId);
  const targetEmployeeName = cleanShortText(employeeName || "数字员工");
  if (!targetEmployeeId) throw new Error("feishu connection tester requires employeeId");
  if (!store) throw new Error("feishu connection tester requires a store");
  if (typeof validateFeishuCredentials !== "function") {
    throw new Error("feishu connection tester requires validateFeishuCredentials");
  }

  let recentConnectionTestClick = { key: "", atMs: 0 };

  async function runFeishuConnectionTest({ connection = {}, application = {}, now = new Date().toISOString() } = {}) {
    const appId = store.readSecret("appId", targetEmployeeId);
    const appSecret = store.readSecret("appSecret", targetEmployeeId);
    const rawTarget = selectConnectionTestTarget();
    const target = summarizeConnectionTestTarget(rawTarget);
    const eventSubscription = connection.eventSubscription || {};
    const roundtripOk = eventSubscription.status === "message_roundtrip_tested";
    const eventSeen = ["event_received", "message_roundtrip_tested"].includes(eventSubscription.status) || Boolean(eventSubscription.lastEventAt);
    const credentialCheck = appId && appSecret
      ? await validateFeishuCredentials({ appId, appSecret })
      : {
          ok: false,
          message: "服务端尚未保存 App ID / App Secret。",
          safeSummary: {
            status: "missing",
            checkedAt: now,
            appIdMasked: "",
            message: "服务端尚未保存 App ID / App Secret。",
          },
        };

    let delivery = {
      mode: "feishu_connection_test",
      sent: false,
      status: "not_sent",
      messageContractOk: true,
      note: "尚未触发真实发送。",
    };
    if (!credentialCheck.ok) {
      delivery = {
        ...delivery,
        status: "credential_failed",
        note: credentialCheck.message || "飞书应用凭证校验失败。",
      };
    } else if (!rawTarget?.feishuId) {
      delivery = {
        ...delivery,
        status: "target_missing",
        note: "缺少测试单聊 open_id/user_id 或群 chat_id/open_chat_id。",
      };
    } else if (roundtripOk) {
      delivery = {
        ...delivery,
        status: "roundtrip_already_passed",
        note: "真实消息收发已经通过，不需要重复发送测试消息。",
      };
    } else if (!credentialCheck.tenantAccessToken) {
      delivery = {
        ...delivery,
        status: "send_skipped_for_local_test",
        note: "本地测试环境跳过飞书远端发送；真实环境会用 tenant_access_token 调用消息 API。",
      };
    } else {
      delivery = await sendFeishuConnectionTestMessage({
        tenantAccessToken: credentialCheck.tenantAccessToken,
        target: rawTarget,
        text: buildConnectionTestMessage({ application, target }),
        redactionValues: [appId, appSecret, rawTarget.feishuId, credentialCheck.tenantAccessToken],
      });
    }

    const status = roundtripOk
      ? "message_roundtrip_tested"
      : delivery.sent
        ? "test_message_sent"
        : delivery.status === "send_skipped_for_local_test"
          ? "worker_binding_ready"
          : delivery.status === "target_missing"
            ? "target_required"
            : delivery.status === "credential_failed"
              ? "credential_failed"
              : eventSeen
                ? "event_received"
                : "awaiting_message_roundtrip";
    const workerStatus = roundtripOk
      ? "passed"
      : delivery.sent || delivery.status === "send_skipped_for_local_test"
        ? "awaiting_real_message"
        : delivery.status === "target_missing"
          ? "target_required"
          : delivery.status === "credential_failed"
            ? "credential_failed"
            : "awaiting_worker_start";

    return {
      status,
      checkedAt: now,
      credential: credentialCheck.safeSummary,
      worker: {
        status: workerStatus,
        message: workerStatus === "awaiting_real_message"
          ? "后端测试已准备；仍需服务端长连接 worker 收到真实飞书消息并挂上状态标记。"
          : workerStatus === "target_required"
            ? "请先补充测试对象稳定 ID，才能做真实消息和状态标记验证。"
            : workerStatus === "passed"
              ? "真实消息状态标记测试已通过。"
              : "请启动或接入服务端飞书长连接 worker。",
      },
      target,
      delivery,
      roundtrip: {
        status: roundtripOk ? "passed" : eventSeen ? "event_received" : "awaiting_real_message",
        lastEventAt: eventSubscription.lastEventAt || "",
        message: roundtripOk
          ? "后端已经收到真实消息并完成原消息下方状态标记。"
          : eventSeen
            ? "后端已经收到真实事件，仍需确认原消息下方状态标记。"
            : "请在飞书单聊机器人，或在测试群 @机器人 发送一条真实测试消息。",
      },
      nextGate: connectionTestNextGate({ delivery, roundtripOk, eventSeen }),
    };
  }

  function connectionTestClickKey({ application = {}, connection = {} } = {}) {
    return [
      application.id || connection.applicationId,
      application.capabilityRequestId || connection.capabilityRequestId,
      application.targetUserId || connection.workerBinding?.targetUserId || "unknown-user",
    ].map((value) => cleanShortText(value || "")).filter(Boolean).join(":") || "feishu-connection-test";
  }

  function connectionTestCooldown({ application = {}, connection = {}, now = new Date().toISOString() } = {}) {
    const clickKey = connectionTestClickKey({ application, connection });
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs) || recentConnectionTestClick.key !== clickKey) return null;
    const elapsedMs = nowMs - recentConnectionTestClick.atMs;
    if (elapsedMs < 0 || elapsedMs >= FEISHU_CONNECTION_TEST_COOLDOWN_MS) return null;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((FEISHU_CONNECTION_TEST_COOLDOWN_MS - elapsedMs) / 1000)),
    };
  }

  function markConnectionTestClick({ application = {}, connection = {}, now = new Date().toISOString() } = {}) {
    recentConnectionTestClick = {
      key: connectionTestClickKey({ application, connection }),
      atMs: Date.parse(now),
    };
  }

  function selectConnectionTestTarget() {
    const raw = store.readSecret("allowedChatRefs", targetEmployeeId);
    if (!raw) return null;
    try {
      const refs = normalizeAllowedChatRefs(JSON.parse(raw));
      return refs.find((item) => item.feishuId) || null;
    } catch {
      const refs = normalizeAllowedChatRefs(raw);
      return refs.find((item) => item.feishuId) || null;
    }
  }

  function summarizeConnectionTestTarget(target = null) {
    if (!target?.feishuId) {
      return {
        status: "missing_target",
        type: "",
        name: "",
        feishuIdMasked: "",
        idStatus: "missing_id",
        receiveIdType: "",
      };
    }
    return {
      status: "ready",
      type: cleanShortText(target.type || "unknown"),
      name: cleanShortText(target.name),
      feishuIdMasked: maskIdentifier(target.feishuId),
      idStatus: "ready",
      receiveIdType: receiveIdTypeForChatRef(target),
    };
  }

  function receiveIdTypeForChatRef(target = {}) {
    const feishuId = String(target.feishuId || "").trim().toLowerCase();
    if (target.type === "group_chat" || feishuId.startsWith("oc_") || feishuId.startsWith("chat_")) return "chat_id";
    if (feishuId.startsWith("on_")) return "union_id";
    if (feishuId.startsWith("user_")) return "user_id";
    return "open_id";
  }

  function buildConnectionTestMessage({ application = {}, target = {} } = {}) {
    return [
      "飞书联通测试消息。",
      `数字员工：${application.targetEmployeeName || targetEmployeeName}`,
      `申请编号：${application.capabilityRequestId || application.id || "待识别"}`,
      target?.name ? `测试对象：${target.name}` : "",
      "请在这个会话里回复任意测试消息；如果是群聊，请 @机器人。服务端收到真实事件并挂上原消息下方状态标记后，管理台会变为绿色通过。",
      "此消息只用于连接测试，不包含 App Secret、token、用户原话或业务原始数据。",
    ].filter(Boolean).join("\n");
  }

  async function sendFeishuConnectionTestMessage({ tenantAccessToken = "", target = {}, text = "", redactionValues = [] } = {}) {
    const receiveIdType = receiveIdTypeForChatRef(target);
    try {
      const response = await fetch(`${FEISHU_REPLY_MESSAGE_URL}?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tenantAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: target.feishuId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      });
      const responseText = await response.text().catch(() => "");
      return {
        mode: "feishu_connection_test",
        sent: response.ok,
        status: response.ok ? "test_message_sent" : "send_failed",
        messageContractOk: true,
        httpStatus: response.status,
        responseSummary: redactFeishuResponseSummary(responseText, redactionValues),
      };
    } catch {
      return {
        mode: "feishu_connection_test",
        sent: false,
        status: "send_failed",
        messageContractOk: true,
        responseSummary: "飞书消息发送接口调用失败。",
      };
    }
  }

  function redactFeishuResponseSummary(value = "", redactionValues = []) {
    let text = cleanText(value).slice(0, 200);
    redactionValues.filter(Boolean).forEach((secret) => {
      text = text.split(String(secret)).join(maskIdentifier(secret));
    });
    return text;
  }

  function connectionTestNextGate({ delivery = {}, roundtripOk = false, eventSeen = false } = {}) {
    if (roundtripOk) return "飞书真实消息状态标记测试已通过。";
    if (eventSeen) return "后端已收到真实飞书事件；请确认原消息下方状态标记是否成功。";
    if (delivery.status === "target_missing") return "请先在联通配置里补充测试单聊 open_id/user_id 或测试群 chat_id/open_chat_id。";
    if (delivery.sent) return "后端已向测试对象发送安全测试消息；请在飞书里回复机器人，或在群里 @机器人，收到事件并挂上状态标记后才会变绿。";
    if (delivery.status === "send_skipped_for_local_test") return "本地测试已完成绑定预检；真实环境需启动长连接 worker 后，再发送一条飞书消息做回环。";
    if (delivery.status === "credential_failed") return "飞书凭证校验失败，请重新保存 App ID / App Secret。";
    return "请启动或接入服务端长连接 worker，然后在飞书单聊或测试群发送真实消息。";
  }

  return {
    connectionTestCooldown,
    markConnectionTestClick,
    runFeishuConnectionTest,
  };
}

export { createFeishuConnectionTester };
