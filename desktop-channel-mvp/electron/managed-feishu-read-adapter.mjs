import path from "node:path";
import { createFeishuReadHelperClient } from "./feishu-read-helper-client.mjs";
import { createFeishuReadAdapter } from "./feishu-read-adapter.mjs";
import buildContract from "../shared/feishu-read-build.cjs";

// Only the sealed package resource namespace. No user config/executable override
// or installed CLI fallback. Package/signature verification owns provenance.
import { FEISHU_CALENDAR_READ_DESCRIPTOR } from "../shared/feishu-calendar-read-contract.mjs";
import { FEISHU_MAIL_LIST_DESCRIPTOR, FEISHU_MAIL_GET_DESCRIPTOR } from "../shared/feishu-mail-read-contract.mjs";

export function createManagedFeishuReadAdapter(options = {}) {
 return createManagedFeishuReadAdapters(options)[0] || null;
}
export function createManagedFeishuReadAdapters({ resourcesPath, connection, platform = process.platform, arch = process.arch } = {}) {
  try {
    if (!path.isAbsolute(resourcesPath || "")) return [];
    const { binaryPath, manifest } = buildContract.verifyFeishuReadResources(path.join(resourcesPath, "feishu-read"), platform, arch);
    return [FEISHU_CALENDAR_READ_DESCRIPTOR, FEISHU_MAIL_LIST_DESCRIPTOR, FEISHU_MAIL_GET_DESCRIPTOR].map(descriptor => {
      const read = createFeishuReadHelperClient({ executablePath: binaryPath, executableDigest: manifest.binaryDigest, descriptor });
      return createFeishuReadAdapter({ connection, read, descriptor });
    });
  } catch { return []; }
}
