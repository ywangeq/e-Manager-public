import path from "node:path";
import { statSync } from "node:fs";

export function resolveDigitalWorkforceDataDir({ env = process.env, projectRoot = process.cwd() } = {}) {
  const configured = String(env.DIGITAL_WORKFORCE_DATA_DIR || "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new TypeError("DIGITAL_WORKFORCE_DATA_DIR must be an absolute path");
    }
    return path.normalize(configured);
  }
  if (!path.isAbsolute(projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  if (isLinkedGitWorktree(projectRoot)) {
    throw new TypeError("DIGITAL_WORKFORCE_DATA_DIR must be configured for a linked Git worktree");
  }
  return path.join(path.normalize(projectRoot), "data", "local");
}

function isLinkedGitWorktree(projectRoot) {
  try {
    return statSync(path.join(projectRoot, ".git")).isFile();
  } catch {
    return false;
  }
}
