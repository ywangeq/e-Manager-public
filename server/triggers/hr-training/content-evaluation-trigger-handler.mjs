import crypto from "node:crypto";
import { AGENT_COMPLETION_CONTRACT_VERSION } from "../../agent-runtime/agent-completion-contract.mjs";
import {
  HR_TRAINING_CONTENT_EVALUATION_PROMPT_VERSION,
  HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION,
  normalizeEvaluationContext,
  projectQuestionPlanningContext,
} from "./content-evaluation-output-policy.mjs";
import { assertFullPromptCoverage } from "./locked-material-coverage.mjs";
import {
  HR_TRAINING_CONTENT_EVALUATION_RESULT_RECORD_VERSION,
} from "./content-evaluation-result-repository.mjs";

const HANDLER_CONTRACT_VERSION = "trigger-executor-handler.v1";
const EXECUTION_CONTRACT_VERSION = "trigger-handler-execution.v1";
const TASK_DEFINITION_ID = "hr-training-content-evaluation-v1";
const HANDLER_VERSION = "hr-training-content-evaluation-handler-v7";
const CAPABILITY = "hr_training.content_evaluate.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EXECUTION_FIELDS = new Set([
  "context",
  "contractVersion",
  "isCancellationRequested",
  "operationReceiptContext",
  "signal",
  "task",
]);

