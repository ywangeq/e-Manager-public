const TASK_MATERIAL_SET_CLAIM_VERSION = "task-material-set-claim.v1";
const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function createTaskMaterialSetRecoveryService({ adapters = [] } = {}) {
  const adapterById = new Map();
  for (const adapter of adapters) {
    const normalized = normalizeAdapter(adapter);
    if (adapterById.has(normalized.adapterId)) throw recoveryError("task_material_set_adapter_duplicate");
    adapterById.set(normalized.adapterId, normalized);
  }

  async function recover({ bindings = [], taskId = "" } = {}) {
    const safeTaskId = requiredToken(taskId, "taskId", 128);
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 64) {
      throw recoveryError("task_material_set_invalid");
    }
    const planned = bindings.map((binding) => {
      const adapterId = requiredToken(binding?.adapterId, "adapterId", 120);
      const adapter = adapterById.get(adapterId);
      if (!adapter) throw recoveryError("task_material_set_adapter_unavailable");
      if (binding.taskId !== safeTaskId) throw recoveryError("task_material_set_task_mismatch");
      return { adapter, binding };
    }).sort((left, right) => (
      left.adapter.mountOrder - right.adapter.mountOrder ||
      String(left.binding.descriptorDigest || "").localeCompare(String(right.binding.descriptorDigest || ""))
    ));

    const claims = [];
    const inputIds = new Set();
    let expiresAt = "";
    let workspace = null;
    let workspaceManager = null;
    for (const { adapter, binding } of planned) {
      if (adapter.delivery === "device_deferred") continue;
      let claim;
      try {
        claim = await adapter.recover({ binding, taskId: safeTaskId });
      } catch (error) {
        if (error?.code) throw error;
        throw recoveryError("task_material_set_source_recovery_failed");
      }
      const normalized = normalizeClaim(claim, safeTaskId);
      if (!workspace) {
        workspace = normalized.workspace;
        workspaceManager = normalized.workspaceManager;
      } else if (workspace.root !== normalized.workspace.root || workspaceManager !== normalized.workspaceManager) {
        throw recoveryError("task_material_set_workspace_mismatch");
      }
      for (const item of normalized.items) {
        if (inputIds.has(item.inputId)) throw recoveryError("task_material_set_input_duplicate");
        inputIds.add(item.inputId);
        claims.push(item);
      }
      if (!expiresAt || normalized.expiresAt < expiresAt) expiresAt = normalized.expiresAt;
    }
    if (!workspace || !workspaceManager || !claims.length) throw recoveryError("task_material_set_recovery_invalid");
    return Object.freeze({
      contractVersion: TASK_MATERIAL_SET_CLAIM_VERSION,
      expiresAt,
      items: Object.freeze(claims.map((item) => Object.freeze({ ...item }))),
      sourceCount: planned.length,
      workspace,
      workspaceManager,
      workspaceTaskId: safeTaskId,
    });
  }

  return Object.freeze({
    contractVersion: "task-material-set-recovery-service.v1",
    recover,
  });
}

function normalizeAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("task material set adapter is invalid");
  }
  const delivery = value.delivery || "workspace";
  if (!new Set(["device_deferred", "workspace"]).has(delivery) ||
    (delivery === "workspace" && typeof value.recover !== "function")) {
    throw new TypeError("task material set adapter delivery is invalid");
  }
  const mountOrder = Number(value.mountOrder);
  if (!Number.isSafeInteger(mountOrder) || mountOrder < 0 || mountOrder > 1000) {
    throw new TypeError("task material set adapter mountOrder is invalid");
  }
  return Object.freeze({
    adapterId: requiredToken(value.adapterId, "adapterId", 120),
    delivery,
    mountOrder,
    ...(delivery === "workspace" ? { recover: value.recover } : {}),
  });
}

function normalizeClaim(value, taskId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !Array.isArray(value.items) || !value.items.length || value.items.length > 64 ||
    value.workspaceTaskId !== taskId || !value.workspace || typeof value.workspace.root !== "string" ||
    !value.workspace.root || !value.workspaceManager || typeof value.workspaceManager !== "object") {
    throw recoveryError("task_material_set_recovery_invalid");
  }
  const expiresAt = normalizedTimestamp(value.expiresAt);
  return Object.freeze({
    expiresAt,
    items: value.items.map(normalizeItem),
    workspace: value.workspace,
    workspaceManager: value.workspaceManager,
  });
}

function normalizeItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw recoveryError("task_material_set_item_invalid");
  const contentDigest = String(value.contentDigest || "");
  if (!SHA256_PATTERN.test(contentDigest)) throw recoveryError("task_material_set_item_digest_invalid");
  const inputId = requiredToken(value.inputId, "inputId", 160);
  const fileName = requiredFileName(value.fileName);
  if (typeof value.filePath !== "string" || !value.filePath) throw recoveryError("task_material_set_item_path_invalid");
  const mimeType = requiredMimeType(value.mimeType);
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 64 * 1024 * 1024) {
    throw recoveryError("task_material_set_item_size_invalid");
  }
  const sourceRef = requiredToken(value.sourceRef, "sourceRef", 240);
  return {
    contentDigest,
    inputId,
    fileName,
    filePath: value.filePath,
    mimeType,
    sizeBytes: value.sizeBytes,
    sourceRef,
    ...(value.materialContract ? { materialContract: value.materialContract } : {}),
  };
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !TOKEN_PATTERN.test(text)) throw recoveryError("task_material_set_reference_invalid", field);
  return text;
}

function requiredFileName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 180 || /[\\/\0\r\n]/.test(text)) throw recoveryError("task_material_set_item_name_invalid");
  return text;
}

function requiredMimeType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text.length > 120 || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(text)) {
    throw recoveryError("task_material_set_item_mime_invalid");
  }
  return text;
}

function normalizedTimestamp(value) {
  const timestamp = new Date(value);
  if (!value || !Number.isFinite(timestamp.getTime())) throw recoveryError("task_material_set_recovery_invalid");
  return timestamp.toISOString();
}

function recoveryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  TASK_MATERIAL_SET_CLAIM_VERSION,
  createTaskMaterialSetRecoveryService,
};
