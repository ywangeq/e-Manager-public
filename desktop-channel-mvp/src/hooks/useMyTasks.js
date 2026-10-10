import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendDesktopTaskEvent,
  isDesktopTaskTerminalStatus,
  normalizeDesktopTaskEvent,
} from "../../shared/desktop-task-timeline.mjs";
import {
  desktopMyTaskFollowRequest,
  isDesktopMyTaskActiveStatus,
  isDesktopMyTaskCancelableStatus,
  projectDesktopMyTaskDetail,
} from "../../shared/desktop-my-tasks.mjs";

const EMPTY_PAGE = Object.freeze({ contractVersion: "current-user-runtime-tasks.v1", queues: [], tasks: [] });

export function useMyTasks(desktopApi, {
  actorContextVersion = 0,
  authenticated,
  bootstrapRevision = 0,
} = {}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(EMPTY_PAGE);
  const [details, setDetails] = useState({});
  const [expandedTaskId, setExpandedTaskId] = useState("");
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [cancelingTaskIds, setCancelingTaskIds] = useState(() => new Set());
  const [feedbackStates, setFeedbackStates] = useState({});
  const previewPageRef = useRef(null);
  const pageRef = useRef(EMPTY_PAGE);
  const detailsRef = useRef({});
  const followingRef = useRef(new Set());
  const identityRef = useRef("");
  const actorIdentityRef = useRef("");
  const detailEpochRef = useRef(new Map());
  const detailSequenceRef = useRef(0);
  const detailTargetRevisionRef = useRef(new Map());
  const listRequestSequenceRef = useRef(0);
  const listRefreshStateRef = useRef({ actorIdentity: "", inFlight: null, trailing: false });
  const expandedTaskIdRef = useRef("");
  const convergeDetailRef = useRef(() => {});
  const actorIdentity = authenticated ? String(actorContextVersion || "preview") : "";
  if (actorIdentityRef.current !== actorIdentity) actorIdentityRef.current = actorIdentity;
  detailsRef.current = details;
  pageRef.current = page;
  expandedTaskIdRef.current = expandedTaskId;

  const performRefresh = useCallback(async () => {
    if (!authenticated) return EMPTY_PAGE;
    const requestActorIdentity = actorIdentityRef.current;
    const requestSequence = ++listRequestSequenceRef.current;
    const currentListRequest = (actorIdentity, sequence) => actorIdentityRef.current === actorIdentity &&
      listRequestSequenceRef.current === sequence;
    setPhase(current => current === "ready" || current === "saving" ? current : "loading");
    setError("");
    if (!desktopApi?.listMyTasks) {
      const preview = previewPageRef.current || previewMyTasksPage();
      previewPageRef.current = preview;
      setPage(preview);
      setPhase("ready");
      return preview;
    }
    const result = await desktopApi.listMyTasks().catch(() => ({ ok: false, status: "network_unavailable" }));
    if (actorIdentityRef.current !== requestActorIdentity || listRequestSequenceRef.current !== requestSequence) return null;
    if (!result?.ok || !result.page) {
      setPage((current) => currentListRequest(requestActorIdentity, requestSequence) ? EMPTY_PAGE : current);
      setDetails((current) => currentListRequest(requestActorIdentity, requestSequence) ? {} : current);
      setExpandedTaskId((current) => currentListRequest(requestActorIdentity, requestSequence) ? "" : current);
      setPhase((current) => currentListRequest(requestActorIdentity, requestSequence) ? "error" : current);
      setError((current) => currentListRequest(requestActorIdentity, requestSequence) ? taskQueueMessage(result?.status) : current);
      return null;
    }
    setPage((current) => currentListRequest(requestActorIdentity, requestSequence) ? result.page : current);
    setCancelingTaskIds((current) => {
      if (!currentListRequest(requestActorIdentity, requestSequence)) return current;
      if (!current.size) return current;
      const cancelableIds = new Set(result.page.tasks
        .filter((task) => isDesktopMyTaskCancelableStatus(task.status))
        .map((task) => task.id));
      const next = new Set([...current].filter((taskId) => cancelableIds.has(taskId)));
      return next.size === current.size ? current : next;
    });
    const taskIds = new Set(result.page.tasks.map((task) => task.id));
    const taskKeys = new Set(result.page.tasks.map(detailKey));
    for (const cache of [detailEpochRef.current, detailTargetRevisionRef.current]) {
      for (const key of cache.keys()) if (!taskKeys.has(key)) cache.delete(key);
    }
    setFeedbackStates(current => currentListRequest(requestActorIdentity, requestSequence)
      ? Object.fromEntries(Object.entries(current).filter(([id]) => taskIds.has(id))) : current);
    const terminalStaleTasks = result.page.tasks.filter((task) => {
      const current = detailsRef.current[task.id];
      return taskNeedsCanonicalDetail(current, task, detailTargetRevisionRef.current.get(detailKey(task)));
    });
    setDetails((current) => {
      if (!currentListRequest(requestActorIdentity, requestSequence)) return current;
      return Object.fromEntries(Object.entries(current)
        .filter(([taskId]) => taskIds.has(taskId))
        .map(([taskId, state]) => {
          const task = result.page.tasks.find((item) => item.id === taskId);
          if (!task || !terminalStaleTasks.some((item) => item.id === taskId)) return [taskId, state];
          return [taskId, { ...state, stale: true, staleListRevision: task.revision }];
        }));
    });
    for (const task of terminalStaleTasks) {
      if (expandedTaskIdRef.current === task.id) void convergeDetailRef.current(task);
    }
    setPhase((current) => currentListRequest(requestActorIdentity, requestSequence) ? "ready" : current);
    return result.page;
  }, [actorContextVersion, authenticated, bootstrapRevision, desktopApi]);

  const refresh = useCallback(() => {
    if (!authenticated) return Promise.resolve(EMPTY_PAGE);
    const requestActorIdentity = actorIdentityRef.current;
    let state = listRefreshStateRef.current;
    if (state.actorIdentity !== requestActorIdentity) {
      state = { actorIdentity: requestActorIdentity, inFlight: null, trailing: false };
      listRefreshStateRef.current = state;
    }
    if (state.inFlight) {
      state.trailing = true;
      return state.inFlight;
    }
    const request = (async () => {
      let result = await performRefresh();
      if (listRefreshStateRef.current === state && state.trailing) {
        state.trailing = false;
        result = await performRefresh();
      }
      return result;
    })();
    state.inFlight = request.finally(() => {
      if (listRefreshStateRef.current === state) {
        state.inFlight = null;
        state.trailing = false;
      }
    });
    return state.inFlight;
  }, [authenticated, performRefresh]);

  const show = useCallback(() => {
    setOpen(true);
    void refresh();
  }, [refresh]);

  const close = useCallback(() => setOpen(false), []);

  const reorder = useCallback(async (queue, orderedTaskIds) => {
    if (!queue?.reorderable || phase === "saving") return;
    setPhase("saving");
    setError("");
    if (!desktopApi?.reorderMyTasks) {
      setPage((current) => {
        const next = reorderPreviewPage(current, queue.employee.id, orderedTaskIds);
        previewPageRef.current = next;
        return next;
      });
      setPhase("ready");
      return;
    }
    const result = await desktopApi.reorderMyTasks({
      employeeId: queue.employee.id,
      expectedRevision: queue.revision,
      orderedTaskIds,
    }).catch(() => ({ ok: false, status: "network_unavailable" }));
    if (!result?.ok || !result.page) {
      setPhase("error");
      setError(taskQueueMessage(result?.status));
      await refresh();
      return;
    }
    setPage(result.page);
    setPhase("ready");
  }, [desktopApi, phase, refresh]);

  const cancel = useCallback(async (task) => {
    if (!task?.id || phase === "saving") return;
    const taskId = String(task.id);
    setCancelingTaskIds((current) => new Set(current).add(taskId));
    setPhase("saving");
    setError("");
    if (!desktopApi?.cancelAssistantTask) {
      setPage((current) => {
        const next = cancelPreviewTask(current, task);
        previewPageRef.current = next;
        return next;
      });
      setPhase("ready");
      return;
    }
    const result = await desktopApi.cancelAssistantTask({
      employeeId: task.employeeId,
      taskId,
    }).catch(() => ({ ok: false, status: "network_unavailable" }));
    if (!result?.ok) {
      setCancelingTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
      setError(taskQueueMessage(result?.error || result?.status));
    }
    await refresh();
  }, [desktopApi, phase, refresh]);

  const loadDetail = useCallback(async (task) => {
    if (!task?.id || !authenticated) return null;
    const requestActorIdentity = actorIdentityRef.current;
    const taskKey = detailKey(task);
    const targetRevision = Number(task.revision || 0);
    if (targetRevision > 0) detailTargetRevisionRef.current.set(taskKey, targetRevision);
    const detailEpoch = bumpDetailEpoch(detailEpochRef.current, task, ++detailSequenceRef.current);
    const currentRead = () => actorIdentityRef.current === requestActorIdentity &&
      detailEpochRef.current.get(detailKey(task)) === detailEpoch;
    setDetails((current) => ({
      ...current,
      [task.id]: { ...current[task.id], phase: "loading", error: "", stale: false, syncing: true },
    }));
    const result = desktopApi?.getMyTaskDetail
      ? await desktopApi.getMyTaskDetail({ employeeId: task.employeeId, taskId: task.id })
        .catch(() => ({ ok: false, status: "network_unavailable" }))
      : { ok: true, detail: previewMyTaskDetail(task) };
    if (!currentRead()) return null;
    if (!result?.ok || !result.detail) {
      detailTargetRevisionRef.current.delete(taskKey);
      if (isAccessFailure(result?.status)) {
        setPage((current) => currentRead() ? EMPTY_PAGE : current);
        setDetails((current) => currentRead() ? {} : current);
        setExpandedTaskId((current) => currentRead() ? "" : current);
      } else {
        setDetails((current) => currentRead()
          ? { ...current, [task.id]: { ...current[task.id], phase: "error", error: taskDetailMessage(result?.status), stale: true, syncing: false } }
          : current);
      }
      return null;
    }
    setDetails((current) => {
      if (!currentRead()) return current;
      const previous = current[task.id]?.detail;
      const detail = mergeVerifiedTaskDetail(previous, result.detail);
      return {
        ...current,
        [task.id]: {
          ...current[task.id],
          phase: "ready",
          error: "",
          detail,
          listRevision: task.revision,
          stale: false,
          staleListRevision: null,
          syncing: false,
        },
      };
    });
    return result.detail;
  }, [authenticated, desktopApi]);

  const convergeTaskDetail = useCallback((task) => {
    const current = detailsRef.current[task?.id];
    if (!task?.id || (!current?.detail && expandedTaskIdRef.current !== task.id)) return;
    return loadDetail(task);
  }, [loadDetail]);
  convergeDetailRef.current = convergeTaskDetail;

  const toggleTask = useCallback((task) => {
    if (!task?.id) return;
    if (expandedTaskIdRef.current === task.id) {
      setExpandedTaskId("");
      return;
    }
    const detailState = detailsRef.current[task.id];
    setExpandedTaskId(task.id);
    if (detailState?.phase !== "ready" || detailState?.stale) void loadDetail(task);
  }, [loadDetail]);

  const inspectArtifact = useCallback(async (reference) => {
    if (!desktopApi?.getArtifactDelivery) return previewArtifactDelivery(reference);
    return desktopApi.getArtifactDelivery(reference).catch(() => ({ ok: false, status: "network_unavailable" }));
  }, [desktopApi]);

  const deliverArtifact = useCallback(async (request) => {
    if (!desktopApi?.deliverArtifact) return { ok: true, status: request?.action === "open" ? "opened" : request?.action === "reveal" ? "revealed" : "landed" };
    return desktopApi.deliverArtifact(request)
      .catch(() => ({ ok: false, status: "network_unavailable" }));
  }, [desktopApi]);

  const submitFeedback = useCallback(async (task, rating, reasonCode = "") => {
    if (!task?.id || task.status !== "completed" || task.feedback) {
      return { ok: false, status: "desktop_my_task_feedback_not_available" };
    }
    const taskId = String(task.id);
    const idempotencyKey = `desktop-feedback:${task.revision}:${rating}:${reasonCode || "none"}`;
    setFeedbackStates((current) => ({
      ...current,
      [taskId]: { phase: "saving", error: "", rating },
    }));
    const request = {
      employeeId: task.employeeId,
      taskId,
      expectedRevision: task.revision,
      idempotencyKey,
      rating,
      reasonCode,
    };
    let result;
    if (!desktopApi?.submitMyTaskFeedback) {
      const receipt = previewFeedbackReceipt(task, rating);
      setPage((current) => {
        const next = applyFeedbackReceipt(current, receipt);
        previewPageRef.current = next;
        return next;
      });
      result = { ok: true, receipt };
    } else {
      result = await desktopApi.submitMyTaskFeedback(request)
        .catch(() => ({ ok: false, status: "network_unavailable" }));
    }
    if (!result?.ok || !result.receipt?.feedback) {
      setFeedbackStates((current) => ({
        ...current,
        [taskId]: { phase: "error", error: taskFeedbackMessage(result?.status), rating },
      }));
      if (isAccessFailure(result?.status)) {
        setPage(EMPTY_PAGE);
        setDetails({});
        setExpandedTaskId("");
      } else if (String(result?.status || "").includes("conflict")) {
        await refresh();
      }
      return result || { ok: false, status: "desktop_my_task_feedback_failed" };
    }
    setPage((current) => applyFeedbackReceipt(current, result.receipt));
    setFeedbackStates((current) => ({
      ...current,
      [taskId]: { phase: "ready", error: "", rating },
    }));
    return result;
  }, [desktopApi, refresh]);

  const observeTaskEvent = useCallback((event) => {
    const taskId = String(event?.taskId || "");
    if (!taskId || event?.eventType !== "task.state_changed" ||
      isDesktopMyTaskCancelableStatus(event.data?.status)) return;
    setCancelingTaskIds((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  useEffect(() => {
    const listenerActorIdentity = actorIdentityRef.current;
    const removeTask = desktopApi?.onAssistantTask?.((payload) => {
      if (actorIdentityRef.current !== listenerActorIdentity) return;
      const taskId = String(payload?.taskId || "");
      if (String(payload?.streamId || "") !== myTaskStreamId(taskId)) return;
      setDetails((current) => ({
        ...current,
        [taskId]: { ...current[taskId], connectionState: String(payload?.connectionState || "") },
      }));
    });
    const removeEvent = desktopApi?.onAssistantTaskEvent?.((payload) => {
      if (actorIdentityRef.current !== listenerActorIdentity) return;
      const employeeId = String(payload?.employeeId || "");
      const taskId = String(payload?.taskId || "");
      if (!employeeId || String(payload?.streamId || "") !== myTaskStreamId(taskId)) return;
      const event = normalizeDesktopTaskEvent(payload?.event, { expectedTaskId: taskId });
      if (!event) return;
      const knownEvents = detailsRef.current[taskId]?.detail?.events || [];
      if (knownEvents.some((item) => item.seq === event.seq)) return;
      observeTaskEvent(event);
      setDetails((current) => {
        const previous = current[taskId]?.detail;
        const events = appendDesktopTaskEvent(previous?.events, event);
        return {
          ...current,
          [taskId]: {
            ...current[taskId],
            phase: "ready",
            syncing: false,
            detail: projectDesktopMyTaskDetail({
              employeeId,
              taskId,
              events,
              result: previous?.result || null,
              activitySnapshot: previous?.activitySnapshot,
              provenanceSnapshot: previous?.provenanceSnapshot,
            }),
          },
        };
      });
      if (event.eventType === "task.state_changed") {
        if (isDesktopTaskTerminalStatus(event.data?.status)) {
          const task = pageRef.current.tasks.find((item) => item.id === taskId) || { employeeId, id: taskId };
          void convergeDetailRef.current(task);
        }
        void refresh();
      }
    });
    return () => {
      removeTask?.();
      removeEvent?.();
    };
  }, [actorIdentity, desktopApi, observeTaskEvent, refresh]);

  useEffect(() => {
    if (!authenticated || !desktopApi?.followAssistantTask) return;
    const followActorIdentity = actorIdentityRef.current;
    for (const task of page.tasks.filter((item) => isDesktopMyTaskActiveStatus(item.status))) {
      const followKey = `${actorContextVersion}:${task.employeeId}:${task.id}`;
      if (followingRef.current.has(followKey)) continue;
      followingRef.current.add(followKey);
      const request = desktopMyTaskFollowRequest(task, detailsRef.current[task.id]?.detail);
      desktopApi.followAssistantTask(request).then(() => {
        if (actorIdentityRef.current !== followActorIdentity) return;
        followingRef.current.delete(followKey);
        const currentTask = pageRef.current.tasks.find((item) => item.id === task.id && item.employeeId === task.employeeId) || task;
        void convergeDetailRef.current(currentTask);
        void refresh();
      }).catch(() => {
        if (actorIdentityRef.current === followActorIdentity) followingRef.current.delete(followKey);
      });
    }
  }, [actorContextVersion, authenticated, desktopApi, page.tasks, refresh]);

  useEffect(() => {
    const identity = authenticated ? String(actorContextVersion || "preview") : "";
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      detailEpochRef.current.clear();
      detailTargetRevisionRef.current.clear();
      listRequestSequenceRef.current += 1;
      listRefreshStateRef.current = { actorIdentity: identity, inFlight: null, trailing: false };
      previewPageRef.current = null;
      followingRef.current.clear();
      setOpen(false);
      setPage(EMPTY_PAGE);
      setDetails({});
      setExpandedTaskId("");
      setCancelingTaskIds(new Set());
      setFeedbackStates({});
      setPhase("idle");
      setError("");
    }
    if (!authenticated) {
      return undefined;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), open ? 4_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [actorContextVersion, authenticated, open, refresh]);

  const counts = useMemo(() => ({
    running: page.tasks.filter((task) => isDesktopMyTaskActiveStatus(task.status)).length,
    queued: page.tasks.filter((task) => task.status === "queued").length,
  }), [page]);

  return {
    busy: ["loading", "saving"].includes(phase),
    cancel,
    cancelingTaskIds,
    close,
    counts,
    error,
    deliverArtifact,
    details,
    expandedTaskId,
    feedbackStates,
    inspectArtifact,
    loadDetail,
    observeTaskEvent,
    open,
    page,
    phase,
    refresh,
    reorder,
    show,
    submitFeedback,
    toggleTask,
  };
}

function myTaskStreamId(taskId) {
  return `my-task:${String(taskId || "").slice(0, 128)}`;
}

function detailKey(task = {}) {
  return `${String(task.employeeId || "")}:${String(task.id || task.taskId || "")}`;
}

function bumpDetailEpoch(epochs, task, next) {
  const key = detailKey(task);
  epochs.set(key, next);
  return next;
}

function taskNeedsCanonicalDetail(state, task, inFlightRevision = 0) {
  if (!state?.detail || !isDesktopTaskTerminalStatus(task?.status)) return false;
  const listRevision = Number(task.revision || 0);
  const recordedRevision = Number(state.listRevision || 0);
  const targetRevision = Number(state.staleListRevision || 0);
  if (listRevision > 0 && Number(inFlightRevision || 0) >= listRevision) return false;
  if (listRevision > 0 && targetRevision >= listRevision) return false;
  if (listRevision > recordedRevision) return true;
  if (state.detail.status !== task.status) return true;
  return task.status === "completed" && !state.detail.result && !state.stale && !state.syncing;
}

function mergeVerifiedTaskDetail(previous, next) {
  if (!previous || previous.employeeId !== next.employeeId || previous.taskId !== next.taskId) return next;
  const events = next.events.reduce((current, event) => appendDesktopTaskEvent(current, event), previous.events);
  return projectDesktopMyTaskDetail({
    employeeId: next.employeeId,
    taskId: next.taskId,
    events,
    result: next.result || previous.result || null,
    activitySnapshot: next.activitySnapshot,
    provenanceSnapshot: next.provenanceSnapshot,
  });
}

function isAccessFailure(code) {
  return /access_denied|authentication_required|actor_changed/.test(String(code || ""));
}

function taskDetailMessage(code) {
  if (isAccessFailure(code)) return "当前身份无权查看此任务。";
  if (String(code || "").includes("result")) return "任务结果暂时不可用，请稍后重试。";
  return "任务详情暂时不可用，请稍后重试。";
}

function taskQueueMessage(code) {
  if (String(code || "").includes("revision_conflict")) return "队列刚刚发生变化，已重新同步。";
  if (String(code || "").includes("actor_changed")) return "企业身份已变化，请重新打开任务列表。";
  if (String(code || "").includes("identity_conflict")) return "员工队列身份需要中心复核，暂未修改顺序。";
  return "任务队列暂时不可用，请稍后重试。";
}

function taskFeedbackMessage(code) {
  if (isAccessFailure(code)) return "当前身份无权提交反馈。";
  if (String(code || "").includes("conflict")) return "反馈状态已变化，正在重新同步。";
  if (String(code || "").includes("quality")) return "质量复盘暂时不可用，请稍后重试。";
  return "反馈暂时未提交，请稍后重试。";
}

function previewMyTasksPage() {
  const now = new Date().toISOString();
  const employee = { id: "example-assistant", name: "示例助手", version: "preview" };
  const secondEmployee = { id: "example-reviewer", name: "示例复核助手", version: "preview" };
  const revision = "a".repeat(64);
  const secondRevision = "b".repeat(64);
  const tasks = [
    previewTask("preview-running", "running", null, employee, revision, now),
    previewTask("preview-queue-1", "queued", 1, employee, revision, now),
    previewTask("preview-queue-2", "queued", 2, employee, revision, now),
    previewTask("task_preview_canonical_timeline", "completed", null, secondEmployee, secondRevision, now),
  ];
  return {
    contractVersion: "current-user-runtime-tasks.v1",
    queues: [{
      contractVersion: "current-user-runtime-task-queue.v1",
      employee,
      runningTaskIds: ["preview-running"],
      queuedTaskIds: ["preview-queue-1", "preview-queue-2"],
      revision,
      reorderable: true,
      reorderReason: "ready",
    }, {
      contractVersion: "current-user-runtime-task-queue.v1",
      employee: secondEmployee,
      runningTaskIds: [],
      queuedTaskIds: [],
      revision: secondRevision,
      reorderable: false,
      reorderReason: "insufficient_tasks",
    }],
    tasks,
  };
}

function previewTask(id, status, position, employee, revision, now) {
  const completed = status === "completed";
  return {
    id,
    revision: 1,
    employeeId: employee.id,
    employeeName: employee.name,
    taskTitle: completed ? "整理协作任务的执行结果（演示）" : status === "running" ? "检查模型训练进度（演示）" : `待执行的分析任务 ${position}（演示）`,
    status,
    statusLabel: status === "running" ? "运行中" : completed ? "已完成" : "排队中",
    feedback: null,
    nextGate: status === "running" ? "Worker 已领取任务，正在执行。" : completed ? "任务已完成。" : "任务已入队，等待 Worker 领取。",
    submittedAt: now,
    startedAt: status === "running" ? now : "",
    finishedAt: completed ? now : "",
    updatedAt: now,
    queue: { position, revision, reorderable: status === "queued" },
  };
}

function previewFeedbackReceipt(task, rating) {
  const timestamp = new Date().toISOString();
  return {
    employeeId: task.employeeId,
    taskId: task.id,
    revision: task.revision,
    feedback: {
      contractVersion: "runtime-task-feedback.v1",
      sourceChannel: "desktop",
      availability: "available",
      status: rating === "helpful" ? "quality_ok" : "pending_quality_review",
      rating,
      qualityEventId: rating === "helpful" ? "" : "QEFDBK-preview",
      diagnosticChainVersion: rating === "helpful" ? "" : "runtime-task-feedback-diagnostic-chain.v1",
      receivedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function applyFeedbackReceipt(page, receipt) {
  return {
    ...page,
    tasks: page.tasks.map((task) => task.id === receipt.taskId && task.employeeId === receipt.employeeId
      ? { ...task, feedback: receipt.feedback }
      : task),
  };
}

function previewMyTaskDetail(task) {
  const occurredAt = task.updatedAt || new Date().toISOString();
  const events = [
    previewTaskEvent(task.id, 1, "task.state_changed", occurredAt, {
      status: "queued",
      waitReasonCode: "awaiting_worker",
      lastErrorCode: null,
      attemptCount: 0,
      recoveryCount: 0,
      code: "task_submitted",
    }),
  ];
  if (task.status === "running") {
    events.push(previewTaskEvent(task.id, 2, "task.state_changed", occurredAt, {
      status: "running",
      waitReasonCode: null,
      lastErrorCode: null,
      attemptCount: 1,
      recoveryCount: 0,
      code: "worker_claimed",
    }));
  }
  let result = null;
  if (task.status === "completed") {
    events.push(
      previewTaskEvent(task.id, 2, "task.progress", occurredAt, { stage: "tool", status: "completed", code: "tool_completed" }),
      previewTaskEvent(task.id, 3, "task.artifact_available", occurredAt, { artifactId: "artifact-preview-report" }),
      previewTaskEvent(task.id, 4, "task.result_available", occurredAt, { resultKind: "conversation_history" }),
      previewTaskEvent(task.id, 5, "task.state_changed", occurredAt, {
        status: "completed",
        waitReasonCode: null,
        lastErrorCode: null,
        attemptCount: 1,
        recoveryCount: 0,
        code: "worker_settled",
      }),
    );
    result = { text: "任务已完成，安全结果已由 Center 保存，可继续查看交付产物。", createdAt: occurredAt };
  }
  return projectDesktopMyTaskDetail({ employeeId: task.employeeId, taskId: task.id, events, result });
}

function previewTaskEvent(taskId, seq, eventType, occurredAt, data) {
  return {
    contractVersion: "task-event.v1",
    taskId,
    seq,
    taskRevision: seq,
    eventType,
    occurredAt,
    data,
  };
}

function previewArtifactDelivery(reference) {
  return {
    ok: true,
    status: "available",
    artifact: {
      artifactId: reference?.artifactId,
      fileName: "任务交付报告.md",
      mimeType: "text/markdown",
      sizeBytes: 28_416,
      deliveryStatus: "available",
      canOpen: true,
      localAvailability: "landed",
    },
  };
}

function reorderPreviewPage(page, employeeId, orderedTaskIds) {
  const revision = page.queues.find((queue) => queue.employee.id === employeeId)?.revision || "b".repeat(64);
  return {
    ...page,
    queues: page.queues.map((queue) => queue.employee.id === employeeId ? { ...queue, queuedTaskIds: orderedTaskIds, revision } : queue),
    tasks: page.tasks.map((task) => {
      const position = orderedTaskIds.indexOf(task.id);
      return task.employeeId === employeeId && position >= 0 ? { ...task, queue: { ...task.queue, position: position + 1, revision } } : task;
    }),
  };
}

function cancelPreviewTask(page, task) {
  const canceledAt = new Date().toISOString();
  return {
    ...page,
    queues: page.queues.map((queue) => {
      if (queue.employee.id !== task.employeeId) return queue;
      const queuedTaskIds = queue.queuedTaskIds.filter((id) => id !== task.id);
      return {
        ...queue,
        runningTaskIds: queue.runningTaskIds.filter((id) => id !== task.id),
        queuedTaskIds,
        reorderable: queuedTaskIds.length >= 2,
        reorderReason: queuedTaskIds.length >= 2 ? "ready" : "insufficient_tasks",
      };
    }),
    tasks: page.tasks.map((item) => item.id === task.id ? {
      ...item,
      status: "canceled",
      statusLabel: "已停止",
      nextGate: "任务已按用户请求停止。",
      finishedAt: canceledAt,
      updatedAt: canceledAt,
      queue: { ...item.queue, position: null, reorderable: false },
    } : item),
  };
}
