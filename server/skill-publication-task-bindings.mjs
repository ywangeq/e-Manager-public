import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveDigitalWorkforceDataDir } from "./local-data-root.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function root() { return path.join(resolveDigitalWorkforceDataDir(), "skill-publication-bindings"); }
function key(task) {
  if (!task?.taskId || !task?.tenantScope || !task?.inputDigest) throw new Error("skill_task_binding_invalid");
  return hash(JSON.stringify([task.tenantScope, task.taskId, task.inputDigest]));
}
function immutableWrite(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o400);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, filename); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const directory = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    for (const parent of [root(), path.dirname(root())]) {
      const fd = fs.openSync(parent, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Prepared before canonical queue insertion. An orphan binding grants no execution;
// replay always keeps the first binding. No timestamps or mutable heads select a version.
export function bindTaskSkillPublications(task, skills) {
  const target = path.join(root(), "tasks", key(task));
  if (fs.existsSync(target)) return readTaskSkillPublications(task);
  const references = skills.map((skill) => {
    const bytes = Buffer.from(JSON.stringify(skill));
    const digest = hash(bytes);
    immutableWrite(path.join(root(), "snapshots", digest), bytes);
    return { skillId: skill.id, version: skill.version || "", publicationId: skill.mvpPublication?.publicationId || "", digest };
  });
  immutableWrite(target, Buffer.from(JSON.stringify({ contractVersion: "skill-publication-task-binding.v1", taskBinding: key(task), references })));
  return readTaskSkillPublications(task);
}

export function readTaskSkillPublications(task) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root(), "tasks", key(task)), "utf8"));
    if (value.contractVersion !== "skill-publication-task-binding.v1" || value.taskBinding !== key(task) || !Array.isArray(value.references)) throw new Error();
    return value.references.map((ref) => {
      if (!/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error();
      const bytes = fs.readFileSync(path.join(root(), "snapshots", ref.digest));
      if (hash(bytes) !== ref.digest) throw new Error();
      const skill = JSON.parse(bytes);
      if (skill.id !== ref.skillId || (skill.version || "") !== ref.version) throw new Error();
      return skill;
    });
  } catch { throw new Error("skill_task_binding_unavailable"); }
}

export function taskBoundSkills(currentSkills, task) {
  if (!task) return currentSkills;
  const current = new Map(currentSkills.map((skill) => [skill.id, skill]));
  return readTaskSkillPublications(task).map((skill) => ({ ...skill,
    // A frozen version does not preserve a subsequently revoked governance grant.
    runtimeEligibility: current.get(skill.id)?.runtimeEligibility?.allowed === true
      ? skill.runtimeEligibility : { allowed: false, reason: "skill_governance_revoked" },
  }));
}
