import { normalizeMaterialBindingDescriptors } from "./task-material-binding.mjs";

// References only; the existing encrypted approval owns the immutable admission input.
export function normalizeConfirmationInputSnapshot(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["contractVersion", "channelId", "employeeVersion", "taskType", "materialBindings"].includes(key)) ||
      value.contractVersion !== "tool-confirmation-input-snapshot.v1" ||
      !["desktop", "management_console"].includes(value.channelId) ||
      typeof value.employeeVersion !== "string" || !value.employeeVersion.trim() || value.employeeVersion.length > 80 ||
      !Array.isArray(value.materialBindings)) return null;
    const materialBindings = value.materialBindings.length ? normalizeMaterialBindingDescriptors(value.materialBindings) : [];
    if (materialBindings.length && value.channelId !== "desktop") return null;
    const taskType = materialBindings.some(binding => binding.sourceKind !== "device_workspace_input")
      ? "desktop_material_chat" : "digital_employee_chat";
    if (value.taskType !== taskType) return null;
    const snapshot = { contractVersion: value.contractVersion, channelId: value.channelId,
      employeeVersion: value.employeeVersion, taskType, materialBindings };
    return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 96 * 1024 ? snapshot : null;
  } catch { return null; }
}

// The card deadline limits first acceptance; an accepted approval has a bounded execution deadline.
export function confirmationRetentionDeadline(record) {
  return record?.acceptance?.executeBeforeMs ?? record?.expiresAtMs ?? 0;
}

export function acceptedConfirmationMatches(record, { contextBinding, executionInputBinding, taskId } = {}) {
  return Boolean(record?.acceptance && contextBinding && executionInputBinding && taskId
    && record.contextBinding === contextBinding
    && record.executionInputBinding === executionInputBinding
    && record.acceptance.taskId === taskId);
}
