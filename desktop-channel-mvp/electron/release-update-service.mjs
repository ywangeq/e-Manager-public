import { app, dialog, shell } from "electron";
import {
  normalizeChannel,
  normalizeDesktopUpdatePolicy,
} from "./release-update-model.mjs";
import { createDesktopReleaseUpdateController } from "./release-update-controller.mjs";
import { createSignedDesktopUpdateInstaller } from "./signed-update-installer.mjs";

export function startDesktopReleaseUpdateChecks({ channel, policy: policyInput } = {}, dependencies = {}) {
  const safeChannel = normalizeChannel(channel);
  const policy = normalizeDesktopUpdatePolicy(policyInput, { source: "managed" });
  const authorityFetchManifest = typeof dependencies.fetchManifest === "function" ? dependencies.fetchManifest : null;
  if (!app.isPackaged || !authorityFetchManifest || !safeChannel || !policy) return disabledService();

  let scheduledCheckTimer = null;
  let startupTimer = null;
  let fallbackInterval = null;
  const signedInstaller = dependencies.signedInstaller || createSignedDesktopUpdateInstaller({
    platform: dependencies.platform || process.platform,
  });
  const controller = createDesktopReleaseUpdateController({
    arch: dependencies.arch || process.arch,
    channel: safeChannel,
    currentVersion: dependencies.currentVersion || app.getVersion(),
    downloadUpdate: dependencies.downloadUpdate || signedInstaller.download,
    downloadInstaller: dependencies.downloadInstaller,
    fetchManifest: authorityFetchManifest,
    now: dependencies.now,
    onCheckScheduled: scheduleCheck,
    onScheduleCancelled: cancelScheduledCheck,
    onStateChange: dependencies.onStateChange,
    openDownloadPage: dependencies.openDownloadPage || ((url) => shell.openExternal(url)),
    openInstaller: async (open) => {
      const error = await open();
      if (error) throw new Error("installer_open_failed");
    },
    persistence: dependencies.persistence,
    platform: dependencies.platform || process.platform,
    policy,
    product: dependencies.product,
    promptRelease: dependencies.promptRelease || showUpdatePrompt,
    random: dependencies.random,
    trustedDownloadOrigin: dependencies.trustedDownloadOrigin,
  });
  if (policy.mode !== "disabled" && policy.triggers.startup) {
    startupTimer = setTimeout(() => void controller.trigger("startup"), policy.triggers.startupDelayMs);
  }
  if (policy.mode !== "disabled" && policy.triggers.fallback) {
    fallbackInterval = setInterval(() => void controller.trigger("poll"), policy.triggers.fallbackIntervalMs);
  }

  async function showUpdatePrompt(release) {
    const automaticInstall = policy.mode === "install_on_confirm";
    if (!automaticInstall && release.artifactSha256 && release.artifactSize) return { action: "defer" };
    const choice = await dialog.showMessageBox({
      type: release.mandatory ? "warning" : "info",
      buttons: [automaticInstall ? "立即升级" : "前往下载", "稍后"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "桌面助手有新版本",
      message: `发现 ${release.channel === "beta" ? "Beta " : ""}版本 ${release.version}`,
      detail: [
        `当前版本：${app.getVersion()}`,
        release.releaseNotes || (automaticInstall ? "升级包将由桌面助手自动下载并安装。" : "请前往企业下载页安装新版。"),
        automaticInstall
          ? "点击后将在后台下载；完成校验后，桌面助手会自动退出、安装并重启。"
          : "当前安装包尚未接入受信签名，需要由用户确认并覆盖安装。",
      ].join("\n\n"),
    });
    return { action: choice.response === 0 ? (automaticInstall ? "install" : "download") : "defer" };
  }

  function scheduleCheck({ delayMs, reason }) {
    cancelScheduledCheck();
    scheduledCheckTimer = setTimeout(() => void controller.trigger(reason), delayMs);
  }

  function cancelScheduledCheck() {
    if (scheduledCheckTimer) clearTimeout(scheduledCheckTimer);
    scheduledCheckTimer = null;
  }

  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    if (fallbackInterval) clearInterval(fallbackInterval);
    fallbackInterval = null;
    cancelScheduledCheck();
    controller.stop();
  }

  return {
    acceptSignal: controller.acceptSignal,
    checkNow: (reason = "manual") => controller.trigger(reason),
    downloadAvailable: controller.downloadAvailable,
    defer: controller.defer,
    enabled: policy.mode !== "disabled",
    getState: controller.getState,
    policy,
    policySource: policy.source,
    notifyNetworkRestored: () => controller.trigger("network"),
    notifyResume: () => controller.trigger("resume"),
    openDownloaded: controller.openDownloaded,
    stop,
    subscribe: controller.subscribe,
    trigger: controller.trigger,
  };
}

function disabledService() {
  return {
    acceptSignal: async () => ({ status: "disabled" }),
    checkNow: async () => ({ status: "disabled" }),
    downloadAvailable: async () => ({ status: "disabled" }),
    defer: async () => ({ status: "disabled" }),
    enabled: false,
    getState: () => ({ status: "disabled" }),
    notifyNetworkRestored: async () => ({ status: "disabled" }),
    notifyResume: async () => ({ status: "disabled" }),
    openDownloaded: async () => ({ status: "disabled" }),
    stop: () => {},
    subscribe: () => () => {},
    trigger: async () => ({ status: "disabled" }),
  };
}
