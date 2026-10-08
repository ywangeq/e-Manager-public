// A reviewer must be explicitly selected from the governed Skill catalog.
const selected = String(process.env.EMANAGER_REVIEWER_SKILL_ID || "").trim();
export const groupStudioRoleSkills = Object.freeze({
  reviewer: /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,159}$/.test(selected) ? selected : "",
});
