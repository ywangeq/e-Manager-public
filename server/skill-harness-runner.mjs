import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEphemeralMediaRef } from "./agent-runtime/ephemeral-media-ref.mjs";
import { verifyHarnessInstallation } from "./skill-harness-artifact-store.mjs";
import { validateHarnessManifest } from "./skill-harness-manifest.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DELIVERY_ARTIFACTS = 3;
const MAX_DELIVERY_ARTIFACT_BYTES = 128 * 1024 * 1024;
const LEGACY_GOVERNED_RUNNABLE_STATUSES = new Set(["mvp_skill_published", "试运行", "可复用"]);

// Legacy compatibility boundary. Owner: Skill migration.
// Remove after every installed harness has a published non-empty version plus manifest/entrypoint hashes.
const LEGACY_HARNESS_REMOVAL_CONDITION = "all_installed_harnesses_have_published_version_and_hash_identity";

function createSkillHarnessRunner({
  getPublishedSkills = null,
  pythonBin = process.env.DIGITAL_WORKFORCE_SKILL_PYTHON || "python3",
  skillRoots = skillRootsFromEnv(),
} = {}) {
  async function forTask(task = {}) {
    await getPublishedSkills({ task });
    return createSkillHarnessRunner({ getPublishedSkills: () => getPublishedSkills({ task }), pythonBin, skillRoots });
  }
  async function hasHarness(skillId = "") {
    return (await resolveGovernedHarness(skillId, skillRoots, getPublishedSkills)).status === "verified";
  }

  async function materialInputContracts(skillIds = []) {
    const contracts = [];
    for (const skillId of uniqueList(Array.isArray(skillIds) ? skillIds.map(cleanShortText) : [])) {
      const resolution = await resolveGovernedHarness(skillId, skillRoots, getPublishedSkills);
      if (resolution.status !== "verified") continue;
      const installed = resolution.installed;
      for (const declaration of installed.manifest.materialInputContracts || []) {
        const contract = sanitizeMaterialInputContract({ declaration, manifest: installed.manifest, skillId });
        if (contract) contracts.push(contract);
      }
    }
    return contracts;
  }

  async function completionEvidenceCapabilities(skillIds = []) {
    const capabilities = [];
    for (const skillId of uniqueList(Array.isArray(skillIds) ? skillIds.map(cleanShortText) : [])) {
      const resolution = await resolveGovernedHarness(skillId, skillRoots, getPublishedSkills);
      if (resolution.status !== "verified") continue;
      const contractId = cleanShortText(resolution.installed.manifest.safeOutputContract);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(contractId)) continue;
      capabilities.push(Object.freeze({
        contractId,
        fixedArguments: Object.freeze({ skillId }),
        prerequisiteKinds: Object.freeze(["task_workspace_material"]),
        toolName: "run_mounted_skill",
      }));
    }
    return capabilities;
  }

  async function inspectHarnessReadiness(skillIds = []) {
    const verifiedSkillIds = [];
    const blockedSkills = [];
    for (const skillId of uniqueList(Array.isArray(skillIds) ? skillIds.map(cleanShortText) : [])) {
      const resolution = await resolveGovernedHarness(skillId, skillRoots, getPublishedSkills);
      if (resolution.status === "verified") verifiedSkillIds.push(skillId);
      else blockedSkills.push({ skillId, status: resolution.status });
    }
    return {
      contractVersion: "skill-harness-readiness.v1",
      verifiedSkillIds,
      blockedSkills,
    };
  }

  async function run({ skillId = "", material = {}, explicitlyRequested = false, safeActivity = null, signal = null } = {}) {
    if (signal?.aborted) return skillResult(skillId, "skill_harness_canceled");
    if (!explicitlyRequested) return skillResult(skillId, "skill_execution_requires_explicit_request");
    if (!material.workspace || !Array.isArray(material.files)) return skillResult(skillId, "skill_material_unavailable");

    const resolution = await resolveGovernedHarness(skillId, skillRoots, getPublishedSkills);
    if (resolution.status !== "verified") return skillResult(skillId, resolution.status);
    const installed = resolution.installed;
    const { manifest, skillRoot } = installed;
    if (manifest.runtime !== "python3" || !manifest.invocation || !manifest.artifacts) {
      return skillResult(skillId, "skill_harness_contract_unsupported");
    }
    const selectedMaterial = selectDeclaredFileMaterialContract(manifest, material);
    if (!selectedMaterial) {
      return skillResult(skillId, "skill_material_contract_mismatch");
    }

    const entrypoint = path.resolve(skillRoot, manifest.entrypoint || "");
    if (!entrypoint.startsWith(`${skillRoot}${path.sep}`)) return skillResult(skillId, "skill_harness_entrypoint_rejected");
    const artifactPaths = resolveArtifactPaths(manifest.artifacts, selectedMaterial.workspace);
    if (!artifactPaths) return skillResult(skillId, "skill_harness_artifact_path_rejected");
    const deliveryArtifactDeclarations = declaredDeliveryArtifacts(manifest, artifactPaths);
    if (!deliveryArtifactDeclarations) return skillResult(skillId, "skill_harness_delivery_artifact_contract_invalid");
    const args = buildInvocationArgs({
      entrypoint,
      manifest,
      material: selectedMaterial,
      artifactPaths,
    });
    if (!args) return skillResult(skillId, "skill_material_contract_mismatch");
    await Promise.all(Object.values(artifactPaths).map((artifactPath) => rm(artifactPath, { recursive: true, force: true }).catch(() => {})));
    if (safeActivity !== null && typeof safeActivity?.start !== "function") {
      throw new TypeError("skill harness safe activity lifecycle is invalid");
    }
    await safeActivity?.start({
      actionCode: "skill.run",
      kind: "skill",
      subjectId: cleanShortText(skillId),
    });
    const execution = await runCommand(pythonBin, args, manifest.maxRuntimeMs || DEFAULT_TIMEOUT_MS, { signal });
    if (!execution.ok) return skillResult(skillId, execution.aborted ? "skill_harness_canceled" : execution.timedOut ? "skill_harness_timed_out" : "skill_harness_failed");

    try {
      const safeOutputPath = artifactPaths[manifest.safeOutputArtifact || "safeResult"];
      if (!safeOutputPath) return skillResult(skillId, "skill_harness_safe_output_missing");
      const payload = JSON.parse(await readFile(safeOutputPath, "utf8"));
      if (manifest.safeOutputContract && payload.contractVersion !== manifest.safeOutputContract) {
        return skillResult(skillId, "skill_harness_safe_output_contract_invalid");
      }
      if (manifest.safeOutputContract && !validSafeOutputPayload(payload)) {
        return skillResult(skillId, "skill_harness_safe_output_contract_invalid");
      }
      const deliveryArtifacts = await readDeclaredDeliveryArtifacts(deliveryArtifactDeclarations);
      if (!deliveryArtifacts) return skillResult(skillId, "skill_harness_delivery_artifact_missing");
      const safeResult = sanitizeSkillResult(skillId, payload);
      const privateAgentContent = await loadPrivateAgentContent({
        artifactPaths,
        declaration: manifest.ephemeralMedia,
        material: selectedMaterial,
      });
      return {
        ...safeResult,
        ...(manifest.safeOutputContract ? {
          completionEvidence: Object.freeze({
            contractId: manifest.safeOutputContract,
            status: "verified",
          }),
        } : {}),
        ...(deliveryArtifacts.length ? { deliveryArtifacts } : {}),
        details: {
          ...(safeResult.details || {}),
          runtimeHarnessEvidence: resolution.evidence,
        },
        privateAgentContent,
      };
    } catch {
      return skillResult(skillId, "skill_harness_safe_output_missing");
    }
  }

  return { forTask, completionEvidenceCapabilities, hasHarness, inspectHarnessReadiness, materialInputContracts, run };
}

