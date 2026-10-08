import products from "../shared/desktop-product.cjs";
const PRODUCT_ID = products.DESKTOP_PRODUCT.productId;
const RELEASE_CHANNELS = new Set(["stable", "beta"]);
const UPDATE_SIGNAL_CONTRACT = "desktop-update-signal.v1";
const UPDATE_POLICY_CONTRACT = "desktop-update-policy.v1";
const SIGNAL_FIELDS = new Set([
  "channel",
  "contractVersion",
  "eventId",
  "expiresAt",
  "manifestRevision",
  "product",
  "publishedAt",
  "sequence",
  "streamEpoch",
]);
const POLICY_FIELDS = new Set(["contractVersion", "defer", "externalDownloadPage", "mode", "policyVersion", "retry", "triggers"]);
const POLICY_TRIGGER_FIELDS = new Set([
  "fallback",
  "fallbackIntervalMs",
  "manual",
  "minCheckIntervalMs",
  "network",
  "resume",
  "signal",
  "startup",
  "startupDelayMs",
]);
const POLICY_RETRY_FIELDS = new Set(["baseMs", "jitterRatio", "maxMs"]);
const POLICY_DEFER_FIELDS = new Set(["mandatoryMs", "maxMs", "normalMs"]);

const PACKAGED_UPDATE_CAPABILITIES = Object.freeze({
  autoDownload: true,
  autoInstall: true,
  externalDownloadPage: true,
  signalTransports: Object.freeze(["authenticated_sse"]),
});

export function normalizeReleaseManifest(input = {}, options = {}) {
  const channel = normalizeChannel(options.channel);
  const platform = cleanToken(options.platform);
  const arch = cleanToken(options.arch);
  const version = cleanVersion(input.version);
  const product = products.productById(options.product ?? PRODUCT_ID);
  if (!product || input.schemaVersion !== 1 || input.product !== product.productId) return null;
  if (!products.supportsVersion(product, version)) return null;
  if (!channel || normalizeChannel(input.channel) !== channel || !version) return null;
  if (channel === "stable" && version.includes("-")) return null;

  const downloadPageUrl = safeManagedDownloadUrl(input.downloadPageUrl, options.trustedDownloadOrigin);
  const artifact = input.artifacts?.[`${platform}-${arch}`] || {};
  const artifactUrl = safeHttpsUrl(artifact.url);
  const autoUpdateFeedUrl = artifact.signed === true ? safeHttpsUrl(artifact.updateFeedUrl) : "";
  if (product === products.GROUP_STUDIO_PRODUCT && autoUpdateFeedUrl && !products.groupFeedUrl(autoUpdateFeedUrl)) return null;
  const artifactSha256 = /^[a-f0-9]{64}$/i.test(String(artifact.sha256 || "")) ? artifact.sha256.toLowerCase() : "";
  const artifactSize = Number.isSafeInteger(artifact.size) && artifact.size > 0 ? artifact.size : 0;
  if (!downloadPageUrl) return null;

  return {
    artifactUrl,
    artifactSha256,
    artifactSize,
    autoUpdateFeedUrl,
    channel,
    downloadPageUrl,
    mandatory: input.mandatory === true,
    publishedAt: normalizeTime(input.publishedAt),
    releaseNotes: cleanText(input.releaseNotes, 1200),
    version,
  };
}

export function isReleaseNewer(candidateVersion, currentVersion) {
  const candidate = parseVersion(candidateVersion);
  const current = parseVersion(currentVersion);
  if (!candidate || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate.core[index] !== current.core[index]) return candidate.core[index] > current.core[index];
  }
  return comparePrerelease(candidate.prerelease, current.prerelease) > 0;
}

export function normalizeDesktopUpdateSignal(input = {}, options = {}) {
  const channel = normalizeChannel(options.channel);
  const now = Number(options.now) || Date.now();
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (!hasExactFields(input, SIGNAL_FIELDS)) return null;
  const product = products.productById(options.product ?? PRODUCT_ID);
  if (!product || input.contractVersion !== UPDATE_SIGNAL_CONTRACT || input.product !== product.productId) return null;
  if (!channel || normalizeChannel(input.channel) !== channel) return null;

  const eventId = cleanKey(input.eventId, 160);
  const streamEpoch = cleanKey(input.streamEpoch, 160);
  const sequence = Number(input.sequence);
  const manifestRevision = cleanKey(input.manifestRevision, 160);
  const publishedAt = normalizeTime(input.publishedAt);
  const expiresAt = normalizeTime(input.expiresAt);
  if (
    !eventId
    || !streamEpoch
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || !manifestRevision
    || !publishedAt
    || !expiresAt
    || Date.parse(expiresAt) <= now
  ) return null;

  return {
    channel,
    contractVersion: UPDATE_SIGNAL_CONTRACT,
    eventId,
    expiresAt,
    manifestRevision,
    product: product.productId,
    publishedAt,
    sequence,
    streamEpoch,
  };
}

