import crypto from "node:crypto";

const DESKTOP_SANDBOX_DEVICE_SESSION_HEADER = "x-digital-workforce-device-session";

function createDesktopSandboxDeviceSession({ randomUUID = crypto.randomUUID } = {}) {
  if (typeof randomUUID !== "function") throw new TypeError("desktop sandbox device session requires randomUUID");
  let value = createSessionId(randomUUID);

  function headers(existingHeaders = undefined) {
    const normalized = new Headers(existingHeaders);
    normalized.set(DESKTOP_SANDBOX_DEVICE_SESSION_HEADER, value);
    return normalized;
  }

  function rotate() {
    value = createSessionId(randomUUID);
  }

  return Object.freeze({ headers, rotate });
}

function createSessionId(randomUUID) {
  const value = String(randomUUID() || "").replace(/-/g, "");
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new TypeError("desktop sandbox device session id invalid");
  return `dws_${value.toLowerCase()}`;
}

export { DESKTOP_SANDBOX_DEVICE_SESSION_HEADER, createDesktopSandboxDeviceSession };
