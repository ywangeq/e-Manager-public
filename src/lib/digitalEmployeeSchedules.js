export function employeeScheduleRecords(employee = {}) {
  return (employee.runtimeSchedules || []).filter(item => item.contractVersion === "governed-schedule-registration.v3")
    .map(item => ({ id: item.id, title: item.title, status: "已登记，运行状态见定时任务" }));
}
export async function fetchScheduleConfiguration(employeeId, scheduleId) {
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/configuration`);
}
export async function fetchScheduleOperations(employeeId, scheduleId) {
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/operations`);
}
export async function fetchScheduleRuns(employeeId, scheduleId, { beforeScheduledFor = "", limit = 20 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeScheduledFor) query.set("beforeScheduledFor", beforeScheduledFor);
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/runs?${query}`);
}
export async function updateScheduleEmergencyStop(employeeId, scheduleId, input) {
  const data = await scheduleRequest(`${schedulePath(employeeId, scheduleId)}/emergency-stop`, "PUT", {
    expectedControlVersion: input.expectedControlVersion, engaged: input.engaged,
    reasonCode: input.reasonCode, safeReason: input.safeReason,
  });
  if (data.contractVersion !== "digital-employee-schedule-emergency-stop.v1" ||
    !Number.isSafeInteger(data.controlVersion) || data.controlVersion < 1 || data.emergencyStop?.active !== input.engaged ||
    !["stop_committed", "stop_already_engaged", "clear_committed", "clear_already_inactive"].includes(data.commandState)) {
    throw new Error("Schedule 急停命令结果未确认");
  }
  return data;
}
function schedulePath(employeeId, scheduleId) {
  return `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-schedules/${encodeURIComponent(scheduleId)}`;
}
async function readScheduleResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const message = data.message || fallbackMessage;
    const code = typeof data.error === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(data.error) ? data.error : "";
    throw new Error(code ? `${message}（${code}）` : message);
  }
  return data;
}

export function scheduleRunArtifactUrl(employeeId, scheduleId, runId, artifactId) {
  return `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export async function fetchScheduleConfigurations(employeeId) {
  return scheduleRequest(`/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-schedules`);
}
export async function saveScheduleConfiguration(employeeId, scheduleId, input) {
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/configuration`, "PUT", input);
}
export async function changeScheduleActivation(employeeId, scheduleId, action, expectedControlVersion) {
  if (!["activate", "pause"].includes(action)) throw new Error("不支持的定时任务操作");
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/${action}`, "POST", { expectedControlVersion });
}
export async function runScheduleNow(employeeId, scheduleId, expectedControlVersion, requestToken) {
  return scheduleRequest(`${schedulePath(employeeId, scheduleId)}/run-now`, "POST", { expectedControlVersion, requestToken });
}
async function scheduleRequest(url, method = "GET", input) {
  const response = await fetch(url, { method, credentials: "include",
    ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) });
  return readScheduleResponse(response, "定时任务操作失败，请刷新后重试");
}
export function scheduleStateLabel(state) {
  return ({ registered: "未启用", active: "启用中", paused: "已暂停", retired: "已停用",
    prepared: "待提交", submitted: "已提交", succeeded: "已完成", completed: "已完成", failed: "失败",
    skipped_max_concurrency: "并发受限，已跳过", canceled: "已取消", cancel_requested: "取消中",
    reconcile_required: "待核对", queued: "排队中", running: "运行中" })[state] || state || "未知";
}

// getRandomValues also works on the managed HTTP LAN; randomUUID requires HTTPS.
export function createScheduleRequestToken(cryptoSource = globalThis.crypto) {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
