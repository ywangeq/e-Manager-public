import fs from "node:fs";
import path from "node:path";
import { createManagedSandboxProviderRegistry } from "./managed-sandbox-provider-registry-v1.mjs";

const RELEASE_PROVIDER_MANIFEST_CONTRACT = "desktop-release-sandbox-providers.v1";

function createDesktopSandboxReleaseProviderResolver({ artifactDir = "", now = () => new Date().toISOString(), releaseVersion = "" } = {}) {
  const directory = String(artifactDir || "").trim();
  const version = String(releaseVersion || "").trim();
  function resolveReadyProvider({ profileDigest = "" } = {}) {
    const manifest = readManifest(directory, version);
    if (!manifest) return null;
    try {
      return createManagedSandboxProviderRegistry({ now, providers: manifest.managedSandboxProviders.providers })
        .resolveReadyProvider({ profileDigest });
    } catch { return null; }
  }
  return Object.freeze({ resolveReadyProvider });
}

function readManifest(directory, version) {
  if (!directory || !version) return null;
  try {
    const input = JSON.parse(fs.readFileSync(path.join(path.resolve(directory), "latest.json"), "utf8"));
    if (input?.schemaVersion !== 1 || input?.version !== version || input?.managedSandboxProviders?.contractVersion !== RELEASE_PROVIDER_MANIFEST_CONTRACT ||
      !Array.isArray(input.managedSandboxProviders.providers)) return null;
    return input;
  } catch { return null; }
}

export { RELEASE_PROVIDER_MANIFEST_CONTRACT, createDesktopSandboxReleaseProviderResolver };
