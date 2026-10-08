import { createFxiaokeCrmReadonlyToolAdapter } from "./fxiaoke-crm-tool-adapter.mjs";

const FXIAOKE_CRM_TOOL_ID = "fxiaoke-crm-readonly";
const FXIAOKE_CRM_TOOL_NAMES = Object.freeze({
  get_sale_contract_by_number: "fxiaoke_crm__getSaleContractByNumber",
  get_contract_approval_process_by_contract_ref: "fxiaoke_crm__getContractApprovalProcess",
  describe_current_object: "fxiaoke_crm__describeCurrentObject",
  read_current_object: "fxiaoke_crm__readCurrentObject",
  prepare_current_object_material: "fxiaoke_crm__prepareCurrentObjectMaterial",
});
const FXIAOKE_CRM_OPERATIONS = Object.freeze([
  Object.freeze({
    toolId: FXIAOKE_CRM_TOOL_ID,
    operationId: "get_sale_contract_by_number",
    action: "get_sale_contract_by_number",
    risk: "read_only",
    scope: Object.freeze(["sales_contract:read"]),
    writebackBoundary: "none",
    confirmationPolicy: "not_required",
  }),
  Object.freeze({
    toolId: FXIAOKE_CRM_TOOL_ID,
    operationId: "get_contract_approval_process_by_contract_ref",
    action: "get_contract_approval_process_by_contract_ref",
    risk: "read_only",
    scope: Object.freeze(["sales_contract_approval_process:read"]),
    writebackBoundary: "none",
    confirmationPolicy: "not_required",
  }),
  Object.freeze({
    toolId: FXIAOKE_CRM_TOOL_ID,
    operationId: "describe_current_object",
    action: "describe_current_object",
    risk: "read_only",
    scope: Object.freeze(["current_subject:schema:read"]),
    writebackBoundary: "none",
    confirmationPolicy: "not_required",
  }),
  Object.freeze({
    toolId: FXIAOKE_CRM_TOOL_ID,
    operationId: "read_current_object",
    action: "read_current_object",
    risk: "read_only",
    scope: Object.freeze(["current_subject:record:read"]),
    writebackBoundary: "none",
    confirmationPolicy: "not_required",
  }),
  Object.freeze({
    toolId: FXIAOKE_CRM_TOOL_ID,
    operationId: "prepare_current_object_material",
    action: "prepare_current_object_material",
    risk: "read_only",
    scope: Object.freeze(["current_subject:material:prepare"]),
    writebackBoundary: "ephemeral_task_workspace_only",
    confirmationPolicy: "not_required",
  }),
]);

