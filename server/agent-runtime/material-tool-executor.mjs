import crypto from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalInputDescriptor } from "./canonical-input-types.mjs";
import { createEphemeralMediaRef, resolveEphemeralMediaRef } from "./ephemeral-media-ref.mjs";
import { cleanupPreparedMaterials, runMaterialIntakeTools } from "./material-intake-tools.mjs";
import { createWorkspaceFileTools } from "./workspace-file-tools.mjs";
import { workspaceMutationToolContract } from "./workspace-operations-v1.mjs";

const MAX_EXPORTED_VISUAL_EVIDENCE_ITEMS = 120;
const MAX_EXPORTED_VISUAL_EVIDENCE_BYTES = 2_500_000;
const MAX_REPORT_BUNDLE_VISUAL_EVIDENCE_BYTES = 64_000_000;
const MAX_PROVIDER_FILE_INPUT_BYTES = 50 * 1024 * 1024;
const VISUAL_EVIDENCE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function createMaterialToolExecutor({
  authorizeToolCall = null,
  channelInputs = [],
  channelMaterialIntakeAllowed = false,
  completionEvidenceCapabilities = [],
  connection = {},
  employee = {},
  materialInputContracts = [],
  prepareChannelInput = null,
  skillHarnessRunner = null,
  skillScope = {},
  verifiedHarnessSkillIds = [],
  workspace = null,
  workspaceInitiallyReady = true,
  workspaceManager = null,
  workspaceTaskId = "",
} = {}) {
  const resources = (Array.isArray(channelInputs) ? channelInputs : []).map((resource, index) => ({
    ...resource,
    inputId: cleanShortText(resource?.inputId) || `channel-input-${index + 1}`,
    name: cleanShortText(resource?.name),
    sourceRef: cleanShortText(resource?.sourceRef),
  }));
  const resourceByInputId = new Map(resources.map((resource) => [resource.inputId, resource]));
  const downloadedByInputId = new Map();
  const preparedByInputId = new Map();
  const preparedMaterials = [];
  const toolResults = [];
  const outputArtifacts = [];
  const completedSkillResults = new Map();
  const completionEvidenceByRun = new Map();
  const preparedChannelContent = new Map();
  const privateAgentContentByRun = new Map();
  const privateAgentResults = new WeakMap();
  const visualEvidenceByToken = new Map();
  const inspectedWorkspaceFiles = new Map();
  const inspectedWorkspaceImages = new Map();
  const inspectedInputFiles = new Map();
  const statusByDigest = {};
  let workspaceReady = workspaceInitiallyReady === true;
  const callableSkillIds = uniqueList(skillScope.callableSkillIds || []);
  const deterministicHarnessSkillIds = uniqueList(skillScope.deterministicHarnessSkillIds || []);
  const verifiedHarnessSkillIdSet = new Set(uniqueList(verifiedHarnessSkillIds));
  const harnessSkillIds = deterministicHarnessSkillIds
    .filter((skillId) => callableSkillIds.includes(skillId) && verifiedHarnessSkillIdSet.has(skillId));
  const governedCompletionEvidenceCapabilities = (Array.isArray(completionEvidenceCapabilities)
    ? completionEvidenceCapabilities
    : []).map(normalizeCompletionEvidenceCapability)
    .filter((capability) => capability && harnessSkillIds.includes(capability.fixedArguments.skillId));
  const workspaceFiles = createWorkspaceFileTools({ workspace });

  function toolDefinitions() {
    const inputIds = resources.map((resource) => resource.inputId);
    const definitions = [];
    if (resources.length) {
      definitions.push({
        type: "function",
        name: "prepare_channel_input",
        description: "把当前 Channel 附件放入本任务受控 workspace；模型原生支持的图片和文件会附加到后续 Agent 回合，ZIP 会安全解包，其他格式保留给已挂载 Tool/Skill。",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            inputId: { type: "string", enum: inputIds, description: "当前消息中可处理的输入编号。" },
          },
          required: ["inputId"],
          additionalProperties: false,
        },
      });
    }
    if (workspace && workspaceReady) {
      definitions.push(
        {
          type: "function",
          name: "list_workspace_files",
          description: "列出当前数字员工任务 workspace 内的真实文件和目录。路径必须相对 workspace。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "相对 workspace 的目录；根目录使用 .。" },
              maxDepth: { type: "integer", minimum: 0, maximum: 4 },
            },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "read_workspace_text",
          description: "读取当前 workspace 内的真实文本文件内容，供本轮 Agent 分析；内容不会进入管理台账。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "相对 workspace 的文件路径。" },
              offset: { type: "integer", minimum: 0 },
              maxChars: { type: "integer", minimum: 1, maximum: 40000 },
            },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "inspect_workspace_image",
          description: "把当前 workspace 内的真实图片作为一次性视觉输入附加到下一 Agent 回合。",
          strict: true,
          parameters: {
            type: "object",
            properties: { relativePath: { type: "string", description: "相对 workspace 的图片路径。" } },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "inspect_workspace_file",
          description: "把 workspace 内模型原生支持的 PDF、Office、表格、文本或代码文件作为一次性文件输入附加到下一 Agent 回合。",
          strict: true,
          parameters: {
            type: "object",
            properties: { relativePath: { type: "string", description: "相对 workspace 的文件路径。" } },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "export_visual_evidence",
          description: "把本轮 Skill 产生的私有 ROI/视觉证据导出为可写入静态报告的安全占位符。返回的 htmlSrc 形如 visual-evidence://...，只能原样用于最终 HTML/Markdown 的 img src；服务端写出时会限量展开，不会把图片 Base64 放入会话或台账。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              maxItems: { type: "integer", minimum: 1, maximum: MAX_EXPORTED_VISUAL_EVIDENCE_ITEMS, description: "最多导出多少张当前轮次可用的视觉证据图。" },
            },
            required: ["maxItems"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "copy_workspace_file",
          description: "把当前任务 workspace 的 input/work/output 普通文件原子复制到 work/ 或 output/。不得覆盖已有目标。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              sourcePath: { type: "string", description: "workspace 相对源文件路径。" },
              targetPath: { type: "string", description: "work/ 或 output/ 下的 workspace 相对目标路径。" },
            },
            required: ["sourcePath", "targetPath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "write_workspace_file",
          description: "在当前任务 workspace 的 work/ 或 output/ 原子创建 UTF-8 文件；目标已存在时稳定失败。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "work/ 或 output/ 下的 workspace 相对文件路径。" },
              content: { type: "string", maxLength: 400000, description: "要创建的完整 UTF-8 内容。" },
            },
            required: ["relativePath", "content"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "replace_workspace_file",
          description: "原子替换当前任务 workspace 的 work/ 或 output/ 普通文件；目标缺失时稳定失败。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "work/ 或 output/ 下的 workspace 相对文件路径。" },
              content: { type: "string", maxLength: 400000, description: "替换后的完整 UTF-8 内容。" },
            },
            required: ["relativePath", "content"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "create_workspace_directory",
          description: "在当前任务 workspace 的 work/ 或 output/ 创建目录；input 始终只读。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "work/ 或 output/ 下的 workspace 相对目录路径。" },
            },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "delete_workspace_path",
          description: "原子移除当前任务 workspace 的 work/ 或 output/ 文件或目录；input 始终只读。这是高风险操作，必须等待当前用户对本次精确参数完成一次性结构化审批。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "work/ 或 output/ 下的 workspace 相对路径。" },
            },
            required: ["relativePath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "extract_workspace_archive",
          description: "把当前任务 workspace 中的 ZIP 安全、原子解压到 work/ 或 output/ 新目录。路径逃逸、链接、超限和压缩炸弹会稳定失败，原始 ZIP 不会被修改。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              sourcePath: { type: "string", description: "input/work/output 中的 workspace 相对 ZIP 路径。" },
              targetPath: { type: "string", description: "work/ 或 output/ 下尚不存在的 workspace 相对目标目录。" },
            },
            required: ["sourcePath", "targetPath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "compress_workspace_output",
          description: "把当前任务 workspace 中指定的 output 目录安全、原子压缩为 output/ 下的新 ZIP；不跟随链接，也不覆盖已有压缩包。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              sourcePath: { type: "string", description: "output 或 output/ 下的 workspace 相对源目录。" },
              targetPath: { type: "string", description: "output/ 下尚不存在的 .zip 相对目标路径。" },
            },
            required: ["sourcePath", "targetPath"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "write_workspace_text",
          description: "在当前任务 workspace 的 output/ 中写入 Markdown、静态 HTML、文本、JSON 或 CSV 结果文件。HTML 可用内联 CSS/SVG 展示图表，也可引用 export_visual_evidence 返回的 visual-evidence:// 占位符；不得包含脚本或外部资源。仅用于 Agent 明确决定生成的本轮交付物。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "output/ 下的相对文件名，扩展名限 .md/.html/.txt/.json/.csv。" },
              content: { type: "string", maxLength: 400000, description: "要写入的完整文本内容；视觉证据请使用 export_visual_evidence 返回的占位符，不要自行生成 Base64。" },
            },
            required: ["relativePath", "content"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "write_report_bundle",
          description: "生成图片较多的静态 HTML 报告压缩包：把 index.html 和 assets/ 目录写入 output/ 下的 zip。HTML 可引用 export_visual_evidence 返回的 visual-evidence:// 占位符；服务端会把这些占位符复制为相对路径 assets/visual-evidence/*，避免在 HTML 中内联大量 Base64。",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "output/ 下的 .zip 文件名，例如 report.zip 或 reports/case-review.zip。" },
              html: { type: "string", maxLength: 400000, description: "完整静态 HTML；大量视觉证据请使用 visual-evidence:// 占位符，不要自行生成 Base64、本地路径或外链。" },
            },
            required: ["relativePath", "html"],
            additionalProperties: false,
          },
        },
      );
    }
    if (harnessSkillIds.length && workspace && workspaceReady) {
      const properties = {
        skillId: { type: "string", enum: harnessSkillIds, description: "当前数字员工已挂载且运行时已验证的确定性 Harness Skill 技术标识。" },
      };
      if (inputIds.length) properties.inputId = { type: "string", enum: inputIds, description: "可选：本轮已准备的输入编号。" };
      definitions.push({
        type: "function",
        name: "run_mounted_skill",
        description: "对已准备完成的短时材料调用当前数字员工已挂载、已批准且运行时已验证的确定性 Skill harness。Harness 可在受控工作区读取本次真实材料，并把私有视觉证据直接附加到后续 Agent 回合；返回值仅是可记录的结构化状态。",
        strict: true,
        parameters: {
          type: "object",
          properties,
          required: ["skillId"],
          additionalProperties: false,
        },
      });
    }
    return definitions;
  }

  function safeToolCatalog() {
    return toolDefinitions().map((tool) => ({ name: tool.name, description: tool.description }));
  }

  function availableInputIds() {
    return resources.map((resource) => resource.inputId);
  }

  function markWorkspaceReady() {
    workspaceReady = true;
  }

  function materialRequirements() {
    return !workspaceReady && materialInputContracts.length
      ? [{ kind: "task_workspace_material", status: "required" }]
      : [];
  }

  async function execute({ name = "", arguments: input = {} } = {}, { safeActivity = null, signal = null } = {}) {
    if (signal?.aborted) return toolFailure("agent_turn_canceled", "任务已取消，材料 Tool 未开始执行。");
    const workspaceMutationContract = workspaceMutationToolContract(name);
    if (workspaceMutationContract && typeof authorizeToolCall !== "function") {
      return toolFailure(
        "tool_invocation_blocked",
        "workspace 写操作缺少结构化授权门禁。",
        "检查 Tool 声明、动作风险、调用策略和人工审批状态。",
      );
    }
    if (typeof authorizeToolCall === "function") {
      const decision = await authorizeToolCall({ name, ...(workspaceMutationContract || {}), arguments: input });
      if (decision?.status !== "allowed") {
        const failure = toolFailure(
          "tool_invocation_blocked",
          decision?.nextGate || "该 Tool 调用未通过 L2 执行门禁。",
          "检查 Tool 声明、动作风险、调用策略和人工审批状态。",
          cleanShortText(input.skillId),
        );
        return decision?.confirmationRequest
          ? { ...failure, confirmationRequest: decision.confirmationRequest }
          : failure;
      }
    }
    if (signal?.aborted) return toolFailure("agent_turn_canceled", "任务已取消，材料 Tool 未开始执行。");
    if (name === "prepare_channel_input") return prepareChannelInputTool(input, { signal });
    if (name === "list_workspace_files") return listWorkspaceFiles(input);
    if (name === "read_workspace_text") return readWorkspaceText(input);
    if (name === "inspect_workspace_image") return inspectWorkspaceImage(input);
    if (name === "inspect_workspace_file") return inspectWorkspaceFile(input);
    if (name === "export_visual_evidence") return exportVisualEvidence(input);
    if (name === "copy_workspace_file") return executeWorkspaceOperation("copy", input);
    if (name === "write_workspace_file") return executeWorkspaceOperation("write", input);
    if (name === "replace_workspace_file") return executeWorkspaceOperation("replace", input);
    if (name === "create_workspace_directory") return executeWorkspaceOperation("mkdir", input);
    if (name === "delete_workspace_path") return executeWorkspaceOperation("delete", input);
    if (name === "extract_workspace_archive") return executeWorkspaceOperation("extract", input);
    if (name === "compress_workspace_output") return executeWorkspaceOperation("compress", input);
    if (name === "write_workspace_text") return writeWorkspaceText(input);
    if (name === "write_report_bundle") return writeReportBundle(input);
    if (name === "run_mounted_skill") return runMountedSkill(input, { safeActivity, signal });
    return toolFailure("tool_not_allowed", "该工具不在当前数字员工的已授权运行边界内。");
  }

  async function prepareChannelInputTool(input = {}, { signal = null } = {}) {
    const inputId = cleanShortText(input.inputId);
    const resource = resourceByInputId.get(inputId);
    if (!resource) return toolFailure("channel_input_not_found", "当前 Channel 输入不存在或已失效。");

    let downloaded = downloadedByInputId.get(inputId);
    if (!downloaded) {
      if (typeof prepareChannelInput !== "function") {
        return recordPreparationFailure(resource, "channel_input_preparer_unavailable", "当前 Channel 没有提供可用的附件读取适配器。");
      }
      downloaded = await prepareChannelInput({ channelInput: resource, signal });
      if (signal?.aborted) return toolFailure("agent_turn_canceled", "任务已取消，Channel 输入准备已停止。");
      downloadedByInputId.set(inputId, downloaded);
      statusByDigest[resource.sourceRef || digestValue(inputId)] = downloaded?.status || "download_failed";
      if (!downloaded?.ok) {
        const status = downloaded.status || "download_failed";
        const summary = cleanShortText(downloaded.summary) || "Channel 输入下载失败，请检查访问范围、文件完整性和短时凭证。";
        return recordPreparationFailure(resource, status, summary, downloaded);
      }
    }

    if (workspaceManager && workspace && !workspaceTaskId) {
      return recordPreparationFailure(resource, "workspace_task_identity_missing", "当前受控 workspace 尚未绑定稳定 taskId。");
    }
    const workspaceRoot = workspaceManager && workspaceTaskId
      ? await workspaceManager.createTaskInputDirectory(workspaceTaskId, resource.sourceRef || inputId)
      : "";
    const intake = await runMaterialIntakeTools({
      channelMaterialIntakeAllowed,
      employee,
      downloadedResources: [{ resource, fileName: resource.name, download: downloaded }],
      workspaceRoot,
    });
    const result = intake.toolResults[0];
    if (!result) {
      return recordToolResult({
        toolId: "channel-input-download",
        status: "input_reader_not_available",
        summary: "输入已下载到受控临时区，但当前员工没有可处理该文件类型的已启用工具。",
        nextGate: "挂载并批准对应的文档、表格或媒体读取 Tool 后，由 Agent 重新调用。",
      });
    }

    let preparedResult = result;
    if (intake.preparedMaterials[0]) {
      const prepared = intake.preparedMaterials[0];
      preparedByInputId.set(inputId, prepared);
      preparedMaterials.push(...intake.preparedMaterials);
      const sourceDigest = String(resource.contentDigest || "");
      if (workspace?.root && workspaceTaskId && prepared.files?.length === 1 &&
        path.extname(resource.name).toLowerCase() !== ".zip" && /^sha256:[a-f0-9]{64}$/.test(sourceDigest)) {
        const relativePath = path.relative(workspace.root, prepared.files[0]).split(path.sep).join("/");
        if (relativePath.startsWith("input/") && !relativePath.split("/").includes("..")) {
          inspectedInputFiles.set(relativePath, {
            contentDigest: sourceDigest.slice(7),
            evidenceDigest: crypto.createHash("sha256")
              .update(JSON.stringify(["group-input-read", workspaceTaskId, sourceDigest]))
              .digest("hex"),
          });
        }
      }
      const descriptor = canonicalInputDescriptor({ fileName: prepared.fileName, mimeType: prepared.mimeType });
      if (descriptor && prepared.files?.length === 1) {
        try {
          const mediaRef = await createEphemeralMediaRef({
            fileName: prepared.fileName,
            filePath: prepared.files[0],
            mimeType: descriptor.mimeType,
            root: workspace?.root || prepared.workspace,
            maxBytes: MAX_PROVIDER_FILE_INPUT_BYTES,
          });
          preparedChannelContent.set(inputId, descriptor.type === "image"
            ? { type: "image", mediaRef, detailHint: "high" }
            : { type: "file", mediaRef, fileName: prepared.fileName, mimeType: descriptor.mimeType, detailHint: "auto" });
          preparedResult = {
            ...result,
            status: "temporary_model_input_ready",
            summary: descriptor.type === "image"
              ? "图片已进入受控临时工作区，并已附加到后续 Agent 模型回合。"
              : "文件已进入受控临时工作区，并已附加到后续 Agent 模型回合。",
            nextGate: "由当前模型按其输入能力直接理解；若 Provider 不支持该格式，则返回明确能力错误。",
          };
        } catch {
          // The file remains available to bounded workspace Tools and mounted Skills.
        }
      }
    }
    return recordToolResult(resource.materialContract ? { ...preparedResult, materialContract: resource.materialContract } : preparedResult);
  }

  async function runMountedSkill(input = {}, { safeActivity = null, signal = null } = {}) {
    const inputId = cleanShortText(input.inputId);
    const skillId = cleanShortText(input.skillId);
    if (inputId && !resourceByInputId.has(inputId)) return toolFailure("channel_input_not_found", "当前 Channel 输入不存在或已失效。");
    const materialContract = inputId ? resourceByInputId.get(inputId)?.materialContract : null;
    if (materialContract?.skillId && materialContract.skillId !== skillId) {
      return toolFailure("skill_material_contract_mismatch", "该材料声明了另一个 Skill 的结构化输入合同，不能交给当前 Skill。", "按 materialContract.skillId 运行已挂载 Skill。", skillId);
    }
    if (!callableSkillIds.includes(skillId)) return toolFailure("skill_not_allowed", "该 Skill 未挂载到当前数字员工，不能由本轮 Agent 调用。");
    if (!deterministicHarnessSkillIds.includes(skillId)) {
      return toolFailure("skill_execution_mode_not_harness", "该 Skill 是执行指引或 Tool 工作流，不是可由 Harness 运行器直接执行的能力。", "按 Skill 指引规划，并只调用当前会话实际声明的 Tool。", skillId);
    }
    if (!harnessSkillIds.includes(skillId)) {
      return toolFailure("skill_harness_not_ready", "该确定性 Skill harness 当前未通过安装、发布版本或摘要校验。", "由 Skill owner 修复运行时发布身份后重试。", skillId);
    }
    const material = await resolveSkillMaterial(inputId);
    if (!material) return toolFailure(
      "material_not_prepared",
      "当前 workspace 中还没有可供 Skill 使用的材料。",
      "先使用本任务已声明的材料准备能力，或确认 workspace 中已有文件。",
      skillId,
    );
    if (!skillHarnessRunner || typeof skillHarnessRunner.run !== "function") {
      return toolFailure("skill_harness_unavailable", "当前服务端没有可用的 Skill harness 运行器。", "检查已批准的 Skill harness 安装和服务端运行环境。", skillId);
    }
    const runKey = `${material.workspace}:${skillId}`;
    if (completedSkillResults.has(runKey)) return completedSkillResults.get(runKey);
    const result = await skillHarnessRunner.run({
      skillId,
      material,
      explicitlyRequested: true,
      safeActivity,
      signal,
    });
    if (signal?.aborted) return toolFailure("agent_turn_canceled", "任务已取消，Skill harness 已停止。", "如仍需要，请提交新任务。", skillId);
    if (result.privateAgentContent?.samples?.length) {
      privateAgentContentByRun.set(runKey, result.privateAgentContent);
    }
    const completionEvidence = verifiedCompletionEvidence(result.completionEvidence);
    if (completionEvidence) completionEvidenceByRun.set(runKey, completionEvidence);
    recordHarnessDeliveryArtifacts(result.deliveryArtifacts, skillId);
    const safeResult = recordToolResult(result);
    completedSkillResults.set(runKey, safeResult);
    return safeResult;
  }

  async function listWorkspaceFiles(input = {}) {
    try {
      const entries = await workspaceFiles.list(input);
      return withPrivateAgentResult(recordToolResult({
        toolId: "workspace-files",
        status: "workspace_files_listed",
        summary: `Agent 已读取 workspace 文件树，共 ${entries.length} 项。`,
      }), { status: "workspace_files_listed", entries });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "workspace_list_failed", "无法读取该 workspace 目录。");
    }
  }

  async function readWorkspaceText(input = {}) {
    try {
      const result = await workspaceFiles.readText(input);
      const safe = { ...recordToolResult({
        toolId: "workspace-files",
        status: "workspace_text_read",
        summary: "Agent 已读取 workspace 文本内容。",
      }), ok: true };
      const relativePath = String(input.relativePath || "").replace(/\\/g, "/");
      const source = inspectedInputFiles.get(relativePath);
      if (source && result.offset === 0 && !result.truncated &&
        crypto.createHash("sha256").update(result.content, "utf8").digest("hex") === source.contentDigest) {
        safe.readSourceDigest = source.evidenceDigest;
      }
      return withPrivateAgentResult(safe, { status: "workspace_text_read", ...result });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "workspace_text_read_failed", "无法读取该 workspace 文本文件。");
    }
  }

  async function inspectWorkspaceImage(input = {}) {
    try {
      const relativePath = cleanWorkspacePath(input.relativePath);
      const evidence = await workspaceFiles.imageEvidence({ relativePath });
      inspectedWorkspaceImages.set(relativePath, evidence);
      return withPrivateAgentResult(recordToolResult({
        toolId: "workspace-files",
        status: "workspace_image_attached",
        summary: "真实 workspace 图片已附加到下一 Agent 回合。",
      }), { status: "workspace_image_attached", relativePath });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "workspace_image_read_failed", "无法读取该 workspace 图片。");
    }
  }

  async function inspectWorkspaceFile(input = {}) {
    try {
      const relativePath = cleanWorkspacePath(input.relativePath);
      const evidence = await workspaceFiles.modelInput({ relativePath });
      inspectedWorkspaceFiles.set(relativePath, evidence);
      return withPrivateAgentResult(recordToolResult({
        toolId: "workspace-files",
        status: "workspace_model_input_attached",
        summary: "Agent 已把该 workspace 文件作为一次性原生输入附加到下一模型回合。",
      }), { status: "workspace_model_input_attached", fileName: evidence.fileName, mimeType: evidence.mimeType });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "workspace_model_input_failed", "该 workspace 文件无法作为当前模型的原生输入。", "改用适配该格式的已挂载 Tool 或 Skill。");
    }
  }

  async function executeWorkspaceOperation(operation, input = {}) {
    try {
      const result = await workspaceFiles[operation](input);
      if (operation === "compress") recordCompressedOutputArtifact(result);
      const status = {
        copy: "workspace_file_copied",
        write: "workspace_file_written",
        replace: "workspace_file_replaced",
        mkdir: "workspace_directory_created",
        delete: "workspace_path_deleted",
        extract: "workspace_archive_extracted",
        compress: "workspace_output_compressed",
      }[operation];
      return recordToolResult({
        toolId: "workspace-files",
        status,
        summary: "Agent 已完成受控 workspace 文件操作。",
        details: {
          contractVersion: result.contractVersion,
          operation: result.operation,
          path: result.path,
          sizeBytes: result.sizeBytes,
          sourcePath: result.sourcePath,
          archiveBytes: result.archiveBytes,
          directoryCount: result.directoryCount,
          extractedBytes: result.extractedBytes,
          fileCount: result.fileCount,
          sha256: result.sha256,
          sourceSha256: result.sourceSha256,
          uncompressedBytes: result.uncompressedBytes,
        },
      });
    } catch (error) {
      return toolFailure(cleanShortText(error?.code || error?.message) || "workspace_operation_failed", "无法完成该 workspace 文件操作。");
    }
  }

  function recordCompressedOutputArtifact(result = {}) {
    if (result?.operation !== "compress" || result?.format !== "zip") return;
    const workspaceRelativePath = String(result.path || "").normalize("NFC");
    if (!workspaceRelativePath.startsWith("output/")) return;
    const relativePath = workspaceRelativePath.slice("output/".length);
    if (!relativePath ||
      relativePath.startsWith("/") ||
      relativePath.includes("\\") ||
      relativePath.split("/").includes("..") ||
      !relativePath.toLowerCase().endsWith(".zip")) {
      return;
    }
    outputArtifacts.push({
      fileName: relativePath.split("/").pop(),
      relativePath,
      format: "zip",
      sizeBytes: Number.isSafeInteger(result.archiveBytes) ? result.archiveBytes : undefined,
      fileType: "stream",
      skillId: "workspace-files",
    });
  }

  function recordHarnessDeliveryArtifacts(value, skillId = "") {
    if (!Array.isArray(value)) return;
    const normalizedSkillId = cleanShortText(skillId);
    for (const artifact of value.slice(0, 3)) {
      const relativePath = cleanArtifactRelativePath(artifact?.relativePath);
      const fileName = cleanShortText(artifact?.fileName);
      const sizeBytes = Number(artifact?.sizeBytes);
      if (!relativePath || path.basename(relativePath) !== fileName ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) continue;
      const format = path.extname(fileName).slice(1).toLowerCase() || "file";
      outputArtifacts.push({ fileName, relativePath, format, sizeBytes, fileType: "stream", skillId: normalizedSkillId });
    }
  }

  async function writeWorkspaceText(input = {}) {
    try {
      const content = await expandVisualEvidenceReferences(String(input.content || ""));
      const artifact = await workspaceFiles.writeText({ ...input, content });
      outputArtifacts.push({ ...artifact, fileType: "stream", skillId: "workspace-files" });
      return recordToolResult({
        toolId: "workspace-files",
        status: "workspace_output_written",
        summary: `Agent 已在受控 workspace 中生成 ${artifact.fileName}。`,
        details: { fileName: artifact.fileName, format: artifact.format, sizeBytes: artifact.sizeBytes },
      });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "workspace_output_write_failed", "无法写入该 workspace 结果文件。");
    }
  }

  async function writeReportBundle(input = {}) {
    try {
      const bundle = await expandVisualEvidenceBundleReferences(String(input.html || ""));
      const artifact = await workspaceFiles.writeReportBundle({
        relativePath: input.relativePath,
        html: bundle.html,
        assets: bundle.assets,
      });
      outputArtifacts.push({ ...artifact, fileType: "stream", skillId: "workspace-files" });
      return recordToolResult({
        toolId: "workspace-files",
        status: "report_bundle_written",
        summary: `Agent 已在受控 workspace 中生成 ${artifact.fileName}，包含 ${artifact.assetCount} 个素材文件。`,
        details: {
          assetCount: artifact.assetCount,
          entrypoint: artifact.entrypoint,
          fileName: artifact.fileName,
          format: artifact.format,
          sizeBytes: artifact.sizeBytes,
        },
      });
    } catch (error) {
      return toolFailure(cleanShortText(error?.message) || "report_bundle_write_failed", "无法写入该 HTML 报告压缩包。");
    }
  }

  function exportVisualEvidence(input = {}) {
    const maxItems = Math.max(1, Math.min(Number(input.maxItems) || 1, MAX_EXPORTED_VISUAL_EVIDENCE_ITEMS));
    const assets = collectVisualEvidenceAssets(maxItems);
    return recordToolResult({
      toolId: "workspace-files",
      status: assets.length ? "visual_evidence_exported" : "visual_evidence_unavailable",
      summary: assets.length
        ? `已导出 ${assets.length} 张当前轮次视觉证据占位符，可用于静态报告。`
        : "当前轮次还没有可导出的 Skill 视觉证据；如需 ROI 报告，请先运行会产生视觉证据的 mounted Skill。",
      details: { assets },
      nextGate: assets.length ? "" : "先调用对应 mounted Skill 生成视觉证据，再导出报告占位符。",
    });
  }

  function collectVisualEvidenceAssets(maxItems) {
    const assets = [];
    visualEvidenceByToken.clear();
    for (const [runKey, evidence] of privateAgentContentByRun.entries()) {
      let sampleIndex = 0;
      for (const sample of evidence.samples || []) {
        sampleIndex += 1;
        if (!sample?.mediaRef) continue;
        const token = `sample-${digestValue(`${runKey}:${sample.sampleId || sampleIndex}`)}`;
        visualEvidenceByToken.set(token, sample);
        assets.push({
          id: token,
          sampleId: cleanShortText(sample.sampleId),
          pairId: cleanShortText(sample.pairId),
          evidenceKind: cleanShortText(sample.evidenceKind),
          label: cleanShortText(sample.label),
          mappedCategory: cleanShortText(sample.mappedCategory),
          caption: cleanShortText(sample.caption),
          mimeType: cleanShortText(sample.mimeType),
          htmlSrc: `visual-evidence://${token}`,
        });
        if (assets.length >= maxItems) return assets;
      }
    }
    return assets;
  }

  async function expandVisualEvidenceReferences(content = "") {
    const text = String(content || "");
    if (!text.includes("visual-evidence://")) return text;
    const matches = [...text.matchAll(/visual-evidence:\/\/([A-Za-z0-9._~-]+)/g)];
    const tokens = [...new Set(matches.map((match) => match[1]))];
    const replacements = new Map();
    let totalBytes = 0;
    for (const token of tokens) {
      const sample = visualEvidenceByToken.get(token);
      if (!sample?.mediaRef) throw new Error("visual_evidence_reference_unavailable");
      const resolved = await resolveEphemeralMediaRef(sample.mediaRef);
      totalBytes += resolved.bytes.length;
      if (totalBytes > MAX_EXPORTED_VISUAL_EVIDENCE_BYTES) throw new Error("visual_evidence_output_too_large");
      replacements.set(token, `data:${resolved.mimeType};base64,${resolved.bytes.toString("base64")}`);
    }
    const expanded = text.replace(/visual-evidence:\/\/([A-Za-z0-9._~-]+)/g, (_value, token) => replacements.get(token) || "");
    if (expanded.includes("visual-evidence://")) throw new Error("visual_evidence_reference_unavailable");
    return expanded;
  }

  async function expandVisualEvidenceBundleReferences(content = "") {
    const text = String(content || "");
    const matches = [...text.matchAll(/visual-evidence:\/\/([A-Za-z0-9._~-]+)/g)];
    if (!matches.length) return { html: text, assets: [] };
    const tokens = [...new Set(matches.map((match) => match[1]))];
    const replacements = new Map();
    const assets = [];
    let totalBytes = 0;
    let index = 0;
    for (const token of tokens) {
      const sample = visualEvidenceByToken.get(token);
      if (!sample?.mediaRef) throw new Error("visual_evidence_reference_unavailable");
      const resolved = await resolveEphemeralMediaRef(sample.mediaRef);
      const mimeType = cleanShortText(resolved.mimeType || sample.mimeType);
      const extension = VISUAL_EVIDENCE_EXTENSIONS.get(mimeType);
      if (!extension) throw new Error("visual_evidence_type_rejected");
      totalBytes += resolved.bytes.length;
      if (totalBytes > MAX_REPORT_BUNDLE_VISUAL_EVIDENCE_BYTES) throw new Error("report_bundle_visual_evidence_too_large");
      index += 1;
      const relativePath = `assets/visual-evidence/${String(index).padStart(3, "0")}-${token}${extension}`;
      replacements.set(token, relativePath);
      assets.push({ relativePath, mimeType, bytes: resolved.bytes });
    }
    const html = text.replace(/visual-evidence:\/\/([A-Za-z0-9._~-]+)/g, (_value, token) => replacements.get(token) || "");
    if (html.includes("visual-evidence://")) throw new Error("visual_evidence_reference_unavailable");
    return { html, assets };
  }

  function availableAgentContent() {
    const content = [];
    for (const [inputId, item] of preparedChannelContent.entries()) {
      const resource = resourceByInputId.get(inputId);
      content.push({ type: "text", text: `Authorized Channel attachment: ${cleanShortText(resource?.name || item.fileName || inputId)}` });
      content.push(item);
    }
    for (const evidence of privateAgentContentByRun.values()) {
      if (evidence.instructions) content.push({ type: "text", text: evidence.instructions });
      for (const sample of evidence.samples || []) {
        if (sample.caption) content.push({ type: "text", text: cleanShortText(sample.caption) });
        content.push({ type: "image", mediaRef: sample.mediaRef, detailHint: "high" });
      }
    }
    for (const evidence of inspectedWorkspaceImages.values()) {
      content.push({ type: "text", text: evidence.caption });
      content.push({ type: "image", mediaRef: evidence.mediaRef, detailHint: "high" });
    }
    for (const evidence of inspectedWorkspaceFiles.values()) {
      content.push({ type: "text", text: evidence.caption });
      content.push(evidence.type === "image"
        ? { type: "image", mediaRef: evidence.mediaRef, detailHint: "high" }
        : { type: "file", mediaRef: evidence.mediaRef, fileName: evidence.fileName, mimeType: evidence.mimeType, detailHint: evidence.detailHint || "auto" });
    }
    return content;
  }

  function withPrivateAgentResult(safeResult, agentResult) {
    privateAgentResults.set(safeResult, agentResult);
    return safeResult;
  }

  function agentResultFor(result) {
    return privateAgentResults.get(result) || result;
  }

  function safeActivityDescriptor(toolCall = {}, { result = null } = {}) {
    if (toolCall.name !== "read_workspace_text") return null;
    const source = result?.status === "workspace_text_read" && /^[a-f0-9]{64}$/.test(result.readSourceDigest || "")
      ? result.readSourceDigest : "";
    return { kind: "tool", subjectId: "read_workspace_text", actionCode: "workspace.read_text",
      ...(source ? { operationCode: `source.${source}`, operationDisplayAllowed: true } : {}) };
  }

  function recordPreparationFailure(resource, status, summary, downloaded = null) {
    statusByDigest[resource.sourceRef || digestValue(resource.inputId)] = status;
    const nextGate = cleanShortText(downloaded?.nextGate) || (status === "download_too_large"
      ? "请拆分为每个不超过 90 MB 的独立 ZIP，或提供已登记 Remote/集群资源与只读路径，或对象存储 Dataset/Branch/版本；系统仍会核验资源绑定和读取授权。"
      : "检查 Channel 文件读取权限、凭证和文件访问范围后重试。");
    return recordToolResult({
      toolId: "channel-input-download",
      status,
      summary,
      nextGate,
      dataset: downloaded?.sizeBytes ? { fileCount: 1 } : {},
    });
  }

  function recordToolResult(result = {}) {
    const details = result.details && typeof result.details === "object" ? result.details : {};
    const businessSource = result.skillId ? details : result;
    const dataset = objectField(businessSource, "dataset");
    const labels = arrayField(businessSource, "labels");
    const riskCounts = objectField(businessSource, "riskCounts");
    const risks = arrayField(businessSource, "risks");
    const visualReview = objectField(businessSource, "visualReview");
    const safeResult = {
      toolId: cleanShortText(result.toolId),
      skillId: cleanShortText(result.skillId),
      status: cleanShortText(result.status) || "tool_result_unavailable",
      summary: cleanShortText(result.summary),
      details,
      groundTruthSource: cleanShortText(businessSource.groundTruthSource),
      dataset,
      labels: labels.slice(0, 20).map((item) => ({
        label: cleanShortText(item?.label),
        count: Number(item?.count) || 0,
        fileCount: Number(item?.fileCount) || 0,
      })).filter((item) => item.label),
      riskCounts: Object.fromEntries(Object.entries(riskCounts).slice(0, 16)
        .map(([key, value]) => [cleanShortText(key), Number(value) || 0])
        .filter(([key]) => key)),
      risks: risks.slice(0, 8).map(cleanShortText).filter(Boolean),
      visualReview: {
        status: cleanShortText(visualReview.status),
        sampleCount: Number(visualReview.sampleCount) || 0,
        labels: Array.isArray(visualReview.labels) ? visualReview.labels.slice(0, 24).map(cleanShortText).filter(Boolean) : [],
        seed: Number(visualReview.seed) || 0,
      },
      nextGate: cleanShortText(result.nextGate),
    };
    toolResults.push(safeResult);
    return safeResult;
  }

  function objectField(source, key) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) return source[key];
    return {};
  }

  function arrayField(source, key) {
    return Array.isArray(source[key]) ? source[key] : [];
  }

  function toolFailure(status, summary, nextGate = "检查当前数字员工的 Tool/Skill 挂载与输入契约。", skillId = "") {
    return recordToolResult({ toolId: "agent-material-tool", skillId, status, summary, nextGate });
  }

  function taskPatch() {
    return {
      statusByDigest: { ...statusByDigest },
      toolResults: toolResults.map((result) => ({
        ...result,
        details: scrubEphemeralReferences(result.details),
      })),
    };
  }

  function availableOutputArtifacts() {
    return outputArtifacts.slice(0, 3);
  }

  function completionEvidence() {
    return [...completionEvidenceByRun.values()];
  }

  function completionEvidenceCapabilityCatalog() {
    return governedCompletionEvidenceCapabilities;
  }

  async function resolveSkillMaterial(inputId = "") {
    const taskWorkspaceRoot = workspace?.root || "";
    if (inputId && preparedByInputId.has(inputId)) {
      const prepared = preparedByInputId.get(inputId);
      return prepared ? { ...prepared, workspace: taskWorkspaceRoot || prepared.workspace } : prepared;
    }
    const latestInput = await workspaceManager?.latestInputDirectory?.(workspace);
    if (!latestInput) return null;
    return { workspace: taskWorkspaceRoot || latestInput, files: await collectFiles(latestInput), managedWorkspace: true };
  }

  async function dispose() {
    await cleanupPreparedMaterials(preparedMaterials);
    // Bound inputs belong to workspace retention; only transient downloads belong to this executor.
    await Promise.all([...downloadedByInputId.values()].map((downloaded) => downloaded?.temporaryFilePath && downloaded.fileOwnership !== "task_workspace"
      ? rm(downloaded.temporaryFilePath, { force: true }).catch(() => {})
      : Promise.resolve()));
  }

  return {
    harnessSkillIds,
    agentResultFor,
    availableAgentContent,
    availableInputIds,
    availableOutputArtifacts,
    completionEvidence,
    completionEvidenceCapabilities: completionEvidenceCapabilityCatalog,
    dispose,
    execute,
    markWorkspaceReady,
    materialRequirements,
    safeToolCatalog,
    safeActivityDescriptor,
    taskPatch,
    toolDefinitions,
  };
}

