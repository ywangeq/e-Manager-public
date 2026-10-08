import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { readHarnessPackageFiles, saveHarnessArtifact } from "./skill-harness-artifact-store.mjs";
import {
  createSkillRuntimeExecutionProfile,
} from "./agent-runtime/skill-runtime-profile.mjs";

export const acceptedPackageExtensions = [".zip", ".tar", ".gz", ".tgz"];
export const maxInlinePackageBytes = 10 * 1024 * 1024;

const maxSkillFileBytes = 64 * 1024;
const maxReferenceFileBytes = 64 * 1024;
const maxSkillPackageManifestBytes = 16 * 1024;
const maxRuntimeHarnessManifestBytes = 32 * 1024;
const maxRuntimeHarnessEntrypointBytes = 256 * 1024;
const maxSkillUnitsPerPackage = 50;
const maxRuntimeInstructionChars = maxSkillFileBytes;
const maxRuntimeInstructionSections = 16;
const maxRuntimeReferenceChars = 32 * 1024;
const maxRuntimeReferenceSections = 16;

export function analyzePackageInput(input = {}, sourceRef = "") {
  const sourceType = cleanText(input.sourceType || "");
  const source = cleanSourceRef(sourceRef);
  const packageFile = input.packageFile || input.packageContent || null;
  const isPackageRef =
    Boolean(packageFile) ||
    sourceType === "openai_package" ||
    /^openai-skill-package:\/\//i.test(source) ||
    /^external-agent-package:\/\//i.test(source);
  const result = {
    isPackageRef,
    received: false,
    unpacked: false,
    manifestParsed: false,
    skillUnits: [],
    packageEntries: [],
    warnings: [],
    summary: {
      mode: isPackageRef ? "package_reference_only" : "source_ref_only",
      contentReceived: false,
      unpacked: false,
      manifestParsed: false,
      skillUnitCount: 0,
    },
  };
  if (!isPackageRef || !packageFile) return result;

  const fileName = cleanText(packageFile.fileName || packageFile.name || source.replace(/^openai-skill-package:\/\//i, ""));
  const base64 = String(packageFile.base64 || packageFile.contentBase64 || "").replace(/^data:[^,]+,/, "");
  const extension = packageExtension(fileName || source);
  if (!base64) {
    result.warnings.push("包文件只登记了名称，未接收二进制内容；Agent 无法读取 SKILL.md，只能阻断补材料。");
    return result;
  }
  if (!acceptedPackageExtensions.includes(extension)) {
    result.warnings.push(`不支持的包类型：${extension || "unknown"}。`);
    return result;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    result.warnings.push("包内容不是有效 base64，无法安全解析。");
    return result;
  }
  result.received = true;
  result.summary.contentReceived = true;
  result.summary.fileName = fileName;
  result.summary.packageBytes = buffer.length;
  if (!buffer.length || buffer.length > maxInlinePackageBytes) {
    result.warnings.push(`包内容大小必须在 1 到 10 MiB 之间；当前 ${buffer.length} bytes。`);
    return result;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "dw-skill-package-"));
  const archivePath = join(tempDir, `package${extension}`);
  try {
    writeFileSync(archivePath, buffer);
    const packageFiles = readHarnessPackageFiles(archivePath);
    const entries = listPackageEntries(archivePath, extension);
    result.packageEntries = entries.slice(0, 80);
    result.unpacked = true;
    result.summary.unpacked = true;
    const allSkillPaths = entries.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry) && isSafeArchiveEntry(entry));
    const skillPaths = allSkillPaths.slice(0, maxSkillUnitsPerPackage);
    if (!skillPaths.length) {
      result.warnings.push("包内没有找到 SKILL.md，无法生成可评审 Skill 稿。");
      return result;
    }
    if (allSkillPaths.length > maxSkillUnitsPerPackage) {
      result.warnings.push(`包内 SKILL.md 数量 ${allSkillPaths.length} 超过当前 MVP 上限 ${maxSkillUnitsPerPackage}；只读取前 ${maxSkillUnitsPerPackage} 个。`);
    }
    result.skillUnits = skillPaths.map((skillPath) => {
      const content = readArchiveText(archivePath, extension, skillPath, maxSkillFileBytes);
      const skillRoot = cleanArchiveEntry(skillPath).replace(/(^|\/)SKILL\.md$/i, "");
      const skillPackageManifestPath = cleanArchiveEntry(`${skillRoot}/skill-package.json`);
      const skillPackageManifest = entries.includes(skillPackageManifestPath)
        ? parseSkillPackageManifest(readArchiveText(archivePath, extension, skillPackageManifestPath, maxSkillPackageManifestBytes))
        : null;
      const unit = skillUnitFromSkillMarkdown({
        content,
        packageEntries: entries,
        skillPath,
        sourceRef: source,
        skillPackageManifest,
        skillPackageManifestPath: skillPackageManifest ? skillPackageManifestPath : "",
      });
      const runtimeHarnessIdentity = readRuntimeHarnessIdentity({
        archivePath,
        extension,
        entries,
        skillRoot,
        skillApiId: unit.skillApiId,
      });
      const runtimeExecutionProfile = packageRuntimeExecutionProfile({ unit, runtimeHarnessIdentity });
      const runtimeHarnessArtifact = runtimeHarnessIdentity?.version
        ? saveHarnessArtifact({ files: packageFiles, skillRoot, identity: runtimeHarnessIdentity }) : null;
      const referenceResources = unit.references.map((referencePath) => {
        const referenceContent = readArchiveText(archivePath, extension, referencePath, maxReferenceFileBytes);
        return {
          manifest: {
            path: referencePath,
            bytes: Math.min(Buffer.byteLength(referenceContent), maxReferenceFileBytes),
            sha256: hashText(referenceContent),
          },
          runtimeReference: runtimeReferenceFromSkillReference({
            path: referencePath,
            content: referenceContent,
          }),
        };
      });
      const referenceManifest = referenceResources.map((resource) => resource.manifest);
      const runtimeReferences = referenceResources
        .map((resource) => resource.runtimeReference)
        .filter(Boolean);
      return {
        ...unit,
        runtimeHarnessIdentity,
        runtimeHarnessArtifact,
        runtimeExecutionProfile,
        referenceManifest,
        runtimeReferences,
        readSummary: {
          ...unit.readSummary,
          runtimeReferenceCount: runtimeReferences.length,
          runtimeReferenceBytes: runtimeReferences.reduce((sum, reference) => (
            sum + Buffer.byteLength(reference.content || "", "utf8")
          ), 0),
          runtimeReferenceTruncated: runtimeReferences.some((reference) => reference.truncated),
        },
        contractDigest: hashText(JSON.stringify({
          skill: unit.skillContentHash,
          identity: unit.skillPackageIdentity,
          runtimeHarness: runtimeHarnessIdentity,
          runtimeExecutionProfile,
          runtimeInstructions: unit.runtimeInstructions?.contentHash || "",
          runtimeReferences: runtimeReferences.map((reference) => ({
            path: reference.path,
            contentHash: reference.contentHash,
          })),
          references: referenceManifest,
        })),
      };
    });
    result.manifestParsed = result.skillUnits.length > 0;
    result.summary.manifestParsed = result.manifestParsed;
    result.summary.skillUnitCount = result.skillUnits.length;
    result.summary.skillPaths = skillPaths;
    result.skillUnits = result.skillUnits.map((unit) => ({
      ...unit,
      packageAnalysis: result,
    }));
    return result;
  } catch (error) {
    result.warnings.push(`包解析失败：${cleanText(error?.message || "unknown_error")}`);
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readRuntimeHarnessIdentity({ archivePath, extension, entries, skillRoot, skillApiId }) {
  const manifestPath = cleanArchiveEntry(`${skillRoot}/runtime-harness.json`);
  if (!entries.includes(manifestPath)) return null;
  const manifestContent = readArchiveText(
    archivePath,
    extension,
    manifestPath,
    maxRuntimeHarnessManifestBytes,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new Error("runtime_harness_manifest_invalid_json");
  }
  const entrypoint = cleanArchiveEntry(manifest?.entrypoint || "");
  if (
    manifest?.contractVersion !== "skill-harness.v1" ||
    cleanText(manifest.skillId) !== cleanText(skillApiId) ||
    !entrypoint ||
    !isSafeArchiveEntry(entrypoint)
  ) {
    throw new Error("runtime_harness_manifest_invalid");
  }
  const entrypointPath = cleanArchiveEntry(`${skillRoot}/${entrypoint}`);
  if (!entries.includes(entrypointPath) || !isSafeArchiveEntry(entrypointPath)) {
    throw new Error("runtime_harness_entrypoint_missing");
  }
  const entrypointContent = readArchiveText(
    archivePath,
    extension,
    entrypointPath,
    maxRuntimeHarnessEntrypointBytes,
  );
  return {
    contractVersion: manifest.contractVersion,
    skillId: cleanText(manifest.skillId),
    version: cleanText(manifest.version || ""),
    runtime: cleanText(manifest.runtime || ""),
    entrypoint,
    manifestPath,
    manifestSha256: hashText(manifestContent),
    entrypointPath,
    entrypointSha256: hashText(entrypointContent),
    safeOutputContract: cleanText(manifest.safeOutputContract || ""),
    requiresExplicitRequest: manifest.requiresExplicitRequest === true,
    network: cleanText(manifest.network || ""),
    writeback: cleanText(manifest.writeback || ""),
  };
}

export function packageIntakeBoundary(input = {}, sourceRef = "", packageAnalysis = null) {
  const sourceType = cleanText(input.sourceType || "");
  const source = cleanSourceRef(sourceRef);
  const packageFile = input.packageFile || input.packageContent || null;
  const isPackageRef =
    Boolean(packageFile) ||
    sourceType === "openai_package" ||
    /^openai-skill-package:\/\//i.test(source) ||
    /^external-agent-package:\/\//i.test(source);
  const received = Boolean(packageAnalysis?.received);
  const unpacked = Boolean(packageAnalysis?.unpacked);
  const manifestParsed = Boolean(packageAnalysis?.manifestParsed);
  return {
    mode: received ? "inline_package_safe_summary" : isPackageRef ? "package_reference_only" : "source_ref_only",
    acceptedExtensions: acceptedPackageExtensions,
    maxInlinePackageBytes,
    contentReceived: received,
    unpacked,
    manifestParsed,
    skillUnitCount: packageAnalysis?.summary?.skillUnitCount || 0,
    packageEntries: packageAnalysis?.packageEntries || [],
    note: isPackageRef
      ? received
        ? "当前 MVP 只读取包内安全摘要并立即丢弃临时文件；不保存原始包、raw prompt、私有 payload 或执行记录。"
        : "当前 MVP 未收到包内容时只登记包文件名/sourceRef；Agent 会阻断补充材料，不能假装已解析 SKILL.md。"
      : "当前 MVP 只登记 sourceRef 和安全摘要；repo/包内容解析需由受控后端任务执行。",
    requiredForAutoUnpack: [
      "multipart or object-store upload",
      "server-side size/type limits",
      "path traversal safe extraction",
      "secret/private payload scanning",
      "SKILL.md directory traversal",
      "manifest/sourceSkillId verification",
    ],
  };
}

function listPackageEntries(archivePath, extension) {
  const args = extension === ".zip"
    ? ["-Z1", archivePath]
    : ["-tf", archivePath];
  const command = extension === ".zip" ? "unzip" : "tar";
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 })
    .split(/\r?\n/)
    .map((entry) => cleanArchiveEntry(entry))
    .filter(Boolean)
    .filter(isSafeArchiveEntry);
}

