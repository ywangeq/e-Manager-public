import { createDeviceReadSessionRegistry } from "./device-read-session-registry.mjs";
import { createDeviceReadDispatchService } from "./device-read-dispatch-service.mjs";
import { createDeviceReadRuntimeTools } from "./device-read-runtime-tools.mjs";
import { createDeviceReadTransport } from "./device-read-transport.mjs";
import { deviceReadAdapterDigest } from "../../desktop-channel-mvp/shared/device-read-operation-v1.mjs";

// Neutral host assembly. Fixed vendor operations are supplied by the capability
// registry; no vendor or employee branches belong in this service.
export function createDeviceReadCenterServices({ repository, operations, resolveActor, resolveRecoverySession,
  isPublished, isManagedHttpsRequest, now = () => Date.now() } = {}) {
  if (!repository?.deviceReads || !Array.isArray(operations) || !operations.length) return null;
  const descriptors = operations.map(entry => entry.descriptor);
  const sessions = createDeviceReadSessionRegistry({ resolveActor, adapterDigests: descriptors.map(deviceReadAdapterDigest), now });
  const validateLiveContext = async (binding, { tenantScope, ownership }) => {
    let task, session;
    try {
      task = repository.canPublishArtifactWithLease({ tenantScope, taskId: binding.taskId, ...ownership, now: new Date(now()) });
      if (!task || task.inputDigest !== binding.taskInputDigest || task.actorSubjectDigest !== binding.actorDigest) return false;
      session = await resolveRecoverySession(task);
    } catch { return false; }
    const entry = operations.find(item => item.descriptor.toolId === binding.toolId && item.descriptor.operationId === binding.operationId &&
      deviceReadAdapterDigest(item.descriptor) === binding.adapterDigest);
    if (!entry || isPublished(entry) !== true) return false;
    return sessions.resolveTask({ task, session, adapterDigest: binding.adapterDigest })?.deviceSessionDigest === binding.deviceSessionDigest;
  };
  const dispatch = createDeviceReadDispatchService({ attempts: repository.deviceReads, descriptors, validateLiveContext, now });
  const tools = createDeviceReadRuntimeTools({ repository, sessionRegistry: sessions, dispatchService: dispatch, operations, isPublished, now });
  const transport = createDeviceReadTransport({ sessions, dispatch, isManagedHttpsRequest });
  return Object.freeze({ tools, transport,
    bindTask({ task, session, req, created }) {
      const id = req?.headers?.["x-digital-workforce-read-device"];
      return typeof id === "string" && sessions.bindTask({ deviceSessionId: id, session, task, created });
    },
    close: dispatch.close,
  });
}
