import crypto from "node:crypto";
import { normalizeCapability } from "../../agent-runtime/context-engine.mjs";

const DIGEST = /^[a-f0-9]{64}$/;

function normalizeLockedMaterial(value, { codePrefix = "hr_training" } = {}) {
  if (!isPlainObject(value) || typeof value.content !== "string" || !value.content.trim()) {
    throw coverageError(`${codePrefix}_material_content_missing`);
  }
  const content = value.content;
  const actualBytes = Buffer.byteLength(content, "utf8");
  const coverage = value.contentCoverage;
  if (!isPlainObject(coverage) || coverage.truncated !== false ||
    !Number.isSafeInteger(coverage.sourceBytes) || !Number.isSafeInteger(coverage.includedBytes) ||
    coverage.sourceBytes !== actualBytes || coverage.includedBytes !== actualBytes ||
    !DIGEST.test(String(coverage.contentSha256 || "").toLowerCase()) ||
    crypto.createHash("sha256").update(content, "utf8").digest("hex") !== coverage.contentSha256.toLowerCase()) {
    throw coverageError(`${codePrefix}_material_coverage_incomplete`);
  }
  return Object.freeze({
    content,
    contentCoverage: Object.freeze({
      contentSha256: coverage.contentSha256.toLowerCase(),
      includedBytes: actualBytes,
      sourceBytes: actualBytes,
      truncated: false,
    }),
    materialVersionId: safeText(value.materialVersionId, 160),
    title: safeText(value.title, 240),
    ...(Array.isArray(value.coreConcepts) ? { coreConcepts: value.coreConcepts } : {}),
    ...(Array.isArray(value.keyPoints) ? { keyPoints: value.keyPoints } : {}),
  });
}

function assertFullPromptCoverage({ lease, prompt, codePrefix = "hr_training" } = {}) {
  let capability;
  try {
    capability = normalizeCapability(lease?.contextCapability);
  } catch {
    throw coverageError(`${codePrefix}_provider_context_capability_unavailable`);
  }
  const reservedTokens = Object.values(capability.reserve).reduce((total, value) => total + value, 0);
  const inputBudgetTokens = capability.contextWindowTokens - reservedTokens;
  // UTF-8 byte count is a conservative upper bound for token count: no tokenizer token consumes zero bytes.
  const promptBytes = Buffer.byteLength(JSON.stringify(prompt), "utf8");
  if (inputBudgetTokens <= 0 || promptBytes > inputBudgetTokens) {
    throw coverageError(`${codePrefix}_provider_context_coverage_insufficient`);
  }
  return Object.freeze({ inputBudgetTokens, promptBytes });
}

function safeText(value, maximum) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function coverageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { assertFullPromptCoverage, normalizeLockedMaterial };
