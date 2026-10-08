import { normalizeLockedMaterial } from "./locked-material-coverage.mjs";

const POLICY_VERSION = "hr-training-content-evaluation-output-policy.v5";
const RESULT_VERSION = "hr-training.content-evaluation-result.v1";
const PROMPT_VERSION = "hr-training-content-evaluate-v5";
const CONTEXT_VERSION = "hr-training.evaluation-context.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIMENSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SECRET_VALUE = /(?:bearer\s+|sk-|rk-|xox[baprs]-|gh[pousr]_|glpat-|ya29\.|eyJ)[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const DEFAULT_QUESTION_PLAN = Object.freeze({
  countPolicy: Object.freeze({ mode: "RANGE", min: 3, max: 5 }),
  sourcePriority: Object.freeze(["recommendedDirections", "materialMarkdown", "defaultQuestionTypes"]),
});
const MAX_QUESTION_COUNT = 10;
const FROZEN_QUESTION_COUNT = 5;
const QUESTION_TEXT_CONTRACT_VERSION = "hr-training.question-text-contract.v1";
// Compatibility owner: HR Train ↔ Digital Workforce Center 集成.
// Remove this absent-field fallback once every active HR evaluation context sends
// hr-training.question-text-contract.v1.
const LEGACY_QUESTION_TEXT_CONTRACT = Object.freeze({
  contractVersion: QUESTION_TEXT_CONTRACT_VERSION,
  minCharacters: 0,
  requireStandaloneQuestion: false,
});
const FROZEN_BASE_QUESTION_IDS = new Set(["Q1", "Q2", "Q3", "Q4", "Q6"]);
const TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE = "TRANSCRIPT_ADAPTIVE";
const REQUIRED_CONTEXT_FIELDS = new Set([
  "assessment",
  "attempt",
  "contractVersion",
  "material",
  "qaPolicy",
  "ready",
  "rubric",
  "session",
  "transcript",
]);

