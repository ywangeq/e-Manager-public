import fs from "node:fs";
import path from "node:path";

export function resolveDeviceReadReleasePhase({ projectRoot, env = {} }) {
  const marker = path.join(projectRoot, "deploy/center-device-read-release.json");
  if (!fs.existsSync(marker)) {
    if (env.RUNTIME_DEVICE_READ_SCHEMA_PHASE && env.RUNTIME_DEVICE_READ_SCHEMA_PHASE !== "inactive") throw Error("device_read_release_marker_required");
    return "inactive";
  }
  const value = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (Object.keys(value).sort().join(",") !== "contractVersion,ownerTask,phase,sourceRevision" ||
      value.contractVersion !== "center-device-read-release.v1" || value.ownerTask !== "WB-FEISHU-001" ||
      value.sourceRevision !== "ff93ba2e73ce0a7b7c726d30a990a30e80fb0004" ||
      !["prepare", "activate", "rollback"].includes(value.phase)) throw Error("device_read_release_phase_invalid");
  const phase = value.phase === "rollback" ? "inactive" : value.phase;
  if (env.RUNTIME_DEVICE_READ_SCHEMA_PHASE && env.RUNTIME_DEVICE_READ_SCHEMA_PHASE !== phase)
    throw Error("device_read_release_phase_conflict");
  return phase;
}