function createHrTrainingContentEvaluationTriggerHandler({
  agentExecutionService,
  callbackAuthorizationDigest,
  callbackEffect,
  currentCallbackAuthorization,
  enabled,
  evaluationContextFetcher = defaultEvaluationContextFetcher,
  fetchImpl = globalThis.fetch,
  handlerVersion = HANDLER_VERSION,
  inputRepository,
  outputPolicy,
  providerLeaseResolver,
  resultRepository,
  reviewStatus,
  scheduleRetry,
  evaluationSkillContextResolver,
  taskDefinitionId = TASK_DEFINITION_ID,
} = {}) {
  requireMethod(agentExecutionService, "buildPrompt");
  requireMethod(agentExecutionService, "execute");
  requireFunction(callbackAuthorizationDigest, "callbackAuthorizationDigest");
  requireMethod(callbackEffect, "execute");
  requireFunction(currentCallbackAuthorization, "currentCallbackAuthorization");
  requireFunction(evaluationContextFetcher, "evaluationContextFetcher");
  if (typeof fetchImpl !== "function") throw new TypeError("HR Training content handler requires fetch");
  requireMethod(inputRepository, "getInternal");
  requireMethod(outputPolicy, "normalizeResult");
  requireMethod(outputPolicy, "outputFormat");
  requireMethod(evaluationSkillContextResolver, "resolve");
  requireFunction(providerLeaseResolver, "providerLeaseResolver");
  requireMethod(resultRepository, "getInternal");
  requireMethod(resultRepository, "saveOrGet");
  requireFunction(scheduleRetry, "scheduleRetry");
  if (typeof enabled !== "boolean" ||
    !["approved", "pending_review", "rejected"].includes(reviewStatus)) {
    throw new TypeError("HR Training content handler governance invalid");
  }
  const exactTaskDefinitionId = requiredToken(taskDefinitionId, 160);
  const exactHandlerVersion = requiredToken(handlerVersion, 80);

  async function execute(value) {
    let request;
    try {
      request = normalizeExecution(value);
      if (request.context.taskDefinition.taskDefinitionId !== exactTaskDefinitionId ||
        request.context.taskDefinition.handlerVersion !== exactHandlerVersion ||
        request.context.triggerEvent.event.eventType !== CAPABILITY) {
        throw new TypeError("HR Training content Trigger task mismatch");
      }
    } catch {
      return blockedSettlement("hr_training_content_context_invalid");
    }
    if (canceled(request)) return canceledSettlement();

    let input;
    try {
      input = inputRepository.getInternal({
        tenantScope: request.task.tenantScope,
        runInputId: request.context.triggerEvent.event.subject.objectId,
      });
      if (!input || input.tenantScope !== request.task.tenantScope ||
        input.runInputId !== request.context.triggerEvent.event.subject.objectId ||
        input.capability !== CAPABILITY) {
        throw new Error("input mismatch");
      }
    } catch {
      return failedSettlement("hr_training_content_input_unavailable");
    }

    let existing;
    try {
      existing = resultRepository.getInternal(resultIdentity(request));
    } catch {
      return failedSettlement("hr_training_content_result_persistence_failed");
    }
    if (existing) {
      return deliverCallback({
        body: existing.result,
        input,
        request,
        terminalEvidenceDigest: existing.evidenceDigest,
        terminalStatus: "completed",
      });
    }

    let context;
    try {
      context = await evaluationContextFetcher({
        apiKey: process.env.HR_TRAINING_SERVICE_API_KEY,
        contextUrl: input.contextUrl,
        fetchImpl,
        signal: request.signal,
      });
    } catch (error) {
      const code = safeExecutionCode(error, "hr_training_content_context_fetch_failed");
      if (code === "hr_training_evaluation_context_not_ready") {
        return waitForEvaluationContext({ error, request, scheduleRetry });
      }
      return failWithCallback({
        errorCode: publicErrorCode(code),
        input,
        message: publicMessage(code),
        request,
      });
    }
    try {
      context = normalizeEvaluationContext(context, {
        meetingRecordId: input.meetingRecordId,
        sessionId: input.sessionId,
      });
    } catch (error) {
      return failWithCallback({
        errorCode: publicErrorCode(safeExecutionCode(error, "hr_training_evaluation_context_invalid")),
        input,
        message: publicMessage(safeExecutionCode(error, "hr_training_evaluation_context_invalid")),
        request,
      });
    }
    if (canceled(request)) return canceledSettlement();

    let result;
    let lease;
    let latestCandidateIssues = [];
    let latestCandidateCode = "";
    let preModelStage = "runtime_execution";
    try {
      lease = await providerLeaseResolver({
        employee: request.context.employee,
        runtimeTask: request.task,
      });
      if (!lease) return blockedSettlement("hr_training_content_provider_unavailable");
      const expected = {
        meetingRecordId: input.meetingRecordId,
        runId: request.task.taskId,
        sessionId: input.sessionId,
      };
      const candidateEvaluator = ({ text }) => {
        try {
          return Object.freeze({
            status: "accepted",
            value: outputPolicy.normalizeResult({
              context,
              expected,
              modelName: modelNameFromLease(lease),
              text,
            }),
          });
        } catch (error) {
          latestCandidateCode = safeExecutionCode(error, "hr_training_content_model_output_invalid");
          latestCandidateIssues = typeof outputPolicy.candidateIssues === "function"
            ? outputPolicy.candidateIssues({ context, expected, text })
            : [];
          return Object.freeze({
            status: "repairable",
            code: latestCandidateCode,
            issues: latestCandidateIssues,
          });
        }
      };
      preModelStage = "skill_context";
      const dependencyContext = evaluationSkillContextResolver.resolve({
        capability: CAPABILITY,
        employee: request.context.employee,
        task: request.task,
        taskDefinition: request.context.taskDefinition,
        triggerEvent: request.context.triggerEvent,
      });
      preModelStage = "prompt_setup";
      const prompt = agentExecutionService.buildPrompt({
        candidateEvaluator,
        completionContract: {
          contractVersion: AGENT_COMPLETION_CONTRACT_VERSION,
          maxCandidateRepairRounds: 1,
          maxEvidenceContinuationRounds: 0,
          requiredEvidence: [],
        },
        conversationHistory: [],
        dependencyContext,
        employeeIdentity: employeeIdentity(request.context.employee, request.task),
        lease,
        maxOutputTokens: outputPolicy.maxOutputTokens || 4200,
        outputFormat: outputPolicy.outputFormat({
          context,
          expected,
          taskDefinition: request.context.taskDefinition,
        }),
        references: [],
        runtimeContext: {
          currentTurn: {
            text: buildEvaluationPrompt({
              context,
              expected,
            }),
          },
        },
        safeContext: {
          contractVersion: "hr-training-trigger-safe-context.v1",
          dependencyContext,
          trigger: {
            sourceSystemId: "hr-train",
            capability: CAPABILITY,
            taskDefinitionId: request.context.taskDefinition.taskDefinitionId,
            bindingId: request.context.binding.bindingId,
          },
        },
        stream: false,
        toolExecutor: null,
      });
      assertFullPromptCoverage({
        codePrefix: "hr_training_evaluation_context",
        lease,
        prompt,
      });
      preModelStage = "runtime_execution";
      const agentResult = await agentExecutionService.execute({
        lease,
        prompt,
        runtimeTask: request.task,
        signal: request.signal,
        toolExecutor: null,
      });
      if (agentResult?.partial === true || agentResult?.reason === "agent_turn_canceled") {
        return agentResult?.reason === "agent_turn_canceled"
          ? canceledSettlement()
          : failedSettlement("hr_training_content_partial_result");
      }
      result = agentResult?.completionOutcome?.contractVersion === HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION
        ? agentResult.completionOutcome
        : outputPolicy.normalizeResult({
          context,
          expected,
          modelName: modelNameFromLease(lease),
          text: agentResult?.text,
        });
    } catch (error) {
      const code = safeExecutionCode(error, "");
      const diagnosticIssues = candidateIssuesFromError(error, [
        ...latestCandidateIssues,
        latestCandidateCode,
      ]);
      const errorCode = publicErrorCode(preModelDiagnosticCode({
        code,
        diagnosticIssues,
        stage: preModelStage,
      }), diagnosticIssues);
      return failWithCallback({
        errorCode,
        input,
        message: publicMessage(errorCode),
        modelName: modelNameFromLease(lease),
        request,
      });
    }
    if (canceled(request)) return canceledSettlement();

    let stored;
    try {
      stored = resultRepository.saveOrGet({
        contractVersion: HR_TRAINING_CONTENT_EVALUATION_RESULT_RECORD_VERSION,
        ...resultIdentity(request),
        result,
      });
    } catch {
      return failedSettlement("hr_training_content_result_persistence_failed");
    }
    return deliverCallback({
      body: stored.result,
      input,
      request,
      terminalEvidenceDigest: stored.evidence.evidenceDigest,
      terminalStatus: "completed",
    });
  }

  async function deliverCallback({ body, input, request, terminalEvidenceDigest = null,
    terminalStatus }) {
    let writeback;
    try {
      const authorizationDigest = callbackAuthorizationDigest({
        input,
        triggerEvent: request.context.triggerEvent,
      });
      writeback = await callbackEffect.execute({
        authorizationDigest,
        authorizeCurrentOperation: (receiptRequest) => currentCallbackAuthorization({
          authorizationDigest: receiptRequest.authorizationDigest,
          input,
          triggerEvent: request.context.triggerEvent,
        }),
        body,
        input,
        operationReceiptContext: request.operationReceiptContext,
        signal: request.signal,
        task: request.task,
        triggerEvent: request.context.triggerEvent,
      });
    } catch (error) {
      return failedSettlement(safeExecutionCode(error, "hr_training_callback_failed"));
    }
    if (!writeback || !["succeeded", "definitive_failed", "unknown"].includes(writeback.status) ||
      writeback.receipt?.status !== writeback.status ||
      !SAFE_CODE.test(String(writeback.receipt?.safeResultCode || ""))) {
      return blockedSettlement("hr_training_callback_outcome_unknown");
    }
    if (writeback.status === "unknown") return blockedSettlement("hr_training_callback_outcome_unknown");
    if (writeback.status === "definitive_failed") {
      return failedSettlement(writeback.receipt.safeResultCode);
    }
    if (terminalStatus === "failed") {
      return failedSettlement(String(body.errorCode || "HR_TRAINING_CONTENT_FAILED").toLowerCase());
    }
    return completedSettlement(terminalEvidenceDigest || digestCanonical(body));
  }

  async function failWithCallback({ errorCode, input, message, modelName = "", request }) {
    const body = failureCallbackBody({
      errorCode,
      input,
      message,
      modelName,
      runId: request.task.taskId,
    });
    return deliverCallback({
      body,
      input,
      request,
      terminalStatus: "failed",
    });
  }

  return Object.freeze({
    contractVersion: HANDLER_CONTRACT_VERSION,
    taskDefinitionId: exactTaskDefinitionId,
    handlerVersion: exactHandlerVersion,
    enabled,
    reviewStatus,
    execute,
  });
}

