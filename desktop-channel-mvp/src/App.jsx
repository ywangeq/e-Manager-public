import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CheckCircle,
  ArrowClockwise,
  ArrowUp,
  Paperclip,
  ClipboardText,
  CirclesFour,
  Clock,
  DownloadSimple,
  File,
  Key,
  ListChecks,
  LockKey,
  Minus,
  PaperPlaneTilt,
  ShieldCheck,
  SignIn,
  SignOut,
  SpinnerGap,
  Stack,
  UserCircleCheck,
  WifiHigh,
  X,
} from "@phosphor-icons/react";
import dogIdle from "./assets/local-device.svg";
import dogAttention from "./assets/local-device.svg";
import dogReceive from "./assets/local-device.svg";
import dogWorking from "./assets/local-device.svg";
import { EmployeeAccessRequestPanel } from "./components/EmployeeAccessRequestPanel.jsx";
import { EmployeeSwitcherSheet } from "./components/EmployeeSwitcherSheet.jsx";
import { MyTasksSheet } from "./components/MyTasksSheet.jsx";
import { ConversationMessage } from "./components/conversation/ConversationMessage.jsx";
import { artifactDeliveryPreviewState, deliverArtifactPreview, inspectArtifactPreview } from "./lib/artifactDeliveryPreview.js";
import { TokenCredentialDialog } from "./components/TokenCredentialDialog.jsx";
import { ProjectGroupWorkspace } from "./components/ProjectGroupWorkspace.jsx";
import { EmployeeTaskFeed } from "./components/EmployeeTaskFeed.jsx";
import { EmployeeConversationSheet } from "./components/EmployeeConversationSheet.jsx";
import { PersonalCockpit } from "./components/PersonalCockpit.jsx";
import { employeeFeedCards, employeeFeedConfirmations } from "./lib/employeeTaskFeed.js";
import { claimToolConfirmationSubmission, toolConfirmationPresentation } from "./lib/toolConfirmationPresentation.js";
import { employeeCharacterFor, registeredEmployeeCharacterFor } from "./data/employeeCharacters.js";
import { PREVIEW_EMPLOYEES } from "./data/fallback-employees.js";
import {
  ASSISTANT_EMPLOYEE_ID,
  cleanDisplayText,
  desktopUpdatePresentation,
  desktopUnsignedUpdateAction,
  desktopUpdateStateTitle,
  desktopConversationHistoryReady,
  desktopRuntimeTaskFailure,
  dataflowCredentialPresentation,
  describeEmployeeCatalogChanges,
  employeeRuntimeState,
  manualCredentialToolFor,
  mergeConversationHistory,
  mergeRecoveredToolParameterCards,
  nextCollapsedPetEmployeeId,
  parseSseBody,
  requireDesktopConversationHistoryApi,
  shouldRecoverConversationTask,
  updateEmployeeConversation,
} from "./lib/desktopChannelModel.js";
import {
  normalizeLocalAttachments,
} from "../shared/desktop-attachments.mjs";
import { containsCredentialText } from "../shared/sensitive-text-guard.mjs";
import {
  canApplyAssistantStreamMessageUpdate,
  claimAssistantStream,
  hasAssistantStreamsForEmployee,
  isCurrentAssistantStream,
  normalizeAssistantActivity,
  releaseAssistantStream,
  upsertAssistantActivity,
} from "../shared/desktop-assistant-activity.mjs";
import { appendDesktopTaskEvent, normalizeDesktopTaskEvent } from "../shared/desktop-task-timeline.mjs";
import { normalizeDesktopTaskActivitySnapshot } from "../shared/desktop-task-activity.mjs";
import { normalizeDesktopTaskProvenance } from "../shared/desktop-task-provenance.mjs";
import { normalizeCurrentUserAuthorizationAction } from "../shared/current-user-authorization-action.mjs";
import { finalizeAssistantActivities, initialConversation, makeMessage } from "./lib/conversationPresentation.js";
import { usePersonalAutomations } from "./hooks/usePersonalAutomations.js";
import { useMyTasks } from "./hooks/useMyTasks.js";
import {
  attachmentIntakeFeedback,
  attachmentKindLabel,
  browserFileRecords,
  cleanCredentialFreeText,
  formatCredentialExpiry,
  formatFileSize,
  httpLinksFromDrop,
  isMaterialDrag,
  materialProgressPercent,
} from "./lib/desktopPresentation.js";