function createFxiaokeCrmReadonlyToolExecutor({
  accessCheck = null,
  accessContext = {},
  authorizeToolCall = null,
  baseUrl = "https://open.fxiaoke.com",
  credentialConfigured = false,
  credentialProvider = null,
  employee = {},
  fetchImpl = globalThis.fetch,
  observeSubjectRecord = null,
  requestTimeoutMs = 10_000,
  serviceClient = null,
  subjectScope = null,
  prepareSubjectMaterial = null,
} = {}) {
  if (observeSubjectRecord !== null && typeof observeSubjectRecord !== "function") {
    throw new TypeError("Fxiaoke CRM subject observer must be a function");
  }
  const binding = fxiaokeCrmBinding(employee);
  if (!binding) return unavailableExecutor("tool_not_bound", "当前数字员工未绑定纷享销客只读 CRM Tool。");
  const accessDecision = typeof accessCheck === "function" ? accessCheck(accessContext) : null;
  if (accessDecision?.status !== "allowed" || !cleanText(accessContext.taskId, 240)) {
    return unavailableExecutor("crm_scope_not_authorized", "当前 actor、CRM 数据域或任务未获得该只读 capability 授权。");
  }
  const subject = normalizeSubjectScope(subjectScope);
  const allowedOperationIds = grantedOperationIds(binding);
  if (subject) {
    allowedOperationIds.add("describe_current_object");
    allowedOperationIds.add("read_current_object");
    if (typeof prepareSubjectMaterial === "function") {
      allowedOperationIds.add("prepare_current_object_material");
    }
  }
  const operations = FXIAOKE_CRM_OPERATIONS.filter((operation) => allowedOperationIds.has(operation.operationId));
  if (!operations.length || cleanId(binding.writebackBoundary) !== "none") {
    return unavailableExecutor("crm_scope_not_authorized", "纷享销客只读 CRM Tool 尚未获得明确的 operation 与零写回授权。");
  }
  const adapter = createFxiaokeCrmReadonlyToolAdapter({
    baseUrl,
    credentialConfigured,
    credentialProvider: () => credentialProvider?.(accessContext),
    fetchImpl,
    requestTimeoutMs,
    serviceClient,
  });
  const operationByName = new Map(operations.map((operation) => [FXIAOKE_CRM_TOOL_NAMES[operation.action], operation]));
  let authorizedContractNumber = "";
  let authorizedContractRef = "";
  let preparedInputId = "";

  async function execute({ name = "", arguments: input = {} } = {}, { signal = null } = {}) {
    const operation = operationByName.get(name);
    if (!operation) return failure("crm_action_not_allowed", "该 CRM 动作不在当前员工的只读授权边界内。");
    if (["describe_current_object", "read_current_object", "prepare_current_object_material"].includes(operation.action)) {
      if (!subject || Object.keys(input || {}).length) {
        return failure("crm_scope_not_authorized", "当前对象 Tool 只能读取任务冻结的 subject，不能接受调用方提供的对象参数。");
      }
      input = operation.action === "describe_current_object"
        ? { objectApiName: subject.objectApiName }
        : operation.action === "read_current_object"
          ? { objectApiName: subject.objectApiName, objectId: subject.objectId }
          : {};
    }
    if (operation.action === "get_sale_contract_by_number" && authorizedContractNumber && cleanText(input?.contractNumber, 200) !== authorizedContractNumber) {
      return failure("crm_scope_not_authorized", "一个任务只允许精确读取一份销售合同；请为另一份合同创建独立任务。");
    }
    if (operation.action === "get_contract_approval_process_by_contract_ref" && cleanText(input?.contractRef, 200) !== authorizedContractRef) {
      return failure("crm_scope_not_authorized", "请先在同一任务中按合同编号精确查询合同，再读取该合同的审批流程。");
    }
    const governedCall = {
      name,
      arguments: input,
      toolId: FXIAOKE_CRM_TOOL_ID,
      operationId: operation.operationId,
      action: operation.action,
      risk: operation.risk,
      scope: [...operation.scope],
      writebackBoundary: operation.writebackBoundary,
    };
    if (typeof authorizeToolCall !== "function") {
      return failure("crm_scope_not_authorized", "CRM Tool 缺少当前员工和任务的结构化调用门禁。");
    }
    const decision = await authorizeToolCall(governedCall, operation, operations);
    if (decision?.status !== "allowed") {
      return failure("crm_scope_not_authorized", decision?.nextGate || "该 CRM 调用未通过结构化授权门禁。");
    }
    if (operation.action === "prepare_current_object_material") {
      let prepared;
      try {
        prepared = await prepareSubjectMaterial({ signal, subject });
      } catch (error) {
        return failure(safePreparationError(error), "当前 CRM subject 材料准备失败；未执行写回。");
      }
      if (!prepared || prepared.status !== "completed" || !cleanText(prepared.inputId, 240)) {
        return failure("crm_subject_material_preparation_failed", "当前 CRM subject 未生成可分析材料；未执行写回。");
      }
      preparedInputId = cleanText(prepared.inputId, 240);
      return {
        ok: true,
        status: "completed",
        toolId: FXIAOKE_CRM_TOOL_ID,
        operationId: operation.operationId,
        inputId: preparedInputId,
        fileCount: Number.isInteger(prepared.fileCount) ? prepared.fileCount : 0,
        summary: "当前 CRM subject 材料已准备到本任务受控 workspace。",
      };
    }
    const result = await adapter.execute({ action: operation.action, arguments: input, signal });
    if (result.ok && operation.action === "read_current_object" && observeSubjectRecord) {
      await observeSubjectRecord(Object.freeze({ record: result.record, subject }));
    }
    if (result.ok && operation.action === "get_sale_contract_by_number") {
      const contractRef = cleanText(result.contract?.contractRef, 200);
      if (contractRef) {
        authorizedContractNumber = cleanText(input?.contractNumber, 200);
        authorizedContractRef = contractRef;
      }
    }
    return { ...result, toolId: FXIAOKE_CRM_TOOL_ID, operationId: operation.operationId };
  }

  function toolDefinitions() {
    return operations.map((operation) => operationDefinition(operation));
  }

  return {
    agentResultFor: (result) => result,
    availableAgentContent: () => [],
    availableInputIds: () => preparedInputId ? [preparedInputId] : [],
    execute,
    materialCapabilities: () => subject && typeof prepareSubjectMaterial === "function" &&
      operations.some((operation) => operation.operationId === "prepare_current_object_material")
      ? [{ kind: "task_workspace_material", toolName: FXIAOKE_CRM_TOOL_NAMES.prepare_current_object_material }]
      : [],
    operations: () => operations.map((operation) => ({ ...operation, scope: [...operation.scope] })),
    runtimeStatus: () => ({
      toolId: FXIAOKE_CRM_TOOL_ID,
      status: adapter.runtimeStatus().status,
      executionMode: "on_demand_readonly",
      fieldSet: subject ? "task-subject-dynamic-schema.v1" : "fxiaoke-sale-contract-read-fields.v1",
      scheduleMode: "disabled",
      writeback: "none",
    }),
    safeToolCatalog: () => toolDefinitions().map(({ name, description }) => ({ name, description })),
    toolDefinitions,
  };
}

