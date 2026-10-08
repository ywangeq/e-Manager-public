const LOCAL_ENDPOINT_SOURCES = new Set(["local_discovery", "fallback"]);
const CONNECTION_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_NETWORK_CHANGED",
  "ERR_NAME_NOT_RESOLVED",
];

function isLocalEndpointSource(source = "") {
  return LOCAL_ENDPOINT_SOURCES.has(String(source || ""));
}

function isDesktopConnectionFailure(error) {
  const details = [error?.code, error?.message, error?.cause?.code, error?.cause?.message]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return CONNECTION_ERROR_CODES.some((code) => details.includes(code));
}

function isDesktopCenterUnavailableError(error) {
  return isDesktopConnectionFailure(error) || String(error?.message || error) === "desktop_server_url_missing";
}

async function fetchWithLocalEndpointRecovery({
  endpoint = {},
  onRecovered = () => {},
  rediscover,
  request,
} = {}) {
  try {
    return await request(endpoint.url);
  } catch (error) {
    if (!isLocalEndpointSource(endpoint.source) || !isDesktopConnectionFailure(error)) throw error;
    const recovered = await rediscover();
    if (!recovered?.url) throw error;
    const response = await request(recovered.url);
    onRecovered(recovered);
    return response;
  }
}

function desktopCenterUnavailableResult(message = "数字员工中心暂时不可达，请检查本机服务或公司网络后重试。") {
  const safeMessage = String(message || "数字员工中心暂时不可达，请稍后重试。").slice(0, 240);
  const payload = { code: "desktop_center_unavailable", message: safeMessage };
  return {
    ok: false,
    status: 503,
    error: payload.code,
    message: payload.message,
    body: `event: error\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

export {
  desktopCenterUnavailableResult,
  fetchWithLocalEndpointRecovery,
  isDesktopCenterUnavailableError,
  isDesktopConnectionFailure,
  isLocalEndpointSource,
};
