import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createPromotedGroupCatalogReader } from "./promoted-group-release-catalog.mjs";
import products from "../desktop-channel-mvp/shared/desktop-product.cjs";
import {
  DESKTOP_UPDATE_SIGNAL_CONTRACT,
  normalizeReleaseManifest,
  normalizeChannel,
  normalizeDesktopUpdatePolicy,
  safeHttpsUrl,
} from "../desktop-channel-mvp/electron/release-update-model.mjs";

const CONTRACT_VERSION = "desktop-release-catalog.v1";
const SIGNAL_EVENT = "desktop-release-update";
const PLATFORM_OPTIONS = Object.freeze({
  "darwin-arm64": { arch: "arm64", label: "macOS Apple Silicon", platform: "darwin" },
  "win32-x64": { arch: "x64", label: "Windows x64", platform: "win32" },
});

function createDesktopReleaseHandlers({
  channel = "beta",
  clearIntervalFn = clearInterval,
  clearTimeoutFn = clearTimeout,
  createId = randomUUID,
  inspectArtifact = defaultInspectArtifact,
  localArtifactDir = "",
  localManifestDir = "",
  localVersion = "",
  manifestUrl = "",
  publicOrigin = "",
  now = () => Date.now(),
  requestJson = defaultRequestJson,
  routeBase = "/api/desktop-releases",
  majorVersion = null,
  requireSession,
  sendArtifact = defaultSendArtifact,
  sendJson,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  updatePolicy: updatePolicyInput = null,
} = {}) {
  if (!["/api/desktop-releases", "/api/desktop-releases/group-studio"].includes(routeBase)
    || (majorVersion !== null && (!Number.isSafeInteger(majorVersion) || majorVersion < 1))) {
    throw new TypeError("invalid desktop release route configuration");
  }
  const product = routeBase === products.GROUP_STUDIO_PRODUCT.routeBase ? products.GROUP_STUDIO_PRODUCT : products.DESKTOP_PRODUCT;
  if (product === products.GROUP_STUDIO_PRODUCT && majorVersion !== 3) throw new TypeError("Group release requires major version 3");
  const releaseChannel = normalizeChannel(channel);
  const releaseManifestUrl = safeHttpsUrl(manifestUrl);
  const updatePolicy = normalizeDesktopUpdatePolicy(updatePolicyInput, { source: "center_managed" });
  const signalPolicy = updatePolicy && updatePolicy.mode !== "disabled"
    && updatePolicy.triggers.signal
    && updatePolicy.triggers.minCheckIntervalMs > 0
    ? updatePolicy
    : null;
  const streamEpoch = cleanEventKey(createId()) || cleanEventKey(randomUUID());
  const subscribers = new Set();
  let cached = null;
  let refreshPromise = null;
  let refreshTimer = null;
  let sequence = 0;
  const localArtifactDigests = new Map();
  const localManifestConfigured = Boolean(localManifestDir);
  let promotedReader = null;
  if (localManifestConfigured && product === products.GROUP_STUDIO_PRODUCT && !localArtifactDir && !localVersion && !manifestUrl) {
    try { promotedReader = createPromotedGroupCatalogReader({ directory: localManifestDir, publicOrigin, channel: releaseChannel }); }
    catch { /* Invalid release configuration degrades downloads, not business APIs. */ }
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith(`${routeBase}/`)) return undefined;
    const releasePath = url.pathname.slice(routeBase.length);
    if (req.method === "GET" && product === products.GROUP_STUDIO_PRODUCT && releasePath.startsWith("/feed/")) {
      await servePromotedFeed(req, res, releasePath);
      return true;
    }
    if (req.method === "GET" && releasePath === "/latest") {
      await listLatest(req, res);
      return true;
    }
    if (req.method === "GET" && releasePath === "/signals") {
      await openSignalStream(req, res);
      return true;
    }
    const match = releasePath.match(/^\/latest\/download\/([^/]+)$/);
    if (req.method === "GET" && match) {
      await downloadLatest(req, res, decodeURIComponent(match[1]));
      return true;
    }
    const pinned = releasePath.match(/^\/versions\/([^/]+)\/download\/([^/]+)$/);
    if (req.method === "GET" && pinned) {
      await downloadLatest(req, res, decodeURIComponent(pinned[2]), decodeURIComponent(pinned[1]), url.searchParams.get("sha256") || "");
      return true;
    }
    return undefined;
  }

  async function listLatest(req, res) {
    if (!requireSession(req, res)) return null;
    const catalog = await loadCatalog();
    if (!catalog.ok) return sendJson(res, catalog.httpStatus, catalog);
    return sendJson(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      release: {
        product: product.productId,
        channel: catalog.channel,
        downloadPageUrl: ["remote_manifest", "published_manifest"].includes(catalog.source) ? safeHttpsUrl(catalog.downloadPageUrl) : "",
        distributionNotice: catalog.distributionNotice || "",
        manifestRevision: catalog.manifestRevision,
        mandatory: catalog.mandatory === true,
        version: catalog.version,
        publishedAt: catalog.publishedAt,
        releaseNotes: catalog.releaseNotes,
        source: catalog.source,
        platforms: Object.fromEntries(Object.entries(catalog.platforms).map(([id, platform]) => [id, {
          available: Boolean(platform?.artifactUrl || platform?.artifactPath),
          autoUpdate: {
            available: catalog.source === "remote_manifest" && Boolean(platform?.autoUpdateFeedUrl),
            feedUrl: catalog.source === "remote_manifest" ? platform?.autoUpdateFeedUrl || "" : "",
            signed: catalog.source === "remote_manifest" && Boolean(platform?.autoUpdateFeedUrl),
          },
          label: PLATFORM_OPTIONS[id].label,
          sha256: platform?.artifactSha256 || platform?.sha256 || "",
          size: platform?.artifactSize || platform?.size || 0,
          downloadUrl: platform?.artifactUrl || platform?.artifactPath ? `${routeBase}/latest/download/${id}` : "",
          pinnedDownloadUrl: platform?.artifactUrl || platform?.artifactPath ? `${routeBase}/versions/${encodeURIComponent(catalog.version)}/download/${id}` : "",
        }])),
      },
    });
  }

  async function downloadLatest(req, res, platformId, pinnedVersion = "", pinnedSha256 = "") {
    if (!requireSession(req, res)) return null;
    if (!PLATFORM_OPTIONS[platformId]) return sendJson(res, 404, { ok: false, error: "desktop_release_platform_not_supported" });
    const catalog = await loadCatalog();
    if (!catalog.ok) return sendJson(res, catalog.httpStatus, catalog);
    if (pinnedVersion && pinnedVersion !== catalog.version) return sendJson(res, 409, { ok: false, error: "desktop_release_version_changed" });
    const platform = catalog.platforms[platformId];
    if (pinnedVersion && (!/^[a-f0-9]{64}$/.test(pinnedSha256) || pinnedSha256 !== (platform?.artifactSha256 || platform?.sha256))) {
      return sendJson(res, 409, { ok: false, error: "desktop_release_artifact_changed" });
    }
    if (catalog.source === "published_manifest") {
      return sendPromotedArtifact(res, catalog, platformId);
    }
    if (platform?.artifactPath) {
      if (pinnedVersion && hashLocalArtifact(platform.artifactPath) !== pinnedSha256) {
        return sendJson(res, 409, { ok: false, error: "desktop_release_artifact_changed" });
      }
      await sendArtifact(res, platform.artifactPath, platform.fileName);
      return null;
    }
    const artifactUrl = platform?.artifactUrl;
    if (!artifactUrl) return sendJson(res, 404, { ok: false, error: "desktop_release_artifact_unavailable", platform: platformId });
    res.writeHead(302, { Location: artifactUrl, "Cache-Control": "no-store" });
    res.end();
    return null;
  }

  async function openSignalStream(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (!signalPolicy) {
      return sendJson(res, 503, {
        ok: false,
        error: "desktop_release_signal_policy_unavailable",
        message: "桌面更新推送策略尚未配置。",
      });
    }
    const catalog = await loadCatalog();
    if (!catalog.ok) return sendJson(res, catalog.httpStatus, catalog);
    if (!catalogSupportsSignal(catalog, signalPolicy)) {
      return sendJson(res, 503, {
        ok: false,
        error: "desktop_release_signal_authority_unavailable",
        message: "桌面更新推送尚未连接可操作的权威发布目录。",
      });
    }

    startSignalStream(res);
    const subscriber = { expiryTimer: null, req, res };
    subscribers.add(subscriber);
    bindSubscriberLifecycle(subscriber, session);
    writeSignal(subscriber, createSignal(catalog.manifestRevision));
    startRefreshTimer();
    return null;
  }

  async function loadCatalog({ force = false } = {}) {
    if (localManifestConfigured) {
      try {
        if (!promotedReader) throw new Error("invalid publication configuration");
        return await promotedReader.read();
      } catch {
        return { ok: false, httpStatus: 503, error: "desktop_release_manifest_unavailable", message: "桌面安装包目录暂时不可用，请稍后重试。" };
      }
    }
    if (!releaseChannel) {
      return { ok: false, httpStatus: 503, error: "desktop_release_manifest_not_configured", message: "桌面安装包发布目录尚未配置。" };
    }
    const localCatalog = () => validateCatalogVersion(createLocalBetaCatalog({
      artifactDir: localArtifactDir,
      channel: releaseChannel,
      inspectArtifact: (filePath) => {
        const info = inspectArtifact(filePath);
        if (!info) return null;
        if (info.sha256) return info;
        const key = `${filePath}:${info.modifiedAt}:${info.size}`;
        let digest = localArtifactDigests.get(key);
        if (!digest && info.size > 0) {
          digest = hashLocalArtifact(filePath);
          localArtifactDigests.set(key, digest);
        }
        return { ...info, sha256: digest || "" };
      },
      signalEligible: !releaseManifestUrl,
      version: localVersion,
    }));
    if (!releaseManifestUrl) return localCatalog() || { ok: false, httpStatus: 503, error: "desktop_release_manifest_not_configured", message: "桌面安装包发布目录尚未配置。" };
    if (!force && cached?.expiresAt > now()) return cached.value;
    try {
      const response = await requestJson(releaseManifestUrl);
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("desktop_release_manifest_unavailable");
      const platforms = Object.fromEntries(Object.entries(PLATFORM_OPTIONS).map(([id, options]) => [
        id,
        normalizeReleaseManifest(response.body, { ...options, channel: releaseChannel, product: product.productId }),
      ]));
      const first = Object.values(platforms).find((platform) => platform?.artifactUrl);
      if (!first) throw new Error("desktop_release_manifest_invalid");
      const value = validateCatalogVersion({
        ok: true,
        channel: first.channel,
        downloadPageUrl: first.downloadPageUrl,
        mandatory: first.mandatory === true,
        distributionNotice: "",
        version: first.version,
        publishedAt: first.publishedAt,
        releaseNotes: first.releaseNotes,
        manifestRevision: digestRevision(response.body),
        source: "remote_manifest",
        platforms,
      });
      if (!value) throw new Error("desktop_release_manifest_invalid");
      cached = { expiresAt: now() + (signalPolicy?.triggers.minCheckIntervalMs || 0), value };
      return value;
    } catch {
      return localCatalog() || { ok: false, httpStatus: 503, error: "desktop_release_manifest_unavailable", message: "桌面安装包目录暂时不可用，请稍后重试。" };
    }
  }

  async function sendPromotedArtifact(res, catalog, platformId) {
    let artifact;
    try { artifact = await promotedReader.openArtifact(catalog.manifest, platformId, { forceHash: true }); }
    catch { return sendJson(res, 409, { ok: false, error: "desktop_release_artifact_changed" }); }
    let stream;
    try {
      stream = createReadStream("", { fd: artifact.fd, autoClose: true, start: 0, end: artifact.info.size - 1 });
      res.writeHead(200, {
        "Cache-Control": "private, no-store", "Content-Length": artifact.info.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
        "Content-Type": artifact.fileName.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable",
        "X-Content-Type-Options": "nosniff",
      });
      await pipeline(stream, res);
    } catch {
      if (stream) stream.destroy();
      else closeSync(artifact.fd);
      res.destroy?.();
    }
    return null;
  }

  async function servePromotedFeed(req, res, releasePath) {
    if (!requireSession(req, res)) return null;
    if (!promotedReader) return sendJson(res, 503, { ok: false, error: "desktop_release_manifest_unavailable" });
    const head = releasePath.match(/^\/feed\/(beta)\/latest\.json$/);
    const versioned = releasePath.match(/^\/feed\/(beta)\/releases\/([^/]+)\/([^/]+)$/);
    if ((!head && !versioned) || (head || versioned)[1] !== releaseChannel) return sendJson(res, 404, { ok: false, error: "desktop_release_artifact_unavailable" });
    let catalog;
    try { catalog = await promotedReader.read(versioned ? decodeURIComponent(versioned[2]) : ""); }
    catch (error) {
      if (error.code === "desktop_release_version_changed") return sendJson(res, 409, { ok: false, error: "desktop_release_version_changed" });
      return sendJson(res, 503, { ok: false, error: "desktop_release_manifest_unavailable" });
    }
    const file = versioned ? versioned[3] : "latest.json";
    if (file === "latest.json") {
      res.writeHead(200, { "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8",
        "Content-Length": catalog.manifestBytes.length, "X-Content-Type-Options": "nosniff" });
      res.end(catalog.manifestBytes);
      return null;
    }
    const platformId = Object.keys(catalog.platforms).find(id => catalog.platforms[id].fileName === file);
    if (!platformId) return sendJson(res, 404, { ok: false, error: "desktop_release_artifact_unavailable" });
    return sendPromotedArtifact(res, catalog, platformId);
  }

  function validateCatalogVersion(catalog) {
    return catalog && products.supportsVersion(product, catalog.version)
      && (majorVersion === null || Number(catalog.version.split(".")[0]) === majorVersion) ? catalog : null;
  }

  function startRefreshTimer() {
    if (refreshTimer || subscribers.size === 0) return;
    refreshTimer = setIntervalFn(refreshSignals, signalPolicy.triggers.minCheckIntervalMs);
    refreshTimer?.unref?.();
  }

  function stopRefreshTimer() {
    if (!refreshTimer) return;
    clearIntervalFn(refreshTimer);
    refreshTimer = null;
  }

  async function refreshSignals() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const catalog = await loadCatalog({ force: true });
      if (!catalog.ok) {
        for (const subscriber of [...subscribers]) writeHeartbeat(subscriber, "manifest-unavailable");
        return catalog;
      }
      if (!catalogSupportsSignal(catalog, signalPolicy)) {
        for (const subscriber of [...subscribers]) writeHeartbeat(subscriber, "authority-unavailable");
        return catalog;
      }
      const changedSubscribers = [...subscribers]
        .filter((subscriber) => subscriber.manifestRevision !== catalog.manifestRevision);
      if (changedSubscribers.length === 0) {
        for (const subscriber of [...subscribers]) writeHeartbeat(subscriber, "current");
        return catalog;
      }
      const signal = createSignal(catalog.manifestRevision);
      for (const subscriber of changedSubscribers) writeSignal(subscriber, signal);
      return catalog;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function createSignal(manifestRevision) {
    const publishedAtMs = now();
    sequence += 1;
    return {
      channel: releaseChannel,
      contractVersion: DESKTOP_UPDATE_SIGNAL_CONTRACT,
      eventId: cleanEventKey(createId()) || `${streamEpoch}:${sequence}`,
      expiresAt: new Date(publishedAtMs + signalPolicy.triggers.fallbackIntervalMs).toISOString(),
      manifestRevision,
      product: product.productId,
      publishedAt: new Date(publishedAtMs).toISOString(),
      sequence,
      streamEpoch,
    };
  }

  function bindSubscriberLifecycle(subscriber, session) {
    const close = () => removeSubscriber(subscriber);
    subscriber.req?.once?.("aborted", close);
    subscriber.req?.once?.("close", close);
    subscriber.res?.once?.("close", close);
    const authExpiresAt = effectiveSessionExpiry(session);
    if (!authExpiresAt) return;
    subscriber.expiryTimer = setTimeoutFn(() => removeSubscriber(subscriber, { end: true }), Math.max(1, authExpiresAt - now()));
    subscriber.expiryTimer?.unref?.();
  }

  function removeSubscriber(subscriber, { end = false } = {}) {
    if (!subscribers.delete(subscriber)) return;
    if (subscriber.expiryTimer) clearTimeoutFn(subscriber.expiryTimer);
    subscriber.expiryTimer = null;
    if (end && !subscriber.res.writableEnded) subscriber.res.end();
    if (subscribers.size === 0) stopRefreshTimer();
  }

  function writeSignal(subscriber, signal) {
    try {
      subscriber.res.write(`id: ${signal.eventId}\n`);
      subscriber.res.write(`event: ${SIGNAL_EVENT}\n`);
      subscriber.res.write(`data: ${JSON.stringify(signal)}\n\n`);
      subscriber.manifestRevision = signal.manifestRevision;
    } catch {
      removeSubscriber(subscriber);
    }
  }

  function writeHeartbeat(subscriber, status) {
    try {
      subscriber.res.write(`: ${status}\n\n`);
    } catch {
      removeSubscriber(subscriber);
    }
  }

  return { handle };
}