function createHrTrainingContentEvaluationOutputPolicy({
  outputPolicyRef,
  promptVersion = PROMPT_VERSION,
} = {}) {
  const exactOutputPolicyRef = requiredReference(outputPolicyRef || "output-policy:hr-training-content-evaluation@v5");
  const exactPromptVersion = requiredReference(promptVersion);

  function assertTaskPolicy(taskDefinition) {
    if (taskDefinition?.outputPolicyRef !== exactOutputPolicyRef) {
      const error = new Error("hr_training_content_evaluation_policy_snapshot_mismatch");
      error.code = "hr_training_content_evaluation_policy_snapshot_mismatch";
      throw error;
    }
  }

  return Object.freeze({
    contractVersion: POLICY_VERSION,
    maxOutputTokens: 4200,
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
      const evaluationContext = normalizeEvaluationContext(context, expected);
      const dimensions = normalizeRubricDimensions(evaluationContext.rubric.evaluationDimensions);
      const questionPlan = resolveQuestionPlan(evaluationContext);
      const dimensionMaxScores = [...new Set(dimensions.map((item) => item.maxScore))];
      return Object.freeze({
        type: "json_schema",
        name: "hr_training_content_evaluation_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contractVersion: { type: "string", enum: [RESULT_VERSION] },
            runId: expected.runId ? { type: "string", enum: [expected.runId] } : { type: "string" },
            sessionId: { type: "string", enum: [expected.sessionId] },
            meetingRecordId: { type: "string", enum: [expected.meetingRecordId] },
            status: { type: "string", enum: ["SUCCEEDED"] },
            contentScore: {
              type: "object",
              properties: {
                totalScore: { type: "number", minimum: 0 },
                maxScore: { type: "number", enum: [sumMaxScore(dimensions)] },
                dimensionScores: {
                  type: "array",
                  minItems: dimensions.length,
                  maxItems: dimensions.length,
                  items: {
                    type: "object",
                    properties: {
                      key: {
                        type: "string",
                        enum: dimensions.map((item) => item.key),
                        description: "Use each current rubric key exactly once, paired with its matching name and maxScore.",
                      },
                      name: {
                        type: "string",
                        enum: dimensions.map((item) => item.name),
                        description: "Must be the exact name paired with key in the current rubric.",
                      },
                      score: { type: "number", minimum: 0 },
                      maxScore: {
                        type: "number",
                        enum: dimensionMaxScores,
                        description: "Must be the exact maxScore paired with key and name in the current rubric.",
                      },
                      reason: { type: "string", minLength: 1, maxLength: 1200 },
                      evidence: {
                        type: "array",
                        maxItems: 6,
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string", enum: ["TRANSCRIPT_SNIPPET"] },
                            text: {
                              type: "string",
                              minLength: 1,
                              maxLength: 240,
                              description: "A contiguous, verbatim excerpt copied from transcript.content; do not paraphrase, combine excerpts, or alter punctuation.",
                            },
                          },
                          required: ["type", "text"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["key", "name", "score", "maxScore", "reason", "evidence"],
                    additionalProperties: false,
                  },
                },
                appliedRules: {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    properties: {
                      ruleId: { type: "string", minLength: 1, maxLength: 120 },
                      effect: { type: "string", minLength: 1, maxLength: 80 },
                      reason: { type: "string", minLength: 1, maxLength: 500 },
                    },
                    required: ["ruleId", "effect", "reason"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["totalScore", "maxScore", "dimensionScores", "appliedRules"],
              additionalProperties: false,
            },
            feedback: {
              type: "object",
              properties: {
                strengths: stringArraySchema(),
                issues: stringArraySchema(),
                suggestions: stringArraySchema(),
              },
              required: ["strengths", "issues", "suggestions"],
              additionalProperties: false,
            },
            questions: {
              type: "array",
              minItems: questionPlan.countPolicy.min,
              maxItems: questionPlan.countPolicy.max,
              items: {
                type: "object",
                properties: {
                  questionId: { type: "string", enum: questionIdsForPlan(questionPlan) },
                  text: {
                    type: "string",
                    minLength: questionPlan.questionTextContract.minCharacters,
                    maxLength: 600,
                  },
                  evaluationFocus: stringArraySchema({ minItems: 1, maxItems: 6, maxLength: 120 }),
                  reason: { type: "string", minLength: 1, maxLength: 600 },
                  ...(questionPlan.questionGenerationMode === "FROZEN_SELECTED" ||
                    questionPlan.questionGenerationMode === TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE ? {
                    sourceQuestionId: { type: "string", pattern: "^Q[1-9][0-9]?$" },
                    questionType: { type: "string", minLength: 1, maxLength: 80 },
                    required: { type: "boolean" },
                  } : {}),
                },
                required: questionPlan.questionGenerationMode === "FROZEN_SELECTED" ||
                  questionPlan.questionGenerationMode === TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE
                  ? ["questionId", "sourceQuestionId", "text", "questionType", "required", "evaluationFocus", "reason"]
                  : ["questionId", "text", "evaluationFocus", "reason"],
                additionalProperties: false,
              },
            },
            modelName: { type: "string", maxLength: 120 },
            promptVersion: { type: "string", enum: [exactPromptVersion] },
          },
          required: [
            "contractVersion",
            "runId",
            "sessionId",
            "meetingRecordId",
            "status",
            "contentScore",
            "feedback",
            "questions",
            "modelName",
            "promptVersion",
          ],
          additionalProperties: false,
        },
      });
    },
    normalizeResult({ context, expected, modelName, promptVersion: requestedPromptVersion = exactPromptVersion, text }) {
      const evaluationContext = normalizeEvaluationContext(context, expected);
      const dimensions = normalizeRubricDimensions(evaluationContext.rubric.evaluationDimensions);
      const value = parseJsonObject(text);
      if (hasForbiddenResultField(value)) throw policyError("hr_training_content_evaluation_forbidden_result_field");
      const requiredFields = new Set([
        "contentScore",
        "contractVersion",
        "feedback",
        "meetingRecordId",
        "modelName",
        "promptVersion",
        "questions",
        "runId",
        "sessionId",
        "status",
      ]);
      requireExactObject(value, requiredFields, "hr_training_content_evaluation_result_invalid");
      if (value.contractVersion !== RESULT_VERSION || value.status !== "SUCCEEDED" ||
        value.sessionId !== expected.sessionId || value.meetingRecordId !== expected.meetingRecordId ||
        (expected.runId && value.runId !== expected.runId) ||
        value.promptVersion !== requestedPromptVersion) {
        throw policyError("hr_training_content_evaluation_result_invalid");
      }
      const contentScore = normalizeContentScore(value.contentScore, dimensions, evaluationContext);
      const feedback = normalizeFeedback(value.feedback);
      const questions = normalizeQuestions(value.questions, resolveQuestionPlan(evaluationContext), evaluationContext);
      return deepFreeze({
        contractVersion: RESULT_VERSION,
        runId: requiredResultRunId(value.runId),
        sessionId: expected.sessionId,
        meetingRecordId: expected.meetingRecordId,
        status: "SUCCEEDED",
        contentScore,
        feedback,
        questions,
        modelName: boundedSafeText(modelName || value.modelName || "", 120, { allowEmpty: true }),
        promptVersion: requestedPromptVersion,
      });
    },
    normalizeStoredResult({ result }) {
      if (!isPlainObject(result) || result.contractVersion !== RESULT_VERSION ||
        result.status !== "SUCCEEDED" || !Array.isArray(result.questions) ||
        !validQuestionCountForStoredResult(result.questions.length)) {
        throw policyError("hr_training_content_evaluation_stored_result_invalid");
      }
      return deepFreeze(result);
    },
  });
}

function normalizeEvaluationContext(value, expected = {}) {
  const context = unwrapContext(value);
  requireAtLeastObject(context, REQUIRED_CONTEXT_FIELDS, "hr_training_evaluation_context_invalid");
  if (context.contractVersion !== CONTEXT_VERSION) {
    throw policyError("hr_training_evaluation_context_contract_invalid");
  }
  if (context.ready !== true) throw policyError("hr_training_evaluation_context_not_ready");
  if (context.session?.sessionId !== expected.sessionId) {
    throw policyError("hr_training_evaluation_context_session_mismatch");
  }
  if (context.attempt?.meetingRecordId !== expected.meetingRecordId) {
    throw policyError("hr_training_evaluation_context_attempt_mismatch");
  }
  if (typeof context.transcript?.content !== "string" || !context.transcript.content.trim()) {
    throw policyError("hr_training_evaluation_context_transcript_missing");
  }
  const material = normalizeLockedMaterial(context.material, { codePrefix: "hr_training_evaluation_context" });
  if (!context.rubric || typeof context.rubric !== "object" ||
    typeof context.rubric.rubricMarkdown !== "string" || !context.rubric.rubricMarkdown.trim() ||
    !Array.isArray(context.rubric.evaluationDimensions) ||
    context.rubric.durationContentRules === undefined ||
    context.rubric.promptHints === undefined) {
    throw policyError("hr_training_evaluation_context_rubric_invalid");
  }
  if (context.qaPolicy === undefined) throw policyError("hr_training_evaluation_context_qa_policy_missing");
  if (!context.assessment || context.assessment.assessmentAdvice === undefined) {
    throw policyError("hr_training_evaluation_context_assessment_missing");
  }
  normalizeRubricDimensions(context.rubric.evaluationDimensions);
  resolveQuestionPlan(context);
  return deepFreeze({ ...context, material });
}

function normalizeContentScore(value, dimensions, context) {
  requireExactObject(value, new Set(["appliedRules", "dimensionScores", "maxScore", "totalScore"]),
    "hr_training_content_score_invalid");
  if (roundScore(value.maxScore) !== sumMaxScore(dimensions)) {
    throw policyError("hr_training_content_score_max_mismatch");
  }
  if (!Array.isArray(value.dimensionScores) || value.dimensionScores.length !== dimensions.length) {
    throw policyError("hr_training_content_score_dimensions_mismatch");
  }
  const seen = new Set();
  const byKey = new Map(dimensions.map((item) => [item.key, item]));
  const dimensionScores = value.dimensionScores.map((item) => {
    requireExactObject(item, new Set(["evidence", "key", "maxScore", "name", "reason", "score"]),
      "hr_training_dimension_score_invalid");
    const dimension = byKey.get(String(item.key || ""));
    if (!dimension || seen.has(dimension.key) || item.name !== dimension.name ||
      roundScore(item.maxScore) !== dimension.maxScore) {
      throw policyError("hr_training_content_score_dimensions_mismatch");
    }
    seen.add(dimension.key);
    const score = roundScore(item.score);
    if (score < 0 || score > dimension.maxScore) {
      throw policyError("hr_training_dimension_score_range_invalid");
    }
    return Object.freeze({
      key: dimension.key,
      name: dimension.name,
      score,
      maxScore: dimension.maxScore,
      reason: boundedSafeText(item.reason, 1200),
      evidence: normalizeEvidence(item.evidence, context),
    });
  });
  if (seen.size !== dimensions.length) throw policyError("hr_training_content_score_dimensions_mismatch");
  const appliedRules = normalizeAppliedRules(value.appliedRules);
  const scored = applyConfiguredRules({
    appliedRules,
    context,
    dimensionScores,
    maxScore: sumMaxScore(dimensions),
    totalScore: roundScore(value.totalScore),
  });
  const recomputedTotal = roundScore(scored.dimensionScores.reduce((sum, item) => sum + item.score, 0));
  const totalScore = Math.min(scored.totalScore, recomputedTotal, scored.maxScore);
  if (Math.abs(totalScore - scored.totalScore) > 0.01) {
    scored.appliedRules.push(Object.freeze({
      ruleId: "system_total_score_adjusted_to_dimension_sum",
      effect: "TOTAL_SCORE_ADJUSTED",
      reason: "总分已按维度得分合计进行一致性修正。",
    }));
  }
  return deepFreeze({
    totalScore,
    maxScore: scored.maxScore,
    dimensionScores: scored.dimensionScores,
    appliedRules: dedupeAppliedRules(scored.appliedRules),
  });
}

function applyConfiguredRules({ appliedRules, context, dimensionScores, maxScore, totalScore }) {
  let scores = dimensionScores.map((item) => ({ ...item }));
  let currentTotal = Math.min(roundScore(totalScore), maxScore);
  const rules = normalizeDurationContentRules(context.rubric.durationContentRules);
  const metrics = contentMetrics(context);
  const triggered = [...appliedRules];
  for (const rule of rules) {
    if (!ruleApplies(rule, metrics)) continue;
    if (rule.warningOnly) {
      triggered.push(appliedRuleForConfiguredRule({
        effect: "WARNING_ONLY",
        reason: `触发 ${rule.label || rule.ruleId}，仅记录提示，不调整内容演示得分。`,
        rule,
      }));
      continue;
    }
    if (rule.noCap) {
      triggered.push(appliedRuleForConfiguredRule({
        effect: "NO_CAP",
        reason: `触发 ${rule.label || rule.ruleId}，不设置内容演示封顶。`,
        rule,
      }));
      continue;
    }
    if (rule.zeroScore) {
      scores = scores.map((item) => ({ ...item, score: 0 }));
      currentTotal = 0;
      triggered.push(appliedRuleForConfiguredRule({
        effect: "ZERO_CONTENT_SCORE",
        reason: `触发 ${rule.label || rule.ruleId}，内容演示得分置为 0。`,
        rule,
      }));
      continue;
    }
    if (typeof rule.capScore === "number" && currentTotal > rule.capScore) {
      const cap = Math.max(0, Math.min(rule.capScore, maxScore));
      scores = scaleDimensionScores(scores, cap);
      currentTotal = roundScore(Math.min(currentTotal, cap));
      triggered.push(appliedRuleForConfiguredRule({
        effect: "CAP_CONTENT_SCORE",
        reason: `触发 ${rule.label || rule.ruleId}，内容演示总分封顶 ${cap} 分。`,
        rule,
      }));
    }
    if (typeof rule.deductScore === "number" && rule.deductScore > 0) {
      const next = Math.max(0, currentTotal - rule.deductScore);
      scores = scaleDimensionScores(scores, next);
      currentTotal = roundScore(next);
      triggered.push(appliedRuleForConfiguredRule({
        effect: "DEDUCT_CONTENT_SCORE",
        reason: `触发 ${rule.label || rule.ruleId}，内容演示总分扣减 ${roundScore(rule.deductScore)} 分。`,
        rule,
      }));
    }
  }
  return {
    totalScore: roundScore(currentTotal),
    maxScore,
    dimensionScores: scores.map((item) => Object.freeze({
      ...item,
      score: Math.max(0, Math.min(roundScore(item.score), item.maxScore)),
    })),
    appliedRules: normalizeAppliedRules(triggered),
  };
}

function normalizeDurationContentRules(value) {
  const source = Array.isArray(value) ? value
    : Array.isArray(value?.rules) ? value.rules
      : Array.isArray(value?.durationContentRules) ? value.durationContentRules
        : typeof value === "string" ? parseTextRules(value)
          : isPlainObject(value) ? [value]
            : [];
  return source.map((item, index) => normalizeRule(item, index)).filter(Boolean);
}

function normalizeRule(value, index) {
  if (typeof value === "string") return normalizeRule({ ruleId: `text_rule_${index + 1}`, description: value }, index);
  if (!isPlainObject(value)) return null;
  const ruleId = safeRuleId(value.ruleId || value.id || value.key || `rule_${index + 1}`);
  const durationText = String(value.durationText || value.condition || "").trim();
  const impactText = String(value.impact || "").trim();
  const description = [
    value.description || value.text || value.message || "",
    durationText,
    impactText,
  ].map((item) => String(item || "").trim()).filter(Boolean).join("；");
  const effect = normalizeRuleEffect(value.effect || value.action || value.scoreAction || impactText);
  const minDurationSeconds = firstNumber([
    value.minDurationSeconds,
    value.minimumDurationSeconds,
    value.durationMinSeconds,
    secondsFromMinutes(value.minDurationMinutes ?? value.minimumDurationMinutes ?? value.durationMinMinutes),
    secondsFromMilliseconds(value.minDurationMs ?? value.minimumDurationMs ?? value.durationMinMs),
  ]);
  const maxDurationSecondsExclusive = firstNumber([
    value.maxDurationSecondsExclusive,
    value.maximumDurationSecondsExclusive,
    value.durationMaxSecondsExclusive,
    secondsFromMinutes(value.maxDurationMinutesExclusive ?? value.maximumDurationMinutesExclusive ?? value.durationMaxMinutesExclusive),
    secondsFromMilliseconds(value.maxDurationMsExclusive ?? value.maximumDurationMsExclusive ?? value.durationMaxMsExclusive),
  ]);
  const maxDurationSecondsInclusive = firstNumber([
    value.maxDurationSecondsInclusive,
    value.maximumDurationSecondsInclusive,
    value.durationMaxSecondsInclusive,
    value.maxDurationSeconds,
    value.maximumDurationSeconds,
    value.durationMaxSeconds,
    secondsFromMinutes(value.maxDurationMinutesInclusive ?? value.maximumDurationMinutesInclusive ?? value.durationMaxMinutesInclusive),
    secondsFromMinutes(value.maxDurationMinutes ?? value.maximumDurationMinutes ?? value.durationMaxMinutes),
    secondsFromMilliseconds(value.maxDurationMsInclusive ?? value.maximumDurationMsInclusive ?? value.durationMaxMsInclusive),
    secondsFromMilliseconds(value.maxDurationMs ?? value.maximumDurationMs ?? value.durationMaxMs),
  ]);
  const minWordCount = firstNumber([
    value.minWordCount,
    value.minimumWordCount,
    value.minWords,
    value.wordCountMin,
    value.minContentWords,
  ]);
  const maxWordCountExclusive = firstNumber([
    value.maxWordCountExclusive,
    value.maximumWordCountExclusive,
    value.maxWordsExclusive,
    value.wordCountMaxExclusive,
    value.maxContentWordsExclusive,
  ]);
  const maxWordCountInclusive = firstNumber([
    value.maxWordCountInclusive,
    value.maximumWordCountInclusive,
    value.maxWordCount,
    value.maximumWordCount,
    value.maxWords,
    value.wordCountMax,
    value.maxContentWords,
  ]);
  const minCharacterCount = firstNumber([
    value.minCharacterCount,
    value.minimumCharacterCount,
    value.minChars,
    value.characterCountMin,
    value.minContentChars,
  ]);
  const maxCharacterCountExclusive = firstNumber([
    value.maxCharacterCountExclusive,
    value.maximumCharacterCountExclusive,
    value.maxCharsExclusive,
    value.characterCountMaxExclusive,
    value.maxContentCharsExclusive,
  ]);
  const maxCharacterCountInclusive = firstNumber([
    value.maxCharacterCountInclusive,
    value.maximumCharacterCountInclusive,
    value.maxCharacterCount,
    value.maximumCharacterCount,
    value.maxChars,
    value.characterCountMax,
    value.maxContentChars,
  ]);
  const capScore = firstNumber([
    value.capScore,
    value.maxTotalScore,
    value.maximumTotalScore,
    value.scoreCap,
    value.maxScoreWhenViolated,
    value.scoreCapWhenViolated,
  ]);
  const deductScore = firstNumber([value.deductScore, value.penaltyScore, value.scoreDeduction]);
  const warningOnly = ["warning_only", "warning"].includes(effect);
  const noCap = ["no_cap", "none"].includes(effect);
  const zeroScore = value.zeroScore === true || value.noScore === true ||
    ["zero", "zero_score", "zero_content_score", "no_score", "不得分"].includes(effect) ||
    zeroScoreFromText(description);
  const parsedCap = noCap || warningOnly ? null : capScore ?? capFromText(description);
  const parsedZero = zeroScore || zeroScoreFromText(description);
  const structuredDurationRange = rangeFromBounds({
    min: minDurationSeconds,
    maxExclusive: maxDurationSecondsExclusive,
    maxInclusive: maxDurationSecondsInclusive,
  });
  const structuredWordRange = rangeFromBounds({
    min: minWordCount,
    maxExclusive: maxWordCountExclusive,
    maxInclusive: maxWordCountInclusive,
  });
  const structuredCharacterRange = rangeFromBounds({
    min: minCharacterCount,
    maxExclusive: maxCharacterCountExclusive,
    maxInclusive: maxCharacterCountInclusive,
  });
  const parsedDuration = structuredDurationRange ? null : minDurationSeconds ?? durationSecondsFromText(description);
  const parsedWords = structuredWordRange ? null : minWordCount ?? wordCountFromText(description);
  const parsedChars = structuredCharacterRange ? null : minCharacterCount ?? charCountFromText(description);
  const durationRange = structuredDurationRange || rangeFromText(durationText || description, ["分钟", "min"], 60);
  const wordRange = structuredWordRange || rangeFromText(durationText || description, ["词", "单词", "words?"], 1);
  const characterRange = structuredCharacterRange || rangeFromText(durationText || description, ["字", "字符", "chars?"], 1);
  if (![parsedDuration, parsedWords, parsedChars].some((item) => typeof item === "number") &&
    !durationRange && !characterRange &&
    !wordRange && !parsedZero && !warningOnly && !noCap &&
    typeof parsedCap !== "number" && typeof deductScore !== "number") {
    return null;
  }
  return Object.freeze({
    ruleId,
    label: boundedSafeText(value.label || value.name || durationText || ruleId, 120),
    durationRange,
    wordRange,
    characterRange,
    minDurationSeconds: parsedDuration,
    minWordCount: parsedWords,
    minCharacterCount: parsedChars,
    zeroScore: parsedZero,
    capScore: parsedCap,
    deductScore,
    warningOnly,
    noCap,
  });
}

function parseTextRules(value) {
  return String(value || "").split(/\n|；|;/).map((item) => item.trim()).filter(Boolean);
}

function ruleApplies(rule, metrics) {
  const rangeChecks = [];
  if (rule.durationRange) rangeChecks.push(rangeContains(rule.durationRange, metrics.durationSeconds));
  if (rule.wordRange) rangeChecks.push(rangeContains(rule.wordRange, metrics.wordCount));
  if (rule.characterRange) rangeChecks.push(rangeContains(rule.characterRange, metrics.characterCount));
  if (rangeChecks.length) return rangeChecks.every(Boolean);
  const checks = [];
  if (typeof rule.minDurationSeconds === "number") checks.push(metrics.durationSeconds < rule.minDurationSeconds);
  if (typeof rule.minWordCount === "number") checks.push(metrics.wordCount < rule.minWordCount);
  if (typeof rule.minCharacterCount === "number") checks.push(metrics.characterCount < rule.minCharacterCount);
  return checks.length ? checks.some(Boolean) : false;
}

function contentMetrics(context) {
  const content = String(context.transcript?.content || "");
  return {
    durationSeconds: firstNumber([
      context.transcript?.durationSeconds,
      context.transcript?.duration,
      context.attempt?.durationSeconds,
      context.session?.durationSeconds,
    ]) ?? durationSecondsFromAttempt(context.attempt) ?? 0,
    wordCount: firstNumber([
      context.transcript?.wordCount,
      context.transcript?.words,
      context.attempt?.wordCount,
    ]) ?? estimateWordCount(content),
    characterCount: firstNumber([
      context.transcript?.characterCount,
      context.transcript?.charCount,
      context.attempt?.characterCount,
    ]) ?? content.replace(/\s/g, "").length,
  };
}

function scaleDimensionScores(scores, targetTotal) {
  const current = scores.reduce((sum, item) => sum + item.score, 0);
  if (current <= 0 || targetTotal <= 0) {
    return scores.map((item) => ({ ...item, score: 0 }));
  }
  const ratio = targetTotal / current;
  let scaled = scores.map((item) => ({
    ...item,
    score: Math.min(item.maxScore, roundScore(item.score * ratio)),
  }));
  let drift = roundScore(targetTotal - scaled.reduce((sum, item) => sum + item.score, 0));
  for (const item of scaled) {
    if (Math.abs(drift) < 0.01) break;
    const room = drift > 0 ? item.maxScore - item.score : item.score;
    const delta = Math.sign(drift) * Math.min(Math.abs(drift), room);
    item.score = roundScore(item.score + delta);
    drift = roundScore(targetTotal - scaled.reduce((sum, candidate) => sum + candidate.score, 0));
  }
  return scaled;
}

function normalizeRubricDimensions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw policyError("hr_training_rubric_dimensions_invalid");
  }
  const contentDimensions = value.filter((item) => String(item?.section || "").trim() === "CONTENT_DEMO");
  const source = contentDimensions.length ? contentDimensions : value;
  const seen = new Set();
  return Object.freeze(source.map((item, index) => {
    if (!isPlainObject(item)) throw policyError("hr_training_rubric_dimensions_invalid");
    const key = String(item.key || item.dimensionKey || item.id || item.code || `content_${index + 1}`).trim();
    const name = boundedSafeText(item.name || item.dimensionName || item.title, 160);
    const maxScore = roundScore(item.maxScore ?? item.max ?? item.points ?? item.score);
    if (!DIMENSION_KEY.test(key) || seen.has(key) || !(maxScore > 0)) {
      throw policyError("hr_training_rubric_dimensions_invalid");
    }
    seen.add(key);
    return Object.freeze({ key, name, maxScore });
  }));
}