function readArchiveText(archivePath, extension, entryPath, maxBytes) {
  const command = extension === ".zip" ? "unzip" : "tar";
  const args = extension === ".zip"
    ? ["-p", archivePath, entryPath]
    : ["-xOf", archivePath, entryPath];
  const output = execFileSync(command, args, { encoding: "utf8", maxBuffer: maxBytes });
  return output.slice(0, maxBytes);
}

function skillUnitFromSkillMarkdown({
  content,
  packageEntries,
  skillPath,
  sourceRef,
  skillPackageManifest = null,
  skillPackageManifestPath = "",
}) {
  const frontmatter = parseFrontmatter(content);
  const folderName = skillPath.split("/").filter(Boolean).slice(-2, -1)[0] || skillPath.replace(/\/?SKILL\.md$/i, "");
  const skillId = cleanEntityId(frontmatter.skillId || frontmatter.skill_id || frontmatter.id || folderName || sourceRef);
  const skillApiId = cleanText(
    frontmatter.skillApiId || frontmatter.skill_api_id || skillPackageManifest?.skillApiId || skillId,
  );
  const sourceSkillId = cleanText(
    frontmatter.sourceSkillId || frontmatter.source_skill_id || frontmatter.id || skillPackageManifest?.sourceSkillId || skillId,
  );
  const name = displayNameForSkillUnit({
    frontmatter,
    heading: headingFromMarkdown(content),
    folderName,
    sourceSkillId,
  });
  const description = cleanText(frontmatter.description || paragraphAfterHeading(content) || `${name} Skill package unit`);
  const inputs = sectionList(content, ["inputs", "input", "输入", "入参"]);
  const outputs = sectionList(content, ["outputs", "output", "输出", "出参"]);
  const tools = uniqueCleanList([
    ...sectionList(content, ["tools", "tool", "工具", "能力工具"]),
    ...sectionList(content, ["dependencies", "依赖"]),
  ]);
  const constraints = uniqueCleanList([
    ...sectionList(content, ["constraints", "guardrails", "rules", "约束", "边界", "规则"]),
  ]);
  const executionGuidance = uniqueCleanList([
    ...sectionList(content, ["workflow", "execution flow", "execution workflow", "operating procedure", "how to use", "工作流", "执行流程", "api 执行流程", "任务分流", "使用方式"]),
    ...sectionList(content, ["api capabilities", "api behavior", "通用 api 能力", "通用 API 能力"]),
  ]);
  const runtimeInstructions = runtimeInstructionsFromSkillMarkdown(content);
  const contentHash = hashSkillMarkdown(content);
  const promptMetadataAutoCompleted = !frontmatter.promptVersion && !frontmatter.promptHash;
  const promptHash = cleanText(frontmatter.promptHash || contentHash);
  const promptVersion = cleanText(frontmatter.promptVersion || `skill-md-${contentHash.replace(/^sha256:/, "").slice(0, 12)}`);
  const references = linkedPackageReferences({ content, packageEntries, skillPath });
  return {
    skillId,
    skillApiId,
    sourceSkillId,
    skillPackageIdentity: skillPackageManifest
      ? {
          contractVersion: skillPackageManifest.contractVersion,
          skillApiId: skillPackageManifest.skillApiId,
          sourceSkillId: skillPackageManifest.sourceSkillId,
          version: skillPackageManifest.version,
          ...(skillPackageManifest.executionMode ? { executionMode: skillPackageManifest.executionMode } : {}),
          path: skillPackageManifestPath,
        }
      : null,
    name,
    skillPath,
    manifestSummary: description,
    declaredInputs: inputs,
    declaredOutputs: outputs,
    tools,
    constraints,
    executionGuidance,
    runtimeInstructions,
    references,
    skillContentHash: contentHash,
    promptVersion,
    promptHash,
    promptMetadataAutoCompleted,
    promptMetadataSource: promptMetadataAutoCompleted ? "skill_markdown_sha256" : "skill_markdown_frontmatter",
    risk: /write|delete|approve|publish|写入|删除|审批|发布/i.test(content) ? "高" : "中",
    readSummary: {
      source: "package_skill_markdown",
      contentReadBytes: Math.min(Buffer.byteLength(content), maxSkillFileBytes),
      referenceCount: references.length,
      runtimeInstructionBytes: Buffer.byteLength(runtimeInstructions.content || "", "utf8"),
      runtimeInstructionTruncated: runtimeInstructions.truncated,
      runtimeReferenceCount: 0,
      rawContentStored: false,
    },
    packageAnalysis: null,
  };
}

