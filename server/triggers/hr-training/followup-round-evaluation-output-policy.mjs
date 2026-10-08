const POLICY_VERSION = "hr-training-followup-round-evaluation-output-policy.v4";
const CONTEXT_VERSION = "hr-training.followup-round-evaluation-context.v3";
const RESULT_VERSION = "hr-training.followup-round-evaluation-result.v1";
const RESULT_KIND = "FOLLOWUP_ROUND_SCORE";
const PROMPT_VERSION = "hr-training-followup-round-evaluate-v4";
const EXPECTED_DIMENSIONS = Object.freeze([
  Object.freeze({ key: "understanding_accuracy", name: "理解准确度", maxScore: 35 }),
  Object.freeze({ key: "insight_depth", name: "深度与个人见解", maxScore: 25 }),
  Object.freeze({ key: "situational_response", name: "临场应变与未知问题处理", maxScore: 25 }),
  Object.freeze({ key: "business_expression", name: "业务化表达", maxScore: 15 }),
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/\S+/i;

function createHrTrainingFollowupRoundEvaluationOutputPolicy({
  outputPolicyRef,
  promptVersion = PROMPT_VERSION,
} = {}) {
  const exactOutputPolicyRef = requiredReference(
    outputPolicyRef || "output-policy:hr-training-followup-round-evaluation@v4",
  );
  const exactPromptVersion = requiredReference(promptVersion);
  return Object.freeze({
    contractVersion: POLICY_VERSION,
    maxOutputTokens: 2400,
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
      if (taskDefinition?.outputPolicyRef !== exactOutputPolicyRef) {
        throw policyError("hr_training_followup_round_policy_snapshot_mismatch");
      }
      normalizeFollowupRoundEvaluationContext(context, expected);
      return Object.freeze({
        type: "json_schema",
        name: "hr_training_followup_round_evaluation_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contractVersion: { type: "string", enum: [RESULT_VERSION] },
            resultKind: { type: "string", enum: [RESULT_KIND] },
            sessionId: { type: "string", enum: [expected.sessionId] },
            meetingRecordId: { type: "string", enum: [expected.meetingRecordId] },
            status: { type: "string", enum: ["SUCCEEDED"] },
            qaScore: {
              type: "object",
              properties: {
                totalScore: { type: "number", minimum: 0, maximum: 100 },
                maxScore: { type: "number", enum: [100] },
              },
              required: ["totalScore", "maxScore"],
              additionalProperties: false,
            },
            dimensionScores: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: {
                anyOf: EXPECTED_DIMENSIONS.map((item) => ({
                  type: "object",
                  properties: {
                    key: { type: "string", enum: [item.key] },
                    name: { type: "string", enum: [item.name] },
                    score: { type: "number", minimum: 0, maximum: item.maxScore },
                    maxScore: { type: "number", enum: [item.maxScore] },
                    reason: { type: "string", minLength: 1, maxLength: 1200 },
                  },
                  required: ["key", "name", "score", "maxScore", "reason"],
                  additionalProperties: false,
                })),
              },
            },
            feedback: feedbackSchema(),
            modelName: { type: "string", maxLength: 120 },
            promptVersion: { type: "string", enum: [exactPromptVersion] },
          },
          required: [
            "contractVersion", "resultKind", "sessionId", "meetingRecordId", "status",
            "qaScore", "dimensionScores", "feedback", "modelName", "promptVersion",
          ],
          additionalProperties: false,
        },
      });
    },
    normalizeResult({ context, expected, modelName, promptVersion: requestedPromptVersion = exactPromptVersion, text }) {
      normalizeFollowupRoundEvaluationContext(context, expected);
      const value = parseJsonObject(text);
      requireExactObject(value, new Set([
        "contractVersion", "dimensionScores", "feedback", "meetingRecordId", "modelName",
        "promptVersion", "qaScore", "resultKind", "sessionId", "status",
      ]), "hr_training_followup_round_result_invalid");
      if (value.contractVersion !== RESULT_VERSION || value.resultKind !== RESULT_KIND ||
        value.status !== "SUCCEEDED" || value.sessionId !== expected.sessionId ||
        value.meetingRecordId !== expected.meetingRecordId ||
        value.promptVersion !== requestedPromptVersion) {
        throw policyError("hr_training_followup_round_result_invalid");
      }
      const dimensionScores = normalizeDimensionScores(value.dimensionScores);
      const qaScore = normalizeQaScore(value.qaScore, dimensionScores);
      const feedback = normalizeFeedback(value.feedback);
      assertNoContextInconsistency({ dimensionScores, feedback });
      return deepFreeze({
        contractVersion: RESULT_VERSION,
        resultKind: RESULT_KIND,
        sessionId: expected.sessionId,
        meetingRecordId: expected.meetingRecordId,
        status: "SUCCEEDED",
        qaScore,
        dimensionScores,
        feedback,
        modelName: safeText(modelName || value.modelName || "", 120, { allowEmpty: true }),
        promptVersion: requestedPromptVersion,
      });
    },
  });
}

