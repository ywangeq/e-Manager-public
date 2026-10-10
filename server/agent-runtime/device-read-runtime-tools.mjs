import { createDeviceReadToolExecutor } from "./device-read-tool-executor.mjs";
import { deviceReadAdapterDigest } from "../../desktop-channel-mvp/shared/device-read-operation-v1.mjs";
import { deviceReadLeaseFenceDigest } from "./device-read-attempt-repository.mjs";

// Shared Runtime composition, independent of employee/vendor/Channel. Hosts
// inject published operations and existing task/session/Tool authorities.
export function createDeviceReadRuntimeTools({ repository, sessionRegistry, dispatchService, operations = [], isPublished, now = () => Date.now() } = {}) {
  if (typeof repository?.canPublishArtifactWithLease !== "function" || typeof sessionRegistry?.resolveTask !== "function" ||
    typeof dispatchService?.dispatchRead !== "function" || typeof isPublished !== "function")
    throw new TypeError("device_read_runtime_authority_required");
  const registrations = operations.map(entry => Object.freeze({ ...entry, adapterDigest: deviceReadAdapterDigest(entry.descriptor) }));
  return Object.freeze({
    createForTask({ employee, session, task, ownership, authorizeToolCall } = {}) {
      const lease = Object.freeze({ ...(ownership?.lease || ownership) });
      const readLiveTask = () => repository.canPublishArtifactWithLease({ tenantScope: task?.tenantScope, taskId: task?.taskId,
        leaseId: lease.leaseId, workerIdDigest: lease.workerIdDigest, fencingToken: lease.fencingToken, now: new Date(now()) });
      let canonical;
      try { canonical = readLiveTask(); } catch { canonical = null; }
      if (!canonical || !session || typeof authorizeToolCall !== "function") return createDeviceReadToolExecutor({ employee, operations: registrations.filter(entry => isPublished(entry) === true) });
      repository.deviceReads?.reconcileForTask({ tenantScope: canonical.tenantScope, taskId: canonical.taskId, ownership: lease, now: new Date(now()) });
      const available = registrations.filter(entry => isPublished(entry) === true && sessionRegistry.resolveTask({ session, task: canonical, adapterDigest: entry.adapterDigest }));
      if (!available.length) return createDeviceReadToolExecutor({ employee, operations: registrations.filter(entry => isPublished(entry) === true) });
      const device = sessionRegistry.resolveTask({ session, task: canonical, adapterDigest: available[0].adapterDigest });
      const context = Object.freeze({ taskId: canonical.taskId, taskInputDigest: canonical.inputDigest, actorDigest: canonical.actorSubjectDigest,
        deviceSessionDigest: device.deviceSessionDigest, leaseFenceDigest: deviceReadLeaseFenceDigest({ ...lease, taskId: canonical.taskId, tenantScope: canonical.tenantScope }) });
      const validateLiveContext = async binding => {
        const entry = available.find(item => item.descriptor.toolId === binding.toolId && item.descriptor.operationId === binding.operationId && item.adapterDigest === binding.adapterDigest);
        if (!entry || isPublished(entry) !== true) return false;
        let current;
        try { current = readLiveTask(); } catch { return false; }
        if (!current || current.taskId !== binding.taskId || current.inputDigest !== binding.taskInputDigest || current.actorSubjectDigest !== binding.actorDigest ||
          binding.leaseFenceDigest !== context.leaseFenceDigest) return false;
        const presence = sessionRegistry.resolveTask({ session, task: current, adapterDigest: entry.adapterDigest });
        return presence?.deviceSessionDigest === binding.deviceSessionDigest;
      };
      const described = available.map(entry => ({ ...entry, operation: { ...entry.operation,
        summary: `${entry.operation.summary || entry.name} 当前时间（UTC）：${new Date(now()).toISOString()}；设备时区：${device.timeZone || "未提供，请确认后查询"}。` } }));
      return createDeviceReadToolExecutor({ employee, operations: described, context, authorizeToolCall, validateLiveContext,
        dispatchRead: (request, options) => dispatchService.dispatchRead({ ...request, tenantScope: canonical.tenantScope, ownership: lease }, options) });
    },
  });
}
