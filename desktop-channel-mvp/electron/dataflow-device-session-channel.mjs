const BOOTSTRAP_CONTRACT = "current-user-tool-credential-broker-bootstrap.v1";
const CHALLENGE_CONTRACT = "current-user-tool-credential-challenge.v1";
const POLL_CONTRACT = "current-user-tool-credential-challenge-poll.v1";
const RESPONSE_CONTRACT = "current-user-tool-credential-challenge-response.v1";
const SUBJECT_EVIDENCE_CONTRACT = "dataflow-device-session-evidence.v1";
const TOOL_ID = "dataflow-rest-api";
const AUDIENCE = "dataflow";
const RETRY_DELAY_MS = 2_000;

function dataflowCredentialConfigFromBootstrap(value = null) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value) || value.contractVersion !== BOOTSTRAP_CONTRACT || !Array.isArray(value.brokers)) {
    throw channelError("dataflow_credential_bootstrap_invalid");
  }
  const candidates = value.brokers.filter((item) => item?.toolId === TOOL_ID);
  if (candidates.length !== 1) throw channelError(candidates.length
    ? "dataflow_credential_bootstrap_ambiguous"
    : "dataflow_credential_bootstrap_missing");
  const item = candidates[0];
  if (!plainObject(item) || item.mode !== "device_session_refresh") {
    throw channelError("dataflow_credential_bootstrap_invalid");
  }
  const apiOrigin = httpsOrigin(item.apiOrigin, "dataflow_credential_api_origin_invalid");
  const allowedLoginOrigins = arrayOfOrigins(item.allowedLoginOrigins || []);
  const loginUrl = httpsUrl(item.loginUrl, "dataflow_credential_login_url_invalid");
  if (![apiOrigin, ...allowedLoginOrigins].includes(new URL(loginUrl).origin)) {
    throw channelError("dataflow_credential_login_origin_not_allowed");
  }
  return Object.freeze({
    accessTokenJsonPath: jsonPath(item.accessTokenJsonPath, "dataflow_credential_access_token_path_required"),
    actorBindingId: opaque(item.actorBindingId, "dataflow_credential_actor_binding_required", 320),
    allowedLoginOrigins,
    apiOrigin,
    certificateSha256Fingerprints: arrayOfFingerprints(item.certificateSha256Fingerprints || []),
    expectedIdentity: verifiedEnterpriseUsername(item.expectedIdentity),
    expiresInSecondsJsonPath: item.expiresInSecondsJsonPath
      ? jsonPath(item.expiresInSecondsJsonPath, "dataflow_credential_expiry_path_invalid")
      : "",
    identityJsonPath: jsonPath(item.identityJsonPath, "dataflow_credential_identity_path_required"),
    loginUrl,
    paths: normalizePaths(item.paths),
  });
}

