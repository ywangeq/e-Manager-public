import crypto from "node:crypto";
import { createSqliteExecutionTaskRepository } from "./sqlite-runtime-task-repository.mjs";
import { createExecutionTaskWorkerPump } from "./execution-task-worker-pump.mjs";
import { createCanonicalRuntimeTaskService } from "./canonical-runtime-task-service.mjs";
import { createSessionRouteAuthority } from "./session-route.mjs";
import { createEmployeeToolExecutor } from "./employee-tool-executor.mjs";

// Host composition for explicitly requested registered read operations. This is
// the same canonical task/Worker/Tool implementation, with no Center transport.
// Bodies and task state are transient; no recovery/replay of a private read.
export function createLocalReadTaskHost({ employee, adapter, authorize, actorContext }) {
  const authority = createSessionRouteAuthority({ routeDigestKey: crypto.randomBytes(32) });
  const repository = createSqliteExecutionTaskRepository({ databasePath: ":memory:", efficiencyFingerprintKey: crypto.randomBytes(32) });
  const tenantScope = "group-local-read";
  const pump = createExecutionTaskWorkerPump({ repository, tenantScope, workerIdDigest: crypto.randomBytes(32).toString("hex"), pollIntervalMs: 5 });
  const routeFor = ({ actor, employeeId = employee.id, channelId = "desktop" }) => authority.create({
    centerInstanceId: "group-local", tenantScope, actorIssuer: "group-local-session", actorSubjectId: actor.key,
    employeeId, channelId, accountId: "local", conversationType: "direct", conversationId: actor.key,
  });
  const runtime = createCanonicalRuntimeTaskService({ executionTaskRepository: repository,
    resolveActorRoute: routeFor, routeVerifier: authority.verify, workerPump: pump });
  const active = new Map();
  let closed = false, generation = 0;
  const pending = new Set();
  async function execute(input) {
      if (closed) throw new Error("local_read_closed");
      const revision = generation;
      const actor = actorContext();
      if (!actor?.key) throw new Error("local_read_authentication_required");
      const args = adapter.normalizeInput(input);
      const route = routeFor({ actor });
      const requestId = crypto.randomUUID(), sessionId = `local-${requestId}`;
      const current = () => !closed && revision === generation && actorContext()?.key === actor.key && actorContext()?.version === actor.version;
      const declared = () => (employee.toolBindings || []).some(binding => (binding.toolId || binding.id)===adapter.toolId && binding.enabled===true && binding.credentialMode===adapter.credentialMode && binding.writebackBoundary==="none");
      const allowed = async () => current() && declared() && await authorize({actor,toolId:adapter.toolId,operationId:adapter.operationId,action:"read",risk:"low",writebackBoundary:"none"}) === true && current() && declared();
      if (!await allowed()) throw new Error("local_read_not_authorized");
      const task = runtime.createConversationTask({ employee, route, requestId, sourceSystemId:"group-local-operation",
        taskType:"digital_employee_chat", executionInput:{session:{sessionId},entry:{contractVersion:"transcript-entry.v1",
          entryId:requestId,idempotencyKey:requestId,sessionId,seq:1,type:"message",createdAt:new Date().toISOString(),
          message:{role:"user",content:JSON.stringify({toolId:adapter.toolId,operationId:adapter.operationId,input:args})}}} });
      active.set(task.id,actor);
      try {
        const completed = await runtime.runConversationTask(task,async ownership => {
          const name = "local_registered_read";
          const executor = await createEmployeeToolExecutor({employee,additionalExecutors:[{
            handledToolIds:()=>[adapter.toolId],toolDefinitions:()=>[{name,description:"Explicit registered read",parameters:adapter.inputSchema}],
            async execute(call,options) {
              if (call.name !== name || !await allowed() || options.signal?.aborted) throw new Error("local_read_not_authorized");
              const data = await adapter.execute(adapter.normalizeInput(call.arguments),options);
              if (!await allowed() || options.signal?.aborted) throw new Error("local_read_actor_changed");
              return {ok:true,status:"completed",data:adapter.normalizeResult(data)};
            },
          }]});
          const result = await executor.execute({name,arguments:args},{signal:ownership.signal});
          if (result.ok !== true) throw new Error("local_read_failed");
          return {ok:true,privateResult:result.data,settlement:{status:"completed",resultSummary:"Registered local read completed."}};
        });
        if (!current() || completed.task.status !== "completed" || !completed.settled) throw new Error("local_read_not_completed");
        return {taskId:task.id,status:"completed",input:args,result:completed.value.privateResult};
      } finally { active.delete(task.id); }
  }
  return Object.freeze({
    execute(input) { const result = execute(input); pending.add(result); return result.finally(() => pending.delete(result)); },
    cancel() { generation++; for (const [taskId,actor] of active) runtime.cancelTask({actor,employeeId:employee.id,taskId,reasonCode:"resource_reclaimed"}); },
    async close() { closed=true; this.cancel(); await Promise.allSettled([...pending]); await pump.close(); repository.close(); },
  });
}
