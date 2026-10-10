import { smoothTrendPath } from "../lib/smoothTrend.js";
import { useEffect, useMemo, useState } from "react";
import { requestOpsRuntimeTaskAnalytics } from "../lib/opsIncidents";
import { buildOpsTrendSeries, formatOpsElapsed, groupOpsErrorCodes, opsDonutArc, opsSeriesColors } from "../lib/opsTaskAnalytics";
import "../styles/ops-task-analytics.css";
import OpsChartTooltip from "./OpsChartTooltip";

const metricLabels = { submitted: "创建量", completed: "成功量", failed: "失败量" };
const count = (value) => value.toLocaleString("zh-CN");
const percent = (value) => value === null ? "暂无" : `${(value * 100).toFixed(1)}%`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export default function OpsTaskAnalyticsPanel({ employees = [] }) {
  const [days, setDays] = useState(7);
  const [endDate, setEndDate] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [metric, setMetric] = useState("submitted");
  const [selectedDate, setSelectedDate] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null });
  const names = useMemo(() => new Map(employees.map((employee) => [employee.id, employee.name || employee.id])), [employees]);
  useEffect(() => {
    let current = true;
    setState({ status: "loading", data: null });
    setSelectedDate("");
    requestOpsRuntimeTaskAnalytics({ days, endDate, employeeId })
      .then((data) => { if (current) setState({ status: "ready", data }); })
      .catch(() => { if (current) setState({ status: "error", data: null }); });
    return () => { current = false; };
  }, [days, endDate, employeeId, refresh]);
  const data = state.data;
  const detail = data?.daily.find((day) => day.date === selectedDate) || data?.summary;
  const series = buildOpsTrendSeries(data?.employees, metric, names);
  const employeeOptions = new Map(names);
  for (const row of data?.employees || []) if (!employeeOptions.has(row.employeeId)) employeeOptions.set(row.employeeId, row.employeeId);

  return (
    <section className="ops-analytics" aria-label="每日任务统计">
      <div className="panel ops-analytics-trend">
        <div className="panel-head">
          <div><p className="eyebrow">Daily activity</p><h2>每日任务趋势</h2></div>
          <div className="ops-analytics-filters">
            <label>范围<select value={days} onChange={(event) => setDays(Number(event.target.value))}>{[7, 14, 30].map((value) => <option key={value} value={value}>最近 {value} 天</option>)}</select></label>
            <label>截至<input type="date" aria-label="统计截止日期" value={endDate || today()} max={today()} onInput={(event) => setEndDate(event.currentTarget.value)} /></label>
            <label>员工<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">全部员工</option>{[...employeeOptions].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={state.status === "loading"}>刷新</button>
          </div>
        </div>
        <div className="ops-analytics-toolbar">
          <div className="ops-analytics-segments" aria-label="趋势指标">{Object.entries(metricLabels).map(([key, label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div>
          <span>每天一个点 · 上海时间 · 点击日期查看当日分布</span>
        </div>
        {state.status === "loading" ? <p className="ops-analytics-empty" role="status">正在读取真实任务统计…</p> : null}
        {state.status === "error" ? <p className="ops-analytics-empty" role="alert">每日统计读取失败，请刷新重试。</p> : null}
        {data ? <>
          <DailyTrend daily={data.daily} series={series} metric={metric} selectedDate={selectedDate} onSelect={setSelectedDate} />
          <p className="ops-boundary-note">创建量按创建日期；成功/失败按结束日期，跨日任务分别归属。今日尚未结束；历史任务以当前保留记录为准。</p>
          <div className="ops-analytics-selection"><strong>{selectedDate || `${data.coverage.startDate} 至 ${data.coverage.endDate}`} · {selectedDate ? "当日明细" : "区间汇总"}</strong>{selectedDate ? <button type="button" onClick={() => setSelectedDate("")}>返回区间汇总</button> : null}<small>以下两图共用此范围和员工筛选</small></div>
          <div className="ops-analytics-summary" aria-label="所选范围统计">
            <span>创建 <b>{count(detail.submitted)}</b></span><span>已结束 <b>{count(detail.terminal)}</b></span><span>成功 <b>{count(detail.completed)}</b></span><span>失败 <b>{count(detail.failed)}</b></span><span>阻断 <b>{count(detail.blocked)}</b></span><span>取消 <b>{count(detail.canceled)}</b></span><span>失败率 <b>{percent(detail.failureRate)}</b><small>占已结束任务</small></span>
          </div>
        </> : null}
      </div>
      {detail ? <div className="ops-analytics-distributions">
        <ErrorDistribution key={`${data.coverage.sourceAsOf}:${selectedDate}`} summary={detail} names={names} />
        <DurationDistribution duration={detail.duration} />
      </div> : null}
      {data ? <p className="ops-boundary-note ops-analytics-coverage">仅统计 Runtime 完整任务，不代表模型 HTTP 请求。失败含失败、丢失和超时；阻断与取消单列。{detail.fallbackTimestampCount ? ` ${detail.fallbackTimestampCount} 条缺失或非法结束时间的任务按更新时间归日，耗时不补零。` : ""} 更新于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(data.coverage.sourceAsOf))}。</p> : null}
    </section>
  );
}

export function DailyTrend({ daily, series, metric, selectedDate, onSelect }) {
  const [hidden, setHidden] = useState([]);
  const [hoveredDate, setHoveredDate] = useState("");
  const visible = series.filter((item) => !hidden.includes(item.id));
  const width = 1080, height = 250, left = 54, right = 18, top = 18, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const peak = visible.reduce((max, item) => item.values.reduce((value, next) => Math.max(value, next), max), 1);
  const step = Math.max(1, Math.ceil(peak / 4));
  const ceiling = step * 4;
  const x = (i) => left + i / Math.max(1, daily.length - 1) * plotWidth;
  const y = (value) => top + plotHeight * (1 - value / ceiling);
  const focusDate = hoveredDate || selectedDate;
  const focusIndex = daily.findIndex((day) => day.date === focusDate);
  const tooltip = (day, index) => <><strong>{day.date} · {metricLabels[metric]}</strong><ul>{visible.map((item) => <li key={item.id}><i style={{ background: item.color }} /><span>{item.label}</span><b>{count(item.values[index])} 次</b></li>)}</ul>{!visible.length ? <p>所有员工曲线已隐藏</p> : null}</>;
  return <>
    <div className="ops-analytics-legend" aria-label="点击图例显示或隐藏员工">{series.map((item) => <button key={item.id} type="button" aria-pressed={!hidden.includes(item.id)} onClick={() => setHidden((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])}><i style={{ background: item.color }} />{item.label}</button>)}</div>
    {!series.length ? <p className="ops-analytics-empty">所选范围暂无{metricLabels[metric]}记录。</p> : <div className="ops-analytics-chart-scroll">
      <svg className="ops-analytics-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`每日${metricLabels[metric]}，按数字员工区分`}>
        <title>每日{metricLabels[metric]}，最多展示前 12 位员工，其余合并</title>
        {Array.from({ length: 5 }, (_, i) => <g key={i}><line x1={left} x2={width - right} y1={y(i * step)} y2={y(i * step)} className="ops-analytics-grid" /><text x={left - 10} y={y(i * step) + 4} textAnchor="end">{count(i * step)}</text></g>)}
        {daily.map((day, i) => <g key={day.date}><line x1={x(i)} x2={x(i)} y1={top} y2={height - bottom} className="ops-analytics-grid" />{(daily.length <= 14 || i % 3 === 0 || i === daily.length - 1) ? <text x={x(i)} y={height - 9} textAnchor="middle">{day.date.slice(5)}</text> : null}</g>)}
        {visible.map((item) => <g key={item.id}><path fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d={smoothTrendPath(item.values.map((value, i) => ({ x: x(i), y: Number.isFinite(value) ? y(value) : NaN })))} />{item.values.map((value, i) => <circle key={i} cx={x(i)} cy={y(value)} r="3" fill="white" stroke={item.color} strokeWidth="1.5" />)}</g>)}
        {daily.map((day, i) => <OpsChartTooltip key={`${metric}:${day.date}`} content={tooltip(day, i)} onOpenChange={(open) => setHoveredDate(open ? day.date : "")}>
          {(props) => <rect {...props} aria-label={`${day.date} ${metricLabels[metric]}详情`} x={Math.max(left, x(i) - plotWidth / Math.max(1, daily.length - 1) / 2)} y={top} width={plotWidth / Math.max(1, daily.length - 1) * (i === 0 || i === daily.length - 1 ? 0.5 : 1)} height={plotHeight} fill={focusDate === day.date ? "rgba(57,124,246,0.08)" : "transparent"} onClick={() => onSelect(day.date)} />}
        </OpsChartTooltip>)}
      </svg>
    </div>}
    <div className="ops-analytics-day-detail" aria-live="polite">{focusIndex >= 0 ? <><b>{focusDate}</b>{visible.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.label} {count(item.values[focusIndex])}</span>)}</> : <span>悬停查看每天的员工任务量；点击下方日期也可选择当天。</span>}</div>
    <div className="ops-analytics-dates" aria-label="选择一天查看分布">{daily.map((day, i) => <OpsChartTooltip key={`${metric}:${day.date}`} content={tooltip(day, i)}>{(props) => <button {...props} type="button" aria-label={`${day.date} ${metricLabels[metric]} ${day[metric]} 次，查看分布`} aria-pressed={selectedDate === day.date} onClick={() => onSelect(day.date)}>{day.date.slice(5)}</button>}</OpsChartTooltip>)}</div>
  </>;
}