function normalizeFeedback(value) {
  requireExactObject(value, new Set(["issues", "strengths", "suggestions"]),
    "hr_training_feedback_invalid");
  return Object.freeze({
    strengths: normalizeStringList(value.strengths, 12, 500),
    issues: normalizeStringList(value.issues, 12, 500),
    suggestions: normalizeStringList(value.suggestions, 12, 500),
  });
}

function normalizeQuestions(value, questionPlan = DEFAULT_QUESTION_PLAN, context = {}) {
  const countPolicy = questionPlan.countPolicy || DEFAULT_QUESTION_PLAN.countPolicy;
  if (!Array.isArray(value) || value.length < countPolicy.min || value.length > countPolicy.max) {
    throw policyError("hr_training_question_count_invalid");
  }
  const seen = new Set();
  const selectedQuestions = Array.isArray(questionPlan.selectedQuestions) ? questionPlan.selectedQuestions : [];
  return Object.freeze(value.map((item, index) => {
    const frozen = selectedQuestions.length > 0;
    const adaptive = questionPlan.questionGenerationMode === TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE;
    requireExactObject(item, frozen
      ? new Set(["evaluationFocus", "questionId", "questionType", "reason", "required", "sourceQuestionId", "text"])
      : new Set(["evaluationFocus", "questionId", "reason", "text"]), "hr_training_question_fields_invalid");
    const questionId = String(item.questionId || "").trim();
    if (questionId !== `q${index + 1}` || seen.has(questionId)) {
      throw policyError("hr_training_question_id_invalid");
    }
    seen.add(questionId);
    const text = normalizeQuestionText(item.text, questionPlan.questionTextContract);
    const evaluationFocus = normalizeQuestionFocus(item.evaluationFocus);
    const reason = normalizeQuestionReason(item.reason);
    const q5Constraint = questionPlan.q5Constraint;
    if (adaptive && index === selectedQuestions.length - 1 && q5Constraint?.prohibitedElements?.some((term) =>
      text.toLowerCase().includes(String(term).toLowerCase()))) {
      throw policyError("hr_training_adaptive_q5_constraint_violation");
    }
    if (adaptive && [text, ...evaluationFocus, reason].some((candidate) =>
      transcriptEchoesQuestion(candidate, context.transcript?.content))) {
      throw policyError("hr_training_adaptive_question_transcript_echo");
    }
    if (frozen && (item.sourceQuestionId !== selectedQuestions[index]?.sourceQuestionId ||
      (!adaptive && text !== selectedQuestions[index]?.text) ||
      item.questionType !== selectedQuestions[index]?.questionType ||
      item.required !== selectedQuestions[index]?.required)) {
      throw policyError("hr_training_selected_question_text_mismatch");
    }
    return Object.freeze({
      questionId,
      text,
      evaluationFocus,
      reason,
      ...(frozen ? {
        sourceQuestionId: selectedQuestions[index].sourceQuestionId,
        questionType: selectedQuestions[index].questionType,
        required: selectedQuestions[index].required,
      } : {}),
    });
  }));
}

