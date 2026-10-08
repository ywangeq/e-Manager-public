import fs from "node:fs";
import path from "node:path";

export function createDigitalEmployeeProfileStore({ storePath, redactError = (value) => String(value || "") } = {}) {
  function readState() {
    if (!storePath || !fs.existsSync(storePath)) return emptyState();
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return emptyState();
      const parsed = JSON.parse(raw);
      return {
        version: "digital-employee-profile-state.v1",
        appliedProfiles: plainObject(parsed.appliedProfiles),
        history: Array.isArray(parsed.history) ? parsed.history : [],
        updatedAt: String(parsed.updatedAt || ""),
      };
    } catch (error) {
      console.warn(`[digital-employee-profile] failed to read store: ${redactError(error?.message || error)}`);
      return emptyState();
    }
  }

  function saveProfile(profile) {
    const state = readState();
    state.appliedProfiles[profile.employeeId] = profile;
    state.history = [profile, ...state.history.filter((item) => item.revisionId !== profile.revisionId)].slice(0, 500);
    state.updatedAt = new Date().toISOString();
    const result = writeState(state);
    return { ...result, profile };
  }

  function writeState(state) {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      console.warn(`[digital-employee-profile] failed to write store: ${redactError(error?.message || error)}`);
      return { ok: false, error: redactError(error?.message || error) };
    }
  }

  return { readState, saveProfile };
}

function emptyState() {
  return {
    version: "digital-employee-profile-state.v1",
    appliedProfiles: {},
    history: [],
    updatedAt: "",
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
