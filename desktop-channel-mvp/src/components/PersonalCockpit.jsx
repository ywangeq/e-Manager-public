import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise, ArrowRight, CalendarDots, CheckCircle, CirclesFour, Clock,
  ListChecks, Minus, Plus, SignOut, Sparkle, SpinnerGap, WarningCircle, FolderOpen,
} from "@phosphor-icons/react";
import { CockpitTaskWorkspace } from "./CockpitTaskWorkspace.jsx";
import { CockpitClock } from "./CockpitClock.jsx";
import { CockpitMetricCard } from "./CockpitMetricCard.jsx";
import { CockpitEmployeeStack } from "./CockpitEmployeeStack.jsx";
import { CockpitGroupParticipants } from "./CockpitGroupParticipants.jsx";
import { CockpitContentWorkspace } from "./CockpitContentWorkspace.jsx";
import { SubsystemConnections } from "./SubsystemConnections.jsx";
import { CockpitSentinel } from "./CockpitSentinel.jsx";
import { useCockpitSentinelState } from "../hooks/useCockpitSentinelState.js";
import { ProjectGroupWorkspace } from "./ProjectGroupWorkspace.jsx";
import { MaximizeButton } from "./MaximizeButton.jsx";
import { cockpitGoalStatus, cockpitOverview, cockpitAttention, cockpitWorkItems, cockpitFilterItems } from "../lib/personalCockpitModel.js";
import { automationTaskTitle, upcomingAutomations } from "../lib/automationCalendar.js";
import { runStatusLabel } from "../lib/groupRunHistory.js";
import { cockpitRecordTime, groupStepProgress } from "../lib/cockpitProgressPresentation.js";
import { cockpitStatusTone } from "../lib/cockpitStatusTone.js";
import { useCockpitMotion } from "../lib/useCockpitMotion.js";
import { employeeCharacterFor } from "../data/employeeCharacters.js";
import { createAutomationRunReadCache } from "../lib/automationRunReadCache.js";
import "./personal-cockpit.css";


function compactTime(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp) : "时间待同步";
}

function intervalLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "周期待同步";
  if (value % 86400 === 0) return `每 ${value / 86400} 天`;
  if (value % 3600 === 0) return `每 ${value / 3600} 小时`;
  if (value % 60 === 0) return `每 ${value / 60} 分钟`;
  return `每 ${value} 秒`;
}

