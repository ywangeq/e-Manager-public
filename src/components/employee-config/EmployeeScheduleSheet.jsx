import ScheduleTimeFields from "./ScheduleTimeFields";
import ScheduleStatus from "./ScheduleStatus";
import { CalendarClock, Pause, Play, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { changeScheduleActivation, fetchScheduleRuns, runScheduleNow, saveScheduleConfiguration,
  createScheduleRequestToken, scheduleRunArtifactUrl, scheduleStateLabel, fetchScheduleConfiguration, updateScheduleEmergencyStop } from "../../lib/digitalEmployeeSchedules";

export default function EmployeeScheduleSheet({ employee, schedule, onClose, onRegistered }) {
  const [record, setRecord] = useState(schedule);
  const [scheduleId] = useState(() => schedule?.scheduleId || `schedule-${createScheduleRequestToken()}`);
  const [config, setConfig] = useState(schedule?.configuration || { title: "", taskInstruction: "", schedule: "0 9 * * *",
    timezone: "Asia/Shanghai", timeoutSeconds: 600, maxConcurrentRuns: 1, overlapWindowMinutes: 5 });
  const [assignment, setAssignment] = useState(schedule?.modelSelection?.assignmentId || "");
  const [tab, setTab] = useState("configuration");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [runs, setRuns] = useState([]);
  const [runError, setRunError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const manualToken = useRef(null);
  const closeRef = useRef(null);
  const portalTarget = document.querySelector(".console-shell") || document.body;
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const escape = event => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  useEffect(() => {
    if (!record || tab !== "runs") return;
    let current = true;
    const refresh = () => fetchScheduleRuns(employee.id, scheduleId).then(data => {
      if (current) { setRuns(data.runs || []); setRunError(""); }
    }).catch(error => { if (current) setRunError(error.message); });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [employee.id, scheduleId, Boolean(record), tab, revision]);
  function edit(key, value) { setConfig(current => ({ ...current, [key]: value })); setDirty(true); }
  async function perform(action) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if (result.configuration) { setRecord(result); setConfig(result.configuration); setDirty(false); }
      await onRegistered?.(result);
      return result;
    } catch (error) { setError(error.message || "操作失败，请刷新后重试"); }
    finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    const result = await perform(() => saveScheduleConfiguration(employee.id, scheduleId, {
      expectedRegistrationVersion: record?.registrationVersion || 0, expectedControlVersion: record?.controlVersion || 0,
      configuration: config, ...(assignment ? { modelAssignmentId: assignment } : {}),
    }));
    if (result) setNotice(result.controlSyncRequired ? "任务已登记，但运行配置尚未同步；启用时会重新校验。" : "已保存。启用后按计划执行。");
  }
  async function toggle() {
    const result = await perform(() => changeScheduleActivation(employee.id, scheduleId,
      record.state === "active" ? "pause" : "activate", record.controlVersion));
    if (result) setNotice(result.state === "active" ? "已启用。运行记录可在本面板和任务监控中查看。" : "已暂停定时触发，仍可立即执行一次。");
  }
  async function runNow() {
    manualToken.current ||= createScheduleRequestToken();
    const result = await perform(() => runScheduleNow(employee.id, scheduleId, record.controlVersion, manualToken.current));
    if (result) {
      manualToken.current = null; setNotice(`本次运行：${scheduleStateLabel(result.state)}`);
      setTab("runs"); setRevision(value => value + 1);
    }
  }
  async function emergencyStop(event) {
    event.preventDefault();
    const result = await perform(async () => {
      await updateScheduleEmergencyStop(employee.id, scheduleId, { expectedControlVersion: record.controlVersion,
        engaged: !record.emergencyStopped, reasonCode: record.emergencyStopped ? "review_complete" : "owner_request", safeReason: stopReason });
      return fetchScheduleConfiguration(employee.id, scheduleId);
    });
    if (result) { setStopOpen(false); setStopReason(""); setNotice(result.emergencyStopped ? "已急停，后台将取消未完成运行。" : "已解除急停，任务仍需重新启用。"); }
  }
  const editable = !record || ["registered", "paused"].includes(record.state);
  return createPortal(<div className="employee-schedule-sheet-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
    <aside className="employee-schedule-sheet" role="dialog" aria-modal="true" aria-label={record ? `${config.title} 定时任务` : "新建定时任务"}>
      <header className="employee-schedule-sheet-head"><span className="employee-schedule-sheet-icon"><CalendarClock size={18}/></span>
        <span><strong>{record ? config.title : "新建定时任务"}</strong><small>{employee.name} · {record ? <ScheduleStatus state={record.state} emergencyStopped={record.emergencyStopped} controlSyncRequired={record.controlSyncRequired}/> : "保存后启用"}</small></span>
        <button ref={closeRef} type="button" className="employee-schedule-sheet-close" onClick={onClose} aria-label="关闭定时任务详情"><X size={17}/></button>
      </header>
      <nav className="employee-schedule-sheet-tabs" aria-label="定时任务详情标签">
        <button type="button" className={tab === "configuration" ? "is-active" : ""} onClick={() => setTab("configuration")}>任务配置</button>
        <button type="button" disabled={!record} className={tab === "runs" ? "is-active" : ""} onClick={() => setTab("runs")}>运行记录</button>
      </nav>
      {tab === "configuration" ? <form className="employee-schedule-register-form" onSubmit={save}>
        {!editable && <p>修改配置前请先暂停任务。正在执行的任务结束后即可保存。</p>}
        <label className="employee-schedule-form-row"><span>任务名称</span><input required maxLength={160} value={config.title} disabled={!editable || busy} onChange={event => edit("title", event.target.value)}/></label>
        <label className="employee-schedule-form-row"><span>执行要求</span><textarea required rows={7} maxLength={16384} value={config.taskInstruction} disabled={!editable || busy}
          placeholder="说明需要完成的工作、范围及总结要求；具体操作流程由员工已挂载的 Skill 提供。" onChange={event => edit("taskInstruction", event.target.value)}/></label>
        <ScheduleTimeFields expression={config.schedule} timezone={config.timezone} disabled={!editable || busy} onChange={value => edit("schedule", value)}/>
        <div className="employee-schedule-sheet-fields">
          <label className="employee-schedule-form-row"><span>时区</span><input required value={config.timezone} disabled={!editable || busy} onChange={event => edit("timezone", event.target.value)}/></label>
          <label className="employee-schedule-form-row"><span>运行时限（秒）</span><input type="number" required min={1} max={86400} value={config.timeoutSeconds} disabled={!editable || busy} onChange={event => edit("timeoutSeconds", Number(event.target.value))}/></label>
          <label className="employee-schedule-form-row"><span>最大同时运行数</span><input type="number" required min={1} max={100} value={config.maxConcurrentRuns} disabled={!editable || busy} onChange={event => edit("maxConcurrentRuns", Number(event.target.value))}/></label>
        </div>
        <label className="employee-schedule-form-row"><span>模型</span><select value={assignment} disabled={!editable || busy} onChange={event => { setAssignment(event.target.value); setDirty(true); }}>
          <option value="">跟随员工当前主模型</option>{schedule?.modelSelection?.assignmentId && <option value={schedule.modelSelection.assignmentId}>专属分配：{schedule.modelSelection.assignmentId}</option>}
        </select><small>每次开始新运行时读取当前配置；同一次运行和恢复过程使用开始时的版本。</small></label>
        <button type="submit" className="ghost-action schedule-action" data-tone="blue" disabled={!editable || busy}><Save size={15}/>保存任务</button>
      </form> : <div className="employee-schedule-sheet-body">
        <button type="button" className="ghost-action" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/>刷新运行记录</button>
        {runError && <p role="alert">{runError}</p>}
        {runs.length ? <table className="employee-schedule-grid-table"><thead><tr><th>触发时间</th><th>来源</th><th>状态</th><th>总结</th></tr></thead><tbody>
          {runs.map(run => <tr key={run.runId}><td>{new Date(run.scheduledFor).toLocaleString("zh-CN", { timeZone: record.configuration.timezone })}</td>
            <td>{run.source === "manual" ? "立即执行" : "定时触发"}</td><td><ScheduleStatus state={run.observedTaskStatus || run.state}/></td>
            <td>{run.artifacts?.length ? run.artifacts.map(artifact => <a key={artifact.artifactId} href={scheduleRunArtifactUrl(employee.id, scheduleId, run.runId, artifact.artifactId)} download>下载总结</a>) : "—"}</td></tr>)}
        </tbody></table> : <p>暂无运行记录。启用后等待计划时间，或点击立即执行。</p>}
      </div>}
      <footer className="employee-schedule-actions-footer">
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        {record?.emergencyStopped && <p role="alert">此任务已急停，需先完成运行控制复核。</p>}
        {record && <div className="employee-schedule-register-actions">
          <button type="button" className="ghost-action schedule-action" data-tone={record.state === "active" ? "yellow" : "blue"} disabled={busy || dirty || record.emergencyStopped} onClick={toggle}>
            {record.state === "active" ? <Pause size={15}/> : <Play size={15}/>} {record.state === "active" ? "暂停任务" : "启用任务"}</button>
          <button type="button" className="ghost-action schedule-action" data-tone="blue" disabled={busy || dirty || record.emergencyStopped || !["active", "paused"].includes(record.state)} onClick={runNow}><Play size={15}/>立即执行</button>
          <button type="button" className="ghost-action schedule-action" data-tone="red" disabled={busy || dirty} onClick={() => setStopOpen(value => !value)}>{record.emergencyStopped ? "解除急停" : "急停"}</button>
        </div>}
        {stopOpen && <form className="employee-schedule-control-form" onSubmit={emergencyStop}>
          <label><span>{record.emergencyStopped ? "复核说明" : "急停原因"}</span><textarea required maxLength={300} value={stopReason} onChange={event => setStopReason(event.target.value)}/></label>
          <button className="ghost-action schedule-action" data-tone="red" type="submit" disabled={busy}>确认{record.emergencyStopped ? "解除急停" : "急停"}</button>
        </form>}
      </footer>
    </aside>
  </div>, portalTarget);
}
