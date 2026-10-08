import * as Lark from "@larksuiteoapi/node-sdk";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiProviderCredentials, aiProviderRoutes } from "../../../src/data/catalog.js";
import { capabilityRequests, qualityEvents, subsystemRegistry } from "../../../src/data/controlPlane.js";
import { createControlPlaneStore } from "../../control-plane-store.mjs";
import { createProviderConnectionGovernanceStore } from "../../provider-connection-governance-store.mjs";
import { projectProviderCredentials, projectProviderRoutes } from "../../provider-connection-service.mjs";
import { createProviderCredentialSecretStore } from "../../provider-connection-store.mjs";
import { fetchRuntimeSkillCatalog } from "../../runtime-business-skill-catalog.mjs";
import { fetchRuntimeDigitalEmployeeCatalog } from "../../runtime-digital-employee-catalog.mjs";
import { createSkillHarnessRunner } from "../../skill-harness-runner.mjs";
import { resolveDigitalWorkforceDataDir } from "../../local-data-root.mjs";
import { taskBoundSkills } from "../../skill-publication-task-bindings.mjs";
import { createRuntimeSessionPersistence } from "../../agent-runtime/session-persistence-bootstrap.mjs";
import { createCompactionCheckpointRepository } from "../../agent-runtime/compaction-checkpoint-repository.mjs";
import { readRuntimeContextCompactionPolicyFromEnvironment } from "../../agent-runtime/runtime-context-session.mjs";
import { createCanonicalRuntimeTaskService } from "../../agent-runtime/canonical-runtime-task-service.mjs";
import { createExecutionTaskWorkerPump } from "../../agent-runtime/execution-task-worker-pump.mjs";
import { runtimeQueuePolicyForEmployee } from "../../agent-runtime/runtime-task-queue-policy.mjs";
import { createRuntimeTaskPersistence } from "../../agent-runtime/runtime-task-persistence-bootstrap.mjs";
import { createRuntimeTaskEvidenceRecorder } from "../../agent-runtime/runtime-task-evidence-recorder.mjs";
import { operationReceiptContextForExecutionOwnership } from "../../agent-runtime/operation-receipt-context.mjs";
import { providerTimeoutPolicyForRoute } from "../../agent-runtime/provider-timeout-policy.mjs";
import { createEmployeeToolExecutor } from "../../agent-runtime/employee-tool-executor.mjs";
import { skillToolCompletionPolicies } from "../../agent-runtime/skill-tool-completion-policy.mjs";
import { createManagedReferenceCatalogStore } from "../../agent-runtime/managed-reference-catalog.mjs";
import {
  BINDING_CONTRACT_VERSION,
  CREDENTIAL_MODE,
  createCurrentUserToolCredentialBindingRegistry,
} from "../../agent-runtime/current-user-tool-binding-registry.mjs";
import { createCurrentUserToolCredentialLeaseService } from "../../agent-runtime/current-user-tool-lease-service.mjs";
import { createFeishuCurrentUserOAuthStore } from "../../agent-runtime/feishu-current-user-oauth-store.mjs";
import {
  FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
  createFeishuCurrentUserOAuthIssuer,
} from "../../agent-runtime/feishu-current-user-oauth-issuer.mjs";
import {
  HR_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  hrCurrentUserJwtIssuerFromEnvironment,
  hrTrainingCurrentUserJwtIssuerFromEnvironment,
} from "../../agent-runtime/hr-current-user-jwt-issuer.mjs";
import { createFeishuEmployeeAgentRuntime } from "./algorithm-agent-runtime.mjs";
import { createFeishuEventGateway } from "./event-gateway.mjs";
import { createFeishuTurnDispatcher } from "./turn-dispatcher.mjs";
import { createFeishuCurrentUserProfileResolver } from "./current-user-profile-resolver.mjs";
import { createFeishuEmployeeAppTokenLeaseService } from "./employee-app-token-lease-service.mjs";
import { createRuntimeToolCapabilities } from "../../agent-runtime/runtime-tool-capabilities.mjs";
import { resolveWorkerEmployeeId } from "./worker-process-config.mjs";
import { resolveDigitalEmployeeReadIdentity } from "../../digital-employee-identity-compatibility.mjs";
import {
  FEISHU_TENANT_TOKEN_URL,
  cleanShortText,
  cleanText,
  createFeishuIntegrationStore,
  createLocalSecretKey,
  maskIdentifier,
} from "../../feishu-integration-support.mjs";
import { loadEnvFile } from "../../auth/server-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..", "..");
loadEnvFile(path.join(projectRoot, ".env.server.local"));
loadEnvFile(path.join(projectRoot, ".env.local"));
const localDataDir = resolveDigitalWorkforceDataDir({ projectRoot });
const managedReferenceCatalogStore = createManagedReferenceCatalogStore({
  filePath: path.join(localDataDir, "managed-reference-catalogs.json"),
});
const defaultStorePath = path.join(localDataDir, "feishu-integration-state.json");
const storePath = process.env.FEISHU_INTEGRATION_STORE_PATH || defaultStorePath;
const feishuCurrentUserOAuthStorePath = process.env.FEISHU_CURRENT_USER_OAUTH_STORE_PATH ||
  path.join(localDataDir, "feishu-current-user-oauth.json");