function normalizeFollowupRoundEvaluationContext(value, expected = {}) {
  const context = unwrapContext(value);
  if (!isPlainObject(context) || !Object.hasOwn(context, "expectedQuestionCount") ||
    !Object.hasOwn(context, "expectedQuestionIds")) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  requireExactObject(context, new Set([
    "attempt", "contractVersion", "evaluationMode", "expectedQuestionCount", "expectedQuestionIds",
    "followupEvaluations", "ready", "resultContractVersion", "resultKind", "rubric", "session",
  ]), "hr_training_followup_round_context_invalid");
  if (context.contractVersion !== CONTEXT_VERSION) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  if (context.contractVersion !== CONTEXT_VERSION || context.ready !== true ||
    context.evaluationMode !== "FOLLOWUP_ROUND" || context.resultKind !== RESULT_KIND ||
    context.resultContractVersion !== RESULT_VERSION || context.session?.sessionId !== expected.sessionId ||
    context.attempt?.meetingRecordId !== expected.meetingRecordId) {
    throw policyError("hr_training_followup_round_context_invalid");
  }
  const rubric = normalizeRubric(context.rubric);
  const expectedQuestionIds = normalizeExpectedQuestionIds(context.expectedQuestionIds);
  if (!Number.isInteger(context.expectedQuestionCount) ||
    context.expectedQuestionCount !== expectedQuestionIds.length) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  if (!Array.isArray(context.followupEvaluations)) throw policyError("hr_training_followup_round_context_incomplete");
  const followupEvaluations = context.followupEvaluations.map(normalizeFollowupEvaluation);
  const questionIds = followupEvaluations.map((item) => item.question.questionId);
  const answerIds = followupEvaluations.map((item) => item.answer.answerId);
  if (new Set(questionIds).size !== questionIds.length || new Set(answerIds).size !== answerIds.length) {
    throw policyError("hr_training_followup_round_context_duplicate_reference");
  }
  if (!sameQuestionIdSet(questionIds, expectedQuestionIds)) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  return deepFreeze({
    contractVersion: CONTEXT_VERSION,
    ready: true,
    evaluationMode: "FOLLOWUP_ROUND",
    resultKind: RESULT_KIND,
    resultContractVersion: RESULT_VERSION,
    session: { sessionId: expected.sessionId },
    attempt: { meetingRecordId: expected.meetingRecordId },
    expectedQuestionCount: expectedQuestionIds.length,
    expectedQuestionIds,
    rubric,
    followupEvaluations,
  });
}

function projectFollowupRoundPromptContext(context) {
  return normalizeFollowupRoundEvaluationContext(context, {
    sessionId: context?.session?.sessionId,
    meetingRecordId: context?.attempt?.meetingRecordId,
  });
}

function projectFollowupRoundContextMetadata(context) {
  const normalized = projectFollowupRoundPromptContext(context);
  return deepFreeze({
    expectedQuestionCount: normalized.expectedQuestionCount,
    expectedQuestionIds: [...normalized.expectedQuestionIds],
    receivedQuestionCount: normalized.followupEvaluations.length,
    receivedQuestionIds: normalized.followupEvaluations.map((item) => item.question.questionId),
  });
}

function normalizeRubric(value) {
  requireExactObject(value, new Set([
    "dimensions", "maxScore", "scoringScope", "version", "weightPercent",
  ]), "hr_training_followup_round_rubric_invalid");
  if (number(value.maxScore) !== 100 || number(value.weightPercent) !== 30 ||
    value.scoringScope !== "ALL_FOLLOWUP_ANSWERS" || !Array.isArray(value.dimensions) ||
    value.dimensions.length !== EXPECTED_DIMENSIONS.length) {
    throw policyError("hr_training_followup_round_rubric_invalid");
  }
  const dimensionsByKey = new Map(value.dimensions.map((item) => [item?.key, item]));
  if (dimensionsByKey.size !== EXPECTED_DIMENSIONS.length) {
    throw policyError("hr_training_followup_round_rubric_invalid");
  }
  const dimensions = EXPECTED_DIMENSIONS.map((expected) => {
    const item = dimensionsByKey.get(expected.key);
    if (!isPlainObject(item) || item.name !== expected.name || number(item.maxScore) !== expected.maxScore) {
      throw policyError("hr_training_followup_round_rubric_invalid");
    }
    requireExactObject(item, new Set([
      "key", "maxScore", "name", "scoringDetailMarkdown",
    ]), "hr_training_followup_round_rubric_invalid");
    return Object.freeze({
      key: expected.key,
      name: expected.name,
      maxScore: expected.maxScore,
      scoringDetailMarkdown: safeText(item.scoringDetailMarkdown, 12000),
    });
  });
  return Object.freeze({
    version: safeText(value.version, 80),
    maxScore: 100,
    weightPercent: 30,
    scoringScope: "ALL_FOLLOWUP_ANSWERS",
    dimensions: Object.freeze(dimensions),
  });
}

