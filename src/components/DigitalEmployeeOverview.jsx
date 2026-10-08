import {
  Activity,
  Apple,
  BrainCircuit,
  Check,
  Copy,
  Download,
  Layers3,
  MonitorDown,
  RadioTower,
  Settings2,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { basicSkills, businessSkills as catalogBusinessSkills } from "../data/catalog";
import { employeeDisplayStatus, employeeRuntimeHealth, employeeRuntimeStatusDetail } from "../lib/digitalEmployeeHealth";
import {
  digitalEmployeeFacets,
  digitalEmployeeLevel,
  digitalEmployeeLevelLabel,
  digitalEmployeeRuntimeTier,
  employeeMatchesDigitalEmployeeFilters,
  desktopChannelAvailable,
  feishuApplicationEnabled,
  levelOptions,
  normalizeDigitalEmployeeFilters,
} from "../lib/digitalEmployeeOverview";
import { digitalEmployeeAccess } from "../lib/permissions";
import { fetchLatestDesktopRelease } from "../lib/desktopRelease";

const MACOS_ADHOC_INSTALL_COMMAND = 'codesign --verify --deep --strict "/Applications/e-Manager Group Studio Local.app" && sudo xattr -dr com.apple.quarantine "/Applications/e-Manager Group Studio Local.app" && open "/Applications/e-Manager Group Studio Local.app"';

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function openBadcaseCount(employee = {}, badcases = []) {
  const explicitCount = Number(employee.quality?.openBadcases);
  const openCases = badcases.filter((item) => !["已关闭", "closed"].includes(item.status)).length;
  return Math.max(Number.isFinite(explicitCount) ? explicitCount : 0, openCases);
}

function employeeQualityScore(employee = {}, badcases = []) {
  if (employee.status === "待人员审批") return 82;
  if (employee.status === "规划中") return 76;
  return Math.max(68, 98 - openBadcaseCount(employee, badcases) * 8);
}

function scoreTone(score) {
  if (score >= 92) return "good";
  if (score >= 80) return "warn";
  return "bad";
}

function employeeSkillCount(employee = {}) {
  return (employee.basicSkillIds?.length || 0) + (employee.businessSkillIds?.length || 0);
}

function averageScore(rows = []) {
  if (!rows.length) return 0;
  return Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length);
}

function optionCounts(values = []) {
  const counts = values.reduce((map, value) => {
    const label = String(value || "").trim();
    if (!label) return map;
    map.set(label, (map.get(label) || 0) + 1);
    return map;
  }, new Map());
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "zh-CN"))
    .slice(0, 12);
}

