import { Check, ChevronDown, ExternalLink, Loader2, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";
import { employeeChannels, feishuApplicationEnabled, feishuChannelConfigured } from "../../lib/digitalEmployeeOverview";
import { SkillChips } from "../ConsolePrimitives";

function uniqueOptions(items = []) {
  return items.filter(Boolean).filter((item, index, source) => source.indexOf(item) === index);
}

function scopeOptions(currentValue) {
  return uniqueOptions([currentValue, "仅自己", "所属部门", "治理管理员", "授权跨部门"]);
}

function scopeValue(employee = {}, permissionLabel = "") {
  if (employee.permissionScope === "departmentOnly") return "所属部门";
  if (employee.permissionScope === "platformGovernance") return "治理管理员";
  if (employee.permissionScope === "crossDepartment") return "授权跨部门";
  return permissionLabel || employee.permissionSummary || "待配置";
}

function buildChannelProfiles(employee = {}, channels = []) {
  const canRequestFeishu = feishuApplicationEnabled(employee);
  const hasFeishu = canRequestFeishu && feishuChannelConfigured(employee);
  const hasApi = channels.includes("API") || employee.channelConfig?.api?.status === "configured" || employee.channelConfig?.api?.enabled === true;
  const hasControl = channels.includes("控制面");
  const hasConsole = channels.includes("管理台");

  return [
    {
      id: "feishu",
      label: "飞书",
      title: "飞书渠道配置",
      detail: "机器人、单聊和群聊入口",
      status: !canRequestFeishu ? "不可申请" : hasFeishu ? "已接入" : "待配置",
      active: hasFeishu,
      openLabel: "飞书渠道配置",
    },
    {
      id: "control",
      label: "控制面",
      title: "控制面渠道配置",
      detail: "平台治理与审查入口",
      status: hasControl ? "已接入" : "可配置",
      active: hasControl,
      openLabel: "开放平台配置",
    },
    {
      id: "console",
      label: "管理台",
      title: "管理台渠道配置",
      detail: "查看、配置和治理入口",
      status: hasConsole ? "已接入" : "可配置",
      active: hasConsole,
      openLabel: "管理入口配置",
    },
    {
      id: "api",
      label: "API",
      title: "API 渠道配置",
      detail: "业务系统受控调用入口",
      status: hasApi ? "已接入" : "待申请",
      active: hasApi,
      openLabel: "API 契约配置",
    },
  ];
}

function buildProfileSettings(profileId, employee = {}, permissionLabel = "", isBusinessEmployee = false) {
  const ownerLabel = employee.owner || "负责人";
  const scopedValue = scopeValue(employee, permissionLabel);
  const channels = employeeChannels(employee);
  const hasApiChannel = channels.includes("API") || employee.channelConfig?.api?.status === "configured" || employee.channelConfig?.api?.enabled === true;
  const apiCallerValue = hasApiChannel
    ? "API Channel 已接入"
    : employee.apiEndpoints?.length
      ? "仅有 API 文档"
      : "待提交申请";

  if (profileId === "api") {
    return [
      { key: "callScope", label: "可调用范围", value: scopedValue, options: scopeOptions(scopedValue), navigable: true },
      { key: "caller", label: "调用来源", value: apiCallerValue, options: uniqueOptions([apiCallerValue, "API Channel 已接入", "仅有 API 文档", "待提交申请", "仅控制面"]), navigable: true },
      { key: "userIdentity", label: "以用户的身份操作", value: isBusinessEmployee ? `经 ${ownerLabel} 授权` : "仅平台服务身份", source: "permissionScope", gate: "RBAC", detail: "决定调用时沿用用户权限还是仅使用平台服务身份。", checked: Boolean(isBusinessEmployee), kind: "switch" },
      { key: "writeback", label: "写回边界", value: employee.writebackBoundary || "safe summary only", options: uniqueOptions([employee.writebackBoundary || "safe summary only", "safe summary only", "人审后写回", "禁止写回"]), navigable: true },
      { key: "streaming", label: "开启流式输出", value: employee.status === "在线" ? "已开启" : "试运行后开启", source: "status", gate: "runtime ready", detail: "控制调用响应是否允许流式返回。", checked: employee.status === "在线", kind: "switch" },
      { key: "replyPolicy", label: "调用回复策略", value: "调用门禁后回复", options: ["调用门禁后回复", "仅返回状态", "人审后回复"], navigable: true },
    ];
  }

  if (profileId === "control") {
    return [
      { key: "governanceScope", label: "治理可用范围", value: scopedValue, options: scopeOptions(scopedValue), navigable: true },
      { key: "reviewTarget", label: "允许审查对象", value: employee.level === "系统级" ? "系统级员工" : "业务级员工", options: ["系统级员工", "业务级员工", "全部治理对象"], navigable: true },
      { key: "governanceIdentity", label: "以用户的身份操作", value: "仅平台治理身份", source: "RBAC", gate: "admin review", detail: "控制面动作不继承普通业务身份。", checked: false, kind: "switch" },
      { key: "controlScope", label: "控制面可用范围", value: employee.ownerDepartmentId || employee.departmentId || "待配置", options: uniqueOptions([employee.ownerDepartmentId, employee.departmentId, "digital-office", "待配置"]), navigable: true },
      { key: "streaming", label: "开启流式输出", value: employee.status === "在线" ? "已开启" : "试运行后开启", source: "status", gate: "runtime ready", detail: "控制治理助手回复是否允许流式返回。", checked: employee.status === "在线", kind: "switch" },
      { key: "controlReply", label: "控制面回复策略", value: "治理动作需审批", options: ["治理动作需审批", "仅生成草案", "阻断后提示"], navigable: true },
    ];
  }

  if (profileId === "console") {
    return [
      { key: "singleScope", label: "单人可用范围", value: scopedValue, options: scopeOptions(scopedValue), navigable: true },
      { key: "views", label: "允许进入的视图", value: "智能体详情 / 配置工作台", options: ["智能体详情 / 配置工作台", "仅详情", "仅治理后台"], navigable: true },
      { key: "userIdentity", label: "以用户的身份操作", value: isBusinessEmployee ? `经 ${ownerLabel} 授权` : "仅平台治理身份", source: "permissionScope", gate: "RBAC", detail: "管理台动作是否沿用当前用户权限边界。", checked: Boolean(isBusinessEmployee), kind: "switch" },
      { key: "departmentScope", label: "部门可用范围", value: employee.department || "待配置", options: uniqueOptions([employee.department, "所属部门", "数字化管理办公室", "待配置"]), navigable: true },
      { key: "streaming", label: "开启流式输出", value: employee.status === "在线" ? "已开启" : "试运行后开启", source: "status", gate: "runtime ready", detail: "控制管理台对话响应是否允许流式返回。", checked: employee.status === "在线", kind: "switch" },
      { key: "consoleReply", label: "管理台回复策略", value: "管理台内回复", options: ["管理台内回复", "侧边栏回复", "仅记录草案"], navigable: true },
    ];
  }

  return [
    { key: "singleScope", label: "单聊可用范围", value: scopedValue, options: scopeOptions(scopedValue), navigable: true },
    { key: "groupAllowlist", label: "允许回复的群", value: employee.channelGroups?.join(" / ") || "未开放群聊", options: uniqueOptions([employee.channelGroups?.join(" / ") || "未开放群聊", "所有群组", "指定群组", "未开放群聊"]), navigable: true },
    { key: "userIdentity", label: "以用户的身份操作", value: isBusinessEmployee ? `经 ${ownerLabel} 授权` : "仅平台治理身份", source: "permissionScope", gate: "RBAC", detail: "决定飞书入口是否沿用发起人的权限边界。", checked: Boolean(isBusinessEmployee), kind: "switch" },
    { key: "groupScope", label: "群内可用范围", value: employee.channelGroupScope || "仅自己", options: uniqueOptions([employee.channelGroupScope || "仅自己", "仅自己", "群内成员", "所属部门"]), navigable: true },
    { key: "streaming", label: "开启流式输出", value: employee.status === "在线" ? "已开启" : "试运行后开启", source: "status", gate: "runtime ready", detail: "控制消息渠道是否允许逐步输出。", checked: employee.status === "在线", kind: "switch" },
    { key: "replyPolicy", label: "群内回复策略", value: employee.channelReplyPolicy || "@时回复", options: uniqueOptions([employee.channelReplyPolicy || "@时回复", "@时回复", "总是回复", "仅私聊回复"]), navigable: true },
  ];
}

function ChannelSwitch({ checked }) {
  return (
    <span className={checked ? "channel-setting-switch is-on" : "channel-setting-switch"} role="switch" aria-checked={checked}>
      <i />
    </span>
  );
}

function feishuChannelStatusRows(employee = {}) {
  const canRequestFeishu = feishuApplicationEnabled(employee);
  const hasFeishu = canRequestFeishu && feishuChannelConfigured(employee);
  const hasFeishuTool = (employee.toolBindings || []).some((tool) => /feishu|lark|飞书|机器人|连接器/i.test(String(tool.name || "")));
  return [
    {
      label: "申请入口",
      value: canRequestFeishu ? "走员工行按钮" : "未开放申请",
    },
    {
      label: "渠道绑定",
      value: hasFeishu ? "已接入" : "未接入生产渠道",
    },
    {
      label: "真实消息测试",
      value: hasFeishu ? "已通过" : "未通过",
    },
    {
      label: "连接器声明",
      value: hasFeishuTool ? "已声明，待联通" : "未声明",
    },
  ];
}

const EMPTY_FEISHU_ENTRY_LOCK = {
  enabled: false,
  fixedReply: { label: "业务入口", url: "", description: "" },
};

function FeishuEntryLockPanel({ employee, isSystemAdmin = false }) {
  const endpoint = `/api/feishu/integrations/${encodeURIComponent(employee.id)}/channel-extension`;
  const [entryLock, setEntryLock] = useState(EMPTY_FEISHU_ENTRY_LOCK);
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let canceled = false;
    setState("loading");
    setMessage("");
    fetchChannelExtension(endpoint)
      .then((data) => {
        if (canceled) return;
        setEntryLock(normalizeEntryLock(data.channelExtension?.entryLock));
        setState("ready");
      })
      .catch((error) => {
        if (canceled) return;
        setState("error");
        setMessage(error?.message || "飞书入口策略读取失败");
      });
    return () => { canceled = true; };
  }, [endpoint]);

  const fixedReply = entryLock.fixedReply || EMPTY_FEISHU_ENTRY_LOCK.fixedReply;
  const canSave = isSystemAdmin && state !== "loading" && state !== "saving" && (
    !entryLock.enabled || (fixedReply.url.trim() && fixedReply.description.trim())
  );

  function updateFixedReply(field, value) {
    setEntryLock((current) => ({
      ...current,
      fixedReply: { ...(current.fixedReply || EMPTY_FEISHU_ENTRY_LOCK.fixedReply), [field]: value },
    }));
  }

  async function save() {
    if (!canSave) return;
    setState("saving");
    setMessage("");
    try {
      const data = await fetchChannelExtension(endpoint, {
        method: "PUT",
        body: JSON.stringify({ channelExtension: { entryLock } }),
      });
      setEntryLock(normalizeEntryLock(data.channelExtension?.entryLock));
      setState("saved");
      setMessage(data.message || "当前飞书入口策略已生效。");
    } catch (error) {
      setState("error");
      setMessage(error?.message || "飞书入口策略保存失败");
    }
  }

  return (
    <div className="feishu-entry-lock">
      <div className="feishu-entry-lock-head">
        <span>
          <strong>飞书入口锁定</strong>
          <small>开启后，已通过渠道认证、白名单和去重的普通输入只返回固定入口；不调用模型或 HR Tool。</small>
        </span>
        <button
          className={entryLock.enabled ? "feishu-entry-lock-switch channel-setting-switch is-on" : "feishu-entry-lock-switch channel-setting-switch"}
          type="button"
          role="switch"
          aria-checked={entryLock.enabled}
          disabled={!isSystemAdmin || state === "loading" || state === "saving"}
          title={isSystemAdmin ? "切换后保存即可立即生效" : "需要平台治理权限"}
          onClick={() => setEntryLock((current) => ({ ...current, enabled: !current.enabled }))}
        >
          <i />
        </button>
      </div>
      <div className="feishu-entry-lock-fields">
        <label>
          <span>入口名称</span>
          <input
            value={fixedReply.label}
            maxLength={80}
            disabled={!isSystemAdmin || state === "loading" || state === "saving"}
            placeholder="HR Train 培训链接"
            onChange={(event) => updateFixedReply("label", event.target.value)}
          />
        </label>
        <label>
          <span>入口链接</span>
          <input
            value={fixedReply.url}
            type="url"
            disabled={!isSystemAdmin || state === "loading" || state === "saving"}
            placeholder="https://training.example.com/"
            onChange={(event) => updateFixedReply("url", event.target.value)}
          />
        </label>
        <label className="is-wide">
          <span>固定说明</span>
          <textarea
            value={fixedReply.description}
            maxLength={320}
            rows={2}
            disabled={!isSystemAdmin || state === "loading" || state === "saving"}
            placeholder="思小练当前仅提供 HR Train 培训与考核入口。"
            onChange={(event) => updateFixedReply("description", event.target.value)}
          />
        </label>
      </div>
      <div className="feishu-entry-lock-actions">
        <small>{state === "loading" ? "正在读取服务端当前设置…" : entryLock.enabled ? "锁定将在保存后立即生效。" : "关闭时，普通输入保持既有统一 Agent Runtime 路径。"}</small>
        <button className="table-action" type="button" disabled={!canSave} onClick={save}>
          {state === "saving" ? <Loader2 className="feishu-application-spin" size={14} /> : null}
          {state === "saving" ? "保存中" : "保存并立即生效"}
        </button>
      </div>
      {message ? <div className={state === "error" ? "feishu-entry-lock-message is-error" : "feishu-entry-lock-message"}>{message}</div> : null}
    </div>
  );
}

