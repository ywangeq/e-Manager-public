const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/;
export const EXECUTION_INPUT_BUNDLE_CONTRACT = "execution-input-bundle.v1";
export function normalizeExecutionInputBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.contractVersion !== EXECUTION_INPUT_BUNDLE_CONTRACT) throw new Error("execution_input_bundle_invalid");
  const instructionRef = value.instructionRef;
  if (!instructionRef || instructionRef.kind !== "transcript_entry" || !ID.test(String(instructionRef.refId || ""))) throw new Error("execution_input_bundle_instruction_invalid");
  const artifactRefs = Array.isArray(value.artifactRefs) ? value.artifactRefs : [];
  if (artifactRefs.length > 64 || artifactRefs.some(ref => !ref || ref.kind !== "artifact_ref" || !ID.test(String(ref.refId || "")))) throw new Error("execution_input_bundle_artifacts_invalid");
  return Object.freeze({ contractVersion: EXECUTION_INPUT_BUNDLE_CONTRACT, instructionRef: Object.freeze({ kind: "transcript_entry", refId: instructionRef.refId }), artifactRefs: Object.freeze(artifactRefs.map(ref => Object.freeze({ kind: "artifact_ref", refId: ref.refId }))) });
}
