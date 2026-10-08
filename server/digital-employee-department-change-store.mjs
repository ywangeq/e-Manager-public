import fs from "node:fs";
import path from "node:path";

export function createDigitalEmployeeDepartmentChangeStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyState();
      const parsed = JSON.parse(raw);
      return {
        version: "digital-employee-department-change.v1",
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        appliedOverrides: plainObject(parsed.appliedOverrides),
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn(`[digital-employee-department-change] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function saveRequest(request) {
    const state = readState();
    const index = state.requests.findIndex((item) => item.id === request.id);
    if (index >= 0) state.requests[index] = { ...request };
    else state.requests.unshift({ ...request });
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return { ...result, request: { ...request } };
  }

  function saveDecision(request, appliedOverride = null) {
    const state = readState();
    const index = state.requests.findIndex((item) => item.id === request.id);
    if (index >= 0) state.requests[index] = { ...request };
    else state.requests.unshift({ ...request });
    if (appliedOverride?.employeeId) state.appliedOverrides[appliedOverride.employeeId] = { ...appliedOverride };
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return { ...result, request: { ...request }, override: appliedOverride ? { ...appliedOverride } : null };
  }

  function writeState(state) {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      console.warn(`[digital-employee-department-change] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  return { readState, saveDecision, saveRequest };
}

function emptyState() {
  return {
    version: "digital-employee-department-change.v1",
    requests: [],
    appliedOverrides: {},
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
