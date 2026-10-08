import { employeeRuntimeHealth } from "../../lib/digitalEmployeeHealth";
import { sortRuntimeTasksLatestFirst } from "../../lib/runtimeTasks";
import { useEmployeeRuntimeTasks } from "./EmployeeRuntimeTasksContext";

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const HEATMAP_WEEK_COUNT = 13;

function explicitNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function monthLabels(date = new Date()) {
  return [-2, -1, 0].map((offset) => {
    const month = new Date(date.getFullYear(), date.getMonth() + offset, 1).getMonth() + 1;
    return `${month}月`;
  });
}

function normalizeLevel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (parsed <= 4) return Math.round(parsed);
  if (parsed <= 10) return 1;
  if (parsed <= 25) return 2;
  if (parsed <= 60) return 3;
  return 4;
}

function normalizeActivitySource(value = {}) {
  const desktopCount = explicitNumber(value.desktopCount) || 0;
  const nonDesktopCount = explicitNumber(value.nonDesktopCount) || 0;
  if (desktopCount > 0 && nonDesktopCount > 0) return "mixed";
  if (desktopCount > 0) return "desktop";
  if (nonDesktopCount > 0) return "non-desktop";
  const channelId = String(value.channelId || "").trim().toLowerCase();
  const source = String(value.source || value.channelGroup || "").trim().toLowerCase();
  if (channelId === "desktop" || source === "desktop") return "desktop";
  if (source === "mixed") return "mixed";
  if (channelId || ["non_desktop", "non-desktop", "management_console", "web"].includes(source)) return "non-desktop";
  return "unknown";
}

function normalizeActivityCell(value = 0) {
  const item = value && typeof value === "object" ? value : { count: value };
  return {
    level: normalizeLevel(item.level ?? item.count ?? item.value),
    source: normalizeActivitySource(item),
    desktopCount: explicitNumber(item.desktopCount) || 0,
    nonDesktopCount: explicitNumber(item.nonDesktopCount) || 0,
  };
}

function emptyActivityGrid() {
  return Array.from({ length: 7 }, () => Array.from({ length: HEATMAP_WEEK_COUNT }, () => normalizeActivityCell()));
}

function normalizeActivityGrid(source = {}) {
  const grid = source.heatmap || source.activityHeatmap || source.dailyActivity || source.activityGrid;

  if (Array.isArray(grid) && Array.isArray(grid[0])) {
    return Array.from({ length: 7 }, (_, dayIndex) =>
      Array.from({ length: HEATMAP_WEEK_COUNT }, (_, weekIndex) => normalizeActivityCell(grid[dayIndex]?.[weekIndex]))
    );
  }

  if (Array.isArray(grid)) {
    const normalized = emptyActivityGrid();
    grid.forEach((item) => {
      const dayIndex = Number(item.dayIndex ?? item.dayOfWeek ?? item.weekday);
      const weekIndex = Number(item.weekIndex ?? item.week);
      if (!Number.isInteger(dayIndex) || !Number.isInteger(weekIndex)) return;
      if (dayIndex < 0 || dayIndex > 6 || weekIndex < 0 || weekIndex >= HEATMAP_WEEK_COUNT) return;
      normalized[dayIndex][weekIndex] = normalizeActivityCell(item);
    });
    return normalized;
  }

  return emptyActivityGrid();
}

function hasActivityData(source = {}) {
  const grid = source.heatmap || source.activityHeatmap || source.dailyActivity || source.activityGrid;
  if (!Array.isArray(grid)) return false;
  if (Array.isArray(grid[0])) {
    return grid.some((row) => Array.isArray(row) && row.some((value) => activityCount(value) > 0));
  }
  return grid.some((item) => activityCount(item) > 0);
}

function activityCount(value = 0) {
  const raw = value && typeof value === "object" ? value.level ?? value.count ?? value.value : value;
  const count = Number(raw);
  return Number.isFinite(count) ? count : 0;
}

function activityCellTitle(cell, dayIndex, weekIndex) {
  const position = `${WEEKDAY_LABELS[dayIndex]} 第 ${weekIndex + 1} 周`;
  if (!cell.level) return `${position}：无使用记录`;
  if (cell.source === "desktop") return `${position}：桌面端 ${cell.desktopCount ? `${cell.desktopCount} 次` : "已记录"}`;
  if (cell.source === "non-desktop") return `${position}：非桌面端 ${cell.nonDesktopCount ? `${cell.nonDesktopCount} 次` : "已记录"}`;
  if (cell.source === "mixed") return `${position}：桌面端 ${cell.desktopCount} 次，非桌面端 ${cell.nonDesktopCount} 次`;
  return `${position}：已记录使用，来源待补齐`;
}

