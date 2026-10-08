import { scheduleDescription, scheduleTimezoneLabel } from "../../lib/schedulePresentation";
import { CalendarPlus, History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchScheduleConfigurations } from "../../lib/digitalEmployeeSchedules";
import ScheduleStatus from "./ScheduleStatus";
import EmployeeScheduleSheet from "./EmployeeScheduleSheet";
export { employeeScheduleRecords } from "../../lib/digitalEmployeeSchedules";

export default function EmployeeSchedulePanel({ employee, isSystemAdmin = false, onScheduleChange = null }) {
  const [schedules, setSchedules] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sheet, setSheet] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!isSystemAdmin) { setLoading(false); return; }
    let current = true;
    setLoading(true); setError("");
    fetchScheduleConfigurations(employee.id).then(data => { if (current) setSchedules(data.schedules || []); })
      .catch(error => { if (current) setError(error.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [employee.id, isSystemAdmin, revision]);
  const visible = schedules.filter(item => statusFilter === "all" || (statusFilter === "active" ? item.state === "active" : item.state !== "active"));
  async function saved(result) {
    setRevision(value => value + 1);
    if (result.digitalEmployee) await onScheduleChange?.(result);
  }
  return <section className="employee-cockpit-section employee-schedule-panel">
    <div className="employee-config-section-head employee-schedule-head"><History size={16}/><span>
      <strong>系统定时任务</strong><small>由数字中心执行，默认使用该数字员工当前生效的模型、技能和工具配置。</small>
    </span></div>
    <div className="employee-schedule-toolbar">
      <span className="employee-schedule-counts"><b>{schedules.length}</b> 个任务<i/><b>{schedules.filter(item => item.state === "active").length}</b> 启用中</span>
      <select aria-label="筛选定时任务状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
        <option value="all">全部状态</option><option value="active">启用中</option><option value="paused">未启用 / 已暂停</option>
      </select>
      <button type="button" className="ghost-action" onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw size={14}/>刷新</button>
      {isSystemAdmin && <button type="button" className="ghost-action schedule-action" data-tone="blue" onClick={() => setSheet({})}><CalendarPlus size={15}/>新建定时任务</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {!isSystemAdmin ? <p>系统定时任务由管理员配置和查看。</p> : loading ? <p>正在读取任务…</p> : visible.length ?
      <div className="employee-schedule-table-shell"><table className="employee-schedule-grid-table">
        <thead><tr><th>任务</th><th>频率 / 时区</th><th>模型</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.scheduleId}>
          <td><strong>{item.configuration.title}</strong></td><td>{scheduleDescription(item.configuration.schedule)}<br/><small>{scheduleTimezoneLabel(item.configuration.timezone)}</small></td>
          <td>{item.modelSelection.mode === "employee_primary" ? "跟随员工当前主模型" : `专属分配：${item.modelSelection.assignmentId}`}</td>
          <td><ScheduleStatus state={item.state} emergencyStopped={item.emergencyStopped} controlSyncRequired={item.controlSyncRequired}/></td>
          <td><button type="button" className="ghost-action schedule-action" data-tone="blue" onClick={() => setSheet(item)}>配置与运行</button></td>
        </tr>)}</tbody>
      </table></div> : !error && <div className="employee-schedule-empty"><strong>暂无定时任务</strong><small>新建后先保存，再启用；可在任务详情中立即执行一次。</small></div>}
    {sheet && <EmployeeScheduleSheet employee={employee} schedule={sheet.scheduleId ? sheet : null} onClose={() => setSheet(null)} onRegistered={saved}/>}
  </section>;
}
