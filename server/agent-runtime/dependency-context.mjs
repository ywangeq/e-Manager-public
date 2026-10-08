import { isDeepStrictEqual } from "node:util";
import { resolveEffectiveSkillScope } from "./skill-scope-resolver.mjs";
import { resolveSkillRuntimeExecutionProfile } from "./skill-runtime-profile.mjs";
import { resolveToolAuthorizationPolicy } from "./tool-authorization-policy.mjs";
import { normalizeSkillToolCompletionPolicies } from "./skill-tool-completion-policy.mjs";

const DEPENDENCY_CONTEXT_CONTRACT = "digital-employee-runtime-dependency-context.v2";
const maxRuntimeInstructionChars = 64 * 1024;
const maxRuntimeReferenceChars = 32 * 1024;
const maxRuntimeReferenceTotalChars = 96 * 1024;
const maxRuntimeReferencesPerSkill = 8;

function assembleDigitalEmployeeDependencyContext({
  businessSkills = [],
  channel = {},
  employee = {},
  getBusinessSkills,
  runtimeTask = null,
  workerBinding = {},
  organizationSkillIds = [],
} = {}) {
  const currentSkills = typeof getBusinessSkills === "function" ? getBusinessSkills({ task: runtimeTask }) : businessSkills;
  const skillById = new Map((currentSkills || []).map((skill) => [cleanId(skill.id), skill]));
  const skillScope = resolveEffectiveSkillScope({ employee, skills: currentSkills, workerBinding, organizationSkillIds });
  const callableSkills = skillScope.callableSkillIds.map((skillId) => safeSkill(skillById.get(skillId), skillId));
  const missingSkillIds = skillScope.blockedSkills
    .filter((skill) => skill.reason === "skill_catalog_entry_missing")
    .map((skill) => skill.skillId);
  const activeCapabilities = uniqueList(callableSkills.flatMap((skill) => skill.capabilities));
  const activeInputs = uniqueList(callableSkills.flatMap((skill) => skill.inputs));
  const activeOutputs = uniqueList(callableSkills.flatMap((skill) => skill.outputs));

  return {
    contractVersion: DEPENDENCY_CONTEXT_CONTRACT,
    employee: {
      id: cleanId(employee.id || workerBinding.employeeId),
      name: cleanText(employee.name || workerBinding.employeeName),
      status: cleanId(employee.status),
      version: cleanId(employee.version),
      businessDomain: cleanId(employee.businessDomain),
      departmentId: cleanId(employee.departmentId),
      ownerDepartmentId: cleanId(employee.ownerDepartmentId),
      ownerUserId: cleanId(employee.ownerUserId),
      permissionScope: cleanList(employee.permissionScope),
      title: cleanText(employee.title),
      objective: cleanText(employee.objective),
      configuredFunctions: safeConfiguredFunctions(employee.configuredFunctions),
      identityBoundaries: cleanList(employee.identityBoundaries).slice(0, 12),
    },
    promptMetadata: {
      promptScope: cleanId(employee.promptScope || employee.promptGovernance?.promptScope),
      promptVersion: cleanId(employee.promptVersion || employee.promptGovernance?.promptVersion),
      promptHash: cleanId(employee.promptHash || employee.promptGovernance?.promptHash),
      promptKeys: cleanList(employee.promptGovernance?.promptKeys || employee.promptKeys),
      rawPromptStored: false,
    },
    channelBinding: {
      channel: cleanId(channel.channel || "feishu"),
      sourceSystemId: cleanId(channel.sourceSystemId),
      status: cleanId(channel.status),
      receiveMode: cleanId(channel.receiveMode),
      applicationId: cleanId(workerBinding.applicationId),
      capabilityRequestId: cleanId(workerBinding.capabilityRequestId),
      selectedSkillIds: skillScope.channelSelectedSkillIds,
      channelIntentIds: cleanList(workerBinding.channelIntentIds),
    },
    assetRegistry: {
      source: "enterpriseSkillCatalog",
      lookupStatus: missingSkillIds.length ? "partial" : skillScope.requestedSkillIds.length ? "resolved" : "no_bound_skill",
      requestedSkillIds: skillScope.requestedSkillIds,
      resolvedSkillIds: skillScope.callableSkillIds,
      missingSkillIds,
    },
    skillScope,
    capabilityScope: {
      source: "effective_skill_scope",
      status: activeCapabilities.length ? "skill_scoped" : "lookup_required",
      activeSkillNames: callableSkills.map((skill) => skill.name).filter(Boolean),
      activeCapabilities: activeCapabilities.slice(0, 12),
      activeInputs: activeInputs.slice(0, 8),
      activeOutputs: activeOutputs.slice(0, 8),
      lookupRequired: !activeCapabilities.length || Boolean(skillScope.blockedSkills.length),
    },
    callableSkills,
    declaredTools: safeTools(employee.toolBindings || employee.tools),
    constraints: cleanList(employee.constraints).slice(0, 12),
    outputContract: cleanText(employee.outputContract || employee.runtimeContract?.outputContract),
    uiDisplayContract: cleanText(employee.uiDisplayContract || employee.runtimeContract?.uiDisplayContract),
    unsupportedActions: cleanList(employee.unsupportedActions).slice(0, 12),
    writebackBoundary: cleanText(employee.writebackBoundary || employee.runtimeContract?.writebackBoundary),
    reviewGate: cleanText(employee.reviewGate),
  };
}