const catalogApiOrigin = process.env.DIGITAL_WORKFORCE_AUTH_ORIGIN || "http://127.0.0.1:8787";
const employeeId = resolveWorkerEmployeeId({ argv: process.argv.slice(2), env: process.env });
const store = createFeishuIntegrationStore({ storePath });
const feishuCurrentUserOAuthStore = createFeishuCurrentUserOAuthStore({
  encryptionKey: createLocalSecretKey(storePath),
  storePath: feishuCurrentUserOAuthStorePath,
});
const runtimeTaskPersistence = createRuntimeTaskPersistence({ env: process.env, projectRoot, resolveSkills: () => currentRuntimeSkills() });
const runtimeTaskEvidenceRecorder = createRuntimeTaskEvidenceRecorder({
  repository: runtimeTaskPersistence.repository,
});
store.freezeRuntimeTaskWriter();
const runtimeSessionPersistence = createRuntimeSessionPersistence({
  env: process.env,
  projectRoot,
});
const runtimeCheckpointRepository = createCompactionCheckpointRepository({
  sessionRepository: runtimeSessionPersistence.sessionRepository,
  store: runtimeSessionPersistence.checkpointStore,
});
const runtimeContextCompactionPolicy = readRuntimeContextCompactionPolicyFromEnvironment(process.env);
const runtimeTaskWorkerPump = createExecutionTaskWorkerPump({
  repository: runtimeTaskPersistence.repository,
  tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE,
  workerIdDigest: crypto.createHash("sha256").update(`feishu-runtime:${employeeId}:${process.pid}`).digest("hex"),
  resolveMaxEmployeeLeases: runtimeEmployeeLaneConcurrency,
});
const controlPlaneStore = createControlPlaneStore({
  projectRoot,
  storePath: process.env.CONTROL_PLANE_STORE_PATH || path.join(localDataDir, "control-plane-subsystems.json"),
  seedCapabilityRequests: capabilityRequests,
  seedQualityEvents: qualityEvents,
  seedSubsystems: subsystemRegistry,
});
const runtimeTaskService = createCanonicalRuntimeTaskService({
  admissionRepository: runtimeTaskPersistence.admissionRepository,
  executionTaskRepository: runtimeTaskPersistence.repository,
  feedbackStore: store,
  materialBindingRepository: runtimeTaskPersistence.taskMaterialBindingRepository,
  qualityEventStore: controlPlaneStore,
  resolveActorRoute: ({ actor, channelId = "feishu", employeeId: targetEmployeeId }) => runtimeSessionPersistence.createRoute({
    accountId: channelId,
    actorIssuer: actor?.identitySource || "feishu-runtime",
    actorSubjectId: actor?.employeeId || actor?.id || "feishu-runtime",
    channelId,
    conversationId: `${targetEmployeeId}:${channelId}:runtime-task`,
    conversationType: "direct",
    employeeId: targetEmployeeId,
  }),
  resolveEmployeeIdentity: resolveDigitalEmployeeReadIdentity,
  resolveProviderTimeoutPolicy: ({ employee }) => providerTimeoutPolicyForRoute(
    currentAiProviderRoutes().find((route) => route.id === (
      employee.modelBinding?.providerRouteId ||
      employee.runtimeBinding?.providerRouteId ||
      employee.runtimeBinding?.preferredProviderRouteId ||
      employee.modelBinding?.preferredProviderRouteId ||
      "codex-digital-office-route"
    )),
  ),
  routeVerifier: runtimeSessionPersistence.routeAuthority.verify,
  workerPump: runtimeTaskWorkerPump,
});
const providerCredentialSecretStore = createProviderCredentialSecretStore({
  storePath: process.env.PROVIDER_CREDENTIAL_SECRET_STORE_PATH || process.env.PROVIDER_KEY_SECRET_STORE_PATH || path.join(localDataDir, "provider-key-secrets.json"),
  redactError: (error) => cleanText(error?.message || String(error)),
});
const providerConnectionGovernanceStore = createProviderConnectionGovernanceStore({
  storePath: process.env.PROVIDER_CONNECTION_GOVERNANCE_STORE_PATH || path.join(localDataDir, "provider-connection-governance.json"),
  redactError: (error) => cleanText(error?.message || String(error)),
});
const hrCurrentUserCredentialAudience = String(process.env.HR_TALENTOS_DELEGATED_JWT_AUDIENCE || "hr-talentos").trim();
const hrCurrentUserCredentialIssuer = hrCurrentUserJwtIssuerFromEnvironment(process.env);
const hrTrainingCurrentUserCredentialAudience = String(process.env.HR_TRAINING_DELEGATED_JWT_AUDIENCE || "hr-training-assessment").trim();
const hrTrainingCurrentUserCredentialIssuer = hrTrainingCurrentUserJwtIssuerFromEnvironment(process.env);
const feishuCurrentUserOAuthRedirectUri = String(
  process.env.FEISHU_CURRENT_USER_OAUTH_REDIRECT_URI ||
  (process.env.FRONTEND_ORIGIN ? `${trimTrailingSlash(process.env.FRONTEND_ORIGIN)}/api/feishu/oauth/callback` : ""),
).trim();
const feishuCurrentUserOAuthIssuer = feishuCurrentUserOAuthRedirectUri
  ? createFeishuCurrentUserOAuthIssuer({
      fetch,
      readEmployeeAppCredentials: (targetEmployeeId) => ({
        appId: store.readSecret("appId", targetEmployeeId),
        appSecret: store.readSecret("appSecret", targetEmployeeId),
      }),
      redirectUri: feishuCurrentUserOAuthRedirectUri,
      store: feishuCurrentUserOAuthStore,
    })
  : null;
