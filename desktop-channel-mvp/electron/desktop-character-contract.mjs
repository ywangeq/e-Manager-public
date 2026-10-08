const CHARACTER_CONTRACT_VERSION = "digital-employee-character.v1";
const MAX_CHARACTER_EMPLOYEES = 24;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_ANIMATED_BYTES = 6 * 1024 * 1024;

async function hydrateDesktopBootstrapCharacters(payload = {}, {
  assetCache = new Map(),
  request,
} = {}) {
  const employees = Array.isArray(payload.employees) ? payload.employees : [];
  const hydrated = await Promise.all(employees.map(async (employee, index) => {
    if (index >= MAX_CHARACTER_EMPLOYEES) return { ...employee, character: null };
    const descriptor = normalizeCharacterDescriptor(employee?.character, employee?.id);
    if (!descriptor || typeof request !== "function") return { ...employee, character: null };
    try {
      const staticSrc = await loadCharacterAsset(descriptor.staticPath, "static", request, assetCache);
      const animatedSrc = descriptor.animatedPath
        ? await loadCharacterAsset(descriptor.animatedPath, "animated", request, assetCache).catch(() => "")
        : "";
      return {
        ...employee,
        character: {
          ...descriptor.character,
          staticSrc,
          animatedSrc,
        },
      };
    } catch {
      return { ...employee, character: null };
    }
  }));
  return { ...payload, employees: hydrated };
}

function normalizeCharacterDescriptor(value = null, employeeId = "") {
  if (!value || value.contractVersion !== CHARACTER_CONTRACT_VERSION) return null;
  const id = cleanId(employeeId);
  const staticPath = safeCharacterAssetPath(value.staticSrc, id, "static");
  if (!id || !staticPath) return null;
  const animatedPath = value.animatedSrc ? safeCharacterAssetPath(value.animatedSrc, id, "animated") : "";
  if (value.animatedSrc && !animatedPath) return null;
  const accent = String(value.accent || "").trim();
  return {
    staticPath,
    animatedPath,
    character: {
      contractVersion: CHARACTER_CONTRACT_VERSION,
      assetRevision: cleanText(value.assetRevision, 80),
      codename: cleanText(value.codename, 80),
      accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#27877b",
      roleModule: cleanText(value.roleModule, 240),
      signatureMotion: cleanText(value.signatureMotion, 240),
    },
  };
}

async function loadCharacterAsset(assetPath, variant, request, assetCache) {
  const cached = assetCache.get(assetPath);
  if (cached) return cached;
  const response = await request(assetPath);
  if (!response?.ok) throw new Error("desktop_character_asset_unavailable");
  const expectedType = variant === "animated" ? "image/webp" : "image/png";
  const contentType = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== expectedType) throw new Error("desktop_character_asset_type_invalid");
  const maxBytes = variant === "animated" ? MAX_ANIMATED_BYTES : MAX_STATIC_BYTES;
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("desktop_character_asset_too_large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new Error("desktop_character_asset_too_large");
  const dataUrl = `data:${expectedType};base64,${bytes.toString("base64")}`;
  assetCache.set(assetPath, dataUrl);
  while (assetCache.size > 64) assetCache.delete(assetCache.keys().next().value);
  return dataUrl;
}

function safeCharacterAssetPath(value, employeeId, variant) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/")) return "";
  let url;
  try {
    url = new URL(raw, "https://desktop-character.invalid");
  } catch {
    return "";
  }
  if (url.origin !== "https://desktop-character.invalid" || url.hash) return "";
  const match = url.pathname.match(/^\/api\/digital-employee-characters\/([a-z0-9._-]{1,120})\/(static|animated)$/);
  if (!match || match[1] !== employeeId || match[2] !== variant) return "";
  if ([...url.searchParams.keys()].some((key) => key !== "v")) return "";
  const revision = url.searchParams.get("v") || "";
  if (!/^[a-f0-9]{16}$/.test(revision)) return "";
  return `${url.pathname}?v=${revision}`;
}

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export {
  CHARACTER_CONTRACT_VERSION,
  hydrateDesktopBootstrapCharacters,
  normalizeCharacterDescriptor,
  safeCharacterAssetPath,
};
