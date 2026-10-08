import fs from "node:fs";
import path from "node:path";

const CONTRACT_VERSION = "digital-employee-runtime-config.v1";

export function createDigitalEmployeeRuntimeConfigStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return {
        version: CONTRACT_VERSION,
        appliedProfiles: plainObject(parsed.appliedProfiles),
        revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [],
        updatedAt: text(parsed.updatedAt),
      };
    } catch (error) {
      console.warn(`[digital-employee-runtime-config] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function saveRevision(revision) {
    const state = readState();
    state.revisions.push({ ...revision });
    state.updatedAt = new Date().toISOString();
    return persist(state, { revision });
  }

  function saveAppliedRevision(revision, profile) {
    const state = readState();
    const index = state.revisions.findIndex((item) => item.id === revision.id);
    if (index >= 0) state.revisions[index] = { ...revision };
    else state.revisions.push({ ...revision });
    state.appliedProfiles[profile.employeeId] = { ...profile };
    state.updatedAt = new Date().toISOString();
    return persist(state, { revision, profile });
  }

  function saveRevisionDecision(revision) {
    const state = readState();
    const index = state.revisions.findIndex((item) => item.id === revision.id);
    if (index < 0) return { ok: false, error: "digital_employee_runtime_config_revision_not_found" };
    state.revisions[index] = { ...revision };
    state.updatedAt = new Date().toISOString();
    return persist(state, { revision });
  }

  function persist(state, result) {
    if (!storePath) return { ok: true, ...result, updatedAt: state.updatedAt };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return { ok: true, ...result, updatedAt: state.updatedAt };
    } catch (error) {
      console.warn(`[digital-employee-runtime-config] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  return { readState, saveAppliedRevision, saveRevision, saveRevisionDecision };
}

function emptyState() {
  return {
    version: CONTRACT_VERSION,
    appliedProfiles: {},
    revisions: [],
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return String(value || "").trim();
}
