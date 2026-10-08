import { automationRunFingerprint } from "./automationRunReadCache.js";

// Only explicit rule/run identities establish membership; titles and sessions do not.
export function groupWorkbenchHistory(items = [], rules = [], details = {}) {
  const tasks = new Map(items.filter(item => item.kind === "employee").map(item => [item.taskId, item]));
  const groups = new Map(), owners = new Map();
  for (const rule of rules) {
    const source = tasks.get(rule.sourceTaskId);
    if (!source || source.employeeId !== rule.employeeId) continue;
    const key = `work-history:${source.taskId}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, kind: "work-history", source, rules: [], children: [source] });
    group.rules.push(rule);
    const detail = details[rule.automationId];
    if (detail?.phase !== "ready" || detail.fingerprint !== automationRunFingerprint(rule)) continue;
    for (const run of detail.runs) {
      const child = tasks.get(run.taskId);
      if (!child || child.employeeId !== rule.employeeId || child.sourceSystemId !== "personal-automation") continue;
      const owned = owners.get(child.taskId);
      if (owned && owned !== key) owners.set(child.taskId, null);
      else if (!owners.has(child.taskId)) owners.set(child.taskId, key);
    }
  }
  // A source belonging to another group or conflicting rules remains a normal card.
  const sources = new Set([...groups.values()].map(group => group.source.taskId));
  for (const [id, key] of owners) {
    if (key && !sources.has(id)) groups.get(key).children.push(tasks.get(id));
    else owners.delete(id);
  }
  const output = [], emitted = new Set();
  const bySource = new Map([...groups.values()].map(group => [group.source.taskId, group]));
  for (const item of items) {
    if (item.kind === "automation") continue;
    const group = bySource.get(item.taskId) || groups.get(owners.get(item.taskId));
    if (!group) { output.push(item); continue; }
    if (!emitted.has(group.key)) { output.push(group); emitted.add(group.key); }
  }
  for (const group of groups.values()) group.children.sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0));
  return output;
}
