import { groupContractError } from "./group-contracts-v1.mjs";
import { normalizeMaterialBindingDescriptors } from "./task-material-binding.mjs";

// Group carries only an opaque input reference. The Center-owned resolver is
// the sole place that may turn that reference into an existing material
// binding descriptor (for example, desktop-material-intake.v1). A missing
// resolver or incomplete mapping fails closed before child task submission.
export function createGroupMaterialBindingResolver({ resolveReference } = {}) {
  if (resolveReference != null && typeof resolveReference !== "function") {
    throw new TypeError("group material resolver requires resolveReference");
  }
  return Object.freeze({
    async resolveStep({ actor, session = null, run, plan, step } = {}) {
      const refIds = Array.isArray(step?.inputRefIds) ? step.inputRefIds : [];
      if (!refIds.length) return [];
      if (typeof resolveReference !== "function") throw groupContractError("group_material_binding_resolver_unavailable");
      const refs = new Map((plan?.inputRefs || []).map((ref) => [ref.refId, ref]));
      const descriptors = [];
      for (const refId of refIds) {
        const reference = refs.get(refId);
        if (!reference) throw groupContractError("group_input_reference_scope_invalid");
        const resolved = await resolveReference({ actor, session, run, plan, step, reference });
        if (!resolved || resolved.refId !== reference.refId || resolved.version !== reference.version || resolved.scope !== reference.scope || !resolved.descriptor) {
          throw groupContractError("group_material_binding_resolution_failed");
        }
        descriptors.push(resolved.descriptor);
      }
      try {
        return normalizeMaterialBindingDescriptors(descriptors);
      } catch {
        throw groupContractError("group_material_binding_resolution_failed");
      }
    },
  });
}