// Persistence accepts only the existing assembled contract, never a raw employee,
// Skill catalog entry or transport credential object supplied alongside it.
function assertDependencyContextStorageBoundary(context) {
  const template = assembleDigitalEmployeeDependencyContext({});
  const exactFields = (value, sample) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), Object.keys(sample).sort())) {
      throw new TypeError("dependency_context_storage_fields_invalid");
    }
  };
  exactFields(context, template);
  for (const field of ["employee", "promptMetadata", "channelBinding", "assetRegistry", "capabilityScope"]) {
    exactFields(context[field], template[field]);
    for (const [name, sample] of Object.entries(template[field])) {
      const value = context[field][name];
      if (field === "employee" && name === "configuredFunctions") {
        if (!isDeepStrictEqual(value, safeConfiguredFunctions(value))) throw new TypeError("dependency_context_storage_functions_invalid");
      } else if (Array.isArray(sample)) {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TypeError("dependency_context_storage_list_invalid");
      } else if (typeof value !== typeof sample) throw new TypeError("dependency_context_storage_value_invalid");
    }
  }
  if (!Array.isArray(context.callableSkills) || context.callableSkills.some(skill => !isDeepStrictEqual(skill, safeSkill(skill, skill.id)))) {
    throw new TypeError("dependency_context_storage_skill_invalid");
  }
  if (!Array.isArray(context.declaredTools)) throw new TypeError("dependency_context_storage_tools_invalid");
  for (const tool of context.declaredTools) {
    const policy = tool.authorizationPolicy;
    const source = { ...tool, ...policy, policyMode: policy?.mode };
    const projected = safeTools([source])[0];
    if (policy?.legacyOperationsIgnored === true && policy.mode === "contract_capability") projected.authorizationPolicy.legacyOperationsIgnored = true;
    if (!isDeepStrictEqual(tool, projected)) throw new TypeError("dependency_context_storage_tool_invalid");
  }
  const scope = context.skillScope;
  const scopeTemplate = template.skillScope;
  const { compatibility, ...scopeFields } = scope || {};
  exactFields(scopeFields, scopeTemplate);
  if (compatibility !== undefined && !isDeepStrictEqual(compatibility, {
    owner: "Channel worker binding migration", removalCondition: "all_worker_bindings_declare_skill_scope_mode",
  })) throw new TypeError("dependency_context_storage_scope_invalid");
  for (const [name, sample] of Object.entries(scopeTemplate)) {
    const value = scopeFields[name];
    if (["runtimeExecutionProfiles", "blockedSkills"].includes(name)) continue;
    if (Array.isArray(sample) ? (!Array.isArray(value) || value.some(item => typeof item !== "string")) : typeof value !== typeof sample) {
      throw new TypeError("dependency_context_storage_scope_invalid");
    }
  }
  if (!Array.isArray(scope.runtimeExecutionProfiles) || scope.runtimeExecutionProfiles.some(({ skillId, ...profile }) =>
    typeof skillId !== "string" || !isDeepStrictEqual(profile, resolveSkillRuntimeExecutionProfile({ runtimeExecutionProfile: profile })))) {
    throw new TypeError("dependency_context_storage_profile_invalid");
  }
  if (!Array.isArray(scope.blockedSkills) || scope.blockedSkills.length) throw new TypeError("dependency_context_storage_blocked");
  for (const name of ["constraints", "unsupportedActions"]) {
    if (!Array.isArray(context[name]) || context[name].some(item => typeof item !== "string")) throw new TypeError("dependency_context_storage_list_invalid");
  }
  for (const name of ["contractVersion", "outputContract", "uiDisplayContract", "writebackBoundary", "reviewGate"]) {
    if (typeof context[name] !== "string") throw new TypeError("dependency_context_storage_value_invalid");
  }
}

