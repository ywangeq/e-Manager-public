import { automationDigest } from "./agent-runtime/personal-automation-contract.mjs";

const TOOL_ID = "personal-automations";
const NAME = "personal_automations";
const ACTIONS = ["create","list","detail","pause","resume","disable"];
const fail = code => ({ok:false,status:"blocked",toolId:TOOL_ID,error:code});

// A Center application-service adapter. The shared Runtime only dispatches this Tool.
export function createPersonalAutomationTool({service,session,task,idempotentEffectService,operationReceiptProjector,now = () => new Date().toISOString()}) {
  if (!service || !session || task?.channelId !== "desktop" || task.taskType !== "digital_employee_chat") return null;
  const scheduled = task.sourceSystemId === "personal-automation";
  if (scheduled && typeof service.authorizeScheduledRun !== "function") return null;
  const actions = scheduled ? ["list","detail","pause","disable"] : ACTIONS;
  const taskId = task.taskId || task.id;
  const authorize = async () => scheduled ? service.authorizeScheduledRun(session,taskId)
    : {task:await service.authorizeConversation(session,taskId)};
  const referenceTime = now();
  return {
    toolDefinitions: () => [{type:"function",name:NAME,strict:false,
      description:scheduled ? "查看、暂停或禁用当前用户的定时安排。根据执行结果自主判断是否还需要后续唤醒；目标已经达到时，可以禁用相关安排。list查看可管理安排，detail读取当前状态和revision；automationId省略时使用本次运行所属安排。暂停和禁用只停止后续唤醒，不取消已开始的任务。" : `管理当前用户的个人定时任务。本轮 Center 参考 UTC 时间：${referenceTime}。相对时间以此为基准，不沿用历史对话日期；expiresAt 必须晚于实际创建时的服务器时间。用户明确要求定时、提醒或周期执行时创建；每轮对话最多创建一个。executionInstruction 只写每次要做的业务工作及授权/停止边界，不包含创建或管理定时任务的指令，不能扩大权限。时间使用带毫秒的 UTC ISO 时间，timezone 为 IANA 时区；先澄清缺少的频率、时区或结束边界。只有成功回执才能声称已安排。修改前 list/detail 取得 revision。禁用不取消已经创建的执行任务。`,
      parameters:{type:"object",additionalProperties:false,required:["action"],properties:{
        action:{type:"string",enum:actions},automationId:{type:"string"},expectedRevision:{type:"integer",minimum:1},
        ...(!scheduled ? {executionInstruction:{type:"string",minLength:1,maxLength:8000},
          intervalSeconds:{type:"integer",minimum:60,maximum:2592000},startAt:{type:"string"},expiresAt:{type:"string"},
          maxRuns:{type:"integer",minimum:1,maximum:1000},timezone:{type:"string"}} : {}),
      }}}],
    safeToolCatalog: () => [{name:NAME,description:scheduled ? "查看或停止当前用户的定时安排" : "创建和管理当前用户的个人定时任务"}],
    safeActivityDescriptor: () => ({kind:"tool",subjectId:TOOL_ID,actionCode:"personal_automation.manage"}),
    runtimeStatus: () => ({toolId:TOOL_ID,status:"ready"}),
    async execute(call,options = {}) {
      if (options.signal?.aborted) return fail("task_canceled");
      if ((options.runtimeTask?.taskId || options.runtimeTask?.id) !== taskId) return fail("personal_automation_execution_context_required");
      const input = call.arguments;
      if (call.name !== NAME || !input || typeof input !== "object" || Array.isArray(input) || !actions.includes(input.action)) return fail("personal_automation_request_invalid");
      const {action,...args} = input;
      const fields = action === "create" ? ["executionInstruction","intervalSeconds","startAt","expiresAt","maxRuns","timezone"]
        : action === "list" ? [] : action === "detail" ? (scheduled ? [] : ["automationId"]) : (scheduled ? ["expectedRevision"] : ["automationId","expectedRevision"]);
      const optionalFields = scheduled && action !== "list" ? ["automationId"] : [];
      if (Object.keys(args).some(k => !fields.includes(k) && !optionalFields.includes(k)) || fields.some(k => args[k] === undefined)) return fail("personal_automation_request_invalid");
      try {
        const authorized = await authorize();
        const current = authorized.task;
        if (scheduled && action !== "list" && args.automationId === undefined) args.automationId = authorized.automationId;
        if (action === "list") return {ok:true,status:"completed",toolId:TOOL_ID,automations:service.list(session).automations,...(scheduled ? {currentAutomationId:authorized.automationId} : {})};
        if (action === "detail") return {ok:true,status:"completed",toolId:TOOL_ID,...service.detail(session,args.automationId)};
        const repositoryContext = options.operationReceiptContext?.repositoryContext;
        if (!idempotentEffectService || !operationReceiptProjector || repositoryContext?.taskId !== taskId || repositoryContext?.tenantScope !== current.tenantScope) return fail("personal_automation_execution_context_required");
        const authorizationDigest = automationDigest([current.tenantScope,current.actorIssuer,current.actorSubjectDigest,TOOL_ID,action,"current_user", "bounded_write"]);
        const request = operationReceiptProjector.project({tenantScope:current.tenantScope,taskId,
          toolCallId:call.callId || call.id,effectKind:"workspace_write",adapterId:TOOL_ID,
          actionCode:`personal_automation.${action}`,targetScope:{actorSubjectDigest:current.actorSubjectDigest,automationId:args.automationId || taskId},
          operation:input,authorizationDigest,recoveryMode:action === "create" ? "remote_idempotency" : "none"});
        const effect = async () => {
          await authorize();
          if (options.signal?.aborted) return {status:"definitive_failed",safeResultCode:"task_canceled",receiptPayload:null};
          try {
            const automation = action === "create" ? await service.createFromConversation(session,taskId,args)
              : await service.change(session,args.automationId,{action,expectedRevision:args.expectedRevision});
            return {status:"succeeded",safeResultCode:"personal_automation_saved",receiptPayload:{automationId:automation.automationId}};
          } catch (error) {
            if (/^personal_automation_[a-z_]+$/.test(error?.code || "")) return {status:"definitive_failed",safeResultCode:error.code,receiptPayload:null};
            throw error;
          }
        };
        const outcome = await idempotentEffectService.execute({request,repositoryContext,effect,
          ...(action === "create" ? {recover:effect} : {}),
          authorizeCurrentOperation:async () => {await authorize();return {status:"allowed",authorizationDigest};}});
        if (outcome.status !== "succeeded") return fail(outcome.status === "definitive_failed" ? outcome.receipt.safeResultCode : "personal_automation_outcome_unconfirmed");
        const {automation} = service.detail(session,outcome.receipt.payload.automationId);
        return {ok:true,status:"completed",toolId:TOOL_ID,operationId:action,automation};
      } catch (error) {
        return fail(/^personal_automation_[a-z_]+$/.test(error?.code || "") ? error.code : "personal_automation_unavailable");
      }
    },
  };
}
