import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDigitalWorkforceDataDir } from "./local-data-root.mjs";
import { validateHarnessManifest } from "./skill-harness-manifest.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const artifactRoot = () => path.join(resolveDigitalWorkforceDataDir(), "skill-harness-artifacts");
const fail = (code) => { throw new Error(code); };
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readHarnessPackageFiles(archivePath) {
  try {
    return JSON.parse(execFileSync(process.env.DIGITAL_WORKFORCE_SKILL_PYTHON || "python3", [
      fileURLToPath(new URL("./skill-artifact-archive.py", import.meta.url)), archivePath,
    ], { maxBuffer: 48 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
  } catch { fail("skill_artifact_archive_rejected"); }
}

export function saveHarnessArtifact({ files, skillRoot, identity }) {
  const prefix = skillRoot ? `${skillRoot}/` : "";
  const entries = Object.entries(files).filter(([name]) => name.startsWith(prefix))
    .map(([name, content]) => [name.slice(prefix.length), content]).sort(([a], [b]) => a.localeCompare(b));
  const payload = Buffer.from(JSON.stringify({ contractVersion: "skill-harness-artifact.v1", files: entries }));
  const artifactDigest = digest(payload);
  const root = path.join(artifactRoot(), "objects");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, artifactDigest.slice(7));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o400);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    syncDirectory(root);
    syncDirectory(artifactRoot());
    syncDirectory(path.dirname(artifactRoot()));
    if (digest(fs.readFileSync(target)) !== artifactDigest) fail("skill_artifact_integrity_failed");
  } finally { fs.rmSync(temporary, { force: true }); }
  const ref = { contractVersion: "skill-harness-artifact-ref.v1", digest: artifactDigest };
  verifyArtifactIdentity(readHarnessArtifact(ref), identity);
  return ref;
}

export function readHarnessArtifact(ref) {
  if (ref?.contractVersion !== "skill-harness-artifact-ref.v1" || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)) {
    fail("skill_artifact_required");
  }
  const file = path.join(artifactRoot(), "objects", ref.digest.slice(7));
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 48 * 1024 * 1024) fail("skill_artifact_integrity_failed");
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== ref.digest) fail("skill_artifact_integrity_failed");
  const value = JSON.parse(bytes);
  if (value.contractVersion !== "skill-harness-artifact.v1" || !Array.isArray(value.files)) fail("skill_artifact_integrity_failed");
  const files = new Map();
  for (const [name, content] of value.files) {
    if (!name || name.startsWith("/") || /[\\\x00-\x1f]/.test(name) || name.split("/").some((p) => !p || p === "." || p === "..") || files.has(name)) fail("skill_artifact_integrity_failed");
    files.set(name, Buffer.from(content, "base64"));
  }
  return files;
}

function verifyArtifactIdentity(files, identity) {
  const bytes = files.get("runtime-harness.json");
  const manifest = bytes && JSON.parse(bytes);
  if (!identity || manifest?.contractVersion !== "skill-harness.v1" || manifest.skillId !== identity.skillId ||
    !identity.version || manifest.version !== identity.version || manifest.entrypoint !== identity.entrypoint ||
    digest(bytes) !== identity.manifestSha256 || !files.has(identity.entrypoint) ||
    digest(files.get(identity.entrypoint)) !== identity.entrypointSha256) fail("skill_artifact_identity_mismatch");
  return manifest;
}

export function harnessInstallationPath(ref) {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref?.digest || "")) fail("skill_artifact_required");
  return path.join(artifactRoot(), "installed", ref.digest.slice(7));
}

// Called only after human review. No package code or package-defined install hook runs here.
export function installHarnessArtifact({ artifact, identity, version }) {
  const files = readHarnessArtifact(artifact);
  const manifest = verifyArtifactIdentity(files, identity);
  validateHarnessManifest(manifest);
  if (manifest.version !== version || manifest.runtime !== "python3" || !manifest.invocation || !manifest.artifacts || !manifest.safeOutputContract) fail("skill_harness_environment_unsupported");
  const target = harnessInstallationPath(artifact);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = `${target}.${randomUUID()}.tmp`;
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    for (const [name, bytes] of files) {
      const filename = path.join(stage, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(filename, "wx", 0o400);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // Syntax-only compilation plus installed distribution checks; never import uploaded modules.
    try {
      execFileSync(process.env.DIGITAL_WORKFORCE_SKILL_PYTHON || "python3", ["-I", fileURLToPath(new URL("./skill-harness-environment.py", import.meta.url)), stage],
        { timeout: 30_000, stdio: "pipe", maxBuffer: 4096 });
    } catch { fail("skill_harness_environment_unsupported"); }
    const directories = new Set([stage]);
    for (const name of files.keys()) {
      let directory = path.dirname(path.join(stage, name));
      while (directory !== stage) { directories.add(directory); directory = path.dirname(directory); }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
    if (fs.existsSync(target)) verifyHarnessInstallation({ artifact, identity });
    else fs.renameSync(stage, target);
    syncDirectory(path.dirname(target));
    syncDirectory(artifactRoot());
    verifyHarnessInstallation({ artifact, identity });
    return { contractVersion: "skill-harness-installation.v1", status: "ready", artifact, version, verifiedAt: new Date().toISOString() };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function verifyHarnessInstallation({ artifact, identity }) {
  const files = readHarnessArtifact(artifact);
  const manifest = verifyArtifactIdentity(files, identity);
  const root = harnessInstallationPath(artifact);
  function inventory(directory, prefix = "") {
    const names = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) names.push(...inventory(path.join(directory, entry.name), `${name}/`));
      else names.push(name);
    }
    return names;
  }
  const installedFiles = inventory(root);
  if (installedFiles.length !== files.size || installedFiles.some((name) => !files.has(name))) fail("skill_harness_installation_corrupt");
  for (const [name, bytes] of files) {
    let current = root;
    for (const part of name.split("/")) {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("skill_harness_installation_corrupt");
      current = path.join(current, part);
    }
    const info = fs.lstatSync(current);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || digest(fs.readFileSync(current)) !== digest(bytes)) fail("skill_harness_installation_corrupt");
  }
  return { manifest, skillRoot: root, manifestSha256: identity.manifestSha256, entrypointSha256: identity.entrypointSha256 };
}