function declaredDeliveryArtifacts(manifest = {}, artifactPaths = {}) {
  if (!Object.prototype.hasOwnProperty.call(manifest, "deliveryArtifacts")) return [];
  if (!Array.isArray(manifest.deliveryArtifacts) || manifest.deliveryArtifacts.length > MAX_DELIVERY_ARTIFACTS) return null;
  const seen = new Set();
  const declarations = [];
  for (const declaration of manifest.deliveryArtifacts) {
    const artifact = cleanContractId(declaration?.artifact);
    if (!artifact || seen.has(artifact)) return null;
    seen.add(artifact);
    const artifactPath = artifactPaths[artifact];
    const workspaceRelativePath = cleanRelativePath(manifest.artifacts?.[artifact]?.relativePath);
    if (!artifactPath || !workspaceRelativePath.startsWith("output/")) return null;
    const relativePath = workspaceRelativePath.slice("output/".length);
    if (!relativePath) return null;
    const configuredMaxBytes = Number(declaration?.maxBytes);
    const maxBytes = Number.isInteger(configuredMaxBytes) && configuredMaxBytes > 0
      ? Math.min(configuredMaxBytes, MAX_DELIVERY_ARTIFACT_BYTES)
      : MAX_DELIVERY_ARTIFACT_BYTES;
    declarations.push({
      artifact,
      artifactPath,
      fileName: path.basename(relativePath),
      relativePath,
      required: declaration?.required !== false,
      maxBytes,
    });
  }
  return declarations;
}

