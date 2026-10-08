import { buildSkillPackageBundle } from "../src/lib/skillPackaging.js";
import {
  businessSkillPackageFileName,
  digitalEmployeePackageFileName,
  employeePackageRootSkillIds,
  hasExportableBusinessSkillPackage,
  hasExportableEmployeePackage,
} from "../src/lib/digitalEmployeePackage.js";

const packageContractVersion = "digital-employee-portable-package.v1";
const businessSkillPackageContractVersion = "business-skill-portable-package.v1";

export function createAssetPackageDownloadHandlers({
  assetPackageDownloadStore,
  cleanList,
  cleanText,
  getBasicSkills = () => [],
  getBusinessSkills,
  getDigitalEmployees,
  hasPermission,
  requireSession,
  sendJson,
}) {
  function handle(req, res, url) {
    if (req.method !== "GET") return undefined;
    const employeeMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/package\.zip$/);
    if (employeeMatch) {
      exportDigitalEmployeePackage(req, res, decodeURIComponent(employeeMatch[1]));
      return true;
    }
    const skillMatch = url.pathname.match(/^\/api\/business-skills\/([^/]+)\/package$/);
    if (skillMatch) {
      downloadBusinessSkillPackage(req, res, decodeURIComponent(skillMatch[1]));
      return true;
    }
    return undefined;
  }

  function exportDigitalEmployeePackage(req, res, employeeId) {
    const session = requireSession(req, res);
    if (!session) return undefined;

    const employee = getDigitalEmployees({}).find((item) => item.id === employeeId);
    if (!employee) {
      return sendJson(res, 404, {
        ok: false,
        error: "digital_employee_not_found",
        contractVersion: packageContractVersion,
      });
    }
    if (!hasExportableEmployeePackage(employee)) {
      return sendJson(res, 409, {
        ok: false,
        error: "digital_employee_package_not_exportable",
        contractVersion: packageContractVersion,
        message: "该数字员工没有声明可导出的完整包边界。",
      });
    }
    if (!canDownloadAssetPackage(session, employee, hasPermission)) {
      return sendJson(res, 403, {
        ok: false,
        error: "digital_employee_package_download_forbidden",
        contractVersion: packageContractVersion,
        message: "只有平台管理员或数字员工归属部门成员可下载该完整包。",
      });
    }

    const allSkills = [...getBasicSkills({}), ...getBusinessSkills({})];
    const packageRootSkillIds = employeePackageRootSkillIds(employee);
    if (!packageRootSkillIds.length) {
      return sendJson(res, 409, {
        ok: false,
        error: "digital_employee_package_skills_required",
        contractVersion: packageContractVersion,
        message: "完整包导出需要明确的 packageBundleSkillIds 或 businessSkillIds。",
      });
    }

    const packageBundle = buildSkillPackageBundle(packageRootSkillIds, allSkills);
    if (packageBundle.missingDependencyIds.length) {
      return sendJson(res, 409, {
        ok: false,
        error: "digital_employee_package_dependency_missing",
        contractVersion: packageContractVersion,
        missingDependencyIds: packageBundle.missingDependencyIds,
        message: "依赖 Skill 不完整，已阻断导出，避免下载到不完整包。",
      });
    }

    const files = buildEmployeePackageFiles({
      cleanList,
      cleanText,
      employee,
      packageBundle,
    });
    const zipBuffer = createZipBuffer(files);
    const fileName = digitalEmployeePackageFileName(employee);
    recordAssetPackageDownload("digital_employee", employee, session);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(fileName),
      "Content-Length": String(zipBuffer.length),
      "Cache-Control": "no-store",
      "X-Package-Contract": packageContractVersion,
    });
    res.end(zipBuffer);
    return true;
  }

  function downloadBusinessSkillPackage(req, res, skillId) {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const skill = getBusinessSkills({}).find((item) => item.id === skillId);
    if (!skill) {
      return sendJson(res, 404, { ok: false, error: "business_skill_not_found" });
    }
    if (!hasExportableBusinessSkillPackage(skill)) {
      return sendJson(res, 409, {
        ok: false,
        error: "business_skill_package_not_exportable",
        contractVersion: businessSkillPackageContractVersion,
      });
    }
    if (!canDownloadAssetPackage(session, skill, hasPermission)) {
      return sendJson(res, 403, {
        ok: false,
        error: "business_skill_package_download_forbidden",
        contractVersion: businessSkillPackageContractVersion,
        message: "只有平台管理员或 Skill 归属部门成员可下载该完整包。",
      });
    }

    if (skill.downloadUrl) {
      const downloadUrl = safeDownloadUrl(skill.downloadUrl);
      if (!downloadUrl) {
        return sendJson(res, 409, {
          ok: false,
          error: "business_skill_package_download_url_invalid",
          contractVersion: businessSkillPackageContractVersion,
        });
      }
      recordAssetPackageDownload("business_skill", skill, session);
      res.writeHead(302, { Location: downloadUrl, "Cache-Control": "no-store" });
      res.end();
      return true;
    }

    const files = buildBusinessSkillPackageFiles({ cleanList, cleanText, skill });
    const zipBuffer = createZipBuffer(files);
    recordAssetPackageDownload("business_skill", skill, session);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(businessSkillPackageFileName(skill)),
      "Content-Length": String(zipBuffer.length),
      "Cache-Control": "no-store",
      "X-Package-Contract": businessSkillPackageContractVersion,
    });
    res.end(zipBuffer);
    return true;
  }

  return { handle };

  function recordAssetPackageDownload(assetKind, asset, session) {
    assetPackageDownloadStore?.recordDownload?.(
      {
        assetKind,
        assetId: asset.id,
        assetVersion: asset.version,
      },
      session,
    );
  }
}

function safeDownloadUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function buildEmployeePackageFiles({
  cleanList,
  cleanText,
  employee,
  packageBundle,
  generatedAt = new Date().toISOString(),
}) {
  const rootDir = safePathSegment(employee.id || "digital-employee-package");
  const includedSkills = packageBundle.includedSkills.map((skill) => summarizeSkill(skill, cleanList, cleanText));
  const manifest = {
    contractVersion: packageContractVersion,
    generatedAt,
    packageKind: "digital_employee_portable_capability_package",
    employee: summarizeEmployee(employee, cleanList, cleanText),
    includedSkillIds: packageBundle.includedSkillIds,
    dependencySkillIds: packageBundle.dependencySkillIds,
    includedSkills,
    effectiveMountChanges: Array.isArray(employee.effectiveMountChanges) ? employee.effectiveMountChanges : [],
    packageBoundary: employee.packageBoundary || null,
    packageRecordBoundary: cleanText(employee.packageRecordBoundary || employee.packageBoundary?.boundarySummary || ""),
    platformRecordsExcluded: cleanList(employee.packageBoundary?.platformRecords),
    privacyBoundary:
      "Package export contains portable capability declarations only. It excludes raw prompts, private package payloads, provider keys, model traces, execution payloads, customer data, employee PII, eval records, badcases, approval history, runtime audit logs, and platform operation history.",
  };

  return [
    {
      path: `${rootDir}/manifest.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: `${rootDir}/README.md`,
      content: employeeReadme(employee, packageBundle, cleanList, cleanText),
    },
    {
      path: `${rootDir}/employee.json`,
      content: `${JSON.stringify(manifest.employee, null, 2)}\n`,
    },
    {
      path: `${rootDir}/install.md`,
      content: installReadme(employee, packageBundle, cleanList, cleanText),
    },
    {
      path: `${rootDir}/package-boundary.md`,
      content: packageBoundaryReadme(employee, cleanList, cleanText),
    },
    ...packageBundle.includedSkills.map((skill) => ({
      path: `${rootDir}/skills/${safePathSegment(skill.id || skill.skillApiId || skill.name)}/SKILL.md`,
      content: skillReadme(skill, cleanList, cleanText),
    })),
  ];
}

export function buildBusinessSkillPackageFiles({
  cleanList,
  cleanText,
  skill,
  generatedAt = new Date().toISOString(),
}) {
  const rootDir = safePathSegment(skill.id || skill.skillApiId || "business-skill-package");
  const manifest = {
    contractVersion: businessSkillPackageContractVersion,
    generatedAt,
    packageKind: "business_skill_portable_capability_package",
    skill: summarizeSkill(skill, cleanList, cleanText),
    packageBoundary: {
      normalizedFromPublishedCatalog: true,
      originalUploadIncluded: false,
      executablePayloadIncluded: false,
    },
    privacyBoundary:
      "Package export contains the governed capability declaration only. It excludes the original uploaded package, raw prompts, private payloads, provider keys, model traces, execution payloads, customer data, employee PII, eval records, badcases, approval history, runtime audit logs, and platform operation history.",
  };

  return [
    {
      path: `${rootDir}/manifest.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: `${rootDir}/SKILL.md`,
      content: skillReadme(skill, cleanList, cleanText),
    },
    {
      path: `${rootDir}/install.md`,
      content: businessSkillInstallReadme(skill, cleanText),
    },
    {
      path: `${rootDir}/package-boundary.md`,
      content: businessSkillPackageBoundaryReadme(),
    },
  ];
}

