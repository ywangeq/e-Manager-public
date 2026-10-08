import { createHash } from "node:crypto";

function hasCompleteVerifiedSkillRuntimeDocuments({ sourceSkill = {}, runtimeSkill = {}, skillPolicyRef = "" } = {}) {
  const expectedVersion = policyVersion(skillPolicyRef);
  if (expectedVersion && (sourceSkill?.version !== expectedVersion || runtimeSkill?.version !== expectedVersion)) {
    return false;
  }
  const sourceInstructions = sourceSkill?.runtimeInstructions;
  const runtimeInstructions = runtimeSkill?.runtimeInstructions;
  if (!sameCompleteDocument(sourceInstructions, runtimeInstructions, "skill-runtime-instructions.v1")) {
    return false;
  }

  const sourceReferences = Array.isArray(sourceSkill?.runtimeReferences)
    ? sourceSkill.runtimeReferences
    : [];
  const runtimeReferences = Array.isArray(runtimeSkill?.runtimeReferences)
    ? runtimeSkill.runtimeReferences
    : [];
  const manifest = Array.isArray(sourceSkill?.referenceManifest) ? sourceSkill.referenceManifest : [];
  if (sourceReferences.length !== runtimeReferences.length ||
    manifest.length !== runtimeReferences.length ||
    new Set(runtimeReferences.map((reference) => reference?.path)).size !== runtimeReferences.length) {
    return false;
  }
  const runtimeByPath = new Map(runtimeReferences.map((reference) => [reference?.path, reference]));
  const sourceByPath = new Map(sourceReferences.map((reference) => [reference?.path, reference]));
  return manifest.every((entry) => {
    const path = String(entry?.path || "");
    const source = sourceByPath.get(path);
    const runtime = runtimeByPath.get(path);
    return sameCompleteDocument(source, runtime, "skill-runtime-reference.v1") &&
      validHash(entry?.sha256) && entry.sha256 === source.sourceHash;
  });
}

function sameCompleteDocument(source, runtime, contractVersion) {
  return source?.contractVersion === contractVersion && runtime?.contractVersion === contractVersion &&
    source?.truncated === false && runtime?.truncated === false &&
    typeof source?.content === "string" && source.content.length > 0 &&
    source.content === runtime.content && validHash(source.contentHash) &&
    source.contentHash === hash(source.content) && source.contentHash === runtime.contentHash &&
    validHash(source.sourceHash) && source.sourceHash === runtime.sourceHash;
}

function validHash(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ""));
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function policyVersion(value = "") {
  const policy = String(value || "").trim();
  const separator = policy.lastIndexOf("@");
  return separator > 0 ? policy.slice(separator + 1) : "";
}

export { hasCompleteVerifiedSkillRuntimeDocuments };
