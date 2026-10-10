import { FEISHU_CALENDAR_READ_DESCRIPTOR as contract } from "../shared/feishu-calendar-read-contract.mjs";

// Display of acknowledged reads or an encrypted account-scoped historical copy.
// Only the trusted main transport supplies results. Renderer may only read.
export function createFeishuCalendarProjection({ notify = () => {}, now = () => Date.now(), persist = () => false } = {}) {
  let context = null, snapshots = [], failed = false, cached = false;
  const same = value => context && value && ["actorKey", "actorVersion", "center", "associationGeneration"].every(key => value[key] === context[key]);
  return Object.freeze({
    acceptLocal(value, completed) {
      if(completed?.status!=="completed" || typeof completed.taskId!=="string" || !completed.taskId) return false;
      return this.accept(value,{claim:{toolId:contract.toolId,operationId:contract.operationId,input:completed.input},result:completed.result});
    },
    setContext(value) {
      if (same(value) || (!value && !context)) return;
      context = value ? Object.freeze({ ...value }) : null;
      snapshots = []; failed = false; cached = false; notify();
    },
    restore(value, saved) {
      if (!same(value) || snapshots.length || !Array.isArray(saved) || !saved.length || saved.length > 4) return false;
      try {
        const restored = saved.map(snapshot => ({...contract.normalizeInput(snapshotRange(snapshot)),
          fetchedAt: snapshot.fetchedAt, ...contract.normalizeResult({events:snapshot.events})}));
        if (restored.some(snapshot => !Number.isFinite(Date.parse(snapshot.fetchedAt)))) return false;
        snapshots = restored; cached = true; notify(); return true;
      } catch { return false; }
    },
    accept(value, { claim, result }) {
      if (!same(value) || claim.toolId !== contract.toolId || claim.operationId !== contract.operationId) return false;
      let range, data;
      try { range = contract.normalizeInput(claim.input); data = contract.normalizeResult(result); } catch { return false; }
      // Replace only the queried coverage, including a successful empty read.
      // A daily query must preserve the untouched parts of a weekly snapshot.
      snapshots = [...snapshots.flatMap(old => {
        if (Date.parse(old.end) <= Date.parse(range.start) || Date.parse(old.start) >= Date.parse(range.end)) return [old];
        return [
          ...(Date.parse(old.start) < Date.parse(range.start) ? [{ ...old, end: range.start }] : []),
          ...(Date.parse(old.end) > Date.parse(range.end) ? [{ ...old, start: range.end }] : []),
        ];
      }),
        { ...range, fetchedAt: new Date(now()).toISOString(), events: structuredClone(data.events) }].slice(-4);
      failed = false; cached = false;
      persist(value, structuredClone(snapshots));
      notify(); return true;
    },
    failed(value, claim) {
      if (!same(value) || claim.toolId !== contract.toolId || claim.operationId !== contract.operationId) return;
      failed = true; notify();
    },
    read(value) {
      if (!same(value)) return { ok: true, phase: "not_synced", snapshots: [] };
      if (failed) return { ok: true, phase: "unavailable", cached, snapshots: structuredClone(snapshots) };
      if (!snapshots.length) return { ok: true, phase: "not_synced", snapshots: [] };
      return { ok: true, cached, phase: cached || snapshots.some(snapshot => now() - Date.parse(snapshot.fetchedAt) > 15 * 60_000) ? "stale" : "ready", snapshots: structuredClone(snapshots) };
    },
  });
}

function snapshotRange(snapshot) { return {start:snapshot.start,end:snapshot.end}; }
