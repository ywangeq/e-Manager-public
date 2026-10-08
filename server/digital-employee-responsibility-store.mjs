import fs from "node:fs";
import path from "node:path";

export function createDigitalEmployeeResponsibilityStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyState();
      const parsed = JSON.parse(raw);
      return {
        version: "digital-employee-responsibility-state.v1",
        appliedAssignments: plainObject(parsed.appliedAssignments),
        pendingRevisions: plainObject(parsed.pendingRevisions),
        history: Array.isArray(parsed.history) ? parsed.history : [],
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn(`[digital-employee-responsibility] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function saveSubmission(revision, appliedRecord = null) {
    const state = readState();
    state.history = [revision, ...state.history.filter((item) => item.id !== revision.id)].slice(0, 500);
    if (revision.status === "pending_review") state.pendingRevisions[revision.employeeId] = revision;
    else delete state.pendingRevisions[revision.employeeId];
    if (appliedRecord?.employeeId) state.appliedAssignments[appliedRecord.employeeId] = appliedRecord;
    return writeState(state);
  }

  function saveDecision(revision, appliedRecord = null) {
    const state = readState();
    state.history = [revision, ...state.history.filter((item) => item.id !== revision.id)].slice(0, 500);
    delete state.pendingRevisions[revision.employeeId];
    if (appliedRecord?.employeeId) state.appliedAssignments[appliedRecord.employeeId] = appliedRecord;
    return writeState(state);
  }

  function writeState(state) {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const next = { ...state, updatedAt: new Date().toISOString() };
      fs.writeFileSync(storePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      console.warn(`[digital-employee-responsibility] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  return { readState, saveDecision, saveSubmission };
}

function emptyState() {
  return {
    version: "digital-employee-responsibility-state.v1",
    appliedAssignments: {},
    pendingRevisions: {},
    history: [],
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