function parseSkillPackageManifest(content = "") {
  let manifest;
  try {
    manifest = JSON.parse(String(content || ""));
  } catch {
    throw new Error("skill_package_manifest_invalid_json");
  }
  if (
    manifest?.contractVersion !== "digital-workforce-skill-package.v1" ||
    !isStableEntityId(manifest.skillApiId) ||
    !isStableEntityId(manifest.sourceSkillId)
  ) {
    throw new Error("skill_package_manifest_invalid");
  }
  const executionMode = cleanText(manifest.executionMode || "");
  if (executionMode) createSkillRuntimeExecutionProfile(executionMode);
  return {
    contractVersion: manifest.contractVersion,
    skillApiId: cleanText(manifest.skillApiId),
    sourceSkillId: cleanText(manifest.sourceSkillId),
    version: cleanText(manifest.version || ""),
    executionMode,
    toolCompletionPolicies: Array.isArray(manifest.toolCompletionPolicies)
      ? structuredClone(manifest.toolCompletionPolicies)
      : [],
  };
}

function packageRuntimeExecutionProfile({ unit = {}, runtimeHarnessIdentity = null } = {}) {
  const declaredMode = cleanText(unit.skillPackageIdentity?.executionMode || "");
  if (declaredMode) {
    const profile = createSkillRuntimeExecutionProfile(declaredMode);
    const declaresHarness = profile.mode === "deterministic_harness";
    if (declaresHarness !== Boolean(runtimeHarnessIdentity)) {
      throw new Error("runtime_execution_profile_harness_mismatch");
    }
    return profile;
  }
  if (runtimeHarnessIdentity) {
    throw new Error("runtime_execution_profile_required_for_harness");
  }
  return createSkillRuntimeExecutionProfile("guidance");
}