async function readDeclaredDeliveryArtifacts(declarations = []) {
  const artifacts = [];
  for (const declaration of declarations) {
    const metadata = await lstat(declaration.artifactPath).catch(() => null);
    if (!metadata) {
      if (declaration.required) return null;
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > declaration.maxBytes) return null;
    artifacts.push(Object.freeze({
      fileName: declaration.fileName,
      relativePath: declaration.relativePath,
      format: path.extname(declaration.fileName).slice(1).toLowerCase() || "file",
      sizeBytes: metadata.size,
    }));
  }
  return Object.freeze(artifacts);
}

function validSafeOutputPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.status === "string" && value.status === value.status.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.status) &&
    typeof value.summary === "string" && Boolean(value.summary.trim()) && value.summary.length <= 4_000;
}

function selectDeclaredFileMaterialContract(manifest = {}, material = {}) {
  const contracts = (Array.isArray(manifest.materialInputContracts)
    ? manifest.materialInputContracts
    : []).filter((contract) => (
      contract?.contractVersion === "skill-material-input.v1" &&
      contract.transfer === "minimal_file_only" &&
      Array.isArray(contract.selectors)
    ) || (
      contract?.contractVersion === "skill-material-input.v2" &&
      contract.transfer === "archive_snapshot" &&
      contract.archiveSnapshot?.snapshotFileName
    ));
  if (!contracts.length) return material;
  const files = Array.isArray(material.files) ? material.files : [];
  const root = path.resolve(String(material.workspace || ""));
  for (const contract of contracts) {
    if (contract.contractVersion === "skill-material-input.v2") {
      const snapshotFileName = path.basename(String(contract.archiveSnapshot.snapshotFileName || ""));
      const matches = files.filter((filePath) => {
        const resolved = path.resolve(filePath);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
        return path.basename(resolved) === snapshotFileName;
      });
      if (snapshotFileName && matches.length === 1) return { ...material, files: matches };
      continue;
    }
    if (!contract.selectors.length) continue;
    const selectedFiles = [];
    let complete = true;
    for (const selector of contract.selectors) {
      const minimum = Number(selector.minimum);
      const maximum = Number(selector.maximum);
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
        minimum < 0 || maximum < minimum) {
        complete = false;
        break;
      }
      const exactBaseNames = new Set((selector.exactBaseNames || []).map(String));
      const extensions = new Set((selector.extensions || []).map((value) => String(value).toLowerCase()));
      if (!exactBaseNames.size || !extensions.size) {
        complete = false;
        break;
      }
      const matches = files.filter((filePath) => {
        const resolved = path.resolve(filePath);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
        return exactBaseNames.has(path.basename(resolved)) &&
          extensions.has(path.extname(resolved).toLowerCase());
      });
      if (matches.length < minimum || matches.length > maximum) {
        complete = false;
        break;
      }
      selectedFiles.push(...matches);
    }
    if (complete) return { ...material, files: [...new Set(selectedFiles)] };
  }
  return null;
}

