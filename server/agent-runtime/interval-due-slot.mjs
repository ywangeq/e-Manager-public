// A process clock only supplies `now`; the persisted cursor owns progress.
export function latestIntervalSlot({ startAt, intervalSeconds, afterExclusive, throughInclusive }) {
  const start = Date.parse(startAt), after = Date.parse(afterExclusive), through = Date.parse(throughInclusive);
  if (![start, after, through].every(Number.isFinite) || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60) {
    throw new TypeError("interval_slot_invalid");
  }
  if (through < start || through <= after) return null;
  const slot = start + Math.floor((through - start) / (intervalSeconds * 1000)) * intervalSeconds * 1000;
  return slot > after ? new Date(slot).toISOString() : null;
}