function fxiaokeCrmToolInvocationCheck({ employee = {}, operation = null, toolCall = {} } = {}) {
  const binding = fxiaokeCrmBinding(employee);
  const expectedName = FXIAOKE_CRM_TOOL_NAMES[operation?.operationId];
  const argumentsValue = toolCall?.arguments;
  if (!binding || operation?.toolId !== FXIAOKE_CRM_TOOL_ID || !expectedName || toolCall?.name !== expectedName) {
    return blocked("当前数字员工未绑定该纷享销客 CRM operation。");
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return blocked("CRM Tool 参数不符合结构化调用合同。");
  }
  if (!grantedOperationIds(binding).has(operation.operationId) || cleanId(binding.writebackBoundary) !== "none") {
    return blocked("该 CRM operation 未进入当前员工的零写回授权边界。");
  }
  if (toolCall.toolId !== FXIAOKE_CRM_TOOL_ID || toolCall.operationId !== operation.operationId ||
    toolCall.action !== operation.action || toolCall.risk !== "read_only" ||
    toolCall.writebackBoundary !== "none" || !sameStringList(toolCall.scope, operation.scope)) {
    return blocked("CRM Tool 调用与已审核的 action、scope、risk 或写回边界不一致。");
  }
  return {
    status: "allowed",
    reason: "fxiaoke_crm_readonly_operation_allowed",
    nextGate: "已通过员工 Tool binding 与只读 operation 门禁；纷享销客只读身份仍执行最终数据授权。",
  };
}

function fxiaokeCrmBinding(employee = {}) {
  return (Array.isArray(employee.toolBindings) ? employee.toolBindings : employee.tools || [])
    .find((binding) => cleanId(binding?.toolId || binding?.id) === FXIAOKE_CRM_TOOL_ID && binding?.enabled !== false) || null;
}

function grantedOperationIds(binding = {}) {
  const values = Array.isArray(binding.allowedOperations) ? binding.allowedOperations : binding.operationIds;
  return new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean));
}

