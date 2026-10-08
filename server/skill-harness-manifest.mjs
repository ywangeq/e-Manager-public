export function validateHarnessManifest(manifest) {
  const token = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  const relative = (v) => typeof v === "string" && v.length > 0 && !v.startsWith("/") && !/[\\\x00-\x1f]/.test(v) && v.split("/").every((p) => p && p !== "." && p !== "..");
  const reject = () => { throw new Error("skill_harness_manifest_invalid"); };
  if (manifest?.contractVersion !== "skill-harness.v1" || !token(manifest.skillId) || !token(manifest.version) ||
    manifest.runtime !== "python3" || !relative(manifest.entrypoint) || !token(manifest.safeOutputContract) ||
    !manifest.invocation || !manifest.artifacts || Array.isArray(manifest.artifacts)) reject();
  const artifacts = Object.entries(manifest.artifacts);
  if (!artifacts.length || artifacts.some(([name, value]) => !token(name) || !relative(value?.relativePath))) reject();
  if (!Object.hasOwn(manifest.artifacts, manifest.safeOutputArtifact || "safeResult")) reject();
  if (manifest.maxRuntimeMs !== undefined && (!Number.isSafeInteger(manifest.maxRuntimeMs) || manifest.maxRuntimeMs <= 0)) reject();
  for (const field of ["arguments", "fileArguments"]) if (manifest.invocation[field] !== undefined && !Array.isArray(manifest.invocation[field])) reject();
  for (const argument of manifest.invocation.arguments || []) {
    if (argument.flag && !/^--[a-z0-9][a-z0-9-]*$/i.test(argument.flag)) reject();
    if (argument.valueFrom === "artifact") { if (!Object.hasOwn(manifest.artifacts, argument.artifact)) reject(); }
    else if (argument.valueFrom !== "workspace" && !(Object.hasOwn(argument, "value") && ["string", "number", "boolean"].includes(typeof argument.value))) reject();
  }
  for (const argument of manifest.invocation.fileArguments || []) {
    if (argument.flag && !/^--[a-z0-9][a-z0-9-]*$/i.test(argument.flag)) reject();
    if (argument.baseNamePattern) { try { new RegExp(argument.baseNamePattern); } catch { reject(); } }
  }
  for (const artifact of manifest.deliveryArtifacts || []) if (!Object.hasOwn(manifest.artifacts, artifact.artifact)) reject();
  return manifest;
}
