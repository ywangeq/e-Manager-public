const GENERIC_INTEGRATION_PREFIX = "/api/feishu/integrations";
const GENERIC_EVENT_PREFIX = "/api/feishu/events";

function createFeishuIntegrationRouteRegistry(adapters = []) {
  const adaptersByEmployeeId = new Map();
  const canonicalEmployeeIdByLegacyId = new Map();
  adapters.forEach(register);

  function register(adapter = {}) {
    const employeeId = normalizeEmployeeId(adapter.employeeId);
    if (!employeeId) throw new Error("feishu integration adapter requires a valid employeeId");
    if (!adapter.legacyIntegrationBase || !adapter.legacyEventPath) {
      throw new Error(`feishu integration adapter ${employeeId} requires legacy route mappings`);
    }
    const legacyEmployeeIds = Array.from(new Set((adapter.legacyEmployeeIds || []).map(normalizeEmployeeId).filter(Boolean)));
    if (legacyEmployeeIds.includes(employeeId)) throw new Error(`feishu integration adapter ${employeeId} cannot alias itself`);
    legacyEmployeeIds.forEach((legacyEmployeeId) => {
      const existing = canonicalEmployeeIdByLegacyId.get(legacyEmployeeId);
      if (existing && existing !== employeeId) throw new Error(`feishu integration legacy employee id conflict: ${legacyEmployeeId}`);
      canonicalEmployeeIdByLegacyId.set(legacyEmployeeId, employeeId);
    });
    adaptersByEmployeeId.set(employeeId, {
      ...adapter,
      employeeId,
      legacyEmployeeIds,
      legacyIntegrationBase: trimTrailingSlash(adapter.legacyIntegrationBase),
      legacyEventPath: trimTrailingSlash(adapter.legacyEventPath),
    });
  }

  function resolve(pathname = "") {
    for (const adapter of adaptersByEmployeeId.values()) {
      if (pathname === adapter.legacyEventPath) {
        const publicEventPath = buildFeishuEventPath(adapter.employeeId);
        return {
          matched: true,
          registered: true,
          legacy: true,
          kind: "event",
          employeeId: adapter.employeeId,
          adapter,
          internalPath: publicEventPath,
          publicEventPath,
          suffix: "",
        };
      }
      if (pathname === adapter.legacyIntegrationBase || pathname.startsWith(`${adapter.legacyIntegrationBase}/`)) {
        const suffix = pathname.slice(adapter.legacyIntegrationBase.length);
        return {
          matched: true,
          registered: true,
          legacy: true,
          kind: "integration",
          employeeId: adapter.employeeId,
          adapter,
          internalPath: buildFeishuIntegrationPath(adapter.employeeId, suffix),
          publicEventPath: buildFeishuEventPath(adapter.employeeId),
          suffix,
        };
      }
    }

    const genericRoute = parseGenericRoute(pathname);
    if (genericRoute) {
      const requestedEmployeeId = genericRoute.employeeId;
      const canonicalEmployeeId = canonicalEmployeeIdByLegacyId.get(requestedEmployeeId) || requestedEmployeeId;
      const adapter = adaptersByEmployeeId.get(canonicalEmployeeId);
      if (!adapter) {
        return {
          ...genericRoute,
          matched: true,
          registered: false,
        };
      }
      return {
        ...genericRoute,
        employeeId: canonicalEmployeeId,
        requestedEmployeeId,
        legacy: requestedEmployeeId !== canonicalEmployeeId,
        matched: true,
        registered: true,
        adapter,
        internalPath: genericRoute.kind === "event"
          ? buildFeishuEventPath(canonicalEmployeeId)
          : buildFeishuIntegrationPath(canonicalEmployeeId, genericRoute.suffix),
        publicEventPath: buildFeishuEventPath(canonicalEmployeeId),
      };
    }

    return null;
  }

  return { register, resolve };
}

function parseGenericRoute(pathname = "") {
  const integrationMatch = pathname.match(/^\/api\/feishu\/integrations\/([^/]+)(\/.*)?$/);
  if (integrationMatch) {
    const employeeId = decodeEmployeeId(integrationMatch[1]);
    if (!employeeId) return null;
    return {
      kind: "integration",
      employeeId,
      suffix: integrationMatch[2] || "",
      legacy: false,
    };
  }

  const eventMatch = pathname.match(/^\/api\/feishu\/events\/([^/]+)$/);
  if (eventMatch) {
    const employeeId = decodeEmployeeId(eventMatch[1]);
    if (!employeeId) return null;
    return {
      kind: "event",
      employeeId,
      suffix: "",
      legacy: false,
    };
  }

  return null;
}

function buildFeishuIntegrationPath(employeeId = "", suffix = "") {
  const normalized = normalizeEmployeeId(employeeId);
  if (!normalized) return "";
  const normalizedSuffix = suffix ? `/${String(suffix).replace(/^\/+/, "")}` : "";
  return `${GENERIC_INTEGRATION_PREFIX}/${encodeURIComponent(normalized)}${normalizedSuffix}`;
}

function buildFeishuEventPath(employeeId = "") {
  const normalized = normalizeEmployeeId(employeeId);
  return normalized ? `${GENERIC_EVENT_PREFIX}/${encodeURIComponent(normalized)}` : "";
}

function decodeEmployeeId(value = "") {
  try {
    return normalizeEmployeeId(decodeURIComponent(value));
  } catch {
    return "";
  }
}

function normalizeEmployeeId(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,79}$/.test(normalized) ? normalized : "";
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

export {
  GENERIC_EVENT_PREFIX,
  GENERIC_INTEGRATION_PREFIX,
  buildFeishuEventPath,
  buildFeishuIntegrationPath,
  createFeishuIntegrationRouteRegistry,
  normalizeEmployeeId,
};
