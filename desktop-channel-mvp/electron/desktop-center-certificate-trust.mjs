import { installExactCertificateTrust } from "./dataflow-device-session-broker.mjs";

function normalizeManagedCenterCertificatePins(value, { origin = "" } = {}) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || !isHttpsOrigin(origin)) return null;
  const pins = [...new Set(value.map((item) => String(item || "").trim().toLowerCase()))];
  if (!pins.length || pins.length > 4 || pins.some((pin) => !/^[a-f0-9]{64}$/.test(pin))) return null;
  return Object.freeze(pins);
}

function isHttpsOrigin(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch {
    return false;
  }
}

function installManagedCenterCertificateTrust({ browserSession, certificateSha256Fingerprints = [], origin = "" } = {}) {
  if (!certificateSha256Fingerprints.length) return () => {};
  return installExactCertificateTrust({ browserSession, certificateSha256Fingerprints, origin });
}

export { installManagedCenterCertificateTrust, normalizeManagedCenterCertificatePins };