function projectQuestionPlanningContext(context) {
  const plan = resolveQuestionPlan(context);
  return deepFreeze({
    countPolicy: plan.countPolicy,
    recommendedCount: plan.recommendedCount,
    sourcePriority: plan.sourcePriority,
    questionTextContract: plan.questionTextContract,
    recommendedDirections: plan.recommendedDirections,
    selectedQuestions: plan.selectedQuestions,
    ...(plan.q5Constraint ? { q5Constraint: plan.q5Constraint } : {}),
    questionGenerationMode: plan.questionGenerationMode,
    implementationRules: plan.implementationRules,
    materialSemanticHints: materialSemanticHints(context.material),
    defaultQuestionTypes: [
      "缺失概念确认",
      "核心概念关系解释",
      "材料到工作场景迁移",
      "讲解结构补全",
      "风险误解澄清",
    ],
  });
}

function transcriptEchoesQuestion(question, transcript) {
  const candidate = String(question || "").replace(/\s+/g, "");
  const source = String(transcript || "").replace(/\s+/g, "");
  if (candidate.length < 24 || source.length < 24) return false;
  for (let index = 0; index <= candidate.length - 24; index += 1) {
    if (source.includes(candidate.slice(index, index + 24))) return true;
  }
  return false;
}

function resolveQuestionPlan(context) {
  const source = isPlainObject(context?.qaPolicy?.questionPlan) ? context.qaPolicy.questionPlan : null;
  const questionTextContract = normalizeQuestionTextContract(source?.questionTextContract);
  const requestedCountPolicy = source ? normalizeQuestionCountPolicy(source.countPolicy) : DEFAULT_QUESTION_PLAN.countPolicy;
  const adaptive = source?.mode === TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE;
  const selectedQuestions = adaptive
    ? normalizeAdaptiveSelectedQuestions(source)
    : normalizeSelectedQuestions(source?.selectedQuestions, requestedCountPolicy, {
      dynamicQuestionRequired: source?.dynamicQuestion?.required === true,
      questionTextContract,
    });
  const countPolicy = selectedQuestions.length
    ? Object.freeze({ mode: "EXACT", min: FROZEN_QUESTION_COUNT, max: FROZEN_QUESTION_COUNT })
    : requestedCountPolicy;
  const recommendedCount = selectedQuestions.length ? FROZEN_QUESTION_COUNT : recommendedQuestionCount(source, countPolicy);
  return deepFreeze({
    countPolicy,
    recommendedCount,
    sourcePriority: normalizeSourcePriority(),
    questionTextContract,
    recommendedDirections: normalizeRecommendedDirections(source?.recommendedDirections),
    selectedQuestions,
    implementationRules: normalizeQuestionImplementationRules(source?.implementationRules),
    questionGenerationMode: adaptive
      ? TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE
      : selectedQuestions.length ? "FROZEN_SELECTED" : "MATERIAL_DERIVED",
    ...(adaptive ? { q5Constraint: normalizeQ5Constraint(source.q5Constraint) } : {}),
  });
}

