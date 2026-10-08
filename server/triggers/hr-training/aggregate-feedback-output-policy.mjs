import { normalizeLockedMaterial } from "./locked-material-coverage.mjs";

const POLICY_VERSION = "hr-training-aggregate-feedback-output-policy.v1";
const CONTEXT_VERSION = "hr-training.aggregate-feedback-context.v1";
const RESULT_VERSION = "hr-training.aggregate-feedback-result.v1";
const RESULT_KIND = "FINAL_SUGGESTION_SUMMARY";
const PROMPT_VERSION = "hr-training-aggregate-feedback-v1";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/\S+/i;
const FORBIDDEN_FIELD = /(?:auth|bearer|callback|credential|duration|max(?:score)?|pass(?:score)?|password|prompt|question[_-]?score|raw|rubric|score|secret|token|trace|transcript|url)/i;
const SCOPES = new Set(["CONTENT", "FOLLOWUP", "CROSS_ROUND"]);
const EVIDENCE_TYPES = new Set(["CONTENT", "FOLLOWUP"]);

function createHrTrainingAggregateFeedbackOutputPolicy({ outputPolicyRef, promptVersion = PROMPT_VERSION } = {}) {
  const exactOutputPolicyRef = requiredReference(outputPolicyRef || "output-policy:hr-training-aggregate-feedback@v1");
  const exactPromptVersion = requiredReference(promptVersion);
  const assertTaskPolicy = (taskDefinition) => {
    if (taskDefinition?.outputPolicyRef !== exactOutputPolicyRef) {
      throw policyError("hr_training_aggregate_feedback_policy_snapshot_mismatch");
    }
  };
  return Object.freeze({
    contractVersion: POLICY_VERSION,
    maxOutputTokens: 1800,
    promptVersion: exactPromptVersion,
    candidateIssues({ context, expected, text }) {
      try {
        normalizeResult({ context, expected, modelName: "", promptVersion: exactPromptVersion, text });
        return Object.freeze([]);
      } catch (error) {
        return Object.freeze([safeIssueCode(error)]);
      }
    },
    outputFormat({ context, expected, taskDefinition }) {
      assertTaskPolicy(taskDefinition);
      const normalizedContext = normalizeAggregateFeedbackContext(context, expected);
      return Object.freeze({
        type: "json_schema",
        name: "hr_training_aggregate_feedback_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contractVersion: { type: "string", enum: [RESULT_VERSION] },
            resultKind: { type: "string", enum: [RESULT_KIND] },
            sessionId: { type: "string", enum: [expected.sessionId] },
            meetingRecordId: { type: "string", enum: [expected.meetingRecordId] },
            status: { type: "string", enum: ["SUCCEEDED"] },
            mainSuggestions: {
              type: "array", minItems: 1, maxItems: 5,
              items: { anyOf: [...SCOPES].map((scope) => suggestionSchema(scope, normalizedContext)) },
            },
            modelName: { type: "string", maxLength: 120 },
            promptVersion: { type: "string", enum: [exactPromptVersion] },
          },
          required: ["contractVersion", "resultKind", "sessionId", "meetingRecordId", "status", "mainSuggestions", "modelName", "promptVersion"],
          additionalProperties: false,
        },
      });
    },
    normalizeResult({ context, expected, modelName, promptVersion: requestedPromptVersion = exactPromptVersion, text }) {
      const normalizedContext = normalizeAggregateFeedbackContext(context, expected);
      const value = parseJsonObject(text);
      requireExactObject(value, new Set(["contractVersion", "resultKind", "sessionId", "meetingRecordId", "status", "mainSuggestions", "modelName", "promptVersion"]),
        "hr_training_aggregate_feedback_result_invalid");
      if (value.contractVersion !== RESULT_VERSION || value.resultKind !== RESULT_KIND || value.status !== "SUCCEEDED" ||
        value.sessionId !== expected.sessionId || value.meetingRecordId !== expected.meetingRecordId || value.promptVersion !== requestedPromptVersion) {
        throw policyError("hr_training_aggregate_feedback_result_invalid");
      }
      return deepFreeze({
        contractVersion: RESULT_VERSION,
        resultKind: RESULT_KIND,
        sessionId: expected.sessionId,
        meetingRecordId: expected.meetingRecordId,
        status: "SUCCEEDED",
        mainSuggestions: normalizeSuggestions(value.mainSuggestions, normalizedContext),
        modelName: safeText(modelName || value.modelName || "", 120, { allowEmpty: true }),
        promptVersion: requestedPromptVersion,
      });
    },
  });
}

