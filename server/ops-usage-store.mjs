import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = "ops-usage-events.v1";
const DEFAULT_SYSTEMS = [
  {
    id: "digital-workforce",
    name: "数字员工管理系统",
    source: "platform",
    status: "collecting",
  },
];
const ALLOWED_SYSTEM_IDS = new Set(DEFAULT_SYSTEMS.map((system) => system.id));
const ALLOWED_EVENT_TYPES = new Set(["login", "session_refresh", "view", "heartbeat"]);
const ALLOWED_VIEW_IDS = new Set([
  "overview",
  "people",
  "employees",
  "basicSkills",
  "businessSkills",
  "systemImports",
  "subsystemRequests",
  "qualityManagement",
  "skillEmployeeReview",
  "evaluationReview",
  "systemWorkers",
  "systemManagement",
  "opsMonitor",
]);

export function createOpsUsageStore({
  projectRoot,
  storePath,
  hashSalt = "digital-workforce-mvp-ops",
  storeVersion = STORE_VERSION,
  redactError = (error) => String(error?.message || error),
}) {
  function recordEvent(input = {}, session = null) {
    const event = sanitizeUsageEvent(input, session);
    if (!event) return null;
    const store = readStore();
    store.events.push(event);
    store.updatedAt = event.occurredAt;
    writeStore(store);
    return event;
  }

  function buildSummary(options = {}) {
    const store = readStore();
    const now = new Date();
    const days = clampInt(options.days, 1, 31, 7);
    const systemId = cleanShortText(options.systemId);
    const includedSystems = DEFAULT_SYSTEMS.filter((system) => !systemId || system.id === systemId);
    const startDate = startOfDay(addDays(now, -(days - 1)));
    const events = store.events.filter((event) => {
      const occurredAt = new Date(event.occurredAt);
      if (Number.isNaN(occurredAt.getTime()) || occurredAt < startDate) return false;
      return !systemId || event.systemId === systemId;
    });
    const todayKey = dayKey(now);
    const yesterdayKey = dayKey(addDays(now, -1));
    const dailySeries = buildDailySeries({ days, now, events, systems: includedSystems });
    const todayEvents = events.filter((event) => dayKey(new Date(event.occurredAt)) === todayKey);
    const yesterdayEvents = events.filter((event) => dayKey(new Date(event.occurredAt)) === yesterdayKey);
    const topUsers = buildTopUsers(events, 10);
    const systems = includedSystems.map((system) => summarizeSystem(system, events, todayKey));
    const lastEventAt = events.reduce((latest, event) => (event.occurredAt > latest ? event.occurredAt : latest), "");

    return {
      ok: true,
      contractVersion: "ops-usage-summary.v1",
      status: events.length ? "ready" : "empty",
      systems,
      metrics: {
        dauToday: uniqueUsers(todayEvents).size,
        dauYesterday: uniqueUsers(yesterdayEvents).size,
        activeUsers7d: uniqueUsers(events).size,
        events7d: events.length,
        highFrequencyUsers: topUsers.filter((user) => user.eventCount >= 3).length,
      },
      dailySeries,
      topUsers,
      coverage: {
        storeKind: "mvp-file-store",
        path: path.relative(projectRoot, storePath),
        productionReady: false,
        startedAt: store.createdAt || "",
        updatedAt: store.updatedAt || "",
        lastEventAt,
        retentionDays: 31,
        note: "仅统计接入埋点后的真实 MVP 使用事件；不会回填或生成示例 DAU。",
      },
      privacyBoundary:
        "Usage events store hashed user keys, display names from the current session, department id/name, system id, event type, and view id only. It must not store raw prompts, AI payloads, model traces, generated records, credentials, customer data, resumes, or private Skill payloads.",
    };
  }

  function readStore() {
    try {
      if (!fs.existsSync(storePath)) return emptyStore();
      const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (!data || typeof data !== "object") return emptyStore();
      return {
        version: storeVersion,
        createdAt: cleanShortText(data.createdAt),
        updatedAt: cleanShortText(data.updatedAt),
        events: Array.isArray(data.events)
          ? data.events.map(sanitizeStoredEvent).filter(Boolean).slice(-5000)
          : [],
      };
    } catch (error) {
      console.warn("[ops-usage-store] Failed to read store:", redactError(error));
      return emptyStore();
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  function emptyStore() {
    const now = new Date().toISOString();
    return { version: storeVersion, createdAt: now, updatedAt: "", events: [] };
  }

  function sanitizeUsageEvent(input, session) {
    const systemId = normalizeSystemId(input.systemId || "digital-workforce");
    if (!ALLOWED_SYSTEM_IDS.has(systemId)) return null;
    const eventType = normalizeEventType(input.eventType || "heartbeat");
    const viewId = sanitizeViewId(input.viewId || input.route || "");
    const now = new Date().toISOString();
    const userKey = userHash(session);
    if (!userKey) return null;
    return {
      id: `OPS-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      systemId,
      eventType,
      viewId,
      occurredAt: now,
      userKey,
      userLabel: cleanShortText(session?.name || session?.email || "已认证用户"),
      employeeIdHash: userKey,
      departmentId: cleanShortText(session?.departmentId || "unknown"),
      departmentName: cleanShortText(session?.department || ""),
      role: cleanShortText(session?.role || ""),
      identitySource: cleanShortText(session?.identitySource || ""),
      source: cleanShortText(input.source || "mvp-ui"),
    };
  }

  function sanitizeStoredEvent(event = {}) {
    const systemId = normalizeSystemId(event.systemId);
    const eventType = normalizeEventType(event.eventType);
    const occurredAt = cleanShortText(event.occurredAt);
    if (!ALLOWED_SYSTEM_IDS.has(systemId) || !occurredAt || Number.isNaN(new Date(occurredAt).getTime())) return null;
    return {
      id: cleanShortText(event.id || `${systemId}-${occurredAt}-${event.userKey || ""}`),
      systemId,
      eventType,
      viewId: sanitizeViewId(event.viewId),
      occurredAt,
      userKey: cleanShortText(event.userKey || event.employeeIdHash),
      userLabel: cleanShortText(event.userLabel || "已认证用户"),
      employeeIdHash: cleanShortText(event.employeeIdHash || event.userKey),
      departmentId: cleanShortText(event.departmentId || "unknown"),
      departmentName: cleanShortText(event.departmentName),
      role: cleanShortText(event.role),
      identitySource: cleanShortText(event.identitySource),
      source: cleanShortText(event.source || "mvp-ui"),
    };
  }

  function userHash(session) {
    const raw = cleanShortText(session?.employeeId || session?.feishuUserId || session?.employeeNo || session?.email);
    if (!raw) return "";
    return crypto.createHash("sha256").update(`${hashSalt}:${raw}`).digest("hex").slice(0, 16);
  }

  return {
    buildSummary,
    recordEvent,
  };
}

function buildDailySeries({ days, now, events, systems }) {
  const eventsByDayAndSystem = new Map();
  for (const event of events) {
    const key = `${dayKey(new Date(event.occurredAt))}:${event.systemId}`;
    if (!eventsByDayAndSystem.has(key)) eventsByDayAndSystem.set(key, []);
    eventsByDayAndSystem.get(key).push(event);
  }

  return Array.from({ length: days }, (_, index) => {
    const date = addDays(now, index - (days - 1));
    const dateKey = dayKey(date);
    const systemValues = systems.map((system) => {
      const systemEvents = eventsByDayAndSystem.get(`${dateKey}:${system.id}`) || [];
      return {
        systemId: system.id,
        systemName: system.name,
        dau: uniqueUsers(systemEvents).size,
        eventCount: systemEvents.length,
      };
    });
    return {
      date: dateKey,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      systems: systemValues,
      dau: uniqueUsers(systemValues.flatMap((system) => eventsByDayAndSystem.get(`${dateKey}:${system.systemId}`) || [])).size,
      eventCount: systemValues.reduce((sum, system) => sum + system.eventCount, 0),
    };
  });
}

function buildTopUsers(events, limit) {
  const userMap = new Map();
  for (const event of events) {
    const key = event.userKey;
    if (!key) continue;
    const current = userMap.get(key) || {
      userKey: key,
      userLabel: event.userLabel || "已认证用户",
      departmentId: event.departmentId,
      departmentName: event.departmentName,
      eventCount: 0,
      activeDays: new Set(),
      systems: new Set(),
      views: new Map(),
      lastActiveAt: "",
    };
    current.eventCount += 1;
    current.activeDays.add(dayKey(new Date(event.occurredAt)));
    current.systems.add(event.systemId);
    if (event.viewId) current.views.set(event.viewId, (current.views.get(event.viewId) || 0) + 1);
    if (event.occurredAt > current.lastActiveAt) current.lastActiveAt = event.occurredAt;
    userMap.set(key, current);
  }

  return [...userMap.values()]
    .map((user) => ({
      userKey: user.userKey,
      userLabel: user.userLabel,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      eventCount: user.eventCount,
      activeDays: user.activeDays.size,
      systems: [...user.systems],
      topView: topMapKey(user.views),
      lastActiveAt: user.lastActiveAt,
    }))
    .sort((left, right) => right.eventCount - left.eventCount || right.activeDays - left.activeDays)
    .slice(0, limit);
}

function summarizeSystem(system, events, todayKey) {
  const systemEvents = events.filter((event) => event.systemId === system.id);
  const todayEvents = systemEvents.filter((event) => dayKey(new Date(event.occurredAt)) === todayKey);
  const lastEventAt = systemEvents.reduce((latest, event) => (event.occurredAt > latest ? event.occurredAt : latest), "");
  return {
    ...system,
    status: systemEvents.length ? "collecting" : system.status,
    dauToday: uniqueUsers(todayEvents).size,
    activeUsers7d: uniqueUsers(systemEvents).size,
    eventCount7d: systemEvents.length,
    lastEventAt,
  };
}

function uniqueUsers(events) {
  return new Set(events.map((event) => event.userKey).filter(Boolean));
}

function topMapKey(map) {
  return [...map.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

function normalizeSystemId(value) {
  return cleanShortText(value || "digital-workforce").toLowerCase();
}

function normalizeEventType(value) {
  const eventType = cleanShortText(value || "heartbeat");
  return ALLOWED_EVENT_TYPES.has(eventType) ? eventType : "heartbeat";
}

function sanitizeViewId(value) {
  const viewId = cleanShortText(value);
  return ALLOWED_VIEW_IDS.has(viewId) ? viewId : "";
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
