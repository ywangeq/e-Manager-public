import { workbenchScheduledRules } from "../lib/workbenchAutomationScope.js";
import { isMaterialDrag } from "../lib/desktopPresentation.js";
import { EmployeeTaskActivity } from "./EmployeeTaskActivity.jsx";
import { workbenchTaskHistory } from "../lib/workbenchTaskHistory.js";
import { groupActivityDetails } from "../lib/groupActivityPresentation.js";
import { GroupAssignmentCapsule } from "./GroupAssignmentCapsule.jsx";
import { GroupDeliveryAcceptance } from "./GroupDeliveryAcceptance.jsx";
import { wrapGroupStudioApi } from "../lib/groupStudioBridge.js";
import { GroupReviewOpinions } from "./GroupReviewOpinions.jsx";
import { GroupReviewerConfigurator } from "./GroupReviewerConfigurator.jsx";
import { ArtifactDeliveryEntry } from "./ArtifactDeliveryEntry.jsx";
import { createGroupRunFollower } from "../lib/groupRunFollow.js";
import { GroupRunHistory } from "./GroupRunHistory.jsx";
import { PersonalAutomationsPanel } from "./PersonalAutomationsPanel.jsx";
import { TaskDetails } from "./MyTasksSheet.jsx";
import { MaximizeButton } from "./MaximizeButton.jsx";
import { mergeGroupHistory, runStatusLabel } from "../lib/groupRunHistory.js";
import { cockpitRecordTimeLabel } from "../lib/cockpitProgressPresentation.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  ArrowUp,
  Bell,
  ChatCircleDots,
  CaretDown,
  Check,
  CirclesFour,
  ClockCounterClockwise,
  Clock,
  DotsThree,
  FileText,
  Lightning,
  LinkSimple,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  Minus,
  Paperclip,
  Plus,
  Square,
  SlidersHorizontal,
  Sparkle,
  Stack,
  UsersThree,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { assignGroupMemberCanvasPositions, createGroupPreviewEdgeGeometry, groupMemberCanvasPositionsOverlap } from "../lib/projectGroupPreviewModel.js";
import { employeeCharacterFor } from "../data/employeeCharacters.js";
import { fetchGroupRunProjection } from "../lib/groupRunProjection.js";
import {
  GROUP_STUDIO_ACCESS_GROUPS,
  adoptGroupRunDemo,
  advanceGroupRun,
  resumeGroupRun,
  cancelGroupRun,
  cancelGroupPlanning,
  groupPlanningCancellationHandle,
  groupStudioMemberAccessGroup,
  selectGroupStudioMembers,
  selectGroupRunDemoMembers,
  reviewerConfigurationIssue,
  startGroupRunDemo,
} from "../lib/groupRunDemoFlow.js";
import { normalizeLocalAttachments } from "../../shared/desktop-attachments.mjs";
import { attachmentIntakeFeedback, attachmentKindLabel, browserFileRecords, formatFileSize } from "../lib/desktopPresentation.js";

const GROUP_NAV_ITEMS = [
  ["feed", "信息流", LinkSimple],
  ["activity", "活动", Lightning],
  ["chat", "聊天", ChatCircleDots],
  ["task_queue", "任务队列", ListChecks],
  ["library", "资料库", FileText],
  ["tools", "工具集", Wrench],
  ["outputs", "产出物", Stack],
  ["reviewers", "复核小组", UsersThree],
  ["automations", "定时任务", ClockCounterClockwise],
];

const GROUP_STATUS_LABELS = {
  pending: "等待 Center 绑定任务",
  queued: "排队中",
  running: "执行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  blocked: "受阻",
  rejected: "已拒绝",
  canceled: "已取消",
  timed_out: "已超时",
  lost: "已丢失",
};

function groupStatusLabel(status) {
  return GROUP_STATUS_LABELS[status] || "状态未知";
}

function groupSafeErrorMessage(error, fallback = "Center 请求失败") {
  const source = String(error?.code || error?.message || "").split(":").at(-1).trim();
  const code = source.match(/^[a-z][a-z0-9_]{2,100}$/i)?.[0] || "";
  return code ? `安全错误码：${code}` : fallback;
}

function historyGoalContext(item) {
  if (item?.review?.goal && item?.review?.groupVersion) return { goal: item.review.goal, groupVersion: item.review.groupVersion };
  if (item?.planning?.goal && item?.planning?.groupVersion) return { goal: item.planning.goal, groupVersion: item.planning.groupVersion };
  return null;
}

function reworkContext(item, history) {
  if (!item?.runId || !item.projection?.steps?.some(step => step.errorCode === "group_review_rejected")) return null;
  const latest = history.find(entry => entry.goalId === item.goalId);
  if (latest?.runId !== item.runId || !Number.isSafeInteger(item.goalRevision) ||
    !item.groupId || !Number.isSafeInteger(item.groupVersion)) return null;
  return { goal: { goalId: item.goalId, revision: item.goalRevision },
    groupVersion: { groupId: item.groupId, version: item.groupVersion } };
}

function retryMatchesGoalContext(retry, context) {
  const continuation = retry?.continuation;
  return Boolean(continuation && context?.goal && context?.groupVersion &&
    continuation.goalId === context.goal.goalId && continuation.expectedGoalRevision === context.goal.revision &&
    continuation.groupId === context.groupVersion.groupId && continuation.expectedGroupVersion === context.groupVersion.version);
}

function persistedHistoryRetry(item) {
  const retryId = item?.planning?.goal?.planningContext?.clientRequestId;
  if (!["failed", "planning"].includes(item?.status) || !item?.planning?.goal || item.planning?.planDraft || !retryId) return null;
  return {
    id: retryId, objective: "", retryOnly: true,
    continuation: { goalId: item.planning.goal.goalId, expectedGoalRevision: item.planning.goal.revision,
      groupId: item.planning.groupVersion?.groupId, expectedGroupVersion: item.planning.groupVersion?.version, retry: true },
    requestBody: { objective: "", retryOnly: true }, failed: true,
  };
}

function desktopGroupFetcher(api) {
  if (!api) return null;
  return async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    const decoded = decodeURIComponent(path);
    let result;
    if (path === "/api/group-studio/messages") result = await api.message({ body });
    else if (path === "/api/group-studio/planning-cancellations") result = await api.cancelPlanning({ body });
    else if (path === "/api/group-studio/goals") result = await api.goal({ body });
    else if (path === "/api/group-studio/group-versions") result = await api.groupVersion({ body });
    else if (path === "/api/group-studio/messages") result = await api.message({ body });
    else if (path === "/api/group-studio/plan-drafts") result = await api.planDraft({ body });
    else if (path === "/api/group-studio/plans/adopt") result = await api.adopt({ body });
    else if (path === "/api/group-studio/runs") result = await api.run({ body });
    else if (path.endsWith("/resume")) result = await api.resume({ runId: decoded.split("/").at(-2), expectedRevision: body?.expectedRevision });
    else if (path.endsWith("/cancel")) result = await api.cancel({ runId: decoded.split("/").at(-2), expectedRevision: body?.expectedRevision });
    else if (path.endsWith("/advance")) result = await api.advance({ runId: decoded.split("/").at(-2), expectedRevision: body?.expectedRevision });
    else throw new Error("desktop_group_route_not_allowed");
    return { ok: true, status: 200, json: async () => result };
  };
}

function GroupActivityRows({ items }) {
  return <div className="group-activity-details">{items.map(item => <article key={item.activityId}>
    <div><strong>#{item.sequence} {item.displayName}{item.operationCode ? ` · ${item.operationCode}` : ""}</strong>
      <small>{[item.subjectId, item.actionCode].filter(Boolean).join(" · ") || "具体操作暂无记录"}</small>
    </div><span>{item.statusLabel}</span>
  </article>)}</div>;
}

