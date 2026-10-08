import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

export function createUnsignedUpdateDownload({ directory, fetchInstaller, openPath, platform, currentActor }) {
  return async function download(release, { onProgress = () => {} } = {}) {
    const actor = currentActor?.();
    if (!actor?.key) throw new Error("authentication_required");
    const suffix = platform === "darwin" ? "dmg" : platform === "win32" ? "exe" : "";
    if (!suffix || !/^[0-9A-Za-z.-]{1,80}$/.test(release?.version)
      || !/^[a-f0-9]{64}$/.test(release?.artifactSha256 || "")
      || !Number.isSafeInteger(release?.artifactSize) || release.artifactSize < 1
      || release.artifactSize > MAX_INSTALLER_BYTES) throw new Error("invalid_installer_metadata");
    const version = release.version;
    const fileName = `SmartMore-Digital-Workforce-${version}-${platform === "darwin" ? "arm64" : "x64"}.${suffix}`;
    const destination = path.join(directory, fileName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await stat(destination).catch(() => null);
    if (existing?.isFile() && existing.size === release.artifactSize && await digestFile(destination) === release.artifactSha256) {
      assertActor();
      onProgress({ percent: 100, total: existing.size, transferred: existing.size });
      return { open: () => openVerified(destination, release, openPath, assertActor) };
    }
    if (existing) {
      if (!existing.isFile()) throw new Error("installer_path_conflict");
      await rm(destination);
    }
    const temporary = `${destination}.${process.pid}.${Date.now()}.partial`;
    try {
      const response = await fetchInstaller(release);
      if (!response?.ok || !response.body || Number(response.headers?.get("content-length")) !== release.artifactSize) {
        throw new Error("installer_response_invalid");
      }
      const hash = createHash("sha256");
      let transferred = 0;
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
          transferred += chunk.length;
          if (transferred > release.artifactSize) throw new Error("installer_too_large");
          hash.update(chunk);
          onProgress({ percent: transferred / release.artifactSize * 100, total: release.artifactSize, transferred });
          yield chunk;
        }
      }, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (transferred !== release.artifactSize || hash.digest("hex") !== release.artifactSha256) {
        throw new Error("installer_checksum_mismatch");
      }
      assertActor();
      await rename(temporary, destination);
      return { open: () => openVerified(destination, release, openPath, assertActor) };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    function assertActor() {
      const current = currentActor?.();
      if (!current?.key || current.key !== actor.key || current.version !== actor.version) {
        throw new Error("authentication_changed");
      }
    }
  };
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function openVerified(filePath, release, openPath, assertActor) {
  assertActor();
  const file = await stat(filePath);
  if (!file.isFile() || file.size !== release.artifactSize || await digestFile(filePath) !== release.artifactSha256) {
    throw new Error("installer_checksum_mismatch");
  }
  assertActor();
  return openPath(filePath);
}
