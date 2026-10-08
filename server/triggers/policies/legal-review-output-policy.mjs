import { AGENT_COMPLETION_CONTRACT_VERSION } from "../../agent-runtime/agent-completion-contract.mjs";

const POLICY_VERSION = "legal-review-output-policy.v6";
const RESULT_VERSION = "managed-legal-review-result.v2";
const REQUIRED_COMPLETION_EVIDENCE = "smore-legal-approval-safe-result.v1";
const DISCLAIMER = "仅供法务辅助判断，不代表最终审批意见";
const REQUIRED_SECTIONS = Object.freeze([
  "【合同基本信息】",
  "【风险汇总】",
  "【风险明细】",
]);

function createLegalReviewOutputPolicy({
  outputPolicyRef,
  skillPolicyRef,
  toolPolicyRef,
} = {}) {
  const exactOutputPolicyRef = requiredReference(outputPolicyRef);
  const exactSkillPolicyRef = requiredReference(skillPolicyRef);
  const exactToolPolicyRef = requiredReference(toolPolicyRef);

  function assertTaskPolicy(taskDefinition) {
    if (taskDefinition?.outputPolicyRef !== exactOutputPolicyRef ||
      taskDefinition?.skillPolicyRef !== exactSkillPolicyRef ||
      taskDefinition?.toolPolicyRef !== exactToolPolicyRef) {
      const error = new Error("trigger_agent_policy_snapshot_mismatch");
      error.code = "trigger_agent_policy_snapshot_mismatch";
      throw error;
    }
  }

  return Object.freeze({
    contractVersion: POLICY_VERSION,
    maxOutputTokens: 2400,
    completionContract({ taskDefinition }) {
      assertTaskPolicy(taskDefinition);
      return Object.freeze({
        contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
        maxCandidateRepairRounds: 1,
        maxEvidenceContinuationRounds: 1,
        requiredEvidence: Object.freeze([REQUIRED_COMPLETION_EVIDENCE]),
      });
    },
    candidateIssues({ maxCommentChars, text }) {
      const issues = [];
      let value;
      try {
        value = JSON.parse(String(text || ""));
      } catch {
        return Object.freeze(["invalid_json"]);
      }
      const maximum = boundedMaximum(maxCommentChars);
      const fields = ["contractVersion", "reviewComment", "riskCounts", "status", "summary"];
      if (!isPlainObject(value) || Object.keys(value).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(value, field))) issues.push("invalid_result_fields");
      if (!isPlainObject(value?.riskCounts) || !Number.isInteger(value.riskCounts.high) ||
        !Number.isInteger(value.riskCounts.medium)) issues.push("invalid_risk_counts");
      if (typeof value?.reviewComment !== "string") issues.push("invalid_review_comment");
      else {
        if (value.reviewComment.trim().length > commentBodyMaximum(maximum)) issues.push("review_comment_too_long");
        try {
          validateCommentBody(value.reviewComment.split(DISCLAIMER).join("").trim());
        } catch {
          issues.push("invalid_review_sections");
        }
      }
      return Object.freeze([...new Set(issues)].slice(0, 8));
    },
    instructions({ taskDefinition }) {
      assertTaskPolicy(taskDefinition);
      return "仅返回符合当前 JSON schema 的结果。";
    },
    outputFormat({ taskDefinition, writebackBinding }) {
      assertTaskPolicy(taskDefinition);
      const maximum = boundedMaximum(writebackBinding?.maxCommentChars);
      return Object.freeze({
        type: "json_schema",
        name: "managed_legal_review_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contractVersion: { type: "string", enum: [RESULT_VERSION] },
            status: { type: "string", enum: ["completed", "insufficient_material"] },
            summary: { type: "string", minLength: 1, maxLength: 1200 },
            riskCounts: {
              type: "object",
              properties: {
                high: { type: "integer", minimum: 0, maximum: 999 },
                medium: { type: "integer", minimum: 0, maximum: 999 },
              },
              required: ["high", "medium"],
              additionalProperties: false,
            },
            reviewComment: {
              type: "string",
              minLength: 1,
              maxLength: commentBodyMaximum(maximum),
              description: "只包含合同基本信息、风险汇总、风险明细三段正文，不包含免责声明。",
            },
          },
          required: ["contractVersion", "status", "summary", "riskCounts", "reviewComment"],
          additionalProperties: false,
        },
      });
    },
    normalizeResult({ maxCommentChars, text }) {
      const maximum = boundedMaximum(maxCommentChars);
      if (typeof text !== "string" || !text.trim()) throw policyError("trigger_agent_review_output_invalid");
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        throw policyError("trigger_agent_review_output_invalid");
      }
      const fields = ["contractVersion", "reviewComment", "riskCounts", "status", "summary"];
      if (!isPlainObject(value) || Object.keys(value).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(value, field)) ||
        value.contractVersion !== RESULT_VERSION ||
        !["completed", "insufficient_material"].includes(value.status) ||
        !isPlainObject(value.riskCounts) || Object.keys(value.riskCounts).length !== 2 ||
        !Number.isInteger(value.riskCounts.high) || value.riskCounts.high < 0 ||
        value.riskCounts.high > 999 ||
        !Number.isInteger(value.riskCounts.medium) || value.riskCounts.medium < 0 ||
        value.riskCounts.medium > 999) {
        throw policyError("trigger_agent_review_output_invalid");
      }
      const insufficient = value.status === "insufficient_material";
      const summary = insufficient
        ? "当前 subject 没有可供评审的有效材料，未形成风险结论。"
        : boundedText(value.summary, 1200);
      const reviewComment = insufficient
        ? composeReviewComment(insufficientMaterialCommentBody(), maximum)
        : composeReviewComment(value.reviewComment, maximum);
      if (insufficient && (value.riskCounts.high !== 0 || value.riskCounts.medium !== 0)) {
        throw policyError("trigger_agent_review_output_invalid");
      }
      return Object.freeze({
        reviewComment,
        result: Object.freeze({
          contractVersion: RESULT_VERSION,
          status: value.status,
          summary,
          riskCounts: Object.freeze({
            high: value.riskCounts.high,
            medium: value.riskCounts.medium,
          }),
        }),
      });
    },
    normalizeStoredResult({ result, taskDefinition }) {
      assertTaskPolicy(taskDefinition);
      const fields = ["contractVersion", "executionPolicyDigest", "riskCounts", "status", "summary"];
      if (!isPlainObject(result) || Object.keys(result).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(result, field)) ||
        result.contractVersion !== RESULT_VERSION ||
        !/^[a-f0-9]{64}$/.test(String(result.executionPolicyDigest || "")) ||
        !["completed", "insufficient_material"].includes(result.status) ||
        !isPlainObject(result.riskCounts) || Object.keys(result.riskCounts).length !== 2 ||
        !Number.isInteger(result.riskCounts.high) || result.riskCounts.high < 0 ||
        result.riskCounts.high > 999 ||
        !Number.isInteger(result.riskCounts.medium) || result.riskCounts.medium < 0 ||
        result.riskCounts.medium > 999 ||
        typeof result.summary !== "string" || !result.summary.trim() ||
        (result.status === "insufficient_material" &&
          (result.riskCounts.high !== 0 || result.riskCounts.medium !== 0 ||
            result.summary !== "当前 subject 没有可供评审的有效材料，未形成风险结论。"))) {
        throw policyError("trigger_agent_stored_result_invalid");
      }
      return Object.freeze({ status: result.status });
    },
  });
}