export default function DigitalEmployeeOverview({
  employees = [],
  statusClass,
  badcasesForEntity,
  businessSkills = catalogBusinessSkills,
  filters = {},
  onFiltersChange = null,
  onSelectEmployee = null,
  runtimeEvidenceByEmployeeId = {},
  isSystemAdmin = false,
  session = null,
  onDesktopAvailabilityChange = null,
  onFeishuApplicationChange = null,
  onOpenAccessReview = null,
  pendingAccessRequestCount = 0,
}) {
  const normalizedFilters = normalizeDigitalEmployeeFilters(filters);
  const allRows = employees.map((employee) => {
    const badcases = typeof badcasesForEntity === "function" ? badcasesForEntity(employee.id) : [];
    const score = employeeQualityScore(employee, badcases);
    const facets = digitalEmployeeFacets(employee, businessSkills);
    const health = employeeRuntimeHealth(employee, employee.modelBinding, runtimeEvidenceByEmployeeId[employee.id] || employee.runtimeEvidence || {});
    const displayStatus = employeeDisplayStatus(employee, health);
    return {
      employee,
      ...facets,
      access: digitalEmployeeAccess(session, employee),
      level: digitalEmployeeLevel(employee),
      levelLabel: digitalEmployeeLevelLabel(employee),
      runtime: digitalEmployeeRuntimeTier(employee),
      score,
      skillCount: employeeSkillCount(employee),
      health,
      displayStatus,
      statusTone: health.overall.tone === "bad" ? "bad" : typeof statusClass === "function" ? statusClass(displayStatus) : health.overall.tone,
      statusDetail: employeeRuntimeStatusDetail(health),
    };
  });
  const rows = allRows.filter((row) => employeeMatchesDigitalEmployeeFilters(row.employee, normalizedFilters, businessSkills));
  const enterpriseRows = rows.filter((row) => row.level === "enterprise");
  const businessRows = rows.filter((row) => row.level === "business");
  const enterpriseTotal = allRows.filter((row) => row.level === "enterprise").length;
  const businessTotal = allRows.filter((row) => row.level === "business").length;
  const onlineCount = rows.filter((row) => row.health.overall.state === "online").length;
  const totalAssignedSkills = new Set(rows.flatMap((row) => [...(row.employee.basicSkillIds || []), ...(row.employee.businessSkillIds || [])])).size;
  const assignableSkillCount = basicSkills.length + (businessSkills || catalogBusinessSkills).length;
  const runtimeCount = new Set(rows.map((row) => row.runtime)).size;
  const visibleChannelCount = new Set(rows.flatMap((row) => row.channels)).size;
  const totalChannelCount = new Set(allRows.flatMap((row) => row.channels)).size;
  const qualityAvg = averageScore(rows);
  const channelOptions = optionCounts(allRows.flatMap((row) => row.channels));
  const metrics = [
    { label: "企业级", value: enterpriseRows.length, detail: `${enterpriseTotal} 总数 · 控制面`, icon: <BrainCircuit size={17} /> },
    { label: "业务级", value: businessRows.length, detail: `${businessTotal} 总数 · 部门流程`, icon: <UserRound size={17} /> },
    { label: "Channels", value: visibleChannelCount, detail: `${totalChannelCount} 个可筛选`, icon: <RadioTower size={17} /> },
    { label: "Skills", value: totalAssignedSkills, detail: `${assignableSkillCount} 可分配`, icon: <Layers3 size={17} /> },
    { label: "Quality", value: qualityAvg ? `${qualityAvg}` : "N/A", detail: `${onlineCount} 在线 · ${runtimeCount} Runtime`, icon: <Activity size={17} /> },
  ];

  function updateFilters(nextFilters) {
    if (typeof onFiltersChange !== "function") return;
    onFiltersChange(normalizeDigitalEmployeeFilters(nextFilters));
  }

  function setFilter(key, value) {
    updateFilters({ ...normalizedFilters, [key]: value });
  }

  return (
    <section className="panel digital-employee-overview">
      <div className="digital-employee-head">
        <div>
          <p className="eyebrow">Digital Employees</p>
          <h2>数字员工</h2>
          <span>主表聚焦能力、Channels、Skills、质量和状态；SOUL 与 Runtime 配置进入详情。</span>
        </div>
        <div className="digital-employee-head-actions">
          {onOpenAccessReview ? (
            <button
              className={`ghost-action digital-employee-access-entry${pendingAccessRequestCount > 0 ? " has-pending" : ""}`}
              type="button"
              aria-label={pendingAccessRequestCount > 0 ? `使用授权，${pendingAccessRequestCount} 条待审核` : "使用授权"}
              title={pendingAccessRequestCount > 0 ? `${pendingAccessRequestCount} 条待审核使用授权` : "使用授权"}
              onClick={onOpenAccessReview}
            >
              <ShieldCheck size={15} />
              使用授权
            </button>
          ) : null}
          <DesktopDownloadMenu />
          <div className="digital-employee-health">
            <ShieldCheck size={16} />
            <strong>{qualityAvg >= 90 ? "治理健康" : rows.length ? "需要复核" : "等待筛选"}</strong>
          </div>
        </div>
      </div>

      <div className="digital-employee-metrics">
        {metrics.map((metric) => (
          <article className="digital-employee-metric" key={metric.label}>
            <span>{metric.icon}</span>
            <div>
              <small>{metric.label}</small>
              <strong>{metric.value}</strong>
              <em>{metric.detail}</em>
            </div>
          </article>
        ))}
      </div>

      <div className="digital-employee-table-wrap">
        <div className="digital-employee-list-controls">
          <div className="digital-employee-sheet-tabs" role="tablist" aria-label="数字员工级别">
            {levelOptions.map((option) => (
              <button
                className={normalizedFilters.level === option.id ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={normalizedFilters.level === option.id}
                key={option.id}
                onClick={() => setFilter("level", option.id)}
              >
                {option.label}
                <b>{option.id === "enterprise" ? enterpriseTotal : option.id === "business" ? businessTotal : allRows.length}</b>
              </button>
            ))}
          </div>
          <ColumnFilter
            label="Channels"
            value={normalizedFilters.channel}
            options={channelOptions}
            onChange={(value) => setFilter("channel", value)}
          />
        </div>
        <table className="digital-employee-table">
          <thead>
            <tr>
              <th>数字员工</th>
              <th>级别</th>
              <th>负责人</th>
              <th>能力</th>
              <th>飞书申请</th>
              <th>桌面端可用</th>
              <th>Channels</th>
              <th>Skills</th>
              <th>质量</th>
              <th>上线状态</th>
              <th>配置</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.employee.id}>
                  <td>
                    <div className="digital-employee-agent-cell">
                      <span className="digital-employee-agent-icon">
                        <BrainCircuit size={15} />
                      </span>
                      <span>
                        <button
                          className="digital-employee-agent-link"
                          type="button"
                          disabled={!row.access.canOpenWorkbench}
                          title={row.access.actionTitle}
                          onClick={() => onSelectEmployee?.(row.employee.id)}
                        >
                          {row.employee.name}
                        </button>
                        <small>{row.employee.department}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`digital-employee-level is-${row.level}`}>{row.levelLabel}</span>
                  </td>
                  <td>
                    <span className="digital-employee-inline">
                      <UserRound size={14} />
                      {row.employee.owner || "未指定"}
                    </span>
                  </td>
                  <td>{row.employee.title || row.employee.objective || row.levelLabel}</td>
                  <td>
                    <ChannelAvailabilitySwitch
                      enabled={feishuApplicationEnabled(row.employee)}
                      editable={isSystemAdmin}
                      onChange={(enabled) => onFeishuApplicationChange?.(row.employee.id, enabled)}
                      enabledLabel="可申请"
                      disabledLabel="不可申请"
                      enabledAction="关闭飞书申请"
                      disabledAction="允许飞书申请"
                      disabledTitle="只有管理员可以调整飞书申请"
                    />
                  </td>
                  <td>
                    <ChannelAvailabilitySwitch
                      enabled={desktopChannelAvailable(row.employee)}
                      editable={isSystemAdmin}
                      onChange={(enabled) => onDesktopAvailabilityChange?.(row.employee.id, enabled)}
                      enabledLabel="可用"
                      disabledLabel="已关闭"
                      enabledAction="关闭桌面端可用"
                      disabledAction="开启桌面端可用"
                      disabledTitle="只有管理员可以调整桌面端可用状态"
                      compact
                    />
                  </td>
                  <td>
                    <DigitalEmployeeTagButtons
                      items={row.channels}
                      activeValue={normalizedFilters.channel}
                      onToggle={(value) => setFilter("channel", value)}
                      icon={<RadioTower size={12} />}
                      label="渠道"
                    />
                  </td>
                  <td>{row.skillCount}</td>
                  <td>
                    <span className={`agent-quality-score is-${scoreTone(row.score)}`}>{row.score}</span>
                  </td>
                  <td>
                    <span className="digital-employee-status-stack">
                      <span className={`status-pill ${row.statusTone}`}>{row.displayStatus}</span>
                      {row.statusDetail && row.statusDetail !== row.displayStatus ? <small>{row.statusDetail}</small> : null}
                    </span>
                  </td>
                  <td>
                    <button
                      className="digital-employee-row-action"
                      type="button"
                      disabled={!row.access.canOpenWorkbench}
                      title={row.access.actionTitle}
                      onClick={() => onSelectEmployee?.(row.employee.id)}
                    >
                      <Settings2 size={14} />
                      {row.access.actionLabel}
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={11}>
                  <div className="digital-employee-empty">
                    <strong>没有匹配的数字员工</strong>
                    <span>切换企业级/业务级，或调整 Channels 后再查看。</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DesktopDownloadMenu() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle", release: null, message: "" });
  const [commandCopied, setCommandCopied] = useState(false);
  const [experience, setExperience] = useState("desktop");
  const requestRevision = useRef(0);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function loadRelease(selectedExperience = experience) {
    const revision = ++requestRevision.current;
    setState({ status: "loading", release: null, message: "" });
    try {
      const release = await fetchLatestDesktopRelease(selectedExperience);
      if (revision !== requestRevision.current) return;
      setState({ status: "ready", release, message: "" });
    } catch (error) {
      if (revision !== requestRevision.current) return;
      setState({ status: "error", release: null, message: error?.message || "桌面安装包目录暂时不可用" });
    }
  }

  function toggleMenu() {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen) setCommandCopied(false);
    if (nextOpen && state.status !== "loading") loadRelease();
  }

  async function copyMacInstallCommand() {
    setCommandCopied(await copyText(MACOS_ADHOC_INSTALL_COMMAND));
  }

  return (
    <div className="digital-employee-desktop-download-wrap" ref={rootRef}>
      <button
        className="ghost-action digital-employee-desktop-download"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggleMenu}
        title="直接下载桌面版安装包"
      >
        <Download size={15} />
        桌面版下载
      </button>
      {open ? (
        <div className="desktop-download-menu" role="dialog" aria-label="桌面版安装包下载">
          <div className="desktop-download-menu-head">
            <span>
              <strong>选择安装包</strong>
              <small>{state.release ? `${state.release.channel === "beta" ? "内测版" : "稳定版"} · v${state.release.version}` : "从企业发布目录读取"}</small>
            </span>
            <button type="button" className="icon-button" aria-label="关闭下载菜单" onClick={() => setOpen(false)}><X size={15} /></button>
          </div>
          <div className="desktop-download-editions" role="group" aria-label="桌面版本">
            {[["group_studio", "Group Studio 3.0"], ["desktop", "桌面版 2.x"]].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={experience === id} onClick={() => {
                setExperience(id);
                setCommandCopied(false);
                loadRelease(id);
              }}>{label}</button>
            ))}
          </div>
          {state.status === "loading" ? <div className="desktop-download-state">正在读取安装包…</div> : null}
          {state.status === "error" ? (
            <>
              <div className="desktop-download-state is-error">
                <span>{state.message}</span>
                <button type="button" className="ghost-action" onClick={() => loadRelease()}>重试</button>
              </div>
              <div className="desktop-download-platforms">
                <DesktopDownloadOption icon={<MonitorDown size={18} />} name="Windows" detail="Windows 10/11 · x64" platform={null} />
                <DesktopDownloadOption icon={<Apple size={18} />} name="macOS" detail="Apple Silicon · ARM64" platform={null} />
              </div>
            </>
          ) : null}
          {state.status === "ready" ? (
            <div className="desktop-download-platforms">
              <DesktopDownloadOption icon={<MonitorDown size={18} />} name="Windows" detail="Windows 10/11 · x64" platform={state.release.platforms["win32-x64"]} />
              <DesktopDownloadOption icon={<Apple size={18} />} name="macOS" detail="Apple Silicon · ARM64" platform={state.release.platforms["darwin-arm64"]} />
            </div>
          ) : null}
          {experience === "desktop" && state.release?.platforms["darwin-arm64"]?.available ? (
            <details className="desktop-download-signing-help">
              <summary>
                <ShieldCheck size={15} />
                <span>
                  <strong>macOS 临时签名说明</strong>
                  <small>Ad-hoc 签名，未经 Apple 公证</small>
                </span>
              </summary>
              <p>先将应用拖入“应用程序”。如系统仍拦截，确认安装包来自公司发布页后，在“终端”运行：</p>
              <div className="desktop-download-command">
                <code>{MACOS_ADHOC_INSTALL_COMMAND}</code>
                <button type="button" className="ghost-action" onClick={copyMacInstallCommand}>
                  {commandCopied ? <Check size={14} /> : <Copy size={14} />}
                  {commandCopied ? "已复制" : "复制命令"}
                </button>
              </div>
              <small>终端询问密码时输入本机登录密码（输入不回显）；该命令只验证并放行这一个 App。</small>
            </details>
          ) : null}
          <small className="desktop-download-boundary">{state.release?.distributionNotice || "公司网络或 VPN 内使用。"} {experience === "desktop" ? "macOS 为 Ad-hoc 临时签名且未公证，Windows 为未签名内测包。" : "签名信息以企业发布记录为准。"}</small>
        </div>
      ) : null}
    </div>
  );
}

