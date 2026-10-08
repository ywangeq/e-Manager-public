import fs from "node:fs";
import path from "node:path";

export function createRuntimeInfrastructureStore({ storePath, redactError = String } = {}) {
  const filePath = storePath || path.join(process.cwd(), "data", "local", "runtime-infrastructure.json");

  function readState() {
    try {
      if (!fs.existsSync(filePath)) return emptyState();
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return emptyState();
      return {
        version: "runtime-infrastructure.v1",
        infrastructures: objectValue(parsed.infrastructures),
        bindings: objectValue(parsed.bindings),
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn("[runtime-infrastructure-store] failed to read state:", redactError(error));
      return emptyState();
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  function listInfrastructures() {
    return Object.values(readState().infrastructures).sort(sortUpdatedDesc);
  }

  function getInfrastructure(id) {
    return readState().infrastructures[id] || null;
  }

  function saveInfrastructure(record = {}) {
    const state = readState();
    if (!record.id) return null;
    state.infrastructures[record.id] = { ...record };
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return state.infrastructures[record.id];
  }

  function updateInfrastructure(id, updater) {
    const state = readState();
    const current = state.infrastructures[id];
    if (!current) return null;
    const next = typeof updater === "function" ? updater({ ...current }) : { ...current, ...(updater || {}) };
    state.infrastructures[id] = { ...current, ...next, id };
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return state.infrastructures[id];
  }

  function listBindings() {
    return Object.values(readState().bindings).sort(sortUpdatedDesc);
  }

  function getBinding(id) {
    return readState().bindings[id] || null;
  }

  function updateBinding(id, updater) {
    const state = readState();
    const current = state.bindings[id];
    if (!current) return null;
    const next = typeof updater === "function" ? updater({ ...current }) : { ...current, ...(updater || {}) };
    state.bindings[id] = { ...current, ...next, id };
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return state.bindings[id];
  }

  function saveBinding(record = {}) {
    const state = readState();
    if (!record.id) return null;
    state.bindings[record.id] = { ...record };
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return state.bindings[record.id];
  }

  function updateBindingsForInfrastructure(infrastructureId, updater) {
    const state = readState();
    let changed = false;
    Object.entries(state.bindings).forEach(([id, binding]) => {
      if (binding.infrastructureId !== infrastructureId) return;
      const next = typeof updater === "function" ? updater({ ...binding }) : { ...binding, ...(updater || {}) };
      state.bindings[id] = { ...binding, ...next, id };
      changed = true;
    });
    if (changed) {
      state.updatedAt = new Date().toISOString();
      writeState(state);
    }
    return Object.values(state.bindings).filter((binding) => binding.infrastructureId === infrastructureId);
  }

  return {
    filePath,
    getBinding,
    getInfrastructure,
    listBindings,
    listInfrastructures,
    saveBinding,
    saveInfrastructure,
    updateBinding,
    updateBindingsForInfrastructure,
    updateInfrastructure,
  };
}

function emptyState() {
  return {
    version: "runtime-infrastructure.v1",
    infrastructures: {},
    bindings: {},
    updatedAt: "",
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sortUpdatedDesc(left, right) {
  return String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || ""));
}