async function defaultEvaluationContextFetcher({ apiKey, contextUrl, fetchImpl, signal }) {
  const token = String(apiKey || "").trim();
  if (!token) throw codedError("hr_training_api_key_unconfigured");
  const response = await fetchImpl(contextUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 409 && notReadyBody(body)) {
    const error = codedError("hr_training_evaluation_context_not_ready");
    error.retryAfterMs = retryAfterMs(response, body);
    throw error;
  }
  if (!response.ok) throw codedError("hr_training_content_context_fetch_failed");
  return body;
}

function waitForEvaluationContext({ error, request, scheduleRetry }) {
  try {
    scheduleRetry({
      delayMs: clampRetryDelay(error?.retryAfterMs),
      task: request.task,
    });
  } catch {
    return blockedSettlement("hr_training_evaluation_context_retry_unavailable");
  }
  return Object.freeze({
    status: "waiting",
    waitReasonCode: "hr_training_evaluation_context_not_ready",
    lastErrorCode: "hr_training_evaluation_context_not_ready",
    resultSummary: "hr_training_evaluation_context_not_ready",
    terminalEvidenceDigest: null,
  });
}

function buildEvaluationPrompt({ context, expected }) {
  return [
    "评估输出必须使用以下 runId/sessionId/meetingRecordId：",
    JSON.stringify(expected),
    "",
    "评分字段必须严格满足以下机械契约；评分理由和反馈仍应根据评分标准总结：",
    JSON.stringify(scoreOutputContract(context)),
    "",
    "证据可追溯格式必须严格满足以下机械契约；它只证明本次确实讲过，不是评分资格、得分上限或与课程材料逐字一致的要求。评分仍只按本轮 rubric：",
    JSON.stringify(evidenceOutputContract()),
    "",
    "追问题单格式必须严格满足以下机械契约；仅修正格式时不得改变评分、反馈或题目业务意图：",
    JSON.stringify(questionOutputContract(context)),
    "",
    "HR Training evaluationContext（不得回显 URL、Prompt 或系统字段；只基于内容评分）：",
    JSON.stringify(projectPromptContext(context)),
  ].join("\n");
}

