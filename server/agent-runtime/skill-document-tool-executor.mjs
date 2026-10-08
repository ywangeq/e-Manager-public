// Prompt projection only: the task's frozen dependency context remains authoritative.
const TOOL_NAME = "runtime__readSkillDocument";
const TOOL_ID = "runtime-skill-documents";
const DEFAULT_PAGE_CHARS = 12_000;
const MAX_PAGE_CHARS = 16_000;

function prepareSkillDocumentContext(dependencyContext, delegate = null, authorizeSkillRead = null) {
  if (authorizeSkillRead !== null && typeof authorizeSkillRead !== "function") throw new TypeError("skill_document_authorizer_invalid");
  const allowed = new Set(dependencyContext.skillScope?.callableSkillIds || []);
  const documents = new Map();
  const callableSkills = (dependencyContext.callableSkills || []).filter((skill) => allowed.has(skill.id)).map((skill) => {
    const entries = [];
    if (allowed.has(skill.id)) {
      if (skill.runtimeInstructions?.content) entries.push(["SKILL.md", skill.runtimeInstructions]);
      for (const reference of skill.runtimeReferences || []) {
        if (reference.path && reference.content) entries.push([reference.path, reference]);
      }
    }
    const version = String(skill.version || "");
    const { runtimeInstructions, runtimeReferences, ...details } = structuredClone(skill);
    const referenceIndex = (runtimeReferences || []).filter(value => value.path && value.content)
      .map(value => ({ documentPath: value.path, characterCount: value.content.length,
        sourceTruncated: value.truncated === true }));
    const skillDetails = { ...details, runtimeReferences: referenceIndex };
    // Metadata-only Skills remain discoverable without inventing executable instructions.
    entries.push(["skill-details.json", { content: JSON.stringify(skillDetails) }]);
    documents.set(skill.id, { version, details: skillDetails,
      entries: new Map(entries.map(([path, value]) => [path, structuredClone(value)])) });
    return {
      id: skill.id, name: skill.name, version,
      description: String(skill.description || "").slice(0, 240),
      ...(String(skill.description || "").length > 240 ? { descriptionTruncated: true } : {}),
      activationPolicy: skill.activationPolicy,
      runtimeExecutionProfile: skill.runtimeExecutionProfile ? { mode: skill.runtimeExecutionProfile.mode } : null,
      runtimeInstructions: { documentPath: runtimeInstructions?.content ? "SKILL.md" : "skill-details.json", readTool: TOOL_NAME },
    };
  });
  if (!documents.size) return { dependencyContext: { ...dependencyContext, callableSkills }, toolExecutor: delegate };
  if ((delegate?.toolDefinitions?.() || []).some((item) => item.name === TOOL_NAME)) {
    throw new TypeError("runtime_skill_document_tool_name_conflict");
  }
  const definition = {
    type: "function", name: TOOL_NAME, strict: true,
    description: "Read reviewed instructions or a reference from a callable Skill's frozen task version. Choose a relevant Skill, read its directory-declared entry documentPath first, then only needed references. This read does not execute a Skill or authorize business Tools. Continue with nextOffset when a page is incomplete.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        skillId: { type: "string", enum: [...documents.keys()] },
        version: { type: "string", description: "Exact version in callableSkills." },
        documentPath: { type: "string", description: "The directory entry documentPath first, then a reference documentPath returned by that read; never a filesystem path or URL." },
        offset: { type: ["integer", "null"], minimum: 0 },
        maxChars: { type: ["integer", "null"], minimum: 1, maximum: MAX_PAGE_CHARS },
      },
      required: ["skillId", "version", "documentPath", "offset", "maxChars"],
    },
  };
  const withDocumentRead = (names) => Array.isArray(names) ? [...new Set([...names, TOOL_NAME])] : names;
  const toolExecutor = {
    ...delegate,
    toolDefinitions: () => [...(delegate?.toolDefinitions?.() || []), definition],
    safeToolCatalog: () => [...(delegate?.safeToolCatalog?.() || []), { name: TOOL_NAME, description: "按需读取本任务可用 Skill 文档" }],
    completionEvidenceCapabilities: () => (delegate?.completionEvidenceCapabilities?.() || []).map((value) => ({
      ...value, allowedToolNames: withDocumentRead(value.allowedToolNames),
    })),
    toolExecutionPolicy: () => {
      const policy = delegate?.toolExecutionPolicy?.() || { toolChoice: "auto" };
      return { ...policy, allowedToolNames: withDocumentRead(policy.allowedToolNames) };
    },
    safeActivityDescriptor: (call, options) => {
      if (call.name !== TOOL_NAME) return delegate?.safeActivityDescriptor?.(call, options);
      const args = call.arguments;
      const skill = documents.get(args?.skillId);
      const document = skill && skill.version === args?.version ? skill.entries.get(args?.documentPath) : null;
      if (!document) return { kind: "tool", subjectId: "declared-tool", actionCode: "tool.execute" };
      const actionCode = Number.isSafeInteger(args.offset) && args.offset > 0
        ? "skill.document.continue"
        : args.documentPath === "SKILL.md" ? "skill.document.instructions"
          : args.documentPath === "skill-details.json" ? "skill.document.metadata"
            : "skill.document.reference";
      return { kind: "tool", subjectId: TOOL_ID, actionCode };
    },
    agentResultFor: (result) => result?.toolId === TOOL_ID ? result : delegate?.agentResultFor?.(result) || result,
    async execute(call = {}, options = {}) {
      if (call.name !== TOOL_NAME) return delegate?.execute?.(call, options);
      if (options.signal?.aborted) throw options.signal.reason || new Error("agent_turn_canceled");
      const args = call.arguments;
      const failure = () => ({ ok: false, status: "blocked", toolId: TOOL_ID, error: "tool_not_allowed" });
      if (!args || typeof args !== "object" || Array.isArray(args) ||
        Object.keys(args).some((key) => !Object.hasOwn(definition.parameters.properties, key))) return failure();
      const skill = documents.get(args.skillId);
      if (!skill || args.version !== skill.version) return failure();
      if (authorizeSkillRead && await authorizeSkillRead({ skillId: args.skillId, version: skill.version }) !== true) return failure();
      if (options.signal?.aborted) throw options.signal.reason || new Error("agent_turn_canceled");
      const document = skill.entries.get(args.documentPath);
      const offset = args.offset ?? 0;
      const maxChars = args.maxChars ?? DEFAULT_PAGE_CHARS;
      if (!document || !Number.isSafeInteger(offset) || offset < 0 || offset > document.content.length ||
        !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_PAGE_CHARS) return failure();
      const end = Math.min(document.content.length, offset + maxChars);
      return {
        ok: true, status: "completed", toolId: TOOL_ID, skillId: args.skillId,
        version: skill.version, documentPath: args.documentPath, contentHash: document.contentHash || "",
        content: document.content.slice(offset, end), offset,
        ...(args.documentPath === "SKILL.md" && offset === 0 ? { skillDetails: structuredClone(skill.details) } : {}),
        totalCharacters: document.content.length, nextOffset: end < document.content.length ? end : null,
        sourceTruncated: document.truncated === true,
      };
    },
  };
  return { dependencyContext: { ...dependencyContext, callableSkills }, toolExecutor };
}

export { prepareSkillDocumentContext, TOOL_NAME as SKILL_DOCUMENT_TOOL_NAME };
