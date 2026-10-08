import { safeHttpsUrl } from "./release-update-model.mjs";

export function createSignedDesktopUpdateInstaller({
  platform = process.platform,
  updaterFactory = createPlatformUpdater,
} = {}) {
  let activeDownload = null;

  async function download(release = {}, { onProgress = () => {} } = {}) {
    if (activeDownload) return activeDownload;
    activeDownload = prepareUpdate(release, { onProgress }).finally(() => {
      activeDownload = null;
    });
    return activeDownload;
  }

  async function prepareUpdate(release, { onProgress }) {
    const feedUrl = safeHttpsUrl(release.autoUpdateFeedUrl);
    if (!feedUrl) throw new Error("signed_update_feed_unavailable");
    const updater = await updaterFactory({ channel: release.channel, feedUrl, platform });
    if (!updater || typeof updater.checkForUpdates !== "function" || typeof updater.downloadUpdate !== "function") {
      throw new Error("desktop_updater_unavailable");
    }

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    const progressListener = (progress = {}) => onProgress(normalizeProgress(progress));
    updater.on?.("download-progress", progressListener);
    try {
      const check = await updater.checkForUpdates();
      if (String(check?.updateInfo?.version || "") !== release.version) {
        throw new Error("center_update_feed_version_mismatch");
      }
      await updater.downloadUpdate();
      onProgress({ percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 });
      return {
        install() {
          updater.quitAndInstall(false, true);
        },
      };
    } finally {
      updater.removeListener?.("download-progress", progressListener);
    }
  }

  return { download };
}

async function createPlatformUpdater({ channel, feedUrl, platform }) {
  const updaterModule = await import("electron-updater");
  const exports = updaterModule.default || updaterModule;
  const Updater = platform === "darwin" ? exports.MacUpdater : platform === "win32" ? exports.NsisUpdater : null;
  if (!Updater) throw new Error("desktop_update_platform_unsupported");
  return new Updater({ channel, provider: "generic", url: feedUrl });
}

function normalizeProgress(value = {}) {
  return {
    percent: boundedNumber(value.percent, 0, 100),
    bytesPerSecond: boundedNumber(value.bytesPerSecond, 0, Number.MAX_SAFE_INTEGER),
    transferred: boundedNumber(value.transferred, 0, Number.MAX_SAFE_INTEGER),
    total: boundedNumber(value.total, 0, Number.MAX_SAFE_INTEGER),
  };
}

function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : 0;
}