function scoreOutputContract(context) {
  const dimensions = Array.isArray(context?.rubric?.evaluationDimensions)
    ? context.rubric.evaluationDimensions.map((item) => ({
      key: item.key,
      name: item.name,
      maxScore: item.maxScore,
    }))
    : [];
  return {
    field: "contentScore",
    maxScore: dimensions.reduce((sum, item) => sum + Number(item.maxScore || 0), 0),
    dimensionScores: dimensions,
    rules: [
      "dimensionScores 必须与上列维度一一对应：不遗漏、不重复、不新增。",
      "每项 key、name、maxScore 必须使用同一行的原值；score 必须在 0 到该项 maxScore 之间。",
      "contentScore.maxScore 必须等于上列 maxScore 之和。",
    ],
  };
}

function evidenceOutputContract() {
  return {
    field: "contentScore.dimensionScores[].evidence[].text",
    type: "TRANSCRIPT_SNIPPET",
    source: "transcript.content",
    match: "可选的可追溯说明；不要求与 transcript.content 连续或逐字一致",
    prohibited: [],
    note: "evidence.text 只用于辅助说明；它不决定是否可得分、得多少分，也不参与评分资格校验。评分允许等价表述、概括和改写。",
  };
}

function questionOutputContract(context) {
  const questionPlanning = projectQuestionPlanningContext(context);
  const countPolicy = questionPlanning.countPolicy;
  return {
    count: { min: countPolicy.min, max: countPolicy.max },
    questionGenerationMode: questionPlanning.questionGenerationMode,
    exactFields: questionPlanning.questionGenerationMode === "FROZEN_SELECTED" ||
      questionPlanning.questionGenerationMode === "TRANSCRIPT_ADAPTIVE"
      ? ["questionId", "sourceQuestionId", "text", "questionType", "required", "evaluationFocus", "reason"]
      : ["questionId", "text", "evaluationFocus", "reason"],
    questionIds: "按数组顺序连续使用 q1 到 qN，不跳号、不重复",
    selectedQuestions: questionPlanning.selectedQuestions.map((item, index) => ({
      questionId: `q${index + 1}`,
      sourceQuestionId: item.sourceQuestionId,
      ...(item.text ? { text: item.text } : {
        evaluationIntent: item.evaluationIntent,
        questionTemplate: item.questionTemplate,
      }),
      questionType: item.questionType,
      required: item.required,
    })),
    ...(questionPlanning.q5Constraint ? { q5Constraint: questionPlanning.q5Constraint } : {}),
    selectedQuestionRule: questionPlanning.questionGenerationMode === "TRANSCRIPT_ADAPTIVE"
      ? "必须按 selectedQuestions 的 sourceQuestionId、questionType、required 和原顺序处理；根据 transcript.content 识别已覆盖、遗漏、错误、表达薄弱或可追问内容，在对应 questionTemplate 与 evaluationIntent 范围内改写题干。只允许四个基础题加最后一道 Q5；不得引入题库外维度、改变 Q5 场景约束、回显逐字稿或敏感信息。"
      : questionPlanning.questionGenerationMode === "FROZEN_SELECTED"
      ? "必须逐题使用 selectedQuestions 的 sourceQuestionId、原始题干、questionType、required 和顺序，不得遗漏、改写、替换或新增；模型只能补 evaluationFocus/reason。"
      : "selectedQuestions 未提供且非动态课程，按 countPolicy、recommendedDirections 和材料语义生成题目。",
    questionTextContract: questionPlanning.questionTextContract,
    textQuality: "改写时优先形成员工可理解、可独立回答的问题；短而有效的题目不得仅因长度或形式导致失败。",
    evaluationFocus: "非空字符串数组，最多 6 项",
    reason: "非空字符串",
  };
}