function normalizeAdaptiveSelectedQuestions(source) {
  if (!Array.isArray(source?.selectedQuestions) || source.selectedQuestions.length !== FROZEN_QUESTION_COUNT) {
    throw policyError("hr_training_adaptive_selected_questions_invalid");
  }
  const sourceIds = new Set();
  const selected = source.selectedQuestions.map((item) => {
    requireAllowedObject(item, new Set([
      "evaluationIntent", "questionTemplate", "questionType", "required", "sourceQuestionId",
    ]), "hr_training_adaptive_selected_questions_invalid");
    const sourceQuestionId = String(item.sourceQuestionId || "").trim();
    if (!/^Q[1-9][0-9]?$/.test(sourceQuestionId) || sourceIds.has(sourceQuestionId)) {
      throw policyError("hr_training_adaptive_selected_questions_invalid");
    }
    const evaluationIntent = boundedSafeText(item.evaluationIntent, 500);
    const questionTemplate = boundedSafeText(item.questionTemplate, 600);
    const questionType = boundedSafeText(item.questionType, 80);
    if (!evaluationIntent || !questionTemplate || !questionType || typeof item.required !== "boolean") {
      throw policyError("hr_training_adaptive_selected_questions_invalid");
    }
    sourceIds.add(sourceQuestionId);
    return Object.freeze({ sourceQuestionId, evaluationIntent, questionTemplate, questionType, required: item.required });
  });
  const base = selected.slice(0, -1);
  const dynamic = selected.at(-1);
  if (base.some((item) => !FROZEN_BASE_QUESTION_IDS.has(item.sourceQuestionId)) ||
    dynamic.sourceQuestionId !== "Q5" || dynamic.required !== true) {
    throw policyError("hr_training_adaptive_selected_question_order_invalid");
  }
  return Object.freeze(selected);
}