export function GroupEntryPanel({ activeNav, safeProjection, projectionError = "", members, composer, setComposer, onSend, onStop, onInspectArtifact, onDeliverArtifact, onOpenDraft, displayHistory = null, displayHistoryLoading = false, displayHistoryError = "", pendingTurn = null, canStop = false, stopping = false, composerEnabled = true, composerPlaceholder = "输入 Group 目标…", assignmentControl = null }) {
  const projectedSteps = safeProjection?.steps || [];
  const [expandedActivityGroups, setExpandedActivityGroups] = useState({});
  const activityGroups = useMemo(() => {
    const groups = new Map();
    (Array.isArray(safeProjection?.activities) ? safeProjection.activities : []).forEach((activity, index) => {
      if (!activity?.stepId || !activity?.taskId) return;
      const key = `${activity.stepId}:${activity.taskId}`;
      const group = groups.get(key) || { key, stepId: activity.stepId, taskId: activity.taskId, items: [], order: index };
      group.items.push(activity);
      groups.set(key, group);
    });
    return [...groups.values()].map(group => ({ ...group, items: group.items.sort((a, b) =>
      (a.kind === "task" ? 0 : 1) - (b.kind === "task" ? 0 : 1) || (a.sequence || 0) - (b.sequence || 0)) }));
  }, [safeProjection?.activities]);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [expandedStepId, setExpandedStepId] = useState("");
  const memberName = (employeeId) => members.find((member) => member.employeeId === employeeId)?.name || employeeId;
  if (activeNav === "chat") {
    return <div className="group-entry-panel group-entry-chat">
      <div className="group-entry-heading"><div><span>聊天</span><strong>当前目标对话</strong></div><small>逐轮规划答复 · 草案采纳后才会执行</small></div>
      <div className="group-chat-thread" aria-live="polite">
        {displayHistoryLoading && !displayHistory?.turns?.length ? <p className="group-chat-placeholder">正在读取本机对话…</p> : null}
        {displayHistoryLoading && displayHistory?.source === "encrypted_offline_cache" ? <p className="group-chat-placeholder">本机原文已显示，正在向 Center 核验规划状态…</p> : null}
        {displayHistoryError ? <p className="group-chat-warning" role="alert">对话暂不可用。{displayHistoryError}</p> : null}
        {displayHistory?.warning ? <p className="group-chat-warning">{displayHistory.warning}</p> : null}
        {(displayHistory?.turns || []).map((turn) => {
          const isOffline = displayHistory?.source === "encrypted_offline_cache" || Number.isSafeInteger(turn.localSequence);
          const centerRevision = isOffline ? null : turn.revision;
          const planningTurn = centerRevision === null ? null : (displayHistory?.planningTurns || []).find(item => item.revision === centerRevision);
          const isPending = centerRevision !== null && pendingTurn?.revision === centerRevision;
          const status = isPending ? pendingTurn.status : planningTurn?.planningStatus || "unverified";
          const stateLabel = status === "draft_ready" ? planningTurn?.result?.adopted ? "计划已采纳" : "计划草案待确认" : status === "planning" ? "正在规划" : status === "failed" ? "规划失败" : status === "canceled" ? "已取消" : status === "unknown" || status === "unverified" ? "状态待核验" : "状态不可用";
          const resultRevision = planningTurn?.result?.goalRevision;
          const answer = isOffline ? turn.localAnswer : planningTurn?.answer;
          const displayIndex = isOffline ? turn.revision || turn.localSequence : centerRevision;
          return <article className="group-chat-turn" key={`${isOffline ? "local" : "center"}:${displayIndex ?? "unknown"}:${turn.createdAt}`}>
            <div className="group-chat-user-message"><span>{isOffline ? turn.revision ? `你 · 第 ${turn.revision} 轮（本机）` : "本机记录" : `你 · 第 ${centerRevision} 轮`}</span><p>{turn.text}</p><time>{turn.createdAt ? new Date(turn.createdAt).toLocaleString() : "时间不可用"}</time><small className={`group-turn-status is-${status}`} role="status">{stateLabel}{status === "failed" && planningTurn?.errorCode ? ` · ${planningTurn.errorCode}` : ""}{resultRevision ? ` · 草案修订 ${resultRevision}` : ""}</small></div>
            {answer ? <div className="group-chat-planner-answer"><strong>{isOffline ? "本机保存的规划答复" : "规划师答复"}</strong><p>{isOffline ? answer : answer.understanding}</p>{!isOffline && answer.recommendations?.length ? <ul>{answer.recommendations.map(item => <li key={item.employeeId}><b>{memberName(item.employeeId)}</b> · {item.assignment} · {item.reason}</li>)}</ul> : null}{!isOffline && resultRevision && onOpenDraft ? <button type="button" onClick={() => onOpenDraft(centerRevision)}>查看本轮草案</button> : null}</div> : null}
          </article>;
        })}
        {pendingTurn && !displayHistory?.turns?.some(turn => turn.revision === pendingTurn.revision) ? <article className="group-chat-turn" key={`pending:${pendingTurn.goalId || "new"}:${pendingTurn.revision || pendingTurn.createdAt}`}><div className="group-chat-user-message is-pending"><span>{Number.isSafeInteger(pendingTurn.revision) ? `你 · 第 ${pendingTurn.revision} 轮` : "本机记录 · 本轮待确认"}</span><p>{pendingTurn.text}</p><time>{new Date(pendingTurn.createdAt).toLocaleString()}</time><small className={`group-turn-status is-${pendingTurn.status}`} role="status">{pendingTurn.status === "failed" ? "发送未确认" : pendingTurn.status === "canceled" ? "已取消" : "正在规划"}</small></div></article> : null}
        {!displayHistoryLoading && !displayHistoryError && !displayHistory?.turns?.length && !pendingTurn ? <div className="group-chat-placeholder"><ChatCircleDots size={24} /><strong>还没有对话</strong><span>发送目标后，原文与规划状态会留在这里。</span></div> : null}
      </div>
      <div className="group-composer workbench-composer has-assignment">{assignmentControl}<input value={composer} disabled={!composerEnabled && !canStop} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!canStop) onSend?.(); } }} placeholder={composerPlaceholder} /><button type="button" onClick={canStop ? onStop : onSend} aria-label={canStop ? (stopping ? "正在停止 Group" : "停止 Group") : "发送聊天消息"} disabled={stopping || (!canStop && !composerEnabled)}>{canStop ? <Square size={15} weight="fill" /> : <ArrowUp size={19} weight="bold" />}</button></div>
    </div>;
  }
  if (activeNav === "activity") {
    return <div className="group-entry-panel"><div className="group-entry-heading"><div><span>活动</span><strong>Center 安全活动</strong></div><small>按执行步骤归组 · 无时间推断</small></div>{activityGroups.length ? <div className="group-activity-groups">{activityGroups.map(group => {
      const taskState = group.items.find(item => item.kind === "task");
      const details = groupActivityDetails(group.items);
      const latest = details.at(-1);
      const expanded = expandedActivityGroups[group.key] === true;
      return <section className="group-activity-group" key={group.key}><header><div><strong>{group.stepId}</strong><span>{taskState ? groupStatusLabel(taskState.status) : "状态未知"}</span></div><p>{cockpitRecordTimeLabel({ kind: "task", item: taskState })}</p>{latest ? <p className="group-activity-latest">{latest.operationCode || latest.displayName} · {latest.statusLabel}</p> : null}{details.length ? <button type="button" aria-expanded={expanded} onClick={() => setExpandedActivityGroups(current => ({ ...current, [group.key]: !current[group.key] }))}>{expanded ? "收起明细" : `查看执行明细（${details.length}）`}</button> : null}</header>{expanded ? <GroupActivityRows items={details} /> : null}</section>;
    })}</div> : <div className="group-entry-empty"><Lightning size={24} /><strong>暂无活动记录</strong><p>Center 尚未提供此目标的安全活动投影。</p></div>}</div>;
  }
  if (activeNav === "task_queue") {
    return <div className="group-entry-panel"><div className="group-entry-heading"><div><span>任务队列</span><strong>员工工作步骤</strong></div><small>{safeProjection?.sourceAsOf ? `Center 更新于 ${safeProjection.sourceAsOf}` : "等待 Center Run 投影"}</small></div>{projectionError ? <p className="group-chat-warning" role="alert">执行状态刷新失败，以下记录仅为上次读取结果。{projectionError}</p> : null}{projectedSteps.length ? <div className="group-entry-list group-queue-list">{projectedSteps.map((step) => {
      const expanded = expandedStepId === step.stepId;
      const activities = groupActivityDetails((safeProjection?.activities || []).filter(item => item.stepId === step.stepId && item.taskId === step.taskId));
      const latest = activities.at(-1);
      return <article key={step.stepId} className="group-work-step"><button type="button" className="group-work-step-toggle" aria-expanded={expanded} onClick={() => setExpandedStepId(expanded ? "" : step.stepId)}><span><strong>{memberName(step.employeeId)}</strong><small>{step.stepId} · {step.kind === "delegate" ? "执行" : step.kind === "consult" ? "协助" : step.kind === "review" ? "复核" : "汇总"}</small><small>{cockpitRecordTimeLabel({ kind: "task", item: step })}</small></span><span className={`group-queue-status is-${step.status || "pending"}`}>{groupStatusLabel(step.status || "pending")}</span><CaretDown size={15} /></button>{expanded ? <div className="group-work-step-detail"><p><b>任务目标</b>{step.objective || "目标摘要暂不可用；请等待 Center 验证步骤引用。"}</p><p><b>依赖</b>{step.dependsOn?.length ? step.dependsOn.join("、") : "无前置步骤"}</p><div className="group-work-step-activities"><b>活动</b>{latest ? <details><summary>{latest.operationCode || latest.displayName} · {latest.statusLabel} · {activities.length} 次调用</summary><GroupActivityRows items={activities} /></details> : <span>{!step.taskId ? "待执行，暂无任务记录" : "暂无安全活动记录"}</span>}</div><p><b>结果</b>{step.resultSummary || (step.status === "completed" ? "任务已完成；摘要暂无记录" : "待执行结果")}</p>{(step.artifacts || []).map(artifact => <div key={artifact.artifactId} className="group-work-step-artifact"><span>{artifact.fileName}</span><ArtifactDeliveryEntry gate={{ ready: true, employeeId: step.employeeId, taskId: step.taskId, artifactId: artifact.artifactId }} inline onInspectArtifact={onInspectArtifact} onDeliverArtifact={onDeliverArtifact} /></div>)}</div> : null}</article>;
    })}</div> : <div className="group-entry-empty"><ListChecks size={24} /><strong>{safeProjection ? "暂无执行步骤" : "执行详情暂不可用"}</strong><p>{safeProjection ? "草案采纳并启动 Run 后，Center 会列出真实工作步骤。" : "尚未加载 Center 的 Run 投影；不能据此判断是否已执行。"}</p></div>}</div>;
  }
  if (activeNav === "reviewers") {
    const reviewerGroup = safeProjection?.reviewerGroup;
    return <div className="group-entry-panel"><div className="group-entry-heading"><div><span>复核小组 Reviewer Group</span><strong>GroupRun 执行门禁</strong></div><small>{reviewerGroup?.blocking ? "复核未完成，汇总步骤被阻塞" : reviewerGroup ? "复核已通过，可继续汇总" : "尚未配置复核小组"}</small></div>{reviewerGroup ? <div className="group-reviewer-panel">{reviewerGroup.members.map((member, index) => <article key={member.employeeId}><span className={`group-entry-status is-${member.status}`} /><div><strong>{members.find((item) => item.employeeId === member.employeeId)?.name || member.employeeId}</strong><p>{reviewerGroup.mode === "parallel" ? "并行复核" : `第 ${index + 1} 顺序复核`}{member.employeeId === reviewerGroup.finalReviewerEmployeeId ? " · 最终汇总 reviewer" : ""}</p><small>{member.opinionSummary || (member.status === "completed" ? "复核已完成，意见请查看产出物" : member.blockCode ? `安全错误码：${member.blockCode}` : "等待复核意见")}</small></div></article>)}</div> : <div className="group-entry-empty"><UsersThree size={24} /><strong>暂无复核小组</strong><p>在右侧成员详情中选择已加入 Group 的员工后配置复核。</p></div>}</div>;
  }
  if (activeNav === "outputs") {
    const artifacts = projectedSteps.flatMap((step) => (step.artifacts || []).map((artifact) => ({
      ...artifact,
      employeeId: step.employeeId,
      stepId: step.stepId,
      taskId: step.taskId,
    })));
    return <div className="group-entry-panel"><div className="group-entry-heading"><div><span>产出物</span><strong>Center Artifact 安全投影</strong></div><small>{safeProjection?.sourceAsOf ? `来源于 ${safeProjection.sourceAsOf}` : "等待 GroupRun 投影"}</small></div>{artifacts.length ? <div className="group-entry-list group-output-list">{artifacts.map((artifact) => {
      const selected = selectedArtifactId === artifact.artifactId;
      const gate = { ready: true, employeeId: artifact.employeeId, taskId: artifact.taskId, artifactId: artifact.artifactId };
      return <article key={artifact.artifactId}><button type="button" className="group-output-select" onClick={() => setSelectedArtifactId(selected ? "" : artifact.artifactId)} aria-expanded={selected}><Stack size={18} /><span><strong>{artifact.fileName}</strong><span>{artifact.stepId} · {memberName(artifact.employeeId)}</span><small>{artifact.mimeType} · {artifact.sizeBytes} bytes · 仅当前任务可见</small></span></button>{selected ? <ArtifactDeliveryEntry gate={gate} onInspectArtifact={onInspectArtifact} onDeliverArtifact={onDeliverArtifact} /> : null}</article>;
    })}</div> : <div className="group-entry-empty"><Stack size={24} /><strong>暂无产出物</strong><p>完成步骤并由 Center 发布 Artifact 后，这里会显示安全元数据。</p></div>}</div>;
  }
  const labels = { library: ["资料库", FileText], tools: ["工具集", Wrench] };
  const [label, Icon] = labels[activeNav] || labels.library;
  return <div className="group-entry-panel"><div className="group-entry-heading"><div><span>{label}</span><strong>{label}安全投影</strong></div><small>尚无对应 Center projection 字段</small></div><div className="group-entry-empty"><Icon size={24} /><strong>{label}尚未接入</strong><p>当前 Group safe projection 不包含{label}数据。接入前保持空态，不展示静态或推测内容。</p></div></div>;
}