function createDataflowCredentialChallengeClient({
  broker,
  fetchCenter,
  now = () => Date.now(),
  onStatus = () => {},
  transportAllowed = () => false,
} = {}) {
  if (typeof broker?.authorizationFor !== "function" || typeof broker?.status !== "function") {
    throw channelError("dataflow_credential_broker_required");
  }
  if (typeof fetchCenter !== "function") throw channelError("dataflow_credential_center_transport_required");
  let controller = null;
  let loopPromise = null;

  function start() {
    if (loopPromise && !controller?.signal.aborted) return loopPromise;
    if (loopPromise) {
      const previousLoop = loopPromise;
      return previousLoop.then(start, start);
    }
    controller = new AbortController();
    loopPromise = runLoop(controller.signal).finally(() => {
      controller = null;
      loopPromise = null;
    });
    return loopPromise;
  }

  function stop() {
    controller?.abort();
  }

  async function runLoop(signal) {
    while (!signal.aborted) {
      if (!transportAllowed()) {
        emitStatus("blocked", "center_credential_transport_insecure");
        return;
      }
      try {
        const result = await pollOnce({ signal });
        if (result.status === "idle") await abortableDelay(RETRY_DELAY_MS, signal);
      } catch (error) {
        if (signal.aborted || error?.code === "dataflow_credential_request_canceled") return;
        if (terminalChallengeCode(error?.code)) {
          emitStatus(error.code === "dataflow_interactive_login_required" ? "refresh_required" : "blocked", error.code);
          return;
        }
        emitStatus("degraded", safeCode(error?.code || "dataflow_credential_challenge_unavailable"));
        await abortableDelay(RETRY_DELAY_MS, signal);
      }
    }
  }

  async function pollOnce({ signal = null } = {}) {
    if (signal?.aborted) throw channelError("dataflow_credential_request_canceled");
    if (!transportAllowed()) throw channelError("center_credential_transport_insecure");
    const response = await safeCenterFetch(fetchCenter, "/api/tool-credential-challenges/pending?channelId=desktop", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    }, "dataflow_credential_challenge_poll_failed");
    if (!response.ok) throw channelError(response.status === 401
      ? "center_credential_authentication_required"
      : response.status === 403
        ? "center_credential_challenge_forbidden"
        : "dataflow_credential_challenge_poll_rejected");
    const payload = await response.json().catch(() => null);
    const challenge = normalizePoll(payload, validNow(now()));
    if (!challenge) {
      return Object.freeze({ status: "idle" });
    }
    const deadline = linkedDeadlineSignal(signal, Date.parse(challenge.expiresAt) - validNow(now()));
    try {
      const lease = await broker.authorizationFor({ signal: deadline.signal });
      if (Date.parse(lease.expiresAt) <= validNow(now())) throw channelError("dataflow_credential_lease_expired");
      const result = await safeCenterFetch(fetchCenter, `/api/tool-credential-challenges/${encodeURIComponent(challenge.challengeId)}/response`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        signal: deadline.signal,
        body: JSON.stringify({
          contractVersion: RESPONSE_CONTRACT,
          challengeId: challenge.challengeId,
          toolId: TOOL_ID,
          authorization: lease.authorization,
          expiresAt: lease.expiresAt,
          subjectEvidence: {
            contractVersion: SUBJECT_EVIDENCE_CONTRACT,
            kind: "current_browser_session",
            apiOrigin: broker.status().apiOrigin,
          },
        }),
      }, "dataflow_credential_challenge_response_failed");
      if (!result.ok) throw channelError(result.status === 401
        ? "center_credential_authentication_required"
        : result.status === 403
          ? "center_credential_challenge_forbidden"
          : "dataflow_credential_challenge_response_rejected");
      emitStatus("ready", "credential_challenge_answered", lease.expiresAt);
      return Object.freeze({ status: "answered", challengeId: challenge.challengeId, expiresAt: lease.expiresAt });
    } catch (error) {
      if (!signal?.aborted && deadline.signal.aborted) throw channelError("dataflow_credential_challenge_expired");
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  function emitStatus(status, code, expiresAt = "") {
    onStatus(Object.freeze({ status, code, toolId: TOOL_ID, expiresAt }));
  }

  return Object.freeze({ pollOnce, start, stop });
}

function normalizePoll(value, currentTime) {
  if (!plainObject(value) || value.contractVersion !== POLL_CONTRACT || !("challenge" in value)) {
    throw channelError("dataflow_credential_challenge_poll_invalid");
  }
  if (value.challenge === null) return null;
  const challenge = value.challenge;
  if (!plainObject(challenge) || challenge.contractVersion !== CHALLENGE_CONTRACT ||
    challenge.toolId !== TOOL_ID || challenge.audience !== AUDIENCE || !Array.isArray(challenge.scopes) ||
    challenge.scopes.length > 64 || challenge.scopes.some((scope) => !safeScope(scope))) {
    throw channelError("dataflow_credential_challenge_invalid");
  }
  const challengeId = opaque(challenge.challengeId, "dataflow_credential_challenge_invalid", 160);
  const expiresAtMs = Date.parse(challenge.expiresAt || "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= currentTime || expiresAtMs - currentTime > 60_000) {
    throw channelError("dataflow_credential_challenge_expired");
  }
  return Object.freeze({ challengeId, expiresAt: new Date(expiresAtMs).toISOString() });
}

async function safeCenterFetch(fetchCenter, path, options, errorCode) {
  if (options?.signal?.aborted) throw channelError("dataflow_credential_request_canceled");
  try {
    return await fetchCenter(path, options);
  } catch {
    if (options?.signal?.aborted) throw channelError("dataflow_credential_request_canceled");
    throw channelError(errorCode);
  }
}