function sanitizeMaterialInputContract({ declaration = {}, manifest = {}, skillId = "" } = {}) {
  if (declaration.contractVersion === "skill-material-input.v2") {
    return sanitizeArchiveSnapshotContract({ declaration, manifest, skillId });
  }
  if (declaration.contractVersion !== "skill-material-input.v1") return null;
  const contractId = cleanContractId(declaration.contractId);
  if (!contractId || declaration.transfer !== "minimal_file_only" || !Array.isArray(declaration.selectors)) return null;
  const selectors = declaration.selectors.slice(0, 8).map((selector) => {
    const selectorId = cleanContractId(selector?.selectorId);
    const sources = uniqueList((selector?.sources || []).map(cleanContractId)).filter((source) => ["direct_file", "archive_entry"].includes(source));
    const exactBaseNames = uniqueList((selector?.exactBaseNames || []).map(cleanBaseName)).slice(0, 16);
    const extensions = uniqueList((selector?.extensions || []).map(cleanExtension)).slice(0, 16);
    const minimum = Number(selector?.minimum);
    const maximum = Number(selector?.maximum);
    if (!selectorId || !sources.length || !exactBaseNames.length || !extensions.length || minimum !== 1 || maximum !== 1 || selector?.archiveMatch !== "unique_only") return null;
    if (exactBaseNames.some((name) => !extensions.includes(path.extname(name).toLowerCase()))) return null;
    return { selectorId, sources, exactBaseNames, extensions, minimum, maximum, archiveMatch: "unique_only" };
  }).filter(Boolean);
  if (!selectors.length || selectors.length !== declaration.selectors.length) return null;
  const normalized = {
    contractVersion: "skill-material-input.v1",
    contractId,
    transfer: "minimal_file_only",
    selectors,
  };
  return {
    skillId: cleanShortText(skillId),
    skillVersion: cleanShortText(manifest.version),
    contractDigest: `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`,
    ...normalized,
  };
}

function sanitizeArchiveSnapshotContract({ declaration = {}, manifest = {}, skillId = "" } = {}) {
  const contractId = cleanContractId(declaration.contractId);
  const snapshot = declaration.archiveSnapshot;
  if (!contractId || declaration.transfer !== "archive_snapshot" || !snapshot || typeof snapshot !== "object") return null;
  const snapshotId = cleanContractId(snapshot.snapshotId);
  const sourceExtensions = uniqueList((snapshot.sourceExtensions || []).map(cleanExtension)).slice(0, 8);
  const requiredBaseNames = uniqueList((snapshot.requiredBaseNames || []).map(cleanBaseName)).slice(0, 16);
  const textExtensions = uniqueList((snapshot.textExtensions || []).map(cleanExtension)).slice(0, 16);
  const inventoryExtensions = uniqueList((snapshot.inventoryExtensions || []).map(cleanExtension)).slice(0, 32);
  const snapshotFileName = cleanBaseName(snapshot.snapshotFileName);
  const maxEntries = boundedInteger(snapshot.maxEntries, 1, 10_000);
  const maxTextEntries = boundedInteger(snapshot.maxTextEntries, 1, 2_000);
  const maxTextBytes = boundedInteger(snapshot.maxTextBytes, 1, 3 * 1024 * 1024);
  if (!snapshotId || !sourceExtensions.length || !requiredBaseNames.length || !textExtensions.length || !inventoryExtensions.length || !snapshotFileName) return null;
  if (path.extname(snapshotFileName).toLowerCase() !== ".json") return null;
  if (!requiredBaseNames.every((name) => textExtensions.includes(path.extname(name).toLowerCase()))) return null;
  if (!maxEntries || !maxTextEntries || !maxTextBytes) return null;
  const normalized = {
    contractVersion: "skill-material-input.v2",
    contractId,
    transfer: "archive_snapshot",
    archiveSnapshot: {
      snapshotId,
      sourceExtensions,
      requiredBaseNames,
      textExtensions,
      inventoryExtensions,
      snapshotFileName,
      maxEntries,
      maxTextEntries,
      maxTextBytes,
    },
  };
  return {
    skillId: cleanShortText(skillId),
    skillVersion: cleanShortText(manifest.version),
    contractDigest: `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`,
    ...normalized,
  };
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : 0;
}

