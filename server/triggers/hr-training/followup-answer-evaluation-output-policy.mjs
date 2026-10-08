import { normalizeLockedMaterial } from "./locked-material-coverage.mjs";

const POLICY_VERSION = "hr-training-followup-answer-evaluation-output-policy.v3";
const RESULT_VERSION = "hr-training.followup-answer-evaluation-result.v3";
const PROMPT_VERSION = "hr-training-followup-answer-evaluate-v3";
const CONTEXT_VERSION = "hr-training.followup-answer-evaluation-context.v1";
const COMPAT_CONTEXT_VERSION = "hr-training.evaluation-context.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/\S+/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const FORBIDDEN_RESULT_FIELDS = new Set([
  "contentScore",
  "firstQuestion",
  "nextQuestion",
  "officialScore",
  "questionScore",
  "questions",
  "runId",
]);

function createHrTrainingFollowupAnswerEvaluationOutputPolicy({
  outputPolicyRef,
  promptVersion = PROMPT_VERSION,
} = {}) {
  const exactOutputPolicyRef = requiredReference(outputPolicyRef || "output-policy:hr-training-followup-answer-evaluation@v3");
  const exactPromptVersion = requiredReference(promptVersion);

  function assertTaskPolicy(taskDefinition) {
    if (taskDefinition?.outputPolicyRef !== exactOutputPolicyRef) {
      throw policyError("hr_training_followup_answer_policy_snapshot_mismatch");
    }
  }

  return Object.freeze({
    contractVersion: POLICY_VERSION,
    maxOutputTokens: 1800,
    promptVersion: exactPromptVersion,
    candidateIssues({ context, expected, text }) {
      const issues = [];
      let value;
      try {
        value = parseJsonObject(text);
      } catch {
        return Object.freeze(["invalid_json"]);
      }
      if (hasForbiddenResultField(value)) issues.push("forbidden_result_field");
      try {
        normalizeResult({ context, expected, modelName: "", promptVersion: exactPromptVersion, text });
      } catch (error) {
        issues.push(safeIssueCode(error));
      }
      return Object.freeze([...new Set(issues)].slice(0, 8));
    },
    outputFormat({ context, expected, taskDefinition }) {
      assertTaskPolicy(taskDefinition);
      normalizeFollowupAnswerEvaluationContext(context, expected);
      return Object.freeze({
        type: "json_schema",
        name: "hr_training_followup_answer_evaluation_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contractVersion: { type: "string", enum: [RESULT_VERSION] },
            sessionId: { type: "string", enum: [expected.sessionId] },
            meetingRecordId: { type: "string", enum: [expected.meetingRecordId] },
            questionId: { type: "string", enum: [expected.questionId] },
            answerId: { type: "string", enum: [expected.answerId] },
            status: { type: "string", enum: ["SUCCEEDED"] },
            feedback: feedbackSchema(),
            modelName: { type: "string", maxLength: 120 },
            promptVersion: { type: "string", enum: [exactPromptVersion] },
          },
          required: [
            "contractVersion",
            "sessionId",
            "meetingRecordId",
            "questionId",
            "answerId",
            "status",
            "feedback",
            "modelName",
            "promptVersion",
          ],
          additionalProperties: false,
        },
      });
    },
    normalizeResult({ context, expected, modelName, promptVersion: requestedPromptVersion = exactPromptVersion, text }) {
      normalizeFollowupAnswerEvaluationContext(context, expected);
      const value = parseJsonObject(text);
      if (hasForbiddenResultField(value)) throw policyError("hr_training_followup_answer_forbidden_result_field");
      requireExactObject(value, new Set([
        "answerId",
        "contractVersion",
        "feedback",
        "meetingRecordId",
        "modelName",
        "promptVersion",
        "questionId",
        "sessionId",
        "status",
      ]), "hr_training_followup_answer_result_invalid");
      if (value.contractVersion !== RESULT_VERSION || value.status !== "SUCCEEDED" ||
        value.sessionId !== expected.sessionId || value.meetingRecordId !== expected.meetingRecordId ||
        value.questionId !== expected.questionId || value.answerId !== expected.answerId ||
        value.promptVersion !== requestedPromptVersion) {
        throw policyError("hr_training_followup_answer_result_invalid");
      }
      return deepFreeze({
        contractVersion: RESULT_VERSION,
        sessionId: expected.sessionId,
        meetingRecordId: expected.meetingRecordId,
        questionId: expected.questionId,
        answerId: expected.answerId,
        status: "SUCCEEDED",
        feedback: normalizeFeedback(value.feedback),
        modelName: boundedSafeText(modelName || value.modelName || "", 120, { allowEmpty: true }),
        promptVersion: requestedPromptVersion,
      });
    },
    normalizeStoredResult({ result }) {
      if (!isPlainObject(result) || result.contractVersion !== RESULT_VERSION ||
        !["FAILED", "SUCCEEDED"].includes(result.status) ||
        !result.questionId || !result.answerId) {
        throw policyError("hr_training_followup_answer_stored_result_invalid");
      }
      return deepFreeze(result);
    },
  });
}