function projectPromptContext(context) {
  return {
    contractVersion: context.contractVersion,
    ready: context.ready,
    session: {
      sessionId: context.session.sessionId,
      assessmentId: context.session.assessmentId || "",
      topicId: context.session.topicId || "",
      materialVersionId: context.session.materialVersionId || "",
      rubricVersionId: context.session.rubricVersionId || "",
      startedAt: context.session.startedAt || "",
    },
    attempt: {
      meetingRecordId: context.attempt.meetingRecordId,
      startTime: context.attempt.startTime || "",
      endTime: context.attempt.endTime || "",
      durationSeconds: context.attempt.durationSeconds ?? null,
    },
    transcript: {
      content: context.transcript.content,
      durationSeconds: context.transcript.durationSeconds ?? context.transcript.duration ?? null,
      wordCount: context.transcript.wordCount ?? null,
      characterCount: context.transcript.characterCount ?? context.transcript.charCount ?? null,
    },
    material: {
      materialVersionId: context.material.materialVersionId || "",
      version: context.material.version || "",
      format: context.material.format || "",
      content: context.material.content,
      checksum: context.material.checksum || "",
    },
    rubric: {
      rubricMarkdown: context.rubric.rubricMarkdown,
      evaluationDimensions: context.rubric.evaluationDimensions,
      durationContentRules: context.rubric.durationContentRules,
    },
    questionPlanning: projectQuestionPlanningContext(context),
  };
}

function employeeIdentity(employee = {}, task = {}) {
  return Object.freeze({
    id: task.employeeId || cleanId(employee.id),
    status: cleanId(employee.status),
    version: task.employeeVersion || cleanId(employee.version),
  });
}

function failureCallbackBody({ errorCode, input, message, modelName, runId }) {
  return Object.freeze({
    contractVersion: HR_TRAINING_CONTENT_EVALUATION_RESULT_VERSION,
    runId,
    sessionId: input.sessionId,
    meetingRecordId: input.meetingRecordId,
    status: "FAILED",
    errorCode,
    message,
    modelName: String(modelName || "").trim().slice(0, 120),
    promptVersion: HR_TRAINING_CONTENT_EVALUATION_PROMPT_VERSION,
  });
}

