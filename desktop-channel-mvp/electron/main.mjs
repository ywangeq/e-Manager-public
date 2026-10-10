import { localCenterUrl } from "../shared/local-center.mjs";
import { registerLocalCalendarIpc } from "./local-calendar-ipc.mjs";
import { createLocalCalendarService } from "./local-calendar-service.mjs";
import { createFeishuCalendarCache } from "./feishu-calendar-cache.mjs";
import { validFeishuCalendarUrl } from "../shared/feishu-calendar-read-contract.mjs";
import { createFeishuCalendarProjection } from "./feishu-calendar-projection.mjs";
import { createManagedFeishuReadAdapters } from "./managed-feishu-read-adapter.mjs";
import { createDesktopConfirmationOutbox, CONFIRMATION_DELIVERY_MESSAGE } from "./desktop-confirmation-outbox.mjs";
import { deliverToolConfirmation, readConfirmationDeliveryResponse } from "./desktop-confirmation-delivery.mjs";
import { registerDesktopPersonalAutomationsIpc } from "./desktop-personal-automations.mjs";
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, net, powerMonitor, safeStorage, screen, session, shell } from "electron";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopReleaseUpdateChecks } from "./release-update-service.mjs";
import { createUnsignedUpdateDownload } from "./unsigned-update-download.mjs";
import { createDesktopUpdateSignalClient } from "./release-update-signal-client.mjs";
import { createDesktopPresenceClient } from "./desktop-presence-client.mjs";
import { createDesktopUpdatePreferenceFilePersistence } from "./release-update-preference-file.mjs";
import { createWindowSizePreferences } from "./window-size-preferences.mjs";
import { createDesktopTaskFollowService } from "./desktop-task-follow-service.mjs";
import { createDesktopMyTasksService, registerDesktopMyTasksIpc } from "./desktop-my-tasks-service.mjs";
import {
  createDesktopGroupMaterialHandler,
  createDesktopGroupStudioService,
  registerDesktopGroupMaterialIpc,
  registerDesktopGroupStudioIpc,
} from "./desktop-group-studio-service.mjs";
import { createDesktopArtifactDeliveryService } from "./desktop-artifact-delivery.mjs";
import { createDesktopManagedSandboxSupervisor } from "./managed-sandbox-supervisor.mjs";
import { createDesktopManagedSandboxTaskWorkspace } from "./managed-sandbox-task-workspace.mjs";
import { createDesktopSandboxDispatchClient } from "./desktop-sandbox-dispatch-client.mjs";
import { createDesktopSandboxMainDispatch } from "./desktop-sandbox-main-dispatch.mjs";
import { createDesktopSandboxDeviceSession } from "./desktop-sandbox-device-session.mjs";
import { createDesktopSandboxOutputIngestService } from "./desktop-sandbox-output-ingest.mjs";
import { createDesktopTaskArtifactStagingClient } from "./desktop-task-artifact-staging-client.mjs";
import {
  installManagedCenterCertificateTrust,
  normalizeManagedCenterCertificatePins,
} from "./desktop-center-certificate-trust.mjs";
import { createDesktopCenterHealthCheck } from "./desktop-center-health.mjs";
import { createDesktopReusableArtifactMaterialService } from "./desktop-reusable-artifact-materials.mjs";
import products from "../shared/desktop-product.cjs";
import {
  createConversationDisplayCache,
  createEncryptedConversationDisplayCacheFilePersistence,
} from "./conversation-display-cache.mjs";
import {
  normalizeDesktopConversationHistoryBootstrap,
  resolveEffectiveDesktopConversationHistoryPolicy,
} from "../shared/desktop-conversation-history-policy.mjs";
import { hydrateDesktopBootstrapCharacters } from "./desktop-character-contract.mjs";
import { prepareDesktopMaterialBridge } from "./desktop-material-bridge.mjs";
import { DESKTOP_MATERIAL_GRANT_TTL_MS, prepareDesktopMaterialManifest } from "./desktop-material-manifest.mjs";
import { planDesktopSandboxWorkspaceInputs } from "./desktop-sandbox-workspace-input.mjs";
import {
  attachmentDescriptorForName,
  attachmentMimeTypeForName,
  DESKTOP_ATTACHMENT_LIMITS,
  normalizeLocalAttachments,
} from "../shared/desktop-attachments.mjs";
import {
  createAssistantActivityStreamParser,
  createAssistantTaskStreamParser,
  createDesktopSandboxBindingStreamParser,
  stripDesktopSandboxBindingEvents,
} from "../shared/desktop-assistant-activity.mjs";
import { currentUserAuthorizationEventsFromSse } from "../shared/current-user-authorization-action.mjs";
import {
  desktopCenterUnavailableResult,
  fetchWithLocalEndpointRecovery,
  isDesktopCenterUnavailableError,
} from "./server-endpoint-recovery.mjs";
import {
  windowAlwaysOnTopForState,
  windowBoundsForState,
  windowResizePolicyForState,
} from "./window-position.mjs";
import {
  createEncryptedCredentialFilePersistence,
  createTemporaryToolCredentialStore,
  isSecureCredentialTransport,
} from "./temporary-tool-token-store.mjs";
import { createDataflowDeviceSessionCredentialBroker, dataflowCredentialPartition } from "./dataflow-device-session-broker.mjs";
import { createDesktopFeishuAuthorization } from "./desktop-feishu-authorization.mjs";
import { createDesktopSubsystemConnections, registerDesktopSubsystemConnectionsIpc } from "./desktop-subsystem-connections.mjs";
import { createDesktopDeviceTools } from "./desktop-device-tools.mjs";
import { createDesktopFeishuCliConnection } from "./desktop-feishu-cli-connection.mjs";
import { createFeishuAssociationIntentStore } from "./feishu-association-intent-store.mjs";
import { projectDataflowCredentialStatus, subsystemAuthenticationState } from "../shared/desktop-subsystem-connections.mjs";
import {
  createDataflowCredentialChallengeClient,
  dataflowCredentialConfigFromBootstrap,
} from "./dataflow-device-session-channel.mjs";
import { containsCredentialText, isCredentialOnlyText, redactCredentialText } from "../shared/sensitive-text-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
app.setName("e-Manager Group Studio Local");
app.setPath("userData", path.join(app.getPath("appData"), "e-Manager Group Studio Local"));
const PACKAGED_PRODUCT = products.packagedProduct(JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")));
const RELEASE_ROUTE_BASE = PACKAGED_PRODUCT.routeBase;
const PACKAGED_NON_PRODUCTION_TEST_CONFIG = isPackagedNonProductionTestConfig();
const GROUP_STUDIO_TEST = PACKAGED_NON_PRODUCTION_TEST_CONFIG && isPackagedNonProductionTestConfig("groupStudioTest");
const GROUP_STUDIO = PACKAGED_PRODUCT === products.GROUP_STUDIO_PRODUCT || GROUP_STUDIO_TEST;
if (PACKAGED_NON_PRODUCTION_TEST_CONFIG) {
  app.setPath("userData", path.join(app.getPath("temp"), "e-manager-local-sandbox-test"));
}
const DEV_URL = cleanHttpUrl(process.env.DESKTOP_DEV_URL || "");
const ENV_SERVER_URL = String(process.env.EMANAGER_LOCAL_CENTER_URL || "").trim();
const DEFAULT_SERVER_URL = "http://127.0.0.1:14878";
const START_EXPANDED = GROUP_STUDIO || process.env.DESKTOP_START_EXPANDED === "1";
const COLLAPSED_SIZE = GROUP_STUDIO ? { width: 250, height: 258 } : { width: 210, height: 218 };
const EXPANDED_SIZE = GROUP_STUDIO ? { width: 1080, height: 760 } : { width: 440, height: 548 };
const EXPANDED_MIN_SIZE = { ...EXPANDED_SIZE };
const SESSION_REVALIDATE_INTERVAL_MS = 15 * 60 * 1000;
const FORTRESS_LOGIN_ALLOWED_ORIGINS = [
  "https://passport.feishu.cn",
];

let mainWindow = null;
let cockpitWindow = null;
let loginWindow = null;
let loginStatusTimer = null;
let dataflowLoginWindow = null;
let dataflowLoginStatusTimer = null;
let dataflowLoginController = null;
let sessionRevalidateTimer = null;
let sessionRevalidationPromise = null;
let releaseUpdateService = null;
let releaseUpdateSignalClient = null;
let desktopPresenceClient = null;
let localCalendarService = null;
let localCalendarLoading = null;
let desktopDeviceTools = null;
const deviceReadDiagnostics = [];
let deviceDiagnosticWrite = Promise.resolve();
let groupReadAssociationGeneration = null;
const feishuCalendarCache = createFeishuCalendarCache({
  directory: () => path.join(app.getPath("userData"), "calendar-display.v1"),
  encryption: {...safeStorageEncryption(), isAvailable: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text"},
});
const feishuCalendarProjection = createFeishuCalendarProjection({ persist: (value,snapshots) => {
  const binding = feishuCliConnection.verifiedCacheBinding();
  if (binding && GROUP_STUDIO && isExpectedDesktopActor(value.actorKey,value.actorVersion) &&
    value.center === serverUrl && value.associationGeneration === feishuCliConnection.associationGeneration())
    return feishuCalendarCache.write({...value,...binding},snapshots);
  return false;
}, notify: () => {
  if (!mainWindow?.webContents?.isDestroyed()) mainWindow.webContents.send("desktop:calendar-changed");
} });
let releaseUpdateSettings = { channel: "", policy: null };
let releaseUpdateChannel = "";
let releaseUpdateState = { update: { status: "disabled" }, signal: { status: "disabled" } };
let tray = null;
let expanded = START_EXPANDED;
let expandedWindowSize = { ...EXPANDED_SIZE };
let windowSizePreferences = null;
let collapsedWindowPosition = null;
let activeWindowDrag = null;
let quitting = false;
let serverUrl = DEFAULT_SERVER_URL;
let serverUrlSource = "fallback";
let serverConfigurationError = "";
let allowMvpPrivateLanCredentialTransport = false;
let conversationDisplayCache = null;
let conversationHistoryBootstrap = null;
let confirmationOutbox = null;
let confirmationRecoveryPromise = null;
let conversationHistorySafetyCeiling = null;
let activeActorProjection = null;
let activeActorContextVersion = 0;
const localSelections = new Map();
const deviceWorkspaceSelections = new Map();
const materialPreparationJobs = new Map();
const preparedMaterialGrants = new Map();
let temporaryToolCredentials = createTemporaryToolCredentialStore();
let dataflowCredentialBroker = null;
let retiredDataflowSessionCleanup = null;
const dataflowSessionCleanups = new Map();
let dataflowCredentialChallengeClient = null;
let dataflowCredentialConfig = null;
let dataflowCredentialActorKey = "";
let dataflowCredentialBootstrapController = null;
let dataflowCredentialState = { status: "not_configured", code: "dataflow_credential_not_configured" };
let desktopArtifactDeliveryService = null;
let desktopReusableArtifactMaterialService = null;
let desktopManagedSandboxSupervisor = null;
let desktopManagedSandboxTaskWorkspace = null;
let desktopSandboxMainDispatch = null;
let desktopSandboxOutputIngest = null;
let removeManagedCenterCertificateTrust = () => {};
let serverIsHealthy = null;
// The managed helper exists only on macOS. Other Desktop platforms must not
// advertise a Sandbox Device session that the local process cannot execute.
const desktopSandboxDeviceSession = process.platform === "darwin"
  ? createDesktopSandboxDeviceSession()
  : null;
const desktopEmployeeToolIds = new Map();
const feishuCliConnection = createDesktopFeishuCliConnection({
  onDisconnect: actor => feishuCalendarCache.removeActor({center:serverUrl,actorKey:actor.key}),
  isExpectedActor: isExpectedDesktopActor,
  actorContext: () => ({ key: activeActorKey, version: activeActorContextVersion }),
  intentStore: GROUP_STUDIO ? createFeishuAssociationIntentStore({
    filePath: () => path.join(app.getPath("userData"), "feishu-association-intent.v1.json"),
    centerOrigin: () => serverUrl,
  }) : null,
  readActor: async ({ signal } = {}) => {
    const key = activeActorKey, version = activeActorContextVersion;
    if (!key) return null;
    const response = await desktopFetch("/api/me", { signal, headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok || data.ok !== true || !data.session || !isExpectedDesktopActor(key, version)) return null;
    const actor = data.session;
    const returnedKey = cleanMessage(actor.employeeId || actor.email || actor.feishuUserId || actor.employeeNo || "").toLowerCase();
    if (returnedKey !== key) return null;
    return { key, version, identitySource: actor.identitySource, email: actor.email,
      feishuUserId: actor.feishuUserId, feishuUnionId: actor.feishuUnionId };
  },
});
const feishuAuthorization = createDesktopFeishuAuthorization({
  actorContext: () => ({ key: activeActorKey, version: activeActorContextVersion }),
  isExpectedActor: isExpectedDesktopActor, connection: {
    status: feishuCliConnection.status, check: feishuCliConnection.check,
    connect: async (...args) => { await feishuCliConnection.connect(...args); notifySubsystemConnectionsChanged(); },
  },
  openExternal: url => shell.openExternal(url),
});
const subsystemConnections = createDesktopSubsystemConnections({
  actorContext: () => ({ key: activeActorKey, version: activeActorContextVersion }),
  isExpectedActor: isExpectedDesktopActor,
  notify: notifySubsystemConnectionsChanged,
  personalConnectionIds: GROUP_STUDIO ? ["lark-cli-openapi"] : [],
  adapters: new Map([["dataflow-rest-api", {
    name: "DataFlow",
    icon: "database",
    credentialMode: "device_session_refresh",
    renewal: "automatic",
    status: () => {
      const value = safeDataflowCredentialStatus();
      return { ...value, state: subsystemAuthenticationState(value), actionsEnabled: value.configured && value.transportReady };
    },
    check: (_id, options) => checkDataflowCredentialSession(options),
    connect: () => openDataflowCredentialLoginWindow(),
    disconnect: () => clearDataflowCredentialSession(),
  }], ["lark-cli-openapi", feishuCliConnection]]),
});
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const desktopEmployeeMaterialContracts = new Map();
const desktopCharacterAssetCache = new Map();
const desktopAssistantRequestControllers = new Set();
let activeActorKey = "";
const desktopTaskFollowService = createDesktopTaskFollowService({
  cleanMessage,
  desktopFetch,
  isExpectedActor: isExpectedDesktopActor,
  onTaskTerminal: ({ taskId }) => desktopSandboxMainDispatch?.finishTask({ taskId }),
});
const desktopMyTasksService = createDesktopMyTasksService({
  desktopFetch,
  isExpectedActor: isExpectedDesktopActor,
  onListFailure: () => desktopTaskFollowService.retainMyTasks([]),
  onListProjection: (page) => desktopTaskFollowService.retainMyTasks(
    page.tasks.map((task) => ({ employeeId: task.employeeId, taskId: task.id })),
  ),
});
const desktopGroupStudioService = createDesktopGroupStudioService({
  desktopFetch,
  isExpectedActor: isExpectedDesktopActor,
  loadDisplayHistory: loadGroupGoalDisplayHistory,
  onHistoryDeleted: clearGroupGoalDisplayHistory,
  onGoalSession: rememberGroupGoalSession,
});

app.commandLine.appendSwitch("force-renderer-accessibility");
app.enableSandbox();

app.whenReady().then(async () => {
  windowSizePreferences = createWindowSizePreferences({
    filePath: path.join(app.getPath("userData"), "window-size.v1.json"),
    defaultSize: EXPANDED_SIZE,
    onFailure: () => console.warn("[desktop-window] size_preference_save_failed"),
  });
  expandedWindowSize = windowSizePreferences.read();
  serverIsHealthy = createDesktopCenterHealthCheck({ browserSession: session.defaultSession });
  const endpoint = await resolveServerEndpoint();
  releaseUpdateSettings = await readManagedUpdateSettings();
  conversationHistorySafetyCeiling = await readPackagedConversationHistorySafetyCeiling();
  temporaryToolCredentials = createTemporaryToolCredentialStore({
    encryption: safeStorageEncryption(),
    persistence: createEncryptedCredentialFilePersistence({
      filePath: path.join(app.getPath("userData"), "tool-credentials.enc.v1.json"),
    }),
  });
  conversationDisplayCache = createConversationDisplayCache({
    encryption: safeStorageEncryption(),
    persistence: createEncryptedConversationDisplayCacheFilePersistence({
      filePath: path.join(app.getPath("userData"), "conversation-display-cache.v1.json"),
    }),
    resolveEffectivePolicy: ({ employeeId = "", projection = null, sessionId = "" } = {}) => {
      const targetEmployeeId = cleanEmployeeId(employeeId || projection?.employeeId);
      const targetSessionId = cleanMessage(sessionId || projection?.sessionId).slice(0, 240);
      const sessionState = conversationHistoryBootstrap?.sessions?.[targetEmployeeId] ||
        Object.values(conversationHistoryBootstrap?.groupSessions || {}).find(item => item.employeeId === targetEmployeeId && item.sessionId === targetSessionId);
      const sessionExpiresAt = targetSessionId && sessionState?.sessionId === targetSessionId
        ? sessionState.sessionExpiresAt
        : "";
      return resolveEffectiveDesktopConversationHistoryPolicy({
        authExpiresAt: conversationHistoryBootstrap?.authExpiresAt || "",
        centerManagedPolicy: conversationHistoryBootstrap?.policy || null,
        packagedSafetyCeiling: conversationHistorySafetyCeiling,
        sessionExpiresAt,
      });
    },
  });
  confirmationOutbox = createDesktopConfirmationOutbox({
    filePath:path.join(app.getPath("userData"),"confirmation-delivery.enc.v1.json"),
    encryption:{...safeStorageEncryption(),isAvailable:() => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text"},
  });
  releaseUpdateChannel = releaseUpdateSettings.channel;
  serverUrl = endpoint.url;
  serverUrlSource = endpoint.source;
  serverConfigurationError = endpoint.error || "";
  allowMvpPrivateLanCredentialTransport = endpoint.allowMvpPrivateLanCredentialTransport === true;
  try {
    resetManagedCenterCertificateTrust(endpoint);
  } catch {
    serverUrl = "";
    serverConfigurationError = "企业配置中的 Center 证书指纹无效或无法校验";
  }
  desktopArtifactDeliveryService = createDesktopArtifactDeliveryService({
    currentActorContext: () => ({ actorKey: activeActorKey, version: activeActorContextVersion }),
    openPath: (filePath) => shell.openPath(filePath),
    request: desktopFetch,
    revealPath: (filePath) => shell.showItemInFolder(filePath),
    tempRoot: path.join(app.getPath("temp"), "e-manager-local-artifact-open"),
    workspaceRoot: path.join(app.getPath("documents"), "数字员工工作区"),
  });
  desktopReusableArtifactMaterialService = createDesktopReusableArtifactMaterialService({
    currentActorContext: () => ({ actorKey: activeActorKey, version: activeActorContextVersion }),
    request: desktopFetch,
  });
  if (process.platform === "darwin") {
    desktopManagedSandboxSupervisor = createDesktopManagedSandboxSupervisor({
      helperPath: managedSandboxHelperPath(),
    });
  }
  desktopManagedSandboxTaskWorkspace = createDesktopManagedSandboxTaskWorkspace({ userDataPath: app.getPath("userData") });
  desktopSandboxOutputIngest = createDesktopSandboxOutputIngestService({
    stageTaskArtifacts: createDesktopTaskArtifactStagingClient({ authenticatedFetch: desktopFetch }).stageTaskArtifacts,
    taskWorkspace: desktopManagedSandboxTaskWorkspace,
  });
  desktopSandboxMainDispatch = createDesktopSandboxMainDispatch({
    authenticatedFetch: desktopFetch,
    createClaimClient: createDesktopSandboxDispatchClient,
    currentActorContext: () => ({ key: activeActorKey, version: activeActorContextVersion }),
    outputIngest: desktopSandboxOutputIngest,
    resolveAuthorizedSelection: resolveDesktopSandboxAuthorizedSelection,
    supervisor: desktopManagedSandboxSupervisor,
    taskWorkspace: desktopManagedSandboxTaskWorkspace,
  });
  await desktopArtifactDeliveryService.cleanup();
  installPermissionBoundary();
  registerIpcHandlers();
  createMainWindow();
  createTray();
  if (GROUP_STUDIO) void ensureLocalCalendar().catch(() => {});
  powerMonitor.on("suspend", () => { localCalendarService?.suspend(); void desktopDeviceTools?.stop(); });
  powerMonitor.on("resume", () => { localCalendarService?.resume(); void desktopDeviceTools?.ensure().catch(() => {}); });
  installSessionRevalidationTriggers();
  setReleaseUpdateState({ signal: { status: "authentication_required" } });
});

app.on("before-quit", (event) => {
  windowSizePreferences?.flush();
  if (!quitting && (desktopPresenceClient || localCalendarService)) {
    event.preventDefault();
    quitting = true;
    const client = desktopPresenceClient;
    desktopPresenceClient = null;
    const local = localCalendarService; localCalendarService = null;
    void Promise.allSettled([client?.stop(), local?.close(), desktopDeviceTools?.stop()]).finally(() => app.quit());
    return;
  }
  quitting = true;
  if (sessionRevalidateTimer) clearInterval(sessionRevalidateTimer);
  releaseUpdateService?.stop();
  releaseUpdateSignalClient?.stop();
  removeManagedCenterCertificateTrust();
  disposeDataflowCredentialRuntime();
  desktopTaskFollowService.abortAll();
  abortDesktopAssistantRequests();
  desktopSandboxMainDispatch?.cancelAndClear();
  desktopArtifactDeliveryService?.abortAll();
  void desktopArtifactDeliveryService?.cleanup();
});

app.on("window-all-closed", (event) => {
  event?.preventDefault?.();
});

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
  else mainWindow.show();
  void revalidateDesktopSession("app_activate");
});

function createMainWindow() {
  const initialResizePolicy = windowResizePolicyForState({
    collapsedSize: COLLAPSED_SIZE,
    expandedMinSize: EXPANDED_MIN_SIZE,
    isExpanded: expanded,
    workArea: screen.getPrimaryDisplay().workArea,
  });
  mainWindow = new BrowserWindow({
    ...currentWindowBounds(),
    ...initialResizePolicy,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: windowAlwaysOnTopForState({ isExpanded: expanded }),
    skipTaskbar: true,
    ...(process.platform === "win32" ? { thickFrame: true } : {}),
    maximizable: GROUP_STUDIO,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    title: GROUP_STUDIO ? "Group Studio 3.0" : "e-Manager Local",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  anchorWindow(expanded);
  secureWebContents(mainWindow.webContents, DEV_URL || "file://");

  if (GROUP_STUDIO) mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle("Group Studio 3.0");
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    windowSizePreferences?.flush();
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  const rememberCollapsedPosition = () => {
    if (!mainWindow || mainWindow.isDestroyed() || expanded) return;
    const [x, y] = mainWindow.getPosition();
    collapsedWindowPosition = { x, y };
  };
  mainWindow.on("move", rememberCollapsedPosition);
  mainWindow.on("moved", rememberCollapsedPosition);
  // will-resize is user-driven; programmatic pet/expanded bounds must not
  // overwrite the user's preferred expanded size.
  mainWindow.on("will-resize", (_event, bounds) => {
    if (mainWindow.isMaximized()) return;
    rememberExpandedWindowSize(bounds);
  });
  if (GROUP_STUDIO) {
    const sendMaximizedState = () => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("desktop:maximized-state", mainWindow.isMaximized());
    };
    mainWindow.on("maximize", sendMaximizedState);
    mainWindow.on("unmaximize", sendMaximizedState);
  }

  if (DEV_URL) mainWindow.loadURL(GROUP_STUDIO ? new URL("/?preview=cockpit", `${DEV_URL}/`).toString() : DEV_URL);
  else mainWindow.loadFile(path.join(APP_ROOT, "dist", "index.html"), GROUP_STUDIO ? { query: { preview: "cockpit" } } : undefined);
}

function showCockpitWindow() {
  if (cockpitWindow && !cockpitWindow.isDestroyed()) {
    cockpitWindow.show();
    cockpitWindow.focus();
    return;
  }
  cockpitWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 920,
    minHeight: 680,
    show: false,
    backgroundColor: "#f7f9f8",
    title: "个人驾驶舱 · Group Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  const windowForLoad = cockpitWindow;
  secureWebContents(windowForLoad.webContents, DEV_URL || "file://");
  windowForLoad.once("ready-to-show", () => { if (!windowForLoad.isDestroyed()) windowForLoad.show(); });
  if (GROUP_STUDIO) {
    const sendMaximizedState = () => {
      if (!windowForLoad.isDestroyed()) windowForLoad.webContents.send("desktop:maximized-state", windowForLoad.isMaximized());
    };
    windowForLoad.on("maximize", sendMaximizedState);
    windowForLoad.on("unmaximize", sendMaximizedState);
  }
  windowForLoad.on("closed", () => { if (cockpitWindow === windowForLoad) cockpitWindow = null; });
  if (DEV_URL) windowForLoad.loadURL(new URL("/?preview=cockpit", `${DEV_URL}/`).toString());
  else windowForLoad.loadFile(path.join(APP_ROOT, "dist", "index.html"), { query: { preview: "cockpit" } });
}

function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray-icon.png")
    : path.join(APP_ROOT, "src", "assets", "characters", "tray-icon.png");
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip(GROUP_STUDIO ? "Group Studio 3.0" : "e-Manager Local");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "个人驾驶舱", click: () => showCockpitWindow() },
    ...(!GROUP_STUDIO ? [
      { label: "打开助手", click: () => showExpandedWindow() },
      { label: "收起为桌面宠物", click: () => setExpanded(false) },
    ] : []),
    { label: "退出登录", click: async () => { await logoutDesktopSession(); showExpandedWindow(); } },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
  tray.on("click", () => {
    if (GROUP_STUDIO) { showExpandedWindow(); return; }
    if (!mainWindow?.isVisible()) showExpandedWindow();
    else setExpanded(!expanded);
  });
}

function managedSandboxHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "managed-sandbox-helper")
    : path.join(APP_ROOT, "native", "managed-sandbox-helper", "target", "debug", "managed-sandbox-helper");
}

