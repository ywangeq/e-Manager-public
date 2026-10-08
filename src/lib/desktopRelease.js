const RELEASE_ROUTES = Object.freeze({ desktop: "/api/desktop-releases", group_studio: "/api/desktop-releases/group-studio" });

export async function fetchLatestDesktopRelease(experience = "desktop") {
  const routeBase = Object.hasOwn(RELEASE_ROUTES, experience) ? RELEASE_ROUTES[experience] : null;
  if (!routeBase) throw new TypeError("invalid desktop release experience");
  const response = await fetch(`${routeBase}/latest`, { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.message || "桌面安装包目录暂时不可用");
  const release = normalizeDesktopRelease(data.release, experience);
  if (!release) throw new Error("桌面安装包目录返回了无效数据");
  return release;
}

export function normalizeDesktopRelease(value = {}, experience = "desktop") {
  const routeBase = Object.hasOwn(RELEASE_ROUTES, experience) ? RELEASE_ROUTES[experience] : null;
  const channel = ["stable", "beta"].includes(value.channel) ? value.channel : "";
  const version = String(value.version || "").trim().slice(0, 80);
  if (!routeBase || !channel || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)
    || (experience === "group_studio" && !version.startsWith("3."))) return null;
  return {
    channel,
    distributionNotice: String(value.distributionNotice || "").replace(/\s+/g, " ").trim().slice(0, 240),
    version,
    publishedAt: normalizeTime(value.publishedAt),
    releaseNotes: String(value.releaseNotes || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    source: experience === "group_studio" && value.source === "published_manifest" ? "published_manifest"
      : value.source === "local_beta" ? "local_beta" : "remote_manifest",
    platforms: Object.fromEntries(["darwin-arm64", "win32-x64"].map((id) => [id, normalizePlatform(value.platforms?.[id], id, routeBase)])),
  };
}

function normalizePlatform(value = {}, id, routeBase) {
  const expectedUrl = `${routeBase}/latest/download/${id}`;
  return {
    available: value.available === true && value.downloadUrl === expectedUrl,
    downloadUrl: value.downloadUrl === expectedUrl ? expectedUrl : "",
    label: String(value.label || "").replace(/\s+/g, " ").trim().slice(0, 80),
  };
}

function normalizeTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