function normalizeFollowupEvaluation(value) {
  requireExactObject(value, new Set([
    "answer", "perQuestionFeedback", "question",
  ]), "hr_training_followup_round_context_invalid");
  if (!isPlainObject(value.question) || !isPlainObject(value.answer) ||
    !isPlainObject(value.perQuestionFeedback)) {
    throw policyError("hr_training_followup_round_context_invalid");
  }
  return Object.freeze({
    question: Object.freeze({
      questionId: requiredToken(value.question.questionId, "questionId"),
      text: safeText(value.question.text, 1600),
      evaluationFocus: normalizeStringList(value.question.evaluationFocus || [], 12, 300, { allowEmpty: true }),
      reason: safeText(value.question.reason || "", 1000, { allowEmpty: true }),
    }),
    answer: Object.freeze({
      answerId: requiredToken(value.answer.answerId, "answerId"),
      text: safeText(value.answer.text, 12000),
    }),
    perQuestionFeedback: projectSafeObject(value.perQuestionFeedback),
  });
}

function normalizeExpectedQuestionIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  const questionIds = value.map((item) => requiredToken(item, "expectedQuestionIds"));
  if (new Set(questionIds).size !== questionIds.length) {
    throw policyError("hr_training_followup_round_context_incomplete");
  }
  return Object.freeze(questionIds);
}

function sameQuestionIdSet(received, expected) {
  return received.length === expected.length && received.every((item) => expected.includes(item));
}

function normalizeDimensionScores(value) {
  if (!Array.isArray(value) || value.length !== EXPECTED_DIMENSIONS.length) {
    throw policyError("hr_training_followup_round_dimension_scores_invalid");
  }
  const byKey = new Map(value.map((item) => [item?.key, item]));
  if (byKey.size !== EXPECTED_DIMENSIONS.length) {
    throw policyError("hr_training_followup_round_dimension_scores_invalid");
  }
  return Object.freeze(EXPECTED_DIMENSIONS.map((expected) => {
    const item = byKey.get(expected.key);
    requireExactObject(item, new Set([
      "key", "maxScore", "name", "reason", "score",
    ]), "hr_training_followup_round_dimension_scores_invalid");
    const score = number(item.score);
    if (item.name !== expected.name || number(item.maxScore) !== expected.maxScore ||
      score < 0 || score > expected.maxScore) {
      throw policyError("hr_training_followup_round_dimension_scores_invalid");
    }
    return Object.freeze({
      key: expected.key,
      name: expected.name,
      score,
      maxScore: expected.maxScore,
      reason: safeText(item.reason, 1200),
    });
  }));
}

function normalizeQaScore(value, dimensionScores) {
  requireExactObject(value, new Set(["maxScore", "totalScore"]), "hr_training_followup_round_score_invalid");
  const totalScore = number(value.totalScore);
  const dimensionTotal = dimensionScores.reduce((sum, item) => sum + item.score, 0);
  if (number(value.maxScore) !== 100 || totalScore < 0 || totalScore > 100 ||
    Math.abs(totalScore - dimensionTotal) > 0.01) {
    throw policyError("hr_training_followup_round_score_invalid");
  }
  return Object.freeze({ totalScore, maxScore: 100 });
}

function normalizeFeedback(value) {
  requireExactObject(value, new Set([
    "gaps", "strengths", "suggestions", "summary",
  ]), "hr_training_followup_round_feedback_invalid");
  return Object.freeze({
    summary: safeText(value.summary, 1200),
    strengths: normalizeStringList(value.strengths, 8, 600, { allowEmpty: true }),
    gaps: normalizeStringList(value.gaps, 8, 600, { allowEmpty: true }),
    suggestions: normalizeStringList(value.suggestions, 8, 600, { allowEmpty: true }),
  });
}