function normalizeQ5Constraint(value) {
  requireAllowedObject(value, new Set(["scenarioId", "promptTemplate", "requiredElements", "prohibitedElements"]),
    "hr_training_q5_constraint_invalid");
  const scenarioId = boundedSafeText(value.scenarioId, 120);
  const promptTemplate = boundedSafeText(value.promptTemplate, 800);
  if (!scenarioId || !promptTemplate) throw policyError("hr_training_q5_constraint_invalid");
  return Object.freeze({
    scenarioId,
    promptTemplate,
    requiredElements: normalizeStringList(value.requiredElements, 12, 240, { minItems: 1 }),
    prohibitedElements: normalizeStringList(value.prohibitedElements, 12, 240),
  });
}

function normalizeSelectedQuestions(value, countPolicy, {
  dynamicQuestionRequired = false,
  questionTextContract = LEGACY_QUESTION_TEXT_CONTRACT,
} = {}) {
  if (value === undefined || value === null) {
    if (dynamicQuestionRequired) throw policyError("hr_training_selected_questions_missing");
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length !== FROZEN_QUESTION_COUNT) {
    throw policyError("hr_training_selected_questions_invalid");
  }
  const sourceIds = new Set();
  const texts = new Set();
  const selected = value.map((item) => {
    requireAllowedObject(item, new Set([
      "questionType", "required", "sourceQuestionId", "text",
    ]), "hr_training_selected_questions_invalid");
    const sourceQuestionId = String(item?.sourceQuestionId || "").trim();
    if (!/^Q[1-9][0-9]?$/.test(sourceQuestionId) || sourceIds.has(sourceQuestionId)) {
      throw policyError("hr_training_selected_questions_invalid");
    }
    const text = normalizeQuestionText(item.text, questionTextContract);
    if (texts.has(text) || /\[\s*BU[^\]]*\]|\bBU\s*[1-9][0-9]*\b/i.test(text)) {
      throw policyError("hr_training_selected_questions_invalid");
    }
    const questionType = String(item?.questionType || "").trim();
    if (!questionType || questionType.length > 80) {
      throw policyError("hr_training_selected_questions_invalid");
    }
    if (typeof item.required !== "boolean") {
      throw policyError("hr_training_selected_questions_invalid");
    }
    sourceIds.add(sourceQuestionId);
    texts.add(text);
    return Object.freeze({ sourceQuestionId, text, questionType, required: item.required });
  });
  const base = selected.slice(0, -1);
  const dynamic = selected[selected.length - 1];
  if (base.length !== 4 || base.some((item) => !FROZEN_BASE_QUESTION_IDS.has(item.sourceQuestionId)) ||
    new Set(base.map((item) => item.sourceQuestionId)).size !== 4 ||
    dynamic.sourceQuestionId !== "Q5" || dynamic.required !== true) {
    throw policyError("hr_training_selected_dynamic_question_invalid");
  }
  return Object.freeze(selected);
}

function normalizeQuestionImplementationRules(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 20) {
    throw policyError("hr_training_question_plan_invalid");
  }
  return Object.freeze(value.map((item) => boundedSafeText(item, 800)));
}

function normalizeQuestionCountPolicy(value) {
  if (!isPlainObject(value)) return DEFAULT_QUESTION_PLAN.countPolicy;
  const mode = String(value.mode || value.type || value.policy || "").trim().toUpperCase();
  if (mode === "EXACT") {
    const count = boundedQuestionCount(value.count ?? value.exact ?? value.value);
    return Object.freeze({ mode: "EXACT", min: count, max: count });
  }
  if (mode === "RANGE") {
    const min = boundedQuestionCount(value.min ?? value.minimum ?? value.minCount);
    const max = boundedQuestionCount(value.max ?? value.maximum ?? value.maxCount);
    if (min > max) throw policyError("hr_training_question_plan_count_invalid");
    return Object.freeze({ mode: "RANGE", min, max });
  }
  if (mode === "AUTO") {
    const fallback = DEFAULT_QUESTION_PLAN.countPolicy;
    const min = boundedQuestionCount(value.min ?? value.minimum ?? value.minCount ?? fallback.min);
    const max = boundedQuestionCount(value.max ?? value.maximum ?? value.maxCount ?? fallback.max);
    if (min > max) throw policyError("hr_training_question_plan_count_invalid");
    return Object.freeze({ mode: "AUTO", min, max });
  }
  return DEFAULT_QUESTION_PLAN.countPolicy;
}

function recommendedQuestionCount(source, countPolicy) {
  const count = firstNumber([source?.recommendedCount, source?.targetCount, source?.preferredCount]);
  if (count === null) return null;
  const rounded = Math.round(count);
  if (rounded < countPolicy.min || rounded > countPolicy.max) {
    throw policyError("hr_training_question_plan_count_invalid");
  }
  return rounded;
}

function normalizeSourcePriority() {
  return DEFAULT_QUESTION_PLAN.sourcePriority;
}

function normalizeRecommendedDirections(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 12) throw policyError("hr_training_question_plan_invalid");
  return Object.freeze(value.map(normalizeRecommendedDirection));
}

function normalizeRecommendedDirection(value) {
  if (!isPlainObject(value)) throw policyError("hr_training_question_plan_invalid");
  requireAllowedObject(value, new Set(["direction", "id", "required", "sourceHeading"]),
    "hr_training_question_plan_invalid");
  const result = {
    id: safeQuestionDirectionId(value.id),
    direction: boundedSafeText(value.direction, 500),
    required: value.required === true,
  };
  if (value.sourceHeading !== undefined && value.sourceHeading !== null) {
    result.sourceHeading = boundedSafeText(value.sourceHeading, 160);
  }
  return Object.freeze(result);
}