export function useCockpitSources(desktopApi, authenticated, enabled = true) {
  const [sources, setSources] = useState({ goals: [], automations: [], goalPhase: "loading", automationPhase: "loading" });
  const [revision, setRevision] = useState(0);
  const refreshRef = useRef(() => {});
  const runCacheRef = useRef(null);
  const [runDetails, setRunDetails] = useState({});
  useEffect(() => {
    setSources({ goals: [], automations: [], goalPhase: "loading", automationPhase: "loading" });
  }, [desktopApi, authenticated]);
  useEffect(() => {
    if (!authenticated) return undefined;
    let current = true;
    setRunDetails({});
    const runCache = createAutomationRunReadCache(id => desktopApi?.personalAutomations?.({ action: "detail", automationId: id }), setRunDetails);
    runCacheRef.current = runCache;
    const pending = new Set();
    function refresh() {
      const settle = (kind, phase, promise, field) => {
        if (pending.has(kind)) return;
        pending.add(kind);
        setSources(previous => ({ ...previous, [phase]: previous[phase] === "ready" ? "ready" : "loading" }));
        Promise.resolve().then(promise).then((result) => {
          if (!current) return;
          const items = result?.ok && Array.isArray(result[field]) ? result[field] : null;
          const visible = kind === "goals" && items ? items.filter((item, index) => items.findIndex(other => other.goalId === item.goalId) === index) : items;
          if (kind === "automations") runCache.update(items || []);
          setSources((previous) => ({ ...previous, [kind]: visible || [], [phase]: items ? "ready" : "error" }));
        }).catch(() => {
          if (!current) return;
          if (kind === "automations") runCache.update([]);
          setSources((previous) => ({ ...previous, [kind]: [], [phase]: "error" }));
        }).finally(() => pending.delete(kind));
      };
      if (enabled) settle("goals", "goalPhase", () => desktopApi?.groupStudio?.history?.(), "items");
      settle("automations", "automationPhase", () => desktopApi?.personalAutomations?.({ action: "list" }), "automations");
    }
    refreshRef.current = refresh;
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => { current = false; runCache.dispose(); if (runCacheRef.current === runCache) runCacheRef.current = null; refreshRef.current = () => {}; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [desktopApi, authenticated, enabled]);
  return {
    ...(authenticated ? sources : { goals: [], automations: [], goalPhase: "idle", automationPhase: "idle" }),
    refresh: () => { refreshRef.current(); setRevision((value) => value + 1); },
    refreshRevision: revision,
    runDetails: authenticated ? runDetails : {},
    ensureRuns: (id, options) => runCacheRef.current?.read(id, options),
  };
}

function Section({ title, action, children, className = "" }) {
  return <section className={`cockpit-section ${className}`}><header><h2>{title}</h2>{action}</header>{children}</section>;
}

function Empty({ children }) {
  return <p className="cockpit-empty">{children}</p>;
}

function TaskActivityRail({ sources, myTasks, employees, onOpenGoal, onOpenTasks }) {
  const [filter, setFilter] = useState("all");
  const items = cockpitFilterItems(cockpitWorkItems({
    tasks: myTasks.phase === "ready" ? myTasks.page.tasks : [],
    goals: sources.goalPhase === "ready" ? sources.goals : [],
    automations: sources.automationPhase === "ready" ? sources.automations : [],
  }), filter).sort((a, b) => (Date.parse(cockpitRecordTime(b)?.value) || 0) - (Date.parse(cockpitRecordTime(a)?.value) || 0));
  const loading = [myTasks.phase, sources.goalPhase, sources.automationPhase].some(phase => phase === "loading" || phase === "idle");
  const failed = [myTasks.phase, sources.goalPhase, sources.automationPhase].includes("error");
  return <aside className="cockpit-activity-rail" aria-label="任务动态">
    <header><h2>任务动态</h2><button type="button" className="cockpit-text-link" title="查看全部任务" aria-label="查看全部任务" onClick={() => onOpenTasks("all")}><ArrowRight size={18} aria-hidden="true" /></button></header>
    <div className="cockpit-activity-tabs" role="group" aria-label="任务动态筛选">{[["all", "全部"], ["active", "进行中"], ["attention", "待处理"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    <p className="cockpit-source-note">当前已加载任务 · 按记录时间排序</p>
    {failed ? <p className="cockpit-source-error" role="status">部分来源暂不可用，仅显示已读取记录。</p> : null}
    {loading ? <p className="cockpit-source-note" role="status">正在同步任务状态…</p> : null}
    <div className="cockpit-activity-list">{items.map(entry => {
      const employee = employees.find(item => item.id === entry.item.employeeId);
      const name = entry.item.employeeName || employee?.name || (entry.kind === "goal" ? "Group 协作" : "数字员工");
      const time = cockpitRecordTime(entry);
      const portrait = employee ? employeeCharacterFor(employee)?.staticSrc : null;
      const row = <button type="button" className="cockpit-activity-row" data-tone={cockpitStatusTone(entry.status)} onClick={() => entry.kind === "goal" ? onOpenGoal(entry.item.goalId) : entry.kind === "automation" ? onOpenTasks("automations", entry.item) : onOpenTasks("all", null, entry.item.id)}>
        <span className="cockpit-activity-dot" aria-hidden="true" />
        {entry.kind !== "goal" ? <span className="cockpit-activity-avatar" aria-hidden="true">{portrait ? <img src={portrait} alt="" draggable={false} /> : <ListChecks size={18} />}</span> : null}
        <span className="cockpit-activity-copy"><span className="cockpit-activity-title"><strong>{entry.title}</strong><em>{entry.kind === "task" ? entry.item.statusLabel || runStatusLabel(entry.status) : entry.kind === "automation" ? entry.status === "attention_required" ? "需要关注" : "定时规则" : runStatusLabel(entry.status)}</em></span><small>{name}</small>{time ? <time dateTime={time.value}>{time.label} {compactTime(time.value)}</time> : <small>记录时间暂不可用</small>}{entry.kind === "task" && entry.item.nextGate ? <small>{entry.item.nextGate}</small> : null}</span>
      </button>;
      return entry.kind === "goal" ? <div key={entry.key} className="cockpit-activity-goal"><CockpitGroupParticipants goal={entry.item} employees={employees} />{row}</div> : <div key={entry.key}>{row}</div>;
    })}</div>
    {!items.length && !loading ? <Empty>{failed ? "任务状态暂时无法完整获取，请刷新后查看。" : filter === "active" ? "当前没有进行中的任务。" : filter === "attention" ? "当前没有需要你处理的事项。" : "当前已加载来源暂无任务记录。"}</Empty> : null}
  </aside>;
}

function PreviewGroupWorkspace({ onBack }) {
  return <div className="cockpit-workbench-preview"><header><button type="button" onClick={onBack}>返回驾驶舱</button><span>Group Studio 3.0 · 工作台结构预览</span></header><div><span>目标与计划</span><span>Group 成员与依赖</span><span>执行与复核</span></div><p>此页仅展示入口位置。浏览器预览没有 Group 授权连接，无法创建目标或执行；已登录的 Desktop 会打开原工作台。</p></div>;
}

export function PersonalCockpit({ expanded = true, authenticated, actor, authError, onLogin, onLogout, desktopApi, employees = [], bootstrapReady, catalogPhase = "idle", onRefreshCatalog, myTasks, onOpenEmployeeConversation = null, onSelectEmployeeConversation = null, renderEmployeeConversation = null, employeeConversationState = null }) {
  const [screen, setScreen] = useState("overview");
  const [taskFilter, setTaskFilter] = useState("active");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedAutomation, setSelectedAutomation] = useState(null);
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const scrollRef = useRef(null);
  useCockpitMotion(scrollRef, `${expanded}:${authenticated}:${screen}:${taskFilter}`, ":scope > .cockpit-heading, :scope > .cockpit-stats, :scope > .cockpit-task-view > .cockpit-heading");
  const sources = useCockpitSources(desktopApi, authenticated, screen !== "group");
  const sentinelPresentation = useCockpitSentinelState({ authenticated, taskPhase: myTasks.phase, tasks: myTasks.page.tasks, sources });
  const overview = useMemo(() => cockpitOverview({ tasks: myTasks.page.tasks, automations: sources.automations, goals: sources.goals }), [myTasks.page, sources.automations, sources.goals]);
  const attention = useMemo(() => cockpitAttention({ tasks: myTasks.phase === "error" ? [] : myTasks.page.tasks, goals: sources.goals, automations: sources.automations }), [myTasks.page, myTasks.phase, sources.goals, sources.automations]);
  const availableEmployees = authenticated && desktopApi && bootstrapReady
    ? employees.filter((employee, index) => employee.id && employee.access?.selectable === true && employee.access?.callable === true && employees.findIndex(other => other.id === employee.id) === index)
    : null;
  const availableEmployeeCount = availableEmployees?.length ?? null;
  const upcoming = upcomingAutomations(sources.automations).slice(0, 4);
  const openTasks = (filter = "all", automation = null, taskId = "") => {
    setTaskFilter(filter);
    setSelectedAutomation(automation);
    setSelectedTaskId(taskId);
    setScreen("tasks");
  };
  const openGoal = (goalId = "") => { setSelectedGoalId(goalId); setScreen("group"); };
  const taskUnavailable = myTasks.phase === "error";
  const loadingTasks = myTasks.phase === "idle" || myTasks.phase === "loading";
  const loadingSources = sources.goalPhase === "loading" || sources.automationPhase === "loading";
  const missingSources = sources.goalPhase === "error" || sources.automationPhase === "error" || taskUnavailable;

  if (!expanded && desktopApi) return <div className="cockpit-desktop-sentinel" aria-label="桌面值守"><CockpitSentinel compact desktopApi={desktopApi} presentation={sentinelPresentation} authenticated={authenticated} taskPhase={myTasks.phase} tasks={myTasks.page.tasks} sources={sources} onOpen={() => {setScreen("overview");void desktopApi.setExpanded?.(true);}} /></div>;

  if (screen === "group" && authenticated) {
    return <div className="cockpit-group-workspace">{desktopApi ? <ProjectGroupWorkspace automationSources={sources} myTasks={myTasks} onSelectEmployeeConversation={onSelectEmployeeConversation} renderEmployeeConversation={renderEmployeeConversation} employeeConversationState={employeeConversationState} onOpenEmployeeConversation={onOpenEmployeeConversation} key={selectedGoalId || "new"} desktopApi={desktopApi} employees={employees} bootstrapReady={bootstrapReady} authenticated={authenticated} initialGoalId={selectedGoalId} onCollapse={() => desktopApi?.setExpanded?.(false)} onBack={() => { setScreen("overview"); sources.refresh(); void myTasks.refresh(); }} /> : <PreviewGroupWorkspace onBack={() => setScreen("overview")} />}</div>;
  }

  return <main className={`personal-cockpit${screen !== "overview" ? " is-workspace-view" : ""}`}>
    <aside className="cockpit-sidebar" aria-label="个人工作区导航">
      <div className="cockpit-brand"><span className="cockpit-brand-icon"><Sparkle size={22} weight="fill" /></span><span><strong>Group Studio</strong><small>个人工作空间</small></span></div>
      <div className="cockpit-nav-label">工作台</div>
      <nav>
        <button type="button" aria-label="驾驶舱" aria-current={screen === "overview" ? "page" : undefined} title="驾驶舱" className={screen === "overview" ? "is-active" : ""} onClick={() => setScreen("overview")}><CirclesFour size={18} aria-hidden="true" />驾驶舱</button>
        <button type="button" aria-label="我的任务" aria-current={screen === "tasks" && taskFilter !== "automations" ? "page" : undefined} title="我的任务" className={screen === "tasks" && taskFilter !== "automations" ? "is-active" : ""} onClick={() => openTasks()} disabled={!authenticated}><ListChecks size={18} aria-hidden="true" />我的任务</button>
        <button type="button" aria-label="我的内容" aria-current={screen === "content" ? "page" : undefined} title="我的内容" className={screen === "content" ? "is-active" : ""} onClick={() => setScreen("content")} disabled={!authenticated}><FolderOpen size={18} aria-hidden="true" />我的内容</button>
        <button type="button" aria-label="定时任务" aria-current={screen === "tasks" && taskFilter === "automations" ? "page" : undefined} title="定时任务" className={screen === "tasks" && taskFilter === "automations" ? "is-active" : ""} onClick={() => openTasks("automations")} disabled={!authenticated}><CalendarDots size={18} aria-hidden="true" />定时任务</button>
        <button type="button" aria-label="Group Studio 工作台" title="Group Studio 工作台" onClick={() => openGoal()} disabled={!authenticated}><Sparkle size={18} aria-hidden="true" />Group 工作台 <ArrowRight size={14} aria-hidden="true" /></button>
      </nav>
      <div className="cockpit-sidebar-footer" />
    </aside>
    <div className="cockpit-main">
      <header className="cockpit-topbar"><div><span className="cockpit-online-dot" aria-hidden="true" />{authenticated ? "当前账号的工作概览" : "登录后查看个人工作"}</div><div className="cockpit-top-actions">{desktopApi ? <><MaximizeButton desktopApi={desktopApi} /><button type="button" aria-label="收起到桌面值守" title="收起到桌面值守" onClick={() => desktopApi.setExpanded?.(false)}><Minus size={18} /></button></> : null}<button type="button" title="刷新概览" aria-label="刷新概览" onClick={() => { sources.refresh(); void myTasks.refresh(); void onRefreshCatalog?.(); }} disabled={!authenticated}><ArrowClockwise size={18} /></button><span className="cockpit-profile">{actor?.name || "企业用户"}</span>{authenticated ? <button type="button" title="退出登录" aria-label="退出登录" onClick={onLogout}><SignOut size={18} /></button> : null}</div></header>
      {!authenticated ? <div className="cockpit-auth"><div><span className="cockpit-eyebrow">PERSONAL WORKSPACE</span><h1>先确认你的企业身份</h1><p>登录后汇总当前用户可见的任务、定时任务与 Group 目标；不同来源无法读取时分别说明。</p><button type="button" className="cockpit-primary" onClick={onLogin}>企业认证登录 <ArrowRight size={17} /></button>{authError ? <p role="alert">{authError}</p> : null}</div></div> : <div className="cockpit-scroll" ref={scrollRef}>
        {screen === "content" ? <div className="cockpit-task-view"><div className="cockpit-heading"><h1>我的内容</h1><CockpitClock compact /></div><CockpitContentWorkspace sources={sources} myTasks={myTasks} employees={availableEmployees || []} desktopApi={desktopApi} onOpenGoal={openGoal} onOpenTask={taskId => openTasks("all", null, taskId)} /></div> : screen === "tasks" ? <div className="cockpit-task-view">
          <div className="cockpit-heading"><div><span className="cockpit-eyebrow">GROUP STUDIO / WORK QUEUE</span><h1>{taskFilter === "automations" ? "定时任务" : "我的任务"}</h1><p>{taskFilter === "automations" ? "查看当前账号的定时定义；执行时刻与运行记录以 Center 为准。" : "按事项跟进进度、处理阻塞并查看交付；协作步骤在目标详情展开。"}</p></div><CockpitClock /></div>
          {!desktopApi ? <div className="cockpit-preview-note">本地交互预览：Runtime 任务为演示；Group 与定时来源未连接，不会伪造记录。</div> : null}
          <CockpitTaskWorkspace myTasks={myTasks} sources={sources} desktopApi={desktopApi} filter={taskFilter} onFilter={(filter) => openTasks(filter)} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} selectedAutomation={selectedAutomation} onOpenGoal={openGoal} onOpenAutomation={(item) => openTasks("automations", item)} />
        </div> : <>
        <div className="cockpit-heading"><div><div className="cockpit-product-name"><Sparkle size={22} aria-hidden="true" /><strong>Group Studio</strong></div><h1>个人驾驶舱</h1><CockpitClock compact /></div><button type="button" className="cockpit-primary" onClick={() => openGoal()}><Plus size={18} aria-hidden="true" />{desktopApi ? "新建目标" : "查看工作台布局"}</button></div>
        <div className="cockpit-overview-time"><div className="cockpit-employee-count"><span role="status">可用员工 <strong>{availableEmployeeCount ?? "—"}</strong>{availableEmployeeCount === null ? <small>{catalogPhase === "error" ? "暂时无法获取" : desktopApi ? "正在同步" : "未连接"}</small> : null}</span>{availableEmployees ? <CockpitEmployeeStack employees={availableEmployees} /> : null}</div></div>
        {!desktopApi ? <div className="cockpit-preview-note">交互预览数据：任务为本地演示，Group 目标及定时任务没有真实连接。</div> : null}
        <div className="cockpit-stats" aria-label="工作概览指标">
          <CockpitMetricCard data-tone="attention" onClick={() => openTasks("attention")}><span>待我处理</span><strong>{missingSources || loadingSources || loadingTasks ? "—" : attention.length}</strong><small>{missingSources ? "部分来源不可用" : "确认计划、检查交付与处理异常"}</small><i className="cockpit-stat-icon" aria-hidden="true"><WarningCircle size={26} /></i></CockpitMetricCard>
          <CockpitMetricCard data-tone="active" onClick={() => openTasks("active")}><span>正在执行</span><strong>{taskUnavailable || loadingTasks || sources.goalPhase !== "ready" ? "—" : overview.runningTasks.length + overview.runningGoals.length}</strong><small>当前页进行中的事项</small><i className="cockpit-stat-icon" aria-hidden="true"><SpinnerGap size={26} /></i></CockpitMetricCard>
          <CockpitMetricCard data-tone="neutral" onClick={() => openTasks("queued")}><span>排队等待</span><strong>{taskUnavailable || loadingTasks || sources.goalPhase !== "ready" ? "—" : overview.queuedTasks.length}</strong><small>查看队列与执行顺序</small><i className="cockpit-stat-icon" aria-hidden="true"><Clock size={26} /></i></CockpitMetricCard>
          <CockpitMetricCard data-tone="success" onClick={() => openTasks("recent")}><span>最近完成</span><strong>{taskUnavailable || loadingTasks || sources.goalPhase !== "ready" ? "—" : overview.completedTasks.length + overview.acceptedGoals.length}</strong><small>当前页已完成任务 · 查看结果</small><i className="cockpit-stat-icon" aria-hidden="true"><CheckCircle size={26} /></i></CockpitMetricCard>
        </div>
        <SubsystemConnections desktopApi={desktopApi} enabled={authenticated && bootstrapReady} />
        <div className="cockpit-columns"><div className="cockpit-primary-column">
          <Section title="待我处理" action={<button type="button" className="cockpit-text-link" onClick={() => openTasks("attention")}>全部待办 <ArrowRight size={14} aria-hidden="true" /></button>}>
            {missingSources ? <p className="cockpit-source-error"><WarningCircle size={17} />部分来源暂不可用，请刷新后查看。</p> : null}
            {attention.slice(0, 3).map((entry) => { const recordTime = cockpitRecordTime(entry); return <button className="cockpit-attention-row" data-tone={cockpitStatusTone(entry.kind === "goal" ? cockpitGoalStatus(entry.item) : entry.kind === "automation" ? entry.item.state : entry.item.status)} key={entry.key} type="button" onClick={() => entry.kind === "goal" ? openGoal(entry.item.goalId) : entry.kind === "automation" ? openTasks("automations", entry.item) : openTasks("attention", null, entry.item.id)}><span className="cockpit-row-icon"><WarningCircle size={18} /></span><span><strong>{entry.title}</strong><small>{entry.reason}</small>{recordTime ? <time dateTime={recordTime.value}>{recordTime.label} {compactTime(recordTime.value)}</time> : <small>记录时间暂不可用</small>}</span><span className="cockpit-attention-action">{entry.action}<ArrowRight size={17} aria-hidden="true" /></span></button>; })}
            {!attention.length && !missingSources && !loadingSources && !loadingTasks ? <Empty>当前没有需要你处理的事项。</Empty> : null}
            {!attention.length && (loadingSources || loadingTasks) ? <Empty>正在核对需要你处理的事项…</Empty> : null}
          </Section>
        </div><aside className="cockpit-right-column">
          <CockpitSentinel blue presentation={sentinelPresentation} authenticated={authenticated} taskPhase={myTasks.phase} tasks={myTasks.page.tasks} sources={sources} />
        </aside></div>
        <div className="cockpit-goals-region"><Section title="Group 目标" action={<button type="button" className="cockpit-text-link" onClick={() => openGoal()}>工作台 <ArrowRight size={14} /></button>}>
          {sources.goalPhase === "error" ? <Empty>Group 目标来源不可用，请刷新后查看。</Empty> : sources.goalPhase !== "ready" ? <Empty>正在同步 Group 目标…</Empty> : sources.goals.length ? <div className="cockpit-goal-list">{sources.goals.slice(0, 4).map(goal => {
            const status = cockpitGoalStatus(goal), progress = groupStepProgress(goal.projection);
            const time = cockpitRecordTime({ kind: "goal", item: goal });
            return <button key={goal.goalId} type="button" data-tone={cockpitStatusTone(status)} onClick={() => openGoal(goal.goalId)}><Sparkle size={20} aria-hidden="true" /><span><strong>{goal.title || "Group 目标"}</strong><small>{progress?.label || "步骤进度待同步"}{time ? ` · ${compactTime(time.value)}` : ""}</small>{progress ? <span className="cockpit-goal-progress" role="progressbar" aria-label="目标步骤进度" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}><span style={{ width: `${progress.percent}%` }} /></span> : null}</span><em>{runStatusLabel(status)}</em><ArrowRight size={16} aria-hidden="true" /></button>;
          })}</div> : <Empty>暂无 Group 目标。</Empty>}
        </Section></div>
        <div className="cockpit-planning-row">
          <Section title="接下来执行" action={<button type="button" className="cockpit-text-link" onClick={() => openTasks("automations")}>查看 <ArrowRight size={14} /></button>}>
            {sources.automationPhase === "error" ? <Empty>定时任务来源不可用。</Empty> : sources.automationPhase === "loading" ? <Empty>正在同步定时任务…</Empty> : upcoming.length ? <div className="cockpit-side-list">{upcoming.map(({rule: automation, time}) => <button type="button" key={automation.automationId} onClick={() => openTasks("automations", automation)}><Clock size={18} /><span><strong>{automationTaskTitle(automation, myTasks.page.tasks)}</strong><small>预计 {compactTime(time)} · {intervalLabel(automation.intervalSeconds)}</small></span><ArrowRight size={15} /></button>)}</div> : <Empty>暂无预计执行安排；可查看全部定时规则。</Empty>}
            <p className="cockpit-source-note">按当前周期推算，实际执行以运行记录为准。</p>
          </Section>
          <Section title="最近交付" action={<button type="button" className="cockpit-text-link" onClick={() => setScreen("content")}>我的内容 <ArrowRight size={14} /></button>}>
            <CockpitContentWorkspace compact sources={sources} myTasks={myTasks} employees={availableEmployees || []} desktopApi={desktopApi} onOpenGoal={openGoal} onOpenTask={taskId => openTasks("recent", null, taskId)} />
          </Section>
        </div>
        </>}
      </div>}
    </div>
    {authenticated && screen === "overview" ? <TaskActivityRail sources={sources} myTasks={myTasks} employees={bootstrapReady ? employees : []} onOpenGoal={openGoal} onOpenTasks={openTasks} /> : null}
  </main>;
}
