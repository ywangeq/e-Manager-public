import { isDeepStrictEqual } from "node:util";
import {
  boundedDeviceReadResult,
  deviceReadAdapterDigest,
  deviceReadOperationDigest,
} from "../../desktop-channel-mvp/shared/device-read-operation-v1.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTEXT_FIELDS = ["taskId", "taskInputDigest", "actorDigest", "deviceSessionDigest", "leaseFenceDigest"];

// Composition boundary only: the injected canonical dispatcher owns durable
// claim/CAS, current actor/Device/lease checks and terminal evidence. No IPC,
// credential, queue, replay or production capability is created here.
export function createDeviceReadToolExecutor({ employee = {}, operations = [], context = null,
  authorizeToolCall = null, validateLiveContext = null, dispatchRead = null } = {}) {
  const bindings = employee.toolBindings || employee.tools || [];
  const registry = new Map();
  const names = new Set();
  for (const entry of operations) {
    if (!validId(entry?.name) || !validId(entry?.descriptor?.toolId) ||
      !validId(entry?.descriptor?.operationId) || !validId(entry?.descriptor?.credentialMode) || entry?.operation?.action !== "read" ||
      entry?.operation?.risk !== "read_only" || entry?.operation?.writebackBoundary !== "none" ||
      entry.operation.toolId !== entry.descriptor.toolId || entry.operation.operationId !== entry.descriptor.operationId ||
      !validIds(entry.operation.scope) || !validIds(entry.operation.capabilities) ||
      typeof entry.descriptor.normalizeInput !== "function" || typeof entry.descriptor.normalizeResult !== "function")
      throw new TypeError("device_read_registration_invalid");
    if (names.has(entry.name)) throw new TypeError("device_read_registration_conflict");
    names.add(entry.name);
    const descriptor = Object.freeze({ ...entry.descriptor,
      inputSchema: freeze(structuredClone(entry.descriptor.inputSchema)),
      resultSchema: freeze(structuredClone(entry.descriptor.resultSchema)) });
    const adapterDigest = deviceReadAdapterDigest(descriptor);
    const operation = freeze({ ...structuredClone(entry.operation), toolName: entry.name, contractDigest: adapterDigest,
      sideEffectFree: true, confirmationPolicy: "not_required", operationIdSource: "contract" });
    if (bindings.some(binding => (binding.toolId || binding.id) === descriptor.toolId &&
      binding.enabled === true && binding.writebackBoundary === "none" && binding.credentialMode === descriptor.credentialMode))
      registry.set(entry.name, Object.freeze({ name: entry.name, descriptor, operation, adapterDigest }));
  }
  const identity = context && Object.getPrototypeOf(context) === Object.prototype &&
    Object.keys(context).length === CONTEXT_FIELDS.length && CONTEXT_FIELDS.every(key => Object.hasOwn(context, key)) &&
    typeof context.taskId === "string" && ID.test(context.taskId) &&
    CONTEXT_FIELDS.slice(1).every(key => typeof context[key] === "string" && DIGEST.test(context[key]))
    ? Object.freeze({ ...context }) : null;
  const available = Boolean(identity && typeof authorizeToolCall === "function" &&
    typeof validateLiveContext === "function" && typeof dispatchRead === "function");
  const privateResults = new WeakMap();
  const failure = (error, status = "blocked") => Object.freeze({ ok: false, status, error });

  async function execute(call = {}, { signal } = {}) {
    if (signal?.aborted) return failure("agent_turn_canceled", "canceled");
    const entry = registry.get(call.name);
    if (!entry || !available) return failure("device_read_context_unavailable");
    if (!validId(call.callId)) return failure("device_read_call_id_invalid");
    let input;
    try {
      input = structuredClone(call.arguments);
      if (!isDeepStrictEqual(entry.descriptor.normalizeInput(structuredClone(input)), input)) throw new Error();
      // Canonical digest also rejects non-JSON values before any authorization.
      deviceReadOperationDigest({ input });
      freeze(input);
    } catch { return failure("tool_arguments_invalid"); }
    const binding = Object.freeze({ ...identity, toolCallId: call.callId,
      toolId: entry.descriptor.toolId, operationId: entry.descriptor.operationId,
      adapterDigest: entry.adapterDigest, inputDigest: deviceReadOperationDigest({ input }) });
    const allowed = async () => {
      if (signal?.aborted || await validateLiveContext(binding, { signal }) !== true) return false;
      const decision = await authorizeToolCall({ ...entry.operation, name: entry.name,
        arguments: input, contractDigest: entry.adapterDigest }, entry.operation, [entry.operation]);
      return !signal?.aborted && decision?.status === "allowed" &&
        await validateLiveContext(binding, { signal }) === true && !signal?.aborted;
    };
    try {
      if (!await allowed()) return failure(signal?.aborted ? "agent_turn_canceled" : "tool_invocation_blocked", signal?.aborted ? "canceled" : "blocked");
      const response = await dispatchRead({ binding, input }, { signal });
      if (signal?.aborted) return failure("agent_turn_canceled", "canceled");
      if (response?.status !== "completed" || !isDeepStrictEqual(response.binding, binding))
        return failure("device_read_terminal_unavailable");
      const data = boundedDeviceReadResult(response.result, entry.descriptor);
      if (!await allowed()) return failure(signal?.aborted ? "agent_turn_canceled" : "device_read_authority_changed", signal?.aborted ? "canceled" : "blocked");
      const safe = Object.freeze({ ok: true, status: "completed", toolId: binding.toolId, operationId: binding.operationId });
      privateResults.set(safe, freeze({ ...safe, data }));
      return safe;
    } catch { return failure(signal?.aborted ? "agent_turn_canceled" : "device_read_failed", signal?.aborted ? "canceled" : "failed"); }
  }
  return Object.freeze({ execute,
    handledToolIds: () => [...new Set([...registry.values()].map(entry => entry.descriptor.toolId))],
    toolDefinitions: () => available ? [...registry.values()].map(entry => ({ type: "function", name: entry.name,
      description: entry.operation.summary || entry.name, parameters: entry.descriptor.inputSchema, strict: true })) : [],
    agentResultFor: result => privateResults.get(result) || result,
  });
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validId(value) { return typeof value === "string" && ID.test(value); }
function validIds(value) {
  return Array.isArray(value) && value.length > 0 && value.every(validId) && new Set(value).size === value.length;
}
