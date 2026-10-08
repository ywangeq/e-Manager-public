import { createGroupExecutionContext } from "./group-execution-context-v1.mjs";

const GROUP_STEP_INPUT_RESOLVER_CONTRACT = "group-step-input-resolver.v1";

// Registered at the standard input boundary. Metadata validation is owned by
// the execution context; it is not duplicated in this dispatch adapter.
export function createGroupStepInputResolver({ taskRepository, authorizeTask, resolveActor } = {}) {
  if (typeof resolveActor !== "function") throw new TypeError("group step resolver requires current actor resolution");
  const context = createGroupExecutionContext({ taskRepository, authorizeTask });
  return Object.freeze({
    contractVersion: GROUP_STEP_INPUT_RESOLVER_CONTRACT,
    async resolve(task) {
      if (task?.taskType !== "group_step") return null;
      let actor;
      try { actor = await resolveActor(task); }
      catch { actor = null; }
      if (!actor) {
        const error = new Error("group_execution_authorization_unavailable");
        error.code = error.message;
        throw error;
      }
      return context.resolve({ task, actor });
    },
  });
}

export { GROUP_STEP_INPUT_RESOLVER_CONTRACT };
