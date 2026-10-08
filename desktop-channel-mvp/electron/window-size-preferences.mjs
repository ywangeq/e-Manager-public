import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// Device-local presentation preference only; never contains identity or task data.
export function createWindowSizePreferences({ filePath, defaultSize, onFailure = () => {} }) {
  let current = { ...defaultSize };
  let pending = false;
  let timer = null;
  const normalize = (value) => {
    if (![value?.width, value?.height].every((n) => Number.isInteger(n) && n > 0 && n <= 32768)) return null;
    return { width: Math.max(defaultSize.width, value.width), height: Math.max(defaultSize.height, value.height) };
  };
  try {
    if (statSync(filePath).size <= 1024) {
      const saved = JSON.parse(readFileSync(filePath, "utf8"));
      if (saved.version === 1) current = normalize(saved) || current;
    }
  } catch { /* Missing or invalid preferences fall back to the default size. */ }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...current }), { mode: 0o600 });
      renameSync(temporaryPath, filePath);
      pending = false;
    } catch { onFailure(); }
  }

  return {
    read: () => ({ ...current }),
    remember(size) {
      const next = normalize(size);
      if (!next || (next.width === current.width && next.height === current.height)) return;
      current = next;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
      timer.unref?.();
    },
    flush,
  };
}