function verifiedCompletionEvidence(value) {
  const contractId = String(value?.contractId || "").trim();
  if (value?.status !== "verified" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(contractId)) return null;
  return Object.freeze({ contractId, status: "verified" });
}

function normalizeCompletionEvidenceCapability(value) {
  const contractId = String(value?.contractId || "").trim();
  const skillId = cleanShortText(value?.fixedArguments?.skillId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,179}$/.test(contractId) ||
    value?.toolName !== "run_mounted_skill" || !skillId) return null;
  return Object.freeze({
    contractId,
    fixedArguments: Object.freeze({ skillId }),
    prerequisiteKinds: Object.freeze(["task_workspace_material"]),
    toolName: "run_mounted_skill",
  });
}

async function collectFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      if (files.length >= 2_000) return;
    }
  }
  await visit(root);
  return files;
}

function cleanWorkspacePath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 1_000);
}

function cleanArtifactRelativePath(value = "") {
  const relativePath = String(value || "").trim();
  if (!relativePath || relativePath.length > 1_000 || relativePath.includes("\\") || relativePath.startsWith("/")) return "";
  return relativePath.split("/").every((part) => part && part !== "." && part !== "..") ? relativePath : "";
}

function scrubEphemeralReferences(value) {
  if (Array.isArray(value)) return value.map(scrubEphemeralReferences);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.startsWith("visual-evidence://") ? "" : value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "mediaRef")
    .map(([key, item]) => [key, scrubEphemeralReferences(item)]));
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function digestValue(value = "") {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function uniqueList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanShortText).filter(Boolean))];
}

export { createMaterialToolExecutor };