function materialSemanticHints(material) {
  const markdown = String(material?.content || "").trim();
  const explicitConcepts = []
    .concat(Array.isArray(material?.coreConcepts) ? material.coreConcepts : [])
    .concat(Array.isArray(material?.keyConcepts) ? material.keyConcepts : [])
    .concat(Array.isArray(material?.keyPoints) ? material.keyPoints : [])
    .map((item) => String(item || ""));
  return Object.freeze({
    title: material?.title ? boundedSafeText(String(material.title), 160, { allowEmpty: true }) : "",
    headings: markdownHeadings(markdown),
    coreConcepts: normalizeStringList([...new Set(explicitConcepts)], 16, 120),
  });
}

function markdownHeadings(value) {
  const headings = String(value || "").split(/\r?\n/)
    .map((line) => /^(#{1,4})\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => boundedSafeText(match[2].replace(/#+\s*$/, ""), 160))
    .slice(0, 16);
  return Object.freeze([...new Set(headings)]);
}

function boundedQuestionCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_QUESTION_COUNT) {
    throw policyError("hr_training_question_plan_count_invalid");
  }
  return count;
}

function normalizeQuestionTextContract(value) {
  if (value === undefined || value === null) return LEGACY_QUESTION_TEXT_CONTRACT;
  requireExactObject(value, new Set([
    "contractVersion", "minCharacters", "requireStandaloneQuestion",
  ]), "hr_training_question_text_contract_invalid");
  const minCharacters = Number(value.minCharacters);
  if (value.contractVersion !== QUESTION_TEXT_CONTRACT_VERSION ||
    !Number.isInteger(minCharacters) || minCharacters < 0 || minCharacters > 600 ||
    typeof value.requireStandaloneQuestion !== "boolean") {
    throw policyError("hr_training_question_text_contract_invalid");
  }
  return Object.freeze({
    contractVersion: QUESTION_TEXT_CONTRACT_VERSION,
    minCharacters,
    requireStandaloneQuestion: value.requireStandaloneQuestion,
  });
}

function normalizeQuestionText(value, questionTextContract = LEGACY_QUESTION_TEXT_CONTRACT) {
  let text;
  try {
    text = boundedSafeText(value, 600);
  } catch {
    throw policyError("hr_training_question_text_invalid");
  }
  if (text.length < questionTextContract.minCharacters) {
    throw policyError("hr_training_question_text_invalid");
  }
  if (questionTextContract.requireStandaloneQuestion && !(/[?？]/.test(text) ||
    /^(请|如何|怎样|为什么|什么|哪些|是否|能否|说明|描述|举例|比较|解释|what\b|how\b|why\b|which\b|can\b|could\b|describe\b|explain\b|compare\b)/i.test(text))) {
    throw policyError("hr_training_question_not_standalone");
  }
  return text;
}

function normalizeQuestionFocus(value) {
  try {
    return normalizeStringList(value, 6, 120, { minItems: 1 });
  } catch {
    throw policyError("hr_training_question_focus_invalid");
  }
}

function normalizeQuestionReason(value) {
  try {
    return boundedSafeText(value, 600);
  } catch {
    throw policyError("hr_training_question_reason_invalid");
  }
}

function questionIdsForPlan(questionPlan) {
  const countPolicy = questionPlan?.countPolicy || DEFAULT_QUESTION_PLAN.countPolicy;
  return Array.from({ length: countPolicy.max }, (_, index) => `q${index + 1}`);
}

function safeQuestionDirectionId(value) {
  const id = String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80);
  return DIMENSION_KEY.test(id) ? id : "direction";
}

function validQuestionCountForStoredResult(count) {
  return Number.isInteger(count) && count >= 1 && count <= MAX_QUESTION_COUNT;
}

function normalizeAppliedRules(value) {
  if (!Array.isArray(value) || value.length > 12) throw policyError("hr_training_applied_rules_invalid");
  return Object.freeze(value.map((item, index) => normalizeAppliedRule(item, index)).filter(Boolean));
}

function normalizeEvidence(value, context) {
  // HR decision: evidence is optional traceability context, never a scoring gate.
  // Do not restore transcript substring/continuous-verbatim validation here.
  // Equivalent wording and paraphrases are explicitly valid for HR scoring.
  if (!Array.isArray(value) || value.length > 6) {
    throw policyError("hr_training_evidence_invalid");
  }
  const evidence = value.map(normalizeEvidenceItem).filter(Boolean);
  return Object.freeze(evidence);
}

function normalizeEvidenceItem(value) {
  if (typeof value === "string") {
    return Object.freeze({
      type: "TRANSCRIPT_SNIPPET",
      text: boundedSafeText(value, 240),
    });
  }
  const fields = new Set(["endOffsetSeconds", "speaker", "startOffsetSeconds", "text", "type"]);
  requireAllowedObject(value, fields, "hr_training_evidence_invalid");
  if (value.type !== "TRANSCRIPT_SNIPPET") throw policyError("hr_training_evidence_invalid");
  const result = {
    type: "TRANSCRIPT_SNIPPET",
    text: boundedSafeText(value.text, 240),
  };
  if (value.speaker !== undefined && value.speaker !== null) {
    const speaker = boundedSafeText(value.speaker, 120, { allowEmpty: true });
    if (speaker) result.speaker = speaker;
  }
  const start = optionalNonNegativeNumber(value.startOffsetSeconds, "hr_training_evidence_invalid");
  const end = optionalNonNegativeNumber(value.endOffsetSeconds, "hr_training_evidence_invalid");
  if (start !== null) result.startOffsetSeconds = start;
  if (end !== null) result.endOffsetSeconds = end;
  if (start !== null && end !== null && end < start) throw policyError("hr_training_evidence_invalid");
  return Object.freeze(result);
}

function normalizeAppliedRule(value, index) {
  if (typeof value === "string") {
    const reason = boundedSafeText(value, 240);
    return Object.freeze({
      ruleId: safeRuleId(reason.split(":")[0]) || `model_rule_${index + 1}`,
      effect: effectFromAppliedRuleText(reason),
      reason,
    });
  }
  requireAllowedObject(value, new Set(["effect", "reason", "ruleId"]), "hr_training_applied_rule_invalid");
  const ruleId = safeRuleId(value.ruleId || `model_rule_${index + 1}`);
  return Object.freeze({
    ruleId,
    effect: normalizePublicRuleEffect(value.effect, "RULE_APPLIED"),
    reason: boundedSafeText(value.reason, 500),
  });
}

function appliedRuleForConfiguredRule({ effect, reason, rule }) {
  return Object.freeze({
    ruleId: safeRuleId(rule.ruleId || rule.label || "duration_content_rule"),
    effect,
    reason: boundedSafeText(reason, 500),
  });
}