function isStableEntityId(value = "") {
  return /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(String(value || "").trim());
}

function linkedPackageReferences({ content = "", packageEntries = [], skillPath = "" } = {}) {
  const skillRoot = cleanArchiveEntry(skillPath).replace(/(^|\/)SKILL\.md$/i, "");
  const entries = new Set(packageEntries.map(cleanArchiveEntry));
  const targets = [...String(content).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, "").split(/[?#]/, 1)[0])
    .filter((target) => /^references\/[^/].*\.md$/i.test(target) && isSafeArchiveEntry(target))
    .map((target) => cleanArchiveEntry(`${skillRoot}/${target}`))
    .filter((target) => entries.has(target));
  return uniqueCleanList(targets);
}

function hashSkillMarkdown(content = "") {
  return hashText(content);
}

function hashText(content = "") {
  return `sha256:${createHash("sha256").update(String(content || ""), "utf8").digest("hex")}`;
}

function displayNameForSkillUnit({ frontmatter = {}, heading = "", folderName = "", sourceSkillId = "" } = {}) {
  const explicitTitle = cleanText(frontmatter.title || frontmatter.displayName || frontmatter.display_name || "");
  if (explicitTitle) return explicitTitle;
  const normalizedId = cleanEntityId(frontmatter.name || folderName || sourceSkillId);
  if (/^edos-rnd-digital-pm$/i.test(normalizedId)) return "PM管理";
  const cleanHeading = cleanText(heading);
  if (cleanHeading && cleanEntityId(cleanHeading) !== normalizedId) return cleanHeading;
  return cleanText(frontmatter.name || folderName || sourceSkillId);
}

function parseFrontmatter(content = "") {
  const match = String(content).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const frontmatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const block = lines[index].match(/^([A-Za-z0-9_-]+):\s*(>[-+]?|\|[-+]?)\s*$/);
    if (block) {
      const key = block[1];
      const values = [];
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() && !/^\s/.test(line)) {
          index -= 1;
          break;
        }
        values.push(line.trim());
        index += 1;
      }
      frontmatter[key] = cleanText(values.join(" "));
      continue;
    }

    const scalar = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (scalar) frontmatter[scalar[1]] = cleanText(cleanYamlScalar(scalar[2]));
  }
  return frontmatter;
}