const DOG_IMAGES = {
  idle: dogIdle,
  attention: dogAttention,
  received: dogReceive,
  working: dogWorking,
  success: dogReceive,
  blocked: dogAttention,
};
export function App() {
  const desktopApi = requireDesktopConversationHistoryApi(window.desktopChannel);
  const previewMode = new URLSearchParams(window.location.search).get("preview");
  const artifactPreviewState = artifactDeliveryPreviewState(window.location.search);
  const [environment, setEnvironment] = useState({ isDesktop: Boolean(desktopApi), expanded: !desktopApi });
  const [expanded, setExpanded] = useState(!desktopApi);
  const [employees, setEmployees] = useState(PREVIEW_EMPLOYEES);
  const [requestableEmployees, setRequestableEmployees] = useState([]);
  const [accessRequests, setAccessRequests] = useState([]);
  const [showAccessRequest, setShowAccessRequest] = useState(false);
  const [showEmployeeSwitcher, setShowEmployeeSwitcher] = useState(false);
  const [requestTargetEmployeeId, setRequestTargetEmployeeId] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(ASSISTANT_EMPLOYEE_ID);
  const [employeeConversationOpen, setEmployeeConversationOpen] = useState(false);
  const [workspaceEmployeeId, setWorkspaceEmployeeId] = useState("");
  const workspaceDraftRef = useRef("");
  const [petEmployeeId, setPetEmployeeId] = useState("");
  const [systemStatus, setSystemStatus] = useState({ connected: false, authenticated: false });
  const [previewAuthenticated, setPreviewAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentFeedback, setAttachmentFeedback] = useState(null);
  const [materialPreparation, setMaterialPreparation] = useState(null);
  const [reusableMaterials, setReusableMaterials] = useState([]);
  const [reusableMaterialsState, setReusableMaterialsState] = useState({ phase: "idle", message: "" });
  const [selectedReusableMaterial, setSelectedReusableMaterial] = useState(null);
  const [showReusableMaterials, setShowReusableMaterials] = useState(false);
  const [inputText, setInputText] = useState("");
  const [sendingEmployeeIds, setSendingEmployeeIds] = useState(() => new Set());
  const [activeTasksByEmployee, setActiveTasksByEmployee] = useState({});
  const [deviceOperationActive, setDeviceOperationActive] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [toolCredentialStatus, setToolCredentialStatus] = useState({ status: "missing", available: false, message: "" });
  const [dataflowCredentialStatus, setDataflowCredentialStatus] = useState({
    status: "not_configured",
    configured: false,
    transportReady: false,
  });
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [catalogSync, setCatalogSync] = useState({ phase: "idle", updatedAt: 0, message: "" });
  const [historyBootstrapRevision, setHistoryBootstrapRevision] = useState(0);
  const [channelStatus, setChannelStatus] = useState({ phase: "idle", label: "本地通道在线" });
  const [updateState, setUpdateState] = useState({ update: { status: "disabled" }, signal: { status: "disabled" } });
  const [conversations, setConversations] = useState(() => ({
    [ASSISTANT_EMPLOYEE_ID]: initialConversation(PREVIEW_EMPLOYEES.find((item) => item.id === ASSISTANT_EMPLOYEE_ID), previewMode),
  }));
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const messageListRef = useRef(null);
  const sessionGenerationRef = useRef(0);
  const statusTimerRef = useRef(null);
  const catalogEmployeesRef = useRef([]);
  const catalogRefreshPromiseRef = useRef(null);
  const petDragRef = useRef(null);
  const suppressPetClickRef = useRef(false);
  const materialJobRef = useRef("");
  const loadedHistoryRevisionRef = useRef(new Map());
  const recoveredHistoryTaskIdsRef = useRef(new Set());
  const actorContextVersionRef = useRef(0);
  const activeStreamIdsRef = useRef(new Map());
  const confirmationSubmissionClaimsRef = useRef(new Set());

  const authenticated = systemStatus.authenticated || previewAuthenticated;
  const myTasks = useMyTasks(desktopApi, {
    actorContextVersion: Number(systemStatus.actorContextVersion || 0),
    authenticated,
    bootstrapRevision: historyBootstrapRevision,
  });
  const actor = systemStatus.actor || (previewAuthenticated
    ? { name: "交互预览用户", department: "数字化管理办公室", role: "普通员工", permissions: [] }
    : null);
  const selectedEmployee = useMemo(
    () => employees.find((item) => item.id === selectedEmployeeId) || employees[0] || { id: "", name: "尚未导入数字员工", tools: [], access: { callable: false, selectable: false } },
    [employees, selectedEmployeeId],
  );
  const selectedEmployeeRef = useRef(selectedEmployee.id);
  selectedEmployeeRef.current = selectedEmployee.id;
  const access = selectedEmployee?.access || { callable: false, selectable: false };
  const runtime = useMemo(() => employeeRuntimeState(selectedEmployee), [selectedEmployee]);
  const selectedCharacter = employeeCharacterFor(selectedEmployee);
  const canTalk = access.callable === true;
  const credentialTool = useMemo(
    () => manualCredentialToolFor(selectedEmployee?.tools),
    [selectedEmployee?.tools],
  );
  const dataflowCredentialTool = useMemo(
    () => (selectedEmployee?.tools || []).find((tool) => (
      tool.id === "dataflow-rest-api" && tool.credentialMode === "device_session_refresh"
    )) || null,
    [selectedEmployee?.tools],
  );
  const dataflowCredentialView = useMemo(
    () => dataflowCredentialPresentation(dataflowCredentialTool, dataflowCredentialStatus),
    [dataflowCredentialStatus, dataflowCredentialTool],
  );
  const messages = conversations[selectedEmployee?.id] || [];
  const myTaskById = useMemo(
    () => new Map((myTasks.page?.tasks || []).map((task) => [String(task.id), task])),
    [myTasks.page],
  );
  const sending = sendingEmployeeIds.has(selectedEmployee?.id);
  const anySending = sendingEmployeeIds.size > 0;
  const [automationSelection,setAutomationSelection] = useState(null);
  const personalAutomations = usePersonalAutomations(desktopApi, {
    authenticated, actorContextVersion:Number(systemStatus.actorContextVersion || 0),
    revision:myTasks.page,
  });
  function openAutomation(automation = null) {
    setAutomationSelection({automationId:automation?.automationId || "",employeeId:automation?.employeeId || selectedEmployee.id});
    myTasks.show();
  }

  const updatePresentation = desktopUpdatePresentation(updateState?.update);
  const unsignedUpdateAction = desktopUnsignedUpdateAction(updateState?.update);
  const dogState = updatePresentation.active ? "working" : anySending ? "working" : channelStatus.phase;
  const prefersReducedMotion = usePrefersReducedMotion();
  const petEmployee = useMemo(
    () => employees.find((item) => item.id === petEmployeeId) || null,
    [employees, petEmployeeId],
  );
  const petCharacter = petEmployee ? registeredEmployeeCharacterFor(petEmployee) : null;
  const localChannelOwnsPet = !authenticated
    || deviceOperationActive
    || updatePresentation.active
    || dogState === "received";
  const showEmployeePet = Boolean(petCharacter && !localChannelOwnsPet);

  useEffect(() => {
    let disposed = false;
    async function initialize() {
      if (!desktopApi) return;
      const nextEnvironment = await desktopApi.getEnvironment().catch(() => ({ isDesktop: true, expanded: false }));
      if (disposed) return;
      setEnvironment(nextEnvironment);
      setExpanded(nextEnvironment.expanded === true);
      setUpdateState(await desktopApi.getUpdateState?.().catch(() => ({ update: { status: "degraded" }, signal: { status: "degraded" } })) || {});
      await desktopApi.revalidateSession?.().catch(() => null);
      const status = await refreshSystemStatus();
      if (status.authenticated) await refreshCatalog();
    }
    initialize();
    const removeWindowListener = desktopApi?.onWindowState?.((state) => setExpanded(state.expanded));
    const removeStatusListener = desktopApi?.onSystemStatusChanged?.(async () => {
      const status = await refreshSystemStatus();
      if (status.authenticated) await refreshCatalog();
    });
    const removeLoginErrorListener = desktopApi?.onLoginError?.((state) => {
      setAuthError(state.message || "企业认证页加载失败");
      updateChannelStatus("blocked", "认证连接受阻", 12000);
    });
    const removeMaterialProgressListener = desktopApi?.onMaterialProgress?.((progress) => {
      if (!progress?.jobId || progress.jobId !== materialJobRef.current) return;
      setMaterialPreparation((current) => current?.jobId === progress.jobId ? { ...current, ...progress } : current);
    });
    const removeAssistantActivityListener = desktopApi?.onAssistantActivity?.((payload) => {
      const activity = normalizeAssistantActivity(payload?.activity);
      const employeeId = String(payload?.employeeId || "");
      const streamId = String(payload?.streamId || "");
      if (!activity || !employeeId || !streamId) return;
      setConversations((current) => {
        const employeeMessages = current[employeeId];
        if (!Array.isArray(employeeMessages)) return current;
        let changed = false;
        const nextMessages = employeeMessages.map((message) => {
          if (!canApplyAssistantStreamMessageUpdate(message, streamId)) return message;
          changed = true;
          const acknowledged = upsertAssistantActivity(message.activities, {
            id: "dispatch",
            kind: "runtime",
            label: "已交给数字员工",
            status: "done",
          });
          return { ...message, activities: upsertAssistantActivity(acknowledged, activity) };
        });
        return changed ? { ...current, [employeeId]: nextMessages } : current;
      });
    });
    const removeAssistantTaskListener = desktopApi?.onAssistantTask?.((payload) => {
      const employeeId = String(payload?.employeeId || "");
      const streamId = String(payload?.streamId || "");
      const taskId = String(payload?.taskId || "");
      if (!employeeId || !streamId || !taskId) return;
      setActiveTasksByEmployee((current) => current[employeeId]?.streamId === streamId
        ? { ...current, [employeeId]: {
            ...current[employeeId],
            taskId,
            ...(payload.status ? { status: payload.status } : {}),
            ...(payload.connectionState ? { connectionState: payload.connectionState } : {}),
          } }
        : current);
      setConversations((current) => {
        const employeeMessages = current[employeeId];
        if (!Array.isArray(employeeMessages)) return current;
        return {
          ...current,
          [employeeId]: employeeMessages.map((message) => message.id === streamId && (!message.taskId || message.taskId === taskId)
            ? { ...message, taskId, ...(payload.connectionState ? { taskConnectionState: payload.connectionState } : {}) }
            : message),
        };
      });
    });
    const removeAssistantTaskEventListener = desktopApi?.onAssistantTaskEvent?.((payload) => {
      const employeeId = String(payload?.employeeId || "");
      const streamId = String(payload?.streamId || "");
      const taskId = String(payload?.taskId || "");
      const taskEvent = normalizeDesktopTaskEvent(payload?.event, { expectedTaskId: taskId });
      if (!employeeId || !streamId || !taskId || !taskEvent) return;
      myTasks.observeTaskEvent(taskEvent);
      if (taskEvent.eventType === "task.state_changed") {
        setActiveTasksByEmployee((current) => current[employeeId]?.streamId === streamId
          ? { ...current, [employeeId]: { ...current[employeeId], status: taskEvent.data.status } }
          : current);
      }
      setConversations((current) => {
        const employeeMessages = current[employeeId];
        if (!Array.isArray(employeeMessages)) return current;
        return {
          ...current,
          [employeeId]: employeeMessages.map((message) => message.id === streamId && (!message.taskId || message.taskId === taskId)
            ? {
                ...message,
                taskId,
                taskEvents: appendDesktopTaskEvent(message.taskEvents, taskEvent),
                ...(taskEvent.eventType === "task.state_changed" ? { canonicalTaskStatus: taskEvent.data.status } : {}),
              }
            : message),
        };
      });
    });
    const removeAssistantTaskActivityListener = desktopApi?.onAssistantTaskActivity?.((payload) => {
      const employeeId = String(payload?.employeeId || "");
      const streamId = String(payload?.streamId || "");
      const taskId = String(payload?.taskId || "");
      const taskActivitySnapshot = normalizeDesktopTaskActivitySnapshot(payload?.snapshot, { expectedTaskId: taskId });
      if (!employeeId || !streamId || !taskId || !taskActivitySnapshot) return;
      setConversations((current) => {
        const employeeMessages = current[employeeId];
        if (!Array.isArray(employeeMessages)) return current;
        return {
          ...current,
          [employeeId]: employeeMessages.map((message) => message.id === streamId && (!message.taskId || message.taskId === taskId)
            ? { ...message, taskId, taskActivitySnapshot }
            : message),
        };
      });
    });
    const removeAssistantTaskProvenanceListener = desktopApi?.onAssistantTaskProvenance?.((payload) => {
      const employeeId = String(payload?.employeeId || "");
      const streamId = String(payload?.streamId || "");
      const taskId = String(payload?.taskId || "");
      const taskProvenanceSnapshot = normalizeDesktopTaskProvenance(payload?.snapshot, { expectedTaskId: taskId });
      if (!employeeId || !streamId || !taskId || !taskProvenanceSnapshot) return;
      setConversations((current) => {
        const employeeMessages = current[employeeId];
        if (!Array.isArray(employeeMessages)) return current;
        return {
          ...current,
          [employeeId]: employeeMessages.map((message) => message.id === streamId && (!message.taskId || message.taskId === taskId)
            ? { ...message, taskId, taskProvenanceSnapshot }
            : message),
        };
      });
    });
    const removeUpdateStateListener = desktopApi?.onUpdateState?.((payload) => setUpdateState(payload || {}));
    const handleNetworkRestore = async () => {
      await desktopApi?.notifyNetworkRestored?.().catch(() => null);
      const status = await refreshSystemStatus();
      if (status.authenticated) await refreshCatalog();
    };
    window.addEventListener("online", handleNetworkRestore);
    return () => {
      disposed = true;
      removeWindowListener?.();
      removeStatusListener?.();
      removeLoginErrorListener?.();
      removeMaterialProgressListener?.();
      removeAssistantActivityListener?.();
      removeAssistantTaskListener?.();
      removeAssistantTaskEventListener?.();
      removeAssistantTaskActivityListener?.();
      removeAssistantTaskProvenanceListener?.();
      removeUpdateStateListener?.();
      window.removeEventListener("online", handleNetworkRestore);
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const node = messageListRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending, expanded]);

  useEffect(() => {
    if (!selectedEmployeeId || selectedEmployee?.id !== selectedEmployeeId) return;
    setConversations((current) => current[selectedEmployeeId]
      ? current
      : updateEmployeeConversation(current, selectedEmployeeId, (items) => items, initialConversation(selectedEmployee, previewMode)));
  }, [selectedEmployeeId, selectedEmployee?.id, selectedEmployee?.name]);

  useEffect(() => {
    const version = Number(systemStatus.actorContextVersion || 0);
    if (!version || actorContextVersionRef.current === version) return;
    const changedActor = actorContextVersionRef.current > 0;
    actorContextVersionRef.current = version;
    if (!changedActor) return;
    setInputText("");
    loadedHistoryRevisionRef.current.clear();
    recoveredHistoryTaskIdsRef.current.clear();
    setEmployeeConversationOpen(false);
    setWorkspaceEmployeeId("");
    workspaceDraftRef.current = "";
    setConversations({});
  }, [systemStatus.actorContextVersion]);

  useEffect(() => {
    let disposed = false;
    const employeeId = selectedEmployee?.id || "";
    if (!desktopApi || !desktopConversationHistoryReady({
      authenticated,
      bootstrapRevision: historyBootstrapRevision,
      employeeId,
      sending,
    })) return undefined;
    desktopApi.getConversationHistory(employeeId).then((result) => {
      if (disposed) return;
      if (result?.ok !== true || !Array.isArray(result.projection?.turns)) {
        if (["center_tombstone", "center_access_denied", "no_active_session"].includes(result?.status)) {
          loadedHistoryRevisionRef.current.delete(employeeId);
          setConversations((current) => ({ ...current, [employeeId]: [] }));
        }
        return;
      }
      const projection = result.projection;
      const revisionKey = `${projection.sessionId || ""}:${projection.revision || ""}`;
      if (loadedHistoryRevisionRef.current.get(employeeId) === revisionKey) return;
      const historyMessages = projection.turns.flatMap((turn) => {
        if (!["user", "assistant"].includes(turn?.role) || !String(turn?.text || "").trim()) return [];
        return [makeMessage(turn.role, String(turn.text), {
          id: `history-${projection.sessionId}-${turn.seq}`,
          createdAt: turn.createdAt,
          status: "done",
          ...(turn.taskId ? { taskId: turn.taskId } : {}),
        })];
      });
      loadedHistoryRevisionRef.current.set(employeeId, revisionKey);
      setConversations((current) => ({
        ...current,
        [employeeId]: mergeConversationHistory(historyMessages, current[employeeId]),
      }));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [authenticated, desktopApi, historyBootstrapRevision, selectedEmployee?.id, sending]);

  useEffect(() => {
    const employeeId = selectedEmployee?.id || "";
    if (!desktopApi?.followAssistantTask || !authenticated || !employeeId) return;
    for (const message of messages) {
      const taskId = String(message?.taskId || "");
      const task = myTaskById.get(taskId);
      if (!shouldRecoverConversationTask(message, task) || task?.employeeId !== employeeId) continue;
      const recoveryKey = `${employeeId}:${taskId}`;
      if (recoveredHistoryTaskIdsRef.current.has(recoveryKey)) continue;
      recoveredHistoryTaskIdsRef.current.add(recoveryKey);
      desktopApi.followAssistantTask({ employeeId, taskId, streamId: message.id }).then((result) => {
        if (result?.ok !== true) recoveredHistoryTaskIdsRef.current.delete(recoveryKey);
      }).catch(() => recoveredHistoryTaskIdsRef.current.delete(recoveryKey));
    }
  }, [authenticated, desktopApi, messages, myTaskById, selectedEmployee?.id]);

  useEffect(() => {
    const latest = [...messages].reverse().find(message => message.role === "assistant" && message.taskId && !message.localNotice && !message.cardRecovery);
    const task = latest ? myTaskById.get(latest.taskId) : null;
    if (!task || task.employeeId !== selectedEmployee.id) return;
    const state = myTasks.details[task.id];
    if (!state && !latest.taskEvents?.length && ["completed", "failed", "blocked", "canceled", "timed_out", "rejected", "lost"].includes(task.status)) {
      void myTasks.loadDetail(task);
      return;
    }
    if (state?.phase !== "ready" || state.stale || !state.detail || latest.taskEvents === state.detail.events) return;
    const detail = state.detail;
    updateConversation(selectedEmployee, current => current.map(message => message.role === "assistant" && message.taskId === task.id
      ? { ...message, canonicalTaskStatus: detail.status, taskEvents: detail.events,
        taskActivitySnapshot: detail.activitySnapshot, taskProvenanceSnapshot: detail.provenanceSnapshot } : message));
  }, [messages, myTaskById, myTasks.details, myTasks.loadDetail, selectedEmployee.id]);

  useEffect(() => {
    let disposed = false;
    const employeeId = selectedEmployee?.id || "";
    if (!desktopApi?.getToolParameterCards || !authenticated || !employeeId || sending) return undefined;
    desktopApi.getToolParameterCards(employeeId).then((result) => {
      if (disposed || result?.ok !== true || !Array.isArray(result.cards)) return;
      updateConversation(selectedEmployee, (current) => mergeRecoveredToolParameterCards(current, result.cards));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [authenticated, desktopApi, selectedEmployee?.id, sending]);

  useEffect(() => {
    const nextPetEmployeeId = nextCollapsedPetEmployeeId({
      authenticated,
      currentPetEmployeeId: petEmployeeId,
      employees,
      hasRegisteredCharacter: (employee) => Boolean(registeredEmployeeCharacterFor(employee)),
      selectedEmployeeId: selectedEmployee?.id,
    });
    if (nextPetEmployeeId !== petEmployeeId) setPetEmployeeId(nextPetEmployeeId);
  }, [authenticated, employees, petEmployeeId, selectedEmployee?.id]);

  useEffect(() => {
    let disposed = false;
    if (!desktopApi || !authenticated || !credentialTool?.id) {
      setToolCredentialStatus({ status: "missing", available: false, message: "" });
      setShowTokenDialog(false);
      return undefined;
    }
    desktopApi.getToolCredentialStatus(credentialTool.id).then((result) => {
      if (!disposed) setToolCredentialStatus({ ...result, message: "" });
    }).catch(() => {
      if (!disposed) setToolCredentialStatus({ status: "missing", available: false, message: "临时授权状态不可用" });
    });
    return () => { disposed = true; };
  }, [authenticated, credentialTool?.id]);

  useEffect(() => {
    let disposed = false;
    if (!desktopApi || !authenticated || !dataflowCredentialTool) {
      setDataflowCredentialStatus({ status: "not_configured", configured: false, transportReady: false });
      return undefined;
    }
    desktopApi.getDataflowCredentialStatus().then((result) => {
      if (!disposed) setDataflowCredentialStatus(result || {});
    }).catch(() => {
      if (!disposed) setDataflowCredentialStatus({ status: "degraded", configured: true, transportReady: false });
    });
    const removeListener = desktopApi.onDataflowCredentialStatusChanged?.((result) => {
      if (!disposed) setDataflowCredentialStatus(result || {});
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [authenticated, dataflowCredentialTool, desktopApi]);

  async function refreshCatalog({ announce = false } = {}) {
    if (!desktopApi) return { ok: false };
    if (catalogRefreshPromiseRef.current) return catalogRefreshPromiseRef.current;
    setCatalogSync((current) => ({ ...current, phase: current.phase === "success" ? "success" : "loading", message: "正在同步…" }));
    catalogRefreshPromiseRef.current = desktopApi.bootstrap().catch(() => ({ ok: false }));
    try {
      const result = await catalogRefreshPromiseRef.current;
      if (!result?.ok) {
        setCatalogSync((current) => ({ ...current, phase: "error", message: result?.error || "更新失败" }));
        return result;
      }
      const desktopEmployees = result.employees || [];
      const selectableEmployees = desktopEmployees.filter((item) => item.access?.selectable && item.access?.callable);
      const message = announce
        ? describeEmployeeCatalogChanges(catalogEmployeesRef.current, desktopEmployees)
        : "";
      catalogEmployeesRef.current = desktopEmployees;
      setEmployees(desktopEmployees);
      setRequestableEmployees(desktopEmployees.filter((item) => item.access?.requestable));
      setAccessRequests(result.accessRequests || []);
      setHistoryBootstrapRevision((current) => current + 1);
      setCatalogSync({ phase: "success", updatedAt: Date.now(), message });
      setSelectedEmployeeId((current) => selectableEmployees.some((item) => item.id === current)
        ? current
        : selectableEmployees.find((item) => item.id === ASSISTANT_EMPLOYEE_ID)?.id || selectableEmployees[0]?.id || "");
      return result;
    } finally {
      catalogRefreshPromiseRef.current = null;
    }
  }

  async function checkForUpdates() {
    const result = await desktopApi?.checkForUpdates?.().catch(() => ({ status: "degraded" }));
    if (result?.status === "up_to_date") updateChannelStatus("success", "桌面版已是最新", 3200);
    else if (["available", "mandatory_pending", "deferred"].includes(result?.status)) updateChannelStatus("attention", "发现桌面版更新", 6000);
    else if (result?.status === "disabled") updateChannelStatus("idle", "更新策略尚未启用", 3200);
    else if (result?.status) updateChannelStatus("blocked", "更新检查暂不可用", 4200);
  }

  async function handleUpdateAction() {
    const result = updateState?.update?.status === "downloaded"
      ? await desktopApi?.openDownloadedUpdate?.().catch(() => ({ status: "installer_open_failed" }))
      : await desktopApi?.downloadUpdate?.().catch(() => ({ status: "installer_download_failed" }));
    if (["installer_download_failed", "installer_open_failed", "download_unavailable", "installer_unavailable"].includes(result?.status)) {
      updateChannelStatus("blocked", "安装包暂不可用，请稍后重试", 5000);
    }
  }

  async function refreshSystemStatus() {
    if (!desktopApi) return { connected: false, authenticated: false };
    const next = await desktopApi.getSystemStatus().catch(() => ({ connected: false, authenticated: false }));
    setSystemStatus(next);
    if (next.authenticated) {
      setAuthError("");
      updateChannelStatus("idle", "企业认证已连接");
    } else if (desktopApi) {
      sessionGenerationRef.current += 1;
      setEmployees([]);
      setRequestableEmployees([]);
      setAccessRequests([]);
      catalogEmployeesRef.current = [];
      setCatalogSync({ phase: "idle", updatedAt: 0, message: "" });
      setHistoryBootstrapRevision(0);
      setSelectedEmployeeId("");
      setPetEmployeeId("");
      setAttachments([]);
      setReusableMaterials([]);
      setReusableMaterialsState({ phase: "idle", message: "" });
      setSelectedReusableMaterial(null);
      setShowReusableMaterials(false);
      setMaterialPreparation(null);
      setDeviceOperationActive(false);
      setInputText("");
      setSendingEmployeeIds(new Set());
      setActiveTasksByEmployee({});
      activeStreamIdsRef.current.clear();
      confirmationSubmissionClaimsRef.current.clear();
      setToolCredentialStatus({ status: "missing", available: false, message: "" });
      setEmployeeConversationOpen(false);
      setWorkspaceEmployeeId("");
      workspaceDraftRef.current = "";
      setConversations({});
      loadedHistoryRevisionRef.current.clear();
      setShowAccessRequest(false);
      setShowEmployeeSwitcher(false);
      updateChannelStatus(
        "blocked",
        next.reasonCode && next.reasonCode !== "authentication_required" ? "企业权限需要重新确认" : "等待企业认证",
      );
    }
    return next;
  }

  function updateChannelStatus(phase, label, resetAfter = 0) {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    setChannelStatus({ phase, label });
    if (resetAfter > 0) {
      statusTimerRef.current = window.setTimeout(() => {
        setChannelStatus({ phase: "idle", label: authenticated ? "本地通道在线" : "等待企业认证" });
      }, resetAfter);
    }
  }

  async function handlePetClick() {
    if (suppressPetClickRef.current) return;
    updateChannelStatus("attention", authenticated ? "正在打开" : "等待企业认证", 1600);
    setExpanded(true);
    await desktopApi?.setExpanded?.(true);
  }

  function beginPetDrag(event) {
    if (!desktopApi?.beginWindowDrag || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    petDragRef.current = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false };
    desktopApi.beginWindowDrag({ x: event.screenX, y: event.screenY });
  }

  function movePetDrag(event) {
    const drag = petDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) < 4) return;
    drag.moved = true;
    desktopApi?.moveWindowDrag?.({ x: event.screenX, y: event.screenY });
  }

  function endPetDrag(event) {
    const drag = petDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressPetClickRef.current = drag.moved;
    petDragRef.current = null;
    desktopApi?.endWindowDrag?.();
    if (drag.moved) window.setTimeout(() => { suppressPetClickRef.current = false; }, 0);
  }

  async function collapseWindow() {
    if (!anySending && channelStatus.phase === "attention") {
      updateChannelStatus("idle", authenticated ? "本地通道在线" : "等待企业认证");
    }
    setExpanded(false);
    await desktopApi?.setExpanded?.(false);
  }

  async function openLogin() {
    setAuthError("");
    updateChannelStatus("attention", "等待企业认证");
    if (!desktopApi) {
      setPreviewAuthenticated(true);
      setSystemStatus({
        connected: true,
        authenticated: false,
        actor: { name: "交互预览用户", department: "数字化管理办公室", role: "普通员工", permissions: [] },
      });
      updateChannelStatus("success", "认证预览已完成", 3200);
      return;
    }
    const result = await desktopApi.openLogin().catch(() => ({ opened: false }));
    if (!result?.opened) {
      setAuthError(result?.error || "无法打开企业认证，请检查管理系统连接");
      updateChannelStatus("blocked", "认证连接受阻", 12000);
    }
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAuthError("");
    sessionGenerationRef.current += 1;
    const result = desktopApi
      ? await desktopApi.logout().catch(() => ({ ok: false }))
      : { ok: true, serverRevoked: true };
    setPreviewAuthenticated(false);
    setSystemStatus({ connected: systemStatus.connected, authenticated: false });
    setEmployees([]);
    setRequestableEmployees([]);
    setAccessRequests([]);
    catalogEmployeesRef.current = [];
    setCatalogSync({ phase: "idle", updatedAt: 0, message: "" });
    setHistoryBootstrapRevision(0);
    setSelectedEmployeeId("");
    setPetEmployeeId("");
    setAttachments([]);
    setReusableMaterials([]);
    setReusableMaterialsState({ phase: "idle", message: "" });
    setSelectedReusableMaterial(null);
    setShowReusableMaterials(false);
    setAttachmentFeedback(null);
    setMaterialPreparation(null);
    setDeviceOperationActive(false);
    setInputText("");
    setSendingEmployeeIds(new Set());
    setActiveTasksByEmployee({});
    activeStreamIdsRef.current.clear();
    confirmationSubmissionClaimsRef.current.clear();
    setToolCredentialStatus({ status: "missing", available: false, message: "" });
    setShowAccessRequest(false);
    setShowEmployeeSwitcher(false);
    setEmployeeConversationOpen(false);
    setWorkspaceEmployeeId("");
    workspaceDraftRef.current = "";
    setConversations({});
    loadedHistoryRevisionRef.current.clear();
    updateChannelStatus("blocked", "等待企业认证");
    if (!result?.ok || result.serverRevoked === false) {
      setAuthError("桌面端已退出；企业中心暂时不可达，中心会话将按原有效期失效。");
    }
    setLoggingOut(false);
  }

  async function loadToolCredential() {
    if (!credentialTool?.id || !desktopApi) return;
    const result = await desktopApi.loadToolCredentialFromClipboard(credentialTool.id).catch(() => ({
      ok: false,
      status: "unavailable",
      available: false,
    }));
    applyToolCredentialStatus(result);
    if (!result.available) setShowTokenDialog(true);
    return result;
  }

  async function storeToolCredentialText(credentialText) {
    if (!credentialTool?.id || !desktopApi?.storeToolCredential) return;
    const result = await desktopApi.storeToolCredential(credentialTool.id, credentialText).catch(() => ({
      ok: false,
      status: "unavailable",
      available: false,
    }));
    applyToolCredentialStatus(result);
    return result;
  }

  function applyToolCredentialStatus(result) {
    const messagesByStatus = {
      bearer_not_found: "未识别到 Bearer，请在输入框中粘贴 Token",
      expired: "Bearer 已过期，请重新授权",
      authentication_required: "请先完成企业认证",
      tool_not_available: "当前 Tool 未开放",
      unavailable: "授权保存失败",
    };
    const readyMessage = result.transportReady === false
      ? "已加密保存；中心切换 HTTPS 后可使用"
      : result.transportStatus === "mvp_private_lan_http"
        ? `已加密保存${formatCredentialExpiry(result.expiresAt)} · MVP 内网传输`
        : result.persisted
          ? `已加密保存${formatCredentialExpiry(result.expiresAt)}`
          : "已载入；系统安全存储不可用，仅本次运行有效";
    setToolCredentialStatus({
      ...result,
      message: result.available ? readyMessage : messagesByStatus[result.status] || "授权保存失败",
    });
    if (result.available) updateChannelStatus(result.usable ? "success" : "blocked", result.usable ? "DataFlow 授权已就绪" : "授权已保存 · 中心连接受阻", 12000);
  }

  async function clearToolCredential() {
    if (!credentialTool?.id || !desktopApi) return;
    const result = await desktopApi.clearToolCredential(credentialTool.id).catch(() => ({ status: "cleared", available: false }));
    setToolCredentialStatus({ ...result, available: false, message: "临时授权已清除" });
  }

  async function connectDataflowCredential() {
    if (!desktopApi?.openDataflowLogin) return;
    const result = await desktopApi.openDataflowLogin().catch(() => ({
      status: "blocked",
      configured: false,
      transportReady: false,
    }));
    setDataflowCredentialStatus(result || {});
  }

  async function logoutDataflowCredential() {
    if (!desktopApi?.logoutDataflow) return;
    const result = await desktopApi.logoutDataflow().catch(() => ({
      status: "blocked",
      configured: true,
      transportReady: false,
    }));
    setDataflowCredentialStatus(result || {});
  }

  async function submitAccessRequest(input) {
    if (!desktopApi) return { ok: true, status: "pending_review" };
    const result = await desktopApi.requestEmployeeAccess(input).catch(() => ({ ok: false, status: "failed" }));
    if (result?.ok) await refreshCatalog();
    return result;
  }

  function openAccessRequest(employeeId = "") {
    setRequestTargetEmployeeId(employeeId);
    setShowEmployeeSwitcher(false);
    setShowAccessRequest(true);
  }

  function openEmployeeSwitcher() {
    setShowEmployeeSwitcher(true);
    if (desktopApi && authenticated) void refreshCatalog({ announce: true });
  }

  function selectEmployee(employeeId) {
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee || employeeId === selectedEmployeeId) return;
    setConversations((current) => current[employeeId]
      ? current
      : updateEmployeeConversation(current, employeeId, (items) => items, initialConversation(employee, previewMode)));
    setSelectedEmployeeId(employeeId);
    setPetEmployeeId(employee?.access?.selectable && employee?.access?.callable ? employeeId : "");
    setAttachments([]);
    setSelectedReusableMaterial(null);
    setShowReusableMaterials(false);
    setAttachmentFeedback(null);
    cancelMaterialPreparation();
    setDeviceOperationActive(false);
    setInputText("");
  }

  const orderedRequestableEmployees = useMemo(() => {
    if (!requestTargetEmployeeId) return requestableEmployees;
    return [...requestableEmployees].sort((left, right) => (
      Number(right.id === requestTargetEmployeeId) - Number(left.id === requestTargetEmployeeId)
    ));
  }, [requestTargetEmployeeId, requestableEmployees]);

  async function chooseAttachments() {
    if (!access.callable) return;
    if (desktopApi) {
      const result = await desktopApi.chooseAttachments().catch(() => ({ canceled: true }));
      if (!result?.canceled) registerAuthorizedFiles(result.files || [], result.selectionId, result.rejected || []);
      return;
    }
    fileInputRef.current?.click();
  }

  async function toggleReusableMaterials() {
    if (!canTalk || sending) return;
    if (showReusableMaterials) {
      setShowReusableMaterials(false);
      return;
    }
    setShowReusableMaterials(true);
    setReusableMaterials([]);
    setReusableMaterialsState({ phase: "loading", message: "正在从中心核验个人材料" });
    if (!desktopApi?.listReusableArtifacts) {
      if (previewMode === "reusable-material") {
        const materials = [reusableMaterialPreview()];
        setReusableMaterials(materials);
        setReusableMaterialsState({ phase: "ready", message: "选择一份材料用于下一任务" });
      } else {
        setReusableMaterialsState({ phase: "error", message: "个人材料仅在已连接 Desktop 中可用" });
      }
      return;
    }
    const sessionGeneration = sessionGenerationRef.current;
    const result = await desktopApi.listReusableArtifacts({ employeeId: selectedEmployee.id })
      .catch(() => ({ ok: false, status: "network_unavailable", materials: [] }));
    if (sessionGeneration !== sessionGenerationRef.current) return;
    if (result?.ok) {
      setReusableMaterials(result.materials || []);
      setReusableMaterialsState({
        phase: "ready",
        message: result.materials?.length ? "选择一份材料用于下一任务" : "暂无可复用的个人材料",
      });
    } else {
      setReusableMaterials([]);
      setReusableMaterialsState({ phase: "error", message: reusableMaterialFailureLabel(result?.status) });
    }
  }

  function selectReusableMaterial(material) {
    if (!material?.grantId || sending) return;
    setSelectedReusableMaterial(material);
    setShowReusableMaterials(false);
    setAttachmentFeedback(null);
  }

  function removeReusableMaterial() {
    if (sending) return;
    setSelectedReusableMaterial(null);
    setAttachmentFeedback(null);
  }

  async function handleDrop(event) {
    if (!isMaterialDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (!access.callable) return;
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    if (!droppedFiles.length) {
      const droppedLinks = httpLinksFromDrop(event.dataTransfer);
      if (droppedLinks.length) {
        setInputText((current) => [current.trim(), ...droppedLinks].filter(Boolean).join("\n"));
        setAttachmentFeedback({ tone: "success", text: `已放入 ${droppedLinks.length} 个链接，发送后交给当前数字员工。` });
      } else {
        setAttachmentFeedback({ tone: "error", text: "没有检测到可添加的文件或 HTTP/HTTPS 链接。" });
      }
      return;
    }
    const { accepted: acceptedDroppedFiles, rejected: droppedRejected } = normalizeLocalAttachments(droppedFiles, attachments);
    if (desktopApi?.registerDroppedAttachments) {
      const result = await desktopApi.registerDroppedAttachments(acceptedDroppedFiles).catch(() => null);
      if (result) {
        const unresolvedFiles = (result.unresolvedIndexes || []).map((index) => acceptedDroppedFiles[index]).filter(Boolean);
        const { accepted: localFiles, rejected: localRejected } = normalizeLocalAttachments(unresolvedFiles);
        const localRecords = await browserFileRecords(localFiles);
        registerAuthorizedFiles(
          [...(result.files || []), ...localRecords],
          result.selectionId,
          [...droppedRejected, ...(result.rejected || []), ...localRejected],
        );
      } else setAttachmentFeedback({ tone: "error", text: "读取拖入文件失败，请重试或点击选择文件。" });
      return;
    }
    registerAuthorizedFiles(await browserFileRecords(acceptedDroppedFiles), `browser-${Date.now()}`, droppedRejected);
  }

  async function handleBrowserFileChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = "";
    const { accepted, rejected } = normalizeLocalAttachments(selectedFiles, attachments);
    registerAuthorizedFiles(await browserFileRecords(accepted), `browser-${Date.now()}`, rejected);
  }

  function registerAuthorizedFiles(files, selectionId, intakeRejected = []) {
    const { accepted, rejected } = normalizeLocalAttachments(files, attachments);
    const nextFeedback = attachmentIntakeFeedback(accepted.length, [...intakeRejected, ...rejected]);
    setAttachmentFeedback(nextFeedback);
    if (!accepted.length) return;
    setShowReusableMaterials(false);
    setAttachments((current) => [
      ...current,
      ...accepted.map((file) => ({ ...file, selectionId, authorization: "current_selection_only" })),
    ]);
    updateChannelStatus("received", `已接收 ${accepted.length} 个文件`, 4200);
  }

  function removeAttachment(id) {
    if (materialPreparation?.phase === "hashing" || materialPreparation?.phase === "inventory") return;
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentFeedback(null);
  }

  function handleDragEnter(event) {
    event.preventDefault();
    if (!access.callable || !isMaterialDrag(event.dataTransfer)) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event) {
    if (!isMaterialDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function sendMessage(options = {}) {
    const toolConfirmation = options?.toolConfirmation?.contractVersion === "tool-call-confirmation.v1"
      ? options.toolConfirmation
      : null;
    const toolParameterCard = options?.toolParameterCard?.submission?.contractVersion === "tool-parameter-card-submission.v2"
      ? options.toolParameterCard
      : null;
    const retryText = typeof options?.retryText === "string" ? options.retryText.trim() : "";
    const text = toolConfirmation
      ? `确认执行：${toolConfirmation.displayName || toolConfirmation.action || "受控 Tool 写操作"}`
      : toolParameterCard
        ? `已提交参数：${toolParameterCard.card.title || toolParameterCard.card.operationId || "受控 Tool 操作"}`
        : retryText || inputText.trim();
    const reusableMaterial = toolConfirmation || toolParameterCard || retryText ? null : selectedReusableMaterial;
    if (!canTalk || (!text && !attachments.length && !reusableMaterial)) return;
    if (sending && attachments.length && !toolConfirmation && !toolParameterCard) {
      setAttachmentFeedback({ tone: "warning", text: "当前任务使用本地材料时，请等待材料清点完成；纯文本任务仍可继续排队。" });
      return;
    }
    if (!toolConfirmation && containsCredentialText(text)) {
      await storeToolCredentialText(text);
      setInputText(cleanCredentialFreeText(text));
      return;
    }
    const sessionGeneration = sessionGenerationRef.current;
    const targetEmployee = selectedEmployee;
    const targetEmployeeId = targetEmployee.id;
    const targetMessages = messages;
    const localFiles = toolConfirmation || toolParameterCard || retryText ? [] : attachments;
    if (toolConfirmation && !claimToolConfirmationSubmission(confirmationSubmissionClaimsRef.current, targetEmployeeId, toolConfirmation)) return;
    const assistantStreamId = `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!claimAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId)) return;
    if (localFiles.length > 0) setDeviceOperationActive(true);
    setEmployeeSending(targetEmployeeId, true);
    let materialGrantId = "";
    let materialManifest = null;

    if (localFiles.length && desktopApi?.prepareMaterial) {
      const jobId = `material-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      materialJobRef.current = jobId;
      setMaterialPreparation({ jobId, phase: "inventory", processedBytes: 0, totalBytes: localFiles.reduce((sum, file) => sum + file.size, 0) });
      setAttachmentFeedback(null);
      updateChannelStatus("working", "正在清点本地材料");
      const prepared = await desktopApi.prepareMaterial({
        jobId,
        employeeId: targetEmployeeId,
        files: localFiles.map((file) => ({ selectionId: file.selectionId, fileId: file.id })),
      }).catch((error) => ({ ok: false, status: "failed", error: error?.message || "材料清点失败" }));
      if (sessionGeneration !== sessionGenerationRef.current) return;
      materialJobRef.current = "";
      if (!prepared?.ok) {
        setMaterialPreparation(null);
        setAttachmentFeedback({
          tone: prepared?.status === "canceled" ? "warning" : "error",
          text: prepared?.status === "canceled" ? "已取消材料清点，文件仍保留在待发送区。" : `材料清点失败：${cleanDisplayText(prepared?.error || "请重新选择文件")}`,
        });
        releaseAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId);
        setEmployeeSending(targetEmployeeId, hasAssistantStreamsForEmployee(activeStreamIdsRef.current, targetEmployeeId));
        setDeviceOperationActive(false);
        updateChannelStatus(prepared?.status === "canceled" ? "idle" : "blocked", prepared?.status === "canceled" ? "材料清点已取消" : "材料清点受阻", 12000);
        return;
      }
      materialGrantId = prepared.grant?.grantId || "";
      materialManifest = prepared.manifest || null;
      setMaterialPreparation({ jobId, phase: "ready", processedBytes: materialManifest?.totalBytes || 0, totalBytes: materialManifest?.totalBytes || 0 });
      setAttachmentFeedback({
        tone: "success",
        text: prepared.bridge?.itemCount
          ? `已授权「${targetEmployee.name}」本轮使用材料；将按需提交 ${prepared.bridge.itemNames.join("、")} 到 1 小时临时 workspace。`
          : `已授权「${targetEmployee.name}」本轮使用 ${materialManifest?.fileCount || localFiles.length} 个本地文件。`,
      });
    }

    const materialSelectionText = reusableMaterial && localFiles.length
      ? `已选择个人材料「${reusableMaterial.fileName}」，并授权 ${localFiles.length} 个本地文件。`
      : reusableMaterial
        ? `已选择个人材料「${reusableMaterial.fileName}」。`
        : `已授权 ${localFiles.length} 个本地文件。`;
    const effectiveText = text || (reusableMaterial && localFiles.length
      ? `请读取我明确选择的个人材料「${reusableMaterial.fileName}」以及本轮授权的 ${localFiles.length} 个本地文件，并根据材料内容继续处理。`
      : reusableMaterial
        ? `请读取我明确选择的个人材料「${reusableMaterial.fileName}」，并根据材料内容继续处理。`
        : `已授权并完成 ${localFiles.length} 个本地文件的材料清点，请根据安全材料清单说明下一步。`);
    const pendingAssistant = makeMessage("assistant", "", {
      id: assistantStreamId,
      status: "streaming",
      activities: [{ id: "dispatch", kind: "runtime", label: "正在交给数字员工", startedAt: Date.now(), status: "running" }],
    });
    if (toolConfirmation) {
      updateConversation(targetEmployee, (current) => current.map((message) => ({
        ...message,
        toolConfirmations: (message.toolConfirmations || []).map((item) => item.id === toolConfirmation.id ? { ...item, status: "submitting" } : item),
      })));
    }
    if (toolParameterCard) {
      updateConversation(targetEmployee, (current) => current.map((message) => ({
        ...message,
        toolParameterCards: (message.toolParameterCards || []).map((item) => item.id === toolParameterCard.card.id ? { ...item, status: "submitting" } : item),
      })));
    }
    updateConversation(targetEmployee, (current) => [
      ...current,
      makeMessage("user", text || materialSelectionText, {
        attachments: localFiles,
        materialPrepared: Boolean(materialManifest),
        reusableMaterial: reusableMaterial ? {
          fileName: reusableMaterial.fileName,
          mimeType: reusableMaterial.mimeType,
          sizeBytes: reusableMaterial.sizeBytes,
        } : null,
      }),
      pendingAssistant,
    ]);
    if (!toolConfirmation && !retryText) setInputText("");
    setActiveTasksByEmployee((current) => ({
      ...current,
      [targetEmployeeId]: { streamId: assistantStreamId, taskId: "", status: "submitting", canceling: false },
    }));
    updateChannelStatus("working", "正在交给数字员工");

    if (!desktopApi) {
      window.setTimeout(() => {
        if (sessionGeneration !== sessionGenerationRef.current) return;
        if (!releaseAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId)) return;
        if (toolConfirmation) updateConversation(targetEmployee, current => current.map(message => ({ ...message,
          toolConfirmations: message.toolConfirmations?.map(card => card.id === toolConfirmation.id ? { ...card, status: "submission_unknown" } : card),
        })));
        updateConversation(targetEmployee, (current) => current.map((message) => message.id === assistantStreamId ? {
          ...message,
          content: "这是桌面 Channel 的交互预览。收起窗口后，工业狗狗仍会显示任务状态。",
          localNotice: true,
          status: "done",
          activities: [{ id: "preview", kind: "runtime", label: "交互预览未连接真实 Runtime", status: "done" }],
        } : message));
        setEmployeeSending(targetEmployeeId, false);
        setActiveTasksByEmployee((current) => {
          if (current[targetEmployeeId]?.streamId !== assistantStreamId) return current;
          const next = { ...current };
          delete next[targetEmployeeId];
          return next;
        });
        if (localFiles.length > 0) setDeviceOperationActive(false);
        updateChannelStatus("success", "结果已送达", 12000);
      }, 2400);
      return;
    }

    try {
      const history = targetMessages.filter((item) => !item.localNotice).slice(-8).map((item) => ({ role: item.role, content: item.content }));
      const result = await desktopApi.sendAssistant({
        employeeId: targetEmployeeId,
        streamId: assistantStreamId,
        requestId: assistantStreamId,
        message: effectiveText,
        messages: history,
        materialGrantId,
        reusableMaterialGrantId: reusableMaterial?.grantId || "",
        toolConfirmation: toolConfirmation ? {
          contractVersion: "tool-call-confirmation.v1",
          id: toolConfirmation.id,
          decision: "approved",
        } : null,
        toolParameterCard: toolParameterCard?.submission || null,
      });
      if (sessionGeneration !== sessionGenerationRef.current) return;
      if (!isCurrentAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId)) return;
      const parsed = parseSseBody(result?.body || "");
      const authorizationActions = (result?.credentialEvents || [])
        .map((item) => normalizeCurrentUserAuthorizationAction(item.authorizationAction))
        .filter(Boolean)
        .slice(0, 2);
      const credentialEvent = (result?.credentialEvents || []).find((item) => item.toolId === credentialTool?.id);
      if (credentialEvent && selectedEmployeeRef.current === targetEmployeeId) {
        const invalid = credentialEvent.clear === true;
        setToolCredentialStatus({
          status: credentialEvent.status,
          available: !invalid && toolCredentialStatus.available,
          usable: !invalid && toolCredentialStatus.usable,
          message: invalid ? "授权已失效或无权访问，请重新授权" : "需要重新授权",
        });
      }
      if ([401, 403].includes(result?.status)) await refreshSystemStatus();
      if (!result?.ok || parsed.error || (!parsed.text && !parsed.toolParameterCards.length)) {
        const runtimeError = new Error(parsed.error || `服务返回 ${result?.status || "异常"}`);
        runtimeError.code = parsed.errorCode || "runtime_task_failed";
        runtimeError.taskId = parsed.taskId || result?.taskId || "";
        runtimeError.taskStatus = parsed.taskStatus || "failed";
        throw runtimeError;
      }
      updateConversation(targetEmployee, (current) => current.map((message) => message.id === assistantStreamId ? {
        ...message,
        activities: finalizeAssistantActivities(message.activities, "done"),
        taskId: parsed.taskId || message.taskId,
        canonicalTaskStatus: parsed.taskStatus || message.canonicalTaskStatus,
        content: parsed.text,
        status: "done",
        authorizationActions,
        toolConfirmations: parsed.toolConfirmations,
        toolParameterCards: parsed.toolParameterCards,
      } : message));
      if (toolParameterCard) updateConversation(targetEmployee, current => current.map(message => ({ ...message,
        toolParameterCards: message.toolParameterCards?.map(card => card.id === toolParameterCard.card.id ? { ...card, status: "submitted" } : card),
      })));
      if (toolConfirmation) updateConversation(targetEmployee, current => current.map(message => ({ ...message,
        toolConfirmations: message.toolConfirmations?.map(card => card.id === toolConfirmation.id ? { ...card, status: "submitted" } : card),
      })));
      void myTasks.refresh();
      if (materialManifest) setAttachments([]);
      if (reusableMaterial) setSelectedReusableMaterial(null);
      updateChannelStatus("success", "结果已送达", 12000);
    } catch (error) {
      if (sessionGeneration !== sessionGenerationRef.current) return;
      if (!isCurrentAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId)) return;
      if (toolConfirmation) updateConversation(targetEmployee, current => current.map(message => ({ ...message,
        toolConfirmations: message.toolConfirmations?.map(card => card.id === toolConfirmation.id ? { ...card, status: "submission_unknown" } : card),
      })));
      updateConversation(targetEmployee, (current) => current.map((message) => {
        if (message.id !== assistantStreamId) return message;
        const failure = desktopRuntimeTaskFailure({
          code: error?.code,
          status: error?.taskStatus,
          taskId: error?.taskId || message.taskId,
        });
        const mayRetryPlainText = failure.retryable && !toolConfirmation && !toolParameterCard && localFiles.length === 0 && !reusableMaterial;
        return {
          ...message,
          activities: finalizeAssistantActivities(message.activities, "blocked"),
          content: "",
          error: true,
          failure,
          retryRequest: mayRetryPlainText ? { text: effectiveText } : null,
          status: "error",
        };
      }));
      if (toolParameterCard) {
        updateConversation(targetEmployee, current => current.map(message => ({ ...message,
          toolParameterCards: message.toolParameterCards?.map(card => card.id === toolParameterCard.card.id ? { ...card, status: "submission_unknown" } : card),
        })));
        const recovered = await desktopApi?.getToolParameterCards?.(targetEmployeeId).catch(() => null);
        if (sessionGeneration === sessionGenerationRef.current && recovered?.ok === true && Array.isArray(recovered.cards)) {
          updateConversation(targetEmployee, current => mergeRecoveredToolParameterCards(current, recovered.cards));
        }
      }
      updateChannelStatus("blocked", "任务受阻 · 点开查看", 12000);
    } finally {
      const ownsCurrentStream = sessionGeneration === sessionGenerationRef.current
        && releaseAssistantStream(activeStreamIdsRef.current, targetEmployeeId, assistantStreamId);
      if (ownsCurrentStream) setEmployeeSending(
        targetEmployeeId,
        hasAssistantStreamsForEmployee(activeStreamIdsRef.current, targetEmployeeId),
      );
      if (ownsCurrentStream) {
        setActiveTasksByEmployee((current) => {
          if (current[targetEmployeeId]?.streamId !== assistantStreamId) return current;
          const next = { ...current };
          delete next[targetEmployeeId];
          return next;
        });
      }
      if (ownsCurrentStream && localFiles.length > 0) setDeviceOperationActive(false);
      if (ownsCurrentStream && localFiles.length > 0) setMaterialPreparation(null);
    }
  }

  function cancelMaterialPreparation() {
    const jobId = materialJobRef.current;
    if (!jobId) {
      setMaterialPreparation(null);
      return;
    }
    void desktopApi?.cancelMaterialPreparation?.(jobId);
  }

  function updateConversation(employee, updater) {
    const employeeId = employee?.id;
    setConversations((current) => updateEmployeeConversation(current, employeeId, updater, initialConversation(employee, previewMode)));
  }

  function setEmployeeSending(employeeId, isSending) {
    setSendingEmployeeIds((current) => {
      const next = new Set(current);
      if (isSending) next.add(employeeId);
      else next.delete(employeeId);
      return next;
    });
  }

  async function openLink(url) {
    if (desktopApi) await desktopApi.openExternal(url).catch(() => {});
    else window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copyTaskId(taskId) {
    try {
      if (desktopApi?.copyTaskId) return (await desktopApi.copyTaskId(taskId))?.ok === true;
      await navigator.clipboard.writeText(taskId);
      return true;
    } catch {
      return false;
    }
  }

  async function cancelAssistantTask(reference) {
    const taskId = String(reference?.taskId || "");
    const employeeId = String(reference?.employeeId || selectedEmployee?.id || "");
    if (!taskId || !employeeId) return;
    await myTasks.cancel({ employeeId, id: taskId });
  }

  async function inspectArtifact(reference) {
    if (!desktopApi?.getArtifactDelivery || !selectedEmployee?.id) {
      return inspectArtifactPreview({ artifactId: reference?.artifactId, previewMode, state: artifactPreviewState });
    }
    return desktopApi.getArtifactDelivery({
      employeeId: reference?.employeeId || selectedEmployee.id,
      taskId: reference?.taskId,
      artifactId: reference?.artifactId,
    }).catch(() => ({ ok: false, status: "network_unavailable" }));
  }

  async function deliverArtifact(reference) {
    if (!desktopApi?.deliverArtifact || !selectedEmployee?.id) {
      return deliverArtifactPreview({ action: reference?.action, previewMode, state: artifactPreviewState });
    }
    return desktopApi.deliverArtifact({
      employeeId: reference?.employeeId || selectedEmployee.id,
      taskId: reference?.taskId,
      artifactId: reference?.artifactId,
      action: reference?.action,
    }).catch(() => ({ ok: false, status: "network_unavailable" }));
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat) return;
    void sendMessage();
  }

  function handleComposerPaste(event) {
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    if (!credentialTool?.id || !containsCredentialText(pastedText)) return;
    event.preventDefault();
    void storeToolCredentialText(pastedText);
  }

  function handleComposerChange(event) {
    const next = event.target.value;
    if (!credentialTool?.id || !containsCredentialText(next)) {
      setInputText(next);
      return;
    }
    setInputText(cleanCredentialFreeText(next));
    void storeToolCredentialText(next);
  }

  if (previewMode === "project-group" && authenticated) {
    return <ProjectGroupWorkspace key={`group-actor-${Number(systemStatus.actorContextVersion || 0)}`} desktopApi={desktopApi} employees={employees} bootstrapReady={catalogSync.phase === "success"} authenticated={authenticated} />;
  }

  function updateParameterDraft(card, values) {
    updateConversation(selectedEmployee, current => current.map(message => ({ ...message,
      toolParameterCards: message.toolParameterCards?.map(item => item.id === card.id ? { ...item, draftArguments: values } : item),
    })));
  }

  function renderConversationMessage(message) {
    const messageTaskId = String(message.taskId || message.taskEvents?.[0]?.taskId || "");
    const feedbackTask = myTaskById.get(messageTaskId);
    return <ConversationMessage
      automations={personalAutomations}
      onOpenAutomation={openAutomation}
      cancelingTaskIds={myTasks.cancelingTaskIds}
      feedbackState={feedbackTask ? myTasks.feedbackStates[feedbackTask.id] : null}
      feedbackTask={feedbackTask}
      key={message.id}
      message={message}
      onCancelTask={(reference) => cancelAssistantTask({ ...reference, employeeId: selectedEmployee.id })}
      onConfirmToolCall={(confirmation) => sendMessage({ toolConfirmation: confirmation })}
      onCopyTaskId={copyTaskId}
      onDeliverArtifact={deliverArtifact}
      onFeedback={myTasks.submitFeedback}
      onInspectArtifact={inspectArtifact}
      onLoadTaskProcess={feedbackTask ? async () => {
        const detail = await myTasks.loadDetail(feedbackTask);
        if (!detail) return false;
        updateConversation(selectedEmployee, (current) => current.map((item) => item.id === message.id
          ? {
              ...item,
              canonicalTaskStatus: detail.status || feedbackTask.status,
              taskEvents: detail.events,
              taskActivitySnapshot: detail.activitySnapshot,
              taskProvenanceSnapshot: detail.provenanceSnapshot,
            }
          : item));
        return true;
      } : null}
      onOpenLink={openLink}
      onRetryTask={sending ? null : (retryRequest) => sendMessage({ retryText: retryRequest?.text || "" })}
      onSubmitToolParameters={(value) => sendMessage({ toolParameterCard: value })}
      onParameterDraftChange={updateParameterDraft}
      parameterBusy={sending}
    />;
  }

  const employeeConversationContent = ({ assignmentControl = null, embedded = false, feed = false, composerOnly = false, onOpenChat } = {}) => (
            <>
              {!feed ? <section className="employee-bar">
                <span className="employee-signal" aria-hidden="true" />
                <div className={`employee-avatar ${selectedCharacter ? "" : "is-unregistered"}`} style={{ "--employee-accent": selectedCharacter?.accent }}>
                  {selectedCharacter ? (
                    <img
                      src={canTalk && !prefersReducedMotion && selectedCharacter.animatedSrc ? selectedCharacter.animatedSrc : selectedCharacter.staticSrc}
                      alt={selectedCharacter.codename}
                    />
                  ) : <span className="employee-character-missing">未登记</span>}
                </div>
                <button type="button" className="employee-trigger" disabled={embedded} onClick={openEmployeeSwitcher} aria-haspopup="dialog" aria-expanded={showEmployeeSwitcher}>
                  <span>当前数字员工</span>
                  <strong>{selectedEmployee.name || selectedEmployee.title || selectedEmployee.id}</strong>
                  <small>{selectedEmployee.title || "受治理数字员工"}</small>
                  <CaretDown size={15} weight="bold" />
                </button>
                <div className="employee-actions">
                  <span className={`status-pill ${runtime.tone}`}>{runtime.label}</span>
                </div>
              </section> : null}

              {dataflowCredentialView.visible && (!feed || !dataflowCredentialView.ready) ? (
                <div className={`tool-credential-bar ${dataflowCredentialView.ready ? "is-ready" : "is-missing"}`}>
                  <span className="tool-credential-icon" aria-hidden="true"><Key size={14} weight="bold" /></span>
                  <div className="tool-credential-copy">
                    <strong>{dataflowCredentialTool.name || "DataFlow 授权"}</strong>
                    <span>{dataflowCredentialView.message}{dataflowCredentialView.ready ? formatCredentialExpiry(dataflowCredentialStatus.expiresAt) : ""}</span>
                  </div>
                  <button
                    type="button"
                    className="tool-credential-action"
                    title={dataflowCredentialView.ready ? "退出并清除 DataFlow 企业登录会话" : "打开 DataFlow 企业登录"}
                    aria-label={dataflowCredentialView.actionLabel}
                    onClick={dataflowCredentialView.ready ? logoutDataflowCredential : connectDataflowCredential}
                  >
                    {dataflowCredentialView.ready ? <SignOut size={15} /> : <SignIn size={15} />}
                    <span>{dataflowCredentialView.actionLabel}</span>
                  </button>
                </div>
              ) : null}

              {credentialTool ? (
                <div className={`tool-credential-bar ${toolCredentialStatus.usable ? "is-ready" : toolCredentialStatus.available ? "is-saved" : "is-missing"}`}>
                  <span className="tool-credential-icon" aria-hidden="true"><Key size={14} weight="bold" /></span>
                  <div className="tool-credential-copy">
                    <strong>{credentialTool.name || "DataFlow 授权"}</strong>
                    <span>{toolCredentialStatus.message || (toolCredentialStatus.available ? "已加密保存" : "等待当前用户临时 Token")}</span>
                  </div>
                  <button
                    type="button"
                    className="tool-credential-action"
                    title="从剪贴板粘贴并加密保存当前用户的 Authorization: Bearer Token"
                    aria-label="粘贴当前用户临时 Token"
                    onClick={loadToolCredential}
                  >
                    <ClipboardText size={15} />
                    <span>粘贴 Token</span>
                  </button>
                  {toolCredentialStatus.available ? (
                    <button type="button" className="tool-credential-action" title="清除临时授权" aria-label="清除临时授权" onClick={clearToolCredential}>
                      <X size={14} />
                    </button>
                  ) : null}
                </div>
              ) : null}

              {showTokenDialog && credentialTool ? (
                <TokenCredentialDialog
                  toolName={credentialTool.name}
                  onClose={() => setShowTokenDialog(false)}
                  onSubmit={storeToolCredentialText}
                />
              ) : null}

              {showAccessRequest ? (
                <EmployeeAccessRequestPanel
                  employees={orderedRequestableEmployees}
                  requests={accessRequests}
                  onClose={() => setShowAccessRequest(false)}
                  onSubmit={submitAccessRequest}
                />
              ) : (
                <section
                  className={`chat-workspace ${dragActive ? "is-dragging" : ""}`}
                >
                  {canTalk ? (
                    <>
                      {!composerOnly ? <div className="message-list" ref={messageListRef}>
                        {messages.map(renderConversationMessage)}
                      </div> : null}

                      {showReusableMaterials ? (
                        <section className="reusable-material-picker" aria-label="最近个人材料">
                          <div className="reusable-material-picker-head">
                            <span><Stack size={13} />最近材料</span>
                            <button type="button" title="关闭个人材料" aria-label="关闭个人材料" onClick={() => setShowReusableMaterials(false)}><X size={12} /></button>
                          </div>
                          <small className={`is-${reusableMaterialsState.phase}`}>{reusableMaterialsState.message}</small>
                          {reusableMaterialsState.phase === "loading" ? <SpinnerGap className="spin reusable-material-loading" size={15} /> : null}
                          {reusableMaterials.length ? (
                            <div className="reusable-material-list">
                              {reusableMaterials.map((material) => (
                                <button type="button" key={material.grantId} onClick={() => selectReusableMaterial(material)}>
                                  <File size={15} />
                                  <span><strong title={material.fileName}>{material.fileName}</strong><small>{formatFileSize(material.sizeBytes)} · {material.mimeType}</small></span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </section>
                      ) : null}

                      {selectedReusableMaterial ? (
                        <div className="reusable-material-selection" role="status">
                          <Stack size={16} />
                          <span><strong title={selectedReusableMaterial.fileName}>{selectedReusableMaterial.fileName}</strong><small>{formatFileSize(selectedReusableMaterial.sizeBytes)} · 个人材料</small></span>
                          <button type="button" title="取消选择个人材料" aria-label="取消选择个人材料" disabled={sending} onClick={removeReusableMaterial}><X size={11} /></button>
                        </div>
                      ) : null}

                      {attachments.length ? (
                        <div className="attachment-strip">
                          <div className="attachment-strip-main">
                            <div className="attachment-thumbnails">
                              {attachments.map((item) => (
                                <div className="attachment-item" key={item.id}>
                                  <div className="attachment-preview">
                                    {item.previewDataUrl ? <img src={item.previewDataUrl} alt={item.name} /> : <File size={18} aria-label={item.name} />}
                                  </div>
                                  <div className="attachment-copy">
                                    <strong title={item.name}>{item.name}</strong>
                                    <span>{attachmentKindLabel(item)} · {formatFileSize(item.size)}</span>
                                  </div>
                                  <button type="button" title="移除材料" disabled={Boolean(materialPreparation)} onClick={() => removeAttachment(item.id)}><X size={11} /></button>
                                </div>
                              ))}
                            </div>
                            <span><ShieldCheck size={13} />本机授权</span>
                          </div>
                          {materialPreparation ? (
                            <div className="material-preparation" role="status" aria-live="polite">
                              <div className="material-progress-copy">
                                <span>{materialPreparation.phase === "ready" ? "本地清点完成" : "正在生成安全材料清单"}</span>
                                <strong>{materialProgressPercent(materialPreparation)}%</strong>
                              </div>
                              <div className="material-progress-track"><span style={{ width: `${materialProgressPercent(materialPreparation)}%` }} /></div>
                              {materialPreparation.phase !== "ready" ? <button type="button" title="取消材料清点" aria-label="取消材料清点" onClick={cancelMaterialPreparation}><X size={12} /></button> : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className={`composer ${embedded ? "workbench-composer has-assignment" : ""} ${dragActive ? "is-dragging" : ""}`}
                        onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                        {dragActive ? <span className="composer-drop-hint" role="status">松开即可添加文件或链接</span> : null}
                        {assignmentControl}
                        <button type="button" className="composer-action" title="选择本地文件（也可直接拖入）" onClick={chooseAttachments}>{embedded ? <Paperclip size={16} /> : <File size={20} />}</button>
                        <textarea
                          value={inputText}
                          onChange={handleComposerChange}
                          onKeyDown={handleComposerKeyDown}
                          onPaste={handleComposerPaste}
                          placeholder="发消息、粘贴链接，或拖入文件…"
                          rows={1}
                        />
                        <button type="button" className="send-button" title={sending ? "发送并加入任务队列" : "发送消息"} aria-label={sending ? "发送并加入任务队列" : "发送消息"} disabled={!inputText.trim() && !attachments.length && !selectedReusableMaterial} onClick={() => sendMessage()}>{embedded ? <ArrowUp size={19} weight="bold" /> : <PaperPlaneTilt size={18} weight="fill" />}</button>
                      </div>
                      {attachmentFeedback ? <div className={`attachment-feedback is-${attachmentFeedback.tone}`} role="status" aria-live="polite">{attachmentFeedback.text}</div> : null}
                      <div className="composer-footnote">
                        <span><ShieldCheck size={12} />{selectedReusableMaterial && attachments.length
                          ? "发送时由中心分别核验个人材料与本地材料"
                          : selectedReusableMaterial
                            ? "发送时由中心重新核验个人材料"
                            : "本地材料仅授权当前数字员工本轮使用"}</span>
                        <button type="button" disabled={sending} onClick={toggleReusableMaterials}><Stack size={11} />最近材料</button>
                      </div>
                    </>
                  ) : <div className="runtime-boundary"><ShieldCheck size={20} /><div><strong>未上线或无权限</strong><span>中心上线且个人权限通过后，才可进入对话。</span></div></div>}
                </section>
              )}

              {showEmployeeSwitcher ? (
                <EmployeeSwitcherSheet
                  employees={employees}
                  requests={accessRequests}
                  selectedEmployeeId={selectedEmployee.id}
                  onClose={() => setShowEmployeeSwitcher(false)}
                  onRefresh={() => refreshCatalog({ announce: true })}
                  onRequest={openAccessRequest}
                  onSelect={selectEmployee}
                  syncState={catalogSync}
                />
              ) : null}
              {myTasks.open ? (
                <MyTasksSheet
                  automationSelection={automationSelection}
                  busy={myTasks.busy}
                  cancelingTaskIds={myTasks.cancelingTaskIds}
                  details={myTasks.details}
                  error={myTasks.error}
                  expandedTaskId={myTasks.expandedTaskId}
                  feedbackStates={myTasks.feedbackStates}
                  page={myTasks.page}
                  onCancel={myTasks.cancel}
                  onClose={myTasks.close}
                  onDeliverArtifact={myTasks.deliverArtifact}
                  onInspectArtifact={myTasks.inspectArtifact}
                  onFeedback={myTasks.submitFeedback}
                  onRefresh={myTasks.refresh}
                  onReorder={myTasks.reorder}
                  onToggleTask={myTasks.toggleTask}
                />
              ) : null}
            </>
  );

  if (previewMode === "cockpit") {
    return <><PersonalCockpit employeeConversationState={{ employeeId: selectedEmployee.id, taskId: [...messages].reverse().find(message => message.role === "assistant" && !message.localNotice && !message.cardRecovery)?.taskId || "", pendingCardIds: [...employeeFeedCards(messages).filter(card => card.status === "draft" && Date.parse(card.expiresAt) > Date.now()), ...employeeFeedConfirmations(messages).filter(card => toolConfirmationPresentation(card).pending)].map(card => card.id), draftText: inputText, busy: sending, locked: deviceOperationActive || Boolean(materialPreparation) || attachments.length > 0 || Boolean(selectedReusableMaterial) }}
      renderEmployeeConversation={({ employeeId, taskId, assignmentControl, view, onOpenChat }) => employeeId === selectedEmployee.id && !employeeConversationOpen
        ? ["feed", "progress"].includes(view) ? <EmployeeTaskFeed progressOnly={view === "progress"} employee={selectedEmployee} messages={messages} busy={sending}
          taskId={taskId} task={myTaskById.get(taskId)?.employeeId === employeeId ? myTaskById.get(taskId) : null}
          liveTaskId={[...messages].reverse().find(message => message.role === "assistant" && !message.localNotice && !message.cardRecovery)?.taskId || ""}
          taskDetailState={myTaskById.get(taskId)?.employeeId === employeeId ? myTasks.details[taskId] : null} onLoadDetail={myTasks.loadDetail}
          onSubmit={value => sendMessage({ toolParameterCard: value })} onDraftChange={updateParameterDraft}
          onConfirm={confirmation => sendMessage({ toolConfirmation: confirmation })} onOpenChat={onOpenChat}
          credentialLabel={dataflowCredentialView.visible && dataflowCredentialView.ready ? "DataFlow 已连接" : ""}
          renderMessage={renderConversationMessage} />
        : <>{employeeConversationContent({ assignmentControl, embedded: true, feed: view === "composer", composerOnly: view === "composer", onOpenChat })}<input ref={fileInputRef} className="visually-hidden" type="file" multiple onChange={handleBrowserFileChange} /></> : null}
      onSelectEmployeeConversation={({ employeeId, text }) => {
        if (!employeeId) { setWorkspaceEmployeeId(""); return true; }
        const employee = employees.find(item => item.id === employeeId);
        if (!authenticated || employee?.access?.callable !== true || employee?.access?.selectable !== true) return false;
        selectEmployee(employeeId);
        if (typeof text === "string" && text.trim()) setInputText(text);
        setWorkspaceEmployeeId(employeeId);
        setEmployeeConversationOpen(false);
        return true;
      }} onOpenEmployeeConversation={({ employeeId, text }) => {
      const employee = employees.find(item => item.id === employeeId);
      if (!authenticated || (employee?.access?.callable !== true || employee?.access?.selectable !== true)) return false;
      if (workspaceEmployeeId && employeeId !== workspaceEmployeeId && (attachments.length || selectedReusableMaterial || materialPreparation || deviceOperationActive)) return false;
      if (workspaceEmployeeId === selectedEmployee.id) workspaceDraftRef.current = inputText;
      selectEmployee(employeeId);
      if (typeof text === "string" && text.trim()) setInputText(text);
      setEmployeeConversationOpen(true);
      return true;
    }} key={`cockpit-actor-${Number(systemStatus.actorContextVersion || 0)}-${authenticated}`} expanded={expanded} authenticated={authenticated} actor={actor} authError={authError} onLogin={openLogin} onLogout={handleLogout} desktopApi={desktopApi} employees={employees} bootstrapReady={catalogSync.phase === "success"} catalogPhase={catalogSync.phase} onRefreshCatalog={refreshCatalog} myTasks={myTasks} />
      {expanded && authenticated && employeeConversationOpen ? <EmployeeConversationSheet employee={selectedEmployee} onClose={() => { setEmployeeConversationOpen(false); if (workspaceEmployeeId && selectedEmployee.id !== workspaceEmployeeId) { selectEmployee(workspaceEmployeeId); setInputText(workspaceDraftRef.current); } }}>{employeeConversationContent()}<input ref={fileInputRef} className="visually-hidden" type="file" multiple onChange={handleBrowserFileChange} /></EmployeeConversationSheet> : null}
    </>;
  }

  return (
    <main className={`desktop-canvas ${expanded ? "is-expanded" : "is-collapsed"}`}>
      {expanded ? (
        <section className="assistant-panel" aria-label="思谋数字员工桌面助手">
          <header className="panel-header">
            <div className="window-drag-region">
              <span className={`connection-dot ${authenticated ? "is-online" : "is-local"}`} />
              <strong>数字员工</strong>
              <small>{authenticated ? `${actor?.name || "已认证"} · ${actor?.department || "企业身份"}` : "首次使用需本地登录"}</small>
            </div>
            <div className="window-actions">
              {environment.appVersion ? (
                <span className="desktop-version" title={`当前桌面版 ${environment.appVersion}`}>
                  v{environment.appVersion}
                </span>
              ) : null}
              {environment.isDesktop ? (
                <button type="button" className="icon-button" title={desktopUpdateStateTitle(updateState)} aria-label="检查桌面版更新" onClick={checkForUpdates}>
                  <ArrowClockwise size={16} className={updateState?.update?.status === "checking" ? "spin" : ""} />
                </button>
              ) : null}
              {environment.isDesktop && unsignedUpdateAction ? (
                <button type="button" className="icon-button" title={unsignedUpdateAction === "open" ? "打开已校验的安装包" : "下载桌面版更新"} aria-label={unsignedUpdateAction === "open" ? "打开安装包" : "下载更新"} disabled={updateState.update.status === "downloading"} onClick={handleUpdateAction}>
                  {unsignedUpdateAction === "open" ? <File size={16} /> : <DownloadSimple size={16} />}
                </button>
              ) : null}
              {authenticated ? <button type="button" className="icon-button" title="退出登录" aria-label="退出登录" disabled={loggingOut} onClick={handleLogout}><SignOut size={17} /></button> : null}
              {authenticated ? (<>
                <button type="button" className="icon-button" title="个人驾驶舱" aria-label="打开个人驾驶舱" onClick={() => void desktopApi?.openCockpit?.()} disabled={!desktopApi}><CirclesFour size={18} /></button>
                {personalAutomations.some(a => a.employeeId === selectedEmployee.id) ? <button type="button" className="icon-button" title="个人定时任务" aria-label="查看当前员工的个人定时任务" onClick={() => openAutomation()}><Clock size={18} /></button> : null}
                <button type="button" className="icon-button task-queue-button" title="我的任务" aria-label={`我的任务，${myTasks.counts.running} 个执行中，${myTasks.counts.queued} 个排队`} onClick={() => { setShowEmployeeSwitcher(false); setAutomationSelection(null); myTasks.show(); }}>
                  <ListChecks size={17} />
                  {myTasks.counts.running + myTasks.counts.queued > 0 ? <span>{myTasks.counts.running + myTasks.counts.queued}</span> : null}
                </button>
              </>) : null}
              <button type="button" className="icon-button" title="收起为桌面宠物" onClick={collapseWindow}><Minus size={18} /></button>
              <button type="button" className="icon-button" title="隐藏窗口" onClick={() => desktopApi?.hide?.()}><X size={17} /></button>
            </div>
          </header>

          {!authenticated ? (
            <EnterpriseAuthGate isDesktop={environment.isDesktop} error={authError} onLogin={openLogin} />
          ) : (
            employeeConversationContent()
          )}
        </section>
      ) : (
        <div
          className={`pet-dock is-${dogState} ${showEmployeePet ? "is-employee-pet" : "is-device-pet"}`}
        >
          <button
            type="button"
            className="pet-open-button"
            onClick={handlePetClick}
            onPointerDown={beginPetDrag}
            onPointerMove={movePetDrag}
            onPointerUp={endPetDrag}
            onPointerCancel={endPetDrag}
            onDragStart={(event) => event.preventDefault()}
            title="按住拖动，轻点打开"
            aria-label={showEmployeePet ? `打开${petEmployee.name || petCharacter.codename}` : "打开数字员工桌面助手"}
          >
            <img
              src={showEmployeePet
                ? (prefersReducedMotion || !petCharacter.animatedSrc ? petCharacter.staticSrc : petCharacter.animatedSrc)
                : DOG_IMAGES[dogState] || dogIdle}
              alt={showEmployeePet ? petCharacter.codename : "本地通道伴生犬"}
              draggable={false}
            />
            <span
              className={`pet-status-pill is-${dogState} ${updatePresentation.active ? `is-update is-${updatePresentation.phase}` : ""}`}
              role={updatePresentation.active ? "progressbar" : undefined}
              aria-valuemin={updatePresentation.active ? 0 : undefined}
              aria-valuemax={updatePresentation.active ? 100 : undefined}
              aria-valuenow={updatePresentation.active ? updatePresentation.percent : undefined}
            >
              {updatePresentation.active ? (
                <>
                  <span className="pet-update-copy">
                    <span className="pet-update-label">
                      <span className="pet-update-icon" aria-hidden="true">
                        {updatePresentation.phase === "installing"
                          ? <ArrowClockwise size={12} weight="bold" />
                          : <DownloadSimple size={12} weight="bold" />}
                      </span>
                      <span>{updatePresentation.label}</span>
                    </span>
                    <strong>{updatePresentation.percent}%</strong>
                  </span>
                  <span className="pet-update-track" aria-hidden="true">
                    <span style={{ width: `${updatePresentation.percent}%` }} />
                  </span>
                </>
              ) : (
                <>
                  {anySending ? <SpinnerGap size={13} className="spin" /> : <span className="pet-status-light" />}
                  {anySending
                    ? "正在执行"
                    : showEmployeePet && dogState === "idle"
                      ? `${petCharacter.codename} · 在线`
                      : channelStatus.label}
                </>
              )}
            </span>
          </button>
        </div>
      )}

      <input ref={fileInputRef} className="visually-hidden" type="file" multiple onChange={handleBrowserFileChange} />
    </main>
  );
}

function reusableMaterialFailureLabel(status) {
  return {
    authentication_required: "登录已失效，请重新登录",
    authentication_changed: "登录身份已变化，请重新打开",
    permission_denied: "当前身份无权查看个人材料",
    network_unavailable: "中心暂不可达，请稍后重试",
    response_invalid: "中心返回的材料信息无效",
  }[status] || "个人材料暂不可用，请稍后重试";
}

function reusableMaterialPreview() {
  return Object.freeze({
    contractVersion: "reusable-artifact-material.v1",
    grantId: `material_${"a".repeat(64)}`,
    scopeType: "personal",
    fileName: "训练分析报告.md",
    mimeType: "text/markdown",
    sizeBytes: 28_416,
    createdAt: "2026-08-15T04:00:00.000Z",
    expiresAt: "2026-09-14T04:00:00.000Z",
    availabilityStatus: "available",
  });
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return undefined;
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  return reducedMotion;
}

function EnterpriseAuthGate({ isDesktop, error, onLogin }) {
  const assistantCharacter = { staticSrc: dogIdle, codename: "本地工作台" };
  return (
    <section className="auth-gate">
      <div className="auth-avatar"><img src={assistantCharacter.staticSrc} alt={assistantCharacter.codename} /><span><LockKey size={15} weight="fill" /></span></div>
      <div className="auth-heading"><span>本地登录</span><strong>登录本地 Center</strong><p>使用本地账号登录；导入并审核资产后，才会出现可使用的数字员工。</p></div>
      <div className="auth-flow" aria-label="认证流程">
        <span><UserCircleCheck size={17} />身份</span><i />
        <span><ShieldCheck size={17} />权限</span><i />
        <span><CheckCircle size={17} />进入</span>
      </div>
      <button type="button" className="login-button" onClick={onLogin}><SignIn size={19} />{isDesktop ? "本地账号登录" : "进入认证交互预览"}</button>
      {error ? <div className="auth-error">{error}</div> : null}
      <small><ShieldCheck size={13} />仅读取安全身份、部门和权限摘要；凭证留在服务端。</small>
    </section>
  );
}
