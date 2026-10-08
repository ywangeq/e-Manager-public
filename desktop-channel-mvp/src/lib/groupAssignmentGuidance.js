const key = "group-studio.assignment-guidance.v1";

export function hasSeenAssignmentGuidance() {
  try { return localStorage.getItem(key) === "seen"; } catch { return false; }
}

export function markAssignmentGuidanceSeen() {
  try { localStorage.setItem(key, "seen"); } catch { /* UI guidance remains optional when storage is unavailable. */ }
}