function createLocalBetaCatalog({ artifactDir = "", channel = "", inspectArtifact, signalEligible = false, version = "" } = {}) {
  const releaseVersion = String(version || "").trim();
  if (channel !== "beta" || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(releaseVersion) || !artifactDir) return null;
  const releaseDir = path.resolve(artifactDir);
  const fileNames = {
    "darwin-arm64": `SmartMore-Digital-Workforce-${releaseVersion}-arm64.dmg`,
    "win32-x64": `SmartMore-Digital-Workforce-${releaseVersion}-x64.exe`,
  };
  let publishedAt = "";
  const platforms = Object.fromEntries(Object.entries(fileNames).map(([id, fileName]) => {
    const artifactPath = path.join(releaseDir, fileName);
    const artifact = inspectArtifact(artifactPath);
    if (!artifact) return [id, null];
    if (!publishedAt || artifact.modifiedAt > publishedAt) publishedAt = artifact.modifiedAt;
    return [id, { artifactPath, fileName, modifiedAt: artifact.modifiedAt, size: artifact.size, sha256: artifact.sha256 || "" }];
  }));
  if (!Object.values(platforms).some(Boolean)) return null;
  const catalog = {
    ok: true,
    channel,
    distributionNotice: "内网 beta 临时分发：文件由当前数字中心主机提供，主机离线时不可下载。",
    version: releaseVersion,
    publishedAt,
    releaseNotes: "内网 beta 临时分发包；正式 HTTPS Publisher Runner 配置完成后移除。",
    mandatory: false,
    source: "local_beta",
    signalEligible: signalEligible === true,
    platforms,
  };
  catalog.manifestRevision = digestRevision({
    channel: catalog.channel,
    platforms: Object.fromEntries(Object.entries(platforms).map(([id, artifact]) => [id, artifact ? {
      fileName: artifact.fileName,
      modifiedAt: artifact.modifiedAt,
      size: artifact.size,
    } : null])),
    publishedAt: catalog.publishedAt,
    version: catalog.version,
  });
  return catalog;
}

