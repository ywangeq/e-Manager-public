import { createDeviceReadCenterServices } from "./agent-runtime/device-read-center-services.mjs";
import { createDeviceReadRoutes } from "./device-read-routes.mjs";
import { requireAdmissionTaskMatch } from "./digital-employee-chat/route-support.mjs";
import { groupStudioRoleSkills } from "./group-studio-role-config.mjs";
import { conciseWorkItemTitle } from "./work-item-display.mjs";
import { groupPlanningInputSnapshot, readGroupPlanningInputSnapshot } from "./agent-runtime/group-planning-input-v1.mjs";
import { createGroupDeliveryAcceptance } from "./agent-runtime/group-delivery-acceptance.mjs";
import { createLocalTestFrontend } from "./auth/local-test-frontend.mjs";
import { createGroupReviewOpinionReader } from "./agent-runtime/group-review-opinion-reader.mjs";
import { createScheduleConfigurationService } from "./agent-runtime/schedule-configuration-service.mjs";
import { createToolAssetRepository } from "./tool-registry/tool-asset-repository.mjs";
import { createToolAssetHandlers } from "./tool-registry/tool-asset-routes.mjs";
import { createToolConnectionAuthority } from "./tool-registry/registered-openapi-tools.mjs";
import { assembleDigitalEmployeeDependencyContext } from "./agent-runtime/dependency-context.mjs";
import { createPersonalAutomationService } from "./agent-runtime/personal-automation-service.mjs";
import { createDesktopPresence, createDesktopPresenceRoutes } from "./desktop-presence.mjs";
import { createDurableScanCoordinator } from "./agent-runtime/durable-scan-coordinator.mjs";
import { createPersonalAutomationRoutes } from "./personal-automation-routes.mjs";
import { runtimePermissionDigest } from "./digital-employee-chat/route-support.mjs";
import { checkPublishedSkillHarnesses } from "./published-skill-harness-preflight.mjs";
import { createGroupArtifactDependencyGate } from "./agent-runtime/group-artifact-dependency-gate.mjs";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiModelCatalog,
  aiModelLevels,
  aiProviderCredentials,
  aiProviderRoutes,
  aiProviderWorkerPools,
  badcaseRecords,
  basicSkills,
  businessSkills,
  departments,
  digitalEmployees,
  departmentGovernance,
  enterpriseTools,
  enterpriseToolBuiltinMigrations,
  externalAuditRequests,
  personnel,
  preReviewWorkers as aiPreReviewWorkers,
  qualityReviewItems,
  systemImportPipelines,
} from "../src/data/catalog.js";
import {
  capabilityRequests,
  distributionPlans,
  invocationPolicies,
  preReviewWorkers as controlPlanePreReviewWorkers,
  qualityEvents,
  subsystemRegistry,
} from "../src/data/controlPlane.js";
import { getLocalAccounts, verifyLocalPassword, assertLocalBinding } from "./auth/local-account.mjs";
import {
  governedTriggerBindingMigrations,
  governedTriggerBindings,
} from "../src/data/triggerBindings.js";
import { governedTriggerMaterialBindings } from "../src/data/triggerMaterialBindings.js";
import {
  governedTriggerTaskDefinitionMigrations,
  governedTriggerTaskDefinitions,
} from "../src/data/triggerTaskDefinitions.js";
import { governedTriggerWritebackBindings } from "../src/data/triggerWritebackBindings.js";
import { governedTriggerCredentialSeeds, governedTriggerSystemSeeds } from "../src/data/triggerSystems.js";
import { hasPermission, permissionsForRole } from "../src/lib/permissions.js";
import { createControlPlaneHandlers } from "./control-plane-routes.mjs";
import { createControlPlaneStore } from "./control-plane-store.mjs";
import { authorizeSession, createAuthorizationSessionService } from "./auth/authorization-session-service.mjs";
import { createExecutionRecoverySessionResolver } from "./auth/execution-recovery-session-resolver.mjs";
import { createRuntimeTaskActorDisplayNameResolver } from "./auth/runtime-task-actor-display-name.mjs";
import { createRuntimeTaskActorDisplayNameCache } from "./auth/runtime-task-actor-display-name-cache.mjs";
import { createOpsRuntimePerformanceObserver } from "./ops-runtime-performance-observer.mjs";
import { applyPersonnelGovernanceAuthorization } from "./auth/personnel-governance-authorization.mjs";
import { dataFlowExpectedEnterpriseIdentity } from "./auth/dataflow-device-session-identity.mjs";
import {
  buildFortressDepartmentDirectory,
  createFortressDepartmentGovernanceHelpers,
} from "./auth/fortress-department-governance.mjs";
import {
  buildPlatformVirtualDepartmentDirectory,
  mergeDepartmentDirectoryEntries,
  mergeDepartmentOwnerEntries,
} from "./digital-employee-department-directory.mjs";
import {
  activeDemoAccountProjection,
  projectFortressAccountStatus,
} from "./auth/fortress-account-status.mjs";
import {
  applyCatalogFilters,
  buildFortressLoginUrl,
  clampNumber,
  cleanList,
  cleanText,
  cookie,
  envList,
  fortressCredentials,
  loadEnvFile,
  parseCookies,
  readJsonBody,
  redactError,
  redirectResponse,
  requestId,
  resolveFrontendOrigin,
  resolveSsoCallbackBaseUri,
  safeRelativeRedirect,
  sendJson,
  signState,
  trimTrailingSlash,
  verifyState,
} from "./auth/server-support.mjs";
import { createAssetPackageDownloadStore } from "./asset-package-download-store.mjs";
import { loadSystemImportStore } from "./system-import-state-store.mjs";
import { createProviderRequestQueue } from "./agent-runtime/provider-request-queue.mjs";
import {
  BINDING_CONTRACT_VERSION,
  CREDENTIAL_MODE,
  createCurrentUserToolCredentialBindingRegistry,
} from "./agent-runtime/current-user-tool-binding-registry.mjs";
import { createCurrentUserToolCredentialLeaseService } from "./agent-runtime/current-user-tool-lease-service.mjs";
import { createFeishuCurrentUserOAuthStore } from "./agent-runtime/feishu-current-user-oauth-store.mjs";
import {
  FEISHU_CURRENT_USER_OAUTH_ISSUER_ADAPTER_ID,
  createFeishuCurrentUserOAuthIssuer,
} from "./agent-runtime/feishu-current-user-oauth-issuer.mjs";
import { createEmployeeToolExecutor } from "./agent-runtime/employee-tool-executor.mjs";
import { skillToolCompletionPolicies } from "./agent-runtime/skill-tool-completion-policy.mjs";
import { createCurrentUserToolCredentialChallengeBroker } from "./agent-runtime/current-user-tool-challenge-broker.mjs";
import {
  DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID,
  createDataFlowDeviceSessionIssuer,
} from "./agent-runtime/dataflow-device-session-issuer.mjs";
import {
  HR_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  HR_TRAINING_DELEGATED_JWT_ISSUER_ADAPTER_ID,
  hrCurrentUserJwtIssuerFromEnvironment,
  hrTrainingCurrentUserJwtIssuerFromEnvironment,
} from "./agent-runtime/hr-current-user-jwt-issuer.mjs";
import { createRuntimeSessionPersistence } from "./agent-runtime/session-persistence-bootstrap.mjs";
import {
  createConversationHistoryPolicyService,
  readManagedConversationHistoryPolicyFromEnvironment,
} from "./agent-runtime/conversation-history-policy-service.mjs";
import { createConversationDisplayHistoryService } from "./agent-runtime/conversation-display-history.mjs";
import { createDigitalEmployeeModelBindingHandlers } from "./digital-employee-model-binding-routes.mjs";
import { createDigitalEmployeeModelBindingStore } from "./digital-employee-model-binding-store.mjs";
import { createDigitalEmployeeRuntimeConfigService } from "./digital-employee-runtime-config-service.mjs";
import { createDigitalEmployeeRuntimeConfigStore } from "./digital-employee-runtime-config-store.mjs";
import {
  createDigitalEmployeeScheduleHandlers,
  isScheduleSystemAdmin, scheduleManagementActor,
} from "./digital-employee-schedule-routes.mjs";
import { createDigitalEmployeeLifecycleHandlers } from "./digital-employee-lifecycle-routes.mjs";
import { createDigitalEmployeeLifecycleStore } from "./digital-employee-lifecycle-store.mjs";
import { createDigitalEmployeeDepartmentChangeHandlers } from "./digital-employee-department-change-routes.mjs";
import { createDigitalEmployeeDepartmentChangeStore } from "./digital-employee-department-change-store.mjs";
import { createDigitalEmployeeResponsibilityHandlers } from "./digital-employee-responsibility-routes.mjs";
import { createDigitalEmployeeResponsibilityStore } from "./digital-employee-responsibility-store.mjs";
import { createDigitalEmployeeProfileHandlers } from "./digital-employee-profile-routes.mjs";
import { createDigitalEmployeeProfileStore } from "./digital-employee-profile-store.mjs";
import { createDigitalEmployeeAccessHandlers } from "./digital-employee-access-routes.mjs";
import { createDesktopSandboxDeviceSessionRegistry } from "./agent-runtime/desktop-sandbox-device-session-registry.mjs";
import { createDesktopSandboxReleaseProviderResolver } from "./agent-runtime/desktop-sandbox-release-provider-resolver.mjs";
import { createDesktopSandboxDispatchContextResolver } from "./agent-runtime/desktop-sandbox-dispatch-context-resolver.mjs";
import { createDesktopSandboxDispatchRepositoryAdapter } from "./agent-runtime/desktop-sandbox-dispatch-repository-adapter.mjs";
import { createDesktopSandboxDispatchService } from "./agent-runtime/desktop-sandbox-dispatch-service.mjs";
import { createDesktopSandboxDispatchTransportHandlers } from "./agent-runtime/desktop-sandbox-dispatch-transport.mjs";
import { createDesktopTaskArtifactStagingTransportHandlers } from "./agent-runtime/desktop-task-artifact-staging-transport.mjs";
import { createDeviceTaskArtifactStagingService } from "./agent-runtime/device-task-artifact-staging-service.mjs";
import { createSandboxExecToolPrepareService } from "./agent-runtime/sandbox-exec-tool-prepare-service.mjs";
import {
  createManagedSandboxEphemeralExecutionInputStore,
  createManagedSandboxExecutionBoundary,
  createManagedSandboxTaskCapabilityGrantService,
} from "./agent-runtime/managed-sandbox-execution-v1.mjs";
import { createDigitalEmployeeCharacterHandlers } from "./digital-employee-character-service.mjs";
import { createDigitalEmployeeRuntimeEventStore } from "./digital-employee-runtime-event-store.mjs";
import {
  resolveDigitalEmployeeReadIdentity,
  resolveDigitalEmployeeRequestIdentity,
} from "./digital-employee-identity-compatibility.mjs";
import { createDigitalEmployeeChatHandlers, runtimeSessionKey } from "./digital-employee-chat-routes.mjs";
import { createConversationDisplayHistoryHandlers } from "./conversation-display-history-routes.mjs";
import { createSkillHarnessRunner } from "./skill-harness-runner.mjs";
import { inspectPublishedSkillHarnessReadiness } from "./agent-runtime/published-skill-harness-readiness.mjs";
import { createDesktopReleaseHandlers } from "./desktop-release-routes.mjs";
import { createFeishuIntegrationHandlers } from "./feishu-integration-routes.mjs";
import { createFeishuIntegrationStore, createLocalSecretKey } from "./feishu-integration-support.mjs";
import { createFeishuEventGateway } from "./channels/feishu/event-gateway.mjs";
import { createFeishuEmployeeAgentRuntime } from "./channels/feishu/algorithm-agent-runtime.mjs";
import { createFeishuTurnDispatcher } from "./channels/feishu/turn-dispatcher.mjs";
import { createFeishuCredentialValidator } from "./channels/feishu/tenant-token-validator.mjs";
import { createFeishuEmployeeAppTokenLeaseService } from "./channels/feishu/employee-app-token-lease-service.mjs";
import { createRuntimeToolCapabilities } from "./agent-runtime/runtime-tool-capabilities.mjs";
import { createFeishuCurrentUserProfileResolver } from "./channels/feishu/current-user-profile-resolver.mjs";
import { createCompactionCheckpointRepository } from "./agent-runtime/compaction-checkpoint-repository.mjs";
import { readRuntimeContextCompactionPolicyFromEnvironment } from "./agent-runtime/runtime-context-session.mjs";
import { createCanonicalRuntimeTaskService } from "./agent-runtime/canonical-runtime-task-service.mjs";
import { createExecutionTaskWorkerPump } from "./agent-runtime/execution-task-worker-pump.mjs";
import { runtimeQueuePolicyForEmployee } from "./agent-runtime/runtime-task-queue-policy.mjs";
import { createDefaultProviderAdapterRegistry } from "./agent-runtime/openai-responses-provider-adapter.mjs";
import { resolveManagedProviderLease } from "./agent-runtime/provider-lease-resolver.mjs";
import { createResponsesAgentRunner } from "./agent-runtime/responses-agent-runner.mjs";
import { createManagedReferenceCatalogStore } from "./agent-runtime/managed-reference-catalog.mjs";
import { createDigitalEmployeeAgentExecutionService } from
  "./agent-runtime/digital-employee-agent-execution-service.mjs";
import { createDesktopMaterialIntakeService } from "./agent-runtime/desktop-material-intake-service.mjs";
import { createGroupMaterialBindingResolver } from "./agent-runtime/group-material-binding-resolver.mjs";
import { createGroupMaterialReferenceService } from "./agent-runtime/group-material-reference-service.mjs";
import { createTaskMaterialBindingSet } from "./agent-runtime/task-material-binding.mjs";
import { createReusableArtifactMaterialService } from "./agent-runtime/reusable-artifact-material-service.mjs";
import { createTaskArtifactService } from "./agent-runtime/task-artifact-service.mjs";
import { createArtifactRetentionCleanupCoordinator } from
  "./agent-runtime/artifact-retention-cleanup-coordinator.mjs";
import { createTaskWorkspaceManager } from "./agent-runtime/task-workspace-manager.mjs";
import { createScheduleRuntimeComposition } from "./agent-runtime/schedule-runtime-composition.mjs";
import { createGovernedScheduleRegistry } from "./agent-runtime/governed-schedule-registry.mjs";
import { createScheduleCancellationCoordinator } from "./agent-runtime/schedule-cancellation-coordinator.mjs";
import { createScheduleCancellationDispatcher } from "./agent-runtime/schedule-cancellation-dispatcher.mjs";
import { createScheduleOperationsService } from "./agent-runtime/schedule-operations-service.mjs";
import { createRuntimeTaskPersistence } from "./agent-runtime/runtime-task-persistence-bootstrap.mjs";
import { createOperationReceiptTaskReferenceResolver } from
  "./agent-runtime/operation-receipt-task-reference-resolver.mjs";
import { createRuntimeTaskEvidenceRecorder } from "./agent-runtime/runtime-task-evidence-recorder.mjs";
import { createTriggerBindingRegistry } from "./triggers/trigger-binding-registry.mjs";
import { normalizeTriggerEvent } from "./triggers/trigger-event-contract-v1.mjs";
import { createFxiaokeApprovalEventAdapter } from "./triggers/fxiaoke/approval-event-adapter.mjs";
import { createTriggerEventSubmissionService } from "./triggers/trigger-event-submission-service.mjs";
import { createTriggerExecutionService } from "./triggers/trigger-execution-service.mjs";
import { createTriggerExecutorRegistry } from "./triggers/trigger-executor-registry.mjs";
import { createTriggerPersistence } from "./triggers/trigger-persistence-bootstrap.mjs";
import { createTriggerTaskDefinitionRegistry } from "./triggers/trigger-task-definition-registry.mjs";
import { applyPublishedSkillPolicyHeadPromotion } from "./triggers/published-skill-policy-promotion.mjs";
import {
  createTriggerWritebackBindingRegistry,
  triggerWritebackPolicyRef,
} from "./triggers/trigger-writeback-binding-registry.mjs";
import { createTriggerAttachmentWorkspaceService } from
  "./triggers/trigger-attachment-workspace-service.mjs";
import { createSqliteTriggerReviewResultRepository } from
  "./triggers/sqlite-trigger-review-result-repository.mjs";
import { createSqliteTriggerBusinessLocatorRepository } from
  "./triggers/sqlite-trigger-business-locator-repository.mjs";
import { createAgentRuntimeTriggerHandler } from "./triggers/agent-runtime-trigger-handler.mjs";
import { createLegalReviewOutputPolicy } from
  "./triggers/policies/legal-review-output-policy.mjs";
import { createTriggerReviewWritebackEffect } from "./triggers/trigger-review-writeback-effect.mjs";
import { createTriggerCapabilityRunHandlers } from "./trigger-capability-run-routes.mjs";
import { createFxiaokeTriggerObjectMaterialAdapter } from
  "./triggers/fxiaoke/object-material-adapter.mjs";
import { createFxiaokeTriggerSubjectAgentResourceBuilder } from
  "./triggers/fxiaoke/subject-agent-resources.mjs";
import { createFxiaokeSaleContractLocatorRecorder } from
  "./triggers/fxiaoke/sale-contract-locator-recorder.mjs";
import { createFxiaokeSaleContractTaskReferenceResolver } from
  "./triggers/fxiaoke/sale-contract-task-reference-resolver.mjs";
import { createSqliteHrTrainingCapabilityRunInputRepository } from
  "./triggers/hr-training/capability-run-input-repository.mjs";
import { createHrTrainingCallbackEffect } from "./triggers/hr-training/callback-effect.mjs";
import { createHrTrainingEvaluationSkillContextResolver } from
  "./triggers/hr-training/evaluation-skill-context.mjs";
import { createHrTrainingContentEvaluationOutputPolicy } from
  "./triggers/hr-training/content-evaluation-output-policy.mjs";
import { createSqliteHrTrainingContentEvaluationResultRepository } from
  "./triggers/hr-training/content-evaluation-result-repository.mjs";
import { createHrTrainingContentEvaluationTriggerHandler } from
  "./triggers/hr-training/content-evaluation-trigger-handler.mjs";
import { createHrTrainingFollowupAnswerEvaluationOutputPolicy } from
  "./triggers/hr-training/followup-answer-evaluation-output-policy.mjs";
import { createSqliteHrTrainingFollowupAnswerEvaluationResultRepository } from
  "./triggers/hr-training/followup-answer-evaluation-result-repository.mjs";
import { createHrTrainingFollowupAnswerEvaluationTriggerHandler } from
  "./triggers/hr-training/followup-answer-evaluation-trigger-handler.mjs";
import { createHrTrainingFollowupRoundEvaluationOutputPolicy } from
  "./triggers/hr-training/followup-round-evaluation-output-policy.mjs";
import { createSqliteHrTrainingFollowupRoundEvaluationResultRepository } from
  "./triggers/hr-training/followup-round-evaluation-result-repository.mjs";
import { createHrTrainingFollowupRoundEvaluationTriggerHandler } from
  "./triggers/hr-training/followup-round-evaluation-trigger-handler.mjs";
import { createHrTrainingAggregateFeedbackOutputPolicy } from
  "./triggers/hr-training/aggregate-feedback-output-policy.mjs";
import { createSqliteHrTrainingAggregateFeedbackResultRepository } from
  "./triggers/hr-training/aggregate-feedback-result-repository.mjs";
import { createHrTrainingAggregateFeedbackTriggerHandler } from
  "./triggers/hr-training/aggregate-feedback-trigger-handler.mjs";
import { createHrTrainingTaskReferenceResolver } from
  "./triggers/hr-training/task-reference-resolver.mjs";
import { createFxiaokeTriggerObjectReviewWritebackAdapter } from
  "./triggers/fxiaoke/object-review-writeback-adapter.mjs";
import { classifyFxiaokeTriggerWritebackError } from
  "./triggers/fxiaoke/writeback-effect-error.mjs";
import { createFxiaokeReviewWritebackExecution } from "./triggers/fxiaoke/review-writeback-execution.mjs";
import {
  createTriggerTaskExecutorResolver,
  createTriggerTaskInputResolver,
} from "./triggers/trigger-task-input-resolver.mjs";
import {
  createTriggerSourceAdapterRegistry,
  createTriggerWebhookHandlers,
} from "./trigger-webhook-routes.mjs";
import { createTriggerManagementHandlers } from "./trigger-management-routes.mjs";
import { createSqliteGovernedScheduleRepository } from "./agent-runtime/sqlite-governed-schedule-repository.mjs";
import { createSqliteScheduleTaskExecutionDefinitionRepository } from "./agent-runtime/sqlite-schedule-task-execution-definition-repository.mjs";
import { providerTimeoutPolicyForRoute } from "./agent-runtime/provider-timeout-policy.mjs";
import { createOpsUsageHandlers } from "./ops-usage-routes.mjs";
import { createOpsUsageStore } from "./ops-usage-store.mjs";
import { createOpsIncidentHandlers } from "./ops-incident-routes.mjs";
import { actorFromSession, createGroupStudioHandlers } from "./group-studio-routes.mjs";
import { createTaskPlannerAgent } from "./agent-runtime/task-planner-agent.mjs";
import { createGroupRunCoordinator } from "./agent-runtime/group-run-coordinator.mjs";
import { createGroupExecutionContext } from "./agent-runtime/group-execution-context-v1.mjs";
import { createGroupArtifactDeliveryAuthorizer } from "./agent-runtime/group-artifact-delivery-authorizer.mjs";
import { createGroupTaskExecutor } from "./agent-runtime/group-task-executor.mjs";
import { safeGroupRequestErrorCode } from "./agent-runtime/group-execution-errors.mjs";
import { projectGroupPlannerDisplay } from "./agent-runtime/group-planner-display-v1.mjs";
import { createReferenceTaskAdmissionService } from "./agent-runtime/reference-task-admission-service.mjs";
import { groupContentDigest, groupContractError } from "./agent-runtime/group-contracts-v1.mjs";
import { evaluateDigitalEmployeeEntitlement } from "./digital-employee-entitlement.mjs";
import { createOpsDiagnosisTaskService } from "./agent-runtime/ops-diagnosis-task-service.mjs";
import { createPersonnelGovernanceHandlers } from "./personnel/governance-routes.mjs";
import { createPersonnelGovernanceStore } from "./personnel/governance-store.mjs";
import { createProviderConnectionHandlers } from "./provider-connection-routes.mjs";
import { createProviderConnectionGovernanceStore } from "./provider-connection-governance-store.mjs";
import { projectProviderCredentials, projectProviderRoutes } from "./provider-connection-service.mjs";
import { createProviderCredentialSecretStore } from "./provider-connection-store.mjs";
import { createFxiaokeCrmCredentialStore } from "./agent-runtime/fxiaoke-crm-vault.mjs";
import { createFxiaokeCrmServiceClient } from "./agent-runtime/fxiaoke-crm-service-client.mjs";
import {
  fxiaokeCrmCredentialsConfigured,
  readFxiaokeCrmCredentials,
} from "./agent-runtime/fxiaoke-crm-readonly-tool-executor.mjs";
import { createRuntimeInfrastructureProbe } from "./runtime-infrastructure-probe.mjs";
import { createRuntimeInfrastructureHandlers } from "./runtime-infrastructure-routes.mjs";
import { createRuntimeInfrastructureStore } from "./runtime-infrastructure-store.mjs";
import { createSystemWorkerConfigHandlers } from "./system-worker-config-routes.mjs";
import { createSystemWorkerConfigStore } from "./system-worker-config-store.mjs";
import { createSystemImportHandlers } from "./system-import-routes.mjs";
import { resolveLanHost } from "./lan-host.mjs";
import { resolveDigitalWorkforceDataDir } from "./local-data-root.mjs";
import { managedCenterTlsOptionsFromEnvironment } from "./managed-center-tls-options.mjs";
import { createManagedHttpsRequestVerifier } from "./managed-https-request.mjs";
import { testTlsOptionsFromEnvironment } from "./test-tls-options.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");


