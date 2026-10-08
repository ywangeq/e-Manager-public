import { isIP } from "node:net";

function createManagedHttpsRequestVerifier({ publicOrigin = "", trustedIngressIps = [] } = {}) {
  const trustedIngress = normalizeTrustedIngressIps(trustedIngressIps);
  const publicHost = normalizedHttpsHost(publicOrigin);
  if (trustedIngress.size > 0 && !publicHost) throw new Error("managed_https_request_configuration_invalid");

  return function isManagedHttpsRequest({ requestContext = null } = {}) {
    const req = requestContext?.req;
    if (req?.socket?.encrypted === true) return true;
    const peerAddress = normalizedIp(req?.socket?.remoteAddress);
    const forwardedProto = singleHeader(req?.headers, "x-forwarded-proto").toLowerCase();
    const forwardedHost = singleHeader(req?.headers, "x-forwarded-host").toLowerCase();
    const host = singleHeader(req?.headers, "host").toLowerCase();
    const ingressIp = normalizedIp(singleHeader(req?.headers, "x-real-ip"));
    return isLoopback(peerAddress) && forwardedProto === "https" && forwardedHost === publicHost &&
      host === publicHost && trustedIngress.has(ingressIp);
  };
}

function normalizeTrustedIngressIps(values) {
  if (!Array.isArray(values)) throw new Error("managed_https_request_configuration_invalid");
  const normalized = values.map(normalizedIp);
  if (normalized.some((value) => !value)) throw new Error("managed_https_request_configuration_invalid");
  return new Set(normalized);
}

function normalizedHttpsHost(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" &&
      !url.search && !url.hash ? url.host.toLowerCase() : "";
  } catch {
    return "";
  }
}

function normalizedIp(value) {
  const candidate = String(value || "").trim().toLowerCase();
  const unwrapped = candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate;
  return isIP(unwrapped) ? unwrapped : "";
}

function isLoopback(value) {
  return value === "::1" || value === "127.0.0.1";
}

function singleHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return "";
  const normalized = String(value || "").trim();
  return normalized && !normalized.includes(",") ? normalized : "";
}

export { createManagedHttpsRequestVerifier };
