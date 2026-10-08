import { desktopRuntimeTaskFailure } from "./desktopChannelModel.js";

export function makeMessage(role, content, extras = {}) {
  const requestedTime = Date.parse(String(extras.createdAt || ""));
  const createdAt = Number.isFinite(requestedTime) ? new Date(requestedTime).toISOString() : new Date().toISOString();
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, role, content, ...extras, createdAt };
}

export function finalizeAssistantActivities(activities = [], status = "done") {
  const current = Array.isArray(activities) && activities.length
    ? activities
    : [{ id: "response", kind: "runtime", label: "数字员工响应", status: "running" }];
  return current.map((activity) => activity.status === "running" ? {
    ...activity,
    label: status === "blocked" ? `${activity.label.replace(/^正在/, "")}受阻` : activity.label.replace(/^正在/, "已"),
    status,
  } : activity);
}

export function initialConversation(employee = {}, previewMode = "") {
  const employeeName = employee?.name || employee?.title || "数字员工";
  if (["task-progress", "task-progress-completed", "reusable-material"].includes(previewMode)) {
    const taskId = "task_preview_canonical_timeline";
    const completed = ["task-progress-completed", "reusable-material"].includes(previewMode);
    const startedAt = Date.now() - 82_000;
    const updatedAt = new Date(startedAt + (completed ? 62_000 : 54_000)).toISOString();
    const taskEvent = (seq, seconds, eventType, data) => ({
      contractVersion: "task-event.v1",
      taskId,
      seq,
      taskRevision: seq,
      eventType,
      occurredAt: new Date(startedAt + (seconds * 1000)).toISOString(),
      data,
    });
    const taskEvents = [
      taskEvent(1, 0, "task.state_changed", { status: "queued", waitReasonCode: "awaiting_worker", lastErrorCode: null, attemptCount: 0, recoveryCount: 0, code: "task_submitted" }),
      taskEvent(2, 4, "task.state_changed", { status: "running", waitReasonCode: null, lastErrorCode: null, attemptCount: 1, recoveryCount: 0, code: "worker_claimed" }),
      taskEvent(3, 7, "task.progress", { stage: "provider", status: "running", code: "provider_started" }),
      taskEvent(4, 18, "task.progress", { stage: "provider", status: "completed", code: "provider_completed" }),
      taskEvent(5, 21, "task.progress", { stage: "tool", status: "running", code: "tool_started" }),
      taskEvent(6, 33, "task.progress", { stage: "tool", status: "completed", code: "tool_completed" }),
      taskEvent(7, 37, "task.progress", { stage: "provider", status: "running", code: "provider_started" }),
      taskEvent(8, 43, "task.progress", { stage: "provider", status: "completed", code: "provider_completed" }),
      taskEvent(9, 46, "task.progress", { stage: "tool", status: "running", code: "tool_started" }),
      taskEvent(10, 51, "task.progress", { stage: "tool", status: "completed", code: "tool_completed" }),
      taskEvent(11, 54, "task.progress", { stage: "tool", status: "running", code: "tool_started" }),
      ...(completed ? [
        taskEvent(12, 59, "task.progress", { stage: "tool", status: "completed", code: "tool_completed" }),
        taskEvent(13, 60, "task.artifact_available", { artifactId: "artifact_preview_delivery_001" }),
        taskEvent(14, 61, "task.result_available", { resultKind: "conversation_history" }),
        taskEvent(15, 62, "task.state_changed", { status: "completed", waitReasonCode: null, lastErrorCode: null, attemptCount: 1, recoveryCount: 0, code: "worker_settled" }),
      ] : []),
    ];
    return [
      makeMessage("user", "查询我当前可用的企业协同能力"),
      makeMessage("assistant", completed ? "企业协同能力已查询完成；结果已由中心任务安全保存。" : "", {
        taskId,
        taskActivitySnapshot: {
          contractVersion: "desktop-task-activity-snapshot.v2",
          taskId,
          updatedAt,
          activities: previewEnterpriseActivities(completed),
        },
        taskProvenanceSnapshot: previewTaskProvenance({ completed, employee, taskId, updatedAt }),
        taskConnectionState: "connected",
        taskEvents,
        ...(completed ? { canonicalTaskStatus: "completed" } : {}),
        status: completed ? "done" : "streaming",
      }),
    ];
  }
  if (previewMode === "task-failure") {
    return [
      makeMessage("user", "查询当前项目的训练状态"),
      makeMessage("assistant", "", {
        activities: [{ id: "model", kind: "model", label: "连接模型受阻", status: "blocked" }],
        error: true,
        failure: desktopRuntimeTaskFailure({
          code: "model_provider_unavailable",
          status: "failed",
          taskId: "task_4ff054c5730867b859c6c866a168b31dbb4ec6960cd5599cc116cf31bb18c210",
        }),
        retryRequest: { text: "查询当前项目的训练状态" },
        status: "error",
      }),
    ];
  }
  const previewCard = previewMode === "tool-parameter-card"
    ? previewToolParameterCard()
    : previewMode === "tool-parameter-card-hr" ? previewHrToolParameterCard() : null;
  return [makeMessage("assistant", previewCard
    ? `我已经选好“${previewCard.title}”这个操作。请确认下面的任务参数，不用在聊天里逐项描述。`
    : `你好，我是${employeeName}。你可以发消息、粘贴网页链接，也可以把本地文件或 ZIP 拖进窗口；每次都只授权当前选择。`,
  previewCard ? { toolParameterCards: [previewCard] } : {})];
}