// Must precede every repository initialization: readiness failure cannot migrate live databases.
if (process.env.EMANAGER_LOCAL_MODE !== "1") throw new Error("start_with_pnpm_start_local_mode_required");
assertLocalBinding(process.env.AUTH_SERVER_HOST);
const demoAccounts = getLocalAccounts();
await checkPublishedSkillHarnesses();

const PORT = Number(process.env.AUTH_SERVER_PORT || 8787);
const LOCAL_DATA_DIR = resolveDigitalWorkforceDataDir({ projectRoot });
const managedReferenceCatalogStore = createManagedReferenceCatalogStore({
  filePath: path.join(LOCAL_DATA_DIR, "managed-reference-catalogs.json"),
});
const PERSONNEL_DRAFT_STORE_PATH =
  process.env.PERSONNEL_DRAFT_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "personnel-governance-drafts.json");
const CONTROL_PLANE_STORE_PATH =
  process.env.CONTROL_PLANE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "control-plane-subsystems.json");
const FEISHU_INTEGRATION_STORE_PATH =
  process.env.FEISHU_INTEGRATION_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "feishu-integration-state.json");
const FEISHU_CURRENT_USER_OAUTH_STORE_PATH =
  process.env.FEISHU_CURRENT_USER_OAUTH_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "feishu-current-user-oauth.json");
const OPS_USAGE_STORE_PATH =
  process.env.OPS_USAGE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "ops-usage-events.json");
const DIGITAL_EMPLOYEE_RUNTIME_EVENT_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_RUNTIME_EVENT_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-runtime-events.json");
const ASSET_PACKAGE_DOWNLOAD_STORE_PATH =
  process.env.ASSET_PACKAGE_DOWNLOAD_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "asset-package-download-events.json");
const PROVIDER_CREDENTIAL_SECRET_STORE_PATH =
  process.env.PROVIDER_CREDENTIAL_SECRET_STORE_PATH ||
  process.env.PROVIDER_KEY_SECRET_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "provider-key-secrets.json");
const PROVIDER_CONNECTION_GOVERNANCE_STORE_PATH =
  process.env.PROVIDER_CONNECTION_GOVERNANCE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "provider-connection-governance.json");
const FXIAOKE_CRM_CREDENTIAL_STORE_PATH =
  process.env.FXIAOKE_CRM_CREDENTIAL_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "fxiaoke-crm-credentials.json");
const RUNTIME_INFRASTRUCTURE_STORE_PATH =
  process.env.RUNTIME_INFRASTRUCTURE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "runtime-infrastructure.json");
const SYSTEM_WORKER_CONFIG_STORE_PATH =
  process.env.SYSTEM_WORKER_CONFIG_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "system-worker-config.json");
const DIGITAL_EMPLOYEE_MODEL_BINDING_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_MODEL_BINDING_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-model-bindings.json");
const DIGITAL_EMPLOYEE_RUNTIME_CONFIG_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_RUNTIME_CONFIG_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-runtime-config.json");
const GOVERNED_SCHEDULE_REGISTRY_PATH =
  process.env.GOVERNED_SCHEDULE_REGISTRY_PATH ||
  path.join(LOCAL_DATA_DIR, "governed-schedules.sqlite");
const SCHEDULE_CONTROL_REPOSITORY_PATH =
  process.env.SCHEDULE_CONTROL_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "schedule-controls.sqlite");
const SCHEDULE_TRIGGER_REPOSITORY_PATH =
  process.env.SCHEDULE_TRIGGER_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "schedule-triggers.sqlite");
const SCHEDULE_TASK_EXECUTION_DEFINITION_REPOSITORY_PATH =
  process.env.SCHEDULE_TASK_EXECUTION_DEFINITION_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "schedule-task-execution-definitions.sqlite");
const GOVERNED_SCHEDULE_TENANT_SCOPE =
  process.env.GOVERNED_SCHEDULE_TENANT_SCOPE ||
  process.env.SESSION_FOUNDATION_TENANT_SCOPE ||
  "digital-workforce-default";
const TRIGGER_TENANT_SCOPE =
  process.env.SESSION_FOUNDATION_TENANT_SCOPE ||
  "digital-workforce-default";
const TRIGGER_REVIEW_RESULT_REPOSITORY_PATH =
  process.env.TRIGGER_REVIEW_RESULT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "trigger-review-results.sqlite");
const TRIGGER_BUSINESS_LOCATOR_REPOSITORY_PATH =
  process.env.TRIGGER_BUSINESS_LOCATOR_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "trigger-business-locators.sqlite");
const HR_TRAINING_CAPABILITY_RUN_INPUT_REPOSITORY_PATH =
  process.env.HR_TRAINING_CAPABILITY_RUN_INPUT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "hr-training-capability-run-inputs.sqlite");
const HR_TRAINING_CONTENT_EVALUATION_RESULT_REPOSITORY_PATH =
  process.env.HR_TRAINING_CONTENT_EVALUATION_RESULT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "hr-training-content-evaluation-results.sqlite");
const HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_REPOSITORY_PATH =
  process.env.HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "hr-training-followup-answer-evaluation-results.sqlite");
const HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_REPOSITORY_PATH =
  process.env.HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "hr-training-followup-round-evaluation-results.sqlite");
const HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_REPOSITORY_PATH =
  process.env.HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_REPOSITORY_PATH ||
  path.join(LOCAL_DATA_DIR, "hr-training-aggregate-feedback-results.sqlite");
const DIGITAL_EMPLOYEE_LIFECYCLE_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_LIFECYCLE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-lifecycle.json");
const DIGITAL_EMPLOYEE_DEPARTMENT_CHANGE_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_DEPARTMENT_CHANGE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-department-changes.json");
const DIGITAL_EMPLOYEE_RESPONSIBILITY_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_RESPONSIBILITY_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-responsibilities.json");
const DIGITAL_EMPLOYEE_PROFILE_STORE_PATH =
  process.env.DIGITAL_EMPLOYEE_PROFILE_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "digital-employee-profiles.json");
const SYSTEM_IMPORT_STORE_PATH =
  process.env.SYSTEM_IMPORT_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "system-import-state.json");
const EVALUATION_DATASET_STORE_PATH =
  process.env.EVALUATION_DATASET_STORE_PATH ||
  path.join(LOCAL_DATA_DIR, "evaluation-dataset-reviews.json");
const AUTH_PUBLIC_HOST = process.env.AUTH_PUBLIC_HOST || resolveLanHost("0.0.0.0");
const AUTH_SERVER_HOST = process.env.AUTH_SERVER_HOST || AUTH_PUBLIC_HOST;
const TEST_TLS_OPTIONS = testTlsOptionsFromEnvironment({ host: AUTH_SERVER_HOST });
const MANAGED_CENTER_TLS_OPTIONS = managedCenterTlsOptionsFromEnvironment();
if (TEST_TLS_OPTIONS && MANAGED_CENTER_TLS_OPTIONS) {
  throw new Error("digital_center_tls_configuration_conflict");
}
const SERVER_TLS_OPTIONS = MANAGED_CENTER_TLS_OPTIONS || TEST_TLS_OPTIONS;
const SERVER_PROTOCOL = SERVER_TLS_OPTIONS ? "https" : "http";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "";
const managedHttpsRequest = createManagedHttpsRequestVerifier({
  publicOrigin: FRONTEND_ORIGIN,
  trustedIngressIps: envList("DIGITAL_CENTER_TRUSTED_HTTPS_INGRESS_IPS"),
});
const FORTRESS_BASE_URL = trimTrailingSlash(
  process.env.FORTRESS_BASE_URL || "https://identity.example.invalid",
);
const FORTRESS_LOGIN_URL = process.env.FORTRESS_LOGIN_URL || `${FORTRESS_BASE_URL}/login`;
const FORTRESS_VERIFY_TICKET_URL =
  process.env.FORTRESS_VERIFY_TICKET_URL || `${FORTRESS_BASE_URL}/fortress/v3/sso/ticket/appId`;
const FORTRESS_USER_INFO_URL =
  process.env.FORTRESS_USER_INFO_URL || `${FORTRESS_BASE_URL}/fortress/v3/info/users`;
const FORTRESS_DEPARTMENTS_URL =
  process.env.FORTRESS_DEPARTMENTS_URL || `${FORTRESS_BASE_URL}/fortress/v3/info/departments`;
const FORTRESS_TICKET_USER_ID_TYPE = process.env.FORTRESS_TICKET_USER_ID_TYPE || "nickName";
const FORTRESS_USER_BATCH_SIZE = clampNumber(process.env.FORTRESS_USER_BATCH_SIZE, 1, 200, 80);
const FORTRESS_SYNC_CACHE_MS = clampNumber(process.env.FORTRESS_SYNC_CACHE_MS, 10_000, 30 * 60 * 1000, 5 * 60 * 1000);
const ADMIN_FEISHU_USER_IDS = envList("ADMIN_FEISHU_USER_IDS").map(normalizeAdminMatchValue);
const ADMIN_EMPLOYEE_NOS = envList("ADMIN_EMPLOYEE_NOS").map(normalizeAdminMatchValue);
const ADMIN_NICK_NAMES = envList("ADMIN_NICK_NAMES").map(normalizeAdminMatchValue);
const ADMIN_FULL_NAMES = envList("ADMIN_FULL_NAMES").map(normalizeAdminMatchValue);
const ADMIN_EMAILS = envList("ADMIN_EMAILS").map(normalizeAdminMatchValue);
const sessionSecret = process.env.AUTH_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const AUTH_SESSION_TTL_MS = clampNumber(process.env.AUTH_SESSION_TTL_MS, 15 * 60 * 1000, 24 * 60 * 60 * 1000, 8 * 60 * 60 * 1000);
const AUTHORIZATION_MAX_AGE_MS = clampNumber(
  process.env.AUTHORIZATION_MAX_AGE_MS,
  5 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
);
const authorizationSessions = createAuthorizationSessionService({
  authorizationMaxAgeMs: AUTHORIZATION_MAX_AGE_MS,
  sessionTtlMs: AUTH_SESSION_TTL_MS,
});
const resolveExecutionRecoverySession = createExecutionRecoverySessionResolver({
  authorizationSessions,
  refreshIdentity: refreshExecutionRecoveryIdentity,
});
const providerRequestQueue = createProviderRequestQueue();
const fortressGovernanceCache = new Map();
let fortressDepartmentDirectoryCache = null;
let fortressWorkerDepartmentDirectoryCache = null;
const {
  buildFortressDepartmentGovernanceRow,
  buildFortressTopDepartmentOwnerDirectory,
  departmentPath,
  flattenFortressDepartments,
  fortressDirectoryUserKey,
  sanitizeFortressDepartmentTree,
  summarizeFortressDepartments,
  uniqueFortressMembers,
} = createFortressDepartmentGovernanceHelpers({
  businessSkills,
  departments,
  digitalEmployees,
});
const personnelGovernanceStore = createPersonnelGovernanceStore({
  projectRoot,
  storePath: PERSONNEL_DRAFT_STORE_PATH,
  redactError,
});
const controlPlaneStore = createControlPlaneStore({
  projectRoot,
  storePath: CONTROL_PLANE_STORE_PATH,
  seedCapabilityRequests: capabilityRequests,
  seedQualityEvents: qualityEvents,
  seedSubsystems: subsystemRegistry,
  redactError,
  fetch,
});
const integrationStateStore = createFeishuIntegrationStore({ storePath: FEISHU_INTEGRATION_STORE_PATH });
const feishuCurrentUserOAuthStore = createFeishuCurrentUserOAuthStore({
  encryptionKey: createLocalSecretKey(FEISHU_INTEGRATION_STORE_PATH),
  storePath: FEISHU_CURRENT_USER_OAUTH_STORE_PATH,
});
const runtimeTaskPersistence = createRuntimeTaskPersistence({ env: process.env, projectRoot,
  resolveSkills: () => systemImportHandlers.listRuntimeBusinessSkills({}),
});
const runtimeTaskEvidenceRecorder = createRuntimeTaskEvidenceRecorder({
  repository: runtimeTaskPersistence.repository,
});
const triggerPersistence = createTriggerPersistence({ env: process.env, projectRoot });
const triggerBusinessLocatorRepository = createSqliteTriggerBusinessLocatorRepository({
  databasePath: TRIGGER_BUSINESS_LOCATOR_REPOSITORY_PATH,
  encryptionKey: deriveTriggerServerKey("business-locator.encryption.v1"),
  indexHmacKey: deriveTriggerServerKey("business-locator.index.v1"),
  integrityHmacKey: deriveTriggerServerKey("business-locator.integrity.v1"),
});
const hrTrainingCapabilityRunInputRepository = createSqliteHrTrainingCapabilityRunInputRepository({
  databasePath: HR_TRAINING_CAPABILITY_RUN_INPUT_REPOSITORY_PATH,
  encryptionKey: deriveTriggerServerKey("hr-training-capability-input.encryption.v1"),
  indexHmacKey: deriveTriggerServerKey("hr-training-capability-input.index.v1"),
  integrityHmacKey: deriveTriggerServerKey("hr-training-capability-input.integrity.v1"),
});
const triggerConfigSeed = triggerPersistence.configRepository.seedIfEmpty({
  systems: governedTriggerSystemSeeds,
  credentials: governedTriggerCredentialSeeds,
  bindings: governedTriggerBindings,
  taskDefinitions: governedTriggerTaskDefinitions,
  materialBindings: governedTriggerMaterialBindings,
  writebackBindings: governedTriggerWritebackBindings,
});
if (!triggerConfigSeed.current) {
  const existingTaskDefinitionIds = new Set(
    triggerPersistence.configRepository.loadPublishedConfiguration().taskDefinitions
      .map((definition) => definition.taskDefinitionId),
  );
  for (const migration of governedTriggerTaskDefinitionMigrations) {
    if (!existingTaskDefinitionIds.has(migration.replacement.taskDefinitionId)) continue;
    triggerPersistence.configRepository.applyTaskDefinitionMigration(migration);
  }
  for (const migration of governedTriggerBindingMigrations) {
    triggerPersistence.configRepository.applyBindingMigration(migration);
  }
}
triggerPersistence.configRepository.applyConfigurationRegistration({
  migrationId: "hr-training-trigger-capabilities-2026-08-21-v2",
  systems: governedTriggerSystemSeeds.filter((item) => item.sourceSystemId === "hr-train"),
  credentials: governedTriggerCredentialSeeds.filter((item) => item.sourceSystemId === "hr-train"),
  bindings: governedTriggerBindings.filter((item) => item.sourceSystemId === "hr-train"),
  taskDefinitions: governedTriggerTaskDefinitions.filter((item) =>
    String(item.taskDefinitionId || "").startsWith("hr-training-")),
  materialBindings: [],
  writebackBindings: [],
});
triggerPersistence.configRepository.applyConfigurationRegistration({
  migrationId: "hr-training-followup-round-evaluation-2026-08-25-v1",
  systems: [],
  credentials: [],
  bindings: governedTriggerBindings.filter((item) =>
    item.bindingId === "trg_hr_training_followup_round_evaluate_v1"),
  taskDefinitions: governedTriggerTaskDefinitions.filter((item) =>
    item.taskDefinitionId === "hr-training-followup-round-evaluation-v1"),
  materialBindings: [],
  writebackBindings: [],
});
triggerPersistence.configRepository.applyConfigurationRegistration({
  migrationId: "hr-training-aggregate-feedback-2026-08-25-v1",
  systems: [],
  credentials: [],
  bindings: governedTriggerBindings.filter((item) =>
    item.bindingId === "trg_hr_training_aggregate_feedback_v1"),
  taskDefinitions: governedTriggerTaskDefinitions.filter((item) =>
    item.taskDefinitionId === "hr-training-aggregate-feedback-v1"),
  materialBindings: [],
  writebackBindings: [],
});
triggerPersistence.configRepository.applyConfigurationRegistration({
  migrationId: "hr-training-trigger-system-homepage-url-2026-08-21-v1",
  systems: governedTriggerSystemSeeds.filter((item) => item.sourceSystemId === "hr-train"),
  credentials: [],
  bindings: [],
  taskDefinitions: [],
  materialBindings: [],
  writebackBindings: [],
});
triggerPersistence.configRepository.applyConfigurationRegistration({
  migrationId: "hr-training-service-api-credential-2026-08-21-v1",
  systems: [],
  credentials: governedTriggerCredentialSeeds.filter((item) =>
    item.credentialRef === "cred_hr_training_service_api_v1"),
  bindings: [],
  taskDefinitions: [],
  materialBindings: [],
  writebackBindings: [],
});
applyPublishedSkillPolicyHeadPromotion({
  configRepository: triggerPersistence.configRepository,
  publishedBusinessSkills: loadSystemImportStore(SYSTEM_IMPORT_STORE_PATH).publishedBusinessSkills,
});
const triggerConfiguration = triggerPersistence.configRepository.loadPublishedConfiguration();
const toolConnectionAuthority = createToolConnectionAuthority({
  getConnections: () => triggerPersistence.configRepository.loadPublishedConfiguration(),
});
const toolAssetRepository = createToolAssetRepository({
  databasePath: path.join(LOCAL_DATA_DIR, "tool-assets.sqlite"),
  validateReferences: toolConnectionAuthority.validateReferences,
});
toolAssetRepository.seedBuiltins(enterpriseTools);
for (const migration of enterpriseToolBuiltinMigrations) toolAssetRepository.addBuiltins(migration);
const toolAssetHandlers = createToolAssetHandlers({
  repository: toolAssetRepository, requireSession, readJsonBody, sendJson,
  connectionOptions: toolConnectionAuthority.options,
  actorDigest: session => resolveCenterSessionRoute({ session, employeeId: "tool-asset-governance", sessionKey: "tool-asset-governance" }).actorSubjectDigest,
});
const triggerBindingRegistry = createTriggerBindingRegistry({ bindings: triggerConfiguration.bindings });
const triggerTaskDefinitionRegistry = createTriggerTaskDefinitionRegistry({
  definitions: triggerConfiguration.taskDefinitions,
  getDefinitions: () => triggerPersistence.configRepository.loadPublishedConfiguration().taskDefinitions,
});
integrationStateStore.freezeRuntimeTaskWriter();
const runtimeSessionPersistence = createRuntimeSessionPersistence({
  env: process.env,
  projectRoot,
});
const runtimeCheckpointRepository = runtimeSessionPersistence.sessionRepository && runtimeSessionPersistence.checkpointStore
  ? createCompactionCheckpointRepository({
      sessionRepository: runtimeSessionPersistence.sessionRepository,
      store: runtimeSessionPersistence.checkpointStore,
    })
  : null;
const runtimeContextCompactionPolicy = readRuntimeContextCompactionPolicyFromEnvironment(process.env);
const conversationHistoryPolicyService = createConversationHistoryPolicyService({
  readManagedPolicy: () => readManagedConversationHistoryPolicyFromEnvironment(process.env),
});
const conversationDisplayHistoryService = runtimeSessionPersistence.sessionRepository
  ? createConversationDisplayHistoryService({
      repository: runtimeSessionPersistence.sessionRepository,
      resolveManagedPolicy: ({ route, session }) => conversationHistoryPolicyService.resolve({ route, session }),
      verifyRoute: runtimeSessionPersistence.routeAuthority.verify,
    })
  : null;
const conversationDisplayHistoryHandlers = conversationDisplayHistoryService
  ? createConversationDisplayHistoryHandlers({
      displayHistoryService: conversationDisplayHistoryService,
      requireSession,
      resolveAuthenticatedRoute: async ({ employeeId, session, sessionId }) => {
        const employee = currentDigitalEmployees().find((item) => item.id === employeeId);
        if (!employee || !digitalEmployeeAccessHandlers.canInvoke({ channelId: "desktop", employee, session })) return null;
        const expectedRoute = resolveCenterSessionRoute({ channelId: "desktop", employeeId, session });
        const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(sessionId);
        return storedRoute?.routeDigest === expectedRoute.routeDigest ? storedRoute : null;
      },
      sendJson,
    })
  : null;