function normalizeFollowupAnswerEvaluationContext(value, expected = {}) {
  const context = unwrapContext(value);
  if (!isPlainObject(context)) throw policyError("hr_training_followup_answer_context_invalid");
  if (![CONTEXT_VERSION, COMPAT_CONTEXT_VERSION].includes(context.contractVersion)) {
    throw policyError("hr_training_followup_answer_context_contract_invalid");
  }
  if (context.ready !== true) throw policyError("hr_training_evaluation_context_not_ready");
  if (context.session?.sessionId !== expected.sessionId) {
    throw policyError("hr_training_followup_answer_context_session_mismatch");
  }
  if (context.attempt?.meetingRecordId !== expected.meetingRecordId) {
    throw policyError("hr_training_followup_answer_context_attempt_mismatch");
  }
  const material = normalizeLockedMaterial(context.material, { codePrefix: "hr_training_followup_answer_context" });
  if (!context.rubric || typeof context.rubric !== "object") {
    throw policyError("hr_training_followup_answer_context_rubric_missing");
  }
  if (context.qaPolicy === undefined) {
    throw policyError("hr_training_followup_answer_context_qa_policy_missing");
  }
  if (context.contractVersion === COMPAT_CONTEXT_VERSION &&
    String(context.evaluationMode || "").trim() !== "FOLLOWUP_ANSWER") {
    throw policyError("hr_training_followup_answer_context_mode_invalid");
  }
  const followupAnswer = isPlainObject(context.followupAnswer) ? context.followupAnswer : null;
  const currentQuestion = normalizeQuestion(context.currentQuestion || context.question ||
    context.followupQuestion || followupAnswer);
  const currentAnswer = normalizeAnswer(context.currentAnswer || context.answer || context.followupAnswer);
  if (currentQuestion.questionId !== expected.questionId || currentAnswer.answerId !== expected.answerId) {
    throw policyError("hr_training_followup_answer_context_identity_mismatch");
  }
  return deepFreeze({
    ...context,
    material,
    currentQuestion,
    currentAnswer,
  });
}

function projectFollowupAnswerPromptContext(context) {
  const evaluationContext = normalizeFollowupAnswerEvaluationContext(context, {
    sessionId: context.session?.sessionId,
    meetingRecordId: context.attempt?.meetingRecordId,
    questionId: context.currentQuestion?.questionId || context.question?.questionId || context.followupQuestion?.questionId,
    answerId: context.currentAnswer?.answerId || context.answer?.answerId || context.followupAnswer?.answerId,
  });
  return deepFreeze({
    contractVersion: evaluationContext.contractVersion,
    ready: evaluationContext.ready,
    session: {
      sessionId: evaluationContext.session.sessionId,
      assessmentId: safeProjectionText(evaluationContext.session.assessmentId),
      topicId: safeProjectionText(evaluationContext.session.topicId),
      materialVersionId: safeProjectionText(evaluationContext.session.materialVersionId),
      rubricVersionId: safeProjectionText(evaluationContext.session.rubricVersionId),
    },
    attempt: {
      meetingRecordId: evaluationContext.attempt.meetingRecordId,
      submittedAt: safeProjectionText(evaluationContext.attempt.submittedAt),
    },
    evaluationMode: evaluationContext.evaluationMode || "FOLLOWUP_ANSWER",
    followupAnswer: {
      questionId: evaluationContext.currentQuestion.questionId,
      question: evaluationContext.currentQuestion.text,
      answerId: evaluationContext.currentAnswer.answerId,
      answer: evaluationContext.currentAnswer.content,
    },
    currentQuestion: evaluationContext.currentQuestion,
    currentAnswer: evaluationContext.currentAnswer,
    material: projectMaterial(evaluationContext.material),
    rubric: projectRubric(evaluationContext.rubric),
    qaPolicy: evaluationContext.qaPolicy,
  });
}

function normalizeQuestion(value) {
  if (!isPlainObject(value)) throw policyError("hr_training_followup_answer_question_invalid");
  const questionId = requiredToken(value.questionId || value.id, "questionId", 160);
  const text = value.text || (isPlainObject(value.question) ? value.question.text : value.question) || value.prompt;
  return Object.freeze({
    questionId,
    text: boundedSafeText(text, 1200),
    evaluationFocus: normalizeStringList(value.evaluationFocus || value.focus || [], 10, 160, { allowEmpty: true }),
    reason: safeProjectionText(value.reason, 800),
  });
}

function normalizeAnswer(value) {
  if (!isPlainObject(value)) throw policyError("hr_training_followup_answer_answer_invalid");
  return Object.freeze({
    answerId: requiredToken(value.answerId || value.id, "answerId", 160),
    content: boundedSafeText(value.content || value.text || value.answer, 4000),
    submittedAt: safeProjectionText(value.submittedAt, 120),
  });
}