function normalizeExecution(value) {
  requireExactObject(value, EXECUTION_FIELDS, "HR Training Trigger execution");
  if (value.contractVersion !== EXECUTION_CONTRACT_VERSION ||
    typeof value.isCancellationRequested !== "function" || !isAbortSignal(value.signal) ||
    !isPlainObject(value.context) || !isPlainObject(value.context.binding) ||
    !isPlainObject(value.context.employee) || !isPlainObject(value.context.taskDefinition) ||
    !isPlainObject(value.context.triggerEvent) || !isPlainObject(value.task)) {
    throw new TypeError("HR Training Trigger execution invalid");
  }
  const repository = value.operationReceiptContext?.repositoryContext;
  if (!isPlainObject(repository) || repository.taskId !== value.task.taskId ||
    repository.tenantScope !== value.task.tenantScope || !DIGEST.test(repository.workerIdDigest) ||
    !Number.isSafeInteger(repository.fencingToken) || repository.fencingToken <= 0) {
    throw new TypeError("HR Training Trigger receipt context invalid");
  }
  requiredToken(repository.leaseId, 128);
  return value;
}

function resultIdentity(request) {
  return Object.freeze({
    tenantScope: requiredToken(request.task.tenantScope, 160),
    triggerEventId: requiredToken(request.context.triggerEvent.triggerEventId, 240),
    taskId: requiredToken(request.task.taskId, 128),
  });
}

function currentRetryHeader(response) {
  try {
    return response.headers?.get?.("retry-after") || response.headers?.get?.("Retry-After") || "";
  } catch {
    return "";
  }
}

function retryAfterMs(response, body) {
  const fromBody = Number(body?.error?.retryAfterSeconds ?? body?.retryAfterSeconds);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody * 1000;
  const header = currentRetryHeader(response);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 30_000;
}

function clampRetryDelay(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) return 30_000;
  return Math.max(5_000, Math.min(300_000, Math.round(delay)));
}

function notReadyBody(value) {
  return value?.error?.code === "EVALUATION_CONTEXT_NOT_READY" ||
    value?.code === "EVALUATION_CONTEXT_NOT_READY";
}

function modelNameFromLease(lease) {
  return String(lease?.model || lease?.modelId || "").trim().slice(0, 120);
}

function publicErrorCode(code, candidateIssues = []) {
  if (candidateIssues.length || isModelOutputValidationCode(code)) {
    return modelOutputDiagnosticCode(candidateIssues, code);
  }
  return ({
    hr_training_api_key_unconfigured: "HR_TRAINING_SERVICE_API_KEY_UNCONFIGURED",
    hr_training_content_context_fetch_failed: "EVALUATION_CONTEXT_FETCH_FAILED",
    hr_training_evaluation_context_contract_invalid: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_context_session_mismatch: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_context_attempt_mismatch: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_context_not_ready: "EVALUATION_CONTEXT_NOT_READY",
    hr_training_evaluation_context_material_content_missing: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_evaluation_context_material_coverage_incomplete: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_evaluation_context_provider_context_capability_unavailable: "EVALUATION_CONTEXT_CAPABILITY_UNAVAILABLE",
    hr_training_evaluation_context_provider_context_coverage_insufficient: "EVALUATION_CONTEXT_COVERAGE_INSUFFICIENT",
    hr_training_evaluation_context_rubric_invalid: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_context_transcript_missing: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_context_invalid: "EVALUATION_CONTEXT_INVALID",
    hr_training_evaluation_skill_unavailable: "EVALUATION_SKILL_UNAVAILABLE",
    hr_training_evaluation_skill_policy_snapshot_mismatch: "EVALUATION_SKILL_POLICY_SNAPSHOT_MISMATCH",
    hr_training_content_prompt_setup_failed: "EVALUATION_PROMPT_SETUP_FAILED",
    hr_training_content_runtime_execution_failed: "EVALUATION_RUNTIME_EXECUTION_FAILED",
  })[code] || (code.includes("context") ? "EVALUATION_CONTEXT_INVALID" : "EVALUATION_RUNTIME_EXECUTION_FAILED");
}

function isModelOutputValidationCode(code) {
  return code === "hr_training_content_model_output_invalid" ||
    /(?:evidence|question|score|dimension|result|forbidden)/.test(code);
}

