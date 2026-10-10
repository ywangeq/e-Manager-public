const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const FEISHU_CALENDAR_READ_DESCRIPTOR = freeze({
  toolId: "feishu-personal-read", credentialMode: "device_local_cli", operationId: "calendar.agenda.read", adapterVersion: "2.1.0",
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "end"],
      properties: { start: { type: "string", format: "date-time", pattern: iso.source },
        end: { type: "string", format: "date-time", pattern: iso.source } }, "x-max-window-days": 7 },
    resultSchema: { type: "object", additionalProperties: false, required: ["events"], properties: {
      events: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
        required: ["eventRef", "title", "start", "end"], properties: { eventRef: { type: "string", maxLength: 256 }, title: { type: "string", maxLength: 500 },
          start: { type: "string" }, end: { type: "string" }, calendarUrl: { type: "string", maxLength: 2048 }, meetingUrl: { type: "string", maxLength: 2048 } } } },
    } },
  normalizeInput, normalizeResult,
});
function normalizeInput(value) {
  if (!exact(value, ["start", "end"]) || !iso.test(value.start) || !iso.test(value.end) ||
    !Number.isFinite(Date.parse(value.start)) || !Number.isFinite(Date.parse(value.end)) ||
    new Date(value.start).toISOString().replace(".000Z", "Z") !== value.start.replace(".000Z", "Z") ||
    new Date(value.end).toISOString().replace(".000Z", "Z") !== value.end.replace(".000Z", "Z") ||
    Date.parse(value.end) <= Date.parse(value.start) || Date.parse(value.end) - Date.parse(value.start) > 7 * 86400_000)
    throw new Error("feishu_read_window_invalid");
  return { start: value.start, end: value.end };
}
function normalizeResult(value) {
  if (!exact(value, ["events"]) || !Array.isArray(value.events) || value.events.length > 100) throw new Error("feishu_read_result_invalid");
  return { events: value.events.map(event => {
    if (!eventShape(event) || typeof event.eventRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(event.eventRef) || typeof event.title !== "string" || event.title.length > 500 || event.title.includes("\0") ||
      !validTime(event.start) || !validTime(event.end) || event.start.length === 10 !== (event.end.length === 10) || Date.parse(event.end) < Date.parse(event.start)) throw new Error("feishu_read_event_invalid");
    const links = {};
    for (const key of ["calendarUrl", "meetingUrl"]) if (Object.hasOwn(event, key)) {
      if (!validFeishuCalendarUrl(event[key], key)) throw new Error("feishu_read_link_invalid");
      links[key] = event[key];
    }
    return { eventRef: event.eventRef, title: event.title, start: event.start, end: event.end, ...links };
  }) };
}
function validTime(value) {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return iso.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
}
function exact(value, fields) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))); }

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Only official web/app links returned by Calendar. Never synthesize event URLs.
export function validFeishuCalendarUrl(value, kind) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const hosts = kind === "calendarUrl" ? ["applink.feishu.cn", "applink.larkoffice.com", "applink.larksuite.com"] :
      kind === "meetingUrl" ? ["vc.feishu.cn", "vc.larkoffice.com", "vc.larksuite.com"] : [];
    return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.includes(url.hostname) &&
      value.startsWith(`https://${url.hostname}/`);
  } catch { return false; }
}
function eventShape(value) {
  return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
    ["eventRef", "title", "start", "end"].every(key => Object.hasOwn(value,key)) &&
    Object.keys(value).every(key => ["eventRef", "title", "start", "end", "calendarUrl", "meetingUrl"].includes(key)));
}