function cleanContractId(value = "") {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(id) ? id : "";
}

function cleanBaseName(value = "") {
  const name = path.basename(String(value || "").trim());
  return name && name === String(value || "").trim() && name.length <= 160 ? name : "";
}

function cleanExtension(value = "") {
  const extension = String(value || "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

function resolveArtifactPaths(declarations = {}, workspace = "") {
  try {
    const root = path.resolve(workspace);
    return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => {
      const artifactPath = path.resolve(root, cleanRelativePath(declaration?.relativePath));
      if (artifactPath !== root && !artifactPath.startsWith(`${root}${path.sep}`)) throw new Error("artifact_outside_workspace");
      return [name, artifactPath];
    }));
  } catch {
    return null;
  }
}

function buildInvocationArgs({ entrypoint, manifest = {}, material = {}, artifactPaths = {} }) {
  try {
    const args = ["-B", entrypoint];
    for (const argument of manifest.invocation.arguments || []) {
      const value = invocationValue(argument, material, artifactPaths);
      if (value === undefined) throw new Error("invocation_value_missing");
      if (argument.flag) args.push(cleanCliToken(argument.flag));
      args.push(String(value));
    }
    for (const declaration of manifest.invocation.fileArguments || []) {
      const matches = selectMaterialFiles(material, declaration);
      const minimum = Number.isInteger(declaration.minimum) ? declaration.minimum : 0;
      const maximum = Number.isInteger(declaration.maximum) ? declaration.maximum : Number.POSITIVE_INFINITY;
      if (matches.length < minimum || matches.length > maximum) throw new Error("file_argument_cardinality_mismatch");
      const selected = declaration.first ? matches.slice(0, 1) : matches;
      for (const filePath of selected) {
        if (declaration.flag) args.push(cleanCliToken(declaration.flag));
        args.push(filePath);
      }
    }
    return args;
  } catch {
    return null;
  }
}

function invocationValue(argument = {}, material = {}, artifactPaths = {}) {
  if (argument.valueFrom === "workspace") return material.workspace;
  if (argument.valueFrom === "artifact") return artifactPaths[argument.artifact];
  if (Object.prototype.hasOwnProperty.call(argument, "value")) return argument.value;
  return undefined;
}

