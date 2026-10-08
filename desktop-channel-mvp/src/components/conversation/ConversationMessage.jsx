import { useEffect, useState } from "react";
import {
  CaretRight,
  CheckCircle,
  Clock,
  File,
  LinkSimple,
  ShieldCheck,
  SpinnerGap,
  Stack,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { MarkdownMessage } from "../MarkdownMessage.jsx";
import { ArtifactDeliveryEntry } from "../ArtifactDeliveryEntry.jsx";
import { TaskFeedbackActions } from "../TaskFeedbackActions.jsx";
import { desktopArtifactDeliveryGate, isDesktopTaskTerminalStatus } from "../../../shared/desktop-task-timeline.mjs";
import { TaskFailureCard } from "../TaskFailureCard.jsx";
import { ToolParameterCard } from "../ToolParameterCard.jsx";
import { DesktopTaskTimeline } from "./DesktopTaskTimeline.jsx";
import { toolConfirmationPresentation } from "../../lib/toolConfirmationPresentation.js";

export function ConversationMessage({ automations = [], onOpenAutomation, cancelingTaskIds, feedbackState, feedbackTask, message, onCancelTask, onConfirmToolCall, onCopyTaskId, onDeliverArtifact, onFeedback, onInspectArtifact, onLoadTaskProcess, onOpenLink, onRetryTask, onSubmitToolParameters, onParameterDraftChange, parameterBusy = false }) {
  const [taskProcessState, setTaskProcessState] = useState("idle");
  const hasTimeline = message.role === "assistant" && message.taskEvents?.length > 0;
  const hasActivity = message.role === "assistant" && !hasTimeline && !message.failure && message.activities?.length > 0;
  const hasProcess = hasTimeline || hasActivity;
  const taskId = String(message.taskId || message.taskEvents?.[0]?.taskId || "");
  const presentationStatus = message.canonicalTaskStatus || [...(message.taskEvents || [])].reverse()
    .find((event) => event?.eventType === "task.state_changed")?.data?.status;
  const canFeedback = hasTimeline && presentationStatus === "completed" && isDesktopTaskTerminalStatus(presentationStatus) && message.content &&
    feedbackTask?.id === taskId && feedbackTask.status === "completed";
  const canLoadTaskProcess = message.role === "assistant" && taskId && !hasTimeline &&
    feedbackTask?.id === taskId && isDesktopTaskTerminalStatus(feedbackTask.status) && onLoadTaskProcess;
  const artifactGates = hasTimeline ? message.taskEvents
    .filter((event) => event.eventType === "task.artifact_available")
    .map((event) => desktopArtifactDeliveryGate(event, message.taskEvents))
    .filter(Boolean) : [];
  const content = message.role === "assistant"
    ? <MarkdownMessage content={message.content} onOpenLink={onOpenLink} />
    : <div className="message-copy">{linkify(message.content, onOpenLink)}</div>;
  return (
    <article className={`message ${message.role} ${message.error ? "is-error" : ""} ${hasProcess ? "has-activity" : ""}`}>
      {hasTimeline ? (
        <DesktopTaskTimeline
          activitySnapshot={message.taskActivitySnapshot}
          canceling={Boolean(taskId && cancelingTaskIds?.has(taskId))}
          connectionState={message.taskConnectionState}
          events={message.taskEvents}
          provenanceSnapshot={message.taskProvenanceSnapshot}
          onCancel={taskId && onCancelTask ? () => onCancelTask({ taskId }) : null}
        />
      ) : null}
      {hasActivity ? <AssistantActivity activities={message.activities} /> : null}
      {message.failure ? <TaskFailureCard failure={message.failure} onCopyTaskId={onCopyTaskId} onRetry={message.retryRequest && onRetryTask ? () => onRetryTask(message.retryRequest) : null} /> : null}
      {message.content || artifactGates.length ? (hasProcess ? <div className="message-response-block">
        {message.content ? <div className="message-response-surface">
          {content}
          {canFeedback ? <TaskFeedbackActions
            onFeedback={onFeedback}
            state={feedbackState}
            task={feedbackTask}
          /> : null}
        </div> : null}
        {artifactGates.length ? <div className="conversation-output-artifacts" aria-label="本次生成的文件">
          {artifactGates.map((gate) => <ArtifactDeliveryEntry
            gate={gate}
            inline
            key={gate.artifactId}
            onDeliverArtifact={onDeliverArtifact}
            onInspectArtifact={onInspectArtifact}
          />)}
        </div> : null}
      </div> : content) : null}
      {message.role === "assistant" && taskId ? automations.filter(a => a.sourceTaskId === taskId).map(a => <button
        key={a.automationId} type="button" className="personal-automation-card" onClick={() => onOpenAutomation?.(a)}>
        <Clock size={20} /><span><strong>个人定时任务</strong><small>每 {a.intervalSeconds >= 3600 ? `${a.intervalSeconds/3600} 小时` : `${a.intervalSeconds/60} 分钟`} · {({active:"已开启",paused:"已暂停",disabled:"已禁用",exhausted:"已结束",attention_required:"需要处理"})[a.state] || "状态待刷新"}</small></span><span>打开</span>
      </button>) : null}
      {canLoadTaskProcess ? <button
        className="message-task-process-button"
        disabled={taskProcessState === "loading"}
        type="button"
        onClick={async () => {
          setTaskProcessState("loading");
          const loaded = await onLoadTaskProcess().catch(() => false);
          setTaskProcessState(loaded ? "ready" : "error");
        }}
      >
        {taskProcessState === "loading" ? <><SpinnerGap className="spin" size={12} />正在加载任务过程</> :
          taskProcessState === "error" ? "任务过程加载失败，请重试" : "查看任务过程"}
      </button> : null}
      {message.role === "assistant" && message.toolConfirmations?.length ? (
        <div className="tool-confirmation-list">
          {message.toolConfirmations.map((confirmation) => (
            <ToolConfirmationCard key={confirmation.id} confirmation={confirmation} onConfirm={onConfirmToolCall} />
          ))}
        </div>
      ) : null}
      {message.role === "assistant" && message.authorizationActions?.length ? (
        <div className="tool-authorization-list">
          {message.authorizationActions.map((action) => (
            <CurrentUserAuthorizationCard action={action} key={`${action.url}-${action.expiresAt}`} onOpen={onOpenLink} />
          ))}
        </div>
      ) : null}
      {message.role === "assistant" && message.toolParameterCards?.length ? (
        <div className="tool-parameter-list">
          {message.toolParameterCards.map((card) => <ToolParameterCard card={card} key={card.id} onSubmit={onSubmitToolParameters} onDraftChange={onParameterDraftChange} busy={parameterBusy} />)}
        </div>
      ) : null}
      {message.attachments?.length ? <div className="message-local-files"><File size={14} />{message.attachments.length} 个文件{message.materialPrepared ? "已授权当前员工" : "已在本机授权"}</div> : null}
      {message.reusableMaterial ? <div className="message-local-files"><Stack size={14} />个人材料 · {message.reusableMaterial.fileName}</div> : null}
      {message.localNotice && !message.cardRecovery ? <span className="message-badge">本地提示</span> : null}
    </article>
  );
}

function CurrentUserAuthorizationCard({ action, onOpen }) {
  const [opened, setOpened] = useState(false);
  const expired = Date.parse(action.expiresAt || "") <= Date.now();

  async function openAuthorization() {
    if (expired || opened) return;
    setOpened(true);
    await onOpen?.(action.url);
  }

  return (
    <section className="tool-confirmation-card tool-authorization-card" aria-label="飞书个人授权">
      <div className="tool-confirmation-head">
        <span><ShieldCheck size={14} />飞书个人授权</span>
        <small>按需授权</small>
      </div>
      <strong>授权当前数字员工使用你的会议与妙记权限</strong>
      <button type="button" disabled={expired || opened} onClick={openAuthorization}>
        {expired ? "授权链接已过期" : opened ? "已打开飞书授权" : action.label}
      </button>
      {opened ? <small>授权后请重新发送请求。</small> : null}
    </section>
  );
}

function AssistantActivity({ activities = [] }) {
  const running = [...activities].reverse().find((activity) => activity.status === "running");
  const blocked = [...activities].reverse().find((activity) => activity.status === "blocked");
  const current = blocked || running || activities[activities.length - 1];
  const elapsedSeconds = useActivityElapsed(current);
  const toolCount = activities.filter((activity) => activity.kind === "tool").length;
  const summary = current?.status === "running"
    ? `${current.label} · ${formatActivityElapsed(elapsedSeconds)}`
    : current?.status === "blocked"
      ? current.label || "任务执行受阻"
      : toolCount
        ? `已调用工具执行了 ${toolCount} 个操作`
        : `已完成 ${activities.length} 个执行步骤`;
  return (
    <details className={`assistant-activity is-${current?.status || "done"}`}>
      <summary>
        <span className="assistant-activity-summary-icon" aria-hidden="true">
          {current?.status === "running" ? <SpinnerGap className="spin" size={14} /> : current?.status === "blocked" ? <WarningCircle size={14} weight="fill" /> : <Wrench size={14} />}
        </span>
        <strong>{summary}</strong>
        <CaretRight className="assistant-activity-caret" size={13} aria-hidden="true" />
      </summary>
      <div className="assistant-activity-list">
        {activities.map((activity) => (
          <div className={`assistant-activity-row is-${activity.status}`} key={activity.id}>
            {activity.status === "running" ? <SpinnerGap className="spin" size={13} /> : null}
            {activity.status === "blocked" ? <WarningCircle size={13} weight="fill" /> : null}
            {activity.status === "done" ? <CheckCircle size={13} /> : null}
            <span className="assistant-activity-row-copy">
              <span>{activity.label}</span>
              {activity.status === "running" ? <small>{activityWaitingDetail(activity.kind)} · 已等待 {formatActivityElapsed(elapsedSeconds)}</small> : null}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function useActivityElapsed(activity = null) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (activity?.status !== "running") return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity?.id, activity?.startedAt, activity?.status]);
  if (activity?.status !== "running") return 0;
  return Math.max(0, Math.floor((clock - Number(activity.startedAt || clock)) / 1000));
}

function activityWaitingDetail(kind = "runtime") {
  return {
    governance: "正在检查权限与运行门禁",
    model: "模型正在生成回复",
    stream: "正在接收模型回复",
    tool: "Tool 正在执行受控操作",
  }[kind] || "数字员工仍在处理中";
}

function formatActivityElapsed(seconds = 0) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  if (safeSeconds < 60) return `${safeSeconds} 秒`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

export function ToolConfirmationCard({ confirmation, onConfirm }) {
  const [clock, setClock] = useState(Date.now);
  const expiry = Date.parse(confirmation.expiresAt || "");
  useEffect(() => {
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return undefined;
    const timer = window.setTimeout(() => setClock(Date.now()), expiry - Date.now() + 20);
    return () => window.clearTimeout(timer);
  }, [expiry]);
  const presentation = toolConfirmationPresentation(confirmation, Math.max(clock, Date.now()));
  const rows = confirmationArgumentRows(confirmation.argumentSummary);
  return (
    <section className="tool-confirmation-card is-operation" aria-label="操作确认">
      <div className="tool-confirmation-head">
        <span><ShieldCheck size={14} />本次写操作</span>
        <small>{confirmation.risk === "high_impact_write" ? "高影响" : "受控"}</small>
      </div>
      <strong>{confirmation.displayName || confirmation.action || "受控 Tool 调用"}</strong>
      {rows.length ? <dl>{rows.map(([key, value]) => <div key={key}><dt>{confirmationFieldLabel(key)}</dt><dd>{value}</dd></div>)}</dl> : null}
      <button type="button" disabled={!presentation.pending || !onConfirm} onClick={() => onConfirm?.(confirmation)}>
        {presentation.label}
      </button>
      {confirmation.status === "submission_unknown" ? <small role="status">暂未收到提交结果，请核对任务状态；不会自动重复提交。</small> : null}
      <small>{Number.isFinite(expiry) ? `有效至 ${new Date(expiry).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ` : ""}仅本次执行；参数变更或重复操作需重新确认。</small>
    </section>
  );
}

function confirmationFieldLabel(path) {
  const labels = { projectID: "项目", workspaceID: "工作区", experimentID: "实验", experiment_no: "实验编号", name: "名称", datasetID: "数据集", version: "数据版本", gpu_count: "GPU 数量", batch_size: "Batch", max_iterations: "最大迭代" };
  return path.replace(/^(path|body|query)\./, "").split(".").map(part => labels[part] || part).join(" · ");
}

function confirmationArgumentRows(value, prefix = "", rows = []) {
  if (Array.isArray(value)) {
    if (!value.length) rows.push([prefix || "参数", "[]"]);
    value.forEach((item, index) => confirmationArgumentRows(item, `${prefix}[${index}]`, rows));
    return rows;
  }
  if (value && typeof value === "object") {
    if (!Object.keys(value).length) rows.push([prefix || "参数", "{}"]);
    Object.entries(value).forEach(([key, item]) => confirmationArgumentRows(item, prefix ? `${prefix}.${key}` : key, rows));
    return rows;
  }
  rows.push([prefix || "参数", String(value ?? "")]);
  return rows;
}

function linkify(text, onOpenLink) {
  const parts = String(text || "").split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => part.startsWith("http://") || part.startsWith("https://")
    ? <button type="button" className="inline-link" key={`${part}-${index}`} onClick={() => onOpenLink(part)}><LinkSimple size={13} />{part}</button>
    : <span key={`${part}-${index}`}>{part}</span>);
}