const feishuEmployeeAppTokenLeaseService = createFeishuEmployeeAppTokenLeaseService({
  fetch,
  readEmployeeAppCredentials: (targetEmployeeId) => ({
    appId: store.readSecret("appId", targetEmployeeId),
    appSecret: store.readSecret("appSecret", targetEmployeeId),
  }),
});
const currentUserToolCredentialLeaseService = createCurrentUserToolCredentialLeaseService({
  bindingRegistry: createCurrentUserToolCredentialBindingRegistry({
    bindings: [{
      contractVersion: BINDING_CONTRACT_VERSION,
      bindingId: "hr-talentos-current-user",
      bindingVersion: "1",
      credentialMode: CREDENTIAL_MODE,
      issuerAdapterId: HR_DELEGATED_JWT_ISSUER_ADAPTER_ID,
      audience: hrCurrentUserCredentialAudience,
      maxLeaseDurationMs: 5 * 60_000,
      scopeSource: "managed_openapi_operation",
      status: "active",
      toolId: "hr-talentos-api",
    }, {
      contractVersion: BINDING_CONTRACT_VERSION,
      bindingId: "hr-training-current-user",
      bindingVersion: "1",
      credentialMode: CREDENTIAL_MODE,
      issuerAdapterId: HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID,
      audience: hrTrainingCurrentUserCredentialAudience,
      maxLeaseDurationMs: 5 * 60_000,
      scopeSource: "managed_openapi_operation",
      status: "active",
      toolId: "hr-training-assessment-api",
    }, {
      contractVersion: BINDING_CONTRACT_VERSION,
      bindingId: "feishu-vc-minutes-current-user",
      bindingVersion: "1",
      credentialMode: CREDENTIAL_MODE,
      issuerAdapterId: FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
      audience: "feishu-openapi",
      maxLeaseDurationMs: 5 * 60_000,
      scopeSource: "managed_openapi_operation",
      status: "active",
      toolId: "feishu-vc-minutes-openapi",
    }],
  }),
  issuerAdapters: [
    hrCurrentUserCredentialIssuer,
    hrTrainingCurrentUserCredentialIssuer,
    feishuCurrentUserOAuthIssuer,
  ].filter(Boolean),
});
const resolveLongConnectionFeishuCurrentUserProfile = createFeishuCurrentUserProfileResolver({
  fetch,
  readSecret: (key, targetEmployeeId) => store.readSecret(key, targetEmployeeId),
  validateFeishuCredentials,
});
const runtimeToolCapabilities = createRuntimeToolCapabilities({ projectRoot,
  feishuEmployeeAppTokenLeaseService, managedReferenceCatalogStore });
