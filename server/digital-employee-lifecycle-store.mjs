import fs from "node:fs";
import path from "node:path";

export function createDigitalEmployeeLifecycleStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyState();
      const parsed = JSON.parse(raw);
      return {
        version: "digital-employee-lifecycle.v1",
        lifecycleStates: plainObject(parsed.lifecycleStates),
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn(`[digital-employee-lifecycle] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function saveLifecycleState(employeeId, lifecycleState) {
    const state = readState();
    state.lifecycleStates[employeeId] = { ...lifecycleState };
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return {
      ...result,
      lifecycleState: state.lifecycleStates[employeeId],
      updatedAt: state.updatedAt,
    };
  }

  function writeState(state) {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      console.warn(`[digital-employee-lifecycle] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  return { readState, saveLifecycleState };
}

function emptyState() {
  return {
    version: "digital-employee-lifecycle.v1",
    lifecycleStates: {},
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
