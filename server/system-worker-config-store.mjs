import fs from "node:fs";
import path from "node:path";

export function createSystemWorkerConfigStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyState();
      const parsed = JSON.parse(raw);
      return {
        version: "system-worker-config.v1",
        workerOverrides: plainObject(parsed.workerOverrides),
        departmentResourceOverrides: plainObject(parsed.departmentResourceOverrides),
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn(`[system-worker-config] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function writeState(state) {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
      return { ok: true };
    } catch (error) {
      console.warn(`[system-worker-config] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  function listOverrides() {
    return { ...readState().workerOverrides };
  }

  function saveOverride(workerId, override) {
    const state = readState();
    state.workerOverrides[workerId] = { ...override };
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return { ...result, override: state.workerOverrides[workerId], updatedAt: state.updatedAt };
  }

  function saveDepartmentResourceOverride(workerId, departmentId, override) {
    const state = readState();
    const workerOverrides = plainObject(state.departmentResourceOverrides[workerId]);
    workerOverrides[departmentId] = { ...override };
    state.departmentResourceOverrides[workerId] = workerOverrides;
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return { ...result, override: workerOverrides[departmentId], updatedAt: state.updatedAt };
  }

  return { listOverrides, readState, saveDepartmentResourceOverride, saveOverride };
}

function emptyState() {
  return {
    version: "system-worker-config.v1",
    workerOverrides: {},
    departmentResourceOverrides: {},
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
