import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperRoot = path.join(desktopRoot, "native", "managed-sandbox-helper");
const helperBinary = path.join(helperRoot, "target", "release", "managed-sandbox-helper");

if (process.platform !== "darwin") {
  console.log("macOS managed sandbox helper build skipped outside macOS");
  process.exit(0);
}

const build = spawnSync("cargo", ["build", "--locked", "--release"], {
  cwd: helperRoot,
  stdio: "inherit",
});
if (build.error || build.status !== 0) {
  throw new Error("macos_managed_sandbox_helper_build_failed");
}
await access(helperBinary);
console.log("macOS managed sandbox helper built");