export function ProjectGroupWorkspace({ runId = null, initialGoalId = "", onBack = null, onCollapse = null, desktopApi = null, employees = [], bootstrapReady = false, authenticated = false, onOpenEmployeeConversation = null, onSelectEmployeeConversation = null, renderEmployeeConversation = null, employeeConversationState = null, myTasks = null, automationSources = null }) {
  const groupApi = useMemo(() => wrapGroupStudioApi(desktopApi?.groupStudio), [desktopApi]);
  const groupFetcher = useMemo(() => desktopGroupFetcher(groupApi), [groupApi]);
  const [activeRunId, setActiveRunId] = useState(runId);
  const [selectedId, setSelectedId] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState(null);
  const [directEmployeeId, setDirectEmployeeId] = useState("");
  const [directTaskId, setDirectTaskId] = useState("");

  const seenParameterCardsRef = useRef(new Set());
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);
  const [manualLinks, setManualLinks] = useState([]);
  const [memberPositions, setMemberPositions] = useState({});
  const manualMemberPositionsRef = useRef({});
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [activeNav, setActiveNav] = useState("feed");
  useEffect(() => {
    if (!directEmployeeId || directEmployeeId !== employeeConversationState?.employeeId) return;
    const ids = employeeConversationState?.pendingCardIds || [];
    const unseen = ids.some(id => !seenParameterCardsRef.current.has(`${directEmployeeId}:${id}`));
    ids.forEach(id => seenParameterCardsRef.current.add(`${directEmployeeId}:${id}`));
    if (unseen) setActiveNav("feed");
  }, [directEmployeeId, employeeConversationState?.employeeId, employeeConversationState?.pendingCardIds?.join(",")]);
  const [notice, setNotice] = useState("");
  const [pendingPlan, setPendingPlan] = useState(null);
  const [planSheetOpen, setPlanSheetOpen] = useState(false);
  const [inspectedDraft, setInspectedDraft] = useState(null);
  const [safeProjection, setSafeProjection] = useState(null);
  const [projectionError, setProjectionError] = useState("");
  const [history, setHistory] = useState([]);
  const [historyKey, setHistoryKey] = useState(null);
  const [displayHistory, setDisplayHistory] = useState(null);
  const [displayHistoryLoading, setDisplayHistoryLoading] = useState(false);
  const [displayHistoryError, setDisplayHistoryError] = useState("");
  const [pendingTurn, setPendingTurn] = useState(null);
  const [newGoalIntent, setNewGoalIntent] = useState(false);
  const [reworkIntent, setReworkIntent] = useState("");
  const selectedHistory = history.find(item => item.key === historyKey);
  const taskHistory = useMemo(() => workbenchTaskHistory(history, myTasks?.page?.tasks || [], automationSources?.automationPhase === "ready" ? automationSources.automations : []), [history, myTasks?.page, automationSources?.automations, automationSources?.automationPhase]);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState("");
  useEffect(() => { setTitleEditing(false); setTitleError(""); }, [historyKey]);
  async function saveTitle(event) {
    event.preventDefault();
    const goalId = selectedHistory?.goalId;
    if (!goalId || titleSaving || !titleDraft.trim()) return;
    const generation = viewGenerationRef.current;
    setTitleSaving(true); setTitleError("");
    historyRequestRef.current += 1;
    try {
      const input = { goalId, title: titleDraft.trim(), expectedDisplayRevision: selectedHistory.displayRevision || 0 };
      const result = groupApi?.renameGoal ? await groupApi.renameGoal(input) : await fetch(`/api/group-studio/goals/${encodeURIComponent(goalId)}/title`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title, expectedDisplayRevision: input.expectedDisplayRevision }) }).then(response => response.json());
      if (!result?.ok) throw Object.assign(new Error("group_title_failed"), { code: result?.error });
      if (generation !== viewGenerationRef.current) return;
      historyRequestRef.current += 1;
      setHistory(current => current.map(item => item.goalId === goalId ? { ...item, title: result.title, displayRevision: result.displayRevision } : item));
      setTitleEditing(false);
    } catch (error) { if (generation === viewGenerationRef.current) setTitleError(error?.code === "group_title_conflict" ? "名称已被更新，请刷新后重试。" : "名称保存失败，请重试。"); }
    finally { setTitleSaving(false); }
  }
  const selectedDirectTask = taskHistory.find(item => item.kind === "employee" && item.taskId === directTaskId);
  const selectedStatus = runStatusLabel(safeProjection?.status || selectedHistory?.status);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planningCancelState, setPlanningCancelState] = useState("idle");
  const selectedRework = reworkContext(selectedHistory, history);
  const composerEnabled = Boolean((newGoalIntent || selectedHistory) && (!activeRunId || (selectedRework && reworkIntent === activeRunId)));
  const composerPlaceholder = selectedRework && reworkIntent === activeRunId ? "输入返工目标，提交新一轮计划草案…" : activeRunId ? "当前目标在此阶段暂不支持修改" : newGoalIntent ? "输入新的 Group 目标…" : selectedHistory ? "补充当前目标…" : "请先选择目标或点击右上角＋";
  const objectiveStatus = planningCancelState === "confirmed" ? "已停止，正在同步" : busy && !activeRunId ? "正在生成计划" : pendingPlan ? "计划待确认" : selectedHistory || activeRunId ? selectedStatus : newGoalIntent ? "新建目标" : "等待选择目标";
  const runCanStop = Boolean(activeRunId && !(selectedRework && reworkIntent === activeRunId) && safeProjection?.activation === "active" && !safeProjection?.cancellationRequested && ["running", "blocked", "awaiting_review", "awaiting_acceptance", "execution_completed"].includes(safeProjection?.status));

  const inspectGroupArtifact = (reference) => desktopApi?.getArtifactDelivery
    ? desktopApi.getArtifactDelivery({ employeeId: reference.employeeId, taskId: reference.taskId, artifactId: reference.artifactId })
      .catch(() => ({ ok: false, status: "network_unavailable" }))
    : Promise.resolve({ ok: false, status: "service_unavailable" });
  const deliverGroupArtifact = (reference) => desktopApi?.deliverArtifact
    ? desktopApi.deliverArtifact({ employeeId: reference.employeeId, taskId: reference.taskId, artifactId: reference.artifactId, action: reference.action })
      .catch(() => ({ ok: false, status: "network_unavailable" }))
    : Promise.resolve({ ok: false, status: "service_unavailable" });

  const historyRequestRef = useRef(0);
  const initialHistoryResolvedRef = useRef(false);
  const initialGoalSelectedRef = useRef(false);
  const displayHistoryRequestRef = useRef(0);
  const displayHistoryRef = useRef(null);
  const pendingTurnRef = useRef(null);
  const viewGenerationRef = useRef(0);
  const deletingHistoryRef = useRef(false);
  async function loadDisplayHistory(goalId) {
    const requestId = ++displayHistoryRequestRef.current;
    displayHistoryRef.current = null;
    const currentPendingTurn = pendingTurn?.goalId === goalId ? pendingTurn : null;
    pendingTurnRef.current = currentPendingTurn;
    if (pendingTurn && !currentPendingTurn) setPendingTurn(null);
    setDisplayHistoryLoading(true); setDisplayHistoryError("");
    let shownLocalHistory = null;
    try {
      if (groupApi?.displayHistory) {
        const local = await groupApi.displayHistory({ goalId, localOnly: true });
        if (requestId !== displayHistoryRequestRef.current) return;
        if (local?.goalId === goalId && local?.ok && local.conversation?.contractVersion === "group-goal-display-history.v1" && Array.isArray(local.conversation.turns)) {
          shownLocalHistory = local.conversation;
          displayHistoryRef.current = local.conversation;
          setDisplayHistory(local.conversation);
          setPendingTurn(current => {
            const next = current?.goalId === goalId && local.conversation.turns.some(turn => turn.revision === current.revision) ? null : current;
            pendingTurnRef.current = next;
            return next;
          });
        }
      }
      const result = groupApi?.displayHistory
        ? await groupApi.displayHistory({ goalId })
        : await fetch(`/api/group-studio/goals/${encodeURIComponent(goalId)}/display-history`, { credentials: "same-origin" }).then(response => response.json());
      if (requestId !== displayHistoryRequestRef.current || result?.goalId !== goalId) return;
      if (!result?.ok || result.conversation?.contractVersion !== "group-goal-display-history.v1" || !Array.isArray(result.conversation.turns)) {
        if (["center_tombstone", "center_access_denied"].includes(result?.status)) {
          displayHistoryRef.current = null; pendingTurnRef.current = null;
          setDisplayHistory(null); setPendingTurn(null);
        }
        else if (!shownLocalHistory?.turns?.length && !pendingTurnRef.current) setDisplayHistoryError(groupSafeErrorMessage(result?.status || "group_history_unavailable", "安全错误码：group_history_unavailable"));
        return;
      }
      displayHistoryRef.current = result.conversation;
      setDisplayHistory(result.conversation);
      setPendingTurn(current => {
        const next = current?.goalId === goalId && result.conversation.turns.some(turn => turn.revision === current.revision) ? null : current;
        pendingTurnRef.current = next;
        return next;
      });
    } catch (error) {
      if (requestId === displayHistoryRequestRef.current && !shownLocalHistory?.turns?.length && !pendingTurnRef.current) setDisplayHistoryError(groupSafeErrorMessage(error, "安全错误码：group_history_unavailable"));
    } finally { if (requestId === displayHistoryRequestRef.current) setDisplayHistoryLoading(false); }
  }
  useEffect(() => {
    const goalId = selectedHistory?.goalId;
    if (!authenticated || !goalId) {
      displayHistoryRequestRef.current += 1;
      displayHistoryRef.current = null; pendingTurnRef.current = null;
      setDisplayHistory(null); setDisplayHistoryError(""); setDisplayHistoryLoading(false);
      setPendingTurn(null);
      return undefined;
    }
    displayHistoryRef.current = null; pendingTurnRef.current = null;
    setDisplayHistory(null); setPendingTurn(null); setDisplayHistoryError(""); setDisplayHistoryLoading(true);
    void loadDisplayHistory(goalId);
    return () => { displayHistoryRequestRef.current += 1; };
  }, [authenticated, desktopApi, groupApi, selectedHistory?.goalId, selectedHistory?.planning?.goal?.revision]);
  useEffect(() => { pendingTurnRef.current = pendingTurn; }, [pendingTurn]);
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setLeftRailCollapsed((current) => !current);
      }
    };
    if (!window.addEventListener) return undefined;
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  async function refreshHistory() {
    if (deletingHistoryRef.current) return;
    const request = ++historyRequestRef.current;
    setHistoryLoading(true);
    try {
      const body = groupApi?.history
        ? await groupApi.history()
        : await fetch("/api/group-studio/history", { credentials: "same-origin" }).then(res => res.json());
      if (request !== historyRequestRef.current) return;
      if (!body?.ok || !Array.isArray(body.items)) throw new Error("group_history_unavailable");
      if (!initialHistoryResolvedRef.current) {
        initialHistoryResolvedRef.current = true;
        setNewGoalIntent(true);
      }
      setHistory(current => mergeGroupHistory(current, body.items));
      setHistoryError("");
    } catch (error) { if (request === historyRequestRef.current) setHistoryError(groupSafeErrorMessage(error, "安全错误码：group_history_unavailable")); }
    finally { if (request === historyRequestRef.current) setHistoryLoading(false); }
  }
  useEffect(() => {
    if (!authenticated) {
      initialHistoryResolvedRef.current = false;
      setHistory([]); setHistoryKey(null); setActiveRunId(null); setPendingPlan(null); setSafeProjection(null); setNewGoalIntent(false); setReworkIntent("");
      return undefined;
    }
    void refreshHistory();
    const timer = window.setInterval(refreshHistory, 10000);
    return () => { historyRequestRef.current += 1; viewGenerationRef.current += 1; materialGenerationRef.current += 1; materialSelectionRef.current += 1; window.clearInterval(timer); };
  }, [authenticated, desktopApi]);
  async function deleteHistory(item) {
    if (busy || submittingRef.current || deletingHistoryRef.current) return;
    deletingHistoryRef.current = true;
    submittingRef.current = true;
    setBusy(true);
    historyRequestRef.current += 1;
    try {
      if (item.goalId) {
        const result = groupApi?.deleteHistory
          ? await groupApi.deleteHistory({ goalId: item.goalId })
          : await fetch(`/api/group-studio/history/${encodeURIComponent(item.goalId)}`, { method: "DELETE", credentials: "same-origin" }).then(response => response.json());
        if (!result?.ok) throw new Error("group_history_delete_failed");
      }
      historyRequestRef.current += 1;
      setHistory(current => current.filter(entry => item.goalId ? entry.goalId !== item.goalId : entry.key !== item.key));
      if (item.goalId ? selectedHistory?.goalId === item.goalId || historyKey === item.key : historyKey === item.key) {
        setDisplayHistory(null); setPendingTurn(null);
        viewGenerationRef.current += 1;
        materialGenerationRef.current += 1; materialSelectionRef.current += 1;
        draftContextRef.current = null;
        setGroupAttachments([]); setGroupMaterialState(null); setGroupAttachmentFeedback(null);
        setHistoryKey(null); setActiveRunId(null); setSafeProjection(null); setPendingPlan(null); setNewGoalIntent(false);
      }
      announce("已隐藏历史记录；执行记录仍由 Center 保留");
    } catch (error) { announce(`隐藏失败，历史记录已保留：${groupSafeErrorMessage(error)}`); }
    finally { deletingHistoryRef.current = false; submittingRef.current = false; setBusy(false); setHistoryLoading(false); }
  }
  function selectHistory(item) {
    if (!item || submittingRef.current || item.key === historyKey || (directEmployeeId && employeeConversationState?.locked)) return;
    if (item.kind === "employee") {
      if (!onSelectEmployeeConversation?.({ employeeId: item.employeeId })) { announce("该员工当前不可用，无法打开任务记录"); return; }
      viewGenerationRef.current += 1;
      materialGenerationRef.current += 1; materialSelectionRef.current += 1;
      setGroupAttachments([]); setGroupMaterialState(null); setGroupAttachmentFeedback(null);
      setManualLinks([]); setGroupMemberIds(new Set([item.employeeId])); setSelectedId(item.employeeId);
      setReviewerIds([]); setReviewerTeam(null); setFinalReviewerId("");
      draftContextRef.current = null; planningRequestRef.current = null; retryRequestRef.current = null;
      setReworkIntent("");
      setHistoryKey(null); setActiveRunId(null); setSafeProjection(null); setPendingPlan(null);
      setPlanSheetOpen(false); setInspectedDraft(null); setPendingTurn(null);
      setDirectEmployeeId(item.employeeId); setDirectTaskId(item.taskId); setActiveNav("activity");
      return;
    }
    setDirectTaskId("");
    setDirectEmployeeId("");
    onSelectEmployeeConversation?.({ employeeId: "" });
    const persistedRetry = persistedHistoryRetry(item);
    viewGenerationRef.current += 1;
    materialGenerationRef.current += 1; materialSelectionRef.current += 1;
    draftContextRef.current = item.review ? { objective: item.objective || "", inputRefs: item.review.draft?.inputRefs || [] } : null;
    setPendingTurn(null);
    setGroupAttachments([]); setGroupMaterialState(null); setGroupAttachmentFeedback(null);
    setManualLinks([]); setGroupMemberIds(new Set()); planningRequestRef.current = null; retryRequestRef.current = null;
    if (persistedRetry) retryRequestRef.current = persistedRetry;
    setNewGoalIntent(false); setReworkIntent("");
    setHistoryKey(item.key);
    setPendingPlan(item.review || null);
    setPlanSheetOpen(false); setInspectedDraft(null); setProjectionError("");
    setSafeProjection(item.projection || null);
    setActiveRunId(item.runId || null);
    const review = item.projection?.reviewerGroup || item.review?.groupVersion?.reviewerGroup;
    setReviewerIds(review?.members?.map(member => member.employeeId) || []);
    setReviewerTeam(review ? { displayName: review.displayName || "复核小组", status: "未开始" } : null);
    setReviewerMode(review?.mode || "single");
    setFinalReviewerId(review?.finalReviewerEmployeeId || "");
  }
  useEffect(() => {
    if (!authenticated || !initialGoalId || initialGoalSelectedRef.current) return;
    const target = history.find((item) => item.goalId === initialGoalId);
    if (!target) return;
    initialGoalSelectedRef.current = true;
    selectHistory(target);
  }, [authenticated, history, initialGoalId]);
  const [composer, setComposer] = useState("");
  const [groupAttachments, setGroupAttachments] = useState([]);
  const [groupAttachmentFeedback, setGroupAttachmentFeedback] = useState(null);
  const [groupMaterialState, setGroupMaterialState] = useState(null);
  const [reviewerMode, setReviewerMode] = useState("single");
  const [reviewerIds, setReviewerIds] = useState([]);
  const [finalReviewerId, setFinalReviewerId] = useState("");
  const [reviewerTeam, setReviewerTeam] = useState(null);
  const [windowExpanded, setWindowExpanded] = useState(true);
  const groupDragRef = useRef(null);
  useEffect(() => onBack ? undefined : desktopApi?.onWindowState?.((state) => setWindowExpanded(state?.expanded === true)), [desktopApi, onBack]);
  function beginGroupWindowDrag(event) {
    if (!desktopApi?.beginWindowDrag || event.button !== 0) return;
    groupDragRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    desktopApi.beginWindowDrag({ x: event.screenX, y: event.screenY });
  }
  function moveGroupWindowDrag(event) {
    if (groupDragRef.current?.pointerId !== event.pointerId) return;
    desktopApi?.moveWindowDrag?.({ x: event.screenX, y: event.screenY });
  }
  function endGroupWindowDrag(event) {
    if (groupDragRef.current?.pointerId !== event.pointerId) return;
    groupDragRef.current = null;
    desktopApi?.endWindowDrag?.();
  }
  const [groupDragActive, setGroupDragActive] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 600 });
  const canvasRef = useRef(null);
  const memberRailRef = useRef(null);
  const reviewerCardRef = useRef(null);
  const reviewerOrbitRef = useRef(null);
  const materialGenerationRef = useRef(0);
  const materialSelectionRef = useRef(0);
  const draftContextRef = useRef(null);
  const suppressNodeClickRef = useRef(false);
  const [memberRemovalTarget, setMemberRemovalTarget] = useState(false);
  const groupFileInputRef = useRef(null);
  const groupDragDepthRef = useRef(0);
  const dragRef = useRef(null);
  const submittingRef = useRef(false);
  const planningRequestRef = useRef(null);
  const planningCancelRef = useRef(null);
  const retryRequestRef = useRef(null);
  const activeSteps = safeProjection?.steps || pendingPlan?.plan?.steps || [];
  const bootstrapMembers = useMemo(() => (bootstrapReady ? selectGroupStudioMembers(employees) : []), [bootstrapReady, employees]);
  const memberRecords = useMemo(() => {
    let projectedRecords = [];
    if (Array.isArray(safeProjection?.members) && safeProjection.members.length) {
      projectedRecords = safeProjection.members.map((member) => ({
        employeeId: member.employeeId,
        employeeVersion: member.employeeVersion,
        coordinator: member.coordinator === true,
        status: member.status || "pending",
      })).filter((member) => member.employeeId);
    } else if (safeProjection?.steps?.length) {
      const priority = { completed: 0, pending: 1, queued: 2, waiting: 3, running: 4, failed: 5, blocked: 5, rejected: 5, canceled: 5, timed_out: 5, lost: 5 };
      const byMember = new Map();
      safeProjection.steps.forEach((step) => {
        if (!step.employeeId) return;
        const key = `${step.employeeId}:${step.employeeVersion || ""}`;
        const current = byMember.get(key);
        const status = step.status || "pending";
        if (!current || (priority[status] || 0) >= (priority[current.status] || 0)) byMember.set(key, { employeeId: step.employeeId, employeeVersion: step.employeeVersion, status });
      });
      projectedRecords = [...byMember.values()];
    } else if (pendingPlan?.groupVersion?.members?.length) {
      projectedRecords = pendingPlan.groupVersion.members.map((member) => ({ employeeId: member.employeeId, employeeVersion: member.employeeVersion, coordinator: member.coordinator === true, status: "计划成员" }));
    }
    if (!bootstrapMembers.length) return projectedRecords;
    const projectedByKey = new Map(projectedRecords.map((member) => [`${member.employeeId}:${member.employeeVersion || ""}`, member]));
    return bootstrapMembers.map((employee) => projectedByKey.get(`${employee.id}:${employee.version}`) || ({ employeeId: employee.id, employeeVersion: employee.version }));
  }, [bootstrapMembers, pendingPlan, safeProjection]);
  const members = useMemo(() => memberRecords.map((record, index) => {
    const employee = employees.find((item) => item.id === record.employeeId && (!record.employeeVersion || item.version === record.employeeVersion));
    const character = employee ? employeeCharacterFor(employee) : null;
    const accessGroup = employee ? groupStudioMemberAccessGroup(employee) : "unavailable";
    const accessLabel = GROUP_STUDIO_ACCESS_GROUPS.find((group) => group.id === accessGroup)?.label || "当前不可用";
    return {
      id: record.employeeId, employeeId: record.employeeId, employeeVersion: record.employeeVersion || "", name: employee?.name || record.employeeId, role: employee?.title || employee?.department || "账号可用员工",
      status: record.status || (activeRunId || pendingPlan ? employee?.status || "待执行" : accessLabel), accessGroup, coordinator: record.coordinator === true,
      accent: ["cyan", "violet", "amber", "teal"][index % 4], tools: employee?.tools || [], avatar: character?.staticSrc || "",
    };
  }), [activeRunId, employees, memberRecords, pendingPlan]);
  const memberGroups = useMemo(() => GROUP_STUDIO_ACCESS_GROUPS.map((group) => ({
    ...group,
    members: members.filter((member) => member.accessGroup === group.id),
  })).filter((group) => group.members.length), [members]);
  const projectedSteps = safeProjection?.steps || [];
  const canvasMemberIds = useMemo(() => new Set(directEmployeeId ? [directEmployeeId] : [
    ...activeSteps.map((step) => step.employeeId),
    ...(safeProjection?.members || []).map((member) => member.employeeId),
    ...((activeSteps.length || pendingPlan) ? [] : (groupMemberIds || [])),
  ].filter(Boolean)), [activeSteps, pendingPlan, safeProjection, groupMemberIds, directEmployeeId]);
  const canvasMembers = members.filter((member) => canvasMemberIds.has(member.employeeId));
  const automationTaskIds = directEmployeeId
    ? [directTaskId || (employeeConversationState?.employeeId === directEmployeeId ? employeeConversationState.taskId : "")].filter(Boolean)
    : (safeProjection?.steps || []).map(step => step.taskId).filter(Boolean);
  const currentScheduledRules = workbenchScheduledRules(automationSources?.automationPhase === "ready" ? automationSources.automations || [] : [], { employeeIds: [...canvasMemberIds], taskIds: automationTaskIds });
  useEffect(() => { if (directEmployeeId && employeeConversationState?.employeeId === directEmployeeId && employeeConversationState.busy) setDirectTaskId(""); }, [directEmployeeId, employeeConversationState?.employeeId, employeeConversationState?.busy, employeeConversationState?.taskId]);
  const reviewerGroup = reviewerIds.length ? { ...(reviewerTeam?.reviewerGroupId ? { reviewerGroupId: reviewerTeam.reviewerGroupId, displayName: reviewerTeam.displayName } : {}), mode: reviewerMode, members: reviewerIds.map((employeeId, order) => { const employee = members.find((item) => item.employeeId === employeeId); return { employeeId, employeeVersion: employee?.employeeVersion || "", order }; }), finalReviewerEmployeeId: finalReviewerId } : null;
  const reviewerIssue = reviewerConfigurationIssue({ reviewerIds, mode: reviewerMode, finalReviewerEmployeeId: finalReviewerId });
  const assignmentLocked = Boolean((directEmployeeId && employeeConversationState?.locked) || busy || selectedHistory || activeRunId || pendingPlan || groupAttachments.length || reviewerIds.length || manualLinks.length);
  const assignmentLockReason = directEmployeeId && employeeConversationState?.locked
    ? "请先完成材料准备或移除已选择的材料，再切换员工"
    : selectedHistory || activeRunId || pendingPlan || busy
    ? "当前目标的安排已固定；新建目标后可重新选择"
    : "请先移除材料、复核或手工关联，再切换安排方式";
  const fixedMembers = safeProjection?.members?.length ? safeProjection.members : historyGoalContext(selectedHistory)?.groupVersion?.members || safeProjection?.steps;
  const assignmentMemberIds = fixedMembers?.length ? new Set(fixedMembers.map(member => member.employeeId))
    : safeProjection?.steps?.length ? new Set(safeProjection.steps.map(step => step.employeeId)) : groupMemberIds;
  function chooseAssignment(employeeId) {
    if (assignmentLocked || submittingRef.current) return;
    if (employeeId && !bootstrapMembers.some(employee => employee.id === employeeId && groupStudioMemberAccessGroup(employee) === "direct")) return;
    const draftText = directEmployeeId ? employeeConversationState?.draftText || "" : composer;
    if (!newGoalIntent) createNewGroupGoal();
    if (employeeId && onSelectEmployeeConversation && renderEmployeeConversation) {
      if (!onSelectEmployeeConversation({ employeeId, text: draftText })) { announce("该员工暂不可用，请刷新员工状态"); return; }
    }
    materialGenerationRef.current += 1; materialSelectionRef.current += 1;
    setGroupMemberIds(employeeId ? new Set([employeeId]) : null);
    if (employeeId) setSelectedId(employeeId);
    planningRequestRef.current = null; retryRequestRef.current = null;
    if (onSelectEmployeeConversation && renderEmployeeConversation) {
      setDirectTaskId("");
      setDirectEmployeeId(employeeId || "");
      setActiveNav(employeeId ? "feed" : "chat");
      if (employeeId) setComposer("");
      else { setComposer(draftText); onSelectEmployeeConversation({ employeeId: "" }); }
      announce(employeeId ? "已安排当前员工直接处理；发送后开始执行" : "将按目标自动推荐合适员工");
    } else if (employeeId && onOpenEmployeeConversation) {
      if (onOpenEmployeeConversation({ employeeId, text: composer })) setComposer("");
      announce("已打开员工会话；发送后由员工直接处理。项目组协作仍使用计划草案。");
    } else announce(employeeId ? "本目标将交给所选员工规划处理；发送前不会执行" : "将按目标自动推荐合适员工");
  }
  const assignmentControl = <GroupAssignmentCapsule employees={bootstrapMembers} memberIds={assignmentMemberIds} fixedMembers={fixedMembers} locked={assignmentLocked} lockReason={assignmentLockReason} onChoose={chooseAssignment} />;
  function editTeam() {
    if (directEmployeeId) { announce("请先切换为自动安排，再配置项目组"); return false; }
    if (busy || activeRunId) { announce("已提交或正在规划的团队不能修改，请新建目标"); return false; }
    if (pendingPlan && !draftContextRef.current?.objective) { announce("历史草案仅有标题，不能代替完整目标重新规划；原草案已保留"); return false; }
    setGroupMemberIds(new Set(canvasMemberIds));
    if (pendingPlan && draftContextRef.current) {
      setComposer(draftContextRef.current.objective || "");
      const refs = draftContextRef.current.inputRefs || [];
      if (refs.length && !groupMaterialState) setGroupMaterialState({ status: "ready", inputRefs: refs, fileCount: 0, totalBytes: 0 });
    }
    setPendingPlan(null);
    planningRequestRef.current = null;
    return true;
  }
  function addReviewerMember(id) {
    const member = members.find((item) => item.employeeId === id);
    if (!member || member.accessGroup !== "direct") return;
    if (reviewerIds.includes(id)) return;
    if (!editTeam()) return;
    setGroupMemberIds(new Set([...canvasMemberIds, id]));
    setReviewerIds((current) => [...current, id]);
    if (!finalReviewerId || !reviewerIds.includes(finalReviewerId)) setFinalReviewerId(reviewerIds[0] || id);
    if (!reviewerIds.length) setReviewerMode("single");
    if (reviewerIds.length === 1 && reviewerMode === "single") setReviewerMode("sequential");
    setReviewerTeam((current) => current || ({ reviewerGroupId: `reviewer-team-${Date.now()}`, displayName: "Reviewer Group", status: "未开始" }));
    announce("已加入 Reviewer Group；不会自动启动执行");
  }
  function removeReviewerMember(id) {
    if (!editTeam()) return;
    const removesLastReviewer = reviewerIds.length === 1 && reviewerIds[0] === id;
    const remaining = reviewerIds.filter(value => value !== id);
    setReviewerIds(remaining);
    if (removesLastReviewer) setReviewerTeam(null);
    if (finalReviewerId === id || removesLastReviewer) setFinalReviewerId(remaining[0] || "");
    if (remaining.length === 1) setReviewerMode("single");
  }
  function changeReviewerMode(mode) {
    if (!editTeam()) return;
    setReviewerMode(mode);
  }
  function changeFinalReviewer(id) {
    if (!editTeam()) return;
    setFinalReviewerId(id);
  }
  function moveReviewer(from, to) {
    if (from === to || to < 0 || to >= reviewerIds.length || !editTeam()) return;
    setReviewerIds(current => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }
  const edges = useMemo(() => {
    const projected = activeSteps.flatMap((step) => (step.dependsOn || []).map((dependencyId) => ({
      from: activeSteps.find((candidate) => candidate.stepId === dependencyId)?.employeeId,
      to: step.employeeId,
      type: step.kind === "review" ? "review" : "handoff",
      label: step.kind === "review" ? "复核" : "顺序交接",
    })));
    const unique = new Map();
    for (const edge of [...manualLinks, ...projected]) {
      if (edge.from !== edge.to && canvasMemberIds.has(edge.from) && canvasMemberIds.has(edge.to)) {
        unique.set(`${edge.from}:${edge.to}:${edge.type}`, edge);
      }
    }
    return [...unique.values()];
  }, [activeSteps, manualLinks, canvasMemberIds]);
  const selected = members.find((member) => member.id === selectedId) || members[0] || { id: "", name: "尚未选择成员", role: "创建 Group 目标后显示账号可用成员", status: "待创建", accent: "cyan", avatar: "" };
  const relatedIds = useMemo(() => new Set(edges.flatMap(({ from, to }) => from === selectedId ? [to] : to === selectedId ? [from] : [])), [edges, selectedId]);
  const layoutPositions = useMemo(() => {
    const positions = { ...manualMemberPositionsRef.current };
    if (directEmployeeId && !positions[directEmployeeId]) {
      positions[directEmployeeId] = canvasSize.width < 440 ? { x: 50, y: 20 } : { x: 22, y: 50 };
    }
    return assignGroupMemberCanvasPositions(canvasMembers, positions, {
      canvasWidth: canvasSize.width, canvasHeight: canvasSize.height,
    });
  }, [canvasMembers, memberPositions, canvasSize, canvasZoom, directEmployeeId]);
  const viewPositions = useMemo(() => Object.fromEntries(Object.entries(layoutPositions).map(([id, point]) => [id, {
    x: 50 + (point.x - 50) * canvasZoom, y: 50 + (point.y - 50) * canvasZoom,
  }])), [layoutPositions, canvasZoom]);
  const edgeGeometry = useMemo(() => edges
    .map((edge) => createGroupPreviewEdgeGeometry(edge, viewPositions))
    .filter(Boolean), [edges, viewPositions]);
  useEffect(() => {
    if (members.length && !members.some((member) => member.id === selectedId)) setSelectedId(members[0].id);
  }, [members, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setCanvasSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeRunId) { setSafeProjection(null); setProjectionError(""); return undefined; }
    const generation = viewGenerationRef.current;
    const controller = new AbortController();
    const follower = createGroupRunFollower({
      readProjection: () => fetchGroupRunProjection({ runId: activeRunId, signal: controller.signal, requester: groupApi?.projection }),
      advance: args => advanceGroupRun({ ...args, ...(groupFetcher ? { fetcher: groupFetcher } : {}) }),
    });
    const refresh = () => follower.refresh().then(projection => { if (projection && !controller.signal.aborted && generation === viewGenerationRef.current) { setProjectionError(""); setSafeProjection(projection); setHistory(current => current.map(item => item.runId === projection.runId ? { ...item, projection } : item)); } })
      .catch(error => { if (!controller.signal.aborted && generation === viewGenerationRef.current) setProjectionError(groupSafeErrorMessage(error, "Center 暂不可用")); });
    refresh();
    const timer = window.setInterval(refresh, 1200);
    return () => { follower.stop(); controller.abort(); window.clearInterval(timer); };
  }, [activeRunId, desktopApi]);

  useEffect(() => {
    const projected = safeProjection?.reviewerGroup;
    if (!projected) return;
    setReviewerTeam((current) => ({
      reviewerGroupId: projected.reviewerGroupId || current?.reviewerGroupId || "reviewer-team-projected",
      displayName: projected.displayName || current?.displayName || "临时复核小组",
      status: projected.status === "approved" ? "复核已通过" : projected.status === "failed" ? "复核未通过" : runStatusLabel(safeProjection.status),
    }));
    setReviewerIds(projected.members.map((member) => member.employeeId));
    setFinalReviewerId(projected.finalReviewerEmployeeId || projected.members.at(-1)?.employeeId || "");
    setReviewerMode(projected.mode || "single");
  }, [safeProjection]);

  function announce(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  function removeGroupMember(id) {
    if (activeRunId && (activeSteps.some((step) => step.employeeId === id) || safeProjection?.members?.some((member) => member.employeeId === id))) {
      announce("该员工属于已提交运行，不能直接移出或改写执行计划");
      return;
    }
    if (!editTeam()) return;
    const affectsPlan = Boolean(pendingPlan);
    const remainingReviewers = reviewerIds.filter(value => value !== id);
    setReviewerIds(remainingReviewers);
    if (finalReviewerId === id) setFinalReviewerId(remainingReviewers[0] || "");
    if (remainingReviewers.length === 1) setReviewerMode("single");
    if (reviewerIds.length === 1 && reviewerIds.includes(id)) setReviewerTeam(null);
    setGroupMemberIds(new Set([...canvasMemberIds].filter((memberId) => memberId !== id)));
    setManualLinks((current) => current.filter((link) => link.from !== id && link.to !== id));
    if (affectsPlan) setPendingPlan(null);
    if (selectedId === id) setSelectedId(canvasMembers.find((member) => member.id !== id)?.id || "");
    announce("已移出员工并清除其手工关联；未采纳计划需重新生成");
  }

  function addGroupMember(id) {
    if (!members.some((member) => member.id === id && member.accessGroup === "direct")) return;
    if (!editTeam()) return;
    setGroupMemberIds(new Set([...canvasMemberIds, id]));
    setSelectedId(id);
    if (!canvasMemberIds.has(id)) setPendingPlan(null);
    announce("已加入当前团队；不会自动启动执行");
  }

  function setGroupLink(to, type) {
    if (!canvasMemberIds.has(selected.id) || !canvasMemberIds.has(to)) return;
    if (!editTeam()) return;
    setGroupMemberIds(new Set(canvasMemberIds));
    setPendingPlan(null);
    setManualLinks((current) => [...current.filter((link) => !(link.from === selected.id && link.to === to)), {
      from: selected.id, to, type, label: type === "review" ? "复核" : "顺序交接",
    }]);
    announce(type === "review" ? "已建立产出复核关系，待下一次规划采用" : "已建立顺序交接关系，待下一次规划采用");
  }

  async function registerGroupFiles(files, selectionId = "", intakeRejected = [], selectionGeneration = ++materialSelectionRef.current) {
    if (selectionGeneration !== materialSelectionRef.current || submittingRef.current) return;
    const { accepted, rejected } = normalizeLocalAttachments(files, groupAttachments);
    const intakeFeedback = attachmentIntakeFeedback(accepted.length, [...intakeRejected, ...rejected]);
    setGroupAttachmentFeedback(intakeFeedback);
    if (!accepted.length) return;
    const generation = viewGenerationRef.current;
    const materialGeneration = ++materialGenerationRef.current;
    const isCurrent = () => generation === viewGenerationRef.current && materialGeneration === materialGenerationRef.current;
    if (pendingPlan && !editTeam()) return;
    const nextAttachments = [...groupAttachments, ...accepted.map((file) => ({
      id: file.id || `${file.name}-${file.lastModified || Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      size: file.size,
      type: file.type,
      kind: file.kind,
      selectionId,
    }))];
    setGroupAttachments(nextAttachments);
    const coordinator = selectGroupRunDemoMembers(employees.filter(employee => !assignmentMemberIds || assignmentMemberIds.has(employee.id)), 1)[0];
    if (!groupApi?.material || !coordinator) {
      setGroupMaterialState({ status: "unavailable", fileCount: nextAttachments.length, totalBytes: nextAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0) });
      setGroupAttachmentFeedback({ tone: "error", text: "当前账号暂时无法准备这些材料，请稍后重试。" });
      return;
    }
    setGroupMaterialState({ status: "preparing", fileCount: nextAttachments.length, totalBytes: nextAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0) });
    try {
      const result = await groupApi.material({
        expectedActorKey: undefined,
        body: { employeeId: coordinator.id, files: nextAttachments.map((file) => ({ selectionId: file.selectionId, fileId: file.id })) },
      });
      if (!isCurrent()) return;
      if (!result?.inputRef?.refId) throw new Error("group_material_reference_missing");
      setGroupMaterialState({ status: "ready", inputRefs: [result.inputRef], fileCount: nextAttachments.length, totalBytes: nextAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0) });
      setGroupAttachmentFeedback({ tone: "success", text: "材料已加入 Group，准备就绪。" });
    } catch (error) {
      if (!isCurrent()) return;
      setGroupMaterialState({ status: "error", fileCount: nextAttachments.length, totalBytes: nextAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0) });
      setGroupAttachmentFeedback({ tone: "error", text: groupMaterialErrorMessage(error) });
    }
  }

  function groupMaterialErrorMessage(error) {
    const code = String(error?.message || error?.code || "");
    if (/expired|ttl|intake_unavailable|selection_expired/i.test(code)) return `材料已过期，请重新选择文件。${groupMaterialSafeErrorCode(code)}`;
    if (/authorization|permission|entitlement|scope|denied/i.test(code)) return `当前账号没有使用这些材料的权限。${groupMaterialSafeErrorCode(code)}`;
    if (/digest|changed|mismatch/i.test(code)) return `材料发生变化，请重新选择文件。${groupMaterialSafeErrorCode(code)}`;
    if (/canceled|cancel/i.test(code)) return `材料准备已取消。${groupMaterialSafeErrorCode(code)}`;
    return `材料暂时无法加入 Group，请稍后重试。${groupMaterialSafeErrorCode(code)}`;
  }

  function groupMaterialSafeErrorCode(code) {
    const normalized = code.match(/(?:group|desktop_group|desktop_material)_[a-z0-9_]{1,100}/i)?.[0] || "";
    return normalized ? `（安全错误码：${normalized}）` : "";
  }

  function handleGroupComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat || busy || !composerEnabled) return;
    void sendMessage();
  }

  async function chooseGroupFiles() {
    if (submittingRef.current) return;
    const selectionGeneration = ++materialSelectionRef.current;
    if (desktopApi?.chooseAttachments) {
      const result = await desktopApi.chooseAttachments().catch(() => ({ canceled: true }));
      if (!result?.canceled) await registerGroupFiles(result.files || [], result.selectionId, result.rejected || [], selectionGeneration);
      return;
    }
    groupFileInputRef.current?.click();
  }

  async function handleGroupBrowserFileChange(event) {
    if (submittingRef.current) return;
    const selectionGeneration = ++materialSelectionRef.current;
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await registerGroupFiles(await browserFileRecords(files), `browser-${Date.now()}`, [], selectionGeneration);
  }

  async function handleGroupDrop(event) {
    if (!isMaterialDrag(event.dataTransfer)) return;
    event.preventDefault();
    groupDragDepthRef.current = 0;
    setGroupDragActive(false);
    if (submittingRef.current) return;
    const selectionGeneration = ++materialSelectionRef.current;
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (!dropped.length) {
      setGroupAttachmentFeedback({ tone: "error", text: "未检测到可添加的文件。" });
      return;
    }
    const { accepted, rejected } = normalizeLocalAttachments(dropped, groupAttachments);
    if (desktopApi?.registerDroppedAttachments) {
      const result = await desktopApi.registerDroppedAttachments(accepted).catch(() => null);
      if (selectionGeneration !== materialSelectionRef.current) return;
      if (!result) {
        setGroupAttachmentFeedback({ tone: "error", text: "读取拖入文件失败，请重试或点击选择文件。" });
        return;
      }
      const unresolved = (result.unresolvedIndexes || []).map((index) => accepted[index]).filter(Boolean);
      await registerGroupFiles([...(result.files || []), ...(await browserFileRecords(unresolved))], result.selectionId, [...rejected, ...(result.rejected || [])], selectionGeneration);
      return;
    }
    await registerGroupFiles(await browserFileRecords(accepted), `browser-${Date.now()}`, rejected, selectionGeneration);
  }

  function removeGroupAttachment(id) {
    if (submittingRef.current || (pendingPlan && !editTeam())) return;
    materialGenerationRef.current += 1; materialSelectionRef.current += 1;
    if (draftContextRef.current) draftContextRef.current.inputRefs = [];
    setGroupAttachments((current) => {
      const next = current.filter((item) => item.id !== id);
      setGroupMaterialState(next.length ? { status: "unavailable", fileCount: next.length, totalBytes: next.reduce((sum, file) => sum + Number(file.size || 0), 0) } : null);
      return next;
    });
    setGroupAttachmentFeedback(null);
  }

  async function startRun({ recoverPlanning = false } = {}) {
    if (directEmployeeId) { announce("请在当前员工的信息流发送任务"); return; }
    if (activeRunId && (!selectedRework || reworkIntent !== activeRunId)) { announce("请先明确发起返工；当前 Run 不会被重新执行。"); return; }
    const historyContext = historyGoalContext(selectedHistory);
    const submissionContext = selectedRework || (selectedHistory ? historyContext : null);
    const restoredRetry = retryRequestRef.current?.retryOnly === true && (recoverPlanning || !composer.trim()) && retryMatchesGoalContext(retryRequestRef.current, submissionContext);
    const retryCandidate = restoredRetry ? retryRequestRef.current : retryRequestRef.current?.objective === composer.trim()
      ? retryRequestRef.current : planningRequestRef.current?.failed && planningRequestRef.current.objective === composer.trim()
        ? planningRequestRef.current : null;
    const localTransientHandle = Boolean(selectedHistory && !selectedHistory.goalId && !historyContext && retryRequestRef.current && !retryRequestRef.current.continuation);
    const localTransientRetry = localTransientHandle && retryCandidate === retryRequestRef.current;
    const retry = (restoredRetry || retryMatchesGoalContext(retryCandidate, submissionContext) || localTransientRetry) ? retryCandidate : null;
    if (!composer.trim() && !retry) { announce("请先输入本次 Group 目标"); return; }
    if (selectedHistory?.goalId && !submissionContext) { announce("当前选中记录缺少可续聊的 Goal 上下文，请先刷新历史"); return; }
    if (!newGoalIntent && !submissionContext && !localTransientHandle) { announce("请先选择一个当前目标，或点击右上角＋新建目标"); return; }
    if (localTransientHandle && !localTransientRetry) { announce("首次目标尚未绑定 Center Goal，只能重试原请求；如需其他目标请点击右上角＋"); return; }
    if (groupAttachments.length && groupMaterialState?.status !== "ready") {
      announce("材料尚未准备好，请稍后再试");
      return;
    }
    if (!restoredRetry && reviewerIssue) { announce(`Reviewer 配置未完成：${reviewerIssue}`); return; }
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Pending pickers/drop registration belong to the pre-planning selection.
    materialSelectionRef.current += 1;
    const continuation = retry?.continuation ? { ...retry.continuation,
      ...(retry.continuation.reworkRunId ? {} : { retry: true }) } : (submissionContext ? {
      goalId: submissionContext.goal?.goalId,
      expectedGoalRevision: submissionContext.goal?.revision,
      groupId: submissionContext.groupVersion?.groupId,
      expectedGroupVersion: submissionContext.groupVersion?.version,
      ...(selectedRework && reworkIntent === activeRunId ? { reworkRunId: selectedHistory.runId } : {}),
    } : null);
    const requestBody = retry
      ? { ...retry.requestBody, continuation, ...(retry.retryOnly ? { retryOnly: true } : {}) }
      : { objective: composer.trim(), inputRefs: groupMaterialState?.inputRefs || [], employees, selectedEmployeeIds: groupMemberIds ? [...groupMemberIds] : null, planningHints: manualLinks, reviewerGroup, ...(continuation ? { continuation } : {}) };
    const requestFingerprint = JSON.stringify(requestBody);
    if (planningRequestRef.current?.fingerprint !== requestFingerprint) {
      planningRequestRef.current = retry ? { ...retry, failed: false } : { fingerprint: requestFingerprint, id: crypto.randomUUID(), objective: composer.trim(), continuation, requestBody, failed: false };
    }
    if (newGoalIntent && !retry && !continuation) setNewGoalIntent(false);
    setBusy(true);
    const submissionKey = continuation?.goalId || `submission-${planningRequestRef.current.id}`;
    const composerSnapshot = composer;
    const title = composerSnapshot.trim();
    const sentAt = new Date().toISOString();
    if (title && !retry?.retryOnly) setPendingTurn({ goalId: continuation?.goalId || null, text: title, createdAt: sentAt, status: "planning" });
    const cancellation = groupPlanningCancellationHandle({
      idempotencyKey: planningRequestRef.current.id,
      continuation,
      retryOnly: retry?.retryOnly === true,
      currentPlanningContext: submissionContext?.goal?.planningContext,
      historyStatus: selectedHistory?.status,
    });
    const cancelHandle = { cancellation, confirmed: false, submissionKey, title, generation: viewGenerationRef.current };
    planningCancelRef.current = cancelHandle;
    setPlanningCancelState("available");
    setHistoryKey(submissionKey);
    setHistory(current => continuation?.reworkRunId
      ? [{ key: submissionKey, title: selectedHistory?.title || title, status: "planning", startedAt: Date.now() }, ...current.filter(item => item.key !== submissionKey)]
      : continuation
      ? current.map(item => item.key === submissionKey ? { ...item, status: "planning", error: "", startedAt: Date.now() } : item)
      : [{ key: submissionKey, title, status: "planning", startedAt: Date.now() }, ...current.filter(item => item.key !== submissionKey)]);
    setPendingPlan(null); setActiveRunId(null); setSafeProjection(null);
    announce("任务规划数字员工正在理解目标并生成计划草案…");
    try {
      const draft = await startGroupRunDemo({ ...requestBody, idempotencyKey: retry?.id || planningRequestRef.current.id, ...(groupFetcher ? { fetcher: groupFetcher } : {}) });
      if (cancelHandle.confirmed) { void refreshHistory(); announce("规划已停止"); return; }
      planningRequestRef.current = null; retryRequestRef.current = null;
      const goalTitle = continuation ? selectedHistory?.title || draftContextRef.current?.objective || title : title;
      draftContextRef.current = { objective: goalTitle, inputRefs: requestBody.inputRefs };
      setNewGoalIntent(false);
      setPendingPlan(draft);
      setPlanSheetOpen(false);
      setGroupMemberIds(new Set((draft.draft?.steps || []).map(step => step.employeeId).filter(Boolean)));
      setHistoryKey(draft.goal.goalId);
      setHistory(current => [{ key: draft.goal.goalId, goalId: draft.goal.goalId, title: goalTitle, objective: goalTitle, status: "draft", review: draft }, ...current.filter(item => item.key !== submissionKey && item.key !== draft.goal.goalId)]);
      setReworkIntent("");
      if (!retry?.retryOnly) setComposer(current => current === composerSnapshot ? "" : current);
      setPendingTurn({ goalId: draft.goal.goalId, revision: draft.goal.revision, text: title, createdAt: sentAt, status: "planning" });
      await loadDisplayHistory(draft.goal.goalId);
      announce("计划草案已生成，请确认分工后采纳");
    } catch (error) {
      if (cancelHandle.confirmed) {
        planningRequestRef.current = null; retryRequestRef.current = null;
        setHistory(current => current.map(item => item.key === cancelHandle.submissionKey ? { ...item, status: "canceled", error: "" } : item));
        setPendingTurn(current => current ? { ...current, status: "canceled" } : current);
        if (continuation?.goalId) await loadDisplayHistory(continuation.goalId);
        void refreshHistory();
        return;
      }
      if (String(error?.code || error?.message || "").split(":").at(-1).trim() === "agent_turn_canceled") {
        cancelHandle.confirmed = true;
        planningRequestRef.current = null; retryRequestRef.current = null;
        const goalId = error?.goal?.goalId || cancelHandle.submissionKey;
        if (error?.goal?.goalId) setNewGoalIntent(false);
        setHistoryKey(goalId);
        setHistory(current => {
          const local = current.find(item => item.key === cancelHandle.submissionKey) || { title: cancelHandle.title };
          return [{ ...local, key: goalId, ...(error?.goal?.goalId ? { goalId } : {}), status: "canceled", error: "" }, ...current.filter(item => item.key !== cancelHandle.submissionKey && item.key !== goalId)];
        });
        setPendingTurn(current => current ? { ...current, goalId, status: "canceled" } : current);
        if (error?.goal?.goalId) await loadDisplayHistory(error.goal.goalId);
        void refreshHistory();
        return;
      }
      let recoveredContinuation = planningRequestRef.current?.continuation || null;
      if (planningRequestRef.current) {
        recoveredContinuation = error?.goal && error?.groupVersion ? {
          goalId: error.goal.goalId, expectedGoalRevision: error.goal.revision,
          groupId: error.groupVersion.groupId, expectedGroupVersion: error.groupVersion.version,
        } : planningRequestRef.current.continuation;
        planningRequestRef.current = { ...planningRequestRef.current, failed: true, continuation: recoveredContinuation,
          requestBody: { ...planningRequestRef.current.requestBody, ...(recoveredContinuation ? { continuation: recoveredContinuation } : {}) } };
        retryRequestRef.current = { ...planningRequestRef.current };
      }
      if (error?.goal && error?.groupVersion) setNewGoalIntent(false);
      const failedCard = { status: "failed", error: `未收到计划草案：${groupSafeErrorMessage(error)}。请先刷新历史确认，再决定是否重试。` };
      setPendingTurn(current => current ? { ...current, goalId: recoveredContinuation?.goalId || current.goalId, status: "failed" } : current);
      // Without a newer Center context, keep the immutable source Run selected.
      // The request may have reached Center; only an explicit same-key retry is safe.
      if (continuation?.reworkRunId && !(error?.goal && error?.groupVersion)) {
        setHistory(current => current.filter(item => item.key !== submissionKey));
        setHistoryKey(selectedHistory.key);
        setActiveRunId(selectedHistory.runId);
        setSafeProjection(safeProjection || selectedHistory.projection || null);
        announce(failedCard.error);
        return;
      }
      if (recoveredContinuation?.goalId) await loadDisplayHistory(recoveredContinuation.goalId);
      if (recoveredContinuation?.goalId) {
        setHistoryKey(recoveredContinuation.goalId);
        setHistory(current => {
          const submission = current.find(item => item.key === submissionKey) || { title };
          const fallbackContext = historyGoalContext(submission);
          const planning = error?.goal && error?.groupVersion
            ? { goal: error.goal, groupVersion: error.groupVersion, planDraft: null }
            : fallbackContext ? { ...fallbackContext, planDraft: null } : null;
          return [{ ...submission, ...failedCard, key: recoveredContinuation.goalId, goalId: recoveredContinuation.goalId, review: null, ...(planning ? { planning } : {}) },
            ...current.filter(item => item.key !== submissionKey && item.key !== recoveredContinuation.goalId)];
        });
      } else {
        setHistory(current => current.map(item => item.key === submissionKey ? { ...item, ...failedCard } : item));
      }
      announce(error?.message === "desktop_group_auth_required" ? "本机测试会话已过期，请重新打开 Sandbox 后重试" : `测试草案未生成：${groupSafeErrorMessage(error)}`);
    }
    finally { if (planningCancelRef.current === cancelHandle) planningCancelRef.current = null; submittingRef.current = false; setBusy(false); setPlanningCancelState("idle"); }
  }

  async function stopPlanning() {
    const handle = planningCancelRef.current;
    if (!handle || handle.confirmed || planningCancelState === "stopping") return;
    setPlanningCancelState("stopping");
    try {
      let result = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await cancelGroupPlanning({ cancellation: handle.cancellation, ...(groupFetcher ? { fetcher: groupFetcher } : {}) });
        if (planningCancelRef.current !== handle || viewGenerationRef.current !== handle.generation) return;
        if (result.cancellation !== "pending") break;
        if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 240));
      }
      if (result?.cancellation === "canceled") {
        handle.confirmed = true;
        setPlanningCancelState("confirmed");
        const goalId = result.goalId || handle.submissionKey;
        if (result.goalId) setNewGoalIntent(false);
        setHistoryKey(goalId);
        setHistory(current => {
          const local = current.find(item => item.key === handle.submissionKey) || { title: handle.title };
          return [{ ...local, key: goalId, goalId, status: "canceled", error: "" }, ...current.filter(item => item.key !== handle.submissionKey && item.key !== goalId)];
        });
        announce("Center 已确认停止规划");
        setPendingTurn(current => current ? { ...current, goalId, status: "canceled" } : current);
        void refreshHistory();
      } else if (result?.cancellation === "completed") {
        setPlanningCancelState("available");
        announce("规划已完成，正在保留草案结果");
      } else {
        setPlanningCancelState("unconfirmed");
        announce("停止尚未确认，可再次点击停止");
      }
    } catch (error) {
      if (planningCancelRef.current !== handle || viewGenerationRef.current !== handle.generation) return;
      setPlanningCancelState("unconfirmed");
      announce(`停止尚未确认：${groupSafeErrorMessage(error)}`);
    }
  }

  async function adoptPlan() {
    if (!pendingPlan || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      let run = await adoptGroupRunDemo({ review: pendingPlan, ...(groupFetcher ? { fetcher: groupFetcher } : {}) });
      setActiveRunId(run.runId);
      setHistoryKey(run.runId);
      setHistory(current => current.map(item => item.key === historyKey ? { ...item, key: run.runId, runId: run.runId, review: null, status: "starting" } : item));
      setPendingPlan(null);
      setPlanSheetOpen(false);
      run = await advanceGroupRun({ runId: run.runId, expectedRevision: run.casRevision, ...(groupFetcher ? { fetcher: groupFetcher } : {}) });
      setActiveRunId(run.runId);
      setPendingPlan(null);
      setPlanSheetOpen(false);
      announce(`GroupRun ${run.runId} 已提交 canonical task，正在读取真实投影`);
    } catch (error) {
      setHistory(current => current.map(item => item.key === historyKey ? { ...item, error: `启动请求未确认：${groupSafeErrorMessage(error)}。请刷新状态后继续。` } : item));
      announce(`GroupRun 未启动：${groupSafeErrorMessage(error)}`);
    } finally { submittingRef.current = false; setBusy(false); void refreshHistory(); }
  }

  async function controlRun(action) {
    if (!activeRunId || !safeProjection || submittingRef.current) return;
    const requestedRunId = activeRunId;
    const generation = viewGenerationRef.current;
    submittingRef.current = true;
    setBusy(true);
    try {
      const operation = action === "resume" ? resumeGroupRun : action === "cancel" ? cancelGroupRun : advanceGroupRun;
      await operation({ runId: requestedRunId, expectedRevision: safeProjection.casRevision, ...(groupFetcher ? { fetcher: groupFetcher } : {}) });
      const projection = await fetchGroupRunProjection({ runId: requestedRunId, requester: groupApi?.projection });
      if (generation !== viewGenerationRef.current || projection.runId !== requestedRunId) return;
      setSafeProjection(projection);
      announce(action === "resume" ? "Center 已重新验权并恢复推进" : action === "cancel" ? "Group 已取消" : "Center 已接受推进请求");
    } catch (error) { if (generation === viewGenerationRef.current) announce(`操作未完成：${groupSafeErrorMessage(error)}`); }
    finally { submittingRef.current = false; if (generation === viewGenerationRef.current) setBusy(false); }
  }

  function sendMessage() {
    return startRun();
  }

  async function openRoundDraft(goalRevision) {
    const goalId = selectedHistory?.goalId;
    if (!goalId || !Number.isSafeInteger(goalRevision) || goalRevision < 1) return;
    if (pendingPlan?.goal?.revision === goalRevision) { setInspectedDraft(null); setPlanSheetOpen(true); return; }
    const generation = viewGenerationRef.current;
    try {
      const data = groupApi?.revisionDraft
        ? await groupApi.revisionDraft({ goalId, goalRevision })
        : await fetch(`/api/group-studio/goals/${encodeURIComponent(goalId)}/revisions/${goalRevision}/draft`, { credentials: "same-origin" }).then(response => response.json());
      if (generation !== viewGenerationRef.current || selectedHistory?.goalId !== goalId) return;
      if (!data?.ok || data.goalId !== goalId || data.goalRevision !== goalRevision || !Array.isArray(data.draft?.steps)) throw new Error("group_history_unavailable");
      setInspectedDraft(data.draft); setPlanSheetOpen(true);
    } catch (error) { if (generation === viewGenerationRef.current) announce(`草案暂不可用：${groupSafeErrorMessage(error)}`); }
  }

  function createNewGroupGoal() {
    if (busy || submittingRef.current || (directEmployeeId && employeeConversationState?.locked)) return;
    if (directEmployeeId) setComposer(employeeConversationState?.draftText || "");
    setDirectEmployeeId("");
    onSelectEmployeeConversation?.({ employeeId: "" });
    viewGenerationRef.current += 1;
    materialGenerationRef.current += 1; materialSelectionRef.current += 1;
    draftContextRef.current = null;
    setDirectTaskId("");
    setNewGoalIntent(true);
    setReworkIntent("");
    setPendingPlan(null); setPlanSheetOpen(false); setInspectedDraft(null); setSafeProjection(null); setProjectionError(""); setActiveRunId(null); setHistoryKey(null);
    setGroupMemberIds(null); setReviewerIds([]); setReviewerTeam(null); setFinalReviewerId(""); setManualLinks([]);
    setGroupAttachments([]); setGroupMaterialState(null); setGroupAttachmentFeedback(null); planningRequestRef.current = null; retryRequestRef.current = null;
    planningCancelRef.current = null; setPlanningCancelState("idle");
    announce("已新建 Group 目标；当前对话将从空白草案开始");
  }

  function startMemberDrag(event, memberId) {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    suppressNodeClickRef.current = false;
    dragRef.current = { memberId, pointerId: event.pointerId, moved: false,
      startX: event.clientX, startY: event.clientY,
      origin: layoutPositions[memberId], originManualPosition: manualMemberPositionsRef.current[memberId] || null,
      currentPosition: layoutPositions[memberId] };
    setSelectedId(memberId);
  }

  function isOverReviewer(event) {
    return [reviewerCardRef, reviewerOrbitRef].some(ref => {
      const rect = ref.current?.getBoundingClientRect();
      return Boolean(rect && rect.width !== 0 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    });
  }

  function dropReviewerOutside(event) {
    const id = event.dataTransfer?.getData("application/x-group-reviewer");
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || activeRunId || !reviewerIds.includes(id)) return;
    if (!isOverReviewer(event)) removeReviewerMember(id);
  }

  function isOverMemberRail(event) {
    const rect = memberRailRef.current?.getBoundingClientRect();
    return Boolean(rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
  }

  function moveMemberDrag(event) {
    const drag = dragRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect || !drag.origin) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    const x = Math.min(87, Math.max(9, drag.origin.x + dx / rect.width * 100 / canvasZoom));
    const y = Math.min(82, Math.max(14, drag.origin.y + dy / rect.height * 100 / canvasZoom));
    const candidate = { x, y };
    const occupiedPositions = Object.entries(layoutPositions).filter(([id]) => id !== drag.memberId).map(([, point]) => point);
    drag.moved = true;
    setMemberRemovalTarget(isOverMemberRail(event) && !isOverReviewer(event));
    if (isOverReviewer(event) || occupiedPositions.some(point => groupMemberCanvasPositionsOverlap(candidate, point, { canvasWidth: rect.width, canvasHeight: rect.height }))) return;
    drag.currentPosition = candidate;
    manualMemberPositionsRef.current = { ...manualMemberPositionsRef.current, [drag.memberId]: candidate };
    setMemberRemovalTarget(isOverMemberRail(event) && !isOverReviewer(event));
    setMemberPositions((current) => ({ ...current, [drag.memberId]: candidate }));
  }

  function endMemberDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    suppressNodeClickRef.current = drag.moved;
    setMemberRemovalTarget(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type !== "pointerup") {
      if (drag.moved) {
        restoreManualMemberPosition(drag);
        setMemberPositions((current) => ({ ...current, [drag.memberId]: drag.origin }));
      }
      return;
    }
    if (drag.moved && isOverReviewer(event)) {
      restoreManualMemberPosition(drag);
      setMemberPositions(current => ({ ...current, [drag.memberId]: drag.origin }));
      addReviewerMember(drag.memberId);
      return;
    }
    if (drag.moved && isOverMemberRail(event)) {
      delete manualMemberPositionsRef.current[drag.memberId];
      setMemberPositions((current) => ({ ...current, [drag.memberId]: drag.origin }));
      removeGroupMember(drag.memberId);
      return;
    }
    if (drag.moved) {
      manualMemberPositionsRef.current = { ...manualMemberPositionsRef.current, [drag.memberId]: drag.currentPosition };
      setMemberPositions((current) => ({ ...current, [drag.memberId]: drag.currentPosition }));
    }
  }

  function restoreManualMemberPosition(drag) {
    if (drag.originManualPosition) manualMemberPositionsRef.current = { ...manualMemberPositionsRef.current, [drag.memberId]: drag.originManualPosition };
    else delete manualMemberPositionsRef.current[drag.memberId];
    setMemberPositions((current) => {
      const next = { ...current };
      delete next[drag.memberId];
      return next;
    });
  }

  return (
    !windowExpanded ? <button type="button" className="group-floating-pet" aria-label="打开 Group Studio" onPointerDown={beginGroupWindowDrag} onPointerMove={moveGroupWindowDrag} onPointerUp={endGroupWindowDrag} onClick={() => desktopApi?.setExpanded?.(true)}><Sparkle size={22} weight="fill" /></button> :
    <main className="group-prototype-shell">
      <header className="group-prototype-topbar" onPointerDown={onBack ? undefined : beginGroupWindowDrag} onPointerMove={onBack ? undefined : moveGroupWindowDrag} onPointerUp={onBack ? undefined : endGroupWindowDrag}>
        <div className="group-brand group-window-drag-region">
          <span className="group-brand-mark"><Sparkle size={17} weight="fill" /></span>
          <div><strong>Group Studio</strong>{onBack ? <button type="button" className="group-back-cockpit" onClick={onBack} aria-label="返回驾驶舱" title="返回驾驶舱"><span aria-hidden="true">←</span> 驾驶舱</button> : <small>成员与状态来自当前账号和 Center</small>}</div>
          <span className="group-live-dot" />
        </div>
        <nav className="group-nav" aria-label="项目组工作区">
          {GROUP_NAV_ITEMS.map(([id, label, Icon]) => <button type="button" onPointerDown={(event) => event.stopPropagation()} className={activeNav === id ? "is-active" : ""} key={id} aria-current={activeNav === id ? "page" : undefined} disabled={Boolean(directEmployeeId && !["feed", "chat", "activity", "automations"].includes(id))} onClick={() => setActiveNav(id)}><Icon size={17} />{label}</button>)}
        </nav>
          <div className="group-top-actions" onPointerDown={(event) => event.stopPropagation()}>{onCollapse ? <button type="button" className="group-icon-button" aria-label="收起到桌面值守" title="收起到桌面值守" onClick={onCollapse}><Minus size={17} /></button> : null}<button type="button" className="group-icon-button" onClick={createNewGroupGoal} disabled={busy || Boolean(directEmployeeId && employeeConversationState?.locked)} aria-label="新建 Group 目标" title="新建 Group 目标"><Plus size={17} /></button><span className="group-boundary" title="本机测试 · 布局示意">本机测试</span><button type="button" className="group-icon-button" aria-label="更多" disabled aria-disabled="true"><DotsThree size={20} /></button><MaximizeButton desktopApi={desktopApi} className="group-window-control" />{!onBack ? <><button type="button" className="group-window-control" aria-label="收起窗口" title="收起窗口" onClick={() => desktopApi?.setExpanded?.(false)}><Minus size={17} /></button><button type="button" className="group-window-control" aria-label="关闭窗口" title="关闭窗口" onClick={() => desktopApi?.hide?.()}><X size={17} /></button></> : null}</div>
      </header>

        {activeNav !== "automations" && pendingPlan ? <div className="group-plan-review" aria-label="Group 计划草案"><span className="group-plan-status-dot" /><strong>计划草案待确认</strong><small>{pendingPlan.draft?.steps?.length || 0} 个步骤 · 未开始执行</small><button type="button" className="group-plan-open" onClick={() => setPlanSheetOpen(true)}>查看草案</button><button type="button" className="group-plan-adopt" onClick={adoptPlan} disabled={busy}>采纳</button></div> : null}
      <section className={`group-prototype-body${activeNav === "automations" ? " is-automation-view" : ""}${leftRailCollapsed ? " is-left-rail-collapsed" : ""}`} onDragOverCapture={event => { if (event.dataTransfer?.types.includes("application/x-group-reviewer")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy || activeRunId ? "none" : "move"; } }} onDropCapture={dropReviewerOutside}>
        <aside className={`group-left-rail ${leftRailCollapsed ? "is-collapsed" : ""} ${memberRemovalTarget ? "is-member-drop-target" : ""}`} ref={memberRailRef}>
          <div className="group-rail-heading"><strong>项目组</strong><button type="button" className="group-rail-collapse" onClick={() => setLeftRailCollapsed((current) => !current)} aria-label={leftRailCollapsed ? "展开员工列" : "收起员工列"} title={leftRailCollapsed ? "展开员工列 (Ctrl+B)" : "收起员工列 (Ctrl+B)"}>{leftRailCollapsed ? "›" : "‹"}</button></div>
          {safeProjection?.steps?.filter(step => step.errorCode).map(step => <div className="group-attachment-feedback is-error" role="alert" key={step.stepId}>{step.stepId}：{step.errorCode}</div>)}
          {safeProjection?.steps?.some(step => step.errorCode === "group_review_rejected") ? <GroupReviewOpinions key={activeRunId} runId={activeRunId} requester={groupApi?.reviewOpinions} /> : null}
          <div className="group-objective"><span>{directEmployeeId ? "单员工任务" : "当前 Group 目标"} {selectedHistory?.goalId ? <button type="button" aria-label="修改任务名称" title="修改任务名称" disabled={titleSaving} onClick={() => { setTitleDraft(selectedHistory.title || ""); setTitleEditing(true); }}><PencilSimple size={13} /></button> : null}</span>{titleEditing ? <form className="group-title-editor" onSubmit={saveTitle}><input aria-label="任务名称" maxLength={80} value={titleDraft} onChange={event => setTitleDraft(event.target.value)} disabled={titleSaving} autoFocus /><button type="submit" title="保存名称" aria-label="保存名称" disabled={titleSaving || !titleDraft.trim()}><Check size={14} /></button><button type="button" title="取消改名" aria-label="取消改名" disabled={titleSaving} onClick={() => setTitleEditing(false)}><X size={14} /></button></form> : <small>{directEmployeeId ? selectedDirectTask?.title || "由当前员工直接处理" : selectedHistory?.title || (newGoalIntent ? "正在新建目标" : "请先选择目标或点击右上角＋")}</small>}{titleError ? <small role="alert">{titleError}</small> : null}<em>{directEmployeeId ? selectedDirectTask ? runStatusLabel(selectedDirectTask.status) : employeeConversationState?.busy ? "执行中" : "可对话" : objectiveStatus}</em><div className="group-progress"><span style={{ width: `${safeProjection?.steps?.length ? 100 * safeProjection.steps.filter(step => step.status === "completed").length / safeProjection.steps.length : 0}%` }} /></div></div>
          <div className="group-section-title"><span>成员 <b>{members.length}</b></span><button type="button" disabled={busy || Boolean(activeRunId)} onClick={() => { if (editTeam()) setGroupMemberIds(new Set(members.filter((member) => member.accessGroup === "direct").map((member) => member.id))); }}><UsersThree size={14} />使用可用员工</button></div>
          <div className="group-member-list">
            {memberGroups.filter((group) => group.id === "direct").map((group) => <section className="group-member-group" key={group.id} aria-label={group.label}>
              {group.members.map((member) => <button type="button" draggable={member.accessGroup === "direct"} key={member.id} className={`group-member-row is-${member.accessGroup} ${selectedId === member.id ? "is-selected" : ""}`} onDragStart={(event) => { event.dataTransfer.setData("application/x-group-employee", member.id); event.dataTransfer.effectAllowed = "copy"; }} onDoubleClick={() => { if (member.accessGroup === "direct") onOpenEmployeeConversation?.({ employeeId: member.id }); }} onClick={() => setSelectedId(member.id)}>{member.avatar ? <img src={member.avatar} alt="" draggable={false} /> : <span className="group-avatar-fallback" aria-hidden="true">{member.name.slice(0, 1)}</span>}<span><strong>{member.name}</strong><small>{member.role} · {member.employeeVersion ? `v${member.employeeVersion}` : "版本未知"}{member.coordinator ? " · 协调者" : ""}</small></span><i className={`group-status-dot is-${member.accent}`} />{member.status !== group.label ? <span className="group-wait">{member.status}</span> : null}</button>)}
            </section>)}
          </div>
          {activeNav !== "automations" ? <GroupReviewerConfigurator cardRef={reviewerCardRef} members={members} reviewerIds={reviewerIds} reviewerMode={reviewerMode} finalReviewerId={finalReviewerId} reviewerTeam={reviewerTeam} disabled={busy || Boolean(activeRunId)} onAdd={addReviewerMember} onRemove={removeReviewerMember} onModeChange={changeReviewerMode} onFinalChange={changeFinalReviewer} onMove={moveReviewer} /> : null}
          <div className="group-member-list">
            {memberGroups.filter((group) => group.id !== "direct").map((group) => <section className="group-member-group" key={group.id} aria-label={group.label}>
              <div className={`group-member-group-title is-${group.id}`}><span>{group.label}</span><b>{group.members.length}</b></div>
              {group.members.map((member) => <button type="button" draggable={false} key={member.id} className={`group-member-row is-${member.accessGroup} ${selectedId === member.id ? "is-selected" : ""}`} onClick={() => setSelectedId(member.id)}>{member.avatar ? <img src={member.avatar} alt="" draggable={false} /> : <span className="group-avatar-fallback" aria-hidden="true">{member.name.slice(0, 1)}</span>}<span><strong>{member.name}</strong><small>{member.role} · {member.employeeVersion ? `v${member.employeeVersion}` : "版本未知"}</small></span><i className={`group-status-dot is-${member.accent}`} /><span className="group-wait">{member.status}</span></button>)}
            </section>)}
            {!members.length ? <p className="group-empty-state">{bootstrapReady ? "当前账号暂无可调用且可选择的员工。" : "正在读取当前账号的 bootstrap 成员目录…"}</p> : null}
          </div>
        </aside>

        <section className="group-canvas-column">
          <div hidden={activeNav === "automations"}><GroupRunHistory items={taskHistory.filter(item => item.kind !== "automation")} automations={automationSources?.automationPhase === "ready" ? automationSources.automations : []} runDetails={automationSources?.runDetails} ensureRuns={automationSources?.ensureRuns} selectedKey={directTaskId ? `employee-task:${directTaskId}` : historyKey} onSelect={selectHistory} onDelete={deleteHistory} onRefresh={async () => { await Promise.all([refreshHistory(), myTasks?.refresh?.()]); }} loading={historyLoading || myTasks?.busy} error={historyError || myTasks?.error} busy={busy} /></div>
          <section className="group-automation-inspector" aria-label="工作台定时任务">
            {activeNav === "automations" ? <div id="group-automation-records" className="group-automation-history"><header><strong>当前任务的定时任务</strong><button type="button" onClick={() => setActiveNav("feed")}>返回信息流</button></header><PersonalAutomationsPanel key={`${[...canvasMemberIds].sort().join(",")}:${automationTaskIds.join(",")}`} cockpitMode workbenchScope={{ employeeIds: [...canvasMemberIds], employeeNames: Object.fromEntries(canvasMembers.map(member => [member.employeeId, member.name])), taskIds: automationTaskIds }} desktopApi={desktopApi} tasks={myTasks?.page?.tasks || []} renderTaskDetail={(task, state) => <TaskDetails task={task} state={state} onInspectArtifact={myTasks?.inspectArtifact} onDeliverArtifact={myTasks?.deliverArtifact} />} /></div> : null}
          </section>
          {activeNav !== "automations" && safeProjection && (activeNav === "outputs" || !["accepted", "rejected"].includes(safeProjection.status)) ? <GroupDeliveryAcceptance key={`${activeRunId}:${safeProjection.delivery?.deliveryDigest || "pending"}`} projection={safeProjection} requester={groupApi?.acceptance} stale={Boolean(projectionError)} onOpenArtifacts={() => setActiveNav("outputs")} onProjection={projection => { setSafeProjection(projection); void refreshHistory(); }} /> : null}
          {directEmployeeId && activeNav === "activity" ? <EmployeeTaskActivity employeeId={directEmployeeId} taskId={directTaskId} myTasks={myTasks} onSelect={setDirectTaskId} onOpenChat={() => setActiveNav("chat")} onOpenLink={async url => { if (desktopApi) await desktopApi.openExternal(url).catch(() => {}); }} /> : null}
          {directEmployeeId && activeNav === "chat" ? <section className="group-employee-conversation employee-conversation-body" aria-label="员工任务信息流">{renderEmployeeConversation?.({ employeeId: directEmployeeId, assignmentControl, view: activeNav, onOpenChat: () => setActiveNav("chat") })}</section> : null}
          {!directEmployeeId && !["feed", "automations"].includes(activeNav) ? <GroupEntryPanel activeNav={activeNav} safeProjection={safeProjection} projectionError={projectionError} members={members} composer={composer} setComposer={setComposer} onSend={sendMessage} onStop={runCanStop ? () => controlRun("cancel") : stopPlanning} onInspectArtifact={inspectGroupArtifact} onDeliverArtifact={deliverGroupArtifact} onOpenDraft={openRoundDraft} displayHistory={displayHistory} displayHistoryLoading={displayHistoryLoading} displayHistoryError={displayHistoryError} pendingTurn={pendingTurn} canStop={Boolean((busy && planningCancelRef.current) || runCanStop)} stopping={["stopping", "confirmed"].includes(planningCancelState)} composerEnabled={composerEnabled} composerPlaceholder={composerPlaceholder} assignmentControl={assignmentControl} /> : null}
          {activeNav === "feed" ? <>
          <div className="group-canvas-toolbar"><div className="group-legend"><span><i className="legend-line is-handoff" />主动交接</span><span><i className="legend-line is-assist" />请求协助</span><span><i className="legend-line is-context" />共享上下文</span><span><i className="legend-line is-parallel" />并行任务</span><span><i className="legend-line is-review" />临时复核</span></div><div className="group-canvas-tools"><button type="button" disabled aria-disabled="true" title="协作关系仅来自 Center 安全投影"><ArrowsClockwise size={16} /></button><button type="button" disabled aria-disabled="true" title="节点可直接拖动"><CirclesFour size={16} /></button></div></div>
          <div className={`group-canvas-frame${directEmployeeId ? " has-direct-employee" : ""}`}>
          <div className={`group-canvas${directEmployeeId ? " has-direct-employee" : ""}`} aria-label="自由协作网络" ref={canvasRef} onDragOver={(event) => { if (event.dataTransfer?.types.includes("application/x-group-employee")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={(event) => { const id = event.dataTransfer?.getData("application/x-group-employee"); if (!id) return; event.preventDefault(); addGroupMember(id); }}>
            <div className="group-canvas-grid" />
            <svg className="group-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {edgeGeometry.map((edge) => <g className={`group-link is-${edge.type}`} key={`${edge.from}-${edge.to}-${edge.type}`}>
                <path d={edge.d} className="group-link-base" />
                <path d={edge.d} pathLength="100" className="group-link-pulse is-a" />
                <path d={edge.d} pathLength="100" className="group-link-pulse is-b" />
                <path d={edge.d} pathLength="100" className="group-link-pulse is-c" />
              </g>)}
            </svg>
            {reviewerTeam ? <div className={`group-reviewer-orbit is-${reviewerTeam.status === "执行中" ? "active" : "idle"}`} aria-label="独立临时复核小组" ref={reviewerOrbitRef} onDragOver={event => { if (!busy && !activeRunId && event.dataTransfer?.types.includes("application/x-group-employee")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { const id = event.dataTransfer?.getData("application/x-group-employee"); if (!id) return; event.preventDefault(); event.stopPropagation(); addReviewerMember(id); }}><strong>{reviewerTeam.displayName}</strong><span>{reviewerIds.length} 位成员 · {reviewerTeam.status}</span><div>{reviewerIds.map((id) => { const member = members.find((item) => item.employeeId === id); return <span key={id} draggable={!busy && !activeRunId} title={`${member?.name || id}：拖出 Reviewer Group 可移除`} onDragStart={event => { event.dataTransfer.setData("application/x-group-reviewer", id); event.dataTransfer.effectAllowed = "move"; }}>{member?.avatar ? <img src={member.avatar} alt="" draggable={false} /> : (member?.name || id).slice(0, 1)}</span>; })}</div></div> : null}
            {canvasMembers.map((member) => {
              const position = viewPositions[member.id];
              const scheduledRules = currentScheduledRules.filter(rule => rule.employeeId === member.employeeId);
              const scheduleActive = scheduledRules.some(rule => rule.state === "active");
              const scheduleLabel = scheduleActive ? "当前任务有已启用的定时任务" : scheduledRules.some(rule => rule.state === "attention_required") ? "当前任务的定时任务需要处理" : "当前任务的定时任务已暂停";
              return <button type="button" draggable={false} key={member.id} title="拖动调整成员位置；拖到左侧可移出 Group" onDoubleClick={() => onOpenEmployeeConversation?.({ employeeId: member.id })} className={`group-node is-${member.accent} ${selectedId === member.id ? "is-selected" : ""} ${relatedIds.has(member.id) ? "is-related" : ""}`} style={{ left: `${position?.x ?? 50}%`, top: `${position?.y ?? 50}%`, transform: `translate(-50%, -50%) scale(${canvasZoom})` }} onClick={() => { if (suppressNodeClickRef.current) { suppressNodeClickRef.current = false; return; } setSelectedId(member.id); }} onDragStart={(event) => event.preventDefault()} onPointerDown={(event) => startMemberDrag(event, member.id)} onPointerMove={moveMemberDrag} onPointerUp={endMemberDrag} onPointerCancel={endMemberDrag} onLostPointerCapture={endMemberDrag}><span className="group-node-avatar">{member.avatar ? <img src={member.avatar} alt="" draggable={false} /> : <span className="group-node-avatar-fallback" aria-hidden="true">{member.name.slice(0, 1)}</span>}{scheduledRules.length ? <span className={`group-node-schedule-badge${scheduleActive ? " is-active" : ""}`} role="img" aria-label={scheduleLabel} title={scheduleLabel}><Clock size={13} aria-hidden="true" /></span> : null}</span><strong>{member.name}</strong><small><i className={`group-status-dot is-${member.accent}`} />{member.status}</small></button>;
            })}
            {edgeGeometry.filter((edge) => edge.label).map((edge) => <span className={`group-edge-label is-${edge.type}`} key={`${edge.from}-${edge.to}-label`} style={{ left: `${edge.labelX}%`, top: `${edge.labelY}%`, transform: `translate(-50%, -50%) scale(${canvasZoom})` }}>{edge.label}{edge.detail ? <><br /><b>{edge.detail}</b></> : null}</span>)}
            {directEmployeeId ? <div className="group-canvas-employee-feed">{renderEmployeeConversation?.({ employeeId: directEmployeeId, taskId: automationTaskIds[0] || "", view: "feed", onOpenChat: () => setActiveNav("chat") })}</div> : null}
          </div>
            <div className="group-canvas-zoom" aria-label="画布缩放"><button type="button" onClick={() => setCanvasZoom((value) => Math.max(.7, Number((value - .1).toFixed(1))))} aria-label="缩小">−</button><span>{Math.round(canvasZoom * 100)}%</span><button type="button" onClick={() => setCanvasZoom((value) => Math.min(1.5, Number((value + .1).toFixed(1))))} aria-label="放大">＋</button></div>
          </div>
          {directEmployeeId ? <div className="group-employee-progress">{renderEmployeeConversation?.({ employeeId: directEmployeeId, taskId: automationTaskIds[0] || "", view: "progress" })}</div> : null}
          {!directEmployeeId ? <>
          <div className="group-activity-footer"><strong>活动</strong><span>{(safeProjection?.activities || []).length} 条 Center 安全投影</span><button type="button" onClick={() => setActiveNav("activity")}>查看活动</button></div>
          {groupAttachments.length || groupMaterialState?.inputRefs?.length ? <div className="group-material-strip" role="status" aria-live="polite">
            <div className="group-material-list">{groupAttachments.map((file) => <div className="group-material-item" key={file.id}><FileText size={14} /><span title={file.name}><strong>{file.name}</strong><small>{attachmentKindLabel(file)} · {formatFileSize(file.size)}</small></span><button type="button" aria-label={`移除${file.name}`} onClick={() => removeGroupAttachment(file.id)}><X size={12} /></button></div>)}</div>
            <div className="group-material-safe" data-status={groupMaterialState?.status || "idle"}><span>安全材料清单 · {groupAttachments.length ? `${groupMaterialState?.fileCount || groupAttachments.length} 个文件` : `${groupMaterialState?.inputRefs?.length || 0} 个草案材料引用`}</span><small>{groupMaterialState?.status === "ready" ? "材料已加入 Group，准备就绪" : groupMaterialState?.status === "preparing" ? "正在准备材料" : groupMaterialState?.status === "error" ? "材料准备失败" : "尚未准备"}</small></div>
          </div> : null}
          {groupAttachmentFeedback ? <div className={`group-attachment-feedback is-${groupAttachmentFeedback.tone}`} role="status" aria-live="polite">{groupAttachmentFeedback.text}</div> : null}
          <div className={`group-context-strip${selectedHistory || newGoalIntent ? " is-active" : " is-empty"}`} role="status"><span className="group-context-dot" /><strong>{selectedHistory ? "当前选中目标" : newGoalIntent ? "新建 Group 目标" : "尚未选择目标"}</strong><small>{selectedHistory ? (selectedHistory.title || "已选任务") : newGoalIntent ? "本次发送将创建新的 Goal" : "选择历史目标，或点击右上角＋新建"}</small>{selectedHistory ? <b>{selectedStatus}</b> : null}{selectedRework ? <button type="button" disabled={busy} onClick={() => setReworkIntent(reworkIntent === activeRunId ? "" : activeRunId)}>{reworkIntent === activeRunId ? "取消返工" : "发起返工"}</button> : safeProjection?.activation === "resume_required" || safeProjection?.activation === "paused" ? <button type="button" disabled={busy} onClick={() => controlRun("resume")}>恢复</button> : selectedHistory?.status === "failed" ? <button type="button" disabled={busy} onClick={() => startRun({ recoverPlanning: true })}>重试</button> : null}</div>
          <div className={`group-composer workbench-composer has-assignment${groupDragActive ? " is-drag-active" : ""}`} onDragEnter={(event) => { if (!isMaterialDrag(event.dataTransfer)) return; event.preventDefault(); groupDragDepthRef.current += 1; setGroupDragActive(true); }} onDragOver={(event) => { if (!isMaterialDrag(event.dataTransfer)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { event.preventDefault(); groupDragDepthRef.current = Math.max(0, groupDragDepthRef.current - 1); if (!groupDragDepthRef.current) setGroupDragActive(false); }} onDrop={handleGroupDrop}>
            {assignmentControl}<button type="button" className="group-composer-attach" onClick={chooseGroupFiles} aria-label="选择 Group 材料" title="选择材料（也可直接拖入）"><Paperclip size={16} /></button><input value={composer} disabled={!composerEnabled} onChange={(event) => setComposer(event.target.value)} onKeyDown={handleGroupComposerKeyDown} placeholder={composerPlaceholder} /><button type="button" onClick={runCanStop ? () => controlRun("cancel") : busy ? stopPlanning : sendMessage} aria-label={runCanStop || busy ? (planningCancelState === "confirmed" ? "Group 已停止，正在同步" : planningCancelState === "stopping" ? "正在停止 Group" : "停止 Group") : "生成项目组规划草案"} disabled={runCanStop ? submittingRef.current : busy ? ["stopping", "confirmed"].includes(planningCancelState) || !planningCancelRef.current : !composerEnabled || !composer.trim() || Boolean(groupAttachments.length && groupMaterialState?.status !== "ready")} className={runCanStop || busy ? "is-stop" : ""}>{runCanStop || busy ? <Square size={15} weight="fill" /> : <ArrowUp size={19} weight="bold" />}</button><input ref={groupFileInputRef} type="file" multiple hidden onChange={handleGroupBrowserFileChange} />
          </div>
          </> : <section className="group-employee-composer group-employee-conversation employee-conversation-body">{renderEmployeeConversation?.({ employeeId: directEmployeeId, assignmentControl, view: "composer" })}</section>}
          </> : null}
        </section>

        <aside className="group-right-rail">
          <div className="group-right-tabs"><button type="button" className="is-active" disabled aria-disabled="true">成员详情</button><button type="button" onClick={() => setActiveNav("reviewers")}>复核小组</button><button type="button" onClick={() => setActiveNav("activity")}>活动</button></div>
          <div className="group-selected-person">{selected.avatar ? <img src={selected.avatar} alt="" /> : <span className="group-selected-avatar-fallback" aria-hidden="true">{selected.name.slice(0, 1)}</span>}<div><span>当前选中成员</span><strong>{selected.name}</strong><small>{selected.role}</small></div><button type="button" aria-label="更多" disabled aria-disabled="true"><DotsThree size={18} /></button></div>
          <div className="group-detail-block"><span>当前关系</span><strong>{relatedIds.size} 个协作连接</strong><p>亮点沿来源 → 接收者流动，仅示意关系方向，不代表实际传输。</p>
            <div className="group-relation-actions">{canvasMemberIds.has(selected.id) && selected.accessGroup === "direct" ? canvasMembers.filter((member) => member.id !== selected.id && member.accessGroup === "direct").map((member) => <span key={member.id}>
              <button type="button" disabled={Boolean(activeRunId)} onClick={() => setGroupLink(member.id, "handoff")}>交接 {member.name}</button>
              <button type="button" disabled={Boolean(activeRunId)} aria-label={`由${member.name}复核${selected.name}的产出`} onClick={() => setGroupLink(member.id, "review")}>复核</button>
            </span>) : <p>该员工未加入当前团队，不能建立关联。</p>}</div>
            {canvasMemberIds.has(selected.id) ? <button type="button" className="group-remove-member" disabled={busy || Boolean(activeRunId)} onClick={() => removeGroupMember(selected.id)}>移出当前团队</button> : selected.accessGroup === "direct" ? <button type="button" className="group-add-member" disabled={busy || Boolean(activeRunId)} onClick={() => addGroupMember(selected.id)}>加入当前团队</button> : null}
          </div>
          <button type="button" className="group-inspect-button" disabled={selected.accessGroup !== "direct" || !onOpenEmployeeConversation} onClick={() => onOpenEmployeeConversation?.({ employeeId: selected.id })}><ChatCircleDots size={15} />与当前员工对话</button>
          <div className="group-detail-block"><span>能力与工具</span>{selected.accessGroup === "direct" ? (selected.tools || []).slice(0, 5).map((item) => <div className="group-capability" key={item.toolId || item.id || item.name}><Sparkle size={13} />{item.name || item.toolId || item.id}<i>可调用</i></div>) : <p>{selected.accessGroup === "request" ? "提交申请并审批通过后，Center 才会返回可用 Tool。" : "当前访问状态不支持调用该成员的 Tool。"}</p>}{selected.accessGroup === "direct" && !(selected.tools || []).length ? <p>该账号尚未为此 Group 返回可用 Tool。</p> : null}</div>
          <div className="group-detail-block"><span>共享上下文</span>{safeProjection?.steps?.filter((step) => step.status === "completed").map((step) => <div className="group-context-item" key={step.stepId}><FileText size={15} /><span>{step.stepId}<small>已由 Center 标记完成</small></span></div>)}{!safeProjection?.steps?.some((step) => step.status === "completed") ? <p>完成步骤后，Center 会在此显示可共享产物。</p> : null}</div>
          <button type="button" className="group-inspect-button" disabled aria-disabled="true"><SlidersHorizontal size={14} />查看安全活动</button>
        </aside>
      </section>
      {planSheetOpen && (pendingPlan || inspectedDraft) ? <div className="group-plan-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setPlanSheetOpen(false); }}><section className="group-plan-sheet" role="dialog" aria-modal="true" aria-labelledby="group-plan-sheet-title"><header><div><strong id="group-plan-sheet-title">第 {inspectedDraft?.goalRevision || pendingPlan?.goal?.revision} 轮计划草案</strong><span>{(inspectedDraft || pendingPlan?.draft)?.steps?.length || 0} 个步骤 · {inspectedDraft ? "历史只读" : "待确认"}</span></div><button type="button" aria-label="关闭草案" onClick={() => setPlanSheetOpen(false)}><X size={18} /></button></header><div className="group-plan-sheet-content"><p>{inspectedDraft ? "历史草案仅供回看，不会在此启动执行。" : "检查职责与依赖。采纳前不会启动执行。"}</p><div className="group-plan-step-cards">{((inspectedDraft || pendingPlan?.draft)?.steps || []).map((step, index) => <article key={step.stepId}><b>{String(index + 1).padStart(2, "0")}</b><div><strong>{members.find((member) => member.employeeId === step.employeeId)?.name || step.employeeId}</strong><span>{step.kind === "delegate" ? "执行" : step.kind === "summary" ? "汇总" : step.kind === "consult" ? "协助" : "复核"} · {step.stepId}</span><small>{step.dependsOn?.length ? `依赖：${step.dependsOn.join("、")}` : "无前置依赖"}</small></div></article>)}</div></div><footer><button type="button" onClick={() => setPlanSheetOpen(false)}>返回工作区</button>{!inspectedDraft && pendingPlan ? <button type="button" className="group-plan-adopt" onClick={adoptPlan} disabled={busy}>采纳计划</button> : null}</footer></section></div> : null}
      {notice ? <div className="group-prototype-toast" role="status"><Check size={15} weight="bold" />{notice}</div> : null}
      <div className="group-prototype-footer"><span><Bell size={14} /> 账号成员与运行状态</span><span><span className="group-live-dot" /> {safeProjection ? `中心投影：${safeProjection.status}` : "等待 GroupRun"}</span><span>账号会话 <b>{authenticated ? "已登录" : "未登录"}</b></span></div>
    </main>
  );
}