function normalizeFeedback(value) {
  requireExactObject(value, new Set(["gaps", "materialGrounding", "strengths", "suggestions", "summary"]),
    "hr_training_followup_answer_feedback_invalid");
  return Object.freeze({
    summary: boundedSafeText(value.summary, 800),
    strengths: normalizeStringList(value.strengths, 8, 500, { allowEmpty: true }),
    gaps: normalizeStringList(value.gaps, 8, 500, { allowEmpty: true }),
    suggestions: normalizeStringList(value.suggestions, 8, 500, { allowEmpty: true }),
    materialGrounding: normalizeMaterialGrounding(value.materialGrounding),
  });
}

function projectMaterial(value) {
  return {
    materialVersionId: safeProjectionText(value.materialVersionId, 160),
    title: safeProjectionText(value.title, 240),
    content: value.content,
    contentCoverage: value.contentCoverage,
    coreConcepts: normalizeStringList(value.coreConcepts || value.keyPoints || [], 24, 160, { allowEmpty: true }),
  };
}

function normalizeMaterialGrounding(value) {
  requireExactObject(value, new Set(["coveredPoints", "howToSupplement", "pendingOrCalibrationPoints"]),
    "hr_training_followup_answer_material_grounding_invalid");
  return Object.freeze({
    coveredPoints: normalizeStringList(value.coveredPoints, 8, 500, { allowEmpty: true }),
    pendingOrCalibrationPoints: normalizeStringList(value.pendingOrCalibrationPoints, 8, 500, { allowEmpty: true }),
    howToSupplement: normalizeStringList(value.howToSupplement, 8, 500, { allowEmpty: true }),
  });
}

function projectRubric(value) {
  const rubricMarkdown = safeProjectionText(value.rubricMarkdown || value.markdown, 12000);
  const sourceLength = String(value.rubricMarkdown || value.markdown || "").trim().length;
  return {
    rubricVersionId: safeProjectionText(value.rubricVersionId, 160),
    rubricMarkdown,
    coverage: {
      sourceLength,
      includedLength: rubricMarkdown.length,
      truncated: sourceLength > rubricMarkdown.length,
    },
    answerEvaluationRules: value.answerEvaluationRules || value.followupAnswerRules || value.questionRules || [],
  };
}

function feedbackSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 800 },
      strengths: stringArraySchema(),
      gaps: stringArraySchema(),
      suggestions: stringArraySchema(),
      materialGrounding: {
        type: "object",
        properties: {
          coveredPoints: stringArraySchema(),
          pendingOrCalibrationPoints: stringArraySchema(),
          howToSupplement: stringArraySchema(),
        },
        required: ["coveredPoints", "pendingOrCalibrationPoints", "howToSupplement"],
        additionalProperties: false,
      },
    },
    required: ["summary", "strengths", "gaps", "suggestions", "materialGrounding"],
    additionalProperties: false,
  };
}

function stringArraySchema({ maxItems = 8, maxLength = 500 } = {}) {
  return {
    type: "array",
    minItems: 0,
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

function normalizeStringList(value, maxItems, maxLength, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw policyError("hr_training_followup_answer_string_list_invalid");
  if (!allowEmpty && value.length === 0) throw policyError("hr_training_followup_answer_string_list_invalid");
  if (value.length > maxItems) throw policyError("hr_training_followup_answer_string_list_invalid");
  return Object.freeze(value.map((item) => boundedSafeText(item, maxLength)));
}

function parseJsonObject(text) {
  if (isPlainObject(text)) return text;
  if (typeof text !== "string" || !text.trim()) throw policyError("hr_training_followup_answer_result_invalid");
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) throw new Error("not object");
    return value;
  } catch {
    throw policyError("hr_training_followup_answer_result_invalid");
  }
}

function hasForbiddenResultField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenResultField);
  return Object.keys(value).some((field) => FORBIDDEN_RESULT_FIELDS.has(field) ||
    hasForbiddenResultField(value[field]));
}

function unwrapContext(value) {
  if (isPlainObject(value?.data)) return value.data;
  if (isPlainObject(value?.context)) return value.context;
  return value;
}

function boundedSafeText(value, maxLength, { allowEmpty = false } = {}) {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || text.length > maxLength || SECRET_VALUE.test(text)) {
    throw policyError("hr_training_followup_answer_text_invalid");
  }
  return text;
}

function safeProjectionText(value, maxLength = 1000) {
  const text = String(value ?? "").trim();
  if (!text || SECRET_VALUE.test(text)) return "";
  return text.slice(0, maxLength);
}

function requiredReference(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 160 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError("HR Training followup answer policy reference invalid");
  }
  return text;
}

function requiredToken(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !TOKEN.test(text) || SECRET_VALUE.test(text)) {
    throw policyError("hr_training_followup_answer_reference_invalid", field);
  }
  return text;
}

function requireExactObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw policyError(code);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function safeIssueCode(error) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : "hr_training_followup_answer_model_output_invalid";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function policyError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  CONTEXT_VERSION as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_CONTEXT_VERSION,
  POLICY_VERSION as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_OUTPUT_POLICY_VERSION,
  PROMPT_VERSION as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_PROMPT_VERSION,
  RESULT_VERSION as HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_VERSION,
  createHrTrainingFollowupAnswerEvaluationOutputPolicy,
  normalizeFollowupAnswerEvaluationContext,
  projectFollowupAnswerPromptContext,
};