function dedupeAppliedRules(value) {
  const seen = new Set();
  const result = [];
  for (const item of normalizeAppliedRules(value)) {
    const key = `${item.ruleId}:${item.effect}:${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 12) break;
  }
  return Object.freeze(result);
}

function effectFromAppliedRuleText(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("zero")) return "ZERO_CONTENT_SCORE";
  if (text.includes("cap")) return "CAP_CONTENT_SCORE";
  if (text.includes("deduct")) return "DEDUCT_CONTENT_SCORE";
  if (text.includes("warning")) return "WARNING_ONLY";
  if (text.includes("no_cap")) return "NO_CAP";
  return "RULE_APPLIED";
}

function normalizePublicRuleEffect(value, fallback) {
  const text = String(value || "").trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s:-]+/g, "_")
    .toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(text) ? text : fallback;
}

function optionalNonNegativeNumber(value, code) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw policyError(code);
  return roundScore(number);
}

function normalizeStringList(value, maximum, maxLength, { allowEmpty = true, minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && !value.length) || value.length < minItems) {
    throw policyError("hr_training_string_list_invalid");
  }
  const result = value.map((item) => boundedSafeText(item, maxLength)).filter(Boolean);
  if (result.length < minItems) throw policyError("hr_training_string_list_invalid");
  return Object.freeze(result);
}

function parseJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw policyError("hr_training_content_evaluation_result_invalid");
  const cleaned = source.startsWith("```")
    ? source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    : source;
  const value = JSON.parse(cleaned);
  if (!isPlainObject(value)) throw policyError("hr_training_content_evaluation_result_invalid");
  return value;
}

function hasForbiddenResultField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenResultField);
  return Object.keys(value).some((key) => key === "officialScore" || key === "firstQuestion" ||
    hasForbiddenResultField(value[key]));
}

function unwrapContext(value) {
  if (isPlainObject(value) && value.contractVersion === CONTEXT_VERSION) return value;
  if (isPlainObject(value) && isPlainObject(value.data) && value.data.contractVersion === CONTEXT_VERSION) {
    return value.data;
  }
  return value;
}

function sumMaxScore(dimensions) {
  return roundScore(dimensions.reduce((sum, item) => sum + item.maxScore, 0));
}

function roundScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw policyError("hr_training_score_invalid");
  return Math.round(number * 100) / 100;
}

function boundedSafeText(value, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw policyError("hr_training_text_invalid");
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) || SECRET_VALUE.test(text)) {
    throw policyError("hr_training_text_invalid");
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

function requireAllowedObject(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).some((field) => !fields.has(field))) {
    throw policyError(code);
  }
}

function requireAtLeastObject(value, fields, code) {
  if (!isPlainObject(value) || [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw policyError(code);
  }
}

function stringArraySchema({ minItems = 0, maxItems = 12, maxLength = 500 } = {}) {
  return {
    type: "array",
    minItems,
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

function requiredResultRunId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128 ||
    /[\u0000-\u001F\u007F]/.test(value) || SECRET_VALUE.test(value)) {
    throw policyError("hr_training_run_id_invalid");
  }
  return value.trim();
}

function requiredReference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("HR Training output policy reference invalid");
  }
  return value;
}

function safeRuleId(value) {
  const id = String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80);
  return DIMENSION_KEY.test(id) ? id : "rule";
}

function firstNumber(values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.round(number * 100) / 100;
  }
  return null;
}

function secondsFromMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number * 60 : null;
}

function secondsFromMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 1000 : null;
}

function durationSecondsFromText(value) {
  const match = String(value || "").match(/(?:少于|低于|不足|小于)\s*(\d+(?:\.\d+)?)\s*(分钟|min|秒|s)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return /分钟|min/i.test(match[2]) ? amount * 60 : amount;
}

function durationSecondsFromAttempt(value = {}) {
  const start = Date.parse(value.startTime || value.startedAt || "");
  const end = Date.parse(value.endTime || value.endedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 10) / 100;
}

function rangeFromText(value, units, multiplier) {
  const unitPattern = `(?:${units.join("|")})`;
  const text = String(value || "");
  const less = new RegExp(`(?:少于|低于|不足|小于)\\s*(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, "i").exec(text);
  if (less) {
    return Object.freeze({
      min: null,
      max: Number(less[1]) * multiplier,
      maxInclusive: false,
    });
  }
  const range = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*-\\s*(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, "i").exec(text);
  if (range) {
    return Object.freeze({
      min: Number(range[1]) * multiplier,
      max: Number(range[2]) * multiplier,
      maxInclusive: false,
    });
  }
  return null;
}

function rangeFromBounds({ min, maxExclusive, maxInclusive }) {
  const hasMaxExclusive = typeof maxExclusive === "number";
  const hasMaxInclusive = typeof maxInclusive === "number";
  if (!hasMaxExclusive && !hasMaxInclusive) return null;
  const max = hasMaxExclusive ? maxExclusive : maxInclusive;
  const lower = typeof min === "number" ? min : null;
  if (lower !== null && max < lower) return null;
  return Object.freeze({
    min: lower,
    max,
    maxInclusive: !hasMaxExclusive,
  });
}

function rangeContains(range, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  if (typeof range.min === "number" && number < range.min) return false;
  if (typeof range.max === "number") {
    return range.maxInclusive ? number <= range.max : number < range.max;
  }
  return true;
}

function normalizeRuleEffect(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function wordCountFromText(value) {
  const match = String(value || "").match(/(?:少于|低于|不足|小于)\s*(\d+)\s*(?:词|单词|words?)/i);
  return match ? Number(match[1]) : null;
}

function charCountFromText(value) {
  const match = String(value || "").match(/(?:少于|低于|不足|小于)\s*(\d+)\s*(?:字|字符|chars?)/i);
  return match ? Number(match[1]) : null;
}

function capFromText(value) {
  const match = String(value || "").match(/(?:封顶|最高|不超过|最多)\s*(\d+(?:\.\d+)?)\s*分/i);
  return match ? Number(match[1]) : null;
}

function zeroScoreFromText(value) {
  return /不得分|零分|(?:^|[^\d])0\s*分/.test(String(value || ""));
}

function estimateWordCount(value) {
  const text = String(value || "");
  const latinWords = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u9FFF]/g) || [];
  return latinWords.length + cjkChars.length;
}

function normalizeEvidenceText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function safeIssueCode(error) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : "hr_training_content_evaluation_result_invalid";
}

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CONTEXT_VERSION as HR_TRAINING_EVALUATION_CONTEXT_VERSION,
  POLICY_VERSION as HR_TRAINING_CONTENT_EVALUATION_OUTPUT_POLICY_VERSION,
  PROMPT_VERSION as HR_TRAINING_CONTENT_EVALUATION_PROMPT_VERSION,
  RESULT_VERSION as HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION,
  TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE as HR_TRAINING_TRANSCRIPT_ADAPTIVE_QUESTION_PLAN_MODE,
  createHrTrainingContentEvaluationOutputPolicy,
  normalizeEvaluationContext,
  projectQuestionPlanningContext,
};