function normalizePaths(value) {
  if (value === null || value === undefined) return Object.freeze({});
  if (!plainObject(value)) throw channelError("dataflow_credential_paths_invalid");
  const result = {};
  for (const key of ["logout", "me", "refresh"]) {
    if (value[key] !== undefined) result[key] = relativePath(value[key]);
  }
  return Object.freeze(result);
}

function arrayOfOrigins(value) {
  if (!Array.isArray(value) || value.length > 8) throw channelError("dataflow_credential_login_origins_invalid");
  return Object.freeze([...new Set(value.map((origin) => httpsOrigin(origin, "dataflow_credential_login_origins_invalid")))]);
}

function arrayOfFingerprints(value) {
  if (!Array.isArray(value) || value.length > 4) throw channelError("dataflow_credential_certificate_pins_invalid");
  return Object.freeze(value.map((item) => {
    const canonical = String(item || "");
    if (!/^[a-f0-9]{64}$/.test(canonical)) throw channelError("dataflow_credential_certificate_pins_invalid");
    return canonical;
  }));
}

function verifiedEnterpriseUsername(value) {
  if (!plainObject(value) || value.type !== "verified_enterprise_username" ||
    Object.keys(value).some((key) => !["type", "value"].includes(key))) {
    throw channelError("dataflow_credential_expected_identity_invalid");
  }
  const username = value.value;
  if (typeof username !== "string" || username !== username.toLowerCase() ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(username)) {
    throw channelError("dataflow_credential_expected_identity_invalid");
  }
  return Object.freeze({ type: "verified_enterprise_username", value: username });
}

function httpsOrigin(value, errorCode) {
  const url = parsedHttpsUrl(value, errorCode);
  if (url.pathname !== "/" || url.search || url.hash) throw channelError(errorCode);
  return url.origin;
}

function httpsUrl(value, errorCode) {
  return parsedHttpsUrl(value, errorCode).toString();
}

function parsedHttpsUrl(value, errorCode) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
    return url;
  } catch {
    throw channelError(errorCode);
  }
}

function relativePath(value) {
  const result = String(value || "").trim();
  if (!result.startsWith("/") || result.startsWith("//") || /[\r\n\0?#]/.test(result)) {
    throw channelError("dataflow_credential_paths_invalid");
  }
  return result;
}

function jsonPath(value, errorCode) {
  const parts = Array.isArray(value) ? value : String(value || "").split(".");
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_-]{1,80}$/.test(String(part)))) throw channelError(errorCode);
  return parts.map(String).join(".");
}

function safeScope(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:@/-]{1,160}$/.test(value);
}

function opaque(value, errorCode, maxLength) {
  const result = text(value, errorCode, maxLength);
  if (!/^[A-Za-z0-9._:@-]+$/.test(result)) throw channelError(errorCode);
  return result;
}

function text(value, errorCode, maxLength) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxLength || /[\r\n\0]/.test(result)) throw channelError(errorCode);
  return result;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validNow(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw channelError("dataflow_credential_clock_invalid");
  return result;
}

function safeCode(value) {
  return String(value || "dataflow_credential_challenge_unavailable").replace(/[^a-z0-9._:-]+/gi, "_").slice(0, 120);
}

function terminalChallengeCode(value) {
  return [
    "center_credential_authentication_required",
    "center_credential_challenge_forbidden",
    "dataflow_interactive_login_required",
    "dataflow_identity_mismatch",
    "dataflow_identity_probe_forbidden",
  ].includes(value);
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function linkedDeadlineSignal(parentSignal, milliseconds) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, milliseconds));
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", forwardAbort);
    },
  });
}

function channelError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  BOOTSTRAP_CONTRACT as DATAFLOW_CREDENTIAL_BOOTSTRAP_CONTRACT,
  CHALLENGE_CONTRACT as DATAFLOW_CREDENTIAL_CHALLENGE_CONTRACT,
  POLL_CONTRACT as DATAFLOW_CREDENTIAL_CHALLENGE_POLL_CONTRACT,
  RESPONSE_CONTRACT as DATAFLOW_CREDENTIAL_CHALLENGE_RESPONSE_CONTRACT,
  createDataflowCredentialChallengeClient,
  dataflowCredentialConfigFromBootstrap,
};