function normalizeAggregateFeedbackContext(value, expected = {}) {
  const context = unwrapContext(value);
  if (!isPlainObject(context) || context.contractVersion !== CONTEXT_VERSION || context.ready !== true ||
    context.session?.sessionId !== expected.sessionId || context.attempt?.meetingRecordId !== expected.meetingRecordId) {
    throw policyError("hr_training_aggregate_feedback_context_invalid");
  }
  rejectScoresOrSensitiveFields(context);
  const material = normalizeLockedMaterial(context.material, { codePrefix: "hr_training_aggregate_feedback_context" });
  if (!isPlainObject(context.contentEvaluation) || !isPlainObject(context.contentEvaluation.feedback) ||
    !Array.isArray(context.followupEvaluations)) {
    throw policyError("hr_training_aggregate_feedback_context_invalid");
  }
  const followups = context.followupEvaluations.map(normalizeFollowup);
  if (new Set(followups.map((item) => item.questionId)).size !== followups.length) {
    throw policyError("hr_training_aggregate_feedback_context_duplicate_question");
  }
  return deepFreeze({
    contractVersion: CONTEXT_VERSION,
    ready: true,
    session: { sessionId: expected.sessionId },
    attempt: { meetingRecordId: expected.meetingRecordId },
    material,
    contentEvaluation: { feedback: projectSafeObject(context.contentEvaluation.feedback) },
    followupEvaluations: followups,
  });
}

function projectAggregateFeedbackPromptContext(context) {
  const normalized = normalizeAggregateFeedbackContext(context, {
    sessionId: context?.session?.sessionId,
    meetingRecordId: context?.attempt?.meetingRecordId,
  });
  return normalized;
}

function normalizeFollowup(value) {
  if (!isPlainObject(value) || (!isPlainObject(value.question) && typeof value.question !== "string") ||
    (!isPlainObject(value.answer) && typeof value.answer !== "string") || !isPlainObject(value.feedback)) {
    throw policyError("hr_training_aggregate_feedback_context_invalid");
  }
  const questionId = requiredToken(value.questionId || value.question.questionId || value.question.id, "questionId");
  if (value.answer.questionId && value.answer.questionId !== questionId) throw policyError("hr_training_aggregate_feedback_context_invalid");
  return Object.freeze({
    questionId,
    question: safeText(typeof value.question === "string" ? value.question : value.question.text || value.question.content, 1200),
    answer: safeText(typeof value.answer === "string" ? value.answer : value.answer.text || value.answer.content, 4000),
    feedback: projectSafeObject(value.feedback),
    materialGrounding: value.materialGrounding === undefined || value.materialGrounding === null ? null : projectSafeObject(value.materialGrounding),
  });
}

function normalizeSuggestions(value, context) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw policyError("hr_training_aggregate_feedback_suggestion_count_invalid");
  const suggestions = value.map((item) => normalizeSuggestion(item, context));
  const identities = suggestions.map((item) => item.direction.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
  if (new Set(identities).size !== identities.length) throw policyError("hr_training_aggregate_feedback_suggestion_duplicate");
  return Object.freeze(suggestions);
}

function normalizeSuggestion(value, context) {
  requireExactObject(value, new Set(["direction", "actionPlan", "scope", "evidenceRefs"]), "hr_training_aggregate_feedback_suggestion_invalid");
  const direction = safeText(value.direction, 400);
  if (!Array.isArray(value.actionPlan) || value.actionPlan.length < 1 || value.actionPlan.length > 4) throw policyError("hr_training_aggregate_feedback_suggestion_invalid");
  const actionPlan = Object.freeze(value.actionPlan.map((item) => safeText(item, 360)));
  if (!SCOPES.has(value.scope) || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1 || value.evidenceRefs.length > 4) {
    throw policyError("hr_training_aggregate_feedback_suggestion_invalid");
  }
  assertNoSourceTextLeakage([direction, ...actionPlan].join("\n"), context);
  const evidenceRefs = value.evidenceRefs.map((item) => normalizeEvidenceRef(item, context));
  if (value.scope === "CONTENT" && evidenceRefs.some((item) => item.type !== "CONTENT")) {
    throw policyError("hr_training_aggregate_feedback_evidence_scope_invalid");
  }
  if (value.scope === "FOLLOWUP" && evidenceRefs.some((item) => item.type !== "FOLLOWUP")) {
    throw policyError("hr_training_aggregate_feedback_evidence_scope_invalid");
  }
  if (value.scope === "CROSS_ROUND" &&
    (!evidenceRefs.some((item) => item.type === "CONTENT") || !evidenceRefs.some((item) => item.type === "FOLLOWUP"))) {
    throw policyError("hr_training_aggregate_feedback_cross_round_evidence_invalid");
  }
  return Object.freeze({ direction, actionPlan, scope: value.scope, evidenceRefs: Object.freeze(evidenceRefs) });
}

function suggestionSchema(scope, context) {
  return {
    type: "object",
    properties: {
      direction: { type: "string", minLength: 1, maxLength: 400 },
      actionPlan: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 360 } },
      scope: { type: "string", enum: [scope] },
      evidenceRefs: evidenceRefsSchema(scope, context),
    },
    required: ["direction", "actionPlan", "scope", "evidenceRefs"], additionalProperties: false,
  };
}

function evidenceRefsSchema(scope, context) {
  const itemSchema = scope === "CROSS_ROUND"
    ? { anyOf: [evidenceRefSchema("CONTENT", context), evidenceRefSchema("FOLLOWUP", context)] }
    : evidenceRefSchema(scope, context);
  return {
    type: "array", minItems: scope === "CROSS_ROUND" ? 2 : 1, maxItems: 4, items: itemSchema,
  };
}