function registerIpcHandlers() {
  ipcMain.on("desktop:begin-window-drag", (event, point) => {
    assertMainSender(event);
    if (expanded || !mainWindow || !isFinitePoint(point)) return;
    const [windowX, windowY] = mainWindow.getPosition();
    activeWindowDrag = {
      pointerX: point.x,
      pointerY: point.y,
      windowX,
      windowY,
    };
  });

  ipcMain.on("desktop:move-window-drag", (event, point) => {
    assertMainSender(event);
    if (expanded || !mainWindow || !activeWindowDrag || !isFinitePoint(point)) return;
    const requested = {
      x: Math.round(activeWindowDrag.windowX + point.x - activeWindowDrag.pointerX),
      y: Math.round(activeWindowDrag.windowY + point.y - activeWindowDrag.pointerY),
    };
    const display = screen.getDisplayNearestPoint(point);
    const bounds = windowBoundsForState({
      collapsedPosition: requested,
      collapsedSize: COLLAPSED_SIZE,
      expandedSize: EXPANDED_SIZE,
      isExpanded: false,
      workArea: display.workArea,
    });
    mainWindow.setPosition(bounds.x, bounds.y, false);
  });

  ipcMain.on("desktop:end-window-drag", (event) => {
    assertMainSender(event);
    activeWindowDrag = null;
  });

  ipcMain.handle("desktop:get-environment", (event) => {
    assertMainSender(event);
    return {
      isDesktop: true,
      expanded,
      platform: process.platform,
      appVersion: app.getVersion(),
      displayVersion: products.displayVersion(PACKAGED_PRODUCT, app.getVersion()),
      updateChannel: releaseUpdateChannel,
      serverUrl,
      serverUrlSource,
    };
  });

  ipcMain.handle("desktop:get-update-state", (event) => {
    assertMainSender(event);
    return structuredClone(releaseUpdateState);
  });

  ipcMain.handle("desktop:check-for-updates", async (event) => {
    assertMainSender(event);
    return releaseUpdateService?.checkNow("manual") || { status: "disabled" };
  });
  ipcMain.handle("desktop:download-update", async (event) => {
    assertMainSender(event);
    return releaseUpdateService?.downloadAvailable() || { status: "disabled" };
  });
  ipcMain.handle("desktop:open-downloaded-update", async (event) => {
    assertMainSender(event);
    return releaseUpdateService?.openDownloaded() || { status: "disabled" };
  });

  ipcMain.handle("desktop:notify-network-restored", async (event) => {
    assertMainSender(event);
    const revalidation = await revalidateDesktopSession("network_restore");
    if (!revalidation.ok) return { ok: false, statuses: [revalidation.status || revalidation.error || "revalidation_failed"] };
    const results = await Promise.allSettled([
      releaseUpdateService?.notifyNetworkRestored?.(),
      restartReleaseUpdateSignalClient(),
    ]);
    return { ok: true, statuses: results.map((result) => result.status) };
  });

  ipcMain.handle("desktop:set-expanded", (event, nextExpanded) => {
    assertMainSender(event);
    setExpanded(nextExpanded === true);
    return { expanded };
  });

  ipcMain.handle("desktop:get-maximized", (event) => {
    assertMainSender(event);
    const target = desktopWindowForSender(event);
    return GROUP_STUDIO && target?.isMaximized() === true;
  });
  ipcMain.handle("desktop:toggle-maximized", (event) => {
    assertMainSender(event);
    const target = desktopWindowForSender(event);
    if (!GROUP_STUDIO || !target || (target === mainWindow && !expanded)) return false;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return target.isMaximized();
  });

  ipcMain.handle("desktop:hide", (event) => {
    assertMainSender(event);
    mainWindow?.hide();
    return { hidden: true };
  });

  ipcMain.handle("desktop:open-cockpit", (event) => {
    assertMainSender(event);
    showCockpitWindow();
    return { opened: true };
  });

  ipcMain.handle("desktop:show-assistant", (event) => {
    assertMainSender(event);
    showExpandedWindow();
    return { opened: true };
  });

  ipcMain.handle("desktop:choose-attachments", async (event) => {
    assertMainSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择要交给本地通道的文件",
      buttonLabel: "授权本次选择",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return { canceled: true, files: [] };
    return prepareSelection(result.filePaths);
  });

  ipcMain.handle("desktop:register-dropped-attachments", async (event, filePaths) => {
    assertMainSender(event);
    if (!Array.isArray(filePaths)) throw new Error("invalid_dropped_file_list");
    return prepareSelection(filePaths);
  });

  ipcMain.handle("desktop:prepare-material", async (event, input) => {
    assertMainSender(event);
    const jobId = cleanMessage(input?.jobId || "").slice(0, 120);
    const employeeId = cleanEmployeeId(input?.employeeId);
    if (!jobId || materialPreparationJobs.has(jobId)) throw new Error("desktop_material_job_invalid");
    if (!employeeId) throw new Error("desktop_material_employee_required");
    if (!activeActorKey) throw new Error("desktop_material_authentication_required");
    const files = resolveAuthorizedMaterialFiles(input?.files);
    if (!files.length) throw new Error("desktop_material_selection_expired");

    const controller = new AbortController();
    materialPreparationJobs.set(jobId, controller);
    let lastProgressAt = 0;
    try {
      const { prepared, bridge } = await prepareDesktopMaterialSelection({
        files,
        employeeId,
        signal: controller.signal,
        materialInputContracts: desktopEmployeeMaterialContracts.get(employeeId) || [],
        onProgress: (progress) => {
          const now = Date.now();
          if (progress.phase !== "ready" && now - lastProgressAt < 80) return;
          lastProgressAt = now;
          mainWindow?.webContents.send("desktop:material-progress", { jobId, ...progress });
        },
      });
      const deviceSelectionRef = crypto.randomUUID();
      preparedMaterialGrants.set(prepared.grant.grantId, {
        actorKey: activeActorKey,
        createdAt: Date.now(),
        expiresAt: Date.parse(prepared.grant.expiresAt),
        authorizedEmployeeId: employeeId,
        bridgeItems: bridge.items,
        deviceSelectionRef,
        safeContext: prepared.safeContext,
        workspaceInputDigest: prepared.sandboxWorkspaceInput.workspaceInputDigest,
      });
      deviceWorkspaceSelections.set(deviceSelectionRef, {
        actorKey: activeActorKey,
        authorizedEmployeeId: employeeId,
        expiresAt: Date.parse(prepared.grant.expiresAt),
        files,
      });
      pruneSelections();
      return {
        ok: true,
        jobId,
        grant: prepared.grant,
        manifest: prepared.manifest,
        bridge: {
          contractVersion: bridge.contractVersion,
          status: bridge.status,
          itemCount: bridge.items.length,
          itemNames: bridge.items.map((item) => item.name),
          skipped: bridge.skipped,
        },
      };
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        return { ok: false, jobId, status: "canceled" };
      }
      throw error;
    } finally {
      materialPreparationJobs.delete(jobId);
    }
  });

  ipcMain.handle("desktop:cancel-material-preparation", (event, jobId) => {
    assertMainSender(event);
    const controller = materialPreparationJobs.get(cleanMessage(jobId || "").slice(0, 120));
    if (!controller) return { canceled: false };
    controller.abort();
    return { canceled: true };
  });

  registerDesktopGroupMaterialIpc({
    ipcMain,
    assertSender: assertMainSender,
    handler: createDesktopGroupMaterialHandler({
      actorContext: () => ({ actorKey: activeActorKey, actorContextVersion: activeActorContextVersion }),
      cleanEmployeeId,
      desktopFetch,
      groupStudioService: desktopGroupStudioService,
      isExpectedActor: isExpectedDesktopActor,
      materialInputContractsFor: employeeId => desktopEmployeeMaterialContracts.get(employeeId) || [],
      materialPreparationJobs,
      prepareMaterialSelection: prepareDesktopMaterialSelection,
      resolveAuthorizedMaterialFiles,
    }),
  });

  ipcMain.handle("desktop:bootstrap", async (event) => {
    assertMainSender(event);
    const requestActor = { key: activeActorKey, version: activeActorContextVersion };
    try {
      const response = await desktopFetch("/api/channels/desktop/bootstrap", {
        headers: desktopSandboxDeviceSession?.headers(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(cleanMessage(data.message || data.error || `HTTP ${response.status}`));
      if (!isExpectedDesktopActor(requestActor.key, requestActor.version)) return { ok: false, employees: [], error: "desktop_actor_changed" };
      const normalizedHistoryBootstrap = normalizeDesktopConversationHistoryBootstrap(data.conversationHistory);
      conversationHistoryBootstrap = normalizedHistoryBootstrap.ok && normalizedHistoryBootstrap.enabled
        ? normalizedHistoryBootstrap.bootstrap
        : null;
      if (!isExpectedDesktopActor(requestActor.key, requestActor.version)) return { ok: false, employees: [], error: "desktop_actor_changed" };
      void recoverPendingConfirmations();
      const hydratedData = await hydrateDesktopBootstrapCharacters(data, {
        assetCache: desktopCharacterAssetCache,
        includeAnimated: !GROUP_STUDIO,
        request: desktopFetch,
      });
      if (!isExpectedDesktopActor(requestActor.key, requestActor.version)) return { ok: false, employees: [], error: "desktop_actor_changed" };
      configureDataflowCredentialRuntime(data.credentialBrokerBootstrap);
      subsystemConnections.configure(hydratedData.employees || []);
      if (GROUP_STUDIO) void subsystemConnections.checkAll().catch(() => {});
      desktopEmployeeToolIds.clear();
      desktopEmployeeMaterialContracts.clear();
      for (const employee of hydratedData.employees || []) {
        const employeeId = cleanEmployeeId(employee.id);
        desktopEmployeeToolIds.set(employeeId, new Set((employee.tools || []).map((tool) => cleanEmployeeId(tool.id)).filter(Boolean)));
        desktopEmployeeMaterialContracts.set(employeeId, Array.isArray(employee.runtimeSkills?.materialInputContracts)
          ? employee.runtimeSkills.materialInputContracts
          : []);
      }
      const {
        conversationHistory: _mainProcessHistoryAuthority,
        credentialBrokerBootstrap: _mainProcessCredentialAuthority,
        sandboxDeviceSession: _mainProcessSandboxDeviceSession,
        ...rendererBootstrap
      } = hydratedData;
      return rendererBootstrap;
    } catch (error) {
      if (isExpectedDesktopActor(requestActor.key, requestActor.version)) subsystemConnections.clear();
      return { ok: false, employees: [], accessRequests: [], error: cleanMessage(error?.message || "员工权限目录不可用") };
    }
  });

  ipcMain.handle("desktop:get-conversation-history", async (event, employeeIdInput) => {
    assertMainSender(event);
    return loadConversationHistoryForEmployee(cleanEmployeeId(employeeIdInput));
  });

  registerDesktopSubsystemConnectionsIpc({ ipcMain, assertSender: assertMainSender, service: subsystemConnections });
  ipcMain.handle("desktop:calendar-snapshot", async (event, input) => {
    assertMainSender(event);
    if (!GROUP_STUDIO || input !== undefined || !activeActorKey) return { ok: false };
    const before = calendarProjectionContext();
    await restoreCalendarDisplay();
    if (JSON.stringify(before) !== JSON.stringify(calendarProjectionContext())) return {ok:false};
    return feishuCalendarProjection.read(before);
  });
  ipcMain.handle("desktop:calendar-open-link", async (event, input) => {
    assertMainSender(event);
    if (!GROUP_STUDIO || !activeActorKey || !input || Object.keys(input).sort().join() !== "eventRef,kind" ||
      typeof input.eventRef !== "string" || !["calendarUrl","meetingUrl"].includes(input.kind)) return {ok:false};
    const before = calendarProjectionContext();
    await restoreCalendarDisplay();
    if (JSON.stringify(before) !== JSON.stringify(calendarProjectionContext())) return {ok:false};
    const value = feishuCalendarProjection.read(calendarProjectionContext()).snapshots.flatMap(snapshot => snapshot.events).find(item => item.eventRef === input.eventRef);
    const url = value?.[input.kind];
    if (!validFeishuCalendarUrl(url,input.kind)) return {ok:false};
    await shell.openExternal(url); return {ok:true};
  });
  registerLocalCalendarIpc({ipcMain,assertSender:assertMainSender,
    actorContext:()=>({key:activeActorKey,version:activeActorContextVersion}),isExpectedActor:isExpectedDesktopActor,
    ensureService:()=>GROUP_STUDIO ? ensureLocalCalendar() : null});
  ipcMain.handle("desktop:feishu-authorization", (event, input) => {
    assertMainSender(event);
    return GROUP_STUDIO ? feishuAuthorization.request(input) : { ok: false };
  });
  registerDesktopPersonalAutomationsIpc({ipcMain,assertSender:assertMainSender,actorContext:() => ({key:activeActorKey,version:activeActorContextVersion}),isExpectedActor:isExpectedDesktopActor,desktopFetch});
  registerDesktopMyTasksIpc({
    actorContext: () => ({ key: activeActorKey, version: activeActorContextVersion }),
    assertSender: assertMainSender,
    ipcMain,
    service: desktopMyTasksService,
  });
  registerDesktopGroupStudioIpc({
    actorContext: () => ({ expectedActorKey: activeActorKey, expectedActorContextVersion: activeActorContextVersion }),
    assertSender: assertMainSender,
    ipcMain,
    service: desktopGroupStudioService,
  });

  ipcMain.handle("desktop:follow-assistant-task", async (event, input = {}) => {
    assertMainSender(event);
    const employeeId = cleanEmployeeId(input.employeeId);
    const taskId = cleanRuntimeTaskId(input.taskId);
    const streamId = cleanMessage(input.streamId).slice(0, 160);
    const afterSeq = Number(input.afterSeq || 0);
    const purpose = input.purpose === "my_tasks" ? "my_tasks" : "conversation";
    if (!activeActorKey) return { ok: false, status: "authentication_required" };
    if (!employeeId || !taskId || !streamId || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      return { ok: false, status: "invalid_task_reference" };
    }
    try {
      const followed = await desktopTaskFollowService.follow({
        afterSeq,
        employeeId,
        purpose,
        sender: event.sender,
        streamId,
        taskId,
        expectedActorContextVersion: activeActorContextVersion,
        expectedActorKey: activeActorKey,
      });
      return { ok: followed?.ok === true, status: followed?.ok === true ? "completed" : cleanMessage(followed?.status || "failed") };
    } catch (error) {
      return { ok: false, status: cleanMessage(error?.code || error?.message || "follow_failed") };
    }
  });

  ipcMain.handle("desktop:copy-task-id", async (event, taskIdInput) => {
    assertMainSender(event);
    const taskId = cleanRuntimeTaskId(taskIdInput);
    if (!taskId) return { ok: false, status: "invalid_task_id" };
    clipboard.writeText(taskId);
    return { ok: true };
  });

  ipcMain.handle("desktop:get-artifact-delivery", async (event, input) => {
    assertMainSender(event);
    return desktopArtifactDeliveryService?.inspect(input) || { ok: false, status: "service_unavailable" };
  });

  ipcMain.handle("desktop:deliver-artifact", async (event, input) => {
    assertMainSender(event);
    return desktopArtifactDeliveryService?.deliver(input) || { ok: false, status: "service_unavailable" };
  });

  ipcMain.handle("desktop:save-reusable-artifact", async (event, input) => {
    assertMainSender(event);
    return desktopReusableArtifactMaterialService?.save(input) || { ok: false, status: "service_unavailable" };
  });

  ipcMain.handle("desktop:list-reusable-artifacts", async (event, input) => {
    assertMainSender(event);
    return desktopReusableArtifactMaterialService?.list(input) || { ok: false, status: "service_unavailable", materials: [] };
  });

  ipcMain.handle("desktop:get-tool-parameter-cards", async (event, employeeIdInput) => {
    assertMainSender(event);
    const employeeId = cleanEmployeeId(employeeIdInput);
    if (!employeeId || !activeActorKey) return { ok: false, status: "authentication_required", cards: [] };
    const response = await desktopFetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/tool-parameter-cards`, {
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => ({}));
    return {
      ok: response.ok && data?.ok === true,
      status: response.ok ? "ready" : cleanMessage(data?.error || `http_${response.status}`),
      cards: Array.isArray(data?.cards) ? data.cards : [],
    };
  });

  for (const [channel, employeeScoped] of [["desktop:get-pending-interactions",false],["desktop:get-employee-pending-interactions",true]]) {
    ipcMain.handle(channel, async (event, employeeIdInput) => {
      assertMainSender(event);
      const actorKey = activeActorKey;
      const employeeId = employeeScoped ? cleanEmployeeId(employeeIdInput) : "";
      if (!actorKey || (employeeScoped && !employeeId)) return {ok:false,status:"authentication_required"};
      const response = await desktopFetch(employeeScoped ? `/api/digital-employees/${encodeURIComponent(employeeId)}/pending-interactions` : "/api/me/pending-interactions",{headers:{Accept:"application/json"}});
      const data = await response.json().catch(() => ({}));
      if (actorKey !== activeActorKey) return {ok:false,status:"actor_changed"};
      return {...data,ok:response.ok && data?.ok === true,status:response.ok ? "ready" : cleanMessage(data?.error || `http_${response.status}`)};
    });
  }

  ipcMain.handle("desktop:request-employee-access", async (event, input) => {
    assertMainSender(event);
    const employeeId = cleanMessage(input?.employeeId || "");
    if (!employeeId) throw new Error("digital_employee_id_required");
    const response = await desktopFetch("/api/digital-employee-access-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, reason: cleanMessage(input?.reason || "").slice(0, 240) }),
    });
    const data = await response.json().catch(() => ({}));
    return { ...data, ok: response.ok && data.ok === true, httpStatus: response.status };
  });

  ipcMain.handle("desktop:get-system-status", async (event) => {
    assertMainSender(event);
    try {
      const response = await desktopFetch("/api/me");
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) return { connected: false, authenticated: false };
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || !data.session) {
        await clearConversationHistoryActor();
        conversationHistoryBootstrap = null;
        activeActorProjection = null;
        setActiveActorKey("", { clearDataflowPartition: false });
        return {
          connected: response.status < 500,
          authenticated: false,
          reasonCode: cleanMessage(data.error || "authentication_required"),
        };
      }
      const actor = data.session;
      setActiveActorKey(actor.employeeId || actor.email || actor.feishuUserId || actor.employeeNo || "");
      activeActorProjection = {
        name: cleanMessage(actor.name || actor.displayName || "已登录用户"),
        department: cleanMessage(actor.department || actor.departmentName || ""),
        departmentId: cleanMessage(actor.departmentId || ""),
        role: cleanMessage(actor.role || actor.roleLabel || ""),
        permissions: cleanStringList(actor.permissions, 40),
        managedDepartmentIds: cleanStringList(actor.managedDepartmentIds, 40),
      };
      return {
        connected: true,
        authenticated: true,
        actor: activeActorProjection,
        actorContextVersion: activeActorContextVersion,
      };
    } catch (error) {
      if (activeActorKey && activeActorProjection && Date.parse(conversationHistoryBootstrap?.authExpiresAt || "") > Date.now()) {
        return {
          connected: false,
          authenticated: true,
          offline: true,
          actor: activeActorProjection,
          actorContextVersion: activeActorContextVersion,
        };
      }
      return { connected: false, authenticated: false, error: cleanMessage(error?.message || "系统不可达") };
    }
  });

  ipcMain.handle("desktop:revalidate-session", async (event) => {
    assertMainSender(event);
    return revalidateDesktopSession("renderer_request");
  });

  ipcMain.handle("desktop:open-login", async (event) => {
    assertMainSender(event);
    if (!serverUrl) {
      return {
        opened: false,
        error: serverConnectionErrorMessage(),
      };
    }
    openLoginWindow();
    return { opened: true, serverUrl };
  });

  ipcMain.handle("desktop:logout", async (event) => {
    assertMainSender(event);
    return logoutDesktopSession();
  });

  ipcMain.handle("desktop:tool-credential-status", async (event, toolId) => {
    assertMainSender(event);
    return credentialStatusForRenderer(await temporaryToolCredentials.status({
      actorKey: activeActorKey,
      toolId: cleanEmployeeId(toolId),
    }));
  });

  ipcMain.handle("desktop:load-tool-credential-from-clipboard", async (event, toolId) => {
    assertMainSender(event);
    return storeToolCredential(toolId, clipboard.readText());
  });

  ipcMain.handle("desktop:store-tool-credential", async (event, input) => {
    assertMainSender(event);
    return storeToolCredential(input?.toolId, input?.credentialText);
  });

  ipcMain.handle("desktop:clear-tool-credential", async (event, toolId) => {
    assertMainSender(event);
    return credentialStatusForRenderer(await temporaryToolCredentials.clear({
      actorKey: activeActorKey,
      toolId: cleanEmployeeId(toolId),
    }));
  });

  ipcMain.handle("desktop:get-dataflow-credential-status", (event) => {
    assertMainSender(event);
    return safeDataflowCredentialStatus();
  });

  ipcMain.handle("desktop:open-dataflow-login", async (event) => {
    assertMainSender(event);
    return openDataflowCredentialLoginWindow();
  });

  ipcMain.handle("desktop:logout-dataflow", async (event) => {
    assertMainSender(event);
    return clearDataflowCredentialSession();
  });

  ipcMain.handle("desktop:send-assistant", sendDesktopAssistant);

  ipcMain.handle("desktop:open-external", async (event, value) => {
    assertMainSender(event);
    const url = safeExternalUrl(value);
    if (!url) throw new Error("external_url_rejected");
    await shell.openExternal(url);
    return { opened: true };
  });
}

async function sendDesktopAssistant(event,input,{resumeDelivery=false}={}) {
    assertMainSender(event);
    const requestActorKey = activeActorKey;
    const requestActorContextVersion = activeActorContextVersion;
    const requestCenterOrigin = new URL(serverUrl).origin;
    const canContinueRequest = () => isExpectedDesktopActor(requestActorKey, requestActorContextVersion) &&
      new URL(serverUrl).origin === requestCenterOrigin;
    const employeeId = cleanEmployeeId(input?.employeeId);
    const streamId = cleanMessage(input?.streamId || "").slice(0, 120);
    if (!employeeId) throw new Error("desktop_employee_required");
    const rawMessage = cleanMessage(input?.message || "").slice(0, 800);
    if (containsCredentialText(rawMessage)) throw new Error("desktop_credential_message_blocked");
    const toolConfirmation = normalizeToolConfirmationInput(input?.toolConfirmation);
    const message = toolConfirmation ? CONFIRMATION_DELIVERY_MESSAGE : redactCredentialText(rawMessage);
    if (!message) throw new Error("empty_message");
    const messages = Array.isArray(input?.messages)
      ? input.messages.slice(-8).flatMap((item) => {
          const content = cleanMessage(item?.content || "").slice(0, 1800);
          if (!content || isCredentialOnlyText(content)) return [];
          return [{
            role: item?.role === "assistant" ? "assistant" : "user",
            content: redactCredentialText(content),
          }];
        }).filter((item) => item.content)
      : [];
    const materialGrantId = cleanMessage(input?.materialGrantId || "").slice(0, 120);
    const reusableMaterialGrantId = cleanReusableArtifactGrantId(input?.reusableMaterialGrantId);
    if (input?.reusableMaterialGrantId && !reusableMaterialGrantId) throw new Error("reusable_artifact_reference_invalid");
    const requestId = cleanMessage(input?.requestId || input?.streamId || "").slice(0, 240);
    const materialGrant = preparedMaterialGrant(materialGrantId, employeeId);
    let emptyDeviceWorkspaceSelectionRef = "";
    let emptyDeviceWorkspaceInputDigest = "";
    let emptyDeviceWorkspaceExpiresAt = 0;
    if (!materialGrant && activeActorKey && desktopSandboxDeviceSession && isManagedHttpsCenterOrigin(serverUrl)) {
      emptyDeviceWorkspaceSelectionRef = crypto.randomUUID();
      emptyDeviceWorkspaceInputDigest = planDesktopSandboxWorkspaceInputs([]).workspaceInputDigest;
      emptyDeviceWorkspaceExpiresAt = Date.now() + DESKTOP_MATERIAL_GRANT_TTL_MS;
      deviceWorkspaceSelections.set(emptyDeviceWorkspaceSelectionRef, {
        actorKey: requestActorKey,
        authorizedEmployeeId: employeeId,
        expiresAt: emptyDeviceWorkspaceExpiresAt,
        files: [],
      });
      pruneSelections();
    }
    const deviceWorkspaceMaterial = materialGrant?.deviceSelectionRef && materialGrant?.workspaceInputDigest
      ? {
          expiresAt: new Date(materialGrant.expiresAt).toISOString(),
          selectionRef: materialGrant.deviceSelectionRef,
          workspaceInputDigest: materialGrant.workspaceInputDigest,
        }
      : emptyDeviceWorkspaceSelectionRef
        ? {
            expiresAt: new Date(emptyDeviceWorkspaceExpiresAt).toISOString(),
            selectionRef: emptyDeviceWorkspaceSelectionRef,
            workspaceInputDigest: emptyDeviceWorkspaceInputDigest,
          }
      : null;
    const chatController = new AbortController();
    desktopAssistantRequestControllers.add(chatController);
    let submittedTask = null;
    let taskFollowPromise = null;
    try {
      await ensureLocalCalendar();
      if (!canContinueRequest()) throw Error("desktop_assistant_actor_changed");
      await desktopDeviceTools?.ensure();
      if (!canContinueRequest()) throw Error("desktop_assistant_actor_changed");
      if (toolConfirmation) {
        await confirmationOutbox.remember({actorKey:requestActorKey,centerOrigin:requestCenterOrigin,employeeId,
          sessionId:conversationHistoryBootstrap?.sessions?.[employeeId]?.sessionId,confirmationId:toolConfirmation.id});
        if (!canContinueRequest()) throw Error("desktop_assistant_actor_changed");
      }
      let desktopMaterial = materialGrant?.safeContext || null;
      if (materialGrant?.bridgeItems?.length) {
        const intakeResponse = await desktopFetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/desktop-material-intakes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractVersion: "desktop-material-bridge.v1",
            manifestDigest: desktopMaterial?.manifest?.contentDigest,
            items: materialGrant.bridgeItems,
          }),
          signal: chatController.signal,
        });
        const intake = await intakeResponse.json().catch(() => ({}));
        if (!intakeResponse.ok || !intake?.intakeId) {
          throw new Error(cleanMessage(intake?.error || `desktop_material_intake_http_${intakeResponse.status}`));
        }
        desktopMaterial = { ...desktopMaterial, intakeId: intake.intakeId };
      }
      const toolCredentials = await toolCredentialsForEmployee(employeeId);
      const toolParameterCard = normalizeToolParameterCardInput(input?.toolParameterCard);
      let response;
      const activityParser = createAssistantActivityStreamParser((activity) => {
        if (!canContinueRequest()) return;
        if (!streamId || event.sender.isDestroyed()) return;
        event.sender.send("desktop:assistant-activity", { employeeId, streamId, activity });
      });
      const acceptSubmittedTask = (task) => {
        if (!canContinueRequest()) return;
        submittedTask = { ...task, employeeId, streamId };
        if (toolConfirmation) void confirmationOutbox.forget({actorKey:requestActorKey,centerOrigin:requestCenterOrigin,confirmationId:toolConfirmation.id}).catch(() => {});
        if (resumeDelivery) {queueMicrotask(() => chatController.abort(Error("confirmation_delivery_received")));return;}
        taskFollowPromise ||= desktopTaskFollowService.follow({ employeeId, sender: event.sender, streamId, taskId: task.taskId, expectedActorContextVersion: requestActorContextVersion, expectedActorKey: requestActorKey });
        taskFollowPromise.catch(() => {});
        if (task.sessionId && conversationHistoryBootstrap) {
          conversationHistoryBootstrap = {
            ...conversationHistoryBootstrap,
            sessions: {
              ...(conversationHistoryBootstrap.sessions || {}),
              [employeeId]: {
                sessionId: task.sessionId,
                sessionExpiresAt: conversationHistoryBootstrap.authExpiresAt,
              },
            },
          };
        }
        if (!streamId || event.sender.isDestroyed()) return;
        event.sender.send("desktop:assistant-task", { employeeId, streamId, ...task });
      };
      const taskParser = createAssistantTaskStreamParser(acceptSubmittedTask);
      const sandboxBindingParser = createDesktopSandboxBindingStreamParser((binding) => {
        if (!deviceWorkspaceMaterial || !canContinueRequest()) return;
        if (binding.workspaceInputDigest !== deviceWorkspaceMaterial.workspaceInputDigest) return;
        try {
          const bound = desktopSandboxMainDispatch?.bindAuthorizedTaskInput({
            inputDigest: binding.taskInputDigest,
            selectionId: deviceWorkspaceMaterial.selectionRef,
            taskId: binding.taskId,
            workspaceInputDigest: binding.workspaceInputDigest,
          });
          deviceWorkspaceSelections.delete(deviceWorkspaceMaterial.selectionRef);
          if (bound && isManagedHttpsCenterOrigin(serverUrl)) {
            void desktopSandboxMainDispatch.claimAndExecute({
              centerOrigin: serverUrl,
              claimPath: "/api/channels/desktop/sandbox-dispatch/claim",
              taskId: bound.taskId,
            }).catch(() => {});
          }
        } catch {
          // A missing/changed selection remains unbound; no local execution can start.
        }
      });
      const streamParsers = {
        push(chunk) { activityParser.push(chunk); taskParser.push(chunk); sandboxBindingParser.push(chunk); },
        finish() { activityParser.finish(); taskParser.finish(); sandboxBindingParser.finish(); },
      };
      const send = async () => {
        if (!canContinueRequest()) throw Error("desktop_assistant_context_changed");
        streamParsers.finish();
        response = await desktopFetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...desktopDeviceTools?.headers() },
          body: JSON.stringify({ message, requestId:toolConfirmation ? `tool-confirmation:${toolConfirmation.id}` : requestId, activeViewLabel: "桌面 Channel", channelId: "desktop", messages, desktopMaterial, deviceWorkspaceMaterial, reusableMaterialGrantId, toolCredentials, toolConfirmation, toolParameterCard }),
        signal: chatController.signal,
      });
        return toolConfirmation ? readConfirmationDeliveryResponse({ response,
          read: () => readDesktopAssistantStream(response, streamParsers), hasTask: () => Boolean(submittedTask?.taskId),
        }) : readDesktopAssistantStream(response, streamParsers);
      };
      const rawBody = toolConfirmation ? await deliverToolConfirmation({ send, signal: chatController.signal,lookupFirst:resumeDelivery,
        canContinue: () => canContinueRequest(),
        lookup: async () => {
          const statusResponse = await desktopFetch(`/api/digital-employees/${encodeURIComponent(employeeId)}/tool-confirmations/${encodeURIComponent(toolConfirmation.id)}/submission`,
            { headers: { Accept: "application/json" }, signal: chatController.signal });
          if (!statusResponse.ok) throw Object.assign(Error("tool_confirmation_status_unavailable"), { terminal: [401, 403, 410].includes(statusResponse.status) });
          const state = await statusResponse.json();
          if (state?.ok !== true || state.contractVersion !== "tool-confirmation-submission.v1") throw Error("tool_confirmation_status_invalid");
          return state;
        },
        recovered: state => {
          response = { ok: true, status: 200 };
          const recoveredBody = `event: meta\ndata: ${JSON.stringify({ employeeId, taskId: state.taskId, taskStatus: state.taskStatus })}\n\nevent: done\ndata: ${JSON.stringify({ ok: true, followTask: true })}\n\n`;
          acceptSubmittedTask({ taskId: state.taskId, status: state.taskStatus });
          return recoveredBody;
        },
      }) : await send();
      if (toolConfirmation && [400,401,403,404,410,422].includes(response?.status)) await confirmationOutbox.forget({actorKey:requestActorKey,centerOrigin:requestCenterOrigin,confirmationId:toolConfirmation.id});
      if (materialGrantId) preparedMaterialGrants.delete(materialGrantId);
      const body = stripDesktopSandboxBindingEvents(rawBody);
      if (!canContinueRequest()) {
        throw new Error("desktop_assistant_actor_changed");
      }
      const credentialEvents = credentialEventsFromSse(body);
      for (const item of credentialEvents.filter((eventItem) => eventItem.clear)) {
        await temporaryToolCredentials.clear({ actorKey: requestActorKey, toolId: item.toolId });
      }
      if (taskFollowPromise) return { ...await taskFollowPromise, credentialEvents };
      const conversationSession = conversationSessionFromSse(body);
      if (response.ok && conversationSession?.sessionId && conversationHistoryBootstrap) {
        conversationHistoryBootstrap = {
          ...conversationHistoryBootstrap,
          sessions: {
            ...(conversationHistoryBootstrap.sessions || {}),
            [employeeId]: {
              sessionId: conversationSession.sessionId,
              sessionExpiresAt: conversationHistoryBootstrap.authExpiresAt,
            },
          },
        };
        await loadConversationHistoryForEmployee(employeeId);
      }
      return { ok: response.ok, status: response.status, body, credentialEvents };
    } catch (error) {
      if (toolConfirmation && error.terminal) await confirmationOutbox.forget({actorKey:requestActorKey,centerOrigin:requestCenterOrigin,confirmationId:toolConfirmation.id});
      if (resumeDelivery && submittedTask?.taskId && canContinueRequest()) return {ok:true,taskId:submittedTask.taskId};
      if (materialGrant && preparedMaterialGrants.get(materialGrantId) === materialGrant) materialGrant.inFlight = false;
      if (submittedTask?.taskId) {
        if (!canContinueRequest()) throw error;
        try {
          return await desktopTaskFollowService.follow({
            employeeId,
            sender: event.sender,
            streamId,
            taskId: submittedTask.taskId,
            expectedActorContextVersion: requestActorContextVersion,
            expectedActorKey: requestActorKey,
          });
        } catch (taskEventError) {
          if (!isDesktopCenterUnavailableError(taskEventError)) throw taskEventError;
        }
      }
      if (!isDesktopCenterUnavailableError(error)) throw error;
      return desktopCenterUnavailableResult(serverConnectionErrorMessage());
    } finally {
      if (emptyDeviceWorkspaceSelectionRef) deviceWorkspaceSelections.delete(emptyDeviceWorkspaceSelectionRef);
      desktopAssistantRequestControllers.delete(chatController);
    }
}

async function recoverPendingConfirmations() {
  if (confirmationRecoveryPromise || !confirmationOutbox || !activeActorKey || !conversationHistoryBootstrap ||
    !mainWindow || mainWindow.isDestroyed()) return confirmationRecoveryPromise;
  const actorKey = activeActorKey, version = activeActorContextVersion, centerOrigin = new URL(serverUrl).origin;
  confirmationRecoveryPromise = (async () => {
    const records = await confirmationOutbox.pending({actorKey,centerOrigin});
    for (const record of records) {
      if (!isExpectedDesktopActor(actorKey,version) || new URL(serverUrl).origin !== centerOrigin) return;
      const currentSession = conversationHistoryBootstrap?.sessions?.[record.employeeId]?.sessionId;
      if (!currentSession) continue;
      if (currentSession !== record.sessionId) {
        await confirmationOutbox.forget({actorKey,centerOrigin,confirmationId:record.confirmationId});continue;
      }
      try {
        await sendDesktopAssistant({sender:mainWindow.webContents},{employeeId:record.employeeId,
          message:CONFIRMATION_DELIVERY_MESSAGE,toolConfirmation:{contractVersion:"tool-call-confirmation.v1",id:record.confirmationId,decision:"approved"}},
          {resumeDelivery:true});
      } catch { /* Keep unresolved intent for the next existing authenticated revalidation. */ }
    }
  })().catch(() => {}).finally(() => {confirmationRecoveryPromise=null;});
  return confirmationRecoveryPromise;
}

async function readDesktopAssistantStream(response, activityParser) {
  if (!response.body?.getReader) {
    const body = (await response.text()).slice(0, 512 * 1024);
    activityParser.push(body);
    activityParser.finish();
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    activityParser.push(chunk);
    if (body.length < 512 * 1024) body = `${body}${chunk}`.slice(0, 512 * 1024);
  }
  const tail = decoder.decode();
  if (tail) {
    activityParser.push(tail);
    if (body.length < 512 * 1024) body = `${body}${tail}`.slice(0, 512 * 1024);
  }
  activityParser.finish();
  return body;
}


function abortDesktopAssistantRequests() {
  for (const controller of desktopAssistantRequestControllers) controller.abort();
  desktopAssistantRequestControllers.clear();
}

function isExpectedDesktopActor(expectedActorKey, expectedActorContextVersion) {
  return Boolean(expectedActorKey && activeActorKey === expectedActorKey &&
    activeActorContextVersion === expectedActorContextVersion);
}

function isFinitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function installSessionRevalidationTriggers() {
  sessionRevalidateTimer = setInterval(() => {
    void revalidateDesktopSession("periodic");
  }, SESSION_REVALIDATE_INTERVAL_MS);
  powerMonitor.on("resume", () => {
    void revalidateDesktopSession("system_resume").then((result) => {
      if (!result.ok) return;
      void subsystemConnections.checkAll();
      void releaseUpdateService?.notifyResume?.();
      void restartReleaseUpdateSignalClient();
    });
  });
}

async function revalidateDesktopSession(trigger) {
  if (sessionRevalidationPromise) return sessionRevalidationPromise;
  sessionRevalidationPromise = (async () => {
    try {
      const response = await desktopFetch("/api/auth/session/revalidate", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok === true) {
        setActiveActorKey(data.session?.employeeId || data.session?.email || data.session?.feishuUserId || data.session?.employeeNo || activeActorKey);
        void recoverPendingConfirmations();
        if (releaseUpdateState.signal.status === "authentication_required") void restartReleaseUpdateSignalClient();
        notifyDesktopSystemStatusChanged();
        return { ok: true, status: data.status || "revalidated", trigger };
      }
      if ([401, 403].includes(response.status)) {
        clearDesktopMaterialState();
        await clearConversationHistoryActor();
        conversationHistoryBootstrap = null;
        activeActorProjection = null;
        setActiveActorKey("", { clearDataflowPartition: false });
        notifyDesktopSystemStatusChanged();
      }
      return {
        ok: false,
        status: response.status,
        error: cleanMessage(data.error || `HTTP ${response.status}`),
        trigger,
      };
    } catch (error) {
      return { ok: false, error: cleanMessage(error?.message || "权限对齐失败"), trigger };
    } finally {
      sessionRevalidationPromise = null;
    }
  })();
  return sessionRevalidationPromise;
}

async function logoutDesktopSession() {
  await desktopDeviceTools?.stop();
  localCalendarService?.invalidate();
  feishuCalendarProjection.setContext(null);
  const presence = desktopPresenceClient;
  desktopPresenceClient = null;
  await presence?.stop();
  desktopTaskFollowService.abortAll();
  abortDesktopAssistantRequests();
  desktopSandboxMainDispatch?.cancelAndClear();
  await desktopArtifactDeliveryService?.cleanup();
  let serverRevoked = false;
  try {
    const response = await desktopFetch("/api/auth/logout", { method: "POST" });
    serverRevoked = response.ok;
  } catch {
    // Local logout must still succeed when the management system is unavailable.
  }
  await clearDataflowCredentialSession();
  try {
    if (serverUrl) await session.defaultSession.cookies.remove(serverUrl, "dw.sid");
  } catch {
    // The server response normally clears this cookie; removal is defense in depth.
  }
  clearDesktopMaterialState();
  await clearConversationHistoryActor();
  conversationHistoryBootstrap = null;
  activeActorProjection = null;
  setActiveActorKey("");
  desktopSandboxDeviceSession?.rotate();
  desktopEmployeeToolIds.clear();
  desktopEmployeeMaterialContracts.clear();
  loginWindow?.close();
  notifyDesktopSystemStatusChanged();
  return { ok: true, serverRevoked };
}

function setActiveActorKey(value = "", { clearDataflowPartition = true } = {}) {
  const next = cleanMessage(value).toLowerCase();
  if (activeActorKey && activeActorKey !== next) {
    void confirmationOutbox?.clearActor(activeActorKey).catch(() => {});
    clearDesktopMaterialState();
    void clearConversationHistoryActor(activeActorKey);
  }
  const changed = activeActorKey !== next;
  if (changed) {
    void desktopDeviceTools?.stop();
    localCalendarService?.invalidate();
    feishuCalendarProjection.setContext(null);
    subsystemConnections.clear(); feishuCliConnection.clear(); feishuAuthorization.clear();
  }
  if (changed || (clearDataflowPartition && !next)) disposeDataflowCredentialRuntime({
    clearPartition: clearDataflowPartition && (!next || next !== retiredDataflowSessionCleanup?.actorKey),
  });
  if (changed) desktopTaskFollowService.abortAll();
  if (changed) abortDesktopAssistantRequests();
  if (changed) desktopSandboxMainDispatch?.cancelAndClear();
  if (changed) void desktopArtifactDeliveryService?.cleanup();
  if (changed) stopReleaseUpdateRuntime(next ? "idle" : "authentication_required");
  if (changed) { void desktopPresenceClient?.stop(); desktopPresenceClient = null; }
  activeActorKey = next;
  if (changed) activeActorContextVersion += 1;
  if (!activeActorKey) return;
  if (desktopPresenceClient?.needsAuthentication()) { void desktopPresenceClient.stop(); desktopPresenceClient = null; }
  if (!quitting && !desktopPresenceClient) {
    desktopPresenceClient = createDesktopPresenceClient({request:desktopFetch});
    void desktopPresenceClient.start();
  }
  ensureReleaseUpdateService();
  if (changed) void restartReleaseUpdateSignalClient();
  if (changed) void ensureLocalCalendar().then(() => desktopDeviceTools?.ensure()).catch(() => {});
}

function ensureReleaseUpdateService() {
  if (releaseUpdateService || !activeActorKey) return releaseUpdateService;
  releaseUpdateService = startDesktopReleaseUpdateChecks(releaseUpdateSettings, {
    product: PACKAGED_PRODUCT.productId,
    downloadInstaller: createUnsignedUpdateDownload({
      currentActor: () => ({ key: activeActorKey, version: activeActorContextVersion }),
      directory: path.join(app.getPath("userData"), "desktop-installers"),
      fetchInstaller: (release) => desktopFetch(`${RELEASE_ROUTE_BASE}/versions/${encodeURIComponent(release.version)}/download/${process.platform}-${process.arch}?sha256=${release.artifactSha256}`, { cache: "no-store" }),
      openPath: (filePath) => shell.openPath(filePath),
      platform: process.platform,
    }),
    fetchManifest: () => fetchCenterReleaseManifest(releaseUpdateSettings.channel),
    onStateChange: (state) => setReleaseUpdateState({ update: state }),
    persistence: createDesktopUpdatePreferenceFilePersistence({
      filePath: path.join(app.getPath("userData"), "desktop-update-preferences.v2.json"),
    }),
    trustedDownloadOrigin: serverUrl,
  });
  setReleaseUpdateState({ update: releaseUpdateService.getState() });
  return releaseUpdateService;
}

function stopReleaseUpdateRuntime(signalStatus = "authentication_required") {
  releaseUpdateSignalClient?.stop();
  releaseUpdateSignalClient = null;
  releaseUpdateService?.stop();
  releaseUpdateService = null;
  setReleaseUpdateState({
    signal: { status: signalStatus },
    update: { status: "disabled", currentVersion: app.getVersion() },
  });
}

async function restartReleaseUpdateSignalClient() {
  releaseUpdateSignalClient?.stop();
  releaseUpdateSignalClient = null;
  setReleaseUpdateState({ signal: { status: activeActorKey ? "idle" : "authentication_required" } });
  ensureReleaseUpdateService();
  if (!activeActorKey || !releaseUpdateService?.enabled) {
    setReleaseUpdateState({ signal: { status: activeActorKey ? "disabled" : "authentication_required" } });
    return { status: "disabled" };
  }
  releaseUpdateSignalClient = createDesktopUpdateSignalClient({
    product: PACKAGED_PRODUCT.productId,
    acceptSignal: releaseUpdateService.acceptSignal,
    channel: releaseUpdateChannel,
    onStateChange: (state) => setReleaseUpdateState({ signal: state }),
    policy: releaseUpdateService.policy,
    request: ({ headers, signal }) => desktopFetch(`${RELEASE_ROUTE_BASE}/signals`, { headers, signal }),
  });
  void releaseUpdateSignalClient.start().catch(() => {});
  return { status: releaseUpdateSignalClient.getState().status };
}

function setReleaseUpdateState(patch = {}) {
  releaseUpdateState = {
    update: patch.update ? safeUpdateState(patch.update) : releaseUpdateState.update,
    signal: patch.signal ? safeUpdateSignalState(patch.signal) : releaseUpdateState.signal,
  };
  mainWindow?.webContents.send("desktop:update-state", structuredClone(releaseUpdateState));
}

function safeUpdateState(value = {}) {
  return {
    status: cleanMessage(value.status || "disabled"),
    canDownload: value.canDownload === true,
    currentVersion: cleanMessage(value.currentVersion || app.getVersion()),
    targetVersion: cleanMessage(value.targetVersion),
    mandatory: value.mandatory === true,
    deferUntil: cleanMessage(value.deferUntil),
    downloadBytesPerSecond: boundedSafeNumber(value.downloadBytesPerSecond),
    downloadPercent: boundedSafeNumber(value.downloadPercent, 100),
    downloadTotal: boundedSafeNumber(value.downloadTotal),
    downloadTransferred: boundedSafeNumber(value.downloadTransferred),
    lastCheckedAt: cleanMessage(value.lastCheckedAt),
    lastError: cleanMessage(value.lastError),
    retryAt: cleanMessage(value.retryAt),
    degradedReasons: cleanStringList(value.degradedReasons, 12),
  };
}

function safeUpdateSignalState(value = {}) {
  return {
    status: cleanMessage(value.status || "disabled"),
    connectedAt: cleanMessage(value.connectedAt),
    retryAt: cleanMessage(value.retryAt),
    failureCount: Number.isSafeInteger(value.failureCount) ? value.failureCount : 0,
  };
}

async function loadConversationHistoryForEmployee(employeeId = "") {
  if (!conversationDisplayCache || !activeActorKey || !employeeId) return { ok: false, status: "authentication_required" };
  if (!conversationHistoryBootstrap?.enabled) return { ok: false, status: "history_policy_unavailable" };
  const actorSubjectDigest = activeConversationActorDigest();
  const sessionState = conversationHistoryBootstrap?.sessions?.[employeeId];
  if (!sessionState?.sessionId) return { ok: false, status: "no_active_session" };
  let response;
  try {
    response = await desktopFetch(
      `/api/digital-employees/${encodeURIComponent(employeeId)}/conversations/${encodeURIComponent(sessionState.sessionId)}/display-history`,
      { headers: { Accept: "application/json" } },
    );
  } catch {
    return loadExactOfflineConversationHistory({ actorSubjectDigest, employeeId, sessionId: sessionState.sessionId });
  }
  const data = await response.json().catch(() => ({}));
  if (response.status >= 500) {
    return loadExactOfflineConversationHistory({ actorSubjectDigest, employeeId, sessionId: sessionState.sessionId });
  }
  if (response.status === 404) {
    await clearConversationHistorySession(employeeId, sessionState.sessionId, actorSubjectDigest);
    return { ok: false, status: "center_tombstone" };
  }
  if ([401, 403].includes(response.status)) {
    await clearConversationHistorySession(employeeId, sessionState.sessionId, actorSubjectDigest);
    return { ok: false, status: "center_access_denied" };
  }
  if (!response.ok || data?.ok !== true || !data.history) return { ok: false, status: "center_history_invalid" };
  if (data.history.employeeId !== employeeId || data.history.sessionId !== sessionState.sessionId) {
    return { ok: false, status: "center_history_identity_mismatch" };
  }
  if (data.history.status !== "active") {
    await clearConversationHistorySession(employeeId, sessionState.sessionId, actorSubjectDigest);
    return { ok: false, status: "center_tombstone" };
  }
  const stored = await conversationDisplayCache.storeProjection({ actorSubjectDigest, projection: data.history });
  return stored.status === "stored"
    ? { ok: true, status: "center", projection: stored.projection, cacheStatus: stored.status }
    : { ok: false, status: stored.status };
}

async function loadExactOfflineConversationHistory({ actorSubjectDigest, employeeId, sessionId }) {
  const cached = await conversationDisplayCache.loadProjection({ actorSubjectDigest, employeeId, sessionId });
  if (cached.status !== "ready") return { ok: false, status: cached.status };
  if (cached.projection?.status !== "active") {
    await clearConversationHistorySession(employeeId, sessionId, actorSubjectDigest);
    return { ok: false, status: "center_tombstone" };
  }
  return {
    ok: true,
    status: "encrypted_offline_cache",
    projection: cached.projection,
    expiresAt: cached.expiresAt,
  };
}

async function rememberGroupGoalSession({ goalId, transcriptSessionId } = {}) {
  const safeGoalId = cleanMessage(goalId);
  const safeSessionId = cleanMessage(transcriptSessionId);
  if (!RUN_ID.test(safeGoalId) || !RUN_ID.test(safeSessionId) || !conversationHistoryBootstrap?.enabled) return;
  const actorKey = activeActorKey;
  const actorVersion = activeActorContextVersion;
  const actorSubjectDigest = activeConversationActorDigest();
  const employeeId = "group-orchestrator";
  const bootstrapSnapshot = conversationHistoryBootstrap;
  const previousSessionId = bootstrapSnapshot.groupSessions?.[safeGoalId]?.sessionId;
  if (previousSessionId && previousSessionId !== safeSessionId) {
    await clearConversationHistorySession(employeeId, previousSessionId, actorSubjectDigest);
    if (!isExpectedDesktopActor(actorKey, actorVersion) || conversationHistoryBootstrap !== bootstrapSnapshot) return false;
  }
  if (!isExpectedDesktopActor(actorKey, actorVersion) || conversationHistoryBootstrap !== bootstrapSnapshot) return false;
  const groupSessions = { ...(bootstrapSnapshot.groupSessions || {}) };
  groupSessions[safeGoalId] = {
    employeeId: "group-orchestrator",
    sessionId: safeSessionId,
    sessionExpiresAt: conversationHistoryBootstrap.authExpiresAt,
  };
  conversationHistoryBootstrap = { ...bootstrapSnapshot, groupSessions };
  return true;
}

async function loadGroupGoalDisplayHistory({ goalId, localOnly = false } = {}) {
  const safeGoalId = cleanMessage(goalId);
  if (!RUN_ID.test(safeGoalId)) return { ok: false, status: "invalid_goal" };
  if (!activeActorKey || !conversationHistoryBootstrap?.enabled || !conversationDisplayCache) {
    return { ok: false, status: "history_policy_unavailable" };
  }
  const actorKey = activeActorKey;
  const actorVersion = activeActorContextVersion;
  const actorSubjectDigest = activeConversationActorDigest();
  const employeeId = "group-orchestrator";
  const sessionState = conversationHistoryBootstrap.groupSessions?.[safeGoalId];
  const useOfflineCache = async () => {
    if (!sessionState?.sessionId) return { ok: false, status: "no_active_session" };
    const cached = await loadExactOfflineConversationHistory({ actorSubjectDigest, employeeId, sessionId: sessionState.sessionId });
    if (!cached.ok) return { ok: false, status: cached.status };
    return {
      ok: true,
      goalId: safeGoalId,
      source: "encrypted_offline_cache",
    conversation: conversationFromCachedProjection(cached.projection),
    };
  };
  if (localOnly) {
    const cached = await useOfflineCache();
    if (!isExpectedDesktopActor(actorKey, actorVersion)) return { ok: false, status: "desktop_group_actor_changed" };
    return cached;
  }
  let response;
  try {
    response = await desktopFetch(`/api/group-studio/goals/${encodeURIComponent(safeGoalId)}/display-history`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    if (!isExpectedDesktopActor(actorKey, actorVersion)) return { ok: false, status: "desktop_group_actor_changed" };
    return useOfflineCache();
  }
  const data = await response.json().catch(() => null);
  if (!isExpectedDesktopActor(actorKey, actorVersion)) return { ok: false, status: "desktop_group_actor_changed" };
  if (response.status >= 500) return useOfflineCache();
  if (response.status === 404 || response.status === 401 || response.status === 403) {
    if (sessionState?.sessionId) await clearConversationHistorySession(employeeId, sessionState.sessionId, actorSubjectDigest);
    return { ok: false, status: response.status === 404 ? "center_tombstone" : "center_access_denied" };
  }
  if (!response.ok || data?.ok !== true || data.goalId !== safeGoalId || !isGroupDisplayConversation(data.conversation)) {
    return { ok: false, status: "center_history_invalid" };
  }
  if (data.conversation.sessionStatus !== "active") {
    await clearConversationHistorySession(employeeId, data.conversation.transcriptSessionId, actorSubjectDigest);
    return { ok: false, status: "center_tombstone" };
  }
  const sessionRemembered = await rememberGroupGoalSession({ goalId: safeGoalId, transcriptSessionId: data.conversation.transcriptSessionId });
  if (!sessionRemembered || !isExpectedDesktopActor(actorKey, actorVersion)) return { ok: false, status: "desktop_group_actor_changed" };
  const projection = groupConversationProjection(data.conversation, {
    authExpiresAt: conversationHistoryBootstrap.authExpiresAt,
    centerInstanceId: conversationHistoryBootstrap.policy?.centerInstanceId,
    employeeId,
    policyVersion: conversationHistoryBootstrap.policy?.policyVersion,
    sessionId: data.conversation.transcriptSessionId,
    tenantScope: conversationHistoryBootstrap.policy?.tenantScope,
  });
  const stored = await conversationDisplayCache.storeProjection({ actorSubjectDigest, projection });
  if (!isExpectedDesktopActor(actorKey, actorVersion)) return { ok: false, status: "desktop_group_actor_changed" };
  return {
    ok: true,
    goalId: safeGoalId,
    source: "center",
    conversation: {
      ...data.conversation,
      turns: data.conversation.turns.map((turn) => ({
        revision: turn.revision,
        text: turn.text,
        createdAt: turn.createdAt,
        role: "user",
        ...(turn.answer ? { answer: turn.answer } : {}),
      })),
      planningTurns: data.conversation.turns.filter(turn => turn.revision !== undefined).map((turn) => ({
        revision: turn.revision,
        planningStatus: turn.planningStatus,
        ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
        ...(turn.result ? { result: turn.result } : {}),
        ...(turn.answer ? { answer: turn.answer } : {}),
      })),
    },
  };
}

function conversationFromCachedProjection(projection) {
  return {
    contractVersion: "group-goal-display-history.v1",
    turns: projection.turns.filter(turn => turn.role === "user").map((turn) => ({
      localSequence: turn.seq,
      ...(turn.goalRevision ? { revision: turn.goalRevision } : {}),
      text: turn.text,
      createdAt: turn.createdAt,
      role: turn.role,
      ...(turn.plannerAnswer ? { localAnswer: turn.plannerAnswer } : {}),
    })),
    status: "offline_unverified",
    warning: "已从本机加密缓存恢复对话；规划状态需联网后刷新。",
  };
}

function groupConversationProjection(conversation, identity) {
  const safeTurns = conversation.turns.map((turn, index) => {
    const answer = turn.answer ? groupPlannerAnswerText(turn.answer) : "";
    return { seq: index + 1, role: "user", text: turn.text, createdAt: turn.createdAt,
      goalRevision: turn.revision, ...(answer ? { plannerAnswer: answer } : {}) };
  });
  return {
    contractVersion: "conversation-display-history.v1",
    historySource: "center_projection",
    centerInstanceId: identity.centerInstanceId,
    tenantScope: identity.tenantScope,
    employeeId: identity.employeeId,
    sessionId: identity.sessionId,
    revision: conversation.sessionRevision,
    status: conversation.sessionStatus,
    sessionUpdatedAt: conversation.sessionUpdatedAt,
    turns: safeTurns,
    page: {
      beforeSeq: null,
      nextBeforeSeq: safeTurns[0]?.seq || 0,
      hasMore: conversation.truncated === true,
    },
    policyVersion: identity.policyVersion,
  };
}

function groupPlannerAnswerText(answer) {
  if (!answer || typeof answer.understanding !== "string" || !answer.understanding.trim() ||
    answer.understanding.length > 600 || /[\u0000-\u001f\u007f]/.test(answer.understanding) ||
    !Array.isArray(answer.recommendations) || answer.recommendations.length > 12 ||
    answer.recommendations.some(item => typeof item?.employeeId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(item.employeeId) ||
      typeof item?.assignment !== "string" || !item.assignment.trim() || item.assignment.length > 240 ||
      typeof item?.reason !== "string" || !item.reason.trim() || item.reason.length > 240 ||
      /[\u0000-\u001f\u007f]/.test(item.assignment + item.reason))) return "";
  const lines = [answer.understanding, ...answer.recommendations.map(item =>
    `${item.employeeId}：${item.assignment}；${item.reason}`)];
  return lines.join("\n");
}

function isGroupDisplayConversation(value) {
  return value?.contractVersion === "group-goal-display-history.v1" &&
    typeof value.transcriptSessionId === "string" &&
    Number.isSafeInteger(value.sessionRevision) && value.sessionRevision > 0 &&
    ["active", "ended", "archived"].includes(value.sessionStatus) &&
    Number.isFinite(Date.parse(value.sessionUpdatedAt)) && Array.isArray(value.turns) &&
    value.turns.every(turn => typeof turn?.text === "string" && Number.isSafeInteger(turn.revision) && turn.revision > 0 &&
      Number.isFinite(Date.parse(turn.createdAt)) && (!turn.answer || Boolean(groupPlannerAnswerText(turn.answer))));
}

async function clearGroupGoalDisplayHistory({ goalId } = {}) {
  const sessionState = conversationHistoryBootstrap?.groupSessions?.[String(goalId || "")];
  if (!sessionState?.sessionId) return;
  await clearConversationHistorySession("group-orchestrator", sessionState.sessionId);
}

async function clearConversationHistorySession(employeeId, sessionId, actorSubjectDigest = activeConversationActorDigest()) {
  if (!conversationDisplayCache || !actorSubjectDigest) return;
  const policy = conversationHistoryBootstrap?.policy;
  if (!policy?.centerInstanceId || !policy?.tenantScope || !sessionId) {
    await conversationDisplayCache.clearActorEverywhere({ actorSubjectDigest });
    return;
  }
  await conversationDisplayCache.clearSession({
    actorSubjectDigest,
    centerInstanceId: policy.centerInstanceId,
    tenantScope: policy.tenantScope,
    employeeId,
    sessionId,
  });
}

async function clearConversationHistoryActor(actorKey = activeActorKey) {
  if (!conversationDisplayCache || !actorKey) return;
  await conversationDisplayCache.clearActorEverywhere({
    actorSubjectDigest: crypto.createHash("sha256").update(actorKey).digest("hex"),
  });
}

function activeConversationActorDigest() {
  return activeActorKey ? crypto.createHash("sha256").update(activeActorKey).digest("hex") : "";
}

function clearDesktopMaterialState() {
  localSelections.clear();
  deviceWorkspaceSelections.clear();
  preparedMaterialGrants.clear();
  for (const controller of materialPreparationJobs.values()) controller.abort();
  materialPreparationJobs.clear();
  desktopEmployeeMaterialContracts.clear();
}

function configureDataflowCredentialRuntime(bootstrap = null) {
  let config;
  try {
    config = dataflowCredentialConfigFromBootstrap(bootstrap);
  } catch (error) {
    disposeDataflowCredentialRuntime();
    setDataflowCredentialState("blocked", cleanMessage(error?.code || "dataflow_credential_bootstrap_invalid"));
    return;
  }
  if (!config) { disposeDataflowCredentialRuntime(); return; }
  const partition = dataflowCredentialPartition(config);
  if (retiredDataflowSessionCleanup && retiredDataflowSessionCleanup.broker.partition !== partition) {
    scheduleDataflowSessionCleanup(retiredDataflowSessionCleanup.broker);
    retiredDataflowSessionCleanup = null;
  }
  const pendingCleanup = dataflowSessionCleanups.get(partition);
  if (pendingCleanup) {
    const actor = { key: activeActorKey, version: activeActorContextVersion };
    void pendingCleanup.then(() => {
      if (isExpectedDesktopActor(actor.key, actor.version)) configureDataflowCredentialRuntime(bootstrap);
    });
    return;
  }
  if (dataflowCredentialBroker && dataflowCredentialActorKey === activeActorKey &&
    JSON.stringify(config) === JSON.stringify(dataflowCredentialConfig)) return;
  disposeDataflowCredentialRuntime();
  if (!activeActorKey) {
    setDataflowCredentialState("blocked", "authentication_required");
    return;
  }
  try {
    dataflowCredentialConfig = config;
    dataflowCredentialActorKey = activeActorKey;
    dataflowCredentialBroker = createDataflowDeviceSessionCredentialBroker({
      ...config,
      sessionFromPartition: (partition) => session.fromPartition(partition),
    });
    if (retiredDataflowSessionCleanup?.broker.partition === partition) retiredDataflowSessionCleanup = null;
    dataflowCredentialChallengeClient = createDataflowCredentialChallengeClient({
      broker: dataflowCredentialBroker,
      fetchCenter: desktopFetch,
      transportAllowed: credentialTransportAllowed,
      onStatus: (state) => setDataflowCredentialState(state.status, state.code, state.expiresAt),
    });
    setDataflowCredentialState("refresh_required", "dataflow_interactive_login_may_be_required");
    dataflowCredentialBootstrapController = new AbortController();
    const bootstrapController = dataflowCredentialBootstrapController;
    const bootstrapBroker = dataflowCredentialBroker;
    let bootstrapTimedOut = false;
    const bootstrapTimer = setTimeout(() => {
      bootstrapTimedOut = true;
      bootstrapController.abort();
    }, 10_000);
    bootstrapTimer.unref?.();
    void bootstrapBroker.refreshAccessToken({ signal: bootstrapController.signal }).then((lease) => {
      if (bootstrapBroker !== dataflowCredentialBroker) return;
      setDataflowCredentialState("ready", "dataflow_browser_session_ready", lease.expiresAt);
    }).catch((error) => {
      if (bootstrapBroker !== dataflowCredentialBroker) return;
      if (error?.code === "dataflow_credential_request_canceled") {
        if (bootstrapTimedOut) setDataflowCredentialState("degraded", "dataflow_session_refresh_timed_out");
        return;
      }
      if (error?.code === "dataflow_interactive_login_required") {
        setDataflowCredentialState("refresh_required", error.code);
        return;
      }
      setDataflowCredentialState("blocked", cleanMessage(error?.code || "dataflow_session_refresh_failed"));
    }).finally(() => {
      clearTimeout(bootstrapTimer);
      if (dataflowCredentialBootstrapController === bootstrapController) dataflowCredentialBootstrapController = null;
      if ((bootstrapController.signal.aborted && !bootstrapTimedOut) || bootstrapBroker !== dataflowCredentialBroker) return;
      void dataflowCredentialChallengeClient?.start().catch(() => {
        setDataflowCredentialState("degraded", "dataflow_credential_challenge_unavailable");
      });
    });
  } catch (error) {
    disposeDataflowCredentialRuntime();
    setDataflowCredentialState("blocked", cleanMessage(error?.code || "dataflow_credential_configuration_invalid"));
  }
}

function disposeDataflowCredentialRuntime({ clearPartition = false } = {}) {
  dataflowCredentialBootstrapController?.abort();
  dataflowCredentialBootstrapController = null;
  dataflowCredentialChallengeClient?.stop();
  dataflowCredentialChallengeClient = null;
  const broker = dataflowCredentialBroker || (clearPartition ? retiredDataflowSessionCleanup?.broker : null);
  const brokerActorKey = dataflowCredentialActorKey || retiredDataflowSessionCleanup?.actorKey;
  const partitionAlreadyCleared = ["dataflow_logged_out", "dataflow_local_session_cleared"].includes(dataflowCredentialState.code);
  dataflowCredentialBroker = null;
  dataflowCredentialConfig = null;
  dataflowCredentialActorKey = "";
  closeDataflowLoginWindow();
  dataflowCredentialState = { status: "not_configured", code: "dataflow_credential_not_configured" };
  if (!broker) return;
  if (!clearPartition || partitionAlreadyCleared) {
    broker.dispose();
    if (!clearPartition) retiredDataflowSessionCleanup = { actorKey: brokerActorKey, broker };
    return;
  }
  retiredDataflowSessionCleanup = null;
  scheduleDataflowSessionCleanup(broker);
}

function scheduleDataflowSessionCleanup(broker) {
  if (dataflowSessionCleanups.has(broker.partition)) return dataflowSessionCleanups.get(broker.partition);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  const cleanup = broker.logout({ signal: controller.signal }).catch(() => broker.clearAccessToken()).finally(() => {
    clearTimeout(timer);
    broker.dispose();
    if (dataflowSessionCleanups.get(broker.partition) === cleanup) dataflowSessionCleanups.delete(broker.partition);
  });
  dataflowSessionCleanups.set(broker.partition, cleanup);
  return cleanup;
}

async function clearDataflowCredentialSession() {
  dataflowCredentialBootstrapController?.abort();
  dataflowCredentialBootstrapController = null;
  dataflowCredentialChallengeClient?.stop();
  closeDataflowLoginWindow();
  const broker = dataflowCredentialBroker;
  const actor = { key: activeActorKey, version: activeActorContextVersion };
  if (!broker) return safeDataflowCredentialStatus();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const result = await broker.logout({ signal: controller.signal });
    if (broker !== dataflowCredentialBroker || !isExpectedDesktopActor(actor.key, actor.version)) return safeDataflowCredentialStatus();
    setDataflowCredentialState("refresh_required", result.remoteLogoutConfirmed ? "dataflow_logged_out" : "dataflow_local_session_cleared");
  } catch {
    if (broker !== dataflowCredentialBroker || !isExpectedDesktopActor(actor.key, actor.version)) return safeDataflowCredentialStatus();
    broker.clearAccessToken();
    setDataflowCredentialState("blocked", "dataflow_session_clear_failed");
  } finally {
    clearTimeout(timer);
  }
  return safeDataflowCredentialStatus();
}

function openDataflowCredentialLoginWindow() {
  if (!dataflowCredentialBroker || !dataflowCredentialConfig || dataflowCredentialActorKey !== activeActorKey) {
    return { opened: false, ...safeDataflowCredentialStatus() };
  }
  if (!credentialTransportAllowed()) {
    setDataflowCredentialState("blocked", "center_credential_transport_insecure");
    return { opened: false, ...safeDataflowCredentialStatus() };
  }
  if (dataflowLoginWindow && !dataflowLoginWindow.isDestroyed()) {
    dataflowLoginWindow.focus();
    return { opened: true, ...safeDataflowCredentialStatus() };
  }
  dataflowCredentialChallengeClient?.stop();
  const broker = dataflowCredentialBroker;
  dataflowLoginController = new AbortController();
  dataflowLoginWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    parent: mainWindow,
    modal: false,
    show: true,
    title: "连接 DataFlow",
    webPreferences: {
      partition: broker.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  secureDataflowLoginWebContents(dataflowLoginWindow.webContents, broker);
  let probePromise = null;
  const probe = () => {
    if (probePromise || dataflowLoginController?.signal.aborted) return probePromise;
    probePromise = broker.refreshAccessToken({ signal: dataflowLoginController.signal }).then((lease) => {
      if (broker !== dataflowCredentialBroker) return;
      broker.markInteractiveLoginVerified();
      setDataflowCredentialState("ready", "dataflow_browser_session_ready", lease.expiresAt);
      if (!dataflowCredentialChallengeClient) return;
      void dataflowCredentialChallengeClient.start();
      dataflowLoginWindow?.close();
    }).catch((error) => {
      if (broker !== dataflowCredentialBroker) return;
      if (["dataflow_interactive_login_required", "dataflow_credential_request_canceled"].includes(error?.code)) return;
      setDataflowCredentialState("blocked", cleanMessage(error?.code || "dataflow_login_verification_failed"));
    }).finally(() => { probePromise = null; });
    return probePromise;
  };
  dataflowLoginWindow.webContents.on("did-navigate", () => { void probe(); });
  dataflowLoginWindow.webContents.on("did-redirect-navigation", () => { void probe(); });
  dataflowLoginStatusTimer = setInterval(() => { void probe(); }, 1_200);
  dataflowLoginWindow.on("closed", () => {
    if (dataflowLoginStatusTimer) clearInterval(dataflowLoginStatusTimer);
    dataflowLoginStatusTimer = null;
    dataflowLoginController?.abort();
    dataflowLoginController = null;
    dataflowLoginWindow = null;
    notifyDataflowCredentialState();
  });
  dataflowLoginWindow.loadURL(dataflowCredentialConfig.loginUrl).catch(() => {
    setDataflowCredentialState("blocked", "dataflow_login_page_unavailable");
    dataflowLoginWindow?.close();
  });
  return { opened: true, ...safeDataflowCredentialStatus() };
}

function closeDataflowLoginWindow() {
  if (dataflowLoginStatusTimer) clearInterval(dataflowLoginStatusTimer);
  dataflowLoginStatusTimer = null;
  dataflowLoginController?.abort();
  dataflowLoginController = null;
  dataflowLoginWindow?.close();
  dataflowLoginWindow = null;
}

function secureDataflowLoginWebContents(webContents, broker) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (broker.isAllowedLoginNavigation(url)) webContents.loadURL(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (!broker.isAllowedLoginNavigation(url)) event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function setDataflowCredentialState(status, code, expiresAt = "") {
  dataflowCredentialState = {
    status: cleanMessage(status).slice(0, 80),
    code: cleanMessage(code).slice(0, 120),
    expiresAt: cleanMessage(expiresAt).slice(0, 40),
  };
  notifyDataflowCredentialState();
}

function notifyDataflowCredentialState() {
  notifySubsystemConnectionsChanged();
  if (!mainWindow?.webContents?.isDestroyed()) {
    mainWindow.webContents.send("desktop:dataflow-credential-status-changed", safeDataflowCredentialStatus());
  }
}

function safeDataflowCredentialStatus() {
  return projectDataflowCredentialStatus({
    brokerStatus: dataflowCredentialBroker?.status() || {},
    runtimeState: dataflowCredentialState,
    configured: Boolean(dataflowCredentialBroker && dataflowCredentialActorKey === activeActorKey),
    transportReady: credentialTransportAllowed(),
  });
}

async function checkDataflowCredentialSession({ signal } = {}) {
  const broker = dataflowCredentialBroker;
  const actor = { key: activeActorKey, version: activeActorContextVersion };
  if (!broker || dataflowCredentialActorKey !== actor.key || !credentialTransportAllowed()) return;
  setDataflowCredentialState("checking", "dataflow_session_checking");
  try {
    const lease = await broker.refreshAccessToken({ signal });
    if (broker !== dataflowCredentialBroker || !isExpectedDesktopActor(actor.key, actor.version)) return;
    setDataflowCredentialState("ready", "dataflow_browser_session_ready", lease.expiresAt);
    void dataflowCredentialChallengeClient?.start();
  } catch (error) {
    if (broker !== dataflowCredentialBroker || !isExpectedDesktopActor(actor.key, actor.version)) return;
    const code = cleanMessage(error?.code || "dataflow_session_check_failed");
    setDataflowCredentialState(code === "dataflow_interactive_login_required" ? "refresh_required" : "degraded", code);
  }
}

function notifySubsystemConnectionsChanged() {
  if (groupReadAssociationGeneration !== feishuCliConnection.associationGeneration()) feishuCalendarProjection.setContext(null);
  void ensureLocalCalendar().then(service => {
    if (groupReadAssociationGeneration !== feishuCliConnection.associationGeneration()) {
      void desktopDeviceTools?.stop().then(() => desktopDeviceTools?.ensure()).catch(() => {});
      service?.invalidate(); groupReadAssociationGeneration = feishuCliConnection.associationGeneration();
    }
  }).catch(() => {});
  if (!mainWindow?.webContents?.isDestroyed()) mainWindow.webContents.send("desktop:subsystem-connections-changed");
}

async function ensureLocalCalendar() {
  if (!GROUP_STUDIO || quitting) return null;
  if (localCalendarService) return localCalendarService;
  if (localCalendarLoading) return localCalendarLoading;
  localCalendarLoading = (async () => {
    const { createLocalReadTaskHost, digitalEmployees } = await import("./local-calendar-runtime.bundle.mjs");
    if (quitting) return null;
    const adapters = createManagedFeishuReadAdapters({ resourcesPath: process.resourcesPath, connection: feishuCliConnection });
    const adapter = adapters[0] || null;
    const service = createLocalCalendarService({
      databasePath: path.join(app.getPath("userData"), "local-calendar-rules.v1.sqlite"),
      createHost: createLocalReadTaskHost, employee: digitalEmployees.find(item => item.id === "personal-work-assistant"),
      adapter, connection: feishuCliConnection, context: calendarProjectionContext, projection: feishuCalendarProjection,
      notify: () => { if (!mainWindow?.webContents?.isDestroyed()) mainWindow.webContents.send("desktop:calendar-changed"); },
    });
    localCalendarService = service;
    if (adapter && !desktopDeviceTools) desktopDeviceTools = createDesktopDeviceTools({
      context: calendarProjectionContext,
      available: async () => {
        if (quitting || !activeActorKey || !isManagedHttpsCenterOrigin(serverUrl)) return false;
        // Restore an existing association and refresh its short-lived identity
        // proof before deciding whether this Device can expose its Tool.
        await feishuCliConnection.check();
        return (await feishuCliConnection.status()).state === "authenticated";
      },
      createAdapters: () => adapters, request: desktopFetch,
      onDiagnostic: recordDeviceReadDiagnostic,
      onCompleted: (context, value) => { feishuCalendarProjection.setContext(context); feishuCalendarProjection.accept(context, value); },
      onFailed: (context, claim) => { feishuCalendarProjection.setContext(context); feishuCalendarProjection.failed(context, claim); },
    });
    service.start(); return service;
  })().finally(() => { localCalendarLoading = null; });
  return localCalendarLoading;
}

// Bounded local operational evidence only: no identity, arguments, results,
// vendor messages or task references enter this file.
function recordDeviceReadDiagnostic({ stage, code = "" } = {}) {
  const stages = ["execution_started", "authority", "pre_identity", "helper", "post_identity", "identity_completed",
    "execution_failed", "execution_finished", "result_started", "result_finished", "transport_failed"];
  const codes = ["", "allowed", "blocked", "transport_failed", "completed", "failed", "canceled",
    "device_read_canceled", "device_read_failed", "device_read_authority_unavailable", "device_read_authority_changed",
    "device_read_claim_expired", "feishu_read_identity_unavailable", "feishu_read_unavailable", "feishu_read_helper_integrity_invalid"];
  if (!stages.includes(stage) || !codes.includes(code)) return;
  deviceReadDiagnostics.push({ at: new Date().toISOString(), stage, code });
  if (deviceReadDiagnostics.length > 32) deviceReadDiagnostics.shift();
  const snapshot = JSON.stringify({ schemaVersion: 1, events: deviceReadDiagnostics });
  deviceDiagnosticWrite = deviceDiagnosticWrite.then(() => writeFile(path.join(app.getPath("userData"), "device-read-diagnostics.v1.json"), snapshot, { mode: 0o600 })).catch(() => {});
}

async function restoreCalendarDisplay() {
  const before = calendarProjectionContext();
  const binding = await feishuCliConnection.cacheBinding();
  if (before.actorKey !== activeActorKey || before.actorVersion !== activeActorContextVersion || before.center !== serverUrl) return;
  if (!binding) {
    if (before.associationGeneration === feishuCliConnection.associationGeneration()) feishuCalendarProjection.setContext(null);
    return;
  }
  if (binding.generation !== feishuCliConnection.associationGeneration()) return;
  const current = calendarProjectionContext();
  feishuCalendarProjection.setContext(current);
  const saved = feishuCalendarCache.read({...current,...binding});
  if (saved) feishuCalendarProjection.restore(current,saved);
}

function calendarProjectionContext() {
  return { actorKey: activeActorKey, actorVersion: activeActorContextVersion, center: serverUrl,
    associationGeneration: feishuCliConnection.associationGeneration() };
}

function desktopToolIsAvailable(toolId = "") {
  return [...desktopEmployeeToolIds.values()].some((toolIds) => toolIds.has(toolId));
}

async function toolCredentialsForEmployee(employeeId = "") {
  if (!credentialTransportAllowed()) return [];
  const toolIds = desktopEmployeeToolIds.get(cleanEmployeeId(employeeId)) || new Set();
  const credentials = [];
  for (const toolId of toolIds) {
    const authorization = await temporaryToolCredentials.authorizationFor({ actorKey: activeActorKey, toolId });
    if (authorization) credentials.push({ toolId, authorization });
  }
  return credentials;
}

function normalizeToolConfirmationInput(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 120);
  return value.contractVersion === "tool-call-confirmation.v1" && value.decision === "approved" && id
    ? { contractVersion: "tool-call-confirmation.v1", id, decision: "approved" }
    : null;
}

function normalizeToolParameterCardInput(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    value.contractVersion !== "tool-parameter-card-submission.v2") return null;
  const cardId = String(value.cardId || "").replace(/[^a-zA-Z0-9_.:/-]/g, "").slice(0, 240);
  const schemaDigest = String(value.schemaDigest || "").trim();
  if (!cardId || !/^sha256:[a-f0-9]{64}$/.test(schemaDigest) || !plainSafeParameterObject(value.arguments)) return null;
  return {
    contractVersion: "tool-parameter-card-submission.v2",
    cardId,
    schemaDigest,
    arguments: structuredClone(value.arguments),
  };
}

function plainSafeParameterObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return false;
  return Object.entries(value).every(([key, item]) => {
    if (/authorization|bearer|token|secret|password|cookie|api[-_]?key|credential/i.test(key)) return false;
    if (item === null || ["string", "boolean"].includes(typeof item)) return true;
    if (typeof item === "number") return Number.isFinite(item);
    return plainSafeParameterObject(item, depth + 1);
  });
}

async function storeToolCredential(toolId = "", credentialText = "") {
  const safeToolId = cleanEmployeeId(toolId);
  if (!activeActorKey) return credentialStatusForRenderer({ ok: false, toolId: safeToolId, status: "authentication_required", available: false });
  if (!desktopToolIsAvailable(safeToolId)) return credentialStatusForRenderer({ ok: false, toolId: safeToolId, status: "tool_not_available", available: false });
  return credentialStatusForRenderer(await temporaryToolCredentials.storeBearer({
    actorKey: activeActorKey,
    clipboardText: credentialText,
    toolId: safeToolId,
  }));
}

function credentialStatusForRenderer(status = {}) {
  const secureTransport = isSecureCredentialTransport(serverUrl);
  const transportReady = credentialTransportAllowed();
  return {
    ...status,
    transportReady,
    usable: status.available === true && transportReady,
    transportStatus: secureTransport
      ? "secure"
      : transportReady
        ? "mvp_private_lan_http"
        : "center_transport_insecure",
  };
}

function credentialTransportAllowed() {
  return isSecureCredentialTransport(serverUrl, {
    allowPrivateLanHttp: allowMvpPrivateLanCredentialTransport,
  });
}

function safeStorageEncryption() {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(String(value || "")).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(String(value || ""), "base64")),
  };
}

function credentialEventsFromSse(body = "") {
  return currentUserAuthorizationEventsFromSse(body);
}

function conversationSessionFromSse(body = "") {
  const blocks = String(body || "").replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks.reverse()) {
    const lines = block.split("\n");
    if (!lines.some((line) => line.trim() === "event: done")) continue;
    const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    try {
      const session = JSON.parse(dataText)?.conversationSession;
      const sessionId = cleanMessage(session?.sessionId || "").slice(0, 240);
      if (sessionId) return { sessionId };
    } catch {
      // Ignore malformed completion metadata; the center remains authoritative.
    }
  }
  return null;
}

async function prepareSelection(filePaths) {
  const safePaths = [...new Set(filePaths.map((item) => String(item || "")).filter(Boolean))].slice(0, 24);
  const candidates = [];
  const unreadable = [];

  for (const filePath of safePaths) {
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile()) {
      unreadable.push({ file: { name: path.basename(filePath) }, reason: "unreadable" });
      continue;
    }
    candidates.push({
      filePath,
      inode: metadata.ino,
      modifiedAtMs: metadata.mtimeMs,
      name: path.basename(filePath),
      size: metadata.size,
      type: attachmentMimeTypeForName(filePath),
      kind: attachmentDescriptorForName(filePath).kind,
    });
  }

  const { accepted, rejected } = normalizeLocalAttachments(candidates);
  const files = [];
  const authorizedFiles = [];

  for (const file of accepted) {
    const previewDataUrl = file.kind === "image" && file.size <= DESKTOP_ATTACHMENT_LIMITS.maxPreviewBytes
      ? `data:${file.type};base64,${(await readFile(file.filePath)).toString("base64")}`
      : "";
    const fileId = crypto.randomUUID();
    authorizedFiles.push({ ...file, id: fileId });
    files.push({
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      kind: file.kind,
      previewDataUrl,
      previewAvailable: Boolean(previewDataUrl),
    });
  }

  const selectionId = crypto.randomUUID();
  localSelections.set(selectionId, { files: authorizedFiles, createdAt: Date.now() });
  pruneSelections();
  return {
    canceled: false,
    selectionId,
    files,
    rejected: [...unreadable, ...rejected].map(({ file, reason }) => ({ name: file?.name || "未知文件", reason })),
    limits: DESKTOP_ATTACHMENT_LIMITS,
    authorization: "current_selection_only",
  };
}

function pruneSelections() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, item] of localSelections) {
    if (item.createdAt < cutoff) localSelections.delete(id);
  }
  while (localSelections.size > 20) localSelections.delete(localSelections.keys().next().value);
  const now = Date.now();
  for (const [id, grant] of preparedMaterialGrants) {
    if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) preparedMaterialGrants.delete(id);
  }
  for (const [id, selection] of deviceWorkspaceSelections) {
    if (!Number.isFinite(selection.expiresAt) || selection.expiresAt <= now) deviceWorkspaceSelections.delete(id);
  }
  while (deviceWorkspaceSelections.size > 20) deviceWorkspaceSelections.delete(deviceWorkspaceSelections.keys().next().value);
}

function resolveAuthorizedMaterialFiles(requestedFiles = []) {
  pruneSelections();
  const resolved = [];
  const seen = new Set();
  for (const requested of Array.isArray(requestedFiles) ? requestedFiles.slice(0, DESKTOP_ATTACHMENT_LIMITS.maxFiles) : []) {
    const selectionId = cleanMessage(requested?.selectionId || "").slice(0, 120);
    const fileId = cleanMessage(requested?.fileId || "").slice(0, 120);
    const file = localSelections.get(selectionId)?.files?.find((item) => item.id === fileId);
    if (!file || seen.has(file.id)) continue;
    seen.add(file.id);
    resolved.push(file);
  }
  return resolved;
}

async function prepareDesktopMaterialSelection({ files = [], employeeId = "", materialInputContracts = [], signal, onProgress = () => {} } = {}) {
  const prepared = await prepareDesktopMaterialManifest({
    files,
    targetEmployeeId: employeeId,
    signal,
    onProgress,
  });
  const bridge = await prepareDesktopMaterialBridge({ files, materialInputContracts, signal });
  await assertAuthorizedMaterialFilesUnchanged(files);
  return { prepared, bridge };
}

function isManagedHttpsCenterOrigin(value = "") {
  try {
    const origin = new URL(String(value || ""));
    return origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash;
  } catch {
    return false;
  }
}

// Called only by the Electron-main dispatch composition after a later
// canonical task binder supplies task/input digests. It is not an IPC handler.
function resolveDesktopSandboxAuthorizedSelection({ selectionId = "" } = {}) {
  pruneSelections();
  if (!activeActorKey) return null;
  const safeSelectionId = cleanMessage(selectionId).slice(0, 120);
  const deviceSelection = deviceWorkspaceSelections.get(safeSelectionId);
  if (deviceSelection?.actorKey === activeActorKey && Array.isArray(deviceSelection.files)) {
    return deviceSelection.files.map((file) => ({
      fileName: file.name,
      filePath: file.filePath,
      inode: file.inode,
      modifiedAtMs: file.modifiedAtMs,
      sizeBytes: file.size,
    }));
  }
  if (deviceSelection) return null;
  const selection = localSelections.get(safeSelectionId);
  if (!selection?.files?.length) return null;
  return selection.files.map((file) => ({
    fileName: file.name,
    filePath: file.filePath,
    inode: file.inode,
    modifiedAtMs: file.modifiedAtMs,
    sizeBytes: file.size,
  }));
}

function preparedMaterialGrant(grantId = "", employeeId = "") {
  pruneSelections();
  const cleanGrantId = cleanMessage(grantId || "").slice(0, 120);
  if (!cleanGrantId) return null;
  const grant = preparedMaterialGrants.get(cleanGrantId);
  if (!grant) throw new Error("desktop_material_grant_expired");
  if (grant.authorizedEmployeeId !== cleanEmployeeId(employeeId)) throw new Error("desktop_material_employee_mismatch");
  if (!activeActorKey || grant.actorKey !== activeActorKey) throw new Error("desktop_material_actor_mismatch");
  if (grant.inFlight) throw new Error("desktop_material_grant_in_use");
  grant.inFlight = true;
  return grant;
}

async function assertAuthorizedMaterialFilesUnchanged(files = []) {
  for (const file of files) {
    const metadata = await stat(file.filePath).catch(() => null);
    if (
      !metadata?.isFile() ||
      metadata.size !== file.size ||
      metadata.mtimeMs !== file.modifiedAtMs ||
      metadata.ino !== file.inode
    ) throw new Error("desktop_material_file_changed");
  }
}

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  const allowedOrigin = new URL(serverUrl).origin;
  const loginUrl = new URL("/", `${serverUrl}/`);
  loginUrl.searchParams.set("redirect", "/?desktopChannel=1");
  loginWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    parent: mainWindow,
    modal: false,
    show: false,
    title: "连接数字员工管理系统",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  secureWebContents(loginWindow.webContents, [allowedOrigin, ...FORTRESS_LOGIN_ALLOWED_ORIGINS]);
  loginWindow.once("ready-to-show", () => loginWindow?.show());
  const completeLoginIfAuthenticated = async () => {
    try {
      const response = await desktopFetch("/api/me");
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || !data.session) return false;
      notifyDesktopSystemStatusChanged();
      mainWindow?.show();
      mainWindow?.focus();
      loginWindow?.close();
      return true;
    } catch {
      return false;
    }
  };
  const checkLoginCompletion = async (_event, destination) => {
    try {
      const url = new URL(destination);
      if (url.origin !== allowedOrigin || url.searchParams.get("desktopChannel") !== "1") return;
      await completeLoginIfAuthenticated();
    } catch {
      // The login window remains open so the user can see the server-side error.
    }
  };
  loginWindow.webContents.on("did-navigate", checkLoginCompletion);
  loginWindow.webContents.on("did-redirect-navigation", checkLoginCompletion);
  loginStatusTimer = setInterval(() => {
    void completeLoginIfAuthenticated();
  }, 1200);
  loginWindow.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    mainWindow?.webContents.send("desktop:login-error", {
      message: "企业认证页加载失败，请检查管理系统或公司网络后重试",
    });
    loginWindow?.close();
  });
  loginWindow.on("closed", () => {
    if (loginStatusTimer) clearInterval(loginStatusTimer);
    loginStatusTimer = null;
    loginWindow = null;
    notifyDesktopSystemStatusChanged();
  });
  loginWindow.loadURL(loginUrl.toString()).catch(() => {
    if (!loginWindow || loginWindow.isDestroyed()) return;
    mainWindow?.webContents.send("desktop:login-error", {
      message: "无法连接企业认证入口，请检查管理系统或公司网络后重试",
    });
    loginWindow.close();
  });
}

function secureWebContents(webContents, allowedDestinations) {
  const destinations = Array.isArray(allowedDestinations) ? allowedDestinations : [allowedDestinations];
  const allowedOrigins = new Set(destinations.flatMap((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? [url.origin] : [];
    } catch {
      return [];
    }
  }));
  webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external && allowedOrigins.has(new URL(external).origin)) {
      webContents.loadURL(external);
    } else if (external) {
      shell.openExternal(external);
    }
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    const destination = cleanHttpUrl(url);
    const isFile = url.startsWith("file://") && !DEV_URL;
    const sameOrigin = destination && allowedOrigins.has(new URL(destination).origin);
    if (!isFile && !sameOrigin) event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function installPermissionBoundary() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function desktopFetch(pathname, options = {}) {
  if (!serverUrl) throw new Error("desktop_server_url_missing");
  return fetchWithLocalEndpointRecovery({
    endpoint: { url: serverUrl, source: serverUrlSource },
    request: (baseUrl) => {
      const target = new URL(pathname, `${baseUrl}/`);
      return net.fetch(target.toString(), {
        ...options,
        credentials: "include",
        headers: desktopSandboxDeviceSession
          ? desktopSandboxDeviceSession.headers(options.headers)
          : options.headers,
      });
    },
    rediscover: discoverLocalServerEndpoint,
    onRecovered: (endpoint) => {
      serverUrl = endpoint.url;
      serverUrlSource = endpoint.source;
      serverConfigurationError = "";
      allowMvpPrivateLanCredentialTransport = false;
      resetManagedCenterCertificateTrust(endpoint);
      notifyDesktopSystemStatusChanged();
    },
  });
}

async function fetchCenterReleaseManifest(channel) {
  const safeChannel = releaseChannel(channel);
  if (!safeChannel) throw new Error("desktop_update_channel_invalid");
  const response = await desktopFetch(`${RELEASE_ROUTE_BASE}/latest`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true || data?.contractVersion !== "desktop-release-catalog.v1") {
    throw new Error("desktop_release_catalog_unavailable");
  }
  const release = data.release || {};
  if (release.product !== undefined && release.product !== PACKAGED_PRODUCT.productId
    || (PACKAGED_PRODUCT === products.GROUP_STUDIO_PRODUCT && release.product !== PACKAGED_PRODUCT.productId)) {
    throw new Error("desktop_release_product_mismatch");
  }
  const platformId = `${process.platform}-${process.arch}`;
  const platformRelease = release.platforms?.[platformId] || {};
  const autoUpdate = platformRelease.autoUpdate || {};
  return {
    schemaVersion: 1,
    product: PACKAGED_PRODUCT.productId,
    channel: release.channel,
    version: release.version,
    publishedAt: release.publishedAt,
    releaseNotes: release.releaseNotes,
    mandatory: release.mandatory === true,
    downloadPageUrl: release.source === "local_beta" ? serverUrl : release.downloadPageUrl,
    artifacts: {
      [platformId]: {
        signed: autoUpdate.available === true && autoUpdate.signed === true,
        updateFeedUrl: cleanMessage(autoUpdate.feedUrl),
        sha256: platformRelease.sha256,
        size: platformRelease.size,
      },
    },
  };
}

async function resolveServerEndpoint() {
  if (ENV_SERVER_URL) {
    const url = managedServerUrl(ENV_SERVER_URL);
    return url
      ? { url, source: "environment" }
      : { url: "", source: "environment", error: "环境变量中的管理系统地址无效或不安全" };
  }

  const managedEndpoint = await readManagedServerEndpoint();
  if (managedEndpoint) return managedEndpoint;

  return (await discoverLocalServerEndpoint()) || { url: DEFAULT_SERVER_URL, source: "fallback" };
}

async function discoverLocalServerEndpoint() {
  const candidates = [DEFAULT_SERVER_URL];
  for (const candidate of [...new Set(candidates)]) {
    if (await serverHealthCheck(candidate)) return { url: candidate, source: "local_discovery" };
  }
  return null;
}

async function readManagedServerEndpoint() {
  for (const configPath of managedConfigPaths()) {
    let rawConfig;
    try {
      rawConfig = await readFile(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { url: "", source: "managed_config", error: "无法读取桌面通道的企业配置" };
    }
    let config;
    try {
      config = JSON.parse(rawConfig);
    } catch {
      return { url: "", source: "managed_config", error: "桌面通道的企业配置格式无效" };
    }
    const rawUrl = String(config?.managementServerUrl || "").trim();
    if (!rawUrl) continue;
    const url = managedServerUrl(rawUrl);
    if (!url) {
      return { url: "", source: "managed_config", error: "企业配置中的管理系统地址无效或不安全" };
    }
    const certificateSha256Fingerprints = normalizeManagedCenterCertificatePins(
      config?.centerCertificateSha256Fingerprints,
      { origin: url },
    );
    if (certificateSha256Fingerprints === null) {
      return { url: "", source: "managed_config", error: "企业配置中的 Center 证书指纹格式错误" };
    }
    return {
      url,
      source: "managed_config",
      certificateSha256Fingerprints,
      allowMvpPrivateLanCredentialTransport:
        config?.allowInsecureMvpToolCredentialTransport === true
        && new URL(url).protocol === "http:"
        && isPrivateHttpHostname(new URL(url).hostname),
    };
  }
  return null;
}

async function readManagedUpdateSettings() {
  for (const configPath of managedConfigPaths()) {
    let rawConfig;
    try {
      rawConfig = await readFile(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { channel: "", policy: null };
    }
    try {
      const config = JSON.parse(rawConfig);
      return {
        channel: releaseChannel(config?.updateChannel),
        policy: config?.desktopUpdatePolicy || null,
      };
    } catch {
      return { channel: "", policy: null };
    }
  }
  return { channel: "", policy: null };
}

async function readPackagedConversationHistorySafetyCeiling() {
  const configPath = path.join(
    app.isPackaged ? process.resourcesPath : APP_ROOT,
    "desktop-channel.config.json",
  );
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config?.conversationHistorySafetyCeiling) return config.conversationHistorySafetyCeiling;
  } catch {
    // Missing or invalid safety ceiling keeps offline history cache disabled.
  }
  return null;
}

function parseJsonObject(value = "") {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function managedConfigPaths() {
  return [path.join(app.isPackaged ? process.resourcesPath : APP_ROOT, "desktop-channel.config.json")];
}

function isPackagedNonProductionTestConfig(feature = null) {
  if (!app.isPackaged) return false;
  try {
    const config = JSON.parse(readFileSync(path.join(process.resourcesPath, "desktop-channel.config.json"), "utf8"));
    return config?.sandboxAcceptanceEnvironment === "non_production_test" && (!feature || config[feature] === true);
  } catch {
    return false;
  }
}

function localIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter(Boolean);
}

async function serverHealthCheck(candidate) {
  return typeof serverIsHealthy === "function" ? serverIsHealthy(candidate) : false;
}

function managedServerUrl(value) {
  return localCenterUrl(value);
}

function resetManagedCenterCertificateTrust(endpoint = {}) {
  removeManagedCenterCertificateTrust();
  removeManagedCenterCertificateTrust = () => {};
  const pins = endpoint?.certificateSha256Fingerprints;
  if (!Array.isArray(pins) || !pins.length) return;
  removeManagedCenterCertificateTrust = installManagedCenterCertificateTrust({
    browserSession: session.defaultSession,
    certificateSha256Fingerprints: pins,
    origin: endpoint.url,
  });
}

function isPrivateHttpHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".localhost")) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function serverConnectionErrorMessage() {
  if (serverConfigurationError) return serverConfigurationError;
  if (["environment", "managed_config"].includes(serverUrlSource)) {
    return "无法连接企业配置的数字员工管理系统，请联系管理员检查中心地址或公司网络";
  }
  return "未发现本机可用的数字员工管理系统；正式安装包需要由管理员配置企业中心地址";
}

function showExpandedWindow() {
  mainWindow?.show();
  setExpanded(true);
  mainWindow?.focus();
}

function setExpanded(nextExpanded) {
  const willExpand = Boolean(nextExpanded);
  if (expanded && willExpand && mainWindow?.isMaximized?.()) return;
  if (expanded && !willExpand) {
    if (mainWindow?.isMaximized?.()) mainWindow.unmaximize();
    else rememberExpandedWindowSize();
  }
  expanded = willExpand;
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(windowAlwaysOnTopForState({ isExpanded: expanded }));
  const shouldRestoreVisiblePet = !expanded && mainWindow.isVisible();
  if (shouldRestoreVisiblePet) mainWindow.hide();
  if (expanded) {
    applyWindowResizePolicy(true);
    anchorWindow(true);
  } else {
    applyWindowResizePolicy(false);
    anchorWindow(false);
  }
  mainWindow.webContents.send("desktop:window-state", { expanded });
  if (shouldRestoreVisiblePet) {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.invalidate();
      mainWindow.showInactive();
    }, 60);
  } else {
    mainWindow.webContents.invalidate();
  }
}

function applyWindowResizePolicy(isExpanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const policy = windowResizePolicyForState({
    collapsedSize: COLLAPSED_SIZE,
    expandedMinSize: EXPANDED_MIN_SIZE,
    isExpanded,
    workArea: display.workArea,
  });
  mainWindow.setResizable(policy.resizable);
  if (isExpanded) {
    mainWindow.setMaximumSize(policy.maxWidth, policy.maxHeight);
    mainWindow.setMinimumSize(policy.minWidth, policy.minHeight);
  } else {
    mainWindow.setMinimumSize(policy.minWidth, policy.minHeight);
    mainWindow.setMaximumSize(policy.maxWidth, policy.maxHeight);
  }
}

function anchorWindow(isExpanded) {
  if (!mainWindow) return;
  const display = collapsedWindowPosition
    ? screen.getDisplayNearestPoint({
        x: collapsedWindowPosition.x + Math.round(COLLAPSED_SIZE.width / 2),
        y: collapsedWindowPosition.y + Math.round(COLLAPSED_SIZE.height / 2),
      })
    : screen.getPrimaryDisplay();
  const bounds = windowBoundsForState({
    collapsedPosition: collapsedWindowPosition,
    collapsedSize: COLLAPSED_SIZE,
    expandedSize: expandedSizeForWorkArea(display.workArea),
    isExpanded,
    workArea: display.workArea,
  });
  mainWindow.setBounds(bounds, !GROUP_STUDIO);
  if (!isExpanded) collapsedWindowPosition = { x: bounds.x, y: bounds.y };
}

function currentWindowBounds() {
  const size = expanded ? expandedWindowSize : COLLAPSED_SIZE;
  return { width: size.width, height: size.height };
}

function rememberExpandedWindowSize(userBounds) {
  if (!mainWindow || mainWindow.isDestroyed() || !expanded || mainWindow.isMaximized?.()) return;
  const [width, height] = userBounds ? [userBounds.width, userBounds.height] : mainWindow.getSize();
  expandedWindowSize = {
    width: Math.max(EXPANDED_MIN_SIZE.width, width),
    height: Math.max(EXPANDED_MIN_SIZE.height, height),
  };
  if (userBounds) windowSizePreferences?.remember(expandedWindowSize);
}

function expandedSizeForWorkArea(workArea) {
  return {
    width: Math.min(expandedWindowSize.width, workArea.width),
    height: Math.min(expandedWindowSize.height, workArea.height),
  };
}

function notifyDesktopSystemStatusChanged() {
  for (const window of [mainWindow, cockpitWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send("desktop:system-status-changed");
  }
}

function assertMainSender(event) {
  const trusted = Boolean(desktopWindowForSender(event));
  if (!trusted) throw new Error("untrusted_desktop_sender");
}

function desktopWindowForSender(event) {
  return [mainWindow, cockpitWindow].find((window) => window && !window.isDestroyed() && event.sender.id === window.webContents.id) || null;
}

function cleanHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
  } catch {
    return "";
  }
}

function releaseChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  return ["stable", "beta"].includes(channel) ? channel : "";
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanMessage(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanEmployeeId(value) {
  const employeeId = cleanMessage(value).toLowerCase();
  return /^[a-z0-9._-]{1,120}$/.test(employeeId) ? employeeId : "";
}

function cleanRuntimeTaskId(value) {
  const taskId = cleanMessage(value);
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(taskId) ? taskId : "";
}

function cleanReusableArtifactGrantId(value) {
  const grantId = cleanMessage(value);
  return /^material_[a-f0-9]{64}$/.test(grantId) ? grantId : "";
}

function cleanStringList(value, maxItems) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanMessage(item).slice(0, 120))
    .filter(Boolean)
    .slice(0, maxItems);
}

function boundedSafeNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, number)) : 0;
}
