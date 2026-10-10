const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function invokeGroup(channel, input) {
  let result;
  try { result = await ipcRenderer.invoke(channel, input); }
  catch { result = { groupIpcError: "desktop_group_request_failed" }; }
  return result;
}

contextBridge.exposeInMainWorld("desktopChannel", Object.freeze({
  getEnvironment: () => ipcRenderer.invoke("desktop:get-environment"),
  getUpdateState: () => ipcRenderer.invoke("desktop:get-update-state"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
  openDownloadedUpdate: () => ipcRenderer.invoke("desktop:open-downloaded-update"),
  notifyNetworkRestored: () => ipcRenderer.invoke("desktop:notify-network-restored"),
  setExpanded: (expanded) => ipcRenderer.invoke("desktop:set-expanded", expanded === true),
  getMaximized: () => ipcRenderer.invoke("desktop:get-maximized"),
  toggleMaximized: () => ipcRenderer.invoke("desktop:toggle-maximized"),
  onMaximizedState: (listener) => {
    const wrapped = (_event, maximized) => listener(maximized === true);
    ipcRenderer.on("desktop:maximized-state", wrapped);
    return () => ipcRenderer.removeListener("desktop:maximized-state", wrapped);
  },
  beginWindowDrag: (point) => ipcRenderer.send("desktop:begin-window-drag", point),
  moveWindowDrag: (point) => ipcRenderer.send("desktop:move-window-drag", point),
  endWindowDrag: () => ipcRenderer.send("desktop:end-window-drag"),
  hide: () => ipcRenderer.invoke("desktop:hide"),
  openCockpit: () => ipcRenderer.invoke("desktop:open-cockpit"),
  showAssistant: () => ipcRenderer.invoke("desktop:show-assistant"),
  chooseAttachments: () => ipcRenderer.invoke("desktop:choose-attachments"),
  registerDroppedAttachments: async (files) => {
    const entries = Array.from(files || []).map((file, index) => ({ index, path: webUtils.getPathForFile(file) }));
    const result = await ipcRenderer.invoke("desktop:register-dropped-attachments", entries.map((entry) => entry.path).filter(Boolean));
    return { ...result, unresolvedIndexes: entries.filter((entry) => !entry.path).map((entry) => entry.index) };
  },
  prepareMaterial: (input) => ipcRenderer.invoke("desktop:prepare-material", input),
  cancelMaterialPreparation: (jobId) => ipcRenderer.invoke("desktop:cancel-material-preparation", jobId),
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  getConversationHistory: (employeeId) => ipcRenderer.invoke("desktop:get-conversation-history", employeeId),
  personalAutomations: (request) => ipcRenderer.invoke("desktop:personal-automations", request),
  listMyTasks: () => ipcRenderer.invoke("desktop:list-my-tasks"),
  groupStudio: Object.freeze({
    renameGoal: (input) => invokeGroup("desktop:group-title", input),
    acceptance: (input) => invokeGroup("desktop:group-acceptance", input),
    deleteHistory: (input) => invokeGroup("desktop:group-history-delete", input),
    history: () => invokeGroup("desktop:group-history"),
    displayHistory: (input) => invokeGroup("desktop:group-display-history", input),
    revisionDraft: (input) => invokeGroup("desktop:group-revision-draft", input),
    goal: (input) => invokeGroup("desktop:group-goal", input),
    groupVersion: (input) => invokeGroup("desktop:group-version", input),
    message: (input) => invokeGroup("desktop:group-message", input),
    cancelPlanning: (input) => invokeGroup("desktop:group-planning-cancel", input),
    planDraft: (input) => invokeGroup("desktop:group-plan-draft", input),
    material: (input) => invokeGroup("desktop:group-material", input),
    adopt: (input) => invokeGroup("desktop:group-adopt", input),
    run: (input) => invokeGroup("desktop:group-run", input),
    reviewOpinions: (input) => invokeGroup("desktop:group-review-opinions", input),
    projection: (input) => invokeGroup("desktop:group-projection", input),
    start: (input) => invokeGroup("desktop:group-start", input),
    resume: (input) => invokeGroup("desktop:group-resume", input),
    cancel: (input) => invokeGroup("desktop:group-cancel", input),
    advance: (input) => invokeGroup("desktop:group-advance", input),
  }),
  reorderMyTasks: (request) => ipcRenderer.invoke("desktop:reorder-my-tasks", request),
  getMyTaskDetail: (request) => ipcRenderer.invoke("desktop:get-my-task-detail", request),
  submitMyTaskFeedback: (request) => ipcRenderer.invoke("desktop:submit-my-task-feedback", request),
  followAssistantTask: (input) => ipcRenderer.invoke("desktop:follow-assistant-task", input),
  copyTaskId: (taskId) => ipcRenderer.invoke("desktop:copy-task-id", taskId),
  getArtifactDelivery: (input) => ipcRenderer.invoke("desktop:get-artifact-delivery", input),
  deliverArtifact: (input) => ipcRenderer.invoke("desktop:deliver-artifact", input),
  saveReusableArtifact: (input) => ipcRenderer.invoke("desktop:save-reusable-artifact", input),
  listReusableArtifacts: (input) => ipcRenderer.invoke("desktop:list-reusable-artifacts", input),
  getToolParameterCards: (employeeId) => ipcRenderer.invoke("desktop:get-tool-parameter-cards", employeeId),
  getPendingInteractions: () => ipcRenderer.invoke("desktop:get-pending-interactions"),
  getEmployeePendingInteractions: (employeeId) => ipcRenderer.invoke("desktop:get-employee-pending-interactions", employeeId),
  requestEmployeeAccess: (input) => ipcRenderer.invoke("desktop:request-employee-access", input),
  getSystemStatus: () => ipcRenderer.invoke("desktop:get-system-status"),
  revalidateSession: () => ipcRenderer.invoke("desktop:revalidate-session"),
  openLogin: () => ipcRenderer.invoke("desktop:open-login"),
  logout: () => ipcRenderer.invoke("desktop:logout"),
  getToolCredentialStatus: (toolId) => ipcRenderer.invoke("desktop:tool-credential-status", toolId),
  loadToolCredentialFromClipboard: (toolId) => ipcRenderer.invoke("desktop:load-tool-credential-from-clipboard", toolId),
  storeToolCredential: (toolId, credentialText) => ipcRenderer.invoke("desktop:store-tool-credential", { toolId, credentialText }),
  clearToolCredential: (toolId) => ipcRenderer.invoke("desktop:clear-tool-credential", toolId),
  feishuAuthorization: (input) => ipcRenderer.invoke("desktop:feishu-authorization", input),
  subsystemConnections: (input) => ipcRenderer.invoke("desktop:subsystem-connections", input),
  calendarOpenLink: (input) => ipcRenderer.invoke("desktop:calendar-open-link", input),
  calendarSnapshot: () => ipcRenderer.invoke("desktop:calendar-snapshot"),
  localCalendar: (input) => ipcRenderer.invoke("desktop:local-calendar", input),
  onCalendarChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("desktop:calendar-changed", wrapped);
    return () => ipcRenderer.removeListener("desktop:calendar-changed", wrapped);
  },
  onSubsystemConnectionsChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("desktop:subsystem-connections-changed", wrapped);
    return () => ipcRenderer.removeListener("desktop:subsystem-connections-changed", wrapped);
  },
  getDataflowCredentialStatus: () => ipcRenderer.invoke("desktop:get-dataflow-credential-status"),
  openDataflowLogin: () => ipcRenderer.invoke("desktop:open-dataflow-login"),
  logoutDataflow: () => ipcRenderer.invoke("desktop:logout-dataflow"),
  sendAssistant: (input) => ipcRenderer.invoke("desktop:send-assistant", input),
  cancelAssistantTask: (input) => ipcRenderer.invoke("desktop:cancel-assistant-task", input),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  onWindowState: (listener) => {
    const wrapped = (_event, state) => listener({ expanded: state?.expanded === true });
    ipcRenderer.on("desktop:window-state", wrapped);
    return () => ipcRenderer.removeListener("desktop:window-state", wrapped);
  },
  onSystemStatusChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("desktop:system-status-changed", wrapped);
    return () => ipcRenderer.removeListener("desktop:system-status-changed", wrapped);
  },
  onLoginError: (listener) => {
    const wrapped = (_event, state) => listener({ message: String(state?.message || "") });
    ipcRenderer.on("desktop:login-error", wrapped);
    return () => ipcRenderer.removeListener("desktop:login-error", wrapped);
  },
  onDataflowCredentialStatusChanged: (listener) => {
    const wrapped = (_event, state) => listener(state || {});
    ipcRenderer.on("desktop:dataflow-credential-status-changed", wrapped);
    return () => ipcRenderer.removeListener("desktop:dataflow-credential-status-changed", wrapped);
  },
  onMaterialProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress || {});
    ipcRenderer.on("desktop:material-progress", wrapped);
    return () => ipcRenderer.removeListener("desktop:material-progress", wrapped);
  },
  onAssistantActivity: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:assistant-activity", wrapped);
    return () => ipcRenderer.removeListener("desktop:assistant-activity", wrapped);
  },
  onAssistantTask: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:assistant-task", wrapped);
    return () => ipcRenderer.removeListener("desktop:assistant-task", wrapped);
  },
  onAssistantTaskEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:assistant-task-event", wrapped);
    return () => ipcRenderer.removeListener("desktop:assistant-task-event", wrapped);
  },
  onAssistantTaskActivity: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:assistant-task-activity", wrapped);
    return () => ipcRenderer.removeListener("desktop:assistant-task-activity", wrapped);
  },
  onAssistantTaskProvenance: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:assistant-task-provenance", wrapped);
    return () => ipcRenderer.removeListener("desktop:assistant-task-provenance", wrapped);
  },
  onUpdateState: (listener) => {
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desktop:update-state", wrapped);
    return () => ipcRenderer.removeListener("desktop:update-state", wrapped);
  },
}));
