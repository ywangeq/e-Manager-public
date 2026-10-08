import {
  DESKTOP_RELEASE_PRODUCT_ID,
  DESKTOP_UPDATE_POLICY_CONTRACT,
  isReleaseNewer,
  normalizeDesktopUpdateSignal,
  normalizeReleaseManifest,
  releaseTargetKey,
} from "./release-update-model.mjs";

const PREFERENCES_CONTRACT = "desktop-update-preferences.v2";
const MAX_PREFERENCES = 100;
const MAX_SIGNAL_DEDUPE_KEYS = 100;
const MAX_STREAM_EPOCHS = 10;

export function createDesktopReleaseUpdateController({
  arch,
  channel,
  currentVersion,
  downloadUpdate = async () => { throw new Error("desktop_updater_unavailable"); },
  downloadInstaller = async () => { throw new Error("desktop_installer_download_unavailable"); },
  fetchManifest,
  now = () => Date.now(),
  onCheckScheduled = () => {},
  onScheduleCancelled = () => {},
  onStateChange = () => {},
  openDownloadPage = async () => {},
  openInstaller = async () => { throw new Error("desktop_installer_unavailable"); },
  persistence = null,
  platform,
  product = DESKTOP_RELEASE_PRODUCT_ID,
  policy,
  promptRelease = async () => ({ action: "defer" }),
  random = Math.random,
  trustedDownloadOrigin = "",
} = {}) {
  const preferences = new Map();
  const subscribers = new Set();
  const seenEventIds = new Set();
  const streamSequences = new Map();
  let activeCheck = null;
  let activeSignalRevision = "";
  let failureCount = 0;
  let initialization = null;
  let initialized = false;
  let lastCheckStartedAt = 0;
  let pendingSignalRevision = "";
  let scheduledManifestRevision = "";
  let scheduledReason = "";
  let stopped = false;
  let state = createInitialState({ arch, channel, currentVersion, platform, policy, product });
  let readyInstaller = null;
  let installerDownload = null;
  let preparingInstaller = false;

  async function initialize() {
    if (initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      if (!policy.defer) {
        setState({ persistenceStatus: "disabled" });
        initialized = true;
        return;
      }
      if (!persistence?.load || !persistence?.save) {
        markPersistenceDegraded("preference_persistence_unavailable", "unavailable");
        initialized = true;
        return;
      }
      try {
        const payload = await persistence.load();
        for (const entry of normalizePreferences(payload)) preferences.set(entry.key, entry);
        setState({ persistenceStatus: "ready" });
      } catch {
        markPersistenceDegraded("preference_persistence_load_failed", "failed");
      }
      initialized = true;
    })();
    return initialization;
  }

  async function trigger(reason = "manual") {
    const safeReason = normalizeTriggerReason(reason);
    if (!safeReason) return { status: "trigger_invalid" };
    const manifestRevision = safeReason === scheduledReason ? scheduledManifestRevision : "";
    if (safeReason === scheduledReason) {
      scheduledManifestRevision = "";
      scheduledReason = "";
    }
    return requestCheck(safeReason, { manifestRevision });
  }

  async function acceptSignal(input = {}) {
    const signal = normalizeDesktopUpdateSignal(input, { channel, product, now: now() });
    if (!signal) return { status: "signal_invalid" };
    if (!policyAllows("signal")) return { status: "signal_disabled" };
    if (isDuplicateSignal(signal)) return { status: "signal_duplicate" };
    rememberConnectionEvent(signal);
    setState({ lastSignalManifestRevision: signal.manifestRevision });
    return requestCheck("signal", { manifestRevision: signal.manifestRevision });
  }

  async function requestCheck(reason, { manifestRevision = "" } = {}) {
    if (stopped) return { status: "stopped" };
    if (policy?.contractVersion !== DESKTOP_UPDATE_POLICY_CONTRACT || policy.mode === "disabled") {
      return { status: "policy_disabled" };
    }
    if (!policyAllows(reason)) return { status: "trigger_disabled", trigger: reason };
    if (preparingInstaller || installerDownload) return { status: "downloading" };
    await initialize();

    if (activeCheck) {
      if (reason === "signal" && manifestRevision && manifestRevision !== activeSignalRevision) {
        pendingSignalRevision = manifestRevision;
      }
      return activeCheck;
    }

    const currentTime = now();
    const retryAt = Date.parse(state.retryAt || "");
    if (reason !== "manual" && Number.isFinite(retryAt) && retryAt > currentTime) {
      scheduleCheck(retryAt - currentTime, reason, manifestRevision);
      return { retryAt: state.retryAt, status: "backoff_pending" };
    }
    const nextEligibleAt = lastCheckStartedAt + policy.triggers.minCheckIntervalMs;
    if (reason !== "manual" && nextEligibleAt > currentTime) {
      const eligibleAt = new Date(nextEligibleAt).toISOString();
      setState({ nextEligibleCheckAt: eligibleAt });
      scheduleCheck(nextEligibleAt - currentTime, reason, manifestRevision);
      return { nextEligibleCheckAt: eligibleAt, status: "throttled" };
    }

    lastCheckStartedAt = currentTime;
    activeSignalRevision = manifestRevision;
    setState({ nextEligibleCheckAt: "" });
    activeCheck = runCheck(reason).finally(() => {
      activeCheck = null;
      activeSignalRevision = "";
      const trailingRevision = pendingSignalRevision;
      pendingSignalRevision = "";
      if (trailingRevision && !stopped) {
        void requestCheck("signal", { manifestRevision: trailingRevision });
      }
    });
    return activeCheck;
  }

  async function defer({ until, version } = {}) {
    if (!policy || policy.mode === "disabled") return { status: "policy_disabled" };
    await initialize();
    const key = releaseTargetKey({ arch, channel, platform, product, version });
    if (!key || key !== state.targetKey) return { status: "release_not_available" };
    if (!policy.defer) {
      const status = state.mandatory ? "mandatory_pending" : "deferred";
      setState({ deferUntil: "", status });
      return { deferUntil: "", status, version: state.targetVersion };
    }
    const deferUntil = boundedDeferUntil(until, state.mandatory === true);
    await savePreference({
      deferUntil,
      disposition: "deferred",
      key,
      lastPromptedAt: new Date(now()).toISOString(),
      mandatory: state.mandatory === true,
      policyVersion: policy.policyVersion,
    });
    setState({ deferUntil, status: state.mandatory ? "mandatory_pending" : "deferred" });
    return { deferUntil, status: state.status, version: state.targetVersion };
  }

  async function runCheck(reason) {
    setState({ lastCheckedAt: new Date(now()).toISOString(), lastTrigger: reason, status: "checking" });
    let input;
    try {
      input = await fetchManifest?.({ reason });
    } catch {
      if (stopped) return { status: "stopped" };
      return recordFailure("check_failed", reason);
    }
    if (stopped) return { status: "stopped" };

    const release = normalizeReleaseManifest(input, { arch, channel, platform, product, trustedDownloadOrigin });
    if (!release) return recordFailure("manifest_invalid", reason);
    resetBackoff();
    if (!isReleaseNewer(release.version, currentVersion)) {
      readyInstaller = null;
      setState(clearTarget({ status: "up_to_date" }));
      return { status: "up_to_date", version: release.version };
    }
    if (policy.mode === "install_on_confirm" && !release.autoUpdateFeedUrl) {
      return recordFailure("signed_update_unavailable", reason);
    }

    const targetKey = releaseTargetKey({ arch, channel, platform, product, version: release.version });
    if (readyInstaller && (readyInstaller.targetKey !== targetKey || readyInstaller.sha256 !== release.artifactSha256)) readyInstaller = null;
    const storedPreference = preferences.get(targetKey);
    const preference = storedPreference?.policyVersion === policy.policyVersion
      && storedPreference?.mandatory === release.mandatory
      ? storedPreference
      : null;
    const pendingState = release.mandatory ? "mandatory_pending" : "available";
    setState({
      deferUntil: preference?.deferUntil || "",
      mandatory: release.mandatory,
      status: pendingState,
      targetKey,
      targetVersion: release.version,
      canDownload: policy.mode === "notify_only" && Boolean(release.artifactSha256 && release.artifactSize),
    });

    if (readyInstaller?.targetKey === targetKey && state.canDownload) {
      setState({ status: "downloaded", downloadPercent: 100 });
      return { status: "downloaded", version: release.version };
    }

    if (Date.parse(preference?.deferUntil || "") > now()) {
      const status = release.mandatory ? "mandatory_pending" : "deferred";
      setState({ status });
      return { deferUntil: preference.deferUntil, status, version: release.version };
    }

    let choice;
    try {
      choice = normalizePromptChoice(await promptRelease(release));
    } catch {
      if (stopped) return { status: "stopped" };
      return recordFailure("prompt_failed", reason);
    }
    if (stopped) return { status: "stopped" };
    const promptedAt = new Date(now()).toISOString();
    if (choice.action === "install" && policy.mode === "install_on_confirm") {
      setState({
        downloadBytesPerSecond: 0,
        downloadPercent: 0,
        downloadTotal: 0,
        downloadTransferred: 0,
        status: "downloading",
      });
      let preparedUpdate;
      try {
        preparedUpdate = await downloadUpdate(release, {
          onProgress: (progress) => {
            if (stopped) return;
            setState({
              downloadBytesPerSecond: boundedProgress(progress?.bytesPerSecond),
              downloadPercent: boundedProgress(progress?.percent, 100),
              downloadTotal: boundedProgress(progress?.total),
              downloadTransferred: boundedProgress(progress?.transferred),
              status: "downloading",
            });
          },
        });
      } catch {
        if (stopped) return { status: "stopped" };
        return recordFailure("automatic_update_download_failed", reason);
      }
      if (stopped) return { status: "stopped" };
      if (typeof preparedUpdate?.install !== "function") return recordFailure("automatic_update_invalid", reason);
      setState({ downloadPercent: 100, status: "installing" });
      try {
        preparedUpdate.install();
      } catch {
        return recordFailure("automatic_update_install_failed", reason);
      }
      return { status: "installing", version: release.version };
    }

    if (choice.action === "download" && policy.mode === "notify_only") {
      try {
        await openDownloadPage(release.downloadPageUrl);
      } catch {
        return recordFailure("download_page_failed", reason);
      }
      setState({ deferUntil: "", status: pendingState });
      return { status: "download_page_opened", version: release.version };
    }

    if (!policy.defer) {
      const status = release.mandatory ? "mandatory_pending" : "deferred";
      setState({ deferUntil: "", status });
      return { deferUntil: "", status, version: release.version };
    }
    const deferUntil = boundedDeferUntil(choice.deferUntil, release.mandatory);
    await savePreference({
      deferUntil,
      disposition: "deferred",
      key: targetKey,
      lastPromptedAt: promptedAt,
      mandatory: release.mandatory,
      policyVersion: policy.policyVersion,
    });
    const status = release.mandatory ? "mandatory_pending" : "deferred";
    setState({ deferUntil, status });
    return { deferUntil, status, version: release.version };
  }

  function boundedDeferUntil(value, mandatory) {
    const currentTime = now();
    const requested = Date.parse(value || "");
    const configuredDelay = mandatory ? policy.defer.mandatoryMs : policy.defer.normalMs;
    const fallback = currentTime + configuredDelay;
    const upperBound = currentTime + (mandatory ? policy.defer.mandatoryMs : policy.defer.maxMs);
    return new Date(Math.min(Number.isFinite(requested) && requested > currentTime ? requested : fallback, upperBound)).toISOString();
  }

  async function savePreference(entry) {
    preferences.set(entry.key, entry);
    if (!persistence?.save) {
      markPersistenceDegraded("preference_persistence_unavailable", "unavailable");
      return;
    }
    try {
      await persistence.save({
        contractVersion: PREFERENCES_CONTRACT,
        entries: [...preferences.values()].slice(-MAX_PREFERENCES),
      });
      clearPersistenceFailure();
    } catch {
      markPersistenceDegraded("preference_persistence_save_failed", "failed");
    }
  }

  function recordFailure(status, reason) {
    failureCount = Math.min(failureCount + 1, 31);
    if (!policy.retry) {
      setState({ failureCount, lastError: status, lastTrigger: reason, retryAt: "", status: "degraded" });
      return { retryAt: "", status };
    }
    const exponentialDelay = Math.min(policy.retry.maxMs, policy.retry.baseMs * (2 ** (failureCount - 1)));
    const boundedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
    const jitter = 1 + (((boundedRandom * 2) - 1) * policy.retry.jitterRatio);
    const retryDelayMs = Math.max(0, Math.round(exponentialDelay * jitter));
    const retryAt = new Date(now() + retryDelayMs).toISOString();
    setState({ failureCount, lastError: status, lastTrigger: reason, retryAt, status: "degraded" });
    scheduleCheck(retryDelayMs, "retry", activeSignalRevision);
    return { retryAt, status };
  }

  function resetBackoff() {
    if (failureCount || state.retryAt || scheduledReason) onScheduleCancelled();
    scheduledManifestRevision = "";
    scheduledReason = "";
    failureCount = 0;
    setState({ failureCount: 0, lastError: "", retryAt: "" });
  }

  function scheduleCheck(delayMs, reason, manifestRevision = "") {
    scheduledManifestRevision = manifestRevision;
    scheduledReason = reason;
    onCheckScheduled({ delayMs: Math.max(0, Math.round(delayMs)), reason });
  }

  function policyAllows(reason) {
    if (!policy || policy.mode === "disabled") return false;
    if (reason === "retry") return Boolean(policy.retry);
    if (reason === "poll") return policy.triggers.fallback === true;
    if (reason === "network") return policy.triggers.network === true;
    return policy.triggers[reason] === true;
  }

  function isDuplicateSignal(signal) {
    const lastSequence = streamSequences.get(signal.streamEpoch) || 0;
    return seenEventIds.has(signal.eventId) || signal.sequence <= lastSequence;
  }

  function rememberConnectionEvent(signal) {
    streamSequences.set(signal.streamEpoch, signal.sequence);
    if (streamSequences.size > MAX_STREAM_EPOCHS) streamSequences.delete(streamSequences.keys().next().value);
    rememberBounded(seenEventIds, signal.eventId);
  }

  function markPersistenceDegraded(reason, persistenceStatus) {
    const degradedReasons = [...new Set([
      ...state.degradedReasons.filter((item) => !item.startsWith("preference_persistence_")),
      reason,
    ])];
    setState({ degradedReasons, persistenceStatus });
  }

  function clearPersistenceFailure() {
    setState({
      degradedReasons: state.degradedReasons.filter((item) => !item.startsWith("preference_persistence_")),
      persistenceStatus: "ready",
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    subscribers.add(listener);
    try {
      listener(getState());
    } catch {
      // State observers are presentation-only and must not interrupt update governance.
    }
    return () => subscribers.delete(listener);
  }

  function setState(patch) {
    state = { ...state, ...patch, updatedAt: new Date(now()).toISOString() };
    const projection = getState();
    try {
      onStateChange(projection);
    } catch {
      // State observers are presentation-only and must not interrupt update governance.
    }
    for (const listener of subscribers) {
      try {
        listener(projection);
      } catch {
        // One failed observer must not prevent other observers or the state transition.
      }
    }
  }

  function getState() {
    return { ...state, degradedReasons: [...state.degradedReasons] };
  }

  function stop() {
    stopped = true;
    readyInstaller = null;
    pendingSignalRevision = "";
    scheduledManifestRevision = "";
    scheduledReason = "";
    subscribers.clear();
    onScheduleCancelled();
  }

  async function downloadAvailable() {
    if (stopped || policy?.mode !== "notify_only" || !state.canDownload || !state.targetKey || preparingInstaller || installerDownload) {
      return { status: "download_unavailable" };
    }
    preparingInstaller = true;
    const expectedKey = state.targetKey;
    let actorRelease;
    try {
      actorRelease = normalizeReleaseManifest(await fetchManifest?.({ reason: "download" }), { arch, channel, platform, product, trustedDownloadOrigin });
    } catch {
      return { status: "download_unavailable" };
    } finally {
      preparingInstaller = false;
    }
    if (stopped || !actorRelease || releaseTargetKey({ arch, channel, platform, product, version: actorRelease.version }) !== expectedKey
      || !actorRelease.artifactSha256 || !actorRelease.artifactSize) return { status: "download_unavailable" };
    setState({ status: "downloading", downloadPercent: 0 });
    installerDownload = Promise.resolve().then(() => downloadInstaller(actorRelease, {
      onProgress: (progress) => {
        if (!stopped) setState({
          status: "downloading",
          downloadPercent: boundedProgress(progress?.percent, 100),
          downloadTotal: boundedProgress(progress?.total),
          downloadTransferred: boundedProgress(progress?.transferred),
        });
      },
    }));
    try {
      const prepared = await installerDownload;
      if (stopped || !prepared || typeof prepared.open !== "function") return { status: "download_unavailable" };
      readyInstaller = { targetKey: expectedKey, sha256: actorRelease.artifactSha256, open: prepared.open };
      setState({ status: "downloaded", downloadPercent: 100 });
      return { status: "downloaded", version: actorRelease.version };
    } catch {
      if (!stopped) setState({ status: "available", lastError: "installer_download_failed" });
      return { status: "installer_download_failed" };
    } finally {
      installerDownload = null;
    }
  }

  async function openDownloaded() {
    if (stopped || !state.canDownload || !readyInstaller || readyInstaller.targetKey !== state.targetKey) return { status: "installer_unavailable" };
    try {
      await openInstaller(readyInstaller.open);
      return { status: "installer_opened" };
    } catch {
      return { status: "installer_open_failed" };
    }
  }

  return { acceptSignal, defer, downloadAvailable, getState, initialize, openDownloaded, stop, subscribe, trigger };
}

function createInitialState({ arch, channel, currentVersion, platform, policy, product }) {
  return {
    arch: String(arch || ""),
    channel: String(channel || ""),
    currentVersion: String(currentVersion || ""),
    canDownload: false,
    deferUntil: "",
    downloadBytesPerSecond: 0,
    downloadPercent: 0,
    downloadTotal: 0,
    downloadTransferred: 0,
    degradedReasons: [],
    failureCount: 0,
    lastError: "",
    lastCheckedAt: "",
    lastSignalManifestRevision: "",
    lastTrigger: "",
    mandatory: false,
    nextEligibleCheckAt: "",
    persistenceStatus: "unknown",
    platform: String(platform || ""),
    policySource: String(policy?.source || "invalid"),
    product,
    retryAt: "",
    status: policy && policy.mode !== "disabled" ? "idle" : "disabled",
    targetKey: "",
    targetVersion: "",
    updatedAt: "",
  };
}

function clearTarget(patch) {
  return {
    canDownload: false,
    deferUntil: "",
    downloadBytesPerSecond: 0,
    downloadPercent: 0,
    downloadTotal: 0,
    downloadTransferred: 0,
    mandatory: false,
    targetKey: "",
    targetVersion: "",
    ...patch,
  };
}

function normalizePreferences(payload) {
  if (payload?.contractVersion !== PREFERENCES_CONTRACT || !Array.isArray(payload.entries)) return [];
  return payload.entries.flatMap((entry) => {
    const key = String(entry?.key || "").slice(0, 500);
    const disposition = entry?.disposition === "deferred" ? "deferred" : "";
    const deferUntil = normalizeTime(entry?.deferUntil);
    const lastPromptedAt = normalizeTime(entry?.lastPromptedAt);
    const policyVersion = cleanPreferenceToken(entry?.policyVersion);
    const mandatory = typeof entry?.mandatory === "boolean" ? entry.mandatory : null;
    return key && disposition && lastPromptedAt && policyVersion && mandatory !== null
      ? [{ deferUntil, disposition, key, lastPromptedAt, mandatory, policyVersion }]
      : [];
  }).slice(-MAX_PREFERENCES);
}

function normalizePromptChoice(value) {
  if (value === "install" || value?.action === "install") return { action: "install", deferUntil: "" };
  if (value === "download" || value?.action === "download") return { action: "download", deferUntil: "" };
  return { action: "defer", deferUntil: normalizeTime(value?.deferUntil) };
}

function boundedProgress(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, number)) : 0;
}

function normalizeTriggerReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  return ["manual", "network", "poll", "resume", "retry", "signal", "startup"].includes(reason) ? reason : "";
}

function normalizeTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function rememberBounded(set, value) {
  set.add(value);
  if (set.size > MAX_SIGNAL_DEDUPE_KEYS) set.delete(set.values().next().value);
}

function cleanPreferenceToken(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]+/g, "").slice(0, 160);
}

export { PREFERENCES_CONTRACT as DESKTOP_UPDATE_PREFERENCES_CONTRACT };