function realUsageSource(employee = {}, runtimeEvidence = {}) {
  return employee.usageStats ||
    employee.activityStats ||
    employee.runtimeUsage ||
    runtimeEvidence.usageStats ||
    runtimeEvidence.runtimeUsage ||
    null;
}

function usageStats(employee = {}, runtimeEvidence = {}) {
  const source = realUsageSource(employee, runtimeEvidence) || {};
  const companionDays = explicitNumber(source.companionDays, employee.companionDays);
  const recentMessages = explicitNumber(source.recentMessages, source.messages, source.messageCount, employee.recentMessages);
  const completedTasks = explicitNumber(source.completedTasks, source.tasks, source.taskCount, employee.completedTasks);

  return {
    hasData: [companionDays, recentMessages, completedTasks].some((value) => value !== null) || hasActivityData(source),
    hasActivity: hasActivityData(source),
    windowLabel: source.windowLabel || "近 12 周",
    sourceLabel: source.sourceLabel || source.source || "运行事件",
    updatedAt: source.updatedAt || source.lastUpdatedAt || "",
    activityGrid: normalizeActivityGrid(source),
    metrics: [
      { label: "陪伴天数", value: companionDays },
      { label: "近期消息", value: recentMessages },
      { label: "完成任务", value: completedTasks },
    ],
  };
}

function EmployeeRuntimeHealthBlock({ employee, modelBinding, runtimeEvidence }) {
  const health = employeeRuntimeHealth(employee, modelBinding, runtimeEvidence);
  const usageSource = realUsageSource(employee, runtimeEvidence) || {};
  const desktopUserCount = explicitNumber(usageSource.desktopUserCount);

  return (
    <section className={`employee-runtime-health is-${health.overall.state}`} aria-label={`${employee.name} 运行健康`}>
      <div className="employee-runtime-health-head">
        <span>
          <strong>运行健康</strong>
          <small>{health.overall.detail}</small>
        </span>
        <b className={`status-pill ${health.overall.tone}`}>{health.overall.label}</b>
      </div>
      <div className="employee-runtime-health-list">
        {health.items.map((item) => (
          <span className={`employee-runtime-health-item is-${item.tone}`} key={item.id}>
            <strong>{item.label}</strong>
            <b>{item.value}</b>
            <small>{item.detail}</small>
          </span>
        ))}
        {desktopUserCount !== null ? (
          <span className="employee-runtime-health-item is-info">
            <strong>桌面端用户</strong>
            <b>{desktopUserCount} 人</b>
            <small>{usageSource.windowLabel || "当前统计窗口"}内完成桌面任务的去重用户数。</small>
          </span>
        ) : null}
      </div>
    </section>
  );
}

