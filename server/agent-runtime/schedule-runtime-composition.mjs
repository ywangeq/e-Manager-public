import { operationReceiptContextForExecutionOwnership } from "./operation-receipt-context.mjs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createSqliteScheduleControlRepository } from "./sqlite-schedule-control-repository.mjs";
import { createSqliteScheduleTriggerRepository } from "./sqlite-schedule-trigger-repository.mjs";
import { createScheduleAgentActivationAuthorityResolver, createScheduleRunConfigurationResolver, createScheduleAgentContextResolver } from "./schedule-agent-context.mjs";
import { resolveEffectiveSkillScope } from "./skill-scope-resolver.mjs";
import { createScheduleAgentTerminalEvidenceResolver } from "./schedule-agent-terminal-evidence.mjs";
import { createScheduleRunAgentAdapter, createScheduleAgentResultSettler } from "./schedule-run-agent-adapter.mjs";
import { createScheduleRunExecutionLifecycle } from "./schedule-run-execution-lifecycle.mjs";
import { createScheduleCurrentSlotVerifier } from "./schedule-current-slot-verifier.mjs";
import { createScheduleRunIntentDispatcher } from "./schedule-run-intent-dispatcher.mjs";
import { createScheduleOneShotScannerCoordinator } from "./schedule-one-shot-scanner-coordinator.mjs";
import { createScheduleScanRuntimeCoordinator } from "./schedule-scan-runtime-coordinator.mjs";
import { createScheduleManualExecutionService } from "./schedule-manual-execution-service.mjs";
import { createEmployeeToolExecutor } from "./employee-tool-executor.mjs";
import { managedOpenApiToolInvocationCheck } from "./managed-openapi-tool-executor.mjs";
import { skillToolCompletionPolicies } from "./skill-tool-completion-policy.mjs";

