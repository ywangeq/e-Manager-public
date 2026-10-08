export const opsSeriesColors = ["#397cf6", "#0c9d80", "#e68b00", "#db5268", "#8658d8", "#0786a4", "#af6b3b", "#658832", "#be499b", "#5361b2", "#637381", "#a77b0c", "#8c959e"];

export function buildOpsTrendSeries(employees = [], metric = "submitted", names = new Map()) {
  const ranked = employees.map((employee) => ({ ...employee, total: employee.daily.reduce((sum, day) => sum + day[metric], 0) }))
    .filter((employee) => employee.total > 0)
    .sort((a, b) => b.total - a.total || a.employeeId.localeCompare(b.employeeId));
  const series = ranked.slice(0, 12).map((employee, i) => ({ id: employee.employeeId, label: names.get(employee.employeeId) || employee.employeeId,
    color: opsSeriesColors[i], values: employee.daily.map((day) => day[metric]) }));
  if (ranked.length > 12) series.push({ id: "__other__", label: "其他员工", color: opsSeriesColors[12],
    values: ranked[0].daily.map((_, i) => ranked.slice(12).reduce((sum, employee) => sum + employee.daily[i][metric], 0)) });
  return series;
}

export function groupOpsErrorCodes(errors = []) {
  const groups = errors.slice(0, 5);
  if (errors.length > 5) {
    const tail = errors.slice(5);
    const employees = new Map();
    for (const error of tail) for (const row of error.employees || []) employees.set(row.employeeId, (employees.get(row.employeeId) || 0) + row.count);
    groups.push({ code: "其他错误码", grouped: true, count: tail.reduce((sum, error) => sum + error.count, 0),
      employees: tail.every((error) => Array.isArray(error.employees)) ? [...employees].map(([employeeId, count]) => ({ employeeId, count })).sort((a, b) => b.count - a.count || a.employeeId.localeCompare(b.employeeId)) : undefined });
  }
  return groups;
}

export function formatOpsElapsed(ms) {
  if (!Number.isFinite(ms)) return "暂无";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${(ms / 60000).toFixed(1)} 分钟`;
}

// Separate arc paths keep each error segment's pointer hit area on its own stroke.
export function opsDonutArc(start, fraction) {
  const point = (turn) => [110 + 78 * Math.sin(turn * 2 * Math.PI), 110 - 78 * Math.cos(turn * 2 * Math.PI)];
  const a = point(start), b = point(start + fraction);
  if (fraction >= 1) return "M110,32 A78,78 0 1 1 110,188 A78,78 0 1 1 110,32";
  return `M${a.join(",")} A78,78 0 ${fraction > 0.5 ? 1 : 0} 1 ${b.join(",")}`;
}
