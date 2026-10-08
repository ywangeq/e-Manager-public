import os from "node:os";

const PREFERRED_INTERFACES = ["en1", "en0"];

export function resolveLanHost(fallback = "") {
  const configured = cleanHost(process.env.DIGITAL_WORKFORCE_LAN_HOST);
  if (configured) return configured;

  const preferred = findPrivateIpv4(PREFERRED_INTERFACES);
  if (preferred) return preferred;

  const detected = findPrivateIpv4(Object.keys(os.networkInterfaces()));
  if (detected) return detected;

  return fallback;
}

function findPrivateIpv4(interfaceNames) {
  const interfaces = os.networkInterfaces();
  for (const name of interfaceNames) {
    for (const address of interfaces[name] || []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return "";
}

function isPrivateIpv4(address) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
}

function cleanHost(value) {
  return String(value || "").trim();
}