function modelOutputDiagnosticCode(candidateIssues, internalCode = "") {
  const issues = new Set((Array.isArray(candidateIssues) ? candidateIssues : [])
    .map((value) => String(value || "").trim()));
  if (SAFE_CODE.test(internalCode)) issues.add(internalCode);
  if (issues.has("invalid_json")) return "MODEL_OUTPUT_JSON_INVALID";
  if (issues.has("forbidden_result_field")) return "MODEL_OUTPUT_FORBIDDEN_FIELD";
  if ([...issues].some((code) => code.includes("evidence"))) {
    return "MODEL_OUTPUT_EVIDENCE_NOT_VERIFIABLE";
  }
  if (issues.has("hr_training_question_count_invalid")) {
    return "MODEL_OUTPUT_QUESTION_COUNT_INVALID";
  }
  if (issues.has("hr_training_question_fields_invalid")) {
    return "MODEL_OUTPUT_QUESTION_FIELDS_INVALID";
  }
  if (issues.has("hr_training_question_id_invalid")) {
    return "MODEL_OUTPUT_QUESTION_ID_INVALID";
  }
  if (issues.has("hr_training_question_text_invalid") || issues.has("hr_training_question_not_standalone")) {
    return "MODEL_OUTPUT_QUESTION_TEXT_INVALID";
  }
  if (issues.has("hr_training_question_focus_invalid")) {
    return "MODEL_OUTPUT_QUESTION_FOCUS_INVALID";
  }
  if (issues.has("hr_training_question_reason_invalid")) {
    return "MODEL_OUTPUT_QUESTION_REASON_INVALID";
  }
  if ([...issues].some((code) => code.includes("question"))) {
    return "MODEL_OUTPUT_QUESTION_CONTRACT_INVALID";
  }
  if ([...issues].some((code) => code.includes("score") || code.includes("dimension"))) {
    return "MODEL_OUTPUT_SCORE_CONTRACT_INVALID";
  }
  return "MODEL_OUTPUT_CONTRACT_INVALID";
}

function candidateIssuesFromError(error, fallback) {
  const fromError = Array.isArray(error?.completionCandidateIssues) ? error.completionCandidateIssues : [];
  return Object.freeze([...(Array.isArray(fallback) ? fallback : []), ...fromError]
    .map((value) => String(value || "").trim())
    .filter((value) => SAFE_CODE.test(value))
    .slice(0, 8));
}

function preModelDiagnosticCode({ code = "", diagnosticIssues = [], stage = "" } = {}) {
  if (diagnosticIssues.length || isModelOutputValidationCode(code)) return code || "hr_training_content_model_output_invalid";
  if (stage === "skill_context") return code || "hr_training_evaluation_skill_unavailable";
  if (stage === "prompt_setup") {
    return code.includes("context") ? code : "hr_training_content_prompt_setup_failed";
  }
  return code || "hr_training_content_runtime_execution_failed";
}