function previewEnterpriseActivities(completed) {
  const definitions = [
    ["查询当前权限范围", "identity.permission.read"],
    ["查询企业能力目录", "enterprise.catalog.read"],
    ["整理任务草案", "runtime.task.draft"],
  ];
  return Array.from({ length: 40 }, (_, index) => {
    const [displayName, actionCode] = definitions[index % definitions.length];
    return {
      activityId: `activity-preview-${index + 1}`,
      sequence: index + 1,
      kind: "tool",
      subjectId: "enterprise-assistant-control-plane",
      displayName,
      actionCode,
      status: completed || index < 39 ? "completed" : "running",
    };
  });
}

function previewTaskProvenance({ completed, employee = {}, taskId, updatedAt }) {
  return {
    contractVersion: "desktop-task-provenance.v1",
    sourceContractVersion: "runtime-safe-provenance.v1",
    taskId,
    updatedAt,
    employeeProfile: {
      fact: "applied",
      subjectId: employee.id || "enterprise-ai-copilot",
      displayName: "员工职业设定",
      sourceVersion: employee.version || "employee-preview-v1",
      promptVersion: employee.promptVersion || "prompt-preview-v1",
    },
    callableSkills: [{
      fact: "callable",
      subjectId: "knowledge-retrieval",
      displayName: "知识检索",
      sourceVersion: "skill-2026.06.25-01",
      executionMode: "guidance",
    }, {
      fact: "callable",
      subjectId: "workflow-orchestration",
      displayName: "流程编排",
      sourceVersion: "skill-2026.06.25-01",
      executionMode: "guidance",
    }],
    executedSkills: [],
  };
}

function previewToolParameterCard() {
  return {
    contractVersion: "tool-parameter-card.v2",
    id: "tool-card-preview-create-training-task",
    status: "draft",
    toolId: "dataflow-rest-api",
    operationId: "createTrainingTask",
    schemaDigest: `sha256:${"a".repeat(64)}`,
    title: "创建训练任务",
    description: "选择训练资源与运行策略。Agent 已根据当前任务预填常用项，你只需要快速确认或调整。",
    method: "POST",
    risk: "controlled_write",
    writebackBoundary: "仅创建 1 个训练任务草稿，不自动启动训练",
    fieldCount: 7,
    createdAt: new Date().toISOString(),
    argumentSchema: {
      type: "object",
      properties: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["projectName", "resourceType", "gpuCount"],
          properties: {
            projectName: { type: "string", title: "项目名称", description: "任务归属项目", minLength: 2, maxLength: 60 },
            resourceType: { type: "string", title: "资源类型", description: "按训练规模选择", enum: ["共享 GPU", "独占 GPU", "CPU"] },
            gpuCount: { type: "integer", title: "GPU 数量", description: "本次任务使用的 GPU 卡数", minimum: 1, maximum: 8 },
            autoRetry: { type: "boolean", title: "失败自动重试", default: true },
            priority: { type: "string", title: "运行优先级", enum: ["普通", "优先", "低峰"] },
            timeoutMinutes: { type: "integer", title: "超时分钟", minimum: 30, maximum: 1440 },
            note: { type: "string", title: "任务备注", maxLength: 120 },
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
    initialArguments: { body: { projectName: "缺陷分割基线", resourceType: "共享 GPU", gpuCount: 2, autoRetry: true, priority: "普通" } },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

function previewHrToolParameterCard() {
  return {
    contractVersion: "tool-parameter-card.v2",
    id: "tool-card-preview-hr-interview-questions",
    status: "draft",
    toolId: "hr-talentos-api",
    operationId: "hrCandidateInterviewQuestionJobCreate",
    schemaDigest: `sha256:${"b".repeat(64)}`,
    title: "创建候选人面试题任务",
    description: "候选人已由 HR 完成解析复核。请确认面试轮次、题目难度和关注点权重。",
    method: "POST",
    risk: "controlled_write",
    writebackBoundary: "仅创建该候选人的面试题草稿，仍需 HR 人工复核",
    fieldCount: 8,
    createdAt: new Date().toISOString(),
    argumentSchema: {
      type: "object",
      properties: {
        path: {
          type: "object",
          additionalProperties: false,
          required: ["candidateId"],
          properties: {
            candidateId: { type: "string", title: "候选人编号", description: "TalentOS 返回的稳定候选人引用。", minLength: 1, maxLength: 120, "x-agent-managed": true },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            questionCount: { type: "integer", title: "面试题数量", description: "本次生成的结构化面试题数量。", minimum: 1, maximum: 10, default: 8 },
            round: { type: "string", title: "面试轮次", enum: ["business", "culture", "final", "technical"], "x-enum-labels": ["业务面", "文化面", "终面", "技术面"], default: "technical" },
            difficulty: { type: "string", title: "题目难度", enum: ["entry", "mid", "senior"], "x-enum-labels": ["入门", "中等", "资深"], default: "mid" },
            focus: {
              type: "object",
              title: "关注点权重",
              description: "各项为 0-100，总和不得超过 100。",
              additionalProperties: false,
              properties: {
                technical_depth: { type: "integer", title: "技术/专业深度", minimum: 0, maximum: 100 },
                project_evidence: { type: "integer", title: "项目经历验证", minimum: 0, maximum: 100 },
                role_fit: { type: "integer", title: "岗位匹配追问", minimum: 0, maximum: 100 },
                communication: { type: "integer", title: "沟通协作", minimum: 0, maximum: 100 },
                risk_check: { type: "integer", title: "风险澄清", minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    initialArguments: { path: { candidateId: "CANDIDATE-SAFE-REF" }, body: { questionCount: 8, round: "technical", difficulty: "mid", focus: {} } },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}
