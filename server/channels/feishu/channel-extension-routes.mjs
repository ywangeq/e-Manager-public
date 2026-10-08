import {
  resolveDigitalEmployeeByReadId,
  resolveDigitalEmployeeRequestIdentity,
} from "../../digital-employee-identity-compatibility.mjs";
import { actorSummary, hasPlatformGovernance } from "./integration-values.mjs";
import {
  CHANNEL_EXTENSION_CONTRACT_VERSION,
  extensionForSession,
  normalizeFeishuChannelExtension,
} from "./channel-extension-policy.mjs";

const CHANNEL_EXTENSION_ROUTE = /^\/api\/feishu\/integrations\/([^/]+)\/channel-extension$/;

function createFeishuChannelExtensionService({ getDigitalEmployees, readJsonBody, requireSession, sendJson, store }) {
  async function handle(req, res, url) {
    const match = url.pathname.match(CHANNEL_EXTENSION_ROUTE);
    if (!match) return undefined;
    const employeeId = decodeEmployeeId(match[1]);
    const identity = resolveDigitalEmployeeRequestIdentity({ employeeId, method: req.method });
    if (!identity.ok) {
      return sendJson(res, identity.error === "digital_employee_identity_alias_read_only" ? 409 : 404, {
        ok: false,
        error: identity.error,
        ...(identity.canonicalEmployeeId ? { canonicalEmployeeId: identity.canonicalEmployeeId } : {}),
        contractVersion: CHANNEL_EXTENSION_CONTRACT_VERSION,
      });
    }
    const employee = resolveDigitalEmployeeByReadId(getDigitalEmployees() || [], identity.canonicalEmployeeId);
    if (!employee) return sendJson(res, 404, unavailableResponse("digital_employee_not_found"));
    if (employee.level === "系统级") return sendJson(res, 422, unavailableResponse("system_digital_employee_channel_not_allowed"));
    if (req.method === "GET") return readExtension(req, res, employee);
    if (req.method === "PUT") return saveExtension(req, res, employee);
    return sendJson(res, 405, unavailableResponse("method_not_allowed"));
  }

  function readExtension(req, res, employee) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return sendJson(res, 200, responseFor(employee, store.readConnection(employee.id)));
  }

  async function saveExtension(req, res, employee) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!hasPlatformGovernance(session)) {
      return sendJson(res, 403, {
        ...unavailableResponse("feishu_channel_extension_governance_required"),
        message: "只有平台治理角色可以变更飞书入口策略。",
      });
    }
    const input = await readJsonBody(req, 1024 * 64);
    let channelExtension;
    try {
      channelExtension = normalizeFeishuChannelExtension(input?.channelExtension || input, { strict: true });
    } catch (error) {
      return sendJson(res, 422, {
        ...unavailableResponse(error?.code || "invalid_feishu_channel_extension"),
        message: "开启飞书入口锁定时，必须填写安全的 HTTPS 入口链接和固定说明。",
      });
    }
    const now = new Date().toISOString();
    const existingConnection = store.readConnection(employee.id);
    const connection = store.saveConnection({
      ...existingConnection,
      employeeId: employee.id,
      channelExtension,
      lastUpdatedBy: actorSummary(session),
      createdAt: existingConnection.createdAt || now,
      updatedAt: now,
    }, employee.id);
    return sendJson(res, 200, {
      ...responseFor(employee, connection),
      message: channelExtension.responseMode === "fixed_entry_reply"
        ? "飞书入口锁定已立即生效；后续普通输入只返回固定入口，不调用模型或 Tool。"
        : "飞书入口锁定已关闭；后续普通输入恢复既有统一 Agent Runtime 路径。",
    });
  }

  function responseFor(employee, connection) {
    return {
      ok: true,
      contractVersion: CHANNEL_EXTENSION_CONTRACT_VERSION,
      employee: { id: employee.id, name: employee.name },
      channelExtension: extensionForSession(connection),
      effective: "current_state",
    };
  }

  return { handle };
}

function unavailableResponse(error) {
  return { ok: false, error, contractVersion: CHANNEL_EXTENSION_CONTRACT_VERSION };
}

function decodeEmployeeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{1,159}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

export { CHANNEL_EXTENSION_CONTRACT_VERSION, createFeishuChannelExtensionService };