function assertNoContextInconsistency({ dimensionScores, feedback }) {
  const evidenceText = [
    ...dimensionScores.map((item) => item.reason),
    feedback.summary,
    ...feedback.strengths,
    ...feedback.gaps,
    ...feedback.suggestions,
  ].join("\n");
  if (/(?:仅|只|仅仅)\s*(?:看见|看到|提供|有|见)\s*(?:q\s*1|第\s*1\s*题)|\b(?:only|just)\s+q\s*1\b|(?:缺少|缺失|没有|未提供|missing|absent)\s*(?:q\s*[2-9]|第\s*[2-9]\s*题)|(?:上下文|题答|回答|context|answers?)\s*(?:不完整|不全|截断|缺失|incomplete|partial|truncated)/i.test(evidenceText)) {
    throw policyError("hr_training_followup_round_context_inconsistent");
  }
}

function feedbackSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 1200 },
      strengths: stringArraySchema(),
      gaps: stringArraySchema(),
      suggestions: stringArraySchema(),
    },
    required: ["summary", "strengths", "gaps", "suggestions"],
    additionalProperties: false,
  };
}

function stringArraySchema() {
  return { type: "array", minItems: 0, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 600 } };
}

function projectSafeObject(value, depth = 0) {
  if (!isPlainObject(value) || depth > 10) throw policyError("hr_training_followup_round_context_invalid");
  return Object.freeze(Object.fromEntries(Object.entries(value).sort().map(([key, item]) => {
    if (!TOKEN.test(key)) throw policyError("hr_training_followup_round_context_invalid");
    if (typeof item === "string") return [key, safeText(item, 2000, { allowEmpty: true })];
    if (Array.isArray(item)) return [key, Object.freeze(item.map((entry) =>
      typeof entry === "string" ? safeText(entry, 800, { allowEmpty: true }) : projectSafeObject(entry, depth + 1)))];
    if (isPlainObject(item)) return [key, projectSafeObject(item, depth + 1)];
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return [key, item];
    throw policyError("hr_training_followup_round_context_invalid");
  })));
}

function normalizeStringList(value, maxItems, maxLength, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) {
    throw policyError("hr_training_followup_round_string_list_invalid");
  }
  return Object.freeze(value.map((item) => safeText(item, maxLength)));
}

function parseJsonObject(text) {
  try {
    const value = isPlainObject(text) ? text : JSON.parse(text);
    if (!isPlainObject(value)) throw new Error("not object");
    return value;
  } catch {
    throw policyError("hr_training_followup_round_result_invalid");
  }
}
function unwrapContext(value) { return isPlainObject(value?.data) ? value.data : isPlainObject(value?.context) ? value.context : value; }
function requireExactObject(value, fields, code) { if (!isPlainObject(value) || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))) throw policyError(code); }
function requiredToken(value, field) { const text = String(value || "").trim(); if (!TOKEN.test(text) || SECRET_VALUE.test(text)) throw policyError("hr_training_followup_round_reference_invalid", field); return text; }
function safeText(value, maxLength, { allowEmpty = false } = {}) { const text = String(value ?? "").trim(); if ((!allowEmpty && !text) || text.length > maxLength || SECRET_VALUE.test(text)) throw policyError("hr_training_followup_round_text_invalid"); return text; }
function requiredReference(value) { const text = String(value || "").trim(); if (!text || text.length > 180 || /[\s\u0000-\u001f\u007f]/.test(text)) throw new TypeError("HR Training followup round policy reference invalid"); return text; }
function number(value) { const result = Number(value); if (!Number.isFinite(result)) throw policyError("hr_training_followup_round_number_invalid"); return result; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(deepFreeze); return value; }
function safeIssueCode(error) { return /^[a-z][a-z0-9_]{1,119}$/.test(String(error?.code || "")) ? error.code : "hr_training_followup_round_result_invalid"; }
function policyError(code, message = code) { const error = new Error(message); error.code = code; return error; }

export {
  CONTEXT_VERSION as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_CONTEXT_VERSION,
  POLICY_VERSION as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_OUTPUT_POLICY_VERSION,
  PROMPT_VERSION as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_PROMPT_VERSION,
  RESULT_KIND as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_KIND,
  RESULT_VERSION as HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_VERSION,
  createHrTrainingFollowupRoundEvaluationOutputPolicy,
  normalizeFollowupRoundEvaluationContext,
  projectFollowupRoundContextMetadata,
  projectFollowupRoundPromptContext,
};
