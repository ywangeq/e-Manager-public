const PREFIX = "digitalWorkforce.";

export function readJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(`${PREFIX}${key}`);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    window.localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Local demo state is best-effort only.
  }
}

export function removeItem(key) {
  try {
    window.localStorage.removeItem(`${PREFIX}${key}`);
  } catch {
    // Ignore localStorage failures in private/restricted browser modes.
  }
}