function cleanYamlScalar(value = "") {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function headingFromMarkdown(content = "") {
  return cleanText(String(content).split(/\r?\n/).find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "") || "");
}

function paragraphAfterHeading(content = "") {
  return cleanText(String(content)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("---") && !line.startsWith("#") && !/^[A-Za-z0-9_-]+:\s*/.test(line))[0] || "");
}

export function runtimeInstructionsFromSkillMarkdown(content = "") {
  const body = stripFrontmatter(content);
  const instructions = cleanInstructionText(body);
  const headings = markdownHeadings(body);
  return {
    contractVersion: "skill-runtime-instructions.v1",
    source: "skill_markdown_reviewed_instruction_body",
    content: instructions.slice(0, maxRuntimeInstructionChars),
    contentHash: hashText(instructions),
    sourceHash: hashText(body),
    sectionHeadings: headings.slice(0, maxRuntimeInstructionSections),
    truncated: instructions.length > maxRuntimeInstructionChars,
  };
}

export function runtimeReferenceFromSkillReference({ path = "", content = "" } = {}) {
  const normalizedPath = cleanArchiveEntry(path);
  const instructions = cleanInstructionText(content);
  if (!normalizedPath || !instructions) return null;
  return {
    contractVersion: "skill-runtime-reference.v1",
    source: "skill_package_reference_markdown",
    path: normalizedPath,
    content: instructions.slice(0, maxRuntimeReferenceChars),
    contentHash: hashText(instructions),
    sourceHash: hashText(content),
    sectionHeadings: markdownHeadings(content).slice(0, maxRuntimeReferenceSections),
    truncated: instructions.length > maxRuntimeReferenceChars,
  };
}