function RecentTaskSummary({ employee }) {
  const { state } = useEmployeeRuntimeTasks();

  const tasks = recentTasks(state.data?.tasks);
  const latestUpdatedAt = tasks[0]?.updatedAt || tasks[0]?.submittedAt || "";

  return (
    <section className="employee-recent-tasks" aria-label={`${employee.name} 最近任务`}>
      <div className="employee-recent-tasks-head">
        <span>
          <strong>最近任务</strong>
          <small>最近 5 条安全摘要</small>
        </span>
        {latestUpdatedAt ? <small>更新于 {formatShortTime(latestUpdatedAt)}</small> : null}
      </div>
      {state.status === "loading" ? <RecentTaskNotice title="正在读取最近任务" detail="" tone="muted" statusLabel="读取中" /> : null}
      {state.status === "error" ? <RecentTaskNotice title="最近任务暂时不可用" detail="稍后刷新后重试" tone="warn" statusLabel="暂不可用" /> : null}
      {state.status === "ready" && !tasks.length ? <RecentTaskNotice title="暂无任务记录" detail="完成数字员工任务后会在这里显示安全摘要" tone="muted" statusLabel="暂无" /> : null}
      {state.status === "ready" && tasks.length ? (
        <div className="employee-recent-task-list">
          {tasks.map((task) => {
            const presentation = taskPresentation(task);
            return (
              <div className="employee-recent-task-row" key={task.id}>
                <span className="employee-recent-task-copy">
                  <strong title={presentation.title}>{presentation.title}</strong>
                  <small title={presentation.detail}>{presentation.detail}</small>
                  <small className="employee-recent-task-meta">
                    <span>发起人：{presentation.actor}</span>
                    <span>{presentation.channel}</span>
                    <span>{formatShortTime(presentation.updatedAt)}</span>
                  </small>
                </span>
                <b className={`status-pill ${presentation.tone}`}>{presentation.statusLabel}</b>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function RecentTaskNotice({ title, detail, statusLabel, tone }) {
  return (
    <div className="employee-recent-task-row">
      <span className="employee-recent-task-copy">
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <b className={`status-pill ${tone}`}>{statusLabel}</b>
    </div>
  );
}

function recentTasks(tasks = []) {
  return sortRuntimeTasksLatestFirst(tasks).slice(0, 5);
}

function taskPresentation(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const statuses = {
    completed: { statusLabel: "已完成", tone: "good" },
    succeeded: { statusLabel: "已完成", tone: "good" },
    done: { statusLabel: "已完成", tone: "good" },
    failed: { statusLabel: "失败", tone: "bad" },
    error: { statusLabel: "失败", tone: "bad" },
    blocked: { statusLabel: "已阻断", tone: "warn" },
    canceled: { statusLabel: "已取消", tone: "muted" },
    cancelled: { statusLabel: "已取消", tone: "muted" },
    queue_full: { statusLabel: "队列已满", tone: "warn" },
    timeout: { statusLabel: "已超时", tone: "warn" },
    running: { statusLabel: "处理中", tone: "warn" },
    queued: { statusLabel: "排队中", tone: "info" },
    pending_remote_resource: { statusLabel: "待资源", tone: "warn" },
    pending_file_intake: { statusLabel: "待资料", tone: "warn" },
  };
  return {
    title: displayTaskTitle(task.taskTitle),
    detail: task.execution?.resultSummary || task.problemSummary || task.nextGate || "已记录一次数字员工任务。",
    actor: task.submittedBy?.displayName || task.submittedBy?.name || "姓名待解析",
    channel: channelLabel(task.trigger?.channel),
    updatedAt: task.updatedAt || task.submittedAt,
    ...(statuses[status] || { statusLabel: task.statusLabel || "已记录", tone: "muted" }),
  };
}

function displayTaskTitle(value) {
  return String(value || "数字员工任务").trim() === "飞书算法对话待分流" ? "飞书算法任务" : String(value || "数字员工任务");
}

function channelLabel(value) {
  if (value === "desktop") return "桌面端";
  if (value === "management_console") return "管理台";
  if (value === "feishu") return "飞书";
  return value || "受控入口";
}

function formatShortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function EmployeeUsageStatsPanel({ employee, modelBinding = employee.modelBinding, runtimeEvidence = employee.runtimeEvidence || {} }) {
  const usage = usageStats(employee, runtimeEvidence);
  const months = monthLabels();

  if (!usage.hasData) {
    return (
      <aside className="employee-usage-stats-card" aria-label={`${employee.name} 使用统计`}>
        <EmployeeRuntimeHealthBlock employee={employee} modelBinding={modelBinding} runtimeEvidence={runtimeEvidence} />

        <div className="employee-usage-head">
          <span>
            <strong>使用统计</strong>
            <small>{usage.windowLabel}</small>
          </span>
          <b>无数据</b>
        </div>

        <div className="employee-usage-empty">
          <strong>暂无真实使用数据</strong>
          <small>等待 Agent runtime 回流 usage events</small>
        </div>
        <RecentTaskSummary employee={employee} />
      </aside>
    );
  }

  return (
    <aside className="employee-usage-stats-card" aria-label={`${employee.name} 使用统计`}>
      <EmployeeRuntimeHealthBlock employee={employee} modelBinding={modelBinding} runtimeEvidence={runtimeEvidence} />

      <div className="employee-usage-head">
        <span>
          <strong>使用统计</strong>
          <small>{usage.windowLabel}</small>
        </span>
        <b>{usage.sourceLabel}</b>
      </div>

      <div className="employee-usage-metrics" aria-label="员工使用指标">
        {usage.metrics.map((item) => (
          <span key={item.label}>
            <strong>{item.value === null ? "暂无" : item.value}</strong>
            <small>{item.label}</small>
          </span>
        ))}
      </div>

      {usage.hasActivity ? (
        <div className="employee-usage-legend" aria-label="使用来源图例">
          <span><i className="source-desktop" />桌面端</span>
          <span><i className="source-non-desktop" />非桌面端</span>
          <span><i className="source-mixed" />两端都有</span>
        </div>
      ) : null}

      <div className="employee-usage-heatmap-wrap">
        <div className="employee-usage-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="employee-usage-heatmap" role="img" aria-label={`${employee.name} 近 12 周使用热力图`}>
          {usage.activityGrid.map((row, dayIndex) =>
            row.map((cell, weekIndex) => (
              <span
                className={`employee-usage-cell level-${cell.level} source-${cell.source}`}
                key={`${dayIndex}-${weekIndex}`}
                title={activityCellTitle(cell, dayIndex, weekIndex)}
              />
            ))
          )}
        </div>
        <div className="employee-usage-months" aria-hidden="true">
          {months.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>

      {usage.updatedAt ? <small className="employee-usage-updated">更新于 {usage.updatedAt}</small> : null}
      <RecentTaskSummary employee={employee} />
    </aside>
  );
}