function DesktopDownloadOption({ detail, icon, name, platform }) {
  if (!platform?.available) {
    return (
      <span className="desktop-download-option is-disabled" aria-disabled="true">
        {icon}
        <span><strong>{name}</strong><small>{detail} · 尚未发布</small></span>
      </span>
    );
  }
  return (
    <a className="desktop-download-option" href={platform.downloadUrl}>
      {icon}
      <span><strong>下载 {name}</strong><small>{detail}</small></span>
      <Download size={15} />
    </a>
  );
}

function ChannelAvailabilitySwitch({ enabled, editable, onChange, enabledLabel, disabledLabel, enabledAction, disabledAction, disabledTitle, compact = false }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function updateApplicationState() {
    if (!editable || saving) return;
    setSaving(true);
    setError("");
    try {
      await onChange?.(!enabled);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      className={`feishu-application-switch${enabled ? " is-on" : ""}${compact ? " is-compact" : ""}${error ? " has-error" : ""}`}
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={saving ? "保存中" : error ? `${enabledLabel}状态保存失败` : `${enabled ? enabledLabel : disabledLabel}；${editable ? (enabled ? enabledAction : disabledAction) : disabledTitle}`}
      disabled={!editable || saving}
      title={error || (editable ? (enabled ? enabledAction : disabledAction) : disabledTitle)}
      onClick={updateApplicationState}
    >
      <span className={enabled ? "channel-setting-switch is-on" : "channel-setting-switch"} aria-hidden="true">
        <i />
      </span>
      {!compact || saving || error ? <small>{saving ? "保存中" : error ? "保存失败" : enabled ? enabledLabel : disabledLabel}</small> : null}
    </button>
  );
}

function ColumnFilter({ label, value, options = [], onChange }) {
  return (
    <label className="digital-employee-column-filter">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={`按${label}筛选`}>
        <option value="all">全部</option>
        {options
          .filter((option) => option.value !== "all")
          .map((option) => (
            <option key={option.value} value={option.value}>
              {option.label || option.value}{option.count ? ` (${option.count})` : ""}
            </option>
          ))}
      </select>
    </label>
  );
}

function DigitalEmployeeTagButtons({ items = [], activeValue = "all", onToggle, icon = null, label }) {
  const visibleItems = items.slice(0, 4);
  if (!visibleItems.length) return <span className="digital-employee-muted">待配置</span>;
  return (
    <span className="digital-employee-chips" aria-label={label}>
      {visibleItems.map((item) => (
        <button
          key={item}
          className={activeValue === item ? "is-active" : ""}
          type="button"
          title={`按${label}筛选：${item}`}
          onClick={() => onToggle(activeValue === item ? "all" : item)}
        >
          {icon}
          {item}
        </button>
      ))}
    </span>
  );
}