export function createZipBuffer(files = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.path, "utf8");
    const contentBuffer = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content || ""), "utf8");
    const crc = crc32(contentBuffer);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + contentBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(files.length, 8);
  endHeader.writeUInt16LE(files.length, 10);
  endHeader.writeUInt32LE(centralDirectory.length, 12);
  endHeader.writeUInt32LE(offset, 16);
  endHeader.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endHeader]);
}

function canDownloadAssetPackage(session, asset, permissionCheck) {
  if (permissionCheck(session.permissions, "system:*")) return true;
  if (permissionCheck(session.permissions, "digital-employees:*")) return true;
  if (permissionCheck(session.permissions, "system-imports:*")) return true;
  const sessionDepartmentId = String(session.departmentId || "");
  const allowedDepartmentIds = [asset.ownerDepartmentId, asset.departmentId].map((item) => String(item || ""));
  return Boolean(sessionDepartmentId && allowedDepartmentIds.includes(sessionDepartmentId));
}

function summarizeEmployee(employee, cleanList, cleanText) {
  return {
    id: employee.id,
    name: employee.name,
    title: employee.title,
    level: employee.level,
    status: employee.status,
    version: employee.version,
    departmentId: employee.departmentId,
    ownerDepartmentId: employee.ownerDepartmentId,
    ownerUserId: employee.ownerUserId,
    owner: employee.owner,
    permissionScope: employee.permissionScope,
    permissionSummary: employee.permissionSummary,
    reviewGate: employee.reviewGate,
    skillPackage: employee.skillPackage,
    packageFormat: employee.packageFormat,
    packageCompleteness: employee.packageCompleteness,
    packageIncludes: cleanList(employee.packageIncludes),
    packageBundleSkillIds: cleanList(employee.packageBundleSkillIds),
    basicSkillIds: cleanList(employee.basicSkillIds),
    businessSkillIds: cleanList(employee.businessSkillIds),
    capabilities: cleanList(employee.capabilities),
    inputs: cleanList(employee.inputs),
    outputs: cleanList(employee.outputs),
    rules: cleanList(employee.rules),
    tools: cleanList(employee.tools),
    unsupportedActions: cleanList(employee.unsupportedActions),
    outputContract: cleanText(employee.outputContract || ""),
    promptMetadata: {
      promptScope: cleanText(employee.promptScope || ""),
      promptVersion: cleanText(employee.promptVersion || ""),
      promptHash: cleanText(employee.promptGovernance?.promptHash || ""),
      rawPromptStored: false,
    },
    runtimeBinding: {
      provider: cleanText(employee.runtimeBinding?.provider || employee.modelBinding?.provider || ""),
      runtimeAdapter: cleanText(employee.runtimeBinding?.runtimeAdapter || employee.modelBinding?.runtimeAdapter || ""),
      productionReady: employee.runtimeBinding?.productionReady === true,
      rawKeyStoredInCatalog: false,
    },
    objective: cleanText(employee.objective || ""),
  };
}