function operationDefinition(operation) {
  if (["describe_current_object", "read_current_object", "prepare_current_object_material"].includes(operation.operationId)) {
    return {
      type: "function",
      name: FXIAOKE_CRM_TOOL_NAMES[operation.operationId],
      description: operation.operationId === "describe_current_object"
        ? "读取本任务已冻结 CRM subject 的对象描述，用于按真实 schema 理解字段；不接受对象名参数，不能浏览其他对象。"
        : operation.operationId === "read_current_object"
          ? "按本任务已冻结的 objectApiName + objectId 精确读取当前 CRM 记录的全部可读字段；不接受对象参数，不进行列表或模糊查询。"
          : "把本任务已冻结 CRM subject 的安全文本和可读取附件准备到本任务 workspace，供通用材料 Tool 和已挂载 Skill 按需分析；不接受对象、字段、路径或 URL 参数。",
      strict: true,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
  }
  if (operation.operationId === "get_sale_contract_by_number") {
    return {
      type: "function",
      name: FXIAOKE_CRM_TOOL_NAMES[operation.operationId],
      description: "按用户明确提供的销售合同编号精确查询一份合同的最小安全字段；不允许列表浏览或模糊搜索。",
      strict: true,
      parameters: {
        type: "object",
        properties: { contractNumber: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["contractNumber"],
        additionalProperties: false,
      },
    };
  }
  return {
    type: "function",
    name: FXIAOKE_CRM_TOOL_NAMES[operation.operationId],
    description: "读取本任务前一步已精确授权合同的审批流程最小安全字段；不能接受任意 CRM 对象引用。",
    strict: true,
    parameters: {
      type: "object",
      properties: { contractRef: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["contractRef"],
      additionalProperties: false,
    },
  };
}

function safePreparationError(error) {
  const code = String(error?.code || "");
  return /^(?:crm_|trigger_)[a-z0-9_]{1,110}$/.test(code)
    ? code
    : "crm_subject_material_preparation_failed";
}

function normalizeSubjectScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const objectApiName = cleanReference(value.objectApiName);
  const objectId = cleanReference(value.objectId);
  return objectApiName && objectId ? Object.freeze({ objectApiName, objectId }) : null;
}

function cleanReference(value) {
  const text = cleanText(value, 240);
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(text) ? text : "";
}

function readFxiaokeCrmCredentials(environment = process.env) {
  return {
    appId: environment.FXIAOKE_CRM_APP_ID,
    appSecret: environment.FXIAOKE_CRM_APP_SECRET,
    permanentCode: environment.FXIAOKE_CRM_PERMANENT_CODE,
    userId: environment.FXIAOKE_CRM_USER_ID,
    revision: environment.FXIAOKE_CRM_CREDENTIAL_REVISION,
  };
}

function fxiaokeCrmCredentialsConfigured(environment = process.env) {
  return [
    environment.FXIAOKE_CRM_APP_ID,
    environment.FXIAOKE_CRM_APP_SECRET,
    environment.FXIAOKE_CRM_PERMANENT_CODE,
    environment.FXIAOKE_CRM_USER_ID,
    environment.FXIAOKE_CRM_CREDENTIAL_REVISION,
  ].every((value) => Boolean(cleanText(value, 8 * 1024)));
}

function fxiaokeCrmActorAccessCheck(context = {}, environment = process.env, { credentialConfigured = fxiaokeCrmCredentialsConfigured(environment) } = {}) {
  const actorId = cleanText(context.actorId, 240);
  const actorIssuer = cleanText(context.actorIssuer, 240);
  const departmentId = cleanText(context.departmentId, 240);
  const taskId = cleanText(context.taskId, 240);
  if (!actorId || !actorIssuer || !taskId || !credentialConfigured) {
    return { status: "blocked", reason: "crm_actor_or_credential_not_configured" };
  }
  const actorRefs = configuredSet(environment.FXIAOKE_CRM_ALLOWED_ACTOR_REFS);
  const departmentIds = configuredSet(environment.FXIAOKE_CRM_ALLOWED_DEPARTMENT_IDS);
  const actorAllowed = actorRefs.has(`${actorIssuer}:${actorId}`);
  const departmentAllowed = departmentId && departmentIds.has(departmentId);
  return actorAllowed || departmentAllowed
    ? { status: "allowed", reason: actorAllowed ? "crm_actor_allowed" : "crm_department_allowed" }
    : { status: "blocked", reason: "crm_actor_domain_not_allowed" };
}

function unavailableExecutor(reason, message) {
  return {
    agentResultFor: (result) => result,
    availableAgentContent: () => [],
    execute: async () => failure(reason, message),
    operations: () => [],
    runtimeStatus: () => ({ toolId: FXIAOKE_CRM_TOOL_ID, status: "unavailable", reason, message }),
    safeToolCatalog: () => [],
    toolDefinitions: () => [],
  };
}

function failure(errorCode, message) {
  return { ok: false, status: "blocked", toolId: FXIAOKE_CRM_TOOL_ID, errorCode, message };
}

function blocked(nextGate) {
  return { status: "blocked", reason: "tool_invocation_not_allowed", nextGate };
}

function sameStringList(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function cleanId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value = "", maximum = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maximum);
}

function configuredSet(value = "") {
  return new Set(String(value || "").split(",").map((item) => cleanText(item, 480)).filter(Boolean));
}

export {
  FXIAOKE_CRM_OPERATIONS,
  FXIAOKE_CRM_TOOL_ID,
  FXIAOKE_CRM_TOOL_NAMES,
  createFxiaokeCrmReadonlyToolExecutor,
  fxiaokeCrmActorAccessCheck,
  fxiaokeCrmCredentialsConfigured,
  fxiaokeCrmToolInvocationCheck,
  readFxiaokeCrmCredentials,
};