export function ErrorDistribution({ summary, names = new Map() }) {
  const errors = groupOpsErrorCodes(summary.errors);
  const tooltip = (error) => <><strong>{error.grouped ? "其他错误码合计" : error.code}</strong><p>{count(error.count)} 次 · 占失败任务 {percent(error.count / summary.failed)}</p>
    {error.employees?.length ? <ul>{error.employees.map((row) => <li key={row.employeeId}><span>{names.get(row.employeeId) || row.employeeId || "未知员工"}</span><b>{count(row.count)} 次</b></li>)}</ul> : <p>当前统计未提供员工明细</p>}
  </>;
  let accumulated = 0;
  return <article className="panel ops-analytics-error"><div className="panel-head"><div><p className="eyebrow">Failure breakdown</p><h2>错误码占比</h2></div><span className="status-pill muted">分母：失败任务</span></div>
    {!summary.failed ? <p className="ops-analytics-empty">暂无失败任务</p> : <div className="ops-analytics-donut-layout">
      <svg viewBox="0 0 220 220" role="img" aria-label={`${count(summary.failed)} 个失败任务的错误码分布`}>
        <title>错误码占失败任务的比例</title>
        {errors.map((error, i) => {
          const fraction = error.count / summary.failed;
          const offset = accumulated;
          accumulated += fraction;
          return <OpsChartTooltip key={error.code} content={tooltip(error)}>{(props) => <path {...props} d={opsDonutArc(offset, fraction)} fill="none" stroke={opsSeriesColors[i]} strokeWidth="30" aria-label={`${error.code}，${count(error.count)} 次，查看员工`} />}</OpsChartTooltip>;
        })}
        <text className="ops-analytics-donut-total" x="110" y="108" textAnchor="middle">{count(summary.failed)}</text><text x="110" y="132" textAnchor="middle">失败任务</text>
      </svg>
      <ul className="ops-analytics-error-list">{errors.map((error, i) => <li key={error.code}><OpsChartTooltip content={tooltip(error)}>{(props) => <button {...props} type="button" className="ops-analytics-error-trigger" aria-label={`${error.code}，查看涉及员工`}><i style={{ background: opsSeriesColors[i] }} /><span>{error.code}</span><b>{count(error.count)}</b><small>{percent(error.count / summary.failed)}</small></button>}</OpsChartTooltip></li>)}</ul>
    </div>}
    <p className="ops-boundary-note">前 5 类错误码，其余合并为“其他”。治理阻断和取消不计入失败。</p>
  </article>;
}