function summarizeSkill(skill, cleanList, cleanText) {
  return {
    id: skill.id,
    skillApiId: cleanText(skill.skillApiId || skill.id || ""),
    sourceSkillId: cleanText(skill.sourceSkillId || ""),
    lineageKey: cleanText(skill.lineageKey || skill.sourceSkillId || skill.skillApiId || skill.id || ""),
    name: cleanText(skill.name || skill.id || ""),
    version: cleanText(skill.version || ""),
    status: cleanText(skill.status || ""),
    departmentId: cleanText(skill.departmentId || ""),
    domain: cleanText(skill.domain || skill.businessGroup || ""),
    owner: cleanText(skill.owner || ""),
    risk: cleanText(skill.risk || ""),
    reviewGate: cleanText(skill.reviewGate || ""),
    capabilities: cleanList(skill.capabilities || [skill.description]),
    inputs: cleanList(skill.inputs || skill.declaredInputs),
    outputs: cleanList(skill.outputs || skill.declaredOutputs),
    tools: cleanList(skill.tools),
    constraints: cleanList(skill.constraints),
    dependencies: cleanList([
      ...(skill.packageBundleSkillIds || []),
      ...(skill.dependencySkillIds || []),
      ...(skill.apiDependencySkillIds || []),
      ...(skill.referenceSkillIds || []),
      ...(skill.linkedSkillIds || []),
    ]),
    promptMetadata: {
      promptScope: cleanText(skill.promptGovernance?.promptScope || skill.promptScope || ""),
      promptVersion: cleanText(skill.promptGovernance?.promptVersion || skill.promptVersion || ""),
      promptHash: cleanText(skill.promptGovernance?.promptHash || skill.promptHash || ""),
      rawPromptStored: false,
    },
    description: cleanText(skill.description || skill.manifestSummary || ""),
  };
}

function employeeReadme(employee, packageBundle, cleanList, cleanText) {
  return [
    `# ${cleanText(employee.name || employee.id)}`,
    "",
    cleanText(employee.objective || employee.title || "数字员工可携带能力包。"),
    "",
    "## Package",
    "",
    `- Contract: ${packageContractVersion}`,
    `- Employee ID: ${cleanText(employee.id || "")}`,
    `- Status: ${cleanText(employee.status || "")}`,
    `- Version: ${cleanText(employee.version || "")}`,
    `- Included Skills: ${packageBundle.includedSkillIds.length}`,
    "",
    "## Capabilities",
    "",
    listMarkdown(cleanList(employee.capabilities)),
    "",
    "## Boundary",
    "",
    cleanText(employee.packageRecordBoundary || employee.packageBoundary?.boundarySummary || ""),
    "",
  ].join("\n");
}

function installReadme(employee, packageBundle, cleanList, cleanText) {
  return [
    "# Install And Review",
    "",
    "1. Inspect `manifest.json` and each `skills/*/SKILL.md`.",
    "2. Confirm owner, permission scope, dependency closure, Prompt metadata fingerprints, output contract, and review gate.",
    "3. Submit the package through the system import flow before mounting, trial, distribution, or production use.",
    "",
    "## Required Gates",
    "",
    listMarkdown([
      cleanText(employee.reviewGate || ""),
      ...cleanList(employee.downloadPolicy?.approval),
      "安装、挂载、发布和业务系统调用仍需登记员预审、人员/技能审批、调用门禁和质量回流。",
    ]),
    "",
    "## Included Skills",
    "",
    listMarkdown(packageBundle.includedLabels),
    "",
  ].join("\n");
}