function publicMessage(code) {
  return ({
    hr_training_api_key_unconfigured: "数字中心缺少 HR Train 评估资料读取密钥配置。",
    hr_training_content_context_fetch_failed: "评估上下文读取失败，请稍后重试或联系管理员检查 HR Train 触发配置。",
    hr_training_evaluation_context_invalid: "评估上下文不符合当前内容评估契约。",
    hr_training_evaluation_context_contract_invalid: "评估上下文版本不符合当前内容评估契约。",
    hr_training_evaluation_context_session_mismatch: "评估上下文与触发的培训会话不一致。",
    hr_training_evaluation_context_attempt_mismatch: "评估上下文与触发的妙记记录不一致。",
    hr_training_evaluation_context_rubric_invalid: "评估准则缺失或不完整。",
    hr_training_evaluation_context_transcript_missing: "评估逐字稿内容缺失。",
    hr_training_evaluation_context_material_content_missing: "锁定课程资料内容缺失，无法确认完整覆盖。",
    hr_training_evaluation_context_material_coverage_incomplete: "锁定课程资料未提供完整覆盖证明，未执行评估。",
    hr_training_evaluation_context_provider_context_capability_unavailable: "当前模型未声明上下文容量，无法确认完整资料与逐字稿覆盖。",
    hr_training_evaluation_context_provider_context_coverage_insufficient: "当前模型上下文容量不足以完整覆盖逐字稿和锁定课程资料，未执行评估。",
    hr_training_evaluation_skill_unavailable: "当前已发布的评估 Skill 运行时不可用。",
    hr_training_evaluation_skill_policy_snapshot_mismatch: "当前评估 Skill 策略与本次任务快照不一致。",
    hr_training_content_prompt_setup_failed: "内容评估在模型调用前的受管准备阶段失败。",
    hr_training_content_runtime_execution_failed: "内容评估运行时未能完成模型执行。",
    EVALUATION_SKILL_UNAVAILABLE: "当前已发布的评估 Skill 运行时不可用。",
    EVALUATION_SKILL_POLICY_SNAPSHOT_MISMATCH: "当前评估 Skill 策略与本次任务快照不一致。",
    EVALUATION_PROMPT_SETUP_FAILED: "内容评估在模型调用前的受管准备阶段失败。",
    EVALUATION_RUNTIME_EXECUTION_FAILED: "内容评估运行时未能完成模型执行。",
    MODEL_OUTPUT_JSON_INVALID: "内容评估结果不是有效的结构化 JSON。",
    MODEL_OUTPUT_FORBIDDEN_FIELD: "内容评估结果包含不允许的字段。",
    MODEL_OUTPUT_EVIDENCE_NOT_VERIFIABLE: "内容评估结果中的证据无法与逐字稿核验。",
    MODEL_OUTPUT_QUESTION_COUNT_INVALID: "内容评估结果中的追问题数量不符合当前题量策略。",
    MODEL_OUTPUT_QUESTION_FIELDS_INVALID: "内容评估结果中的追问题字段不符合当前题目契约。",
    MODEL_OUTPUT_QUESTION_ID_INVALID: "内容评估结果中的追问题编号不符合当前题目契约。",
    MODEL_OUTPUT_QUESTION_TEXT_INVALID: "内容评估结果中的追问题干不符合当前题目契约。",
    MODEL_OUTPUT_QUESTION_FOCUS_INVALID: "内容评估结果中的追问关注点不符合当前题目契约。",
    MODEL_OUTPUT_QUESTION_REASON_INVALID: "内容评估结果中的追问理由不符合当前题目契约。",
    MODEL_OUTPUT_QUESTION_CONTRACT_INVALID: "内容评估结果中的追问题不符合当前题目契约。",
    MODEL_OUTPUT_SCORE_CONTRACT_INVALID: "内容评估结果中的计分字段不符合当前评分准则。",
    MODEL_OUTPUT_CONTRACT_INVALID: "内容评估结果未通过结构化输出校验。",
  })[code] || "内容评估未完成，请联系管理员查看安全错误码。";
}

function canceled(request) {
  if (request.signal.aborted) return true;
  try {
    return request.isCancellationRequested() !== false;
  } catch {
    return true;
  }
}

function canceledSettlement() {
  return blockedSettlement("agent_turn_canceled");
}

function blockedSettlement(code) {
  return settlement("blocked", code, code, null);
}

function failedSettlement(code) {
  return settlement("failed", code, "hr_training_content_evaluation_failed", null);
}

function completedSettlement(evidenceDigest) {
  return settlement("completed", null, "hr_training_content_evaluation_completed", evidenceDigest);
}

function settlement(status, lastErrorCode, resultSummary, terminalEvidenceDigest) {
  return Object.freeze({ status, lastErrorCode, resultSummary, terminalEvidenceDigest });
}

function safeExecutionCode(error, fallback) {
  const code = String(error?.code || "");
  return SAFE_CODE.test(code) ? code : fallback;
}

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
  }
  return value;
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 160);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function requiredToken(value, maximum) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("HR Training Trigger reference invalid");
  }
  return value;
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`HR Training content handler requires ${method}`);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`HR Training content handler requires ${name}`);
}

function requireExactObject(value, fields, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} invalid`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isAbortSignal(value) {
  return value && typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  CAPABILITY as HR_TRAINING_CONTENT_EVALUATION_CAPABILITY,
  HANDLER_VERSION as HR_TRAINING_CONTENT_EVALUATION_HANDLER_VERSION,
  TASK_DEFINITION_ID as HR_TRAINING_CONTENT_EVALUATION_TASK_DEFINITION_ID,
  createHrTrainingContentEvaluationTriggerHandler,
  defaultEvaluationContextFetcher,
};