function startSignalStream(res) {
  res.writeHead(200, {
    "Cache-Control": "private, no-store, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function catalogSupportsSignal(catalog = {}, policy = {}) {
  if (catalog.source === "remote_manifest") return Boolean(safeHttpsUrl(catalog.downloadPageUrl));
  if (catalog.source === "published_manifest") return policy.mode === "notify_only" && Boolean(safeHttpsUrl(catalog.downloadPageUrl));
  return catalog.source === "local_beta"
    && catalog.signalEligible === true
    && policy.mode === "notify_only"
    && Object.values(catalog.platforms || {}).some((platform) => Boolean(platform?.artifactPath));
}

function digestRevision(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanEventKey(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]+/g, "").slice(0, 160);
}

function effectiveSessionExpiry(session = {}) {
  const candidates = [session.expiresAt, session.authorization?.validUntil]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : 0;
}

function defaultInspectArtifact(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? { modifiedAt: stat.mtime.toISOString(), size: stat.size } : null;
  } catch {
    return null;
  }
}

function hashLocalArtifact(filePath) {
  try {
    const hash = createHash("sha256");
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytes;
      while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
}

async function defaultSendArtifact(res, filePath, fileName) {
  const stat = statSync(filePath);
  const contentType = fileName.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable";
  res.writeHead(200, {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Content-Length": stat.size,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
}

async function defaultRequestJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) });
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("desktop_release_manifest_too_large");
  return { statusCode: response.status, body: text ? JSON.parse(text) : {} };
}

export { createDesktopReleaseHandlers };