function insufficientMaterialCommentBody() {
  return "【合同基本信息】\n当前 subject 未提供可供评审的有效表单文本或附件。\n" +
    "【风险汇总】\n材料不足，无法形成风险结论。\n" +
    "【风险明细】\n未进行实体风险判断，请补充有效材料后重新触发。";
}

function composeReviewComment(value, maximum) {
  const normalized = boundedText(value, maximum);
  const body = boundedText(normalized.split(DISCLAIMER).join("").trim(), commentBodyMaximum(maximum));
  validateCommentBody(body);
  return `${body}\n${DISCLAIMER}`;
}

function validateCommentBody(value) {
  let previous = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = value.indexOf(section);
    if (index <= previous || value.indexOf(section, index + section.length) !== -1) {
      throw policyError("trigger_agent_review_output_invalid");
    }
    previous = index;
  }
}

function boundedMaximum(value) {
  if (!Number.isInteger(value) || value < 500 || value > 20_000) {
    throw policyError("trigger_agent_review_output_invalid");
  }
  return value;
}

function commentBodyMaximum(maximum) {
  return maximum - DISCLAIMER.length - 1;
}

function boundedText(value, maximum) {
  if (typeof value !== "string") {
    throw policyError("trigger_agent_review_output_invalid");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw policyError("trigger_agent_review_output_invalid");
  }
  return normalized;
}

function requiredReference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("legal review output policy reference invalid");
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  POLICY_VERSION as LEGAL_REVIEW_OUTPUT_POLICY_VERSION,
  RESULT_VERSION as MANAGED_LEGAL_REVIEW_RESULT_VERSION,
  createLegalReviewOutputPolicy,
};