function safeSkill(skill = {}, fallbackId = "") {
  const resolved = Boolean(skill?.id);
  return {
    id: cleanId(skill?.id || fallbackId),
    name: cleanText(skill?.name || fallbackId),
    version: cleanId(skill?.version),
    status: cleanId(skill?.status),
    runtimeEligibility: {
      allowed: skill?.runtimeEligibility?.allowed === true,
      reason: cleanId(skill?.runtimeEligibility?.reason),
    },
    runtimeExecutionProfile: resolveSkillRuntimeExecutionProfile(skill),
    description: cleanText(skill?.description),
    activationPolicy: cleanId(skill?.activationPolicy || "agent_discretion"),
    deliveryPolicy: cleanText(skill?.deliveryPolicy),
    domain: cleanId(skill?.domain || skill?.businessDomain),
    risk: cleanId(skill?.risk),
    reviewGate: cleanText(skill?.reviewGate),
    capabilities: cleanList(skill?.capabilities).slice(0, 6),
    inputs: cleanList(skill?.inputs).slice(0, 5),
    outputs: cleanList(skill?.outputs).slice(0, 5),
    constraints: cleanList(skill?.constraints).slice(0, 6),
    executionGuidance: cleanList(skill?.executionGuidance).slice(0, 12),
    runtimeInstructions: safeRuntimeInstructions(skill?.runtimeInstructions),
    runtimeReferences: safeRuntimeReferences(skill?.runtimeReferences),
    toolCompletionPolicies: normalizeSkillToolCompletionPolicies(
      skill?.skillPackageIdentity?.toolCompletionPolicies || skill?.toolCompletionPolicies,
    ),
    promptKeys: cleanList(skill?.promptGovernance?.promptKeys || skill?.promptKeys).slice(0, 8),
    resolutionStatus: resolved ? "resolved" : "missing",
  };
}

function safeTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 20).map((tool) => ({
    id: cleanId(tool?.id || tool?.toolId),
    name: cleanText(tool?.name),
    enabled: tool?.enabled !== false,
    permissionScope: cleanList(tool?.permissionScope).slice(0, 8),
    writebackBoundary: cleanText(tool?.writebackBoundary),
    authorizationPolicy: resolveToolAuthorizationPolicy(tool),
  })).filter((tool) => tool.id);
}

function safeConfiguredFunctions(functions = []) {
  if (!Array.isArray(functions)) return [];
  return functions.slice(0, 20).map((item) => ({
    id: cleanId(item?.id || item?.functionId || item?.name),
    name: cleanText(item?.name),
    description: cleanText(item?.description),
  })).filter((item) => item.id && item.name);
}

function safeRuntimeInstructions(value = null) {
  if (!value || typeof value !== "object" || value.contractVersion !== "skill-runtime-instructions.v1") return null;
  const cleaned = cleanInstructionText(value.content);
  const content = cleaned.slice(0, maxRuntimeInstructionChars);
  if (!content) return null;
  return {
    contractVersion: value.contractVersion,
    source: cleanText(value.source),
    content,
    contentHash: cleanId(value.contentHash),
    sourceHash: cleanId(value.sourceHash),
    sectionHeadings: cleanList(value.sectionHeadings).slice(0, 16),
    truncated: value.truncated === true || cleaned.length > maxRuntimeInstructionChars,
  };
}

function safeRuntimeReferences(value = []) {
  if (!Array.isArray(value)) return [];
  let remainingChars = maxRuntimeReferenceTotalChars;
  const references = [];
  for (const reference of value.slice(0, maxRuntimeReferencesPerSkill)) {
    if (!reference || typeof reference !== "object" || reference.contractVersion !== "skill-runtime-reference.v1") continue;
    if (remainingChars <= 0) break;
    const cleaned = cleanInstructionText(reference.content);
    const content = cleaned.slice(0, Math.min(maxRuntimeReferenceChars, remainingChars));
    if (!content) continue;
    remainingChars -= content.length;
    references.push({
      contractVersion: reference.contractVersion,
      source: cleanText(reference.source),
      path: cleanId(reference.path),
      content,
      contentHash: cleanId(reference.contentHash),
      sourceHash: cleanId(reference.sourceHash),
      sectionHeadings: cleanList(reference.sectionHeadings).slice(0, 16),
      truncated: reference.truncated === true || cleaned.length > content.length,
    });
  }
  return references;
}

function cleanInstructionText(value = "") {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !/(api[-_ ]?key|secret|password|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer|jwt|oauth[_ -]?state|authorization code)\s*[:=]\s*\S+/i.test(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanList(values = []) {
  const source = Array.isArray(values) ? values : values ? [values] : [];
  return source.map(cleanText).filter(Boolean);
}

function uniqueList(values = []) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 160);
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export { DEPENDENCY_CONTEXT_CONTRACT, assembleDigitalEmployeeDependencyContext, assertDependencyContextStorageBoundary, safeSkill as projectSkillDependency };