export function DurationDistribution({ duration }) {
  const peak = Math.max(1, ...duration.buckets.map((bucket) => bucket.count));
  const step = Math.max(1, Math.ceil(peak / 4));
  const ceiling = step * 4;
  return <article className="panel ops-analytics-duration"><div className="panel-head"><div><p className="eyebrow">Task duration</p><h2>任务耗时分布</h2></div><span className="status-pill muted">已结束任务</span></div>
    <div className="ops-analytics-duration-metrics"><span>P50 <b>{formatOpsElapsed(duration.p50Ms)}</b></span><span>P95 <b>{formatOpsElapsed(duration.p95Ms)}</b></span><span>样本 <b>{count(duration.sampleCount)}</b></span></div>
    {!duration.sampleCount ? <p className="ops-analytics-empty">暂无有效耗时样本</p> : <div className="ops-analytics-chart-scroll"><svg className="ops-analytics-histogram" viewBox="0 0 600 240" role="img" aria-label="完整任务耗时区间与任务数">
      <title>已结束任务从创建到结束的耗时分布，包含排队、等待和重试</title>
      {Array.from({ length: 5 }, (_, i) => <g key={i}><line x1="45" x2="588" y1={195 - i * 42} y2={195 - i * 42} className="ops-analytics-grid" /><text x="35" y={199 - i * 42} textAnchor="end">{count(i * step)}</text></g>)}
      {duration.buckets.map((bucket, i) => <g key={bucket.label}><rect x={61 + i * 88} y={195 - bucket.count / ceiling * 168} width="44" height={bucket.count / ceiling * 168} rx="3" fill="#397cf6"><title>{bucket.label}：{count(bucket.count)} 个任务，{percent(bucket.count / duration.sampleCount)}</title></rect><text x={83 + i * 88} y={187 - bucket.count / ceiling * 168} textAnchor="middle">{count(bucket.count)}</text><text x={83 + i * 88} y="219" textAnchor="middle">{bucket.label}</text></g>)}
    </svg></div>}
    <p className="ops-boundary-note">创建至结束，含排队、等待及重试；区间含下限、不含上限。缺失 {duration.missingCount} 条，非法 {duration.invalidCount} 条，均不补零。</p>
  </article>;
}