// Center composition only: no personal session, second scheduler, or business executor.
export function createScheduleRuntimeComposition({ tenantScope, controlDatabasePath, triggerDatabasePath,
  registry, resolveEmployee, getBusinessSkills, resolveDefinition, deriveKey, executionTaskRepository,
  agentExecutionService, workspaceManager, taskArtifactService, resolveProviderLease,
  managedOpenApiTools, idempotentEffectService, operationReceiptProjector,
  authorizeManagementSession, managementActor, wakeWorker,
  now = () => new Date().toISOString(), scanIntervalMs = 30_000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (![authorizeManagementSession, managementActor, deriveKey, resolveEmployee, getBusinessSkills].every(fn => typeof fn === "function") ||
    !Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 1000) throw new TypeError("Schedule composition authorities required");
  let manualScope = null;
  const requireEmployee = request => {
    if (request.tenantScope !== tenantScope) throw failure("schedule_tenant_forbidden");
    const employee = resolveEmployee(request);
    if (!employee || employee instanceof Promise || employee.id !== request.employeeId) throw failure("schedule_agent_employee_unavailable");
    return employee;
  };
  const authorities = { resolveEmployee: requireEmployee, getBusinessSkills, registry };
  const triggerRepository = createSqliteScheduleTriggerRepository({ databasePath: triggerDatabasePath });
  const keyId = "schedule-run-configuration-v1";
  const controlRepository = createSqliteScheduleControlRepository({ databasePath: controlDatabasePath, now,
    resolveTaskExecutionDefinition: resolveDefinition,
    resolveAgentActivationAuthority: createScheduleAgentActivationAuthorityResolver(authorities),
    resolveRunConfiguration: createScheduleRunConfigurationResolver({ ...authorities, resolveDefinition }),
    resolveAgentTerminalEvidence: createScheduleAgentTerminalEvidenceResolver({ executionTaskRepository, scheduleTriggerRepository: triggerRepository }),
    runConfigurationEncryption: { currentEncryptionKeyId: keyId,
      encryptionKeys: { [keyId]: deriveKey("schedule-run-configuration.encryption.v1") },
      stableIntegrityHmacKey: deriveKey("schedule-run-configuration.integrity.v1") },
    authorizeManualRun: request => {
      if (!manualScope || ["tenantScope", "employeeId", "scheduleId"].some(key => request[key] !== manualScope[key]) ||
        !isDeepStrictEqual(request.actor, manualScope.actor)) return false;
      registry.resolveAgentAuthority({ ...request, employee: requireEmployee(request) });
      return true;
    },
  });
  function resolveCurrent({ task, snapshot, runConfiguration }) {
    const employee = requireEmployee(task);
    const authority = registry.resolveAgentAuthority({ tenantScope: task.tenantScope, employee, scheduleId: snapshot.scheduleId });
    if (!isDeepStrictEqual(authority.actor, snapshot.actor) || !isDeepStrictEqual(authority.owner, snapshot.owner) ||
      authority.scheduleScope !== snapshot.scheduleScope) throw failure("schedule_agent_current_authority_changed");
    const scope = resolveEffectiveSkillScope({ employee, skills: getBusinessSkills({ tenantScope, employee }) });
    const allowed = new Set(scope.callableSkillIds);
    if (runConfiguration.configuration.dependencyContext.skillScope.callableSkillIds.some(id => !allowed.has(id))) {
      throw failure("schedule_agent_skill_revoked");
    }
    return { allowed: true, employee };
  }
  const resolveContext = createScheduleAgentContextResolver({ resolveCurrent, resolveDefinition, resolveProviderLease,
    createToolExecutor: ({ employee, dependencyContext, revalidate, ownership }) => createEmployeeToolExecutor({
      employee, managedOpenApiTools, idempotentEffectService, operationReceiptProjector,
      defaultOperationReceiptContext: operationReceiptContextForExecutionOwnership(ownership),
      toolCompletionPolicies: skillToolCompletionPolicies(dependencyContext.callableSkills),
      authorizeToolCall: async (toolCall, operation, allOperations) => {
        const frozen = managedOpenApiToolInvocationCheck({ employee, toolCall, operation, allOperations });
        if (frozen.status !== "allowed") return frozen;
        const current = await revalidate(operation);
        return managedOpenApiToolInvocationCheck({ employee: current.employee, toolCall, operation, allOperations });
      },
    }),
  });
  const adapter = createScheduleRunAgentAdapter({ agentExecutionService, resolveContext,
    settleResult: createScheduleAgentResultSettler({ workspaceManager, taskArtifactService, now: () => new Date(now()) }) });
  const lifecycle = createScheduleRunExecutionLifecycle({ controlRepository, executionTaskRepository,
    scheduleTriggerRepository: triggerRepository, productionAdapter: adapter, now: () => new Date(now()),
    runOwnerDigest: crypto.randomBytes(32).toString("hex") });
  const verifier = createScheduleCurrentSlotVerifier({ controlRepository });
  const dispatcher = createScheduleRunIntentDispatcher({ controlRepository, executionTaskRepository,
    scheduleTriggerRepository: triggerRepository, verifyScheduledFor: verifier.verifyScheduledFor, now: () => new Date(now()),
    resolveActivatedScheduleSnapshot: request => controlRepository.resolveActiveActivationSnapshot(request), wakeWorker });
  const scanner = createScheduleOneShotScannerCoordinator({ controlRepository,
    listActiveSnapshotControls: request => controlRepository.listActiveSnapshotControls(request), runIntentDispatcher: dispatcher,
    scannerOwnerDigest: crypto.randomBytes(32).toString("hex"), currentTime: now });
  const coordinator = createScheduleScanRuntimeCoordinator({ runExecutionLifecycle: lifecycle, scannerCoordinator: scanner,
    tenantScopes: [tenantScope], now });
  const manual = createScheduleManualExecutionService({ controlRepository, dispatcher,
    requestHmacKey: deriveKey("schedule-manual-request.integrity.v1") });
  const manualExecutionService = Object.freeze({ execute(input, { session } = {}) {
    if (authorizeManagementSession(session) !== true || manualScope) throw failure("schedule_manual_forbidden");
    const actor = managementActor(session);
    if (actor.principalId !== input.actor?.principalId || actor.identitySource !== input.actor?.identitySource) throw failure("schedule_manual_forbidden");
    manualScope = { ...input, actor };
    try { return manual.execute({ ...input, actor }); } finally { manualScope = null; }
  } });
  let timer = null;
  let closed = false;
  let startPromise = null;
  return Object.freeze({ controlRepository, triggerRepository, lifecycle, dispatcher, manualExecutionService,
    // Startup is explicit, after all Center authorities and Worker exist.
    async start() {
      if (closed) throw failure("schedule_runtime_closed");
      if (!startPromise) startPromise = (async () => {
        await coordinator.start();
        if (closed) return;
        timer = setIntervalFn(() => coordinator.wake(), scanIntervalMs);
        timer?.unref?.();
      })();
      return startPromise;
    },
    async stop() {
      closed = true;
      if (timer) clearIntervalFn(timer);
      timer = null;
      await coordinator.close();
    },
    closeStores() { controlRepository.close(); triggerRepository.close(); },
  });
}
function failure(code) { return Object.assign(new Error(code), { code }); }
