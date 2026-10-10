import { FEISHU_CALENDAR_READ_DESCRIPTOR } from "../shared/feishu-calendar-read-contract.mjs";
import { createFeishuReadAdapter } from "./feishu-read-adapter.mjs";

// Existing calendar-sync caller keeps its calendar-only descriptor.
export function createFeishuCalendarReadAdapter(options = {}) {
  return createFeishuReadAdapter({ ...options, descriptor: FEISHU_CALENDAR_READ_DESCRIPTOR });
}