function selectMaterialFiles(material = {}, declaration = {}) {
  const root = path.resolve(material.workspace);
  const extensions = new Set((declaration.extensions || []).map((value) => String(value).toLowerCase()));
  const pattern = declaration.baseNamePattern ? new RegExp(declaration.baseNamePattern, "i") : null;
  return (material.files || []).filter((filePath) => {
    const resolved = path.resolve(filePath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
    if (extensions.size && !extensions.has(path.extname(resolved).toLowerCase())) return false;
    return !pattern || pattern.test(path.basename(resolved));
  });
}

async function loadPrivateAgentContent({ artifactPaths = {}, declaration = null, material = {} }) {
  const empty = { contractVersion: "ephemeral-media-index.v1", samples: [] };
  if (!declaration) return empty;
  try {
    const indexPath = artifactPaths[declaration.indexArtifact];
    const mediaDirectory = artifactPaths[declaration.directoryArtifact];
    if (!indexPath || !mediaDirectory) return empty;
    const payload = JSON.parse(await readFile(indexPath, "utf8"));
    const expectedContract = cleanShortText(declaration.contractVersion) || "ephemeral-media-index.v1";
    if (payload.contractVersion !== expectedContract || !Array.isArray(payload.samples)) return empty;
    let totalBytes = 0;
    const samples = [];
    const maxItems = Math.max(1, Math.min(Number(declaration.maxItems) || 24, 48));
    const maxTotalBytes = Math.max(1, Math.min(Number(declaration.maxTotalBytes) || 16_000_000, 32_000_000));
    for (const item of payload.samples.slice(0, maxItems)) {
      const fileName = path.basename(cleanShortText(item.fileName));
      const mimeType = cleanShortText(item.mimeType);
      if (!fileName || fileName !== item.fileName || !["image/jpeg", "image/png", "image/webp"].includes(mimeType)) continue;
      const mediaRef = await createEphemeralMediaRef({
        filePath: path.join(mediaDirectory, fileName),
        mimeType,
        root: material.workspace,
      });
      const resolved = await stat(path.join(mediaDirectory, fileName));
      totalBytes += resolved.size;
      if (totalBytes > maxTotalBytes) break;
      samples.push({
        mediaRef,
        mimeType,
        sampleId: cleanShortText(item.sampleId),
        pairId: cleanShortText(item.pairId),
        evidenceKind: cleanShortText(item.evidenceKind || item.kind),
        label: cleanShortText(item.rawLabel || item.label),
        mappedCategory: cleanShortText(item.mergedCategory || item.mappedCategory),
        caption: cleanShortText(item.caption) || `Skill evidence ${cleanShortText(item.sampleId) || samples.length + 1}`,
      });
    }
    return {
      contractVersion: expectedContract,
      instructions: cleanShortText(payload.instructions),
      samples,
    };
  } catch {
    return empty;
  }
}

function cleanRelativePath(value = "") {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("relative_path_rejected");
  return normalized;
}

function cleanCliToken(value = "") {
  const token = String(value || "").trim();
  if (!/^--[a-z0-9][a-z0-9-]*$/i.test(token)) throw new Error("cli_token_rejected");
  return token;
}

async function resolveInstalledHarness(skillId, skillRoots) {
  if (!skillId) return null;
  for (const root of skillRoots) {
    const approvedRoot = path.resolve(root);
    const skillRoot = path.resolve(approvedRoot, skillId);
    if (!skillRoot.startsWith(`${approvedRoot}${path.sep}`)) continue;
    const manifestPath = path.join(skillRoot, "runtime-harness.json");
    try {
      const manifestContent = await readFile(manifestPath);
      const manifest = JSON.parse(manifestContent.toString("utf8"));
      if (manifest.contractVersion !== "skill-harness.v1" || manifest.skillId !== skillId) continue;
      const entrypointPath = path.resolve(skillRoot, manifest.entrypoint || "");
      if (!entrypointPath.startsWith(`${skillRoot}${path.sep}`)) continue;
      const entrypointContent = await readFile(entrypointPath);
      return {
        manifest,
        skillRoot,
        manifestSha256: hashContent(manifestContent),
        entrypointSha256: hashContent(entrypointContent),
      };
    } catch {
      // Try the next approved installation root.
    }
  }
  return null;
}

async function resolveGovernedHarness(skillId, skillRoots, getPublishedSkills) {
  if (typeof getPublishedSkills !== "function") return { status: "skill_harness_publication_unavailable" };
  try {
    const skills = await getPublishedSkills();
    const published = Array.isArray(skills) ? skills.find((skill) => skill?.id === skillId) : null;
    const identity = published?.runtimeHarnessIdentity;
    const version = cleanShortText(published?.version);
    let installed;
    try {
      installed = published?.runtimeHarnessArtifact
        ? verifyHarnessInstallation({ artifact: published.runtimeHarnessArtifact, identity })
        : await resolveInstalledHarness(skillId, skillRoots);
      if (published?.runtimeHarnessArtifact && installed) validateHarnessManifest(installed.manifest);
    } catch { return { status: "skill_harness_installation_corrupt" }; }
    if (!installed) return { status: "skill_harness_not_installed" };
    if (
      !published ||
      published.runtimeEligibility?.allowed !== true ||
      !LEGACY_GOVERNED_RUNNABLE_STATUSES.has(published.status)
    ) {
      return { status: "skill_harness_publication_unavailable" };
    }
    if (identity === null || identity === undefined) {
      if (!version) return { status: "skill_harness_publication_unavailable" };
      return {
        status: "verified",
        installed,
        evidence: {
          contractVersion: "skill-harness-verification.v1",
          mode: "legacy_catalog_compatibility",
          status: "published_identity_registration_required",
          catalogVersion: version,
          observedManifestSha256: installed.manifestSha256,
          observedEntrypointSha256: installed.entrypointSha256,
          migrationOwner: "Skill migration",
          removalCondition: LEGACY_HARNESS_REMOVAL_CONDITION,
        },
      };
    }
    if (
      identity.contractVersion !== "skill-harness.v1" ||
      identity.skillId !== skillId ||
      !version ||
      !cleanShortText(identity.version) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.manifestSha256 || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.entrypointSha256 || "")
    ) {
      return { status: "skill_harness_publication_unavailable" };
    }
    if (
      cleanShortText(identity.version) !== version ||
      cleanShortText(installed.manifest.version) !== version ||
      cleanShortText(installed.manifest.entrypoint) !== cleanShortText(identity.entrypoint) ||
      installed.manifestSha256 !== identity.manifestSha256 ||
      installed.entrypointSha256 !== identity.entrypointSha256
    ) {
      return { status: "skill_harness_identity_mismatch" };
    }
    return {
      status: "verified",
      installed,
      evidence: {
        contractVersion: "skill-harness-verification.v1",
        mode: "published_identity_verified",
        status: "verified",
        catalogVersion: version,
        manifestSha256: installed.manifestSha256,
        entrypointSha256: installed.entrypointSha256,
        ...(published.runtimeHarnessArtifact ? { artifactDigest: published.runtimeHarnessArtifact.digest } : {}),
      },
    };
  } catch {
    return { status: "skill_harness_publication_unavailable" };
  }
}