const managedOpenApiTools = runtimeToolCapabilities.descriptors;
const skillHarnessRunner = createSkillHarnessRunner({ getPublishedSkills: currentRuntimeSkills });
let generatedIdSequence = 0;
let runtimeSkills = [];
let runtimeDigitalEmployees = [];

function currentRuntimeSkills({ task = null } = {}) {
  // Worker caches may lag a Center publication; the durable head remains authoritative.
  const statePath = process.env.SYSTEM_IMPORT_STORE_PATH || path.join(localDataDir, "system-import-state.json");
  let published = [];
  try { published = Object.values(JSON.parse(readFileSync(statePath, "utf8")).publishedBusinessSkills || {}); }
  catch (error) { if (error.code !== "ENOENT" || runtimeSkills.some((skill) => skill.mvpPublication)) throw new Error("skill_publication_head_unavailable"); }
  const current = new Map(runtimeSkills.map((skill) => [skill.id, skill]));
  for (const skill of published) current.set(skill.id, skill);
  return taskBoundSkills([...current.values()], task);
}

async function refreshRuntimeCatalogs() {
  const [skillCatalog, employeeCatalog] = await Promise.all([
    fetchRuntimeSkillCatalog({ baseUrl: catalogApiOrigin, fetch }),
    fetchRuntimeDigitalEmployeeCatalog({ baseUrl: catalogApiOrigin, fetch }),
  ]);
  runtimeSkills = skillCatalog.skills;
  runtimeDigitalEmployees = employeeCatalog.digitalEmployees;
  if (!resolveEmployee()) throw new Error(`feishu_worker_employee_not_found:${employeeId}`);
  return { employeeCatalog, skillCatalog };
}

function resolveEmployee() {
  return currentDigitalEmployees().find((employee) => employee.id === employeeId) || null;
}

function currentDigitalEmployees() {
  return runtimeDigitalEmployees;
}

function runtimeEmployeeLaneConcurrency(candidateEmployeeId) {
  const employee = currentDigitalEmployees().find((item) => item.id === candidateEmployeeId);
  return runtimeQueuePolicyForEmployee(employee).maxParallelWorkers;
}

function currentAiProviderRoutes() {
  return projectProviderRoutes(aiProviderRoutes, providerConnectionGovernanceStore.readState());
}

function currentAiProviderCredentials() {
  return projectProviderCredentials(aiProviderCredentials, providerConnectionGovernanceStore.readState());
}