function normalizeEntryLock(value = {}) {
  return {
    enabled: Boolean(value.enabled),
    fixedReply: {
      label: value.fixedReply?.label || EMPTY_FEISHU_ENTRY_LOCK.fixedReply.label,
      url: value.fixedReply?.url || "",
      description: value.fixedReply?.description || "",
    },
  };
}

async function fetchChannelExtension(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || "飞书入口策略接口失败");
  return data;
}

export default function EmployeeChannelsPanel({
  employee,
  channels,
  permissionLabel,
  isBusinessEmployee,
  isSystemAdmin = false,
  onOpenFeishuApplication = null,
  apiAccessPanel = null,
}) {
  const normalizedChannels = channels.length ? channels : ["管理台"];
  const profiles = buildChannelProfiles(employee, normalizedChannels);
  const defaultProfileId = profiles.find((profile) => profile.active)?.id || "feishu";
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || profiles.find((profile) => profile.id === defaultProfileId) || profiles[0];
  const settings = buildProfileSettings(selectedProfile.id, employee, permissionLabel, isBusinessEmployee);
  const [openSettingKey, setOpenSettingKey] = useState("");
  const [settingDrafts, setSettingDrafts] = useState({});
  const [switchDrafts, setSwitchDrafts] = useState({});
  const [showGovernanceBoundary, setShowGovernanceBoundary] = useState(false);
  const configUrl = employee.channelConfigUrls?.[selectedProfile.id] || employee.channelConfig?.[selectedProfile.id]?.url || "";
  const isFeishuProfile = selectedProfile.id === "feishu";
  const showApiAccessPanel = selectedProfile.id === "api" && apiAccessPanel;
  const feishuStatusRows = feishuChannelStatusRows(employee);
  const feishuReady = feishuChannelConfigured(employee);
  const distributionItems = [
    employee.permissionSummary || permissionLabel,
    employee.apiEndpoints?.length ? "API 调用前必须经过 capability request 与 invocation check。" : "暂未声明外部 API 调用入口。",
    employee.downloadUrl || employee.packageIncludes?.length ? "能力包只携带声明与安装材料，治理记录留在平台。" : "暂未发布可下载能力包。",
    isBusinessEmployee ? "业务系统可申请使用，系统级员工只作为治理/预审 Worker。" : "系统级员工不进入业务系统可申请目录。",
  ].filter(Boolean);
  const sourceTargetItems = employee.sourceTargets || [];
  const boundarySummary = [
    `${distributionItems.length} 条分发规则`,
    sourceTargetItems.length ? `${sourceTargetItems.length} 个来源/目标` : "",
  ].filter(Boolean).join(" / ");

  function settingStateKey(item) {
    return `${selectedProfile.id}:${item.key}`;
  }

  function currentValue(item) {
    const key = settingStateKey(item);
    if (item.kind === "switch") {
      const checked = switchDrafts[key] ?? item.checked;
      if (item.key === "streaming") return checked ? "已开启" : "已关闭";
      return item.value;
    }
    return settingDrafts[key] || item.value;
  }

  function currentChecked(item) {
    const key = settingStateKey(item);
    return Boolean(switchDrafts[key] ?? item.checked);
  }

  function toggleSwitch(item) {
    const key = settingStateKey(item);
    setSwitchDrafts((current) => ({ ...current, [key]: !currentChecked(item) }));
    setOpenSettingKey("");
  }

  function chooseOption(item, option) {
    const key = settingStateKey(item);
    setSettingDrafts((current) => ({ ...current, [key]: option }));
    setOpenSettingKey("");
  }

  return (
    <section className="employee-cockpit-section channel-config-section">
      <div className="employee-config-section-head">
        <RadioTower size={16} />
        <span>
          <strong>渠道与分发</strong>
          <small>Channel 是结构化入口配置；CHANNELS.md 是它的可读治理说明。</small>
        </span>
      </div>

      {isFeishuProfile ? (
        <article className="channel-settings-card">
          <div className="channel-settings-head">
            <strong>飞书接入状态</strong>
            <span>
              <button
                className="table-action"
                type="button"
                onClick={onOpenFeishuApplication || undefined}
                disabled={!onOpenFeishuApplication}
                title={onOpenFeishuApplication ? "打开飞书申请与联通配置" : "当前未开放飞书联通配置入口"}
              >
                打开联通配置
                <ExternalLink size={13} />
              </button>
              <span className={feishuReady ? "status-pill good" : "status-pill muted"}>
                {feishuReady ? "已接入" : "未完成真实测试"}
              </span>
            </span>
          </div>
          <div className="channel-setting-list">
            {feishuStatusRows.map((item) => (
              <div className="channel-setting-row is-static" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <FeishuEntryLockPanel employee={employee} isSystemAdmin={isSystemAdmin} />
          <div className="feishu-channel-whitelist">
            <div className="feishu-channel-whitelist-head">
              <strong>白名单添加</strong>
              <small>审批通过后由治理角色在联通配置中录入稳定 ID。</small>
            </div>
            <div className="feishu-channel-whitelist-grid">
              <span>
                <b>群聊白名单</b>
                <small>新增群名 + chat_id/open_chat_id；群内通过 @机器人 触发。</small>
              </span>
              <span>
                <b>单聊白名单</b>
                <small>新增姓名 + open_id/user_id；单聊直接给机器人发消息。</small>
              </span>
              <span>
                <b>应用可见范围</b>
                <small>看得到机器人不等于可调用，服务端仍按白名单和门禁拦截。</small>
              </span>
            </div>
          </div>
        </article>
      ) : (
        <article className="channel-settings-card">
          <div className="channel-settings-head">
            <strong>{selectedProfile.title}</strong>
            <span>
              {configUrl ? (
                <a className="table-action" href={configUrl} target="_blank" rel="noreferrer">
                  {selectedProfile.openLabel}
                  <ExternalLink size={13} />
                </a>
              ) : (
                <button className="table-action" type="button" disabled title="未配置外部配置链接">
                  {selectedProfile.openLabel}
                  <ExternalLink size={13} />
                </button>
              )}
            </span>
          </div>
          <div className="channel-setting-list">
            {settings.map((item) => {
              const key = settingStateKey(item);
              const isOpen = openSettingKey === key;
              const value = currentValue(item);
              const options = item.options?.length ? item.options : [item.value];
              const isSwitch = item.kind === "switch";

              return (
                <div className="channel-setting-control" key={item.key}>
                  <button
                    className={[
                      "channel-setting-row",
                      isOpen ? "is-active" : "",
                      isSwitch ? "is-switch" : "",
                    ].filter(Boolean).join(" ")}
                    type="button"
                    aria-label={isSwitch ? `${item.label}${currentChecked(item) ? "已开启" : "已关闭"}` : undefined}
                    aria-expanded={isSwitch ? undefined : isOpen}
                    onClick={() => {
                      if (isSwitch) {
                        toggleSwitch(item);
                        return;
                      }
                      setOpenSettingKey((current) => (current === key ? "" : key));
                    }}
                  >
                    <span>{item.label}</span>
                    {isSwitch ? null : <strong>{value}</strong>}
                    {isSwitch ? <ChannelSwitch checked={currentChecked(item)} /> : <ChevronDown size={16} />}
                  </button>
                  {!isSwitch && isOpen ? (
                    <div className="channel-setting-dropdown" role="listbox" aria-label={`${item.label} 选项`}>
                      {options.map((option) => {
                        const selected = option === value;
                        return (
                          <button
                            className={selected ? "is-selected" : ""}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            key={option}
                            onClick={() => chooseOption(item, option)}
                          >
                            <span>{option}</span>
                            {selected ? <Check size={14} /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </article>
      )}

      <div className="employee-channel-grid">
        {profiles.map((profile) => (
          <button
            className={selectedProfile.id === profile.id ? "employee-channel-card is-active" : "employee-channel-card"}
            type="button"
            key={profile.id}
            onClick={() => setSelectedProfileId(profile.id)}
          >
            <span>
              <strong>{profile.label}</strong>
              <small className={profile.active ? "status-pill good" : "status-pill muted"}>{profile.status}</small>
            </span>
            <em>{profile.detail}</em>
          </button>
        ))}
      </div>
      <div className="channel-boundary-disclosure">
        <button
          className={showGovernanceBoundary ? "channel-boundary-toggle is-open" : "channel-boundary-toggle"}
          type="button"
          aria-expanded={showGovernanceBoundary}
          onClick={() => setShowGovernanceBoundary((current) => !current)}
        >
          <span>
            <strong>治理边界</strong>
            <small>{boundarySummary || "暂无额外边界"}</small>
          </span>
          <span className="channel-boundary-action">
            {showGovernanceBoundary ? "收起" : "展开"}
            <ChevronDown size={15} />
          </span>
        </button>
        {showGovernanceBoundary ? (
          <div className="channel-boundary-body">
            <SkillChips title="分发边界" items={distributionItems} compact />
            {sourceTargetItems.length ? <SkillChips title="来源/目标" items={sourceTargetItems} compact /> : null}
          </div>
        ) : null}
      </div>
      {showApiAccessPanel ? apiAccessPanel : null}
    </section>
  );
}