function packageBoundaryReadme(employee, cleanList, cleanText) {
  return [
    "# Package Boundary",
    "",
    "## Portable Contents",
    "",
    listMarkdown(cleanList(employee.packageBoundary?.portableContents || employee.packageIncludes)),
    "",
    "## Excluded Platform Records",
    "",
    listMarkdown(cleanList(employee.packageBoundary?.platformRecords)),
    "",
    "## Privacy Boundary",
    "",
    "不导出 raw prompt、原始上传包、私有 payload、provider key、模型 trace、执行 payload、客户数据、员工 PII、治理审批、eval、badcase、root cause、分发历史、运行审计或运维记录。",
    "",
    "## Source Summary",
    "",
    listMarkdown(cleanList(employee.sourceTargets).map((item) => cleanText(item))),
    "",
  ].join("\n");
}

function skillReadme(skill, cleanList, cleanText) {
  return [
    `# ${cleanText(skill.name || skill.id)}`,
    "",
    cleanText(skill.description || skill.manifestSummary || "业务 Skill 能力声明。"),
    "",
    "## Identity",
    "",
    `- skillApiId: ${cleanText(skill.skillApiId || skill.id || "")}`,
    `- sourceSkillId: ${cleanText(skill.sourceSkillId || "")}`,
    `- version: ${cleanText(skill.version || "")}`,
    `- status: ${cleanText(skill.status || "")}`,
    "",
    "## Capabilities",
    "",
    listMarkdown(cleanList(skill.capabilities || [skill.description])),
    "",
    "## Inputs",
    "",
    listMarkdown(cleanList(skill.inputs || skill.declaredInputs)),
    "",
    "## Outputs",
    "",
    listMarkdown(cleanList(skill.outputs || skill.declaredOutputs)),
    "",
    "## Tools",
    "",
    listMarkdown(cleanList(skill.tools)),
    "",
    "## Constraints",
    "",
    listMarkdown(cleanList(skill.constraints)),
    "",
    "## Prompt Metadata",
    "",
    `- promptScope: ${cleanText(skill.promptGovernance?.promptScope || skill.promptScope || "")}`,
    `- promptVersion: ${cleanText(skill.promptGovernance?.promptVersion || skill.promptVersion || "")}`,
    `- promptHash: ${cleanText(skill.promptGovernance?.promptHash || skill.promptHash || "")}`,
    "- rawPromptStored: false",
    "",
  ].join("\n");
}

function businessSkillInstallReadme(skill, cleanText) {
  return [
    "# Install And Review",
    "",
    "1. Inspect `manifest.json`, `SKILL.md`, and `package-boundary.md`.",
    "2. Confirm the stable Skill identity, version, owner, input/output contract, dependencies, Prompt metadata fingerprints, and review gate.",
    "3. Submit this governed declaration through the system import flow before mounting, distribution, trial, or production use.",
    "",
    "## Required Gate",
    "",
    `- ${cleanText(skill.reviewGate || "需 Skill owner 与平台治理人员复核")}`,
    "- 该导出不包含原始上传包或可执行文件；运行前必须另行获取受信任的版本化执行载荷并通过完整性校验。",
    "",
  ].join("\n");
}

function businessSkillPackageBoundaryReadme() {
  return [
    "# Package Boundary",
    "",
    "这是由已发布目录记录生成的治理能力包，用于审阅、迁移和重新导入能力声明。",
    "",
    "- 包含：Skill 稳定标识、版本、能力、输入输出、Tool 声明、约束和 Prompt 指纹摘要。",
    "- 不包含：原始上传 ZIP、脚本/依赖等可执行载荷、raw prompt、私有 payload、凭据、客户数据、审批/测评/badcase/运行审计记录。",
    "- 该包不代表已安装、已挂载、可运行或已获得业务写回权限。",
    "",
  ].join("\n");
}

function listMarkdown(items = []) {
  const list = items.map((item) => String(item || "").trim()).filter(Boolean);
  return list.length ? list.map((item) => `- ${item}`).join("\n") : "- 未声明";
}

function safePathSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "item";
}

function contentDisposition(fileName) {
  const fallback = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
