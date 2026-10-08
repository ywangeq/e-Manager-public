import { spawn as defaultSpawn } from "node:child_process";

const PROBE_MARKER = "DW_INFRA_PROBE";

export function createRuntimeInfrastructureProbe({
  clusterCliPath = process.env.ALGORITHM_CLUSTER_CLI_PATH || "",
  mode = process.env.RUNTIME_INFRASTRUCTURE_PROBE_MODE || "ssh",
  spawn = defaultSpawn,
  sshBin = process.env.RUNTIME_INFRASTRUCTURE_SSH_BIN || "ssh",
  timeoutMs = Number(process.env.RUNTIME_INFRASTRUCTURE_PROBE_TIMEOUT_MS || 8_000),
} = {}) {
  return {
    async probe(infrastructure = {}) {
      if (mode === "mock") return mockProbe(infrastructure);
      return sshProbe({ clusterCliPath, infrastructure, spawn, sshBin, timeoutMs });
    },
  };
}

async function sshProbe({ clusterCliPath, infrastructure, spawn, sshBin, timeoutMs }) {
  const connectionRef = cleanConnectionRef(infrastructure.connectionRef);
  if (!connectionRef) {
    return { ok: false, code: "connection_ref_missing", message: "缺少服务端 SSH 凭据引用。" };
  }

  const command = buildProbeCommand({
    kind: infrastructure.kind,
    cliAdapter: infrastructure.cliAdapter,
    clusterCliPath,
  });
  const result = await run(sshBin, [
    "-o", "BatchMode=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", `ConnectTimeout=${clampTimeout(timeoutMs)}`,
    "-o", "StrictHostKeyChecking=yes",
    connectionRef,
    command,
  ], { spawn, timeoutMs });

  if (!result.ok) {
    return {
      ok: false,
      code: result.timedOut ? "probe_timeout" : "connection_failed",
      message: result.timedOut ? "只读联通探测超时。" : "未能完成服务端 SSH 只读联通探测。",
    };
  }

  const values = parseProbeOutput(result.stdout);
  if (values.marker !== "ok" || !values.account) {
    return { ok: false, code: "probe_contract_invalid", message: "联通探测未返回有效安全摘要。" };
  }
  if (infrastructure.kind === "cluster" && values.cliStatus !== "available") {
    return { ok: false, code: "cluster_cli_unavailable", message: "SSH 已联通，但未检测到可用集群 CLI。" };
  }

  return {
    ok: true,
    accountMasked: maskIdentifier(values.account),
    cliAdapter: values.cliAdapter || "",
    cliStatus: infrastructure.kind === "cluster" ? "available" : "not_applicable",
    detectedGpuCount: safeNumber(values.gpuCount),
    probeMode: "server_side_read_only_ssh",
    summary: infrastructure.kind === "cluster"
      ? "SSH 与集群 CLI 只读探测通过。"
      : "SSH 与 GPU 可见性只读探测通过。",
  };
}

function mockProbe(infrastructure = {}) {
  const declaredGpuCount = safeNumber(infrastructure.gpuTotal);
  const detectedGpuCount = declaredGpuCount || (infrastructure.kind === "cluster" ? 8 : 2);
  return Promise.resolve({
    ok: true,
    accountMasked: infrastructure.kind === "cluster" ? "c***r" : "r***e",
    cliAdapter: infrastructure.kind === "cluster" ? infrastructure.cliAdapter === "auto" ? "schedctl_object" : infrastructure.cliAdapter : "",
    cliStatus: infrastructure.kind === "cluster" ? "available" : "not_applicable",
    detectedGpuCount,
    probeMode: "mvp_mock",
    summary: infrastructure.kind === "cluster"
      ? "MVP 集群 CLI 模拟探测通过。"
      : "MVP Remote SSH 模拟探测通过。",
  });
}

function buildProbeCommand({ kind, cliAdapter = "auto", clusterCliPath = "" } = {}) {
  const gpuProbe = "if command -v nvidia-smi >/dev/null 2>&1; then GPU_COUNT=$(nvidia-smi -L 2>/dev/null | sed -n '$='); else GPU_COUNT=0; fi";
  const base = [
    `printf '${PROBE_MARKER}=ok\\n'`,
    "ACCOUNT=$(whoami 2>/dev/null || true)",
    "printf 'ACCOUNT=%s\\n' \"$ACCOUNT\"",
    gpuProbe,
    "printf 'GPU_COUNT=%s\\n' \"$GPU_COUNT\"",
  ];
  if (kind !== "cluster") return `${base.join("; ")}; printf 'CLI_STATUS=not_applicable\\n'`;

  const cliProbe = buildClusterCliProbe({ cliAdapter, clusterCliPath });
  return `${base.join("; ")}; ${cliProbe}; printf 'CLI_STATUS=%s\\n' \"$CLI_STATUS\"; printf 'CLI_ADAPTER=%s\\n' \"$CLI_ADAPTER\"`;
}

function buildClusterCliProbe({ cliAdapter, clusterCliPath }) {
  const configuredPath = safeCliPath(clusterCliPath);
  const candidates = [];
  if (configuredPath) candidates.push(`[ -x '${configuredPath}' ] && CLI_ADAPTER='${configuredPath.split("/").pop()}'`);
  if (cliAdapter === "schedctl") candidates.push("command -v schedctl >/dev/null 2>&1 && CLI_ADAPTER=schedctl");
  else if (cliAdapter === "schedctl_object") candidates.push("command -v schedctl_object >/dev/null 2>&1 && CLI_ADAPTER=schedctl_object");
  else candidates.push("command -v schedctl_object >/dev/null 2>&1 && CLI_ADAPTER=schedctl_object", "command -v schedctl >/dev/null 2>&1 && CLI_ADAPTER=schedctl");
  return `CLI_ADAPTER=''; ${candidates.map((candidate) => `[ -z \"$CLI_ADAPTER\" ] && ${candidate}`).join("; ")}; if [ -n \"$CLI_ADAPTER\" ]; then CLI_STATUS=available; else CLI_STATUS=missing; fi`;
}

function run(command, args, { spawn, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, Math.max(1_000, timeoutMs));
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 8_192) stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish({ ok: false, stdout, timedOut }));
    child.on("close", (code) => finish({ ok: code === 0 && !timedOut, stdout, timedOut }));
  });
}

function parseProbeOutput(output = "") {
  const values = {};
  String(output).split(/\r?\n/).forEach((line) => {
    const [key, ...parts] = line.split("=");
    if (!key || !parts.length) return;
    values[normalizeKey(key)] = parts.join("=").trim();
  });
  return {
    marker: values.dwInfraProbe === "ok" ? "ok" : "",
    account: values.account || "",
    gpuCount: values.gpuCount || "0",
    cliAdapter: values.cliAdapter || "",
    cliStatus: values.cliStatus || "",
  };
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function cleanConnectionRef(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 120 || text.startsWith("-") || /[\s\u0000-\u001f]/.test(text)) return "";
  return text;
}

function safeCliPath(value) {
  const text = String(value || "").trim();
  return /^\/[A-Za-z0-9._/-]+$/.test(text) ? text : "";
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 8;
  return Math.max(1, Math.min(30, Math.ceil(number / 1_000)));
}

function maskIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 2) return "**";
  return `${text.slice(0, 1)}***${text.slice(-1)}`;
}
