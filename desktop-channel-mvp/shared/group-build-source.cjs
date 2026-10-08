const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

// Includes root catalog/assets and the native witness's shared server inputs.
const inputs = [".gitattributes", "desktop-channel-mvp", "src", "shared", "server", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "tools/validate_desktop_release.mjs", "tools/group_studio_release_source.mjs", "tools/group_studio_macos_handoff.mjs",
  "tools/check_group_studio_packaged_identity.mjs", "tools/create_macos_sandbox_provider_record.mjs",
  "tools/test_macos_seatbelt_sandbox_provider_witness.mjs", "tools/test_macos_sandbox_tls_dispatch_witness.mjs"];

function assertGroupBuildInputs(root) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  assert.match(sha, /^[a-f0-9]{40}$/);
  git(["diff", "--exit-code", "HEAD", "--", ...inputs]);
  assert.equal(git(["ls-files", "--others", "--exclude-standard", "--", ...inputs]), "", "untracked Group build inputs are forbidden");
  return sha;
}
module.exports = { assertGroupBuildInputs };
