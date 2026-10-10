import { PERSONAL_AUTOMATION_CONTRACT, automationDigest, automationError, automationScope, normalizeAutomationRequest, personalSlotIdentity, TERMINAL_TASK_STATES } from "./personal-automation-contract.mjs";
import { latestIntervalSlot } from "./interval-due-slot.mjs";
import { createRuntimeTaskExecutionInputResolver } from "./runtime-task-execution-input-resolver.mjs";
import { taskMaterialBindingsRequireSourceAccess } from "./task-material-binding.mjs";

export function createPersonalAutomationService({ repository, ownerRepository, instructionStore = null, runtimeTaskService, sessionRepository,
  resolveRoute, resolveEmployee, canInvoke, resolveRecoverySession, permissionDigest, resolveSkillScope = () => [], readDesktopPresence = () => null, now = () => new Date().toISOString() }) {
  const inputResolver = createRuntimeTaskExecutionInputResolver({ sessionRepository, resolveEmployee });
  const scopeFor = session => automationScope(resolveRoute({ session, employeeId: "personal-automations", channelId: "desktop" }));
  const employeeDigest = employee => automationDigest([employee.version, employee.permissionScope, employee.toolBindings || employee.tools, employee.skills, employee.skillIds, employee.mountedSkills, employee.runtimeBinding, resolveSkillScope(employee), ...(employee.serviceScope ? [employee.serviceScope] : [])]);

  function requireEmployee(session, employeeId, version = null, scopeDigest = null) {
    const employee = resolveEmployee(employeeId);
    if (!employee || !canInvoke({session, employee, channelId:"desktop"}) || (version && employee.version !== version) || (scopeDigest && employeeDigest(employee) !== scopeDigest)) {
      throw automationError("personal_automation_authorization_changed");
    }
    return employee;
  }
  function project(definition) {
    return { automationId:definition.automationId, contractVersion:PERSONAL_AUTOMATION_CONTRACT, version:definition.version,
      employeeId:definition.employeeId, sourceTaskId:definition.sourceTaskId, intervalSeconds:definition.intervalSeconds,
      startAt:definition.startAt, expiresAt:definition.expiresAt, timezone:definition.timezone, maxRuns:definition.maxRuns,
      runCount:definition.runCount, state:definition.state, revision:definition.revision, reasonCode:definition.reasonCode,
      lastTaskId:definition.lastTaskId, budget:definition.budget, notificationPolicy:"terminal_runs", missedSlotPolicy:"latest_only" };
  }
  async function sourceInput(definition) {
    const task = runtimeTaskService.readCanonicalExecutionTask(definition.sourceTaskId, {tenantScope:definition.tenantScope});
    if (!task || task.actorIssuer !== definition.actorIssuer || task.actorSubjectDigest !== definition.actorSubjectDigest ||
      task.employeeId !== definition.employeeId || task.sessionId !== definition.sessionId) throw automationError("personal_automation_input_unavailable");
    const resolved = await inputResolver.resolve(task);
    if (definition.version === 2) {
      const content = instructionStore?.read({refId:definition.instructionRef,sessionId:definition.sessionId,routeDigest:resolved.route.routeDigest});
      if (typeof content !== "string" || instructionStore.digest(content) !== definition.instructionDigest) throw automationError("personal_automation_input_unavailable");
      return {...resolved, userText:content};
    }
    if (definition.version !== 1 || task.executionInputRef?.refId !== definition.instructionRef || task.inputDigest !== definition.instructionDigest) throw automationError("personal_automation_input_unavailable");
    return resolved;
  }
  async function create(session, input, frozenInstruction = null) {
    if (repository.enabled === false) throw automationError("personal_automation_not_active");
    const timestamp = now();
    const request = normalizeAutomationRequest(input,timestamp);
    const scope = scopeFor(session);
    const employee = requireEmployee(session,request.employeeId);
    const source = runtimeTaskService.readCanonicalExecutionTask(request.sourceTaskId,{tenantScope:scope.tenantScope});
    if (!source || source.actorIssuer !== scope.actorIssuer || source.actorSubjectDigest !== scope.actorSubjectDigest || source.employeeId !== employee.id ||
      source.channelId !== "desktop" || source.taskType !== "digital_employee_chat" || source.sourceSystemId === "personal-automation" ||
      taskMaterialBindingsRequireSourceAccess(runtimeTaskService.readTaskMaterialBindings(source.taskId,{tenantScope:scope.tenantScope}))) throw automationError("personal_automation_input_unavailable");
    const automationId = `pa_${automationDigest([scope,request.idempotencyKey])}`;
    const existing = repository.get(scope,automationId);
    if (existing) {
      const compare = Object.keys(request).filter(k => k !== "idempotencyKey");
      if (compare.some(k => existing[k] !== request[k]) || (frozenInstruction !== null
        ? existing.version !== 2 || existing.instructionDigest !== instructionStore?.digest(frozenInstruction)
        : existing.version !== 1)) throw automationError("personal_automation_idempotency_conflict");
      return project(existing);
    }
    // Preserve completed idempotent replays, but reject expired new definitions before any preparation writes.
    if (request.expiresAt <= timestamp) throw automationError("personal_automation_time_invalid");
    const definition = { ...scope,...request,automationId,version:1,contractVersion:PERSONAL_AUTOMATION_CONTRACT,
      employeeVersion:employee.version,sessionId:source.sessionId,instructionRef:source.executionInputRef.refId,instructionDigest:source.inputDigest,
      permissionDigest:permissionDigest(session),scopeDigest:employeeDigest(employee),
      budget:{taskExecutionTotalMs:source.providerTimeoutPolicy.taskExecutionTotalMs}, createdAt:timestamp };
    const resolved = await sourceInput(definition);
    const expectedRoute = resolveRoute({session,employeeId:employee.id,channelId:"desktop"});
    if (expectedRoute.routeDigest !== resolved.route.routeDigest) throw automationError("personal_automation_input_unavailable");
    if (frozenInstruction !== null) {
      if (!instructionStore) throw automationError("personal_automation_not_active");
      const frozen = instructionStore.save({refId:`instruction:${automationId}`,sessionId:source.sessionId,routeDigest:expectedRoute.routeDigest,content:frozenInstruction});
      definition.version = 2;
      definition.instructionRef = frozen.refId;
      definition.instructionDigest = frozen.digest;
    }
    // Reuse the encrypted identity-locator authority; never store a request credential.
    const existingOwner = ownerRepository.get(automationId,{now:new Date(timestamp)});
    definition.createdAt = existingOwner?.createdAt || timestamp;
    ownerRepository.saveOrGet({ contractVersion:"execution-admission.v1",taskId:automationId,
      actorLocator:{identitySource:String(session.identitySource || session.authorization?.identitySource || "center"),
        subjectId:String(session.feishuUserId || session.employeeId || session.email || ""),subjectIdType:session.feishuUserId ? "feishu_id" : session.employeeId ? "employee_id" : "email"},
      // This binding identifies the authenticated creation source; instructionRef owns execution text.
      routeBinding:{...scope,employeeId:employee.id,sessionId:source.sessionId,entryId:source.executionInputRef.refId,routeDigest:resolved.route.routeDigest},
      employeeVersion:employee.version,channelId:"desktop",permissionDigest:definition.permissionDigest,createdAt:definition.createdAt,expiresAt:definition.expiresAt }, {now:new Date(timestamp)});
    return project(repository.create(definition));
  }
  async function authorizeConversation(session, taskId) {
    const scope = scopeFor(session);
    const task = runtimeTaskService.readCanonicalExecutionTask(taskId,{tenantScope:scope.tenantScope});
    if (!task || task.actorIssuer !== scope.actorIssuer || task.actorSubjectDigest !== scope.actorSubjectDigest ||
      task.channelId !== "desktop" || task.taskType !== "digital_employee_chat" || task.sourceSystemId === "personal-automation") throw automationError("personal_automation_authorization_changed");
    const admission = runtimeTaskService.readExecutionAdmission(taskId);
    const current = admission && await resolveRecoverySession(admission.actorLocator);
    if (!current || automationDigest(scopeFor(current)) !== automationDigest(scope) || permissionDigest(current) !== permissionDigest(session) || permissionDigest(current) !== admission.permissionDigest) throw automationError("personal_automation_authorization_changed");
    requireEmployee(current,task.employeeId,task.employeeVersion);
    return task;
  }
  async function authorizeScheduledRun(session, taskId) {
    const scope = scopeFor(session);
    const task = runtimeTaskService.readCanonicalExecutionTask(taskId,{tenantScope:scope.tenantScope});
    if (!task || task.actorIssuer !== scope.actorIssuer || task.actorSubjectDigest !== scope.actorSubjectDigest ||
      task.channelId !== "desktop" || task.taskType !== "digital_employee_chat" || task.sourceSystemId !== "personal-automation" ||
      task.status !== "running") throw automationError("personal_automation_authorization_changed");
    const definition = repository.forTask(task);
    const admission = runtimeTaskService.readExecutionAdmission(taskId);
    const expectedBinding = {...scope,employeeId:task.employeeId,sessionId:task.sessionId,entryId:task.executionInputRef?.refId};
    if (!admission || admission.taskId !== taskId || admission.channelId !== task.channelId ||
      admission.employeeVersion !== task.employeeVersion ||
      Object.entries(expectedBinding).some(([field,value]) => admission.routeBinding?.[field] !== value)) {
      throw automationError("personal_automation_authorization_changed");
    }
    const resolved = await inputResolver.resolve(task);
    if (resolved.route.routeDigest !== admission.routeBinding.routeDigest) throw automationError("personal_automation_authorization_changed");
    const current = await resolveRecoverySession(admission.actorLocator);
    if (!definition || automationDigest(automationScope(definition)) !== automationDigest(scope) ||
      definition.employeeId !== task.employeeId || definition.sessionId !== task.sessionId ||
      definition.employeeVersion !== task.employeeVersion || !current ||
      automationDigest(scopeFor(current)) !== automationDigest(scope) || permissionDigest(current) !== permissionDigest(session) ||
      permissionDigest(current) !== admission.permissionDigest || permissionDigest(current) !== definition.permissionDigest) {
      throw automationError("personal_automation_authorization_changed");
    }
    requireEmployee(current,task.employeeId,task.employeeVersion,definition.scopeDigest);
    await sourceInput(definition);
    const latest = runtimeTaskService.readCanonicalExecutionTask(taskId,{tenantScope:scope.tenantScope});
    if (!latest || latest.status !== "running") throw automationError("personal_automation_authorization_changed");
    requireEmployee(current,task.employeeId,task.employeeVersion,definition.scopeDigest);
    return {task:latest,automationId:definition.automationId};
  }
  async function createFromConversation(session, taskId, input) {
    const task = await authorizeConversation(session,taskId);
    const {executionInstruction,...schedule} = input || {};
    if (typeof executionInstruction !== "string" || !executionInstruction.trim() || executionInstruction.length > 8000 ||
      Object.keys(schedule).some(k => !["intervalSeconds","startAt","expiresAt","maxRuns","timezone"].includes(k))) throw automationError("personal_automation_request_invalid");
    return create(session,{...schedule,sourceTaskId:taskId,employeeId:task.employeeId,idempotencyKey:taskId},executionInstruction.trim());
  }
  function list(session) {
    const scope = scopeFor(session);
    return {contractVersion:"personal-automation-page.v1",automations:repository.list(scope).map(project),notifications:repository.notifications(scope)};
  }
  function detail(session,id) {
    const value = repository.detail(scopeFor(session),id);
    return {automation:project(value.definition),runs:value.runs};
  }
  async function change(session,id,request) {
    if (!request || Object.keys(request).some(k => !["action","expectedRevision"].includes(k))) throw automationError("personal_automation_request_invalid");
    if (request.action === "resume") {
      const current = repository.get(scopeFor(session),id);
      if (!current) throw automationError("personal_automation_not_found");
      requireEmployee(session,current.employeeId,current.employeeVersion,current.scopeDigest);
      if (permissionDigest(session) !== current.permissionDigest) throw automationError("personal_automation_authorization_changed");
      await sourceInput(current);
    }
    return project(repository.change(scopeFor(session),id,request.expectedRevision,request.action,now()));
  }
  async function runOnce() {
    if (repository.enabled === false) return;
    ownerRepository.purgeExpired({now:new Date(now())});
    repository.reconcile(now());
    for (const definition of repository.candidates()) {
      const timestamp = now();
      const presence = readDesktopPresence(definition);
      const after = presence && presence.connectedSince > definition.cursorAfter ? presence.connectedSince : definition.cursorAfter;
      const slot = latestIntervalSlot({...definition,afterExclusive:after,throughInclusive:timestamp});
      if (!presence || !slot) {
        repository.advance(definition,timestamp,null,null,{skipDueSlot:true});
        continue;
      }
      const last = definition.lastTaskId && runtimeTaskService.readCanonicalExecutionTask(definition.lastTaskId,{tenantScope:definition.tenantScope});
      if (!slot || timestamp >= definition.expiresAt || definition.runCount >= definition.maxRuns || (last && !TERMINAL_TASK_STATES.has(last.status))) {
        repository.advance(definition,timestamp);
        continue;
      }
      try {
        const owner = ownerRepository.get(definition.automationId,{now:new Date(timestamp)});
        if (!owner) throw automationError("personal_automation_authorization_changed");
        const session = await resolveRecoverySession(owner.actorLocator);
        if (!session || automationDigest(scopeFor(session)) !== automationDigest(automationScope(definition)) || permissionDigest(session) !== definition.permissionDigest) throw automationError("personal_automation_authorization_changed");
        const employee = requireEmployee(session,definition.employeeId,definition.employeeVersion,definition.scopeDigest);
        await sourceInput(definition);
        const route = resolveRoute({session,employeeId:employee.id,channelId:"desktop"});
        const current = await sessionRepository.openSession({route});
        const slotId = personalSlotIdentity(definition,slot);
        const assertDispatchEligible = () => {
          const currentPresence = readDesktopPresence(definition);
          if (!currentPresence || currentPresence.generation !== presence.generation || slot <= currentPresence.connectedSince) {
            throw automationError("personal_automation_presence_fenced");
          }
          const saved = repository.get(definition,definition.automationId);
          if (!saved || saved.state !== "active" || saved.revision !== definition.revision || saved.cursorAfter !== definition.cursorAfter) {
            throw automationError("personal_automation_revision_conflict");
          }
          return true;
        };
        const executionInput = await sessionRepository.appendTranscriptEntry({route,sessionId:current.sessionId,
          at:now(),idempotencyKey:`personal-automation:${slotId}`,extendsInteraction:false,
          commitGuard:assertDispatchEligible,
          entry:{type:"message",message:{role:"user",content:`个人定时任务待执行引用（${definition.automationId}）`}} });
        runtimeTaskService.createConversationTask({actorLocator:owner.actorLocator,employee,executionInput,route,
          requestId:`personal-automation:${slotId}`,sourceSystemId:"personal-automation",permissionDigest:definition.permissionDigest,
          commitSubmission:submission => {
            // Every async preparation is fenced again at the actual commit time.
            assertDispatchEligible();
            requireEmployee(session,definition.employeeId,definition.employeeVersion,definition.scopeDigest);
            if (permissionDigest(session) !== definition.permissionDigest) throw automationError("personal_automation_authorization_changed");
            return repository.advance(definition,now(),submission,slot);
          }});
      } catch (error) {
        if (["personal_automation_revision_conflict","runtime_task_submission_fenced","personal_automation_presence_fenced","session_mutation_commit_rejected"].includes(error?.code)) continue;
        const reason = /input|session|transcript/.test(error?.code || "") ? "input_unavailable" : /authorization|permission|employee/.test(error?.code || "") ? "authorization_changed" : "execution_unavailable";
        repository.hold(definition,reason);
      }
    }
  }
  async function resolveTaskInput(task) {
    if (task.sourceSystemId !== "personal-automation") return null;
    const definition = repository.forTask(task);
    if (!definition || automationDigest(automationScope(definition)) !== automationDigest(automationScope(task))) throw automationError("personal_automation_input_unavailable");
    const resolved = await inputResolver.resolve(task);
    if (employeeDigest(resolved.employee) !== definition.scopeDigest) throw automationError("personal_automation_authorization_changed");
    const source = await sourceInput(definition);
    const runs = repository.detail(definition, definition.automationId).runs;
    if (!runs.some(run => run.taskId === task.taskId)) throw automationError("personal_automation_context_unavailable");
    const contextTasks = [definition.sourceTaskId, ...runs.map(run => run.taskId)].map(taskId => {
      const member = runtimeTaskService.readCanonicalExecutionTask(taskId, {tenantScope:definition.tenantScope});
      if (!member || ["tenantScope","actorIssuer","actorSubjectDigest","employeeId","sessionId","channelId"].some(field => member[field] !== task[field]) ||
        member.taskType !== "digital_employee_chat" || !member.executionInputRef?.refId ||
        (taskId !== definition.sourceTaskId && member.sourceSystemId !== "personal-automation")) {
        throw automationError("personal_automation_context_unavailable");
      }
      return member;
    });
    return {...resolved,userText:source.userText,contextProjection:{
      policy:"exact_task_history",sessionId:task.sessionId,routeDigest:resolved.route.routeDigest,
      taskIds:contextTasks.map(member => member.taskId),inputEntryIds:contextTasks.map(member => member.executionInputRef.refId),
    }};
  }
  return Object.freeze({create,createFromConversation,authorizeConversation,authorizeScheduledRun,list,detail,change,runOnce,resolveTaskInput,
    markRead:(session,id,taskId) => repository.markRead(scopeFor(session),id,taskId,now())});
}