export function normalizeDesktopUpdatePolicy(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (!hasExactFields(input, POLICY_FIELDS) || input.contractVersion !== UPDATE_POLICY_CONTRACT) return null;
  if (!hasExactFields(input.triggers, POLICY_TRIGGER_FIELDS)) return null;
  if (input.retry !== null && !hasExactFields(input.retry, POLICY_RETRY_FIELDS)) return null;
  if (input.defer !== null && !hasExactFields(input.defer, POLICY_DEFER_FIELDS)) return null;
  if (!["disabled", "install_on_confirm", "notify_only"].includes(input.mode)) return null;
  if (typeof input.externalDownloadPage !== "boolean") return null;
  const policyVersion = cleanKey(input.policyVersion, 160);
  if (!policyVersion) return null;

  const triggers = {
    startup: booleanValue(input.triggers.startup),
    startupDelayMs: boundedInteger(input.triggers.startupDelayMs, 0, 5 * 60 * 1000),
    resume: booleanValue(input.triggers.resume),
    network: booleanValue(input.triggers.network),
    manual: booleanValue(input.triggers.manual),
    signal: booleanValue(input.triggers.signal),
    fallback: booleanValue(input.triggers.fallback),
    fallbackIntervalMs: boundedInteger(input.triggers.fallbackIntervalMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
    minCheckIntervalMs: boundedInteger(input.triggers.minCheckIntervalMs, 0, 60 * 60 * 1000),
  };
  // These ranges are validation limits for managed input, not product timing defaults.
  const retry = input.retry === null ? null : {
    baseMs: boundedInteger(input.retry.baseMs, 1000, 60 * 60 * 1000),
    maxMs: boundedInteger(input.retry.maxMs, 1000, 24 * 60 * 60 * 1000),
    jitterRatio: boundedNumber(input.retry.jitterRatio, 0, 1),
  };
  const defer = input.defer === null ? null : {
    normalMs: boundedInteger(input.defer.normalMs, 0, 30 * 24 * 60 * 60 * 1000),
    mandatoryMs: boundedInteger(input.defer.mandatoryMs, 0, 30 * 24 * 60 * 60 * 1000),
    maxMs: boundedInteger(input.defer.maxMs, 0, 30 * 24 * 60 * 60 * 1000),
  };
  if (
    Object.values(triggers).some((value) => value === null)
    || (retry && Object.values(retry).some((value) => value === null))
    || (defer && Object.values(defer).some((value) => value === null))
    || (retry && retry.maxMs < retry.baseMs)
    || (defer && defer.maxMs < defer.normalMs)
  ) return null;

  const packagedCapabilities = options.packagedCapabilities || PACKAGED_UPDATE_CAPABILITIES;
  const externalDownloadPage = packagedCapabilities.externalDownloadPage === true && input.externalDownloadPage === true;
  const installOnConfirm = input.mode === "install_on_confirm"
    && packagedCapabilities.autoDownload === true
    && packagedCapabilities.autoInstall === true
    && input.externalDownloadPage === false;
  const mode = installOnConfirm
    ? "install_on_confirm"
    : input.mode === "notify_only" && externalDownloadPage
      ? "notify_only"
      : "disabled";
  return {
    capabilities: {
      autoDownload: packagedCapabilities.autoDownload === true,
      autoInstall: packagedCapabilities.autoInstall === true,
      externalDownloadPage,
      signalTransports: [...packagedCapabilities.signalTransports],
    },
    contractVersion: UPDATE_POLICY_CONTRACT,
    defer,
    mode,
    policyVersion,
    retry,
    source: cleanKey(options.source, 80) || "managed",
    triggers,
  };
}

export function releaseTargetKey({ arch, channel, platform, product = PRODUCT_ID, version } = {}) {
  const safeProduct = cleanKey(product, 160);
  const safeChannel = normalizeChannel(channel);
  const safePlatform = cleanToken(platform);
  const safeArch = cleanToken(arch);
  const safeVersion = cleanVersion(version);
  return safeProduct && safeChannel && safePlatform && safeArch && parseVersion(safeVersion)
    ? [safeProduct, safeChannel, safePlatform, safeArch, safeVersion].join(":")
    : "";
}

export function normalizeChannel(value) {
  const channel = cleanToken(value).toLowerCase();
  return RELEASE_CHANNELS.has(channel) ? channel : "";
}

export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeManagedDownloadUrl(value, trustedOrigin) {
  const httpsUrl = safeHttpsUrl(value);
  if (httpsUrl) return httpsUrl;
  try {
    const url = new URL(String(value || ""));
    const trusted = new URL(String(trustedOrigin || ""));
    const privateLanCenter = trusted.protocol === "http:" && isPrivateLanIpv4(trusted.hostname);
    if (!privateLanCenter || url.origin !== trusted.origin || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isPrivateLanIpv4(hostname) {
  const parts = String(hostname || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function parseVersion(value) {
  const match = cleanVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function cleanVersion(value) {
  return String(value || "").trim().slice(0, 80);
}

function cleanToken(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "").slice(0, 80);
}

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanKey(value, limit) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]+/g, "").slice(0, limit);
}

function normalizeTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function hasExactFields(input, allowedFields) {
  return Boolean(
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.keys(input).length === allowedFields.size
    && Object.keys(input).every((field) => allowedFields.has(field)),
  );
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : null;
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

export {
  PRODUCT_ID as DESKTOP_RELEASE_PRODUCT_ID,
  PACKAGED_UPDATE_CAPABILITIES as DESKTOP_PACKAGED_UPDATE_CAPABILITIES,
  UPDATE_POLICY_CONTRACT as DESKTOP_UPDATE_POLICY_CONTRACT,
  UPDATE_SIGNAL_CONTRACT as DESKTOP_UPDATE_SIGNAL_CONTRACT,
};
