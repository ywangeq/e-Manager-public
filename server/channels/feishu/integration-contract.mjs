export const CONTRACT_VERSION = "feishu-algorithm-access.v1";
export const SOURCE_SYSTEM_ID = "feishu-digital-employee-entry";
export const SOURCE_SYSTEM_NAME = "飞书数字员工助手";
// Legacy entry is inert: only real, governed employee-scoped routes are usable.
export const EMPLOYEE_ID = "unconfigured";
export const ROOT_SKILL_ID = "";
export const BUSINESS_DOMAIN = "";
export const DEPARTMENT_ID = "";
export const SAFE_SUMMARY = "按数字员工配置渠道并完成授权和消息联调。";
export const DEFAULT_CAPABILITIES = [];
export const FORBIDDEN_MESSAGE_FIELDS = [
  "raw prompt",
  "provider key",
  "API key",
  "token",
  "ticket",
  "cookie",
  "模型 trace",
  "完整执行 payload",
  "客户原始数据",
  "员工 PII",
];
export const HIGH_RISK_ACTIONS = [
  "auto_publish",
  "auto_delete_data",
  "auto_customer_commitment",
  "auto_remote_write",
  "raw_dataset_export",
];
export const POST_APPROVAL_CHANNEL_ACTIONS = [
  "添加指定飞书群",
  "配置群白名单",
  "确认群内可用范围",
  "设置群内状态标记策略",
];
export const CHANNEL_INTENT_OPTIONS = [
  {
    id: "personal_chat",
    label: "本人/单聊试用",
    value: "本人或单聊试用",
    description: "先验证个人申请、消息摘要和平台门禁，不开放群白名单。",
  },
  {
    id: "ops_group_smoke",
    label: "群内运维测试",
    value: "群内运维测试",
    description: "可随申请填写希望开通的飞书群；真实白名单和状态标记策略由管理员审批后配置。",
    requiresAdminForWebhook: true,
  },
];
export const MESSAGE_DELIVERY_OPTIONS = [
  {
    id: "dry_run",
    label: "dry-run 校验",
    description: "只校验飞书消息安全摘要，不真实发送，也不调用员工 Runtime。",
    adminOnly: false,
  },
  {
    id: "webhook",
    label: "运维群 webhook 冒烟",
    description: "使用服务端配置的群机器人 webhook 发送一条安全摘要消息。",
    adminOnly: true,
  },
];
export const CONVERSATION_GATEWAY_BOUNDARY = {
  status: "待接入事件网关",
  receiveMode: "Feishu app bot event subscription / message callback",
  currentMvp: "权限申请、消息 dry-run 和可选群 webhook 冒烟",
  note: "群自定义 webhook 只能做推送冒烟；用户提问、机器人接收并显示状态标记需要正式事件订阅网关。",
};
export const FEISHU_TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
export const FEISHU_REPLY_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
export const FEISHU_MESSAGE_REACTION_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
export const FEISHU_EVENT_CALLBACK_PATH = `/api/feishu/events/${EMPLOYEE_ID}`;
export const LEGACY_FEISHU_EVENT_CALLBACK_PATH = "/api/feishu/events/algorithm-worker";
export const DEFAULT_CONNECTION_MODE = "websocket";
export const CONNECTION_MODE_OPTIONS = [
  {
    id: "websocket",
    label: "飞书机器人长连接（推荐）",
    description: "按飞书机器人长连接方式接收事件，只需要 App ID 和 App Secret；在飞书开放平台事件订阅选择使用长连接接收事件。",
  },
  {
    id: "webhook",
    label: "HTTPS 回调（高级）",
    description: "使用本系统公网 HTTPS 地址接收飞书事件，需要 Verification Token，可选 Encrypt Key。",
  },
];
export const CONNECTION_REQUIRED_FIELDS = [
  "飞书 App ID",
  "飞书 App Secret",
  "事件接收方式：使用长连接接收事件",
  "订阅 im.message.receive_v1",
  "订阅 card.action.trigger（回答质量反馈）",
  "开通 im:message.group_msg，用于精确白名单群内先发材料、再 @机器人下指令",
  "开通 im:message:readonly，用于受控下载飞书附件（100 MB 以内）",
  "开通消息表情回复/状态标记权限 im:message.reactions:write_only（或 im:message）",
  "开通范围/群白名单",
];
export const CONNECTION_AUTOMATION_STEPS = [
  "服务端保存加密凭证",
  "自动换取并校验 tenant_access_token",
  "按连接方式生成长连接或 HTTPS 回调下一步",
  "确认飞书事件订阅已启用 im.message.receive_v1 和 card.action.trigger",
  "受控临时下载飞书附件，不写入任务记录、不自动解压或执行",
  "收到消息事件后在原消息下方挂员工状态标记",
];
export const RUNTIME_TASK_CONTRACT_VERSION = "digital-employee-runtime-task.v2";
export const DEFAULT_RUNTIME_TASK_STATUS = "queued";
export const DEFAULT_RESOURCE_MONITOR_STATUS = "not_configured";
export const ALGORITHM_RUNTIME_RESOURCE_DEFS = [
  {
    id: "algorithm-remote-pool",
    name: "算法 remote/集群执行池",
    kind: "remote_cluster",
    status: DEFAULT_RESOURCE_MONITOR_STATUS,
    boundary: "登记可管理 remote、GPU/CPU、工作目录、conda/env、SDK checkout 和删除权限摘要；不保存 SSH 密码或远程日志。",
    nextGate: "研发负责人确认可管理机器、工作目录、环境复用策略、GPU 并发和清理权限。",
  },
  {
    id: "algorithm-object-storage",
    name: "算法文件包/对象存储 intake",
    kind: "object_storage",
    status: DEFAULT_RESOURCE_MONITOR_STATUS,
    boundary: "飞书文件只进入安全下载、扫描、对象存储和 evidenceRef 流程；平台不长期保存原始文件。",
    nextGate: "配置文件下载、对象存储、解压扫描、大小限制、保留策略和数据 owner 确认。",
  },
  {
    id: "algorithm-runner",
    name: "算法 SDK/任务运行器",
    kind: "algorithm_runner",
    status: DEFAULT_RESOURCE_MONITOR_STATUS,
    boundary: "运行器负责 SDK/DVC/可视化证据，输出结构化安全摘要；平台不保存完整执行 payload。",
    nextGate: "接入受控 runner，执行前通过 invocation check 并注入 digital-employee runtime dependency context。",
  },
];
export const MATERIAL_MESSAGE_TYPES = ["file", "folder", "image", "media", "audio", "post"];