function markdownHeadings(content = "") {
  return uniqueCleanList(String(content || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,4}\s+(.+)$/)?.[1])
    .filter(Boolean));
}

function stripFrontmatter(content = "") {
  return String(content || "").replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
}

function cleanInstructionText(value = "") {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !unsafeInstructionLine(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function unsafeInstructionLine(line = "") {
  return /(api[-_ ]?key|secret|password|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer|jwt|oauth[_ -]?state|authorization code)\s*[:=]\s*\S+/i.test(line);
}

function sectionList(content = "", headings = []) {
  const lines = String(content).split(/\r?\n/);
  const wanted = new Set(headings.map((item) => item.toLowerCase()));
  const items = [];
  let active = false;
  for (const line of lines) {
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    if (heading) {
      const label = heading[1].replace(/[:：].*$/, "").trim().toLowerCase();
      active = wanted.has(label);
      continue;
    }
    if (!active) continue;
    if (/^#{1,4}\s+/.test(line)) break;
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (item) items.push(cleanText(item[1]));
  }
  return uniqueCleanList(items).slice(0, 12);
}

function packageExtension(fileName = "") {
  const text = String(fileName || "").toLowerCase();
  if (text.endsWith(".tar.gz")) return ".tgz";
  return extname(text);
}

function cleanArchiveEntry(entry = "") {
  return String(entry || "").trim().replace(/^\.\/+/, "");
}

function isSafeArchiveEntry(entry = "") {
  const text = cleanArchiveEntry(entry);
  return Boolean(text) && !text.startsWith("/") && !text.includes("../") && !text.includes("..\\");
}

function cleanText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
}

function cleanSourceRef(value) {
  return cleanText(value).slice(0, 300);
}

function cleanEntityId(value) {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "skill-package-unit";
}

function uniqueCleanList(items = []) {
  return Array.from(new Set((Array.isArray(items) ? items : [items]).map(cleanText).filter(Boolean))).slice(0, 20);
}
