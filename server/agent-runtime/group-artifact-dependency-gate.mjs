import { assertGroupScope, groupContractError, groupId } from "./group-contracts-v1.mjs";

// Adapts the existing reusable Artifact grant authority to Group dependency checks.
// It never creates, copies, or extends grants; callers inject it as verifyDependency.
export function createGroupArtifactDependencyGate({ readGrant, now = () => new Date() } = {}) {
  if (typeof readGrant !== "function") throw new TypeError("group_artifact_gate_reader_required");
  return Object.freeze({
    async verify({ actor, step } = {}) {
      assertGroupScope(actor, actor);
      const grantIds = Array.isArray(step?.inputArtifactIds) ? step.inputArtifactIds.map(groupId) : [];
      if (grantIds.length === 0) return true;
      for (const grantId of grantIds) {
        const record = readGrant({ ...actor, grantId, now: now() });
        if (!record?.grant || !record.artifact) throw groupContractError("group_artifact_unavailable");
        assertGroupScope(record.grant, actor);
      }
      return true;
    },
  });
}