function hashContent(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sanitizeSkillResult(skillId, payload = {}) {
  const details = sanitizeSafeValue(Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !["status", "summary", "nextGate"].includes(key))));
  return {
    skillId,
    status: cleanShortText(payload.status) || "skill_harness_completed",
    summary: cleanShortText(payload.summary) || "Skill harness 已完成。",
    details,
    nextGate: cleanShortText(payload.nextGate),
  };
}

function sanitizeSafeValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.replace(/[\0\r\n\t]+/g, " ").trim().slice(0, 1_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeSafeValue(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 1_000);
  return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([key]) => !/(?:path|content|base64|prompt|trace|secret|token|credential|private|raw)/i.test(key))
    .map(([key, item]) => [cleanShortText(key), sanitizeSafeValue(item, depth + 1)]));
}

function skillResult(skillId, status) {
  return {
    skillId: cleanShortText(skillId),
    status,
    summary: "Skill harness 未执行或未完成。",
    nextGate: "确认该 Skill 已完整安装、已显式请求，并满足其输入契约与运行门禁。",
  };
}

function skillRootsFromEnv() {
  const envRoots = String(process.env.DIGITAL_WORKFORCE_SKILL_ROOTS || "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const codexHome = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : "";
  return uniqueList([
    ...envRoots,
    codexHome,
    path.join(os.homedir(), ".codex", "skills"),
  ]);
}

function uniqueList(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function runCommand(command, args, timeoutMs, { signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, timedOut: false, aborted: true });
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    let aborted = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", abort);
      resolve(result);
    };
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, timedOut: true, aborted: false });
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    signal?.addEventListener?.("abort", abort, { once: true });
    child.on("error", () => finish({ ok: false, timedOut: false, aborted: false }));
    child.on("close", (code) => finish({ ok: code === 0 && !aborted, timedOut: false, aborted }));
  });
}

function cleanShortText(value = "") {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 240);
}

export { createSkillHarnessRunner };
