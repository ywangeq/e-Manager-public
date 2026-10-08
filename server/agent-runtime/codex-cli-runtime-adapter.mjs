import { spawn } from "node:child_process";

const DEFAULT_CODEX_CLI_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TIMEOUT_MS = 60_000;

async function runCodexCliRuntime({ model = "gpt-5.5", prompt = "", reasoningEffort = "medium", signal = null } = {}) {
  if (signal?.aborted) throw canceledError();
  const bin = process.env.CODEX_CLI_BIN || DEFAULT_CODEX_CLI_BIN;
  const timeoutMs = clampNumber(process.env.CODEX_CLI_TIMEOUT_MS, 5_000, 5 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const child = spawn(bin, [
    "exec", "--ephemeral", "--sandbox", "read-only", "--json",
    "-m", model,
    "-c", `model_reasoning_effort="${reasoningEffort}"`,
    "-C", process.cwd(), "-",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let killTimer = null;
  const timeout = setTimeout(() => { if (!settled) child.kill("SIGTERM"); }, timeoutMs);
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    killTimer.unref?.();
  };
  signal?.addEventListener?.("abort", abort, { once: true });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener?.("abort", abort);
  });
  if (signal?.aborted) throw canceledError();
  if (exitCode !== 0) throw new Error(`Codex CLI 执行失败：${safeError(stderr || stdout || `exit ${exitCode}`)}`);
  const parsed = parseCodexCliJsonl(stdout);
  if (!parsed.text) throw new Error(`Codex CLI 未返回可展示文本：${safeError(stderr || stdout || "empty output")}`);
  return parsed;
}

function canceledError() {
  const error = new Error("agent_turn_canceled");
  error.code = "agent_turn_canceled";
  return error;
}

function parseCodexCliJsonl(text) {
  let latestAgentText = "";
  let usage = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) latestAgentText = String(event.item.text);
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // Ignore non-contract CLI output.
    }
  }
  return { text: latestAgentText, usage };
}

function safeError(text) {
  return String(text || "").replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]").split(/\r?\n/).slice(0, 4).join(" ").slice(0, 420);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export { runCodexCliRuntime };
