import { History } from "lucide-react";

export default function PersonalEmployeeSchedulePanel() {
  return <section className="employee-cockpit-section employee-schedule-panel">
    <div className="employee-config-section-head employee-schedule-head"><History size={16}/><span>
      <strong>个人任务管理</strong><small>个人任务按用户管理，请在 Group Studio 查看。</small>
    </span></div>
    <p className="employee-schedule-empty">在 Group Studio 的定时任务中查看、设置和暂停你的任务。周历同步在本机同步设置中管理。</p>
  </section>;
}
