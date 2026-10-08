import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileText, ArrowClockwise, X } from "@phosphor-icons/react";
import { ArtifactDeliveryEntry } from "./ArtifactDeliveryEntry.jsx";
import { cockpitContentSource } from "../lib/cockpitContentSource.js";

function dateLabel(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "时间暂无记录";
}
function sizeLabel(value) {
  return Number.isFinite(value) ? value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB` : "—";
}

export function CockpitContentWorkspace({ sources, myTasks, employees, desktopApi, onOpenGoal, onOpenTask, compact = false }) {
  const [tab, setTab] = useState("outputs");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("date");
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState(0);
  const [materials, setMaterials] = useState({ items: [], phase: "loading" });
  const [artifactMetadata, setArtifactMetadata] = useState({});
  const materialReadRef = useRef(null);
  const employeeKey = employees.map(employee => employee.id).join("|");
  const taskKey = myTasks.page.tasks.filter(task => task.status === "completed").map(task => `${task.id}:${task.revision}`).join("|");
  useEffect(() => {
    if (compact) return undefined;
    let active = true;
    let request = 0;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      const sequence = ++request;
      inFlight = true;
      if (active) setMaterials(previous => ({ ...previous, phase: previous.phase === "ready" ? "ready" : "loading" }));
      if (!desktopApi?.listReusableArtifacts) { if (active) setMaterials({ items: [], phase: "error" }); inFlight = false; return; }
      let read = materialReadRef.current;
      if (!read || read.api !== desktopApi || read.employeeKey !== employeeKey) {
        read = { api: desktopApi, employeeKey, promise: null };
        read.promise = Promise.all(employees.map(employee => Promise.resolve().then(() => desktopApi.listReusableArtifacts({ employeeId: employee.id })).catch(() => ({ ok: false }))));
        materialReadRef.current = read;
        void read.promise.finally(() => { if (materialReadRef.current === read) materialReadRef.current = null; });
      }
      const results = await read.promise;
      inFlight = false;
      if (!active || sequence !== request) return;
      const unique = new Map(results.filter(result => result?.ok).flatMap(result => result.materials || []).filter(item => !item.expiresAt || Date.parse(item.expiresAt) > Date.now()).map(item => [item.grantId, item]));
      setMaterials({ items: [...unique.values()], phase: results.some(result => !result?.ok) ? "error" : "ready" });
    }
    void load();
    const timer = window.setInterval(load, 15_000);
    window.addEventListener("focus", load);
    return () => { active = false; request += 1; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [desktopApi, employeeKey, revision, sources.refreshRevision, compact]);
  useEffect(() => {
    const expiry = Math.min(...materials.items.map(item => Date.parse(item.expiresAt)).filter(value => Number.isFinite(value) && value > Date.now()));
    if (!Number.isFinite(expiry)) return undefined;
    const timer = window.setTimeout(() => setRevision(value => value + 1), Math.min(2147483647, Math.max(1, expiry - Date.now())));
    return () => window.clearTimeout(timer);
  }, [materials.items]);
  useEffect(() => {
    let active = true;
    async function load() {
      const completed = myTasks.phase === "ready" ? myTasks.page.tasks.filter(task => task.status === "completed") : [];
      const recent = compact ? [...completed].sort((a, b) => (Date.parse(b.finishedAt || b.updatedAt) || 0) - (Date.parse(a.finishedAt || a.updatedAt) || 0)).slice(0, 3) : completed;
      for (const task of recent) {
        if (!active) break;
        const cached = myTasks.details?.[task.id];
        if (cached?.phase === "ready" && !cached.stale && cached.listRevision === task.revision) continue;
        await myTasks.loadDetail?.(task);
      }
    }
    void load();
    return () => { active = false; };
  }, [taskKey, myTasks.loadDetail, revision, compact]);
  const outputs = useMemo(() => {
    const groupOutputs = !["error", "idle"].includes(sources.goalPhase) ? sources.goals.flatMap(goal => (goal.projection?.steps || []).flatMap(step => (step.artifacts || []).map(artifact => ({ ...artifact, key: `${step.taskId}:${artifact.artifactId}`, employeeId: step.employeeId, taskId: step.taskId, goalId: goal.goalId, source: goal.title || "Group 目标", time: goal.projection?.executionUpdatedAt })))) : [];
    const taskOutputs = !["error", "idle"].includes(myTasks.phase) ? myTasks.page.tasks.flatMap(task => myTasks.details?.[task.id]?.phase === "ready" ? (myTasks.details[task.id].detail?.artifacts || []).map(artifact => ({ ...artifact, key: `${task.id}:${artifact.artifactId}`, employeeId: task.employeeId, taskId: task.id, source: task.taskTitle || task.employeeName || "任务产出", time: task.finishedAt || task.updatedAt })) : []) : [];
    return [...new Map([...taskOutputs, ...groupOutputs].map(item => [item.key, item])).values()];
  }, [sources.goals, sources.goalPhase, myTasks.page, myTasks.details, myTasks.phase]);
  const outputKey = [...outputs].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).map(item => `${item.key}:${item.time || ""}`).join("|");
  useEffect(() => {
    let active = true;
    if (compact) setArtifactMetadata({});
    async function load() {
      const candidates = [...outputs].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
      for (const item of (compact ? candidates.slice(0, 3) : candidates).filter(item => compact || !item.fileName)) {
        if (!active) break;
        const result = await Promise.resolve().then(() => myTasks.inspectArtifact?.(item)).catch(() => ({ ok: false }));
        const verified = result?.ok && result.artifact && (!compact || result.artifact.artifactId === item.artifactId);
        if (active) setArtifactMetadata(current => ({ ...current, [item.key]: verified ? { ...result.artifact, verified: true } : { unavailable: true } }));
      }
    }
    void load();
    return () => { active = false; };
  }, [outputKey, taskKey, myTasks.inspectArtifact, revision, sources.refreshRevision, compact]);
  const rows = (tab === "outputs" ? outputs.map(item => ({ ...item, ...artifactMetadata[item.key], key: item.key, source: item.source, time: item.time })) : materials.items.map(item => ({ ...item, key: item.grantId, time: item.createdAt })))
    .map(item => ({ ...item, origin: cockpitContentSource(tab === "outputs" ? item : item.source, { tasks: myTasks.page.tasks, goals: sources.goalPhase === "ready" ? sources.goals : [], employees }) }))
    .filter(item => `${item.fileName || "任务产物"} ${item.origin.employeeName} ${item.origin.taskName} ${item.origin.context || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === "name" ? (a.fileName || "").localeCompare(b.fileName || "", "zh-CN") : (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  const hasError = tab === "materials" ? materials.phase === "error" : sources.goalPhase === "error" || myTasks.phase === "error" || Object.values(artifactMetadata).some(item => item.unavailable) || myTasks.page.tasks.some(task => myTasks.details?.[task.id]?.phase === "error");
  const detailTasks = compact ? [...myTasks.page.tasks].filter(task => task.status === "completed").sort((a, b) => (Date.parse(b.finishedAt || b.updatedAt) || 0) - (Date.parse(a.finishedAt || a.updatedAt) || 0)).slice(0, 3) : myTasks.page.tasks;
  const loading = tab === "materials" ? materials.phase === "loading" : sources.goalPhase === "loading" || myTasks.phase === "loading" || detailTasks.some(task => myTasks.details?.[task.id]?.phase === "loading");
  const previewRows = rows.filter(item => artifactMetadata[item.key]?.verified && !item.unavailable).slice(0, 3);
  const inspecting = compact && [...outputs].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).slice(0, 3).some(item => !artifactMetadata[item.key]);
  const selectedItem = rows.find(item => item.key === selected);
  if (compact) return <div className="cockpit-recent-deliveries">
    {hasError ? <p className="cockpit-source-note" role="status">部分交付来源暂不可用。</p> : null}
    {previewRows.map(item => <button className="cockpit-delivery-row" key={item.key} type="button" onClick={() => item.origin.goalId ? onOpenGoal(item.origin.goalId) : onOpenTask(item.taskId)}><FileText size={22} aria-hidden="true" /><span><strong>{item.fileName || "任务产物"}</strong><small>{item.origin.employeeName} · {item.origin.taskName}</small><time dateTime={item.time}>{dateLabel(item.time)}</time></span><ArrowRight size={15} aria-hidden="true" /></button>)}
    {!previewRows.length ? <p className="cockpit-empty">{loading || inspecting ? "正在同步交付…" : hasError ? "暂时无法完整获取交付。" : "当前已加载任务暂无产出物。"}</p> : null}
  </div>;
  return <section className="cockpit-content-workspace">
    <div className="cockpit-content-toolbar"><div role="tablist" aria-label="内容来源">{[["outputs", "任务产出"], ["materials", "已存材料"]].map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => { setTab(id); setSelected(""); }}>{label}</button>)}</div><input aria-label="搜索我的内容" placeholder="搜索名称或来源" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="内容排序" value={sort} onChange={event => setSort(event.target.value)}><option value="date">时间排序</option><option value="name">名称排序</option></select><button type="button" aria-label="刷新内容" title="刷新内容" onClick={() => { setRevision(value => value + 1); sources.refresh(); void myTasks.refresh(); }}><ArrowClockwise size={17} /></button></div>
    {hasError ? <p role="status" className="cockpit-source-error">部分内容来源暂不可用，当前仅显示已成功读取的内容。</p> : null}
    <div className={`cockpit-content-layout${selectedItem ? " has-detail" : ""}`}><div className="cockpit-content-list-pane"><div className="cockpit-content-table"><div className="cockpit-content-head"><span>名称</span><span>来源员工 / 任务</span><span>{tab === "materials" ? "保存时间" : "任务更新时间"}</span><span>大小</span><span /></div>
      {rows.map(item => <div key={item.key} className="cockpit-content-item"><div className="cockpit-content-row"><button type="button" aria-expanded={selected === item.key} onClick={() => setSelected(selected === item.key ? "" : item.key)}><FileText size={20} /><span><strong title={item.fileName || "任务产物"}>{item.fileName || "任务产物"}</strong></span></button><div className="cockpit-content-source"><strong>{item.origin.employeeName}</strong><small title={item.origin.taskName}>{item.origin.taskName}</small>{item.origin.context ? <small title={item.origin.context}>{item.origin.context}</small> : null}</div><time dateTime={item.time}>{dateLabel(item.time)}</time><span>{sizeLabel(item.sizeBytes)}</span>{item.origin.goalId || item.origin.taskLoaded ? <button type="button" title="查看来源任务" aria-label={`查看来源任务：${item.origin.taskName}`} onClick={() => item.origin.goalId ? onOpenGoal(item.origin.goalId) : onOpenTask(item.origin.taskId)}><ArrowRight size={16} /></button> : <span />}</div>
      </div>)}
    </div>
    {!rows.length ? <p className="cockpit-empty">{loading ? "正在同步内容…" : hasError ? "暂时无法完整获取内容。" : tab === "outputs" ? "当前已加载任务暂无产出物。" : "暂无已存材料。"}</p> : null}
    </div>{selectedItem ? <section className="cockpit-content-detail" aria-label="内容详情">
      <header><h2>{selectedItem.fileName || "任务产物"}</h2><button type="button" aria-label="收起内容详情" title="收起详情" onClick={() => setSelected("")}><X size={18} /></button></header>
      <dl><div><dt>来源员工</dt><dd>{selectedItem.origin.employeeName}</dd></div><div><dt>来源任务</dt><dd>{selectedItem.origin.taskName}</dd></div>{selectedItem.origin.context ? <div><dt>所属目标</dt><dd>{selectedItem.origin.context}</dd></div> : null}<div><dt>{tab === "materials" ? "保存时间" : "任务更新时间"}</dt><dd>{dateLabel(selectedItem.time)}</dd></div><div><dt>大小</dt><dd>{sizeLabel(selectedItem.sizeBytes)}</dd></div></dl>
      {selectedItem.origin.goalId || selectedItem.origin.taskLoaded ? <button type="button" className="cockpit-text-link" onClick={() => selectedItem.origin.goalId ? onOpenGoal(selectedItem.origin.goalId) : onOpenTask(selectedItem.origin.taskId)}>查看来源任务 <ArrowRight size={16} /></button> : null}
      {tab === "outputs" ? <ArtifactDeliveryEntry key={selectedItem.key} gate={{ employeeId: selectedItem.employeeId, taskId: selectedItem.taskId, artifactId: selectedItem.artifactId, ready: true }} onInspectArtifact={myTasks.inspectArtifact} onDeliverArtifact={myTasks.deliverArtifact} /> : <div className="cockpit-content-meta"><p>有效期至 {dateLabel(selectedItem.expiresAt)} · {selectedItem.mimeType}</p></div>}
    </section> : null}</div>
  </section>;
}
