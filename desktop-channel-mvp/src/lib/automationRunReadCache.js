export const automationRunFingerprint = rule => JSON.stringify([rule.automationId, rule.employeeId,
  rule.sourceTaskId, rule.revision, rule.runCount, rule.lastTaskId]);

// Actor-local presentation cache; callers dispose it on auth/context changes.
export function createAutomationRunReadCache(readDetail, publish) {
  let alive = true, rules = new Map(), entries = new Map();
  const emit = () => { if (alive) publish(Object.fromEntries(entries)); };
  function update(nextRules) {
    rules = new Map(nextRules.map(rule => [rule.automationId, rule]));
    for (const [id, entry] of entries) {
      if (!rules.has(id) || entry.fingerprint !== automationRunFingerprint(rules.get(id))) entries.delete(id);
    }
    emit();
  }
  function read(id, { retry = false } = {}) {
    const rule = rules.get(id);
    if (!alive || !rule) return Promise.resolve();
    const previous = entries.get(id);
    if (previous && (previous.phase !== "error" || !retry)) return previous.promise || Promise.resolve();
    const entry = { fingerprint: automationRunFingerprint(rule), phase: "loading" };
    entries.set(id, entry);
    entry.promise = Promise.resolve().then(() => readDetail(id)).then(result => {
      if (!alive || entries.get(id) !== entry) return;
      if (!result?.ok || automationRunFingerprint(result.automation || {}) !== entry.fingerprint || !Array.isArray(result.runs)) throw new Error("automation_detail_changed");
      entries.set(id, { fingerprint: entry.fingerprint, phase: "ready", runs: result.runs });
      emit();
    }).catch(() => {
      if (!alive || entries.get(id) !== entry) return;
      entries.set(id, { fingerprint: entry.fingerprint, phase: "error" });
      emit();
    });
    emit();
    return entry.promise;
  }
  return { update, read, dispose() { alive = false; entries.clear(); rules.clear(); } };
}