function evidenceRefSchema(type, context) {
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: [type] },
      questionId: type === "CONTENT"
        ? { type: "null" }
        : { type: "string", enum: context.followupEvaluations.map((item) => item.questionId) },
    },
    required: ["type", "questionId"], additionalProperties: false,
  };
}

function normalizeEvidenceRef(value, context) {
  requireExactObject(value, new Set(["type", "questionId"]), "hr_training_aggregate_feedback_evidence_invalid");
  if (!EVIDENCE_TYPES.has(value.type)) throw policyError("hr_training_aggregate_feedback_evidence_invalid");
  if (value.type === "CONTENT") {
    if (value.questionId !== null) throw policyError("hr_training_aggregate_feedback_evidence_invalid");
    return Object.freeze({ type: "CONTENT", questionId: null });
  }
  const questionId = requiredToken(value.questionId, "questionId");
  if (!context.followupEvaluations.some((item) => item.questionId === questionId)) {
    throw policyError("hr_training_aggregate_feedback_evidence_invalid");
  }
  return Object.freeze({ type: "FOLLOWUP", questionId });
}

function rejectScoresOrSensitiveFields(value, depth = 0) {
  if (depth > 20) throw policyError("hr_training_aggregate_feedback_context_invalid");
  if (Array.isArray(value)) return value.forEach((item) => rejectScoresOrSensitiveFields(item, depth + 1));
  if (!isPlainObject(value)) return;
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_FIELD.test(key)) throw policyError("hr_training_aggregate_feedback_context_forbidden_field");
    rejectScoresOrSensitiveFields(item, depth + 1);
  });
}

function projectSafeObject(value, depth = 0) {
  if (depth > 12 || !isPlainObject(value)) throw policyError("hr_training_aggregate_feedback_context_invalid");
  return Object.freeze(Object.fromEntries(Object.entries(value).sort().map(([key, item]) => {
    if (FORBIDDEN_FIELD.test(key)) throw policyError("hr_training_aggregate_feedback_context_forbidden_field");
    if (typeof item === "string") return [key, safeText(item, 2000, { allowEmpty: true })];
    if (Array.isArray(item)) return [key, Object.freeze(item.map((entry) => typeof entry === "string" ? safeText(entry, 800, { allowEmpty: true }) : projectSafeObject(entry, depth + 1)))];
    if (isPlainObject(item)) return [key, projectSafeObject(item, depth + 1)];
    if (item === null || typeof item === "boolean") return [key, item];
    throw policyError("hr_training_aggregate_feedback_context_invalid");
  })));
}

function assertNoSourceTextLeakage(text, context) {
  const sourceTexts = [
    context.material.content,
    ...collectStrings(context.contentEvaluation.feedback),
    ...context.followupEvaluations.flatMap((item) => [
      item.question, item.answer, ...collectStrings(item.feedback), ...collectStrings(item.materialGrounding),
    ]),
  ];
  if (sourceTexts.some((source) => source.length >= 20 && text.includes(source.slice(0, 20)))) {
    throw policyError("hr_training_aggregate_feedback_raw_context_forbidden");
  }
}

function collectStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isPlainObject(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function parseJsonObject(text) { try { const value = isPlainObject(text) ? text : JSON.parse(text); if (!isPlainObject(value)) throw new Error(); return value; } catch { throw policyError("hr_training_aggregate_feedback_result_invalid"); } }
function unwrapContext(value) { return isPlainObject(value?.data) ? value.data : isPlainObject(value?.context) ? value.context : value; }
function requireExactObject(value, fields, code) { if (!isPlainObject(value) || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))) throw policyError(code); }
function requiredToken(value, field) { const text = String(value || "").trim(); if (!TOKEN.test(text) || SECRET_VALUE.test(text)) throw policyError("hr_training_aggregate_feedback_reference_invalid", field); return text; }
function safeText(value, maxLength, { allowEmpty = false } = {}) { const text = String(value ?? "").trim(); if ((!allowEmpty && !text) || text.length > maxLength || SECRET_VALUE.test(text)) throw policyError("hr_training_aggregate_feedback_text_invalid"); return text; }
function requiredReference(value) { const text = String(value || "").trim(); if (!text || text.length > 160 || /[\s\u0000-\u001f\u007f]/.test(text)) throw new TypeError("HR Training aggregate feedback policy reference invalid"); return text; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(deepFreeze); return value; }
function safeIssueCode(error) { return /^[a-z][a-z0-9_]{1,119}$/.test(String(error?.code || "")) ? error.code : "hr_training_aggregate_feedback_result_invalid"; }
function policyError(code, message = code) { const error = new Error(message); error.code = code; return error; }

export {
  CONTEXT_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_CONTEXT_VERSION,
  POLICY_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_OUTPUT_POLICY_VERSION,
  PROMPT_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_PROMPT_VERSION,
  RESULT_KIND as HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_KIND,
  RESULT_VERSION as HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_VERSION,
  createHrTrainingAggregateFeedbackOutputPolicy,
  normalizeAggregateFeedbackContext,
  projectAggregateFeedbackPromptContext,
};