const runtimeTaskWorkerPump = createExecutionTaskWorkerPump({
  repository: runtimeTaskPersistence.repository,
  tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE,
  workerIdDigest: crypto.createHash("sha256").update(`center-runtime:${process.pid}`).digest("hex"),
  resolveMaxEmployeeLeases: runtimeEmployeeLaneConcurrency,
});
const runtimeTaskService = createCanonicalRuntimeTaskService({
  admissionRepository: runtimeTaskPersistence.admissionRepository,
  executionTaskRepository: runtimeTaskPersistence.repository,
  feedbackStore: integrationStateStore,
  materialBindingRepository: runtimeTaskPersistence.taskMaterialBindingRepository,
  qualityEventStore: controlPlaneStore,
  resolveActorRoute: ({ actor, channelId, employeeId }) => resolveCenterSessionRoute({
    channelId,
    employeeId,
    session: actor || { employeeId: "center-runtime", identitySource: "center-runtime" },
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
const runtimeTaskWorkspaceManager = createTaskWorkspaceManager();
const desktopMaterialIntakeService = createDesktopMaterialIntakeService({
  workspaceManager: runtimeTaskWorkspaceManager,
});
const groupMaterialReferenceService = createGroupMaterialReferenceService({
  materialIntakeService: desktopMaterialIntakeService,
  referenceRepository: runtimeTaskPersistence.taskMaterialBindingRepository,
  taskRepository: runtimeTaskPersistence.repository,
  resolveEmployee: (employeeId) => currentDigitalEmployees().find((employee) => employee.id === employeeId) || null,
  canInvokeEmployee: ({ session, employee, channelId }) => evaluateDigitalEmployeeEntitlement({ employee, session, channelId }).callable,
  runtimeSessionKey,
});
const groupMaterialBindingResolver = createGroupMaterialBindingResolver({
  resolveReference: (context) => groupMaterialReferenceService.resolveReference(context),
});
const taskArtifactService = createTaskArtifactService({
  objectRoot: runtimeTaskPersistence.artifactObjectRoot,
  repository: runtimeTaskPersistence.repository,
  workspaceManager: runtimeTaskWorkspaceManager,
});
const artifactRetentionCleanupCoordinator = createArtifactRetentionCleanupCoordinator({
  artifactService: taskArtifactService,
  cleanupExecutionContinuations: request => runtimeTaskPersistence.executionContinuationRepository.cleanupTerminalRecords(request),
});
const reusableArtifactMaterialService = createReusableArtifactMaterialService({
  taskArtifactService,
  workspaceManager: runtimeTaskWorkspaceManager,
});
const triggerSubmissionService = createTriggerEventSubmissionService({
  bindingRegistry: triggerBindingRegistry,
  executionTaskRepository: runtimeTaskPersistence.repository,
  resolveEmployee: (employeeId) => currentDigitalEmployees().find((item) => item.id === employeeId) || null,
  resolveProviderTimeoutPolicy: ({ employee }) => providerTimeoutPolicyForRoute(
    currentAiProviderRoutes().find((route) => route.id === (
      employee.modelBinding?.providerRouteId ||
      employee.runtimeBinding?.providerRouteId ||
      employee.runtimeBinding?.preferredProviderRouteId ||
      employee.modelBinding?.preferredProviderRouteId ||
      "codex-digital-office-route"
    )),
  ),
  tenantScope: TRIGGER_TENANT_SCOPE,
  taskDefinitionRegistry: triggerTaskDefinitionRegistry,
  triggerEventRepository: triggerPersistence.repository,
  workerPump: runtimeTaskWorkerPump,
});
const triggerTaskInputResolver = createTriggerTaskInputResolver({
  bindingRegistry: triggerBindingRegistry,
  resolveEmployee: (employeeId) => currentDigitalEmployees().find((item) => item.id === employeeId) || null,
  taskDefinitionRegistry: triggerTaskDefinitionRegistry,
  tenantScope: TRIGGER_TENANT_SCOPE,
  triggerEventRepository: triggerPersistence.repository,
});
let triggerExecutionService = null;
const triggerTaskExecutorResolver = createTriggerTaskExecutorResolver({
  executeTrigger: (request) => triggerExecutionService.execute(request),
  inputResolver: triggerTaskInputResolver,
});
const triggerWebhookHandlers = createTriggerWebhookHandlers({
  adapterRegistry: createTriggerSourceAdapterRegistry([
    createFxiaokeApprovalEventAdapter({ normalizeTriggerEvent }),
  ]),
  bindingRegistry: triggerBindingRegistry,
  readJsonBody,
  resolveBindingSecret: (binding) => process.env[binding.secretEnvName] || "",
  sendJson,
  submissionService: triggerSubmissionService,
});
const triggerCapabilityRunHandlers = createTriggerCapabilityRunHandlers({
  bindingRegistry: triggerBindingRegistry,
  inputRepository: hrTrainingCapabilityRunInputRepository,
  isAllowedCallbackUrl: isAllowedHrTrainingCallbackUrl,
  isAllowedContextUrl: isAllowedHrTrainingContextUrl,
  readJsonBody,
  resolveBindingSecret: (binding) => process.env[binding.secretEnvName] || "",
  sendJson,
  submissionService: triggerSubmissionService,
  tenantScope: TRIGGER_TENANT_SCOPE,
});
const hrTrainingContentEvaluationRetryTimers = new Set();
const opsUsageStore = createOpsUsageStore({
  projectRoot,
  storePath: OPS_USAGE_STORE_PATH,
  hashSalt: process.env.OPS_USAGE_HASH_SALT || "digital-workforce-mvp-ops",
  redactError,
});
const digitalEmployeeRuntimeEventStore = createDigitalEmployeeRuntimeEventStore({
  executionTaskRepository: runtimeTaskPersistence.repository,
  projectRoot,
  storePath: DIGITAL_EMPLOYEE_RUNTIME_EVENT_STORE_PATH,
  tenantScope: TRIGGER_TENANT_SCOPE,
  hashSalt: process.env.DIGITAL_EMPLOYEE_RUNTIME_EVENT_HASH_SALT || "digital-workforce-mvp-runtime-events",
  redactError,
  resolveEmployeeIdentity: resolveDigitalEmployeeReadIdentity,
});
const assetPackageDownloadStore = createAssetPackageDownloadStore({
  projectRoot,
  storePath: ASSET_PACKAGE_DOWNLOAD_STORE_PATH,
  hashSalt: process.env.ASSET_PACKAGE_DOWNLOAD_HASH_SALT || "digital-workforce-mvp-asset-package-downloads",
  redactError,
});
const providerCredentialSecretStore = createProviderCredentialSecretStore({
  storePath: PROVIDER_CREDENTIAL_SECRET_STORE_PATH,
  redactError,
});
const fxiaokeCrmCredentialStore = createFxiaokeCrmCredentialStore({
  keyPath: process.env.FXIAOKE_CRM_SECRET_KEY_PATH || path.join(LOCAL_DATA_DIR, ".fxiaoke-crm-secret-key"),
  storePath: FXIAOKE_CRM_CREDENTIAL_STORE_PATH,
});
const fxiaokeCrmServiceClient = createFxiaokeCrmServiceClient({
  baseUrl: process.env.FXIAOKE_CRM_BASE_URL || "https://open.fxiaoke.com",
  credentialProvider: () => fxiaokeCrmCredentialStore.getCredentials() ||
    readFxiaokeCrmCredentials(process.env),
});
const triggerManagementHandlers = createTriggerManagementHandlers({
  businessLocatorRepository: triggerBusinessLocatorRepository,
  configRepository: triggerPersistence.configRepository,
  credentialStatus: (credential) => credential.secretAuthority === "server_environment"
    ? Boolean(String(process.env[credential.secretLocator] || "").trim())
    : credential.secretAuthority === "fxiaoke_crm_credential_vault"
      ? Boolean(fxiaokeCrmCredentialStore.isConfigured() || fxiaokeCrmCredentialsConfigured(process.env))
      : false,
  getDigitalEmployees: currentDigitalEmployees,
  hasPermission,
  readJsonBody,
  requireSession,
  runtimeTaskRepository: runtimeTaskPersistence.repository,
  sendJson,
  tenantScope: TRIGGER_TENANT_SCOPE,
  triggerEventRepository: triggerPersistence.repository,
});
const providerConnectionGovernanceStore = createProviderConnectionGovernanceStore({
  storePath: PROVIDER_CONNECTION_GOVERNANCE_STORE_PATH,
  redactError,
});
const runtimeInfrastructureStore = createRuntimeInfrastructureStore({
  storePath: RUNTIME_INFRASTRUCTURE_STORE_PATH,
  redactError,
});
const systemWorkerConfigStore = createSystemWorkerConfigStore({
  storePath: SYSTEM_WORKER_CONFIG_STORE_PATH,
  redactError,
});
const digitalEmployeeModelBindingStore = createDigitalEmployeeModelBindingStore({
  storePath: DIGITAL_EMPLOYEE_MODEL_BINDING_STORE_PATH,
  redactError,
});
const digitalEmployeeRuntimeConfigStore = createDigitalEmployeeRuntimeConfigStore({
  storePath: DIGITAL_EMPLOYEE_RUNTIME_CONFIG_STORE_PATH,
  redactError,
});
const digitalEmployeeRuntimeConfigService = createDigitalEmployeeRuntimeConfigService({
  aiModelCatalog,
  store: digitalEmployeeRuntimeConfigStore,
});
const scheduleTaskDefinitionEncryptionKeyId = "schedule-task-definition-local-v1";
const scheduleTaskDefinitionRepository = createSqliteScheduleTaskExecutionDefinitionRepository({
  databasePath: SCHEDULE_TASK_EXECUTION_DEFINITION_REPOSITORY_PATH,
  encryptionKeys: {
    [scheduleTaskDefinitionEncryptionKeyId]: deriveScheduleTaskDefinitionKey("encryption.v1"),
  },
  currentEncryptionKeyId: scheduleTaskDefinitionEncryptionKeyId,
  stableIntegrityHmacKey: deriveScheduleTaskDefinitionKey("integrity.v1"),
});
// Only shared Agent definitions may enter new system Schedule execution.
// Immutable historical rows remain in storage for audit, without an executor.
const agentScheduleDefinition = resolution => resolution?.definition?.contractVersion === "schedule-task-execution-definition.v3"
  ? resolution : null;
const resolveTaskExecutionDefinitionVersion = request => agentScheduleDefinition(scheduleTaskDefinitionRepository.resolveVersion(request));
const resolveTaskExecutionDefinitionExact = request => agentScheduleDefinition(scheduleTaskDefinitionRepository.resolveExact(request));
const governedScheduleRepository = createSqliteGovernedScheduleRepository({
  databasePath: GOVERNED_SCHEDULE_REGISTRY_PATH,
});
const governedScheduleRegistry = createGovernedScheduleRegistry({
  aiModelCatalog,
  getProviderRoutes: currentAiProviderRoutes,
  registrarSubjectHmacKey: deriveScheduleServerKey("governed-schedule-registrar-subject.v1"),
  repository: governedScheduleRepository,
  resolveProviderTimeoutPolicy: ({ providerBinding }) => {
    const route = currentAiProviderRoutes().find((item) => item.id === providerBinding.providerRouteId);
    if (!route) throw new TypeError("governed Schedule Provider Route is unavailable");
    return providerTimeoutPolicyForRoute(route);
  },
  resolveTaskExecutionDefinitionExact,
  resolveTaskExecutionDefinitionVersion,
});
const digitalEmployeeLifecycleStore = createDigitalEmployeeLifecycleStore({
  storePath: DIGITAL_EMPLOYEE_LIFECYCLE_STORE_PATH,
  redactError,
});
const digitalEmployeeDepartmentChangeStore = createDigitalEmployeeDepartmentChangeStore({
  storePath: DIGITAL_EMPLOYEE_DEPARTMENT_CHANGE_STORE_PATH,
  redactError,
});
const digitalEmployeeResponsibilityStore = createDigitalEmployeeResponsibilityStore({
  storePath: DIGITAL_EMPLOYEE_RESPONSIBILITY_STORE_PATH,
  redactError,
});
const digitalEmployeeProfileStore = createDigitalEmployeeProfileStore({
  storePath: DIGITAL_EMPLOYEE_PROFILE_STORE_PATH,
  redactError,
});
const providerConnectionHandlers = createProviderConnectionHandlers({
  credentials: aiProviderCredentials,
  getDepartmentDirectory: resolveSystemWorkerDepartmentDirectory,
  governanceStore: providerConnectionGovernanceStore,
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  routes: aiProviderRoutes,
  store: providerCredentialSecretStore,
  workerPools: aiProviderWorkerPools,
});
const runtimeInfrastructureHandlers = createRuntimeInfrastructureHandlers({
  digitalEmployees,
  getDigitalEmployees: currentDigitalEmployees,
  hasPermission,
  probe: createRuntimeInfrastructureProbe(),
  readJsonBody,
  requireSession,
  sendJson,
  store: runtimeInfrastructureStore,
});
const systemWorkerConfigHandlers = createSystemWorkerConfigHandlers({
  aiModelCatalog,
  aiProviderRoutes,
  departments,
  digitalEmployees,
  getDigitalEmployees: currentDigitalEmployees,
  getAiProviderRoutes: currentAiProviderRoutes,
  getDepartmentDirectory: resolveSystemWorkerDepartmentDirectory,
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: systemWorkerConfigStore,
  runtimeConfigService: digitalEmployeeRuntimeConfigService,
  workers: aiPreReviewWorkers,
});
const personnelGovernanceHandlers = createPersonnelGovernanceHandlers({
  canResolveFortressPersonnel,
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: personnelGovernanceStore,
  tryFetchFortressUser,
});
const opsUsageHandlers = createOpsUsageHandlers({
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: opsUsageStore,
});
const opsDiagnosisTaskService = createOpsDiagnosisTaskService({
  repository: runtimeTaskPersistence.repository,
  resolveEmployee: (employeeId) => currentDigitalEmployees().find((item) => item.id === employeeId) || null,
  resolveProviderTimeoutPolicy: ({ employee }) => providerTimeoutPolicyForRoute(
    currentAiProviderRoutes().find((route) => route.id === (
      employee.modelBinding?.providerRouteId || employee.runtimeBinding?.providerRouteId ||
      employee.runtimeBinding?.preferredProviderRouteId || employee.modelBinding?.preferredProviderRouteId ||
      "codex-digital-office-route"
    )),
  ),
  tenantScope: TRIGGER_TENANT_SCOPE,
  workerPump: runtimeTaskWorkerPump,
});
const runtimePerformanceObserver = createOpsRuntimePerformanceObserver();
let runtimeTaskActorDisplayNameCache = null;
const opsIncidentHandlers = createOpsIncidentHandlers({
  diagnosisTaskService: opsDiagnosisTaskService,
  hasPermission,
  readJsonBody,
  referenceHmacKey: deriveTriggerServerKey("ops-incident-reference.v1"),
  requireSession,
  runtimeTaskRepository: runtimeTaskPersistence.repository,
  runtimePerformanceObserver,
  getRuntimeTaskActorDisplayNameCacheSummary: () => runtimeTaskActorDisplayNameCache?.summary?.() || null,
  sendJson,
  tenantScope: TRIGGER_TENANT_SCOPE,
});
let systemImportHandlers;
let digitalEmployeeModelBindingHandlers;
let digitalEmployeeScheduleHandlers;
let digitalEmployeeLifecycleHandlers;
let digitalEmployeeDepartmentChangeHandlers;
let digitalEmployeeResponsibilityHandlers;
let digitalEmployeeProfileHandlers;
const skillHarnessRunner = createSkillHarnessRunner({
  getPublishedSkills: (options = {}) => systemImportHandlers?.listRuntimeBusinessSkills?.(options) || [],
});
const triggerReviewResultRepository = createSqliteTriggerReviewResultRepository({
  databasePath: TRIGGER_REVIEW_RESULT_REPOSITORY_PATH,
  encryptionKey: deriveTriggerServerKey("review-result.encryption.v1"),
  integrityHmacKey: deriveTriggerServerKey("review-result.integrity.v1"),
});
const hrTrainingContentEvaluationResultRepository =
  createSqliteHrTrainingContentEvaluationResultRepository({
    databasePath: HR_TRAINING_CONTENT_EVALUATION_RESULT_REPOSITORY_PATH,
    encryptionKey: deriveTriggerServerKey("hr-training-content-result.encryption.v1"),
    integrityHmacKey: deriveTriggerServerKey("hr-training-content-result.integrity.v1"),
  });
const hrTrainingFollowupAnswerEvaluationResultRepository =
  createSqliteHrTrainingFollowupAnswerEvaluationResultRepository({
    databasePath: HR_TRAINING_FOLLOWUP_ANSWER_EVALUATION_RESULT_REPOSITORY_PATH,
    encryptionKey: deriveTriggerServerKey("hr-training-followup-answer-result.encryption.v1"),
    integrityHmacKey: deriveTriggerServerKey("hr-training-followup-answer-result.integrity.v1"),
  });
const hrTrainingFollowupRoundEvaluationResultRepository =
  createSqliteHrTrainingFollowupRoundEvaluationResultRepository({
    databasePath: HR_TRAINING_FOLLOWUP_ROUND_EVALUATION_RESULT_REPOSITORY_PATH,
    encryptionKey: deriveTriggerServerKey("hr-training-followup-round-result.encryption.v1"),
    integrityHmacKey: deriveTriggerServerKey("hr-training-followup-round-result.integrity.v1"),
  });
const hrTrainingAggregateFeedbackResultRepository =
  createSqliteHrTrainingAggregateFeedbackResultRepository({
    databasePath: HR_TRAINING_AGGREGATE_FEEDBACK_RESULT_REPOSITORY_PATH,
    encryptionKey: deriveTriggerServerKey("hr-training-aggregate-feedback-result.encryption.v1"),
    integrityHmacKey: deriveTriggerServerKey("hr-training-aggregate-feedback-result.integrity.v1"),
  });
const triggerWritebackBindingRegistry = createTriggerWritebackBindingRegistry({
  bindings: triggerConfiguration.writebackBindings,
});
const fxiaokeTriggerMaterialAdapter = createFxiaokeTriggerObjectMaterialAdapter({
  requestJson: fxiaokeCrmServiceClient.requestJson,
  isAllowedDownloadUrl: isAllowedTriggerAttachmentUrl,
});
const fxiaokeTriggerWritebackAdapter = createFxiaokeTriggerObjectReviewWritebackAdapter({
  diagnosticLogger: (record) => {
    console.info("[fxiaoke-writeback]", JSON.stringify(record));
  },
  requestJson: fxiaokeCrmServiceClient.requestJson,
});
const triggerAttachmentWorkspaceService = createTriggerAttachmentWorkspaceService();
const sharedDigitalEmployeeAgentRunner = createResponsesAgentRunner({
  providerAdapterRegistry: createDefaultProviderAdapterRegistry(),
  providerRequestQueue,
  isTaskCancellationRequested: (task) => runtimeTaskService.isCancellationRequested(task),
  recordRuntimeEvidence: runtimeTaskEvidenceRecorder.record,
  recordRuntimeEfficiency: runtimeTaskEvidenceRecorder.recordEfficiency,
});
const sharedDigitalEmployeeAgentExecutionService = createDigitalEmployeeAgentExecutionService({
  agentRunner: sharedDigitalEmployeeAgentRunner,
  recordRuntimeProvenance: runtimeTaskEvidenceRecorder.recordProvenance,
});
const triggerReviewWritebackEffect = createTriggerReviewWritebackEffect({
  idempotentEffectService: runtimeTaskPersistence.idempotentEffectService,
  operationReceiptProjector: runtimeTaskPersistence.operationReceiptProjector,
});
// Local distribution has no preinstalled business Trigger handlers or callback credentials.
// Unknown task definitions remain rejected by the canonical executor registry.
triggerExecutionService = createTriggerExecutionService({
  executorRegistry: createTriggerExecutorRegistry({ handlers: [] }),
});
const controlPlaneHandlers = createControlPlaneHandlers({
  basicSkills,
  businessSkills,
  getBusinessSkills: (options = {}) => systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills,
  capabilityRequests,
  cleanList,
  cleanText,
  digitalEmployees,
  getDigitalEmployees: currentDigitalEmployees,
  distributionPlans,
  getEnterpriseTools: () => toolAssetRepository.catalog(),
  invocationPolicies,
  optionalSession,
  preReviewWorkers: controlPlanePreReviewWorkers,
  qualityEvents,
  readJsonBody,
  sendJson,
  store: controlPlaneStore,
  subsystemRegistry,
  toolResourceCatalogStore: managedReferenceCatalogStore,
  applyCatalogFilters,
});
const desktopSandboxProviderResolver = createDesktopSandboxReleaseProviderResolver({
  artifactDir: process.env.DESKTOP_RELEASE_LOCAL_DIR || "",
  releaseVersion: process.env.DESKTOP_RELEASE_LOCAL_VERSION || "",
});
// Device execution is authorized by the current user's session and Tool
// contract. The local helper is the execution boundary; a release-provider
// manifest must not be a per-run prerequisite.
const desktopSandboxDeviceSessionRegistry = createDesktopSandboxDeviceSessionRegistry();
const desktopSandboxExecutionInputs = createManagedSandboxEphemeralExecutionInputStore();
const desktopSandboxCapabilityGrants = createManagedSandboxTaskCapabilityGrantService();
const desktopSandboxDispatchRepository = createDesktopSandboxDispatchRepositoryAdapter({
  repository: runtimeTaskPersistence.repository,
});
const desktopSandboxExecutionBoundary = createManagedSandboxExecutionBoundary({
  capabilityGrantVerifier: desktopSandboxCapabilityGrants,
  executionInputResolver: desktopSandboxExecutionInputs,
});
const desktopSandboxDispatchService = createDesktopSandboxDispatchService({
  deviceSessionRegistry: desktopSandboxDeviceSessionRegistry,
  dispatchRepository: desktopSandboxDispatchRepository,
  executionBoundary: desktopSandboxExecutionBoundary,
  takeExecutionInput: desktopSandboxExecutionInputs.takeForExecution,
});
const desktopSandboxExecToolPrepareService = createSandboxExecToolPrepareService({
  capabilityGrantService: desktopSandboxCapabilityGrants,
  dispatchService: desktopSandboxDispatchService,
  executionInputs: desktopSandboxExecutionInputs,
});
const desktopSandboxDispatchContextResolver = createDesktopSandboxDispatchContextResolver({
  tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE,
  deviceSessionRegistry: desktopSandboxDeviceSessionRegistry,
  dispatchRepository: desktopSandboxDispatchRepository,
  resolveSessionRoute: resolveCenterSessionRoute,
});
const desktopTaskArtifactStagingService = createDeviceTaskArtifactStagingService({
  repository: runtimeTaskPersistence.repository,
  taskArtifactService,
  workspaceManager: runtimeTaskWorkspaceManager,
});
const desktopSandboxDispatchTransportHandlers = createDesktopSandboxDispatchTransportHandlers({
  dispatchService: desktopSandboxDispatchService,
  isManagedHttpsRequest: managedHttpsRequest,
  resolveActionContext: ({ attemptId, requestContext }) =>
    desktopSandboxDispatchContextResolver.resolveActionContext({ attemptId, requestContext }),
  resolveClaimContext: ({ requestContext }) => desktopSandboxDispatchContextResolver.resolveClaimContext({ requestContext }),
  resolveClaimWaitContext: ({ requestContext, taskId }) =>
    desktopSandboxDispatchContextResolver.resolveClaimWaitContext({ requestContext, taskId }),
});
const desktopTaskArtifactStagingTransportHandlers = createDesktopTaskArtifactStagingTransportHandlers({
  isManagedHttpsRequest: managedHttpsRequest,
  resolveActionContext: (input) => desktopSandboxDispatchContextResolver.resolveActionContext(input),
  stagingService: desktopTaskArtifactStagingService,
});
const digitalEmployeeAccessHandlers = createDigitalEmployeeAccessHandlers({
  getEnterpriseTools: () => toolAssetRepository.catalog(),
  registerDesktopPresenceDevice: input => desktopPresence.registerDevice(input),
  getDigitalEmployees: currentDigitalEmployees,
  getBusinessSkills: (options = {}) => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills)],
  isManagedHttpsRequest: managedHttpsRequest,
  getConversationHistoryBootstrap: async ({ employees, session }) => {
    const sessions = {};
    for (const employee of employees) {
      if (!employee?.access?.callable) continue;
      const route = resolveCenterSessionRoute({ channelId: "desktop", employeeId: employee.id, session });
      const current = await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
      if (current?.sessionId) {
        sessions[employee.id] = { sessionId: current.sessionId, sessionExpiresAt: session.expiresAt };
      }
    }
    const groupSessions = {};
    const groupActor = actorFromSession({ session, tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE, resolveRoute: resolveCenterSessionRoute });
    for (const goal of runtimeTaskPersistence.repository.groups.listActiveGoalSessions(groupActor, { limit: 20 })) {
      const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goal.goalId}` });
      const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(goal.transcriptSessionId);
      if (storedRoute?.routeDigest !== route.routeDigest) continue;
      const transcriptSession = await runtimeSessionPersistence.sessionRepository.readSession(goal.transcriptSessionId);
      if (transcriptSession?.sessionId !== goal.transcriptSessionId || transcriptSession.status !== "active") continue;
      groupSessions[goal.goalId] = {
        employeeId: "group-orchestrator",
        sessionId: goal.transcriptSessionId,
        sessionExpiresAt: session.expiresAt,
      };
    }
    return conversationHistoryPolicyService.bootstrap({ authExpiresAt: session.expiresAt, sessions, groupSessions });
  },
  getCredentialBrokerBootstrap: ({ employees, session }) => dataFlowCredentialBrokerBootstrap({ employees, session }),
  hasPermission,
  desktopSandboxDeviceSessionRegistry,
  desktopSandboxDispatchTransportHandlers,
  desktopTaskArtifactStagingTransportHandlers,
  readJsonBody,
  requireSession,
  sendJson,
  skillHarnessRunner,
  store: controlPlaneStore,
});
const digitalEmployeeCharacterHandlers = createDigitalEmployeeCharacterHandlers({
  requireSession,
  sendJson,
});
const desktopReleaseHandlers = createDesktopReleaseHandlers({
  channel: process.env.DESKTOP_RELEASE_CHANNEL || "",
  localArtifactDir: process.env.DESKTOP_RELEASE_LOCAL_DIR || "",
  localVersion: process.env.DESKTOP_RELEASE_LOCAL_VERSION || "",
  manifestUrl: process.env.DESKTOP_RELEASE_MANIFEST_URL || "",
  requireSession,
  sendJson,
  updatePolicy: readDesktopReleaseUpdatePolicy(),
});
const groupStudioReleaseHandlers = createDesktopReleaseHandlers({
  routeBase: "/api/desktop-releases/group-studio",
  majorVersion: 3,
  channel: process.env.GROUP_STUDIO_RELEASE_CHANNEL || "beta",
  localManifestDir: process.env.GROUP_STUDIO_RELEASE_PUBLISH_DIR || "",
  publicOrigin: FRONTEND_ORIGIN,
  localArtifactDir: process.env.GROUP_STUDIO_RELEASE_LOCAL_DIR || "",
  localVersion: process.env.GROUP_STUDIO_RELEASE_LOCAL_VERSION || "",
  manifestUrl: process.env.GROUP_STUDIO_RELEASE_MANIFEST_URL || "",
  updatePolicy: readGroupStudioReleaseUpdatePolicy(),
  requireSession,
  sendJson,
});
const hrCurrentUserCredentialAudience = String(process.env.HR_TALENTOS_DELEGATED_JWT_AUDIENCE || "hr-talentos").trim();
const hrCurrentUserCredentialIssuer = hrCurrentUserJwtIssuerFromEnvironment(process.env);
const hrTrainingCurrentUserCredentialAudience = String(process.env.HR_TRAINING_DELEGATED_JWT_AUDIENCE || "hr-training-assessment").trim();
const hrTrainingCurrentUserCredentialIssuer = hrTrainingCurrentUserJwtIssuerFromEnvironment(process.env);
const feishuCurrentUserOAuthRedirectUri = String(
  process.env.FEISHU_CURRENT_USER_OAUTH_REDIRECT_URI ||
  (FRONTEND_ORIGIN ? `${trimTrailingSlash(FRONTEND_ORIGIN)}/api/feishu/oauth/callback` : ""),
).trim();
const feishuCurrentUserOAuthIssuer = feishuCurrentUserOAuthRedirectUri
  ? createFeishuCurrentUserOAuthIssuer({
      fetch: globalThis.fetch,
      readEmployeeAppCredentials: (employeeId) => ({
        appId: integrationStateStore.readSecret("appId", employeeId),
        appSecret: integrationStateStore.readSecret("appSecret", employeeId),
      }),
      redirectUri: feishuCurrentUserOAuthRedirectUri,
      store: feishuCurrentUserOAuthStore,
    })
  : null;
const feishuEmployeeAppTokenLeaseService = createFeishuEmployeeAppTokenLeaseService({
  fetch: globalThis.fetch,
  readEmployeeAppCredentials: (employeeId) => ({
    appId: integrationStateStore.readSecret("appId", employeeId),
    appSecret: integrationStateStore.readSecret("appSecret", employeeId),
  }),
});
const dataFlowApiOrigin = httpsOrigin(process.env.DATAFLOW_API_BASE_URL);
const currentUserToolCredentialChallengeBroker = dataFlowApiOrigin ? createCurrentUserToolCredentialChallengeBroker({
  tools: [{
    toolId: "dataflow-rest-api",
    issuerAdapterId: DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID,
    audience: "dataflow",
    apiOrigin: dataFlowApiOrigin,
  }],
}) : null;
const dataFlowDeviceSessionIssuer = currentUserToolCredentialChallengeBroker
  ? createDataFlowDeviceSessionIssuer({ challengeBroker: currentUserToolCredentialChallengeBroker })
  : null;
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
    }, {
      contractVersion: BINDING_CONTRACT_VERSION,
      bindingId: "dataflow-device-current-user",
      bindingVersion: "1",
      credentialMode: CREDENTIAL_MODE,
      issuerAdapterId: DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID,
      audience: "dataflow",
      maxLeaseDurationMs: 5 * 60_000,
      scopeSource: "managed_openapi_operation",
      status: "active",
      toolId: "dataflow-rest-api",
    }],
  }),
  issuerAdapters: [
    hrCurrentUserCredentialIssuer,
    hrTrainingCurrentUserCredentialIssuer,
    feishuCurrentUserOAuthIssuer,
    dataFlowDeviceSessionIssuer,
  ].filter(Boolean),
});
const runtimeToolCapabilities = createRuntimeToolCapabilities({ projectRoot, assetRepository: toolAssetRepository,
  connectionAuthority: toolConnectionAuthority, feishuEmployeeAppTokenLeaseService, managedReferenceCatalogStore });
const managedOpenApiTools = runtimeToolCapabilities.descriptors;
const deviceReadServices = runtimeTaskPersistence.repository.deviceReads ? createDeviceReadCenterServices({
  repository: runtimeTaskPersistence.repository, operations: runtimeToolCapabilities.deviceReadOperations(),
  resolveActor: session => {
    const route = resolveCenterSessionRoute({ session, channelId: "desktop", employeeId: "device-read" });
    return { tenantScope: route.tenantScope, actorDigest: route.actorSubjectDigest };
  },
  resolveRecoverySession: async task => {
    const admission = runtimeTaskService.readExecutionAdmission(task.taskId);
    requireAdmissionTaskMatch(admission, task);
    return resolveExecutionRecoverySession(admission.actorLocator, { sessionId: task.sessionId });
  },
  isPublished: entry => {
    const current = toolAssetRepository.resolvePublished(entry.descriptor.toolId);
    return current?.kind === "builtin" && current.assetRevision === entry.publicationRevision && current.catalog?.credentialMode === entry.descriptor.credentialMode;
  },
  isManagedHttpsRequest: managedHttpsRequest,
}) : null;
const deviceReadRoutes = createDeviceReadRoutes({ transport: deviceReadServices?.transport, requireSession, readJsonBody, sendJson });
const validatePersistentFeishuCredentials = createFeishuCredentialValidator({ fetch: globalThis.fetch });
const resolvePersistentFeishuCurrentUserProfile = createFeishuCurrentUserProfileResolver({
  fetch: globalThis.fetch,
  readSecret: (key, employeeId) => integrationStateStore.readSecret(key, employeeId),
  validateFeishuCredentials: validatePersistentFeishuCredentials,
});
const resolveRuntimeTaskActorDisplayNameFromDirectory = createRuntimeTaskActorDisplayNameResolver({
  cleanText,
  resolveFeishuCurrentUserProfile: resolvePersistentFeishuCurrentUserProfile,
  tryFetchFortressUser,
});
runtimeTaskActorDisplayNameCache = createRuntimeTaskActorDisplayNameCache({
  resolve: resolveRuntimeTaskActorDisplayNameFromDirectory,
  snapshotRepository: runtimeTaskPersistence.actorDisplaySnapshotRepository,
  onResolution: (sample) => runtimePerformanceObserver.record({
    ...sample,
    metricId: "runtime_task_actor_directory_resolution",
  }),
});
const resolveRuntimeTaskActorDisplayName = runtimeTaskActorDisplayNameCache.resolveDisplayName;
const resolveRuntimeTaskSourceDisplayName = ({ task } = {}) => {
  const sourceSystemId = cleanText(task?.sourceSystemId || "");
  if (!sourceSystemId || cleanText(task?.trigger?.channel || "") !== "trigger") return null;
  const sourceSystem = triggerPersistence.configRepository.loadPublishedConfiguration().systems
    .find((item) => item.sourceSystemId === sourceSystemId);
  return sourceSystem ? { displayName: sourceSystem.displayName, source: "trigger-configuration" } : null;
};
const resolveFxiaokeRuntimeTaskBusinessReference = createFxiaokeSaleContractTaskReferenceResolver({
  locatorRepository: triggerBusinessLocatorRepository,
  tenantScope: TRIGGER_TENANT_SCOPE,
}).resolve;
const resolveHrTrainingRuntimeTaskBusinessReference = createHrTrainingTaskReferenceResolver({
  inputRepository: hrTrainingCapabilityRunInputRepository,
  tenantScope: TRIGGER_TENANT_SCOPE,
}).resolve;
const resolveOperationReceiptRuntimeTaskBusinessReference = createOperationReceiptTaskReferenceResolver({
  repository: runtimeTaskPersistence.repository,
  tenantScope: TRIGGER_TENANT_SCOPE,
}).resolve;
const resolveRuntimeTaskBusinessReference = (request) =>
  resolveHrTrainingRuntimeTaskBusinessReference(request) ||
  resolveFxiaokeRuntimeTaskBusinessReference(request) ||
  resolveOperationReceiptRuntimeTaskBusinessReference(request);
let personalAutomationService = null;
const groupArtifactDeliveryAuthorizer = createGroupArtifactDeliveryAuthorizer({
  taskRepository: runtimeTaskPersistence.repository,
});
const digitalEmployeeChatHandlers = createDigitalEmployeeChatHandlers({
  authorizeReferenceTaskArtifact: (input) => groupArtifactDeliveryAuthorizer.authorize(input),
  aiProviderCredentials,
  aiProviderRoutes,
  aiProviderWorkerPools,
  basicSkills,
  businessSkills,
  getBusinessSkills: (options = {}) => systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills,
  getDigitalEmployees: currentDigitalEmployees,
  getAiProviderCredentials: currentAiProviderCredentials,
  getAiProviderRoutes: currentAiProviderRoutes,
  cleanText,
  checkpointRepository: runtimeCheckpointRepository,
  contextCompactionPolicy: runtimeContextCompactionPolicy,
  currentUserToolCredentialLeaseService,
  currentUserToolCredentialChallengeBroker,
  digitalEmployees,
  hasPermission,
  fxiaokeCrmCredentialStore,
  fxiaokeCrmServiceClient,
  idempotentEffectService: runtimeTaskPersistence.idempotentEffectService,
  executionContinuationRepository: runtimeTaskPersistence.executionContinuationRepository,
  operationReceiptProjector: runtimeTaskPersistence.operationReceiptProjector,
  managedOpenApiTools,
  providerRequestQueue,
  providerCredentialSecretStore,
  persistentTaskExecution: true,
  readJsonBody,
  responsesAgentRunner: sharedDigitalEmployeeAgentRunner,
  agentExecutionService: sharedDigitalEmployeeAgentExecutionService,
  requireSession,
  resolveRuntimeTaskActorDisplayName,
  runtimePerformanceObserver,
  resolveRuntimeTaskBusinessReference,
  resolveRuntimeTaskSourceDisplayName,
  resolveSessionRoute: resolveCenterSessionRoute,
  resolveTaskInput: (task) => personalAutomationService?.resolveTaskInput(task) || null,
  getPersonalAutomationService: () => personalAutomationService,
  resolveRecoverySession: resolveExecutionRecoverySession,
  runtimeActivityRecorder: runtimeTaskEvidenceRecorder.recordActivity,
  runtimeEfficiencyRecorder: runtimeTaskEvidenceRecorder.recordEfficiency,
  runtimeEventStore: digitalEmployeeRuntimeEventStore,
  runtimeTaskService,
  sessionRepository: runtimeSessionPersistence.sessionRepository,
  skillHarnessRunner,
  toolParameterContinuationRepository: runtimeTaskPersistence.toolParameterContinuationRepository,
  toolConfirmationRepository: runtimeTaskPersistence.toolCallConfirmationRepository,
  desktopMaterialIntakeService,
  desktopSandboxDeviceSessionRegistry,
  reusableArtifactMaterialService,
  taskArtifactService,
  getGroupExecutionContext: () => groupExecutionContext,
  getGroupTaskRepository: () => runtimeTaskPersistence.repository,
  sandboxExecPrepareService: desktopSandboxExecToolPrepareService,
  deviceReadRuntimeTools: deviceReadServices?.tools,
  bindDeviceReadTask: deviceReadServices?.bindTask,
  canInvokeDigitalEmployee: digitalEmployeeAccessHandlers.canInvoke,
});

const desktopPresence = createDesktopPresence({scopeFor: session => resolveCenterSessionRoute({session,employeeId:"personal-automations",channelId:"desktop"})});
const desktopPresenceHandlers = createDesktopPresenceRoutes({presence:desktopPresence,requireSession,readJsonBody,sendJson});
personalAutomationService = createPersonalAutomationService({
  repository: runtimeTaskPersistence.repository.personalAutomations,
  ownerRepository: runtimeTaskPersistence.personalAutomationOwnerRepository,
  instructionStore: runtimeSessionPersistence.instructionStore,
  runtimeTaskService, sessionRepository: runtimeSessionPersistence.sessionRepository,
  resolveRoute: resolveCenterSessionRoute,
  resolveEmployee: id => currentDigitalEmployees().find(employee => employee.id === id),
  canInvoke: digitalEmployeeAccessHandlers.canInvoke,
  resolveRecoverySession: resolveExecutionRecoverySession,
  permissionDigest: runtimePermissionDigest,
  readDesktopPresence: desktopPresence.read,
  resolveSkillScope: employee => assembleDigitalEmployeeDependencyContext({
    employee, businessSkills:[...basicSkills,...systemImportHandlers.listRuntimeBusinessSkills({})],
  }).callableSkills,
});
const personalAutomationHandlers = createPersonalAutomationRoutes({service:personalAutomationService,requireSession,readJsonBody,sendJson});
const personalAutomationScanner = createDurableScanCoordinator({runOnce:() => personalAutomationService.runOnce(),onFailure:() => console.warn("[personal-automation] scan_failed")});

const feishuIntegrationHandlers = createFeishuIntegrationHandlers({
  aiProviderCredentials,
  aiProviderRoutes,
  businessSkills: [...basicSkills, ...businessSkills],
  checkpointRepository: runtimeCheckpointRepository,
  cleanList,
  cleanText,
  controlPlaneStore,
  contextCompactionPolicy: runtimeContextCompactionPolicy,
  createSessionRoute: runtimeSessionPersistence.createRoute,
  digitalEmployees,
  getDigitalEmployees: currentDigitalEmployees,
  getAiProviderCredentials: currentAiProviderCredentials,
  getAiProviderRoutes: currentAiProviderRoutes,
  getBusinessSkills: (options = {}) => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills)],
  providerRequestQueue,
  providerCredentialSecretStore,
  readJsonBody,
  requireSession,
  runtimeInfrastructureStore,
  sendJson,
  store: integrationStateStore,
  runtimeTaskService,
  runtimeEvidenceRecorder: runtimeTaskEvidenceRecorder.record,
  runtimeEfficiencyRecorder: runtimeTaskEvidenceRecorder.recordEfficiency,
  runtimeProvenanceRecorder: runtimeTaskEvidenceRecorder.recordProvenance,
  persistentTaskExecution: true,
  sessionRepository: runtimeSessionPersistence.sessionRepository,
});
const persistentFeishuGateways = new Map();
function resolvePersistentFeishuTaskExecutor(task) {
  if (task?.channelId !== "feishu" || !task.employeeId) return null;
  let gateway = persistentFeishuGateways.get(task.employeeId);
  if (!gateway) {
    const employeeId = task.employeeId;
    const agentRuntime = createFeishuEmployeeAgentRuntime({
      employeeId,
      agentExecutionService: sharedDigitalEmployeeAgentExecutionService,
      agentRunner: sharedDigitalEmployeeAgentRunner,
      aiProviderCredentials,
      aiProviderRoutes,
      businessSkills: [...basicSkills, ...businessSkills],
      contextCompactionPolicy: runtimeContextCompactionPolicy,
      digitalEmployees,
      fetch: globalThis.fetch,
      getDigitalEmployees: currentDigitalEmployees,
      getAiProviderCredentials: currentAiProviderCredentials,
      getAiProviderRoutes: currentAiProviderRoutes,
      getBusinessSkills: (options = {}) => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills)],
      isTaskCancellationRequested: (candidateTask) => runtimeTaskService.isCancellationRequested(candidateTask),
      providerCredentialSecretStore,
      providerRequestQueue,
      recordRuntimeEvidence: runtimeTaskEvidenceRecorder.record,
      recordRuntimeEfficiency: runtimeTaskEvidenceRecorder.recordEfficiency,
      recordRuntimeProvenance: runtimeTaskEvidenceRecorder.recordProvenance,
    });
    const feishuTurnDispatcher = createFeishuTurnDispatcher({
      agentRuntime,
      businessSkills: [...basicSkills, ...businessSkills],
      confirmationRepository: runtimeTaskPersistence.toolCallConfirmationRepository,
      getBusinessSkills: (options = {}) => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.(options) || businessSkills)],
    });
    gateway = createFeishuEventGateway({
      checkpointRepository: runtimeCheckpointRepository,
      controlPlaneStore,
      createSessionRoute: runtimeSessionPersistence.createRoute,
      createToolExecutor: ({ decision, employee, executionIdentity, materialToolExecutor }) => createEmployeeToolExecutor({
        additionalExecutors: [materialToolExecutor],
        authorizeToolCall: (toolCall, operation, allOperations) => feishuTurnDispatcher.authorizeToolCall({
          allOperations,
          decision,
          operation,
          toolCall,
        }),
        currentUserToolCredentialLeaseService,
        employee,
        executionIdentity,
        idempotentEffectService: runtimeTaskPersistence.idempotentEffectService,
        managedOpenApiTools,
        operationReceiptProjector: runtimeTaskPersistence.operationReceiptProjector,
        toolCompletionPolicies: skillToolCompletionPolicies(decision?.dependencyContext?.callableSkills),
      }),
      employeeId,
      fetch: globalThis.fetch,
      persistentTaskExecution: true,
      resolveEmployee: (candidateEmployeeId) => currentDigitalEmployees().find((employee) => employee.id === candidateEmployeeId) || null,
      runtimeTaskService,
      resolveCurrentUserToolProfile: ({ employee, ...input }) => (
        [...(employee?.toolBindings || employee?.tools || [])].some((binding) =>
          [binding?.id, binding?.toolId].includes("hr-training-assessment-api") && binding?.enabled !== false)
          ? resolvePersistentFeishuCurrentUserProfile(input)
          : null
      ),
      sessionRepository: runtimeSessionPersistence.sessionRepository,
      toolParameterContinuationRepository: runtimeTaskPersistence.toolParameterContinuationRepository,
      skillHarnessRunner,
      store: integrationStateStore,
      turnDispatcher: feishuTurnDispatcher,
      validateFeishuCredentials: validatePersistentFeishuCredentials,
    });
    persistentFeishuGateways.set(employeeId, gateway);
  }
  return gateway.resolvePersistentTaskExecutor(task);
}
systemImportHandlers = createSystemImportHandlers({
  assetPackageDownloadStore,
  basicSkills,
  businessSkills,
  cleanList,
  cleanText,
  digitalEmployees,
  externalAuditRequests,
  getSkillMountRequests: () => controlPlaneStore.readSkillMountRequests(),
  getPreReviewWorkers: systemWorkerConfigHandlers.listRuntimeAuxiliaryWorkers,
  hasPermission,
  preReviewWorkers: aiPreReviewWorkers,
  readJsonBody: (req) => readJsonBody(req, 14 * 1024 * 1024),
  requireSession,
  sendJson,
  onPublishedBusinessSkillHead: () => applyPublishedSkillPolicyHeadPromotion({
    configRepository: triggerPersistence.configRepository,
    publishedBusinessSkills: loadSystemImportStore(SYSTEM_IMPORT_STORE_PATH).publishedBusinessSkills,
  }),
  systemImportStorePath: SYSTEM_IMPORT_STORE_PATH,
  evaluationDatasetStorePath: EVALUATION_DATASET_STORE_PATH,
});
const startupHarnessReadiness = await inspectPublishedSkillHarnessReadiness({
  publishedSkills: Object.values(loadSystemImportStore(SYSTEM_IMPORT_STORE_PATH).publishedBusinessSkills || {}),
  skillHarnessRunner,
});
if (!startupHarnessReadiness.ok) {
  console.error("[auth-server] published Skill Harness preflight failed", startupHarnessReadiness);
  process.exitCode = 1;
  throw new Error("published_skill_harness_preflight_failed");
}
digitalEmployeeProfileHandlers = createDigitalEmployeeProfileHandlers({
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: digitalEmployeeProfileStore,
});
digitalEmployeeDepartmentChangeHandlers = createDigitalEmployeeDepartmentChangeHandlers({
  businessSkills,
  getDirectory: resolveDigitalEmployeeDepartmentDirectory,
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: digitalEmployeeDepartmentChangeStore,
});
digitalEmployeeResponsibilityHandlers = createDigitalEmployeeResponsibilityHandlers({
  getDirectory: resolveDigitalEmployeeDepartmentDirectory,
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: digitalEmployeeResponsibilityStore,
});
digitalEmployeeModelBindingHandlers = createDigitalEmployeeModelBindingHandlers({
  aiModelCatalog,
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  requireSession,
  runtimeConfigService: digitalEmployeeRuntimeConfigService,
  sendJson,
  store: digitalEmployeeModelBindingStore,
});
const scheduleRuntime = createScheduleRuntimeComposition({
  tenantScope: GOVERNED_SCHEDULE_TENANT_SCOPE,
  controlDatabasePath: SCHEDULE_CONTROL_REPOSITORY_PATH,
  triggerDatabasePath: SCHEDULE_TRIGGER_REPOSITORY_PATH,
  registry: governedScheduleRegistry,
  resolveEmployee: ({ employeeId }) => currentDigitalEmployees().find(employee => employee.id === employeeId),
  getBusinessSkills: () => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.() || businessSkills)],
  resolveDefinition: resolveTaskExecutionDefinitionExact,
  deriveKey: deriveScheduleServerKey,
  executionTaskRepository: runtimeTaskPersistence.repository,
  agentExecutionService: sharedDigitalEmployeeAgentExecutionService,
  workspaceManager: runtimeTaskWorkspaceManager, taskArtifactService,
  resolveProviderLease: ({ employee, taskModelBinding }) => {
    const providerRoute = currentAiProviderRoutes().find(route => route.id === taskModelBinding.providerRouteId) || {};
    const providerCredential = currentAiProviderCredentials().find(credential => credential.id === providerRoute.credentialId) || {};
    return resolveManagedProviderLease({ employee, providerBinding: taskModelBinding, providerRoute, providerCredential,
      providerCredentialSecret: providerCredentialSecretStore.getSecret(providerCredential.id) });
  },
  managedOpenApiTools,
  idempotentEffectService: runtimeTaskPersistence.idempotentEffectService,
  operationReceiptProjector: runtimeTaskPersistence.operationReceiptProjector,
  authorizeManagementSession: session => Boolean(session) && isScheduleSystemAdmin(session, hasPermission),
  managementActor: scheduleManagementActor,
  wakeWorker: () => runtimeTaskWorkerPump.wake(),
});
const scheduleControlRepository = scheduleRuntime.controlRepository;
const scheduleCancellationCoordinator = createScheduleCancellationCoordinator({
  dispatcher: createScheduleCancellationDispatcher({ controlRepository: scheduleControlRepository,
    executionTaskRepository: runtimeTaskPersistence.repository, tenantScope: GOVERNED_SCHEDULE_TENANT_SCOPE,
    workerPump: runtimeTaskWorkerPump }),
});
const scheduleOperationsService = createScheduleOperationsService({
  activationCapabilityManifest: { runLedger: true, workerLifecycle: true, scannerCoordinator: true,
    resultParserAlerting: false, continuousStopDispatcher: true },
  controlRepository: scheduleControlRepository,
  getCanonicalTask: (taskId, { tenantScope }) => runtimeTaskPersistence.repository.get(taskId, { tenantScope }),
  listTaskArtifacts: request => runtimeTaskPersistence.repository.listArtifacts(request),
  getRegisteredSchedule: ({ employeeId, scheduleId, tenantScope }) => governedScheduleRepository.get(scheduleId, { employeeId, tenantScope }),
  wakeCancellation: () => scheduleCancellationCoordinator.wake(),
});
const scheduleConfigurationService = createScheduleConfigurationService({
  registry: governedScheduleRegistry, repository: governedScheduleRepository,
  definitionRepository: scheduleTaskDefinitionRepository, controlRepository: scheduleControlRepository,
  tenantScope: GOVERNED_SCHEDULE_TENANT_SCOPE,
  resolveEmployee: ({ employeeId }) => currentDigitalEmployees().find(employee => employee.id === employeeId),
  getBusinessSkills: () => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.() || businessSkills)],
});
digitalEmployeeScheduleHandlers = createDigitalEmployeeScheduleHandlers({
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  registry: governedScheduleRegistry,
  operationsService: scheduleOperationsService,
  requireSession,
  sendJson,
  tenantScope: GOVERNED_SCHEDULE_TENANT_SCOPE,
  manualExecutionService: scheduleRuntime.manualExecutionService,
  configurationService: scheduleConfigurationService,
  taskArtifactService,
});
digitalEmployeeLifecycleHandlers = createDigitalEmployeeLifecycleHandlers({
  getDigitalEmployees: () => currentDigitalEmployees({}),
  hasPermission,
  readJsonBody,
  requireSession,
  sendJson,
  store: digitalEmployeeLifecycleStore,
});
async function persistGroupTextReference({ session, goalId, idempotencyKey, text, sessionId = "" }) {
  const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goalId}` });
  const opened = sessionId
    ? await runtimeSessionPersistence.sessionRepository.readSession(sessionId)
    : await runtimeSessionPersistence.sessionRepository.openSession({ route });
  const storedRoute = opened && await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(opened.sessionId);
  if (!opened || !storedRoute || storedRoute.routeDigest !== route.routeDigest || opened.status !== "active") throw groupContractError("group_objective_reference_invalid");
  const appended = await runtimeSessionPersistence.sessionRepository.appendTranscriptEntry({
    route, sessionId: opened.sessionId, expectedRevision: opened.revision, idempotencyKey,
    entry: { type: "message", message: { role: "user", content: text } },
  });
  return { kind: "transcript_entry", refId: appended.entry.entryId };
}

function groupTurnPlanningState({ plannerTask = null, planDraft = null, goalRevision, adopted = false } = {}) {
  if (planDraft) return {
    planningStatus: "draft_ready",
    result: { kind: "plan_draft", goalRevision, ...(adopted ? { adopted: true } : {}) },
  };
  const status = plannerTask?.status;
  if (["queued", "running", "waiting", "pending"].includes(status)) return { planningStatus: "planning" };
  if (status === "canceled") return { planningStatus: "canceled" };
  if (["failed", "timed_out", "lost"].includes(status)) return {
    planningStatus: "failed",
    ...(plannerTask?.lastErrorCode ? { errorCode: safeGroupRequestErrorCode(plannerTask.lastErrorCode) } : {}),
  };
  return { planningStatus: "unknown" };
}
const groupReviewOpinionReader = createGroupReviewOpinionReader({
  taskRepository: runtimeTaskPersistence.repository, taskArtifactService,
  authorizeReviewer: ({ session, step }) => {
    const employee = currentDigitalEmployees().find(item => item.id === step.employeeId && String(item.version) === step.employeeVersion);
    return Boolean(employee && evaluateDigitalEmployeeEntitlement({ employee, session, channelId: "desktop" }).callable);
  },
});
const groupPlannerAgent = createTaskPlannerAgent({
  resolveReviewerFeedback: input => groupReviewOpinionReader.readForGoal(input),
  runAgentTurn: input => digitalEmployeeChatHandlers.runInternalAgentTurn(input),
  resolveEmployee: ({ session, employeeId }) => {
    const employee = currentDigitalEmployees().find(item => item.id === employeeId);
    return employee && evaluateDigitalEmployeeEntitlement({ employee, session, channelId: "management_console" }).callable ? employee : null;
  },
  resolveSkills: () => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.({}) || businessSkills)],
  createInstructionReference: ({ session, goalId, stepId, requestId, instruction }) => persistGroupTextReference({
    session, goalId, idempotencyKey: `group-instruction:${groupContentDigest({ requestId, stepId })}`, text: instruction,
  }),
});
const groupTaskAdmission = createReferenceTaskAdmissionService({
  admissionRepository: runtimeTaskPersistence.admissionRepository,
  taskRepository: runtimeTaskPersistence.repository,
  resolveRecoverySession: resolveExecutionRecoverySession,
  resolveActor: ({ session }) => actorFromSession({
    session, tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE, resolveRoute: resolveCenterSessionRoute,
  }),
  resolveEmployee: (employeeId) => currentDigitalEmployees().find(employee => employee.id === employeeId) || null,
  canInvokeEmployee: ({ session, employee, channelId }) => evaluateDigitalEmployeeEntitlement({ employee, session, channelId }).callable,
});
const groupExecutionContext = createGroupExecutionContext({
  taskRepository: runtimeTaskPersistence.repository,
  readTaskMaterialBindings: (taskId, options) => runtimeTaskPersistence.taskMaterialBindingRepository.getSet(taskId, options)?.bindings || [],
  resolveStepMaterialBindings: (context) => groupMaterialBindingResolver.resolveStep(context),
  authorizeTask: async ({ task }) => {
    await groupTaskAdmission.recover(task);
    return true;
  },
});
const groupTaskExecutor = createGroupTaskExecutor({
  contextResolver: groupExecutionContext,
  agentExecutionService: sharedDigitalEmployeeAgentExecutionService,
  getBusinessSkills: () => [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.({}) || businessSkills)],
  providerLeaseResolver: ({ employee }) => resolveTriggerReviewProviderLease(employee),
  taskArtifactService,
  workspaceManager: runtimeTaskWorkspaceManager,
  createToolExecutor: ({ employee, identity, context, task, ownership, dependencyContext }) =>
    digitalEmployeeChatHandlers.createGroupToolExecutor({
      employee, executionIdentity: identity, dependencyContext, task, ownership, context,
    }),
  recoverAdmission: (task) => groupTaskAdmission.recover(task),
  resolveInputs: async ({ context, session }) => {
    const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${context.goalId}` });
    const current = await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
    const transcript = current ? await runtimeSessionPersistence.sessionRepository.readTranscript(current.sessionId) : [];
    const textFor = ref => ref?.kind === "transcript_entry"
      ? transcript.find(entry => entry.entryId === ref.refId && entry.type === "message")?.message?.content : null;
    // Missing or fabricated references must fail before any Provider call.
    return { objectiveText: textFor(context.objectiveRef), instructionText: textFor(context.instructionRef), references: context.dependencyRefs || [] };
  },
});
const groupRunCoordinator = createGroupRunCoordinator({
  taskRepository: runtimeTaskPersistence.repository,
  authorizeRun: async () => true,
  authorizeStep: async ({ session, step }) => {
    const employee = currentDigitalEmployees().find((item) => item.id === step.employeeId && String(item.version || "") === step.employeeVersion);
    return Boolean(employee && evaluateDigitalEmployeeEntitlement({ employee, session, channelId: "desktop" }).callable);
  },
  verifyDependency: async ({ actor, binding }) => {
    const task = binding?.taskId ? runtimeTaskPersistence.repository.get(binding.taskId, { tenantScope: actor.tenantScope }) : null;
    return task?.status === "completed";
  },
  artifactDependencyGate: createGroupArtifactDependencyGate({
    readGrant: (input) => runtimeTaskPersistence.repository.readReusableArtifactGrant(input),
  }),
  resolveStepMaterialBindings: (context) => groupMaterialBindingResolver.resolveStep(context),
  buildSubmission: async ({ actor, session, step, run, materialBindings = [] }) => {
    const key = groupContentDigest({ tenantScope: actor.tenantScope, actorIssuer: actor.actorIssuer, actorSubjectDigest: actor.actorSubjectDigest, runId: run.runId, planId: run.planId, planRevision: run.planRevision, stepId: step.stepId, round: step.round });
    const now = new Date().toISOString();
    const submission = { taskId: `group_task_${key}`, ...actor, employeeId: step.employeeId, employeeVersion: step.employeeVersion, sessionId: null, sourceSystemId: "group_studio", channelId: "desktop", taskType: "group_step", submissionScope: `group:${run.runId}`, idempotencyKey: key, inputDigest: groupContentDigest(step), executionInputRef: step.instructionRef, maxRecoveries: 0, createdAt: now, availableAt: now };
    await groupTaskAdmission.prepare({ task: submission, session });
    if (materialBindings.length) {
      const routeDigest = groupContentDigest({ tenantScope: actor.tenantScope, actorIssuer: actor.actorIssuer, actorSubjectDigest: actor.actorSubjectDigest, runId: run.runId, planRevision: run.planRevision, stepId: step.stepId });
      runtimeTaskPersistence.taskMaterialBindingRepository.saveSetOrGet(createTaskMaterialBindingSet({
        descriptors: materialBindings,
        routeDigest,
        submission,
        transcriptEntryId: null,
      }));
    }
    return submission;
  },
  workerPump: runtimeTaskWorkerPump,
});
async function findGroupPlannerTask({ actor, session, goal }) {
  const context = goal?.planningContext;
  if (!context?.plannerRequestId || !goal?.goalId) return null;
  const sessionKey = runtimeSessionKey({ channelId: "management_console", employeeId: "task-planner-agent", session, conversationScope: `goal:${goal.goalId}` });
  const route = resolveCenterSessionRoute({ channelId: "management_console", employeeId: "task-planner-agent", session, sessionKey });
  const current = await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
  if (!current) return null;
  const turnKey = `runtime-turn:${crypto.createHash("sha256").update(`${context.plannerRequestId}:message:user`).digest("hex")}`;
  const transcript = await runtimeSessionPersistence.sessionRepository.readTranscript(current.sessionId);
  const input = transcript.find(entry => entry.type === "message" && entry.message?.role === "user" && entry.idempotencyKey === turnKey);
  if (!input) return null;
  const tasks = runtimeTaskPersistence.repository.listByActor({ ...actor, employeeIds: ["task-planner-agent"], limit: 64, order: "recent" });
  const task = tasks.find(item => item.channelId === "management_console" && item.taskType === "digital_employee_chat" &&
    item.sessionId === current.sessionId && item.executionInputRef?.refId === input.entryId);
  let plannerInput = null;
  try {
    const parsed = JSON.parse(String(input.message?.content || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      plannerInput = {
        objective: typeof parsed.objective === "string" ? parsed.objective : "",
        inputRefs: Array.isArray(parsed.inputRefs) ? parsed.inputRefs : [],
        planningHints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        resourceScope: Array.isArray(parsed.resourceScope) ? parsed.resourceScope : [],
        completionConditions: Array.isArray(parsed.completionConditions) ? parsed.completionConditions : [],
        budget: parsed.budget && typeof parsed.budget === "object" ? parsed.budget : null,
      };
    }
  } catch { /* encrypted transcript input remains unavailable to the route */ }
  return task ? { taskId: task.taskId, status: task.status, lastErrorCode: task.lastErrorCode || null, plannerInput } : null;
}
async function groupGoalDisplayEntry({ session, goal }) {
  const sessionId = goal.transcriptSessionId;
  if (!sessionId || goal.objectiveRef?.kind !== "transcript_entry") return null;
  const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(sessionId);
  const expectedRoute = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goal.goalId}` });
  if (!storedRoute || storedRoute.routeDigest !== expectedRoute.routeDigest) return null;
  const transcript = await runtimeSessionPersistence.sessionRepository.readTranscript(sessionId);
  return transcript.find(item => item.entryId === goal.objectiveRef.refId && item.type === "message" && item.message?.role === "user") || null;
}
const groupStudioHandlers = createGroupStudioHandlers({
  workItemDisplayRepository: runtimeTaskPersistence.workItemDisplayRepository,
  resolveGoalCreatedAt: async context => (await groupGoalDisplayEntry(context))?.createdAt || null,
  resolveReviewerSkill: () => (systemImportHandlers?.listRuntimeBusinessSkills?.({}) || businessSkills)
    .find(skill => skill.id === groupStudioRoleSkills.reviewer) || null,
  deliveryAcceptance: createGroupDeliveryAcceptance({
    taskRepository: runtimeTaskPersistence.repository, taskArtifactService,
    authorizeStep: ({ session, step }) => {
      const employee = currentDigitalEmployees().find(item => item.id === step.employeeId && String(item.version) === step.employeeVersion);
      return Boolean(employee && evaluateDigitalEmployeeEntitlement({ employee, session, channelId: "desktop" }).callable);
    },
  }),
  reviewOpinionReader: groupReviewOpinionReader,
  plannerAgent: groupPlannerAgent,
  savePlannerInput: async (input) => {
    await persistGroupTextReference({ session: input.session, goalId: input.planContext.goalId,
      idempotencyKey: `group-planning-input:${input.requestId}`, text: JSON.stringify(groupPlanningInputSnapshot(input)) });
  },
  readPlannerInput: async ({ session, goal, groupVersion }) => {
    const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goal.goalId}` });
    const current = await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
    if (!current) return null;
    const transcript = await runtimeSessionPersistence.sessionRepository.readTranscript(current.sessionId);
    const entry = transcript.find(item => item.type === "message" && item.idempotencyKey === `group-planning-input:${goal.planningContext.plannerRequestId}`);
    if (!entry) return null;
    let snapshot;
    try { snapshot = JSON.parse(entry.message.content); } catch { throw groupContractError("group_planner_input_unavailable"); }
    return readGroupPlanningInputSnapshot(snapshot, goal, groupVersion);
  },
  resolveMessageMembers: ({ session, members }) => members.map(member => {
    const employee = currentDigitalEmployees().find(item => item.id === member.employeeId && item.version === member.employeeVersion);
    if (!employee || !evaluateDigitalEmployeeEntitlement({ employee, session, channelId: "desktop" }).callable) return null;
    const context = assembleDigitalEmployeeDependencyContext({ employee,
      businessSkills: [...basicSkills, ...(systemImportHandlers?.listRuntimeBusinessSkills?.({}) || businessSkills)] });
    return { id: employee.id, version: employee.version, name: employee.name, title: employee.title, objective: employee.objective,
      capabilities: context.capabilityScope?.activeCapabilities || [], skills: context.callableSkills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, outputs: skill.outputs })) };
  }).filter(Boolean),
  coordinator: groupRunCoordinator,

  groups: runtimeTaskPersistence.repository.groups,
  runtimeTaskRepository: runtimeTaskPersistence.repository,
  findPlannerTask: findGroupPlannerTask,
  cancelPlannerTask: ({ session, taskId }) => runtimeTaskService.cancelTask({ actor: session, employeeId: "task-planner-agent", taskId, reasonCode: "operator_requested" }),
  groupMaterialReferenceService,
  requireSession,
  resolveActor: (session) => actorFromSession({
    session,
    tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE,
    resolveRoute: resolveCenterSessionRoute,
  }),
  readJsonBody,
  sendJson,
  resolveGoalTitle: async ({ session, goal }) => {
    const originalGoal = runtimeTaskPersistence.repository.groups.readGoal(actorFromSession({ session, tenantScope: process.env.SESSION_FOUNDATION_TENANT_SCOPE, resolveRoute: resolveCenterSessionRoute }), goal.goalId, 1) || goal;
    const entry = await groupGoalDisplayEntry({ session, goal: originalGoal });
    return conciseWorkItemTitle(entry?.message?.content) || null;
  },
  readObjectiveReference: async ({ session, goal }) => {
    const sessionId = goal.transcriptSessionId;
    if (!sessionId) throw groupContractError("group_objective_reference_invalid");
    const expectedRoute = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goal.goalId}` });
    const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(sessionId);
    if (!storedRoute || storedRoute.routeDigest !== expectedRoute.routeDigest) throw groupContractError("group_objective_reference_invalid");
    const transcript = await runtimeSessionPersistence.sessionRepository.readTranscript(sessionId) || [];
    const entry = transcript.find(item => item.entryId === goal.objectiveRef?.refId && item.type === "message" && item.message?.role === "user");
    const objective = typeof entry?.message?.content === "string" ? entry.message.content.trim() : "";
    if (!objective) throw groupContractError("group_objective_reference_invalid");
    return objective;
  },
  resolveStepObjectives: async ({ actor, session, run, plan }) => {
    const goal = runtimeTaskPersistence.repository.groups.readGoal(actor, run.goalId, run.goalRevision);
    if (!goal || goal.goalId !== plan.goalId || goal.revision !== plan.goalRevision) return {};
    const draft = goal.planningContext?.plannerRequestId
      ? runtimeTaskPersistence.repository.groups.readDraft(actor, goal.planningContext.plannerRequestId, 0) : null;
    if (!draft || draft.goalId !== plan.goalId || draft.goalRevision !== plan.goalRevision) return {};
    const groupVersion = runtimeTaskPersistence.repository.groups.readGroupVersion(actor, draft.groupId, draft.groupVersion);
    let plannerTask;
    try { plannerTask = await findGroupPlannerTask({ actor, session, goal }); }
    catch { return {}; }
    if (!groupVersion || plannerTask?.status !== "completed" || !plannerTask.taskId) return {};
    const plannerKey = runtimeSessionKey({ channelId: "management_console", employeeId: "task-planner-agent", session, conversationScope: `goal:${goal.goalId}` });
    const plannerRoute = resolveCenterSessionRoute({ channelId: "management_console", employeeId: "task-planner-agent", session, sessionKey: plannerKey });
    let plannerSession, entries;
    try {
      plannerSession = await runtimeSessionPersistence.sessionRepository.readCurrentSession(plannerRoute);
      if (!plannerSession || (await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(plannerSession.sessionId))?.routeDigest !== plannerRoute.routeDigest) return {};
      entries = await runtimeSessionPersistence.sessionRepository.readTranscript(plannerSession.sessionId) || [];
    } catch { return {}; }
    const output = entries.find(entry => entry.type === "message" && entry.message?.role === "assistant" && entry.message.taskId === plannerTask.taskId);
    const answer = output && projectGroupPlannerDisplay({ response: output.message.content, draft, groupVersion });
    if (!answer) return {};
    const counts = new Map();
    for (const step of plan.steps) counts.set(step.employeeId, (counts.get(step.employeeId) || 0) + 1);
    return Object.fromEntries(plan.steps.flatMap(step => {
      const assignment = answer.recommendations.find(item => item.employeeId === step.employeeId)?.assignment;
      return counts.get(step.employeeId) === 1 && assignment ? [[step.stepId, assignment]] : [];
    }));
  },
  resolveGoalConversation: async ({ actor, session, goal, revisions }) => {
    const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goal.goalId}` });
    const transcriptSession = goal.transcriptSessionId
      ? await runtimeSessionPersistence.sessionRepository.readSession(goal.transcriptSessionId)
      : null;
    const transcriptRoute = goal.transcriptSessionId
      ? await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(goal.transcriptSessionId)
      : null;
    if (!transcriptSession || transcriptSession.sessionId !== goal.transcriptSessionId ||
      !transcriptRoute || transcriptRoute.routeDigest !== route.routeDigest) {
      throw groupContractError("group_objective_reference_invalid");
    }
    const turnsByRef = new Map();
    let legacyUnreconstructible = false;
    const sortedRevisions = revisions.filter(item => item.goalId === goal.goalId).sort((a, b) => a.revision - b.revision);
    const transcriptBySession = new Map();
    const uniqueRefs = new Map();
    for (const revision of sortedRevisions.slice(-100)) {
      const ref = revision.turnInputRef?.kind === "transcript_entry" ? revision.turnInputRef
        : revision.revision === 1 && revision.objectiveRef?.kind === "transcript_entry" ? revision.objectiveRef : null;
      if (!ref || !revision.transcriptSessionId) { legacyUnreconstructible = true; continue; }
      const key = `${revision.transcriptSessionId}:${ref.refId}`;
      if (!uniqueRefs.has(key)) uniqueRefs.set(key, { revision: revision.revision, sessionId: revision.transcriptSessionId, refId: ref.refId });
    }
    const turnStateByRevision = new Map();
    for (const revision of sortedRevisions.slice(-100)) {
      const plannerTask = revision.planningContext
        ? await findGroupPlannerTask({ actor, session, goal: revision })
        : null;
      const planDraft = revision.planningContext?.plannerRequestId
        ? runtimeTaskPersistence.repository.groups.readDraft(actor, revision.planningContext.plannerRequestId, 0)
        : null;
      const state = groupTurnPlanningState({ plannerTask, planDraft, goalRevision: revision.revision,
        adopted: Boolean(planDraft && runtimeTaskPersistence.repository.groups.hasPlanOrRun(actor, revision.goalId, revision.revision)) });
      if (planDraft && plannerTask?.status === "completed" && plannerTask.taskId) {
        const plannerKey = runtimeSessionKey({ channelId: "management_console", employeeId: "task-planner-agent", session, conversationScope: `goal:${goal.goalId}` });
        const plannerRoute = resolveCenterSessionRoute({ channelId: "management_console", employeeId: "task-planner-agent", session, sessionKey: plannerKey });
        const plannerSession = await runtimeSessionPersistence.sessionRepository.readCurrentSession(plannerRoute);
        const groupVersion = runtimeTaskPersistence.repository.groups.readGroupVersion(actor, planDraft.groupId, planDraft.groupVersion);
        if (plannerSession && groupVersion) {
          const verified = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(plannerSession.sessionId);
          if (verified?.routeDigest === plannerRoute.routeDigest) {
            const entries = await runtimeSessionPersistence.sessionRepository.readTranscript(plannerSession.sessionId) || [];
            const output = entries.find(entry => entry.type === "message" && entry.message?.role === "assistant" && entry.message.taskId === plannerTask.taskId);
            const answer = output && projectGroupPlannerDisplay({ response: output.message.content, draft: planDraft, groupVersion });
            if (answer) state.answer = answer;
          }
        }
      }
      turnStateByRevision.set(revision.revision, state);
    }
    for (const [key, ref] of uniqueRefs) {
      let entries = transcriptBySession.get(ref.sessionId);
      if (!entries) {
        const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(ref.sessionId);
        if (storedRoute?.routeDigest !== route.routeDigest) { legacyUnreconstructible = true; continue; }
        entries = await runtimeSessionPersistence.sessionRepository.readTranscript(ref.sessionId) || [];
        transcriptBySession.set(ref.sessionId, entries);
      }
      const entry = entries.find(item => item.entryId === ref.refId && item.type === "message" && item.message?.role === "user");
      if (typeof entry?.message?.content === "string") turnsByRef.set(key, {
        revision: ref.revision, text: entry.message.content, createdAt: entry.createdAt,
        ...turnStateByRevision.get(ref.revision),
      });
      else legacyUnreconstructible = true;
    }
    const turns = [...turnsByRef.values()].sort((a, b) => a.revision - b.revision);
    const latestTurnState = turnStateByRevision.get(goal.revision) || { planningStatus: "unknown" };
    return {
      contractVersion: "group-goal-display-history.v1",
      transcriptSessionId: goal.transcriptSessionId,
      sessionRevision: transcriptSession.revision,
      sessionStatus: transcriptSession.status,
      sessionUpdatedAt: transcriptSession.updatedAt,
      turns,
      status: latestTurnState.planningStatus,
      ...(latestTurnState.errorCode ? { errorCode: latestTurnState.errorCode } : {}),
      ...(latestTurnState.result ? { result: latestTurnState.result } : {}),
      ...(legacyUnreconstructible ? { warning: "历史原话无法按轮次还原，未对累计目标作推测拆分。" } : {}),
      ...(sortedRevisions.length > 100 ? { truncated: true } : {}),
    };
  },
  createObjectiveReference: async ({ session, goalId, objective, previousObjectiveRef = null, previousTranscriptSessionId = "", operationId = "" }) => {
    const route = resolveCenterSessionRoute({ channelId: "group_orchestrator", employeeId: "group-orchestrator", session, sessionKey: `group:${goalId}` });
    let previousObjective = "";
    let previousSessionId = previousTranscriptSessionId;
    if (previousObjectiveRef?.kind === "transcript_entry" && previousObjectiveRef.refId) {
      const current = previousSessionId
        ? await runtimeSessionPersistence.sessionRepository.readSession(previousSessionId)
        : await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
      if (!current?.sessionId) throw groupContractError("group_objective_reference_invalid");
      const storedRoute = await runtimeSessionPersistence.sessionRepository.readVerifiedRoute(current.sessionId);
      if (!storedRoute || storedRoute.routeDigest !== route.routeDigest) throw groupContractError("group_objective_reference_invalid");
      const transcript = await runtimeSessionPersistence.sessionRepository.readTranscript(current.sessionId) || [];
      const entry = transcript.find(item => item.entryId === previousObjectiveRef.refId && item.type === "message" && item.message?.role === "user");
      previousObjective = typeof entry?.message?.content === "string" ? entry.message.content.trim() : "";
      if (!previousObjective) throw groupContractError("group_objective_reference_invalid");
      previousSessionId = current.sessionId;
    }
    const currentObjective = [previousObjective, String(objective || "").trim()].filter(Boolean).join("\n\n");
    if (!currentObjective || currentObjective.length > 12000) throw groupContractError("group_objective_context_too_large");
    const suffix = operationId ? `:${operationId}` : "";
    const activeSession = await runtimeSessionPersistence.sessionRepository.readCurrentSession(route);
    let transcriptSessionId = activeSession?.status === "active" ? activeSession.sessionId : "";
    if (!transcriptSessionId) {
      const opened = await runtimeSessionPersistence.sessionRepository.openSession({ route });
      transcriptSessionId = opened.sessionId;
    }
    const turnInputRef = operationId && previousObjectiveRef?.kind === "transcript_entry"
      ? await persistGroupTextReference({ session, goalId, idempotencyKey: `group-turn:${goalId}:${operationId}`, text: String(objective || "").trim(), sessionId: transcriptSessionId })
      : await persistGroupTextReference({ session, goalId, idempotencyKey: `group-objective:${goalId}${suffix}`, text: String(objective || "").trim(), sessionId: transcriptSessionId });
    const objectiveRef = operationId && previousObjectiveRef?.kind === "transcript_entry"
      ? await persistGroupTextReference({ session, goalId, idempotencyKey: `group-objective:${goalId}${suffix}`, text: currentObjective, sessionId: transcriptSessionId, createdAt: turnInputRef.createdAt })
      : turnInputRef;
    return {
      objectiveRef,
      turnInputRef: previousObjectiveRef?.kind === "transcript_entry" ? turnInputRef : objectiveRef,
      transcriptSessionId,
      objectiveDigest: groupContentDigest({ objective: currentObjective }),
      objective: currentObjective,
    };
  },
});
await scheduleCancellationCoordinator.start();
runtimeTaskWorkerPump.reconcileOnStartup();
await artifactRetentionCleanupCoordinator.start();
runtimeTaskWorkerPump.start({
  resolveExecutionLifecycle: (task) => scheduleRuntime.lifecycle.resolveExecutionLifecycle(task),
  resolveExecutor: (task) => (task?.taskType === "group_step" ? ((ownership) => groupTaskExecutor.execute(task, ownership)) : null) ||
    triggerTaskExecutorResolver.resolvePersistentTaskExecutor(task) ||
    scheduleRuntime.lifecycle.resolvePersistentTaskExecutor(task) ||
    opsDiagnosisTaskService.resolvePersistentTaskExecutor(task) ||
    digitalEmployeeChatHandlers.resolvePersistentTaskExecutor(task) || resolvePersistentFeishuTaskExecutor(task),
});

await scheduleRuntime.start();
if (runtimeTaskPersistence.repository.personalAutomations.enabled) void personalAutomationScanner.start();

const localTestFrontend = createLocalTestFrontend({
  enabled: process.env.EMANAGER_LOCAL_MODE === "1",
  directory: path.resolve("dist"),
});

const server = (SERVER_TLS_OPTIONS ? https : http).createServer(SERVER_TLS_OPTIONS || undefined, async (req, res) => {
  try {
    const url = new URL(req.url, `${SERVER_PROTOCOL}://${req.headers.host || `${AUTH_PUBLIC_HOST}:${PORT}`}`);
    if (!["127.0.0.1", "[::1]"].includes(url.hostname)) return sendJson(res, 403, { ok: false, error: "local_host_required" });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}` && req.headers.origin !== `http://[::1]:${PORT}`) return sendJson(res, 403, { ok: false, error: "local_origin_required" });
    if (localTestFrontend(req, res, url)) return;
    if (applyDigitalEmployeeReadAlias(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, service: "digital-workforce-auth" });
    }

    if (await toolAssetHandlers.handle(req, res, url)) return;

    if (await desktopPresenceHandlers.handle(req,res,url)) return;
    if (await deviceReadRoutes.handle(req, res, url)) return;
    await personalAutomationHandlers.handle(req,res,url);
    if (res.headersSent || res.writableEnded) return;

    await triggerCapabilityRunHandlers.handle(req, res, url);
    if (res.headersSent || res.writableEnded) return;

    await triggerWebhookHandlers.handle(req, res, url);
    if (res.headersSent || res.writableEnded) return;

    if (req.method === "GET" && url.pathname === "/.well-known/hr-talentos-delegated-jwks.json") {
      if (!hrCurrentUserCredentialIssuer) return sendJson(res, 503, { ok: false, error: "hr_delegated_jwt_issuer_unconfigured" });
      return sendJson(res, 200, hrCurrentUserCredentialIssuer.publicJwks());
    }

    if (req.method === "GET" && url.pathname === "/.well-known/hr-training-delegated-jwks.json") {
      if (!hrTrainingCurrentUserCredentialIssuer) return sendJson(res, 503, { ok: false, error: "hr_training_delegated_jwt_issuer_unconfigured" });
      return sendJson(res, 200, hrTrainingCurrentUserCredentialIssuer.publicJwks());
    }

    if (req.method === "GET" && url.pathname === "/api/feishu/oauth/callback") {
      if (!feishuCurrentUserOAuthIssuer) {
        return sendFeishuOAuthCallbackPage(res, 503, "飞书用户授权尚未在数字中心配置。");
      }
      if (url.searchParams.get("error")) {
        return sendFeishuOAuthCallbackPage(res, 400, "飞书用户授权未完成，请返回会话后重试。");
      }
      try {
        await feishuCurrentUserOAuthIssuer.handleCallback({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
        });
        return sendFeishuOAuthCallbackPage(res, 200, "授权成功，可以关闭此页面并返回飞书继续刚才的操作。");
      } catch {
        return sendFeishuOAuthCallbackPage(res, 400, "授权链接无效、已过期或授权身份不匹配，请返回会话重新发起。");
      }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/demo/login") {
      return await demoLogin(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/auth/sso/start") {
      return startSso(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/auth/sso/callback") {
      return await finishSso(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return currentUser(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/session/revalidate") {
      return await revalidateCurrentSession(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/ops/usage-summary") {
      return opsUsageHandlers.listUsageSummary(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/ops/usage-events") {
      return await opsUsageHandlers.recordUsageEvent(req, res);
    }

    const opsIncidentResult = await opsIncidentHandlers.handle(req, res, url);
    if (opsIncidentResult !== undefined || res.headersSent) return opsIncidentResult;

    const groupStudioResult = await groupStudioHandlers.handle(req, res, url);
    if (groupStudioResult !== undefined || res.headersSent) return groupStudioResult;

    const runtimeInfrastructureResult = await runtimeInfrastructureHandlers.handle(req, res, url);
    if (runtimeInfrastructureResult !== undefined || res.headersSent) {
      return runtimeInfrastructureResult;
    }

    const systemWorkerConfigResult = await systemWorkerConfigHandlers.handle(req, res, url);
    if (systemWorkerConfigResult !== undefined || res.headersSent) {
      return systemWorkerConfigResult;
    }

    const digitalEmployeeModelBindingResult = await digitalEmployeeModelBindingHandlers.handle(req, res, url);
    if (digitalEmployeeModelBindingResult !== undefined || res.headersSent) {
      return digitalEmployeeModelBindingResult;
    }

    const digitalEmployeeProfileResult = await digitalEmployeeProfileHandlers.handle(req, res, url);
    if (digitalEmployeeProfileResult !== undefined || res.headersSent) {
      return digitalEmployeeProfileResult;
    }

    const digitalEmployeeLifecycleResult = await digitalEmployeeLifecycleHandlers.handle(req, res, url);
    if (digitalEmployeeLifecycleResult !== undefined || res.headersSent) {
      return digitalEmployeeLifecycleResult;
    }

    const digitalEmployeeDepartmentChangeResult = await digitalEmployeeDepartmentChangeHandlers.handle(req, res, url);
    if (digitalEmployeeDepartmentChangeResult !== undefined || res.headersSent) {
      return digitalEmployeeDepartmentChangeResult;
    }

    const digitalEmployeeResponsibilityResult = await digitalEmployeeResponsibilityHandlers.handle(req, res, url);
    if (digitalEmployeeResponsibilityResult !== undefined || res.headersSent) {
      return digitalEmployeeResponsibilityResult;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/org/departments" &&
      url.searchParams.get("source") === "fortress"
    ) {
      return await listFortressDepartments(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/org/departments") {
      return listDepartments(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/personnel") {
      return listPersonnel(res, url);
    }

    const personnelGovernanceResult = await personnelGovernanceHandlers.handle(req, res, url);
    if (personnelGovernanceResult !== undefined || res.headersSent) {
      return personnelGovernanceResult;
    }

    const digitalEmployeeAccessResult = await digitalEmployeeAccessHandlers.handle(req, res, url);
    if (digitalEmployeeAccessResult !== undefined || res.headersSent) {
      return digitalEmployeeAccessResult;
    }

    if (conversationDisplayHistoryHandlers) {
      const conversationDisplayHistoryResult = await conversationDisplayHistoryHandlers.handle(req, res, url);
      if (conversationDisplayHistoryResult !== undefined || res.headersSent) {
        return conversationDisplayHistoryResult;
      }
    }

    const digitalEmployeeCharacterResult = await digitalEmployeeCharacterHandlers.handle(req, res, url);
    if (digitalEmployeeCharacterResult !== undefined || res.headersSent) {
      return digitalEmployeeCharacterResult;
    }

    const groupStudioReleaseResult = await groupStudioReleaseHandlers.handle(req, res, url);
    if (groupStudioReleaseResult !== undefined) return groupStudioReleaseResult;
    const desktopReleaseResult = await desktopReleaseHandlers.handle(req, res, url);
    if (desktopReleaseResult !== undefined || res.headersSent) {
      return desktopReleaseResult;
    }

    if (req.method === "GET" && url.pathname === "/api/org/department-governance") {
      return await listDepartmentGovernance(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/digital-employees") {
      return listDigitalEmployees(res, url);
    }

    const digitalEmployeeScheduleResult = await digitalEmployeeScheduleHandlers.handle(req, res, url);
    if (digitalEmployeeScheduleResult !== undefined || res.headersSent) {
      return digitalEmployeeScheduleResult;
    }

    if (req.method === "GET" && url.pathname === "/api/ai-models") {
      return listAiModels(res, url);
    }

    const providerConnectionResult = await providerConnectionHandlers.handle(req, res, url);
    if (providerConnectionResult !== undefined || res.headersSent) {
      return providerConnectionResult;
    }

    const triggerManagementResult = await triggerManagementHandlers.handle(req, res, url);
    if (triggerManagementResult !== undefined || res.headersSent) {
      return triggerManagementResult;
    }

    if (req.method === "GET" && url.pathname === "/api/basic-skills") {
      return listBasicSkills(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/business-skills") {
      return listBusinessSkills(res, url);
    }

    const digitalEmployeeChatResult = await digitalEmployeeChatHandlers.handle(req, res, url);
    if (digitalEmployeeChatResult !== undefined || res.headersSent) {
      return digitalEmployeeChatResult;
    }

    const feishuIntegrationResult = await feishuIntegrationHandlers.handle(req, res, url);
    if (feishuIntegrationResult !== undefined || res.headersSent) {
      return feishuIntegrationResult;
    }

    if (req.method === "GET" && url.pathname === "/api/system-imports/pipelines") {
      return listSystemImportPipelines(res, url);
    }

    const systemImportResult = await systemImportHandlers.handle(req, res, url);
    if (systemImportResult !== undefined || res.headersSent) {
      return systemImportResult;
    }

    if (req.method === "GET" && url.pathname === "/api/quality-reviews") {
      return listQualityReviews(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/external-audit-requests") {
      return listExternalAuditRequests(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/badcases") {
      return listBadcases(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/subsystems") {
      return controlPlaneHandlers.listSubsystems(res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/subsystems") {
      return await controlPlaneHandlers.registerSubsystem(req, res);
    }

    if (req.method === "POST" && /^\/api\/control-plane\/subsystems\/[^/]+\/assignment-draft$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/api\/control-plane\/subsystems\/([^/]+)\/assignment-draft$/);
      const subsystemId = decodeURIComponent(match?.[1] || "");
      return await controlPlaneHandlers.updateSubsystemAssignment(req, res, subsystemId);
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/control-plane/subsystems/") && url.pathname.endsWith("/handshakes")) {
      const subsystemId = decodeURIComponent(
        url.pathname
          .slice("/api/control-plane/subsystems/".length)
          .replace(/\/handshakes$/, ""),
      );
      return await controlPlaneHandlers.startSubsystemHandshake(req, res, subsystemId);
    }

    if (
      req.method === "POST" &&
      url.pathname.startsWith("/api/control-plane/subsystems/") &&
      /\/handshakes\/[^/]+\/confirm$/.test(url.pathname)
    ) {
      const match = url.pathname.match(/^\/api\/control-plane\/subsystems\/([^/]+)\/handshakes\/([^/]+)\/confirm$/);
      const subsystemId = decodeURIComponent(match?.[1] || "");
      const handshakeId = decodeURIComponent(match?.[2] || "");
      return await controlPlaneHandlers.confirmSubsystemHandshake(req, res, subsystemId, handshakeId);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/capability-catalog") {
      return controlPlaneHandlers.listCapabilityCatalog(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/capability-requests") {
      return controlPlaneHandlers.listCapabilityRequests(res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/capability-requests") {
      return await controlPlaneHandlers.createCapabilityRequest(req, res);
    }

    if (req.method === "POST" && /^\/api\/control-plane\/capability-requests\/[^/]+\/decision$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/api\/control-plane\/capability-requests\/([^/]+)\/decision$/);
      const requestId = decodeURIComponent(match?.[1] || "");
      return await controlPlaneHandlers.decideCapabilityRequest(req, res, requestId);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/capability-requests/pre-review") {
      return await controlPlaneHandlers.runCapabilityPreReview(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/distributions") {
      return controlPlaneHandlers.listDistributions(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/skill-mount-requests") {
      return controlPlaneHandlers.listSkillMountRequests(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/skill-mount-requests") {
      return await controlPlaneHandlers.createSkillMountRequest(req, res);
    }

    if (req.method === "POST" && /^\/api\/control-plane\/skill-mount-requests\/[^/]+\/decision$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/api\/control-plane\/skill-mount-requests\/([^/]+)\/decision$/);
      const requestId = decodeURIComponent(match?.[1] || "");
      return await controlPlaneHandlers.decideSkillMountRequest(req, res, requestId);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/tool-binding-requests") {
      return controlPlaneHandlers.listToolBindingRequests(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/managed-sandbox-profiles") {
      return controlPlaneHandlers.listManagedSandboxProfiles(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/tool-resources") {
      return controlPlaneHandlers.listToolResources(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/tool-binding-requests") {
      return await controlPlaneHandlers.createToolBindingRequest(req, res);
    }

    if (req.method === "POST" && /^\/api\/control-plane\/tool-binding-requests\/[^/]+\/decision$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/api\/control-plane\/tool-binding-requests\/([^/]+)\/decision$/);
      const requestId = decodeURIComponent(match?.[1] || "");
      return await controlPlaneHandlers.decideToolBindingRequest(req, res, requestId);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/quality-events") {
      return await controlPlaneHandlers.createQualityEvent(req, res);
    }

    if (req.method === "POST" && /^\/api\/control-plane\/quality-events\/[^/]+\/review-actions$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/api\/control-plane\/quality-events\/([^/]+)\/review-actions$/);
      const eventId = decodeURIComponent(match?.[1] || "");
      return await controlPlaneHandlers.updateQualityReviewTask(req, res, eventId);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/quality-events") {
      return controlPlaneHandlers.listQualityEvents(res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/control-plane/invocation-policies") {
      return controlPlaneHandlers.listInvocationPolicies(res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/control-plane/invocation-checks") {
      return await controlPlaneHandlers.checkInvocationPolicy(req, res);
    }

    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/api/auth/logout"
    ) {
      return logout(req, res);
    }

    if (res.headersSent || res.writableEnded) return;
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error("[auth-server]", redactError(error));
    if (res.headersSent || res.writableEnded) return;
    return sendJson(res, 500, { ok: false, error: "Auth server error" });
  }
});

server.listen(PORT, AUTH_SERVER_HOST, () => {
  console.log(`Auth server listening on ${SERVER_PROTOCOL}://${AUTH_SERVER_HOST}:${PORT}`);
});

let shutdownPromise = null;
function shutdownCenter() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    deviceReadServices?.close();
    await personalAutomationScanner.close();
    await scheduleRuntime.stop();
    const workerClose = runtimeTaskWorkerPump.close();
    await artifactRetentionCleanupCoordinator.close();
    await scheduleCancellationCoordinator.drainForShutdown();
    await workerClose;
    await scheduleCancellationCoordinator.drainForShutdown();
    await scheduleCancellationCoordinator.close();
    scheduleRuntime.closeStores();
    scheduleTaskDefinitionRepository.close();
    governedScheduleRepository.close();
    await runtimeSessionPersistence.close();
    triggerReviewResultRepository.close();
    hrTrainingContentEvaluationResultRepository.close();
    hrTrainingFollowupRoundEvaluationResultRepository.close();
    hrTrainingAggregateFeedbackResultRepository.close();
    hrTrainingCapabilityRunInputRepository.close();
    triggerBusinessLocatorRepository.close();
    runtimeToolCapabilities.close();
    toolAssetRepository.close();
    triggerPersistence.close();
    for (const timer of hrTrainingContentEvaluationRetryTimers) clearTimeout(timer);
    hrTrainingContentEvaluationRetryTimers.clear();
    desktopMaterialIntakeService.close();
    runtimeTaskPersistence.close();
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdownCenter().catch((error) => {
      console.error("[auth-server-shutdown]", redactError(error));
      process.exitCode = 1;
    });
  });
}

function startSso(req, res, url) {
  if (process.env.EMANAGER_LOCAL_MODE === "1") return sendJson(res, 503, { ok: false, error: "本地版本使用本地账号；企业认证需要独立适配。" });
  const { appId, appSecret } = fortressCredentials();
  if (!appId || !appSecret) {
    return sendJson(res, 503, {
      ok: false,
      error: "Fortress SSO is not configured",
      requiredEnv: ["FORTRESS_APP_ID", "FORTRESS_APP_SECRET", "FORTRESS_SERVICE_URL"],
    });
  }

  const redirect = safeRelativeRedirect(url.searchParams.get("redirect") || "/");
  const state = signState({
    nonce: crypto.randomBytes(16).toString("hex"),
    redirect,
    ts: Date.now(),
  }, sessionSecret);
  const serviceUrl = resolveSsoCallbackBaseUri(req, FRONTEND_ORIGIN);
  const loginUrl = buildFortressLoginUrl({ appId, serviceUrl, loginUrl: FORTRESS_LOGIN_URL });

  res.setHeader("Set-Cookie", cookie("dw.sso.state", state, { httpOnly: true, maxAge: 10 * 60 }));
  redirectResponse(res, loginUrl.toString());
}

async function finishSso(req, res, url) {
  const ticket = url.searchParams.get("ticket");
  const state = url.searchParams.get("state") || parseCookies(req.headers.cookie)["dw.sso.state"];
  if (!ticket || !state) {
    res.setHeader("Set-Cookie", cookie("dw.sso.state", "", { httpOnly: true, maxAge: 0 }));
    return redirectResponse(res, `${resolveFrontendOrigin(req, FRONTEND_ORIGIN)}/?auth=missing-ticket`);
  }

  const parsedState = verifyState(state, sessionSecret);
  if (!parsedState) {
    res.setHeader("Set-Cookie", cookie("dw.sso.state", "", { httpOnly: true, maxAge: 0 }));
    return redirectResponse(res, `${resolveFrontendOrigin(req, FRONTEND_ORIGIN)}/?auth=invalid-state`);
  }

  const ticketIdentity = await verifyFortressTicket(ticket);
  const member = await fetchFortressUser(
    ticketIdentity.NickName || ticketIdentity.Username,
    FORTRESS_TICKET_USER_ID_TYPE,
  );
  const identity = mapFortressUserToSession(ticketIdentity, member);
  const created = authorizationSessions.createSession(identity.session, identity.accountProjection);
  if (!created.allowed) {
    res.setHeader("Set-Cookie", [
      cookie("dw.sid", "", { httpOnly: true, maxAge: 0 }),
      cookie("dw.sso.state", "", { httpOnly: true, maxAge: 0 }),
    ]);
    return redirectResponse(res, `${resolveFrontendOrigin(req, FRONTEND_ORIGIN)}/?auth=${encodeURIComponent(created.error)}`);
  }
  opsUsageStore.recordEvent({ eventType: "login", source: "fortress-sso" }, created.session);

  res.setHeader("Set-Cookie", [
    cookie("dw.sid", created.sessionId, { httpOnly: true, maxAge: Math.floor(AUTH_SESSION_TTL_MS / 1000) }),
    cookie("dw.sso.state", "", { httpOnly: true, maxAge: 0 }),
  ]);
  redirectResponse(res, `${resolveFrontendOrigin(req, FRONTEND_ORIGIN)}${parsedState.redirect || "/"}`);
}

function currentUser(req, res) {
  const sessionId = parseCookies(req.headers.cookie)["dw.sid"];
  const decision = sessionId ? authorizationSessions.resolveSession(sessionId) : null;
  if (!decision?.allowed) return sendSessionDecision(res, decision);
  return sendJson(res, 200, { ok: true, session: decision.session });
}

async function demoLogin(req, res) {
  const input = await readJsonBody(req);
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const account = demoAccounts.find((item) => item.email === email && verifyLocalPassword(email, password));
  if (!account) return sendJson(res, 401, { ok: false, error: "账号或密码不正确" });

  const identity = mapDemoAccountToSession(account);
  const created = authorizationSessions.createSession(identity.session, identity.accountProjection);
  if (!created.allowed) return sendSessionDecision(res, created);
  opsUsageStore.recordEvent({ eventType: "login", source: "demo-login" }, created.session);
  res.setHeader("Set-Cookie", cookie("dw.sid", created.sessionId, { httpOnly: true, maxAge: Math.floor(AUTH_SESSION_TTL_MS / 1000) }));
  return sendJson(res, 200, { ok: true, session: created.session });
}

function requireSession(req, res) {
  const sessionId = parseCookies(req.headers.cookie)["dw.sid"];
  const decision = sessionId ? authorizationSessions.resolveSession(sessionId) : null;
  if (decision?.allowed) return decision.session;
  sendSessionDecision(res, decision);
  return null;
}

function optionalSession(req) {
  const sessionId = parseCookies(req.headers.cookie)["dw.sid"];
  const decision = sessionId ? authorizationSessions.resolveSession(sessionId) : null;
  return decision?.allowed ? decision.session : null;
}

function listDepartments(res, url) {
  const parentId = url.searchParams.get("parentId");
  const items = departments
    .filter((department) => parentId === null || String(department.parentId) === parentId)
    .map((department) => ({
      ...department,
      path: departmentPath(department.id),
      headcount: personnel.filter((user) => user.departmentId === department.id).length,
      digitalEmployees: digitalEmployees.filter((employee) => employee.departmentId === department.id).length,
      businessSkills: businessSkills.filter((skill) => skill.departmentId === department.id).length,
    }));
  return sendJson(res, 200, { ok: true, departments: items });
}

function listPersonnel(res, url) {
  const items = applyCatalogFilters(personnel, url, ["departmentId", "role", "status"]);
  return sendJson(res, 200, { ok: true, personnel: items });
}

async function listDepartmentGovernance(req, res, url) {
  if (url.searchParams.get("source") === "fortress") {
    return await listFortressDepartmentGovernance(req, res, url);
  }
  const items = applyCatalogFilters(departmentGovernance, url, ["departmentId", "ownerUserId", "scope"]);
  return sendJson(res, 200, { ok: true, departmentGovernance: items });
}

function listDigitalEmployees(res, url) {
  const items = currentDigitalEmployees({
    departmentId: cleanText(url.searchParams.get("departmentId") || ""),
    ownerDepartmentId: cleanText(url.searchParams.get("ownerDepartmentId") || ""),
    ownerUserId: cleanText(url.searchParams.get("ownerUserId") || ""),
    permissionScope: cleanText(url.searchParams.get("permissionScope") || ""),
    level: cleanText(url.searchParams.get("level") || ""),
    status: cleanText(url.searchParams.get("status") || ""),
    owner: cleanText(url.searchParams.get("owner") || ""),
  }).map(publicDigitalEmployeeProjection);
  return sendJson(res, 200, {
    ok: true,
    digitalEmployees: items,
    catalogSource: "catalog_plus_mvp_employee_review_state_plus_admin_profile_plus_department_change_plus_responsibility_assignment_plus_tool_binding_plus_channel_runtime_evidence_plus_unified_runtime_config_plus_governed_schedule_registry_plus_runtime_workers_plus_runtime_events_plus_lifecycle_control",
    persistence: {
      kind: "mvp-file-store",
      productionReady: false,
      path: "data/local/system-import-state.json + data/local/digital-employee-profiles.json + data/local/control-plane-subsystems.json + data/local/digital-employee-department-changes.json + data/local/digital-employee-responsibilities.json + data/local/digital-employee-runtime-config.json + data/local/governed-schedules.sqlite + data/local/schedule-controls.sqlite + data/local/digital-employee-model-bindings.json (read-only compatibility) + data/local/system-worker-config.json (auxiliary lanes) + data/local/digital-employee-runtime-events.json + data/local/digital-employee-lifecycle.json",
      note: "包含技能/员工评审写入的人员审批和 MVP 试运行状态、管理员应用的员工展示名称、已批准的归属变更、责任分工与 Tool 绑定覆盖记录、数字员工与主 Worker 共用的已生效运行配置及待审修订、管理员登记但默认停用的权威 Schedule 与任务级模型安全投影、已接共享 Runtime 与 Center 时钟的 Schedule control/run/outbox 权威、辅助 Worker Lane 概要、管理员直接生效的员工生命周期状态，以及任务调用 event 汇总出的使用统计；生产仍需正式人员治理库、RBAC、运行审计和指标仓库。",
    },
  });
}

function publicDigitalEmployeeProjection(employee = {}) {
  if (!employee.modelAssignments || typeof employee.modelAssignments !== "object") return employee;
  const { assignmentDigest: _assignmentDigest, ...modelAssignments } = employee.modelAssignments;
  return { ...employee, modelAssignments };
}

function currentDigitalEmployees(filters = {}) {
  const items = systemImportHandlers?.listRuntimeDigitalEmployees?.({}) || digitalEmployees;
  const itemsWithProfiles = digitalEmployeeProfileHandlers?.withProfiles?.(items) || items;
  const itemsWithDesktopAvailability = digitalEmployeeAccessHandlers?.withDesktopChannelAvailability?.(itemsWithProfiles) || itemsWithProfiles;
  const itemsWithDepartmentChanges = digitalEmployeeDepartmentChangeHandlers?.withDepartmentChanges?.(itemsWithDesktopAvailability) || itemsWithDesktopAvailability;
  const itemsWithResponsibilities = digitalEmployeeResponsibilityHandlers?.withResponsibilities?.(itemsWithDepartmentChanges) || itemsWithDepartmentChanges;
  const itemsWithToolBindings = controlPlaneHandlers?.withEffectiveToolBindings?.(itemsWithResponsibilities) || itemsWithResponsibilities;
  const itemsWithRuntimeEvidence = typeof feishuIntegrationHandlers?.withRuntimeEvidence === "function"
    ? feishuIntegrationHandlers.withRuntimeEvidence(itemsWithToolBindings)
    : itemsWithToolBindings;
  const itemsWithModelBindings = digitalEmployeeModelBindingHandlers?.withModelBindings?.(itemsWithRuntimeEvidence) || itemsWithRuntimeEvidence;
  const itemsWithRuntimeConfig = digitalEmployeeRuntimeConfigService.withAppliedProfiles(itemsWithModelBindings);
  const itemsWithRegisteredSchedules = governedScheduleRegistry.withRegisteredSchedules(itemsWithRuntimeConfig, {
    tenantScope: GOVERNED_SCHEDULE_TENANT_SCOPE,
  });
  const itemsWithRuntimeWorkers = systemWorkerConfigHandlers.withRuntimeWorkers(itemsWithRegisteredSchedules);
  const itemsWithRuntimeUsage = digitalEmployeeRuntimeEventStore.withRuntimeUsage(itemsWithRuntimeWorkers);
  const itemsWithLifecycleStates = digitalEmployeeLifecycleHandlers?.withLifecycleStates?.(itemsWithRuntimeUsage) || itemsWithRuntimeUsage;
  return filterDigitalEmployees(itemsWithLifecycleStates, filters);
}

function runtimeEmployeeLaneConcurrency(employeeId) {
  const employee = currentDigitalEmployees().find((item) => item.id === employeeId);
  return runtimeQueuePolicyForEmployee(employee).maxParallelWorkers;
}

function currentAiProviderRoutes() {
  return projectProviderRoutes(aiProviderRoutes, providerConnectionGovernanceStore.readState());
}

function currentAiProviderCredentials() {
  return projectProviderCredentials(aiProviderCredentials, providerConnectionGovernanceStore.readState());
}

function filterDigitalEmployees(items = [], filters = {}) {
  const activeFilters = Object.entries(filters).filter(([, value]) => cleanText(value));
  if (!activeFilters.length) return items;
  return items.filter((item) => activeFilters.every(([field, value]) => cleanText(item[field]) === cleanText(value)));
}

function applyDigitalEmployeeReadAlias(req, res, url) {
  const match = url.pathname.match(/^\/api\/digital-employees\/([^/]+)(\/.*)?$/);
  if (match) {
    let employeeId = "";
    try {
      employeeId = decodeURIComponent(match[1]);
    } catch {
      return false;
    }
    const identity = resolveDigitalEmployeeRequestIdentity({ employeeId, method: req.method });
    if (!identity.ok && identity.error === "digital_employee_identity_alias_read_only") {
      sendJson(res, 409, {
        ok: false,
        error: identity.error,
        canonicalEmployeeId: identity.canonicalEmployeeId,
        message: "旧算法员工标识只用于读取兼容；请刷新员工目录后重试。",
      });
      return true;
    }
    if (identity.ok && identity.isLegacyReadAlias) {
      url.pathname = `/api/digital-employees/${encodeURIComponent(identity.canonicalEmployeeId)}${match[2] || ""}`;
    }
  }
  if (url.searchParams.has("employeeId")) {
    const identity = resolveDigitalEmployeeRequestIdentity({
      employeeId: url.searchParams.get("employeeId"),
      method: req.method,
    });
    if (!identity.ok && identity.error === "digital_employee_identity_alias_read_only") {
      sendJson(res, 409, {
        ok: false,
        error: identity.error,
        canonicalEmployeeId: identity.canonicalEmployeeId,
        message: "旧算法员工标识只用于读取兼容；请刷新员工目录后重试。",
      });
      return true;
    }
    if (identity.ok && identity.isLegacyReadAlias) url.searchParams.set("employeeId", identity.canonicalEmployeeId);
  }
  return false;
}

function listAiModels(res, url) {
  const items = applyCatalogFilters(aiModelCatalog, url, ["provider", "model", "status"]);
  return sendJson(res, 200, { ok: true, aiModelLevels, aiModels: items });
}

function listBasicSkills(res, url) {
  const items = applyCatalogFilters(basicSkills, url, ["category", "status", "owner"]);
  return sendJson(res, 200, { ok: true, basicSkills: items });
}

function listBusinessSkills(res, url) {
  const status = cleanText(url.searchParams.get("status") || "");
  const departmentId = cleanText(url.searchParams.get("departmentId") || "");
  const domain = cleanText(url.searchParams.get("domain") || "");
  const risk = cleanText(url.searchParams.get("risk") || "");
  const items = systemImportHandlers.listRuntimeBusinessSkills({ status, departmentId, domain, risk });
  return sendJson(res, 200, {
    ok: true,
    businessSkills: items,
    catalogSource: "runtime_catalog_plus_mvp_publications",
    persistence: {
      kind: "mvp-file-store",
      productionReady: false,
      path: "data/local/system-import-state.json",
      note: "包含通过技能/员工评审生成并写入 ignored data/local MVP 文件存储的发布目录项；生产仍需正式 Skill registry、RBAC 和审计。",
    },
  });
}

function listSystemImportPipelines(res, url) {
  const items = applyCatalogFilters(systemImportPipelines, url, ["status", "ownerEmployeeId"]);
  return sendJson(res, 200, { ok: true, systemImportPipelines: items });
}

function listQualityReviews(res, url) {
  const items = applyCatalogFilters(qualityReviewItems, url, ["category", "status", "owner"]);
  return sendJson(res, 200, { ok: true, qualityReviewItems: items });
}

function listExternalAuditRequests(res, url) {
  const items = applyCatalogFilters(externalAuditRequests, url, [
    "requestType",
    "status",
    "risk",
    "auditorEmployeeId",
    "reviewDepartmentId",
  ]);
  return sendJson(res, 200, { ok: true, externalAuditRequests: items });
}

function listBadcases(res, url) {
  const items = applyCatalogFilters(badcaseRecords, url, [
    "entityId",
    "entityType",
    "severity",
    "status",
    "promptVersion",
    "rootCauseCategory",
  ]);
  return sendJson(res, 200, { ok: true, badcaseRecords: items });
}

function logout(req, res) {
  const sessionId = parseCookies(req.headers.cookie)["dw.sid"];
  if (sessionId) {
    const current = authorizationSessions.peekSession(sessionId);
    if (current?.allowed) revokeCurrentUserToolCredentials(current.session);
    authorizationSessions.removeSession(sessionId);
  }
  res.setHeader("Set-Cookie", cookie("dw.sid", "", { httpOnly: true, maxAge: 0 }));
  return sendJson(res, 200, { ok: true });
}

async function revalidateCurrentSession(req, res) {
  const sessionId = parseCookies(req.headers.cookie)["dw.sid"];
  const current = sessionId ? authorizationSessions.peekSession(sessionId) : null;
  if (!current?.allowed) return sendSessionDecision(res, current);

  let identity;
  try {
    identity = current.session.identitySource === "fortress-sso-v3"
      ? await refreshFortressSessionIdentity(current.session)
      : refreshDemoSessionIdentity(current.session);
  } catch (error) {
    console.warn("[auth-server] session revalidation failed:", redactError(error));
    return sendJson(res, 503, {
      ok: false,
      error: "identity_revalidation_unavailable",
      contractVersion: "session-authorization.v1",
    });
  }

  if (!identity) {
    revokeCurrentUserToolCredentials(current.session);
    authorizationSessions.removeSession(sessionId);
    return sendSessionDecision(res, { allowed: false, error: "identity_not_found", statusCode: 401 });
  }

  const decision = authorizationSessions.revalidateSession(
    sessionId,
    identity.session,
    identity.accountProjection,
  );
  if (!decision.allowed) {
    revokeCurrentUserToolCredentials(current.session);
    return sendSessionDecision(res, decision);
  }
  if (decision.session.authorization?.permissionVersion !== current.session.authorization?.permissionVersion) {
    revokeCurrentUserToolCredentials(current.session);
  }
  return sendJson(res, 200, {
    ok: true,
    status: "revalidated",
    contractVersion: "session-authorization.v1",
    session: decision.session,
  });
}

async function refreshFortressSessionIdentity(session) {
  const userId = session.feishuUserId || session.nickName || session.employeeId;
  const userIdType = session.feishuUserId ? "feishuID" : session.userIdType || FORTRESS_TICKET_USER_ID_TYPE;
  const member = await fetchFortressUser(userId, userIdType);
  return mapFortressUserToSession({
    NickName: session.nickName,
    Username: session.nickName || session.employeeId,
  }, member);
}

function refreshDemoSessionIdentity(session) {
  const account = demoAccounts.find((item) => item.email === session.email);
  return account ? mapDemoAccountToSession(account) : null;
}

function sendSessionDecision(res, decision = null) {
  const error = decision?.error || "authentication_required";
  const statusCode = decision?.statusCode || 401;
  if (["authentication_required", "session_expired", "identity_not_found", "account_blocked", "account_disabled"].includes(error)) {
    res.setHeader("Set-Cookie", cookie("dw.sid", "", { httpOnly: true, maxAge: 0 }));
  }
  return sendJson(res, statusCode, {
    ok: false,
    error,
    contractVersion: "session-authorization.v1",
  });
}

async function verifyFortressTicket(ticket) {
  const { appId, appSecret } = fortressCredentials();
  const body = await postFortressJson(`${trimTrailingSlash(FORTRESS_VERIFY_TICKET_URL)}/${encodeURIComponent(appId)}`, {
    RequestID: requestId("sso-ticket"),
    AppSecret: appSecret,
    Ticket: ticket,
  });
  if (!body.NickName && !body.Username) {
    throw new Error("Fortress ticket response did not include a user nickname");
  }
  return body;
}

async function fetchFortressUser(userId, userIdType) {
  const { appId, appSecret } = fortressCredentials();
  if (!userId) throw new Error("Fortress user lookup requires a user id");
  const body = await postFortressJson(`${trimTrailingSlash(FORTRESS_USER_INFO_URL)}/${encodeURIComponent(userId)}`, {
    RequestID: requestId("user-info"),
    AppID: appId,
    AppSecret: appSecret,
    UserIDType: userIdType,
  });
  if (!body.Member) throw new Error("Fortress user response did not include Member");
  return body.Member;
}

async function tryFetchFortressUser(userId, userIdType) {
  try {
    return await fetchFortressUser(userId, userIdType);
  } catch {
    return null;
  }
}

async function fetchFortressUsersByIds(userIds, userIdType) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const directory = new Map();
  if (!ids.length) return directory;

  const { appId, appSecret } = fortressCredentials();
  for (let index = 0; index < ids.length; index += FORTRESS_USER_BATCH_SIZE) {
    const batch = ids.slice(index, index + FORTRESS_USER_BATCH_SIZE);
    const body = await postFortressJson(FORTRESS_USER_INFO_URL, {
      RequestID: requestId("users-info"),
      UserIDs: batch,
      AppID: appId,
      AppSecret: appSecret,
      UserIDType: userIdType,
    });
    for (const member of Array.isArray(body.Members) ? body.Members : []) {
      const key = fortressDirectoryUserKey(member);
      if (key) directory.set(key, member);
    }
  }
  return directory;
}

async function listFortressDepartments(req, res, url) {
  if (!requireSession(req, res)) return undefined;
  const root = await fetchFortressDepartmentTree(url.searchParams.get("departmentId") || "0");
  const departments = flattenFortressDepartments(root);
  return sendJson(res, 200, {
    ok: true,
    source: "fortress-v3",
    root: sanitizeFortressDepartmentTree(root, 0, root),
    departments,
    summary: summarizeFortressDepartments(root, departments),
  });
}

async function listFortressDepartmentGovernance(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return undefined;

  const departmentId = url.searchParams.get("departmentId") || "0";
  const cached = fortressGovernanceCache.get(departmentId);
  if (cached && cached.expiresAt > Date.now() && url.searchParams.get("refresh") !== "1") {
    return sendJson(res, 200, cached.payload);
  }

  const root = await fetchFortressDepartmentTree(departmentId);
  const topDepartments = Array.isArray(root.Children) ? root.Children : [];
  const branchMemberIds = uniqueFortressMembers(topDepartments)
    .map((member) => member.FeishuUserID)
    .filter(Boolean);
  const memberDirectory = await fetchFortressUsersByIds(branchMemberIds, "feishuID");
  const leaderIds = [...new Set(
    [...memberDirectory.values()].map((member) => member.LeaderUserID).filter(Boolean),
  )].filter((leaderId) => !memberDirectory.has(leaderId));
  const leaderDirectory = await fetchFortressUsersByIds(leaderIds, "feishuID");
  const directory = new Map([...memberDirectory, ...leaderDirectory]);

  const payload = {
    ok: true,
    source: "fortress-v3",
    sync: {
      rootDepartmentId: root.ID,
      rootName: root.Name,
      generatedAt: new Date().toISOString(),
      userKey: "FeishuUserID",
      ownerSource: "LeaderUserID",
      ownerStrategy: "top-node-constrained-leader-aggregation",
      ownerConfidence: "candidate",
    },
    departmentGovernance: topDepartments.map((department) =>
      buildFortressDepartmentGovernanceRow(department, topDepartments, directory),
    ),
  };

  fortressGovernanceCache.set(departmentId, {
    expiresAt: Date.now() + FORTRESS_SYNC_CACHE_MS,
    payload,
  });
  return sendJson(res, 200, payload);
}

async function fetchFortressDepartmentTree(departmentId) {
  const { appId, appSecret } = fortressCredentials();
  const body = await postFortressJson(FORTRESS_DEPARTMENTS_URL, {
    RequestID: requestId("departments"),
    DepartmentID: departmentId,
    AppID: appId,
    AppSecret: appSecret,
  });
  if (!body.Root) throw new Error("Fortress departments response did not include Root");
  return body.Root;
}

async function resolveSystemWorkerDepartmentDirectory(session = {}, { allowStale = true } = {}) {
  const now = Date.now();
  if (fortressWorkerDepartmentDirectoryCache?.expiresAt > now) {
    return { ...fortressWorkerDepartmentDirectoryCache.payload, freshness: "fresh" };
  }

  const { appId, appSecret } = fortressCredentials();
  if (appId && appSecret) {
    try {
      const root = await fetchFortressDepartmentTree("0");
      const directory = buildFortressDepartmentDirectory(root);
      const rootEntry = directory.find((item) => item.directoryId === String(root.ID || "0")) || directory[0];
      const topDepartments = directory.filter((item) => item.parentId === rootEntry?.id);
      const virtualDirectory = buildPlatformVirtualDepartmentDirectory({ departments, personnel });
      const generatedAt = new Date(now).toISOString();
      const payload = {
        source: "fortress-v3",
        freshness: "fresh",
        generatedAt,
        departmentIdContract: "fortress-department-path.v1",
        departments: mergeDepartmentDirectoryEntries(virtualDirectory.departments, topDepartments).map(safeWorkerDepartment),
      };
      fortressWorkerDepartmentDirectoryCache = {
        payload,
        expiresAt: now + FORTRESS_SYNC_CACHE_MS,
      };
      return payload;
    } catch (error) {
      if (allowStale && fortressWorkerDepartmentDirectoryCache?.payload) {
        return { ...fortressWorkerDepartmentDirectoryCache.payload, freshness: "stale" };
      }
      if (session.identitySource === "fortress-sso-v3") throw error;
    }
  }

  if (session.identitySource === "fortress-sso-v3") {
    throw new Error("Fortress department directory is unavailable");
  }
  return {
    source: "demo-catalog",
    freshness: "degraded",
    generatedAt: "",
    departmentIdContract: "demo-department-id.v1",
    departments: departments.filter((department) => department.parentId === "company").map(safeWorkerDepartment),
  };
}

function safeWorkerDepartment(department = {}) {
  return {
    id: cleanText(department.id),
    directoryId: cleanText(department.directoryId || department.id),
    name: cleanText(department.name),
    label: cleanText(department.label || department.name),
    parentId: cleanText(department.parentId),
    source: cleanText(department.source || "identity-directory"),
  };
}

async function resolveDigitalEmployeeDepartmentDirectory(session) {
  const { appId, appSecret } = fortressCredentials();
  if (!appId || !appSecret) {
    throw new Error("Fortress department directory is not configured");
  }
  const now = Date.now();
  if (!fortressDepartmentDirectoryCache || fortressDepartmentDirectoryCache.expiresAt <= now) {
    const root = await fetchFortressDepartmentTree("0");
    const memberIds = uniqueFortressMembers([root]).map((member) => member.FeishuUserID).filter(Boolean);
    const memberDirectory = await fetchFortressUsersByIds(memberIds, "feishuID");
    const leaderIds = [...new Set(
      [...memberDirectory.values()].map((member) => member.LeaderUserID).filter(Boolean),
    )].filter((leaderId) => !memberDirectory.has(leaderId));
    const leaderDirectory = await fetchFortressUsersByIds(leaderIds, "feishuID");
    const fortressUsers = new Map([...memberDirectory, ...leaderDirectory]);
    fortressDepartmentDirectoryCache = {
      departments: buildFortressDepartmentDirectory(root).filter((department) => department.id !== "0"),
      personnel: buildFortressTopDepartmentOwnerDirectory(root, fortressUsers),
      expiresAt: now + FORTRESS_SYNC_CACHE_MS,
      generatedAt: new Date(now).toISOString(),
    };
  }
  const virtualDirectory = buildPlatformVirtualDepartmentDirectory({ departments, personnel });
  const directoryDepartments = mergeDepartmentDirectoryEntries(
    virtualDirectory.departments,
    fortressDepartmentDirectoryCache.departments,
  );
  const governance = personnelGovernanceStore.readForSession(session);
  const governanceOwnerCandidates = [
    ...(Array.isArray(governance.addedPeople) ? governance.addedPeople : []),
    session,
  ]
    .map((person) => canonicalDirectoryOwner(person, directoryDepartments))
    .filter(Boolean);
  return {
    source: "fortress-v3",
    generatedAt: fortressDepartmentDirectoryCache.generatedAt,
    departments: directoryDepartments,
    personnel: mergeDepartmentOwnerEntries(
      governanceOwnerCandidates,
      virtualDirectory.personnel,
      fortressDepartmentDirectoryCache.personnel,
    ),
  };
}

function canonicalDirectoryOwner(person = {}, departments = []) {
  const role = cleanText(person.governanceRole || person.role);
  const status = cleanText(person.status || "启用");
  if (!["系统管理员", "平台管理员", "部门负责人", "部门管理员", "业务管理员"].includes(role) || status === "停用") {
    return null;
  }
  const id = cleanText(person.id || person.employeeId || person.feishuUserId);
  if (!id) return null;
  const departmentId = canonicalDirectoryDepartmentId(person, departments);
  if (!departmentId) return null;
  return {
    id,
    name: cleanText(person.name || person.displayName || id),
    departmentId,
    role,
    status,
    source: cleanText(person.identitySource || "personnel-governance-mvp"),
  };
}

function canonicalDirectoryDepartmentId(person = {}, departments = []) {
  const rawId = String(person.departmentId || "").trim();
  if (departments.some((department) => department.id === rawId)) return rawId;
  const pathKey = normalizedDepartmentPath(person.departmentPath || person.department || person.departmentName);
  const pathMatches = pathKey
    ? departments.filter((department) => normalizedDepartmentPath(department.label) === pathKey)
    : [];
  if (pathMatches.length === 1) return pathMatches[0].id;
  const idMatches = rawId
    ? departments.filter((department) => department.directoryId === rawId || department.id.split("/").includes(rawId))
    : [];
  return idMatches.length === 1 ? idMatches[0].id : "";
}

function normalizedDepartmentPath(value) {
  return String(value || "")
    .split(/[\/／>＞]+/)
    .map((part) => part.replace(/\s+/g, "").trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}

async function postFortressJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  const status = body.Status || {};
  if (!response.ok || String(status.Code ?? 0) !== "0") {
    const code = status.Code ?? response.status;
    const message = status.Message || response.statusText || "unknown error";
    throw new Error(`Fortress request failed (${code}): ${message}`);
  }
  return body;
}

function mapFortressUserToSession(ticketIdentity, member) {
  const mainDepartment = (member.DepartmentRef || []).find((department) => department.IsMain) || member.DepartmentRef?.[0];
  const departmentName = mainDepartment?.Name || "";
  const departmentId = mainDepartment?.ID || "";
  const employee = findDemoEmployeeForFortressMember(member);
  const governanceFields = sessionGovernanceFields(employee);
  const adminResolution = resolveFortressAdminMember(member, ticketIdentity);
  const isAdmin = adminResolution.isAdmin;

  const baseSession = {
    email: member.Mail || "",
    employeeId:
      member.FeishuUserID ||
      member.FeishuUnionID ||
      member.EmployeeNo ||
      ticketIdentity.NickName ||
      ticketIdentity.Username,
    name: member.FullName || member.NickName || ticketIdentity.NickName || "企业用户",
    role: isAdmin ? "admin" : member.Position || employee?.role || "企业用户",
    title: member.Position || employee?.role || "企业用户",
    permissions: permissionsForRole(isAdmin ? "admin" : ""),
    departmentId: departmentId || employee?.departmentId || null,
    department: departmentName || employee?.department || "未映射部门",
    departmentPath: departmentName || (employee ? departmentPath(employee.departmentId).join(" / ") : ""),
    governanceRole: isAdmin ? "平台管理员" : governanceFields.governanceRole,
    managedDepartmentIds: isAdmin ? ["*"] : governanceFields.managedDepartmentIds,
    reviewDepartmentIds: isAdmin ? ["*"] : governanceFields.reviewDepartmentIds,
    identitySource: "fortress-sso-v3",
    feishuUserId: member.FeishuUserID || "",
    feishuUnionId: member.FeishuUnionID || "",
    employeeNo: member.EmployeeNo || "",
    nickName: member.NickName || ticketIdentity.NickName || "",
    userIdType: member.FeishuUserID ? "feishuID" : FORTRESS_TICKET_USER_ID_TYPE,
    adminResolution,
    signedInAt: new Date().toISOString(),
  };
  const session = applyPersonnelGovernanceAuthorization(
    baseSession,
    personnelGovernanceStore.resolveAuthorizationAssignment(baseSession),
  );
  return {
    accountProjection: projectFortressAccountStatus(member),
    session,
  };
}

function mapDemoAccountToSession(account) {
  const employee = personnel.find((item) => item.email === account.email);
  const departmentId = employee?.departmentId || null;
  const governanceFields = sessionGovernanceFields(employee);
  const baseSession = {
    email: account.email,
    employeeId: employee?.id || account.email,
    name: employee?.name || account.name,
    role: account.role,
    permissions: permissionsForRole(account.role),
    departmentId,
    department: employee?.department || account.department,
    departmentPath: departmentId ? departmentPath(departmentId).join(" / ") : "",
    governanceRole: governanceFields.governanceRole,
    managedDepartmentIds: governanceFields.managedDepartmentIds,
    reviewDepartmentIds: governanceFields.reviewDepartmentIds,
    identitySource: employee?.identitySource || "demo-account",
    signedInAt: new Date().toISOString(),
  };
  const session = applyPersonnelGovernanceAuthorization(
    baseSession,
    personnelGovernanceStore.resolveAuthorizationAssignment(baseSession),
  );
  return {
    accountProjection: activeDemoAccountProjection(),
    session,
  };
}

function sessionGovernanceFields(employee) {
  const rule = employee
    ? departmentGovernance.find((item) => item.ownerUserId === employee.id || (item.adminUserIds || []).includes(employee.id))
    : null;
  return {
    governanceRole: employee?.governanceRole || "",
    managedDepartmentIds: employee?.managedDepartmentIds?.length
      ? employee.managedDepartmentIds
      : rule?.editableDepartmentIds || [],
    reviewDepartmentIds: employee?.reviewDepartmentIds?.length
      ? employee.reviewDepartmentIds
      : rule?.reviewDepartmentIds || [],
  };
}

function isFortressAdminMember(member, ticketIdentity) {
  return resolveFortressAdminMember(member, ticketIdentity).isAdmin;
}

function resolveFortressAdminMember(member, ticketIdentity) {
  const fields = [
    ["feishuUserId", member.FeishuUserID, ADMIN_FEISHU_USER_IDS],
    ["employeeNo", member.EmployeeNo, ADMIN_EMPLOYEE_NOS],
    ["nickName", member.NickName || ticketIdentity.NickName || ticketIdentity.Username, ADMIN_NICK_NAMES],
    ["fullName", member.FullName, ADMIN_FULL_NAMES],
    ["email", member.Mail, ADMIN_EMAILS],
  ];
  const matchedField = fields.find(([, value, allowlist]) => {
    const normalizedValue = normalizeAdminMatchValue(value);
    return normalizedValue && allowlist.includes(normalizedValue);
  })?.[0] || "";

  return {
    isAdmin: Boolean(matchedField),
    matchedField,
    checkedFields: fields.map(([field]) => field),
  };
}

function normalizeAdminMatchValue(value) {
  return (
    String(value || "")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase()
  );
}

function deriveScheduleTaskDefinitionKey(purpose) {
  const rootKey = Buffer.from(process.env.SESSION_FOUNDATION_ENCRYPTION_KEY || "", "base64");
  if (rootKey.length !== 32) {
    throw new TypeError("SESSION_FOUNDATION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    Buffer.from(`schedule-task-execution-definition.${purpose}`, "utf8"),
    32,
  ));
}

function deriveTriggerServerKey(domain) {
  const rootKey = Buffer.from(process.env.SESSION_FOUNDATION_ENCRYPTION_KEY || "", "base64");
  if (rootKey.length !== 32) {
    throw new TypeError("SESSION_FOUNDATION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    Buffer.from(`trigger-runtime.${domain}`, "utf8"),
    32,
  ));
}

function isAllowedTriggerAttachmentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

function isAllowedHrTrainingContextUrl(value) {
  return isAllowedHrTrainingUrl(value, "HR_TRAIN_CONTEXT_URL_ALLOWED_ORIGINS");
}

function isAllowedHrTrainingCallbackUrl(value) {
  return isAllowedHrTrainingUrl(value, "HR_TRAIN_CALLBACK_URL_ALLOWED_ORIGINS");
}

function isAllowedHrTrainingUrl(value, originEnvName) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    const configuredOrigin = hrTrainingUrlOrigin(process.env[originEnvName] || "");
    return configuredOrigin === "https://training.example.invalid" && url.origin === configuredOrigin;
  } catch {
    return false;
  }
}

function hrTrainingUrlOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !url.hash ? url.origin : "";
  } catch {
    return "";
  }
}

function safeRuntimeLogCode(value) {
  const code = String(value || "").trim();
  return /^[a-z][a-z0-9_]{1,119}$/.test(code) ? code : "runtime_safe_log_code_unavailable";
}

function scheduleHrTrainingContentEvaluationRetry({ delayMs, task } = {}) {
  const tenantScope = String(task?.tenantScope || "").trim();
  const taskId = String(task?.taskId || "").trim();
  if (!tenantScope || !taskId) {
    const error = new Error("hr_training_retry_task_invalid");
    error.code = "hr_training_retry_task_invalid";
    throw error;
  }
  const delay = Math.max(5_000, Math.min(300_000, Number(delayMs) || 30_000));
  const timer = setTimeout(() => {
    try {
      const marked = runtimeTaskPersistence.repository.markReady({
        tenantScope,
        taskId,
        now: new Date(),
      });
      if (marked) runtimeTaskWorkerPump.wake();
    } catch (error) {
      console.warn("[hr-training-trigger-retry]", JSON.stringify({
        code: safeRuntimeLogCode(error?.code || "hr_training_retry_mark_ready_failed"),
      }));
    } finally {
      hrTrainingContentEvaluationRetryTimers.delete(timer);
    }
  }, delay);
  timer.unref?.();
  hrTrainingContentEvaluationRetryTimers.add(timer);
  return { scheduled: true, delayMs: delay };
}

function resolveTriggerReviewProviderLease(employee) {
  const providerRouteId = employee?.modelBinding?.providerRouteId ||
    employee?.runtimeBinding?.providerRouteId ||
    employee?.runtimeBinding?.preferredProviderRouteId ||
    employee?.modelBinding?.preferredProviderRouteId ||
    "codex-digital-office-route";
  const providerRoute = currentAiProviderRoutes().find((route) => route.id === providerRouteId) || {};
  const providerCredential = currentAiProviderCredentials()
    .find((credential) => credential.id === providerRoute.credentialId) || {};
  const lease = resolveManagedProviderLease({
    employee,
    providerCredential,
    providerCredentialSecret: providerCredentialSecretStore.getSecret(providerCredential.id),
    providerRoute,
  });
  const model = String(employee?.modelBinding?.model || employee?.runtimeBinding?.model || "").trim();
  if (!lease || !model) return null;
  return Object.freeze({
    ...lease,
    model,
    modelId: String(employee?.modelBinding?.modelId || employee?.runtimeBinding?.modelId || "").trim(),
    modelLevelId: String(
      employee?.modelBinding?.modelLevelId || employee?.runtimeBinding?.modelLevelId || "",
    ).trim(),
    reasoningEffort: String(
      employee?.modelBinding?.modelLevelId || employee?.runtimeBinding?.modelLevelId ||
        process.env.ENTERPRISE_ASSISTANT_REASONING_EFFORT || "medium",
    ).trim(),
  });
}

function currentTriggerReviewWritebackAuthorization({ authorizationDigest, triggerEvent,
  writebackBinding }) {
  const snapshot = triggerEvent.executionSnapshot;
  const currentBinding = triggerBindingRegistry.get(snapshot.bindingId);
  const resolvedBinding = currentBinding && triggerBindingRegistry.resolve({
    bindingId: snapshot.bindingId,
    eventType: triggerEvent.event.eventType,
    sourceAdapterId: snapshot.sourceAdapterId,
    sourceSystemId: snapshot.sourceSystemId,
  });
  const currentDefinition = triggerTaskDefinitionRegistry.resolve({
    taskDefinitionId: snapshot.taskDefinitionId,
    taskDefinitionVersion: snapshot.taskDefinitionVersion,
    handlerVersion: snapshot.handlerVersion,
  });
  const currentWriteback = triggerWritebackBindingRegistry.resolve({
    sourceObjectApiName: triggerEvent.event.subject.objectApiName,
    sourceSystemId: snapshot.sourceSystemId,
    taskDefinitionId: snapshot.taskDefinitionId,
  });
  const currentEmployee = currentDigitalEmployees()
    .find((employee) => employee.id === snapshot.targetEmployeeId);
  const allowed = Boolean(resolvedBinding && currentDefinition && currentWriteback && currentEmployee &&
    resolvedBinding.bindingVersion === snapshot.bindingVersion &&
    resolvedBinding.taskDefinitionId === snapshot.taskDefinitionId &&
    resolvedBinding.targetEmployeeId === snapshot.targetEmployeeId &&
    currentEmployee.version === snapshot.targetEmployeeVersion &&
    ["在线", "试运行"].includes(String(currentEmployee.status || "").trim()) &&
    currentDefinition.skillPolicyRef === snapshot.skillPolicyRef &&
    currentDefinition.toolPolicyRef === snapshot.toolPolicyRef &&
    currentDefinition.outputPolicyRef === snapshot.outputPolicyRef &&
    currentDefinition.writebackPolicyRef === snapshot.writebackPolicyRef &&
    triggerWritebackPolicyRef(currentWriteback) === snapshot.writebackPolicyRef &&
    currentWriteback.writebackBindingId === writebackBinding.writebackBindingId &&
    currentWriteback.bindingVersion === writebackBinding.bindingVersion &&
    triggerReviewAuthorizationDigest({
      triggerEvent,
      writebackBinding: currentWriteback,
    }) === authorizationDigest);
  return {
    status: allowed ? "allowed" : "denied",
    authorizationDigest,
    reasonCode: allowed ? null : "trigger_review_writeback_policy_changed",
  };
}

function currentHrTrainingCallbackAuthorization({ authorizationDigest, input, triggerEvent }) {
  const snapshot = triggerEvent.executionSnapshot;
  const currentBinding = triggerBindingRegistry.get(snapshot.bindingId);
  const resolvedBinding = currentBinding && triggerBindingRegistry.resolve({
    bindingId: snapshot.bindingId,
    eventType: triggerEvent.event.eventType,
    sourceAdapterId: snapshot.sourceAdapterId,
    sourceSystemId: snapshot.sourceSystemId,
  });
  const currentDefinition = triggerTaskDefinitionRegistry.resolve({
    taskDefinitionId: snapshot.taskDefinitionId,
    taskDefinitionVersion: snapshot.taskDefinitionVersion,
    handlerVersion: snapshot.handlerVersion,
  });
  const currentEmployee = currentDigitalEmployees()
    .find((employee) => employee.id === snapshot.targetEmployeeId);
  const allowed = Boolean(resolvedBinding && currentDefinition && currentEmployee &&
    snapshot.sourceSystemId === "hr-train" &&
    snapshot.sourceAdapterId === "capability-run.v1" &&
    input?.tenantScope === triggerEvent.tenantScope &&
    input?.capability === triggerEvent.event.eventType &&
    input?.runInputId === triggerEvent.event.subject.objectId &&
    isAllowedHrTrainingContextUrl(input?.contextUrl) &&
    isAllowedHrTrainingCallbackUrl(input?.callbackUrl) &&
    triggerEvent.event.subject.objectApiName === "HrTrainingEvaluation" &&
    resolvedBinding.bindingVersion === snapshot.bindingVersion &&
    resolvedBinding.taskDefinitionId === snapshot.taskDefinitionId &&
    resolvedBinding.targetEmployeeId === snapshot.targetEmployeeId &&
    currentEmployee.version === snapshot.targetEmployeeVersion &&
    ["在线", "试运行"].includes(String(currentEmployee.status || "").trim()) &&
    currentDefinition.skillPolicyRef === snapshot.skillPolicyRef &&
    currentDefinition.toolPolicyRef === snapshot.toolPolicyRef &&
    currentDefinition.outputPolicyRef === snapshot.outputPolicyRef &&
    currentDefinition.writebackPolicyRef === snapshot.writebackPolicyRef &&
    hrTrainingCallbackAuthorizationDigest({ input, triggerEvent }) === authorizationDigest);
  return {
    status: allowed ? "allowed" : "denied",
    authorizationDigest,
    reasonCode: allowed ? null : "hr_training_callback_policy_changed",
  };
}

function hrTrainingCallbackAuthorizationDigest({ input, triggerEvent }) {
  const snapshot = triggerEvent.executionSnapshot;
  const payload = JSON.stringify([
    "hr-training-callback-authorization.v1",
    triggerEvent.tenantScope,
    triggerEvent.triggerEventId,
    triggerEvent.event.eventType,
    triggerEvent.event.subject.objectApiName,
    triggerEvent.event.subject.objectId,
    snapshot.bindingId,
    snapshot.bindingVersion,
    snapshot.taskDefinitionId,
    snapshot.taskDefinitionVersion,
    snapshot.handlerVersion,
    snapshot.skillPolicyRef,
    snapshot.toolPolicyRef,
    snapshot.outputPolicyRef,
    snapshot.writebackPolicyRef,
    snapshot.targetEmployeeId,
    snapshot.targetEmployeeVersion,
    input.capability,
    input.runInputId,
    input.contextUrlDigest,
    input.callbackUrlDigest,
  ]);
  return crypto.createHmac("sha256", deriveTriggerServerKey("hr-training-callback-authorization.v1"))
    .update(payload)
    .digest("hex");
}

function triggerReviewAuthorizationDigest({ triggerEvent, writebackBinding }) {
  const snapshot = triggerEvent.executionSnapshot;
  const payload = JSON.stringify([
    "trigger-review-writeback-authorization.v1",
    snapshot.bindingId,
    snapshot.bindingVersion,
    snapshot.taskDefinitionId,
    snapshot.taskDefinitionVersion,
    snapshot.handlerVersion,
    snapshot.skillPolicyRef,
    snapshot.toolPolicyRef,
    snapshot.outputPolicyRef,
    snapshot.writebackPolicyRef,
    snapshot.targetEmployeeId,
    snapshot.targetEmployeeVersion,
    writebackBinding.writebackBindingId,
    writebackBinding.bindingVersion,
    writebackBinding.sourceSystemId,
    writebackBinding.sourceObjectApiName,
    writebackBinding.commentFieldApiName,
    writebackBinding.receiptFieldApiName,
    writebackBinding.maxCommentChars,
    writebackBinding.triggerWorkflow,
    writebackBinding.objectLockPolicy,
    fxiaokeTriggerWritebackAdapter.adapterId,
  ]);
  return crypto.createHmac("sha256", deriveTriggerServerKey("writeback-authorization.v1"))
    .update(payload)
    .digest("hex");
}

function deriveScheduleServerKey(domain) {
  const rootKey = Buffer.from(process.env.SESSION_FOUNDATION_ENCRYPTION_KEY || "", "base64");
  if (rootKey.length !== 32) {
    throw new TypeError("SESSION_FOUNDATION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    Buffer.from(domain, "utf8"),
    32,
  ));
}

function readDesktopReleaseUpdatePolicy() {
  const environmentPolicy = String(process.env.DESKTOP_RELEASE_UPDATE_POLICY_JSON || "").trim();
  if (environmentPolicy) {
    try {
      return JSON.parse(environmentPolicy);
    } catch {
      return { invalid: true };
    }
  }
  try {
    const config = JSON.parse(readFileSync(path.join(projectRoot, "desktop-channel-mvp", "desktop-channel.config.json"), "utf8"));
    return config?.desktopUpdatePolicy || null;
  } catch {
    return null;
  }
}

function readGroupStudioReleaseUpdatePolicy() {
  const policy = String(process.env.GROUP_STUDIO_RELEASE_UPDATE_POLICY_JSON || "").trim();
  if (!policy) return null;
  try {
    const value = JSON.parse(policy);
    return value?.mode === "notify_only" ? value : null;
  } catch { return null; }
}

function resolveCenterSessionRoute({ channelId = "management_console", employeeId = "", session = {}, sessionKey = "" } = {}) {
  const actorSubjectId = String(
    session.employeeId || session.email || session.feishuUserId || session.employeeNo || "",
  ).trim();
  const actorIssuer = String(session.identitySource || session.authorization?.identitySource || "").trim();
  const conversationId = sessionKey || runtimeSessionKey({ channelId, employeeId, session });
  return runtimeSessionPersistence.createRoute({
    accountId: channelId,
    actorIssuer,
    actorSubjectId,
    channelId,
    conversationId,
    conversationType: "direct",
    employeeId,
  });
}

async function refreshExecutionRecoveryIdentity(locator = {}) {
  if (locator.identitySource === "fortress-sso-v3") {
    return refreshFortressSessionIdentity({
      employeeId: locator.subjectId,
      feishuUserId: locator.subjectIdType === "feishu_id" ? locator.subjectId : "",
      identitySource: locator.identitySource,
      userIdType: locator.subjectIdType,
    });
  }
  const person = personnel.find((item) => item.id === locator.subjectId || item.email === locator.subjectId);
  const account = demoAccounts.find((item) => item.email === (person?.email || locator.subjectId));
  return account ? mapDemoAccountToSession(account) : null;
}

function findDemoEmployeeForFortressMember(member) {
  const mail = String(member.Mail || "").toLowerCase();
  const employeeNo = String(member.EmployeeNo || "");
  const nickName = String(member.NickName || "").toLowerCase();
  return personnel.find((item) => {
    return (
      (mail && item.email.toLowerCase() === mail) ||
      (employeeNo && item.id === employeeNo) ||
      (nickName && item.email.toLowerCase().startsWith(`${nickName}@`))
    );
  });
}

function canResolveFortressPersonnel(session) {
  return session.identitySource === "fortress-sso-v3" && Boolean(fortressCredentials().appId && fortressCredentials().appSecret);
}

function httpsOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function dataFlowCredentialBrokerBootstrap({ employees = [], session = {} } = {}) {
  const hasDataFlowTool = employees.some((employee) => (employee.tools || [])
    .some((tool) => tool.id === "dataflow-rest-api" && tool.credentialMode === "device_session_refresh"));
  const expectedIdentity = dataFlowExpectedEnterpriseIdentity(session);
  if (!hasDataFlowTool || !currentUserToolCredentialChallengeBroker || !expectedIdentity) return null;
  const loginUrl = safeHttpsUrl(process.env.DATAFLOW_DEVICE_SESSION_LOGIN_URL);
  const accessTokenJsonPath = safeJsonPath(process.env.DATAFLOW_DEVICE_SESSION_ACCESS_TOKEN_JSON_PATH);
  const identityJsonPath = safeJsonPath(process.env.DATAFLOW_DEVICE_SESSION_IDENTITY_JSON_PATH);
  const expiresInSecondsJsonPath = safeJsonPath(process.env.DATAFLOW_DEVICE_SESSION_EXPIRES_IN_SECONDS_JSON_PATH, { optional: true });
  const paths = {
    refresh: safeAbsolutePath(process.env.DATAFLOW_DEVICE_SESSION_REFRESH_PATH),
    me: safeAbsolutePath(process.env.DATAFLOW_DEVICE_SESSION_ME_PATH),
    logout: safeAbsolutePath(process.env.DATAFLOW_DEVICE_SESSION_LOGOUT_PATH),
  };
  const allowedLoginOrigins = String(process.env.DATAFLOW_DEVICE_SESSION_ALLOWED_LOGIN_ORIGINS || "")
    .split(",").map((value) => httpsOrigin(value.trim())).filter(Boolean);
  const certificateSha256Fingerprints = String(process.env.DATAFLOW_DEVICE_SESSION_CERTIFICATE_SHA256_FINGERPRINTS || "")
    .split(",").map((value) => value.trim()).filter((value) => /^(?:[A-Fa-f0-9]{64}|(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})$/.test(value))
    .map((value) => value.replaceAll(":", "").toLowerCase());
  const actorBindingKey = base64Key(process.env.DATAFLOW_DEVICE_SESSION_ACTOR_BINDING_KEY);
  const pinsRequired = process.env.DATAFLOW_ALLOW_SELF_SIGNED_CERT === "1";
  if (!loginUrl || !accessTokenJsonPath || !identityJsonPath || Object.values(paths).some((value) => !value) ||
    !allowedLoginOrigins.length || !allowedLoginOrigins.includes(new URL(loginUrl).origin) ||
    (pinsRequired && !certificateSha256Fingerprints.length) || !actorBindingKey) return null;
  const actorSubjectDigest = resolveCenterSessionRoute({
    channelId: "desktop",
    employeeId: "current-user-tool-credential-broker",
    session,
    sessionKey: "current-user-tool-credential-broker",
  }).actorSubjectDigest;
  const actorBindingId = `dataflow-actor:${crypto.createHmac("sha256", actorBindingKey).update(actorSubjectDigest).digest("base64url")}`;
  return {
    contractVersion: "current-user-tool-credential-broker-bootstrap.v1",
    brokers: [{
      contractVersion: "current-user-tool-credential-broker.v1",
      toolId: "dataflow-rest-api",
      mode: "device_session_refresh",
      actorBindingId,
      apiOrigin: dataFlowApiOrigin,
      loginUrl,
      accessTokenJsonPath,
      identityJsonPath,
      expectedIdentity,
      ...(expiresInSecondsJsonPath ? { expiresInSecondsJsonPath } : {}),
      paths,
      allowedLoginOrigins: [...new Set(allowedLoginOrigins)],
      certificateSha256Fingerprints: [...new Set(certificateSha256Fingerprints)],
    }],
  };
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeJsonPath(value, { optional = false } = {}) {
  const pathValue = String(value || "").trim();
  if (!pathValue && optional) return "";
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,7}$/.test(pathValue) ? pathValue : "";
}

function safeAbsolutePath(value) {
  const pathValue = String(value || "").trim();
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/.test(pathValue) && !pathValue.includes("//") ? pathValue : "";
}

function base64Key(value) {
  try {
    const key = Buffer.from(String(value || ""), "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function revokeCurrentUserToolCredentials(session = {}) {
  try {
    const route = resolveCenterSessionRoute({
      channelId: "desktop",
      employeeId: "current-user-tool-credential-broker",
      session,
      sessionKey: "current-user-tool-credential-broker",
    });
    currentUserToolCredentialLeaseService.revokeSubject(route.actorSubjectDigest);
  } catch {
    // A session without a stable actor could not have acquired an actor-bound lease.
  }
}

function sendFeishuOAuthCallbackPage(res, status, message) {
  const safeMessage = String(message || "飞书用户授权处理完成。")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书用户授权</title><body style="font-family:system-ui;padding:40px;line-height:1.6"><h1>数字中心 · 飞书用户授权</h1><p>${safeMessage}</p></body></html>`);
}