function employeeHasEnabledTool(employee = {}, toolId = "") {
  return [...(employee?.toolBindings || employee?.tools || [])]
    .some((binding) => [binding?.id, binding?.toolId].includes(toolId) && binding?.enabled !== false);
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function nextRecordId(prefix = "FEVT") {
  generatedIdSequence = (generatedIdSequence + 1) % 100000;
  return `${prefix}-${Date.now()}-${String(generatedIdSequence).padStart(5, "0")}`;
}

async function validateFeishuCredentials({ appId, appSecret }) {
  if (process.env.FEISHU_CONNECTION_SKIP_REMOTE_VALIDATION === "1") {
    return {
      ok: true,
      message: "本地测试已跳过飞书远端凭证校验。",
      safeSummary: {
        status: "skipped_for_local_test",
        checkedAt: new Date().toISOString(),
        appIdMasked: maskIdentifier(appId),
        message: "本地测试已跳过飞书远端凭证校验。",
      },
      tenantAccessToken: "",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(FEISHU_TENANT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    const ok = response.ok && Number(data.code) === 0 && data.tenant_access_token;
    return {
      ok,
      message: ok ? "飞书应用凭证校验通过。" : cleanText(data.msg || data.message || "飞书应用凭证校验失败。"),
      safeSummary: {
        status: ok ? "validated" : "failed",
        checkedAt: new Date().toISOString(),
        appIdMasked: maskIdentifier(appId),
        expireSeconds: ok ? Number(data.expire) || undefined : undefined,
        responseCode: Number.isFinite(Number(data.code)) ? Number(data.code) : undefined,
        message: ok ? "tenant_access_token 校验通过。" : cleanText(data.msg || data.message || "飞书应用凭证校验失败。"),
      },
      tenantAccessToken: ok ? data.tenant_access_token : "",
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.name === "AbortError" ? "飞书凭证校验超时。" : "无法连接飞书凭证校验接口。",
      safeSummary: {
        status: "failed",
        checkedAt: new Date().toISOString(),
        appIdMasked: maskIdentifier(appId),
        message: error?.name === "AbortError" ? "飞书凭证校验超时。" : "无法连接飞书凭证校验接口。",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function saveWorkerStatus(status, patch = {}) {
  const now = new Date().toISOString();
  const connection = store.readConnection(employeeId);
  const employee = resolveEmployee();
  const next = store.saveConnection({
    ...connection,
    employeeId,
    workerBinding: {
      ...(connection.workerBinding || {}),
      status,
      ...patch,
      employeeId,
      employeeName: employee?.name || connection.workerBinding?.employeeName || employeeId,
      updatedAt: now,
    },
    lastConnectionTest: {
      ...(connection.lastConnectionTest || {}),
      status,
      checkedAt: now,
      worker: {
        status,
        message: patch.message || workerStatusMessage(status),
      },
      nextGate: patch.nextGate || workerStatusMessage(status),
    },
    updatedAt: now,
  }, employeeId);
  return next;
}

function workerStatusMessage(status = "") {
  if (status === "worker_online") return "飞书长连接 worker 已启动，等待真实飞书消息。";
  if (status === "worker_stopped") return "飞书长连接 worker 已停止。";
  if (status === "worker_failed") return "飞书长连接 worker 启动失败，请检查 App ID/App Secret 和事件订阅。";
  if (status === "message_roundtrip_tested") return "飞书真实消息状态标记测试已通过。";
  if (status === "event_received") return "飞书长连接 worker 已收到真实事件，正在确认状态标记。";
  return "飞书长连接 worker 状态已更新。";
}

function safeEventLog(data = {}) {
  const message = data.message || {};
  const sender = data.sender || {};
  return {
    eventType: cleanShortText(data.event_type || "im.message.receive_v1"),
    messageId: maskIdentifier(message.message_id),
    chatId: maskIdentifier(message.chat_id),
    senderId: maskIdentifier(sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id),
    messageType: cleanShortText(message.message_type),
    chatType: cleanShortText(message.chat_type),
  };
}

async function main() {
  const appId = store.readSecret("appId", employeeId);
  const appSecret = store.readSecret("appSecret", employeeId);
  if (!appId || !appSecret) {
    saveWorkerStatus("worker_failed", {
      message: "服务端尚未保存 App ID/App Secret，无法启动飞书长连接 worker。",
      nextGate: "请先在联通配置里保存并校验飞书 App ID/App Secret。",
    });
    console.error("[feishu-worker] credentials missing", JSON.stringify({ employeeId }));
    process.exitCode = 1;
    return;
  }
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    saveWorkerStatus("worker_failed", {
      message: "飞书 App ID 格式不符合长连接 SDK 要求，应为 cli_ 加 16 位十六进制字符。",
      nextGate: "请确认飞书开放平台里的 App ID，并重新保存联通配置。",
    });
    console.error("[feishu-worker] invalid app id:", maskIdentifier(appId));
    process.exitCode = 1;
    return;
  }

  const credentialCheck = await validateFeishuCredentials({ appId, appSecret });
  if (!credentialCheck.ok && process.env.FEISHU_CONNECTION_SKIP_REMOTE_VALIDATION !== "1") {
    saveWorkerStatus("worker_failed", {
      message: credentialCheck.message,
      nextGate: "请重新保存正确的飞书 App ID/App Secret。",
    });
    console.error("[feishu-worker] credential validation failed:", credentialCheck.message);
    process.exitCode = 1;
    return;
  }

  const runtimeCatalogs = await refreshRuntimeCatalogs();
  const agentRuntime = createFeishuEmployeeAgentRuntime({
    employeeId,
    aiProviderCredentials,
    aiProviderRoutes,
    businessSkills: currentRuntimeSkills(),
    contextCompactionPolicy: runtimeContextCompactionPolicy,
    digitalEmployees: currentDigitalEmployees(),
    fetch,
    getDigitalEmployees: currentDigitalEmployees,
    getAiProviderCredentials: currentAiProviderCredentials,
    getAiProviderRoutes: currentAiProviderRoutes,
    getBusinessSkills: currentRuntimeSkills,
    isTaskCancellationRequested: (task) => runtimeTaskService.isCancellationRequested(task),
    providerCredentialSecretStore,
    recordRuntimeActivity: runtimeTaskEvidenceRecorder.recordActivity,
    recordRuntimeEvidence: runtimeTaskEvidenceRecorder.record,
    recordRuntimeEfficiency: runtimeTaskEvidenceRecorder.recordEfficiency,
    recordRuntimeProvenance: runtimeTaskEvidenceRecorder.recordProvenance,
  });
  const feishuTurnDispatcher = createFeishuTurnDispatcher({
    agentRuntime,
    businessSkills: currentRuntimeSkills(),
    confirmationRepository: runtimeTaskPersistence.toolCallConfirmationRepository,
    getBusinessSkills: currentRuntimeSkills,
  });
  const gateway = createFeishuEventGateway({
    checkpointRepository: runtimeCheckpointRepository,
    controlPlaneStore,
    createSessionRoute: runtimeSessionPersistence.createRoute,
    createToolExecutor: ({ decision, employee, executionIdentity, materialToolExecutor, runtimeTask }) => createEmployeeToolExecutor({
      additionalExecutors: [materialToolExecutor],
      authorizeToolCall: (toolCall, operation, allOperations) => feishuTurnDispatcher.authorizeToolCall({
        allOperations,
        decision,
        operation,
        toolCall,
      }),
      currentUserToolCredentialLeaseService,
      defaultOperationReceiptContext: operationReceiptContextForExecutionOwnership({
        task: runtimeTask,
        lease: runtimeTask?.lease,
      }),
      employee,
      executionIdentity,
      idempotentEffectService: runtimeTaskPersistence.idempotentEffectService,
      managedOpenApiTools,
      operationReceiptProjector: runtimeTaskPersistence.operationReceiptProjector,
      toolCompletionPolicies: skillToolCompletionPolicies(decision?.dependencyContext?.callableSkills),
    }),
    employeeId,
    fetch,
    nextRecordId,
    resolveCurrentUserToolProfile: ({ employee, ...input }) => (
      employeeHasEnabledTool(employee, "hr-training-assessment-api")
        ? resolveLongConnectionFeishuCurrentUserProfile(input)
        : null
    ),
    resolveEmployee,
    runtimeTaskService,
    persistentTaskExecution: true,
    sessionRepository: runtimeSessionPersistence.sessionRepository,
    toolParameterContinuationRepository: runtimeTaskPersistence.toolParameterContinuationRepository,
    skillHarnessRunner,
    store,
    turnDispatcher: feishuTurnDispatcher,
    validateFeishuCredentials,
  });
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    handshakeTimeoutMs: 10000,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => {
      saveWorkerStatus("worker_online");
      console.log("[feishu-worker] long connection ready", JSON.stringify({
        employeeId,
        appIdMasked: maskIdentifier(appId),
        runtimeDigitalEmployeeCatalogSource: runtimeCatalogs.employeeCatalog.source,
        runtimeSkillCatalogSource: runtimeCatalogs.skillCatalog.source,
        storePath,
      }));
    },
    onError: (error) => {
      saveWorkerStatus("worker_failed", {
        message: error?.message || "飞书长连接 worker 连接失败。",
        nextGate: "请检查飞书应用凭证、事件订阅、机器人能力和网络连通性。",
      });
      console.error("[feishu-worker] connection error", error);
    },
    onReconnecting: () => {
      saveWorkerStatus("worker_reconnecting", {
        message: "飞书长连接 worker 正在重连。",
      });
      console.warn("[feishu-worker] reconnecting");
    },
    onReconnected: () => {
      saveWorkerStatus("worker_online", {
        message: "飞书长连接 worker 已重连。",
      });
      console.log("[feishu-worker] reconnected");
    },
  });
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      console.log("[feishu-worker] message event received", JSON.stringify({ employeeId, ...safeEventLog(data) }));
      await refreshRuntimeCatalogs();
      const result = await gateway.recordFeishuEvent({
        callbackPath: "",
        connection: store.readConnection(employeeId),
        event: data,
        receiveMode: "websocket_long_connection",
        submittedBy: { id: `feishu-long-connection-worker:${employeeId}`, name: "飞书长连接 worker", departmentId: "", role: "service" },
      });
      console.log("[feishu-worker] event handled", JSON.stringify({
        status: result.status,
        eventStatus: result.eventStatus,
        markerStatus: result.marker?.status || result.reply?.status,
        agentStatus: cleanShortText(result.agentTurn?.status),
        agentReason: cleanShortText(result.agentTurn?.reason),
        taskStatus: cleanShortText(result.runtimeTask?.status),
      }));
    },
    "card.action.trigger": async (data) => {
      const result = await gateway.recordFeishuEvent({
        callbackPath: "",
        connection: store.readConnection(employeeId),
        event: { ...data, event_type: "card.action.trigger" },
        receiveMode: "websocket_long_connection",
        submittedBy: { id: `feishu-long-connection-worker:${employeeId}`, name: "飞书长连接 worker", departmentId: "", role: "service" },
      });
      console.log("[feishu-worker] card action handled", JSON.stringify({
        status: result.status,
        qualityEventId: result.qualityEvent?.id || "",
      }));
      return result.callbackResponse || result.toast || {};
    },
  });

  if (process.env.FEISHU_WORKER_DRY_RUN_EVENT === "1") {
    saveWorkerStatus("worker_online");
    await gateway.recordFeishuEvent({
      callbackPath: "",
      connection: store.readConnection(employeeId),
      event: {
        event_type: "im.message.receive_v1",
        sender: {
          sender_id: { open_id: "ou_local_worker_test" },
          sender_type: "user",
        },
        message: {
          message_id: "om_local_worker_test",
          chat_id: "oc_local_worker_test",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "local worker smoke" }),
        },
      },
      receiveMode: "websocket_long_connection",
      submittedBy: { id: `feishu-long-connection-worker:${employeeId}`, name: "飞书长连接 worker", departmentId: "", role: "service" },
    });
    console.log("[feishu-worker] dry-run event handled");
    await runtimeTaskWorkerPump.close();
    runtimeTaskPersistence.close();
    runtimeSessionPersistence.close();
    runtimeToolCapabilities.close();
    return;
  }

  saveWorkerStatus("worker_starting", {
    message: "飞书长连接 worker 已启动，正在等待 SDK 握手成功。",
  });
  await wsClient.start({ eventDispatcher });
  console.log("[feishu-worker] long connection starting", JSON.stringify({
    employeeId,
    appIdMasked: maskIdentifier(appId),
    storePath,
  }));

  const stop = async (signal) => {
    saveWorkerStatus("worker_stopped", { message: `收到 ${signal}，飞书长连接 worker 已停止。` });
    try {
      wsClient.close({ force: true });
    } catch {
      // Ignore shutdown races from the SDK.
    }
    await runtimeTaskWorkerPump.close();
    runtimeTaskPersistence.close();
    runtimeSessionPersistence.close();
    runtimeToolCapabilities.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop("SIGINT"); });
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
}

main().catch(async (error) => {
  await runtimeTaskWorkerPump.close();
  runtimeTaskPersistence.close();
  runtimeSessionPersistence.close();
  runtimeToolCapabilities.close();
  saveWorkerStatus("worker_failed", {
    message: error?.message || "飞书长连接 worker 启动失败。",
    nextGate: "请检查飞书应用凭证、事件订阅和网络连通性。",
  });
  console.error("[feishu-worker] fatal", error);
  process.exit(1);
});
