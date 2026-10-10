import { cockpitGoalStatus, cockpitNeedsAttention } from "./personalCockpitModel.js";
import { isDesktopMyTaskActiveStatus } from "../../shared/desktop-my-tasks.mjs";

// Presentation only. Runtime, Group projections and automation sources retain authority.
export const activityStates = {
  idle: { label: "值守待命", color: [0, 132, 155], particleColor: [24, 190, 220], speed: .85 },
  waiting: { label: "等待登录", color: [110, 125, 145], particleColor: [85, 174, 207], speed: .18 },
  loading: { label: "同步中", color: [75, 128, 168], particleColor: [65, 175, 228], speed: .4 },
  unavailable: { label: "部分数据不可用", color: [105, 125, 145], particleColor: [58, 170, 216], speed: .12 },
  queued: { label: "任务排队", color: [90, 119, 185], particleColor: [111, 158, 237], speed: .4 },
  attention: { label: "等待处理", color: [164, 104, 20], particleColor: [237, 176, 67], speed: .35 },
  working: { label: "执行中", color: [20, 122, 190], particleColor: [37, 173, 241], speed: 1.6 },
  success: { label: "刚刚完成", color: [0, 134, 106], particleColor: [36, 184, 154], speed: .65 },
  blocked: { label: "执行受阻", color: [190, 77, 85], particleColor: [235, 116, 128], speed: .12 },
};

export function cockpitSentinelActivity({ authenticated, taskPhase, goalPhase, automationPhase, tasks = [], goals = [], automations = [] }) {
  if (!authenticated) return "waiting";
  const phases = [taskPhase, goalPhase, automationPhase];
  if (phases.includes("error")) return "unavailable";
  if (phases.some((phase) => phase !== "ready")) return "loading";
  const statuses = [...tasks.map((task) => task.status), ...goals.map(cockpitGoalStatus),
    ...goals.filter((goal) => !["completed", "accepted", "canceled", "failed", "rejected", "timeout", "timed_out", "lost"].includes(cockpitGoalStatus(goal)))
      .flatMap((goal) => (goal.projection?.steps || []).map((step) => step.status))];
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.some((status) => cockpitNeedsAttention(status))) return "attention";
  if (statuses.some((status) => isDesktopMyTaskActiveStatus(status) || ["planning", "starting"].includes(status))) return "working";
  if (statuses.some((status) => ["queued", "pending"].includes(status))) return "queued";
  if (statuses.some((status) => !["completed", "accepted", "canceled", "failed", "timeout", "timed_out", "lost", "rejected", "awaiting_review", "execution_completed", "reconcile_required", "resume_required"].includes(status))) return "unavailable";
  return "idle";
}

export function completionSnapshot(tasks, goals) {
  return new Map([...tasks.filter((item) => item.id).map((item) => [`task:${item.id}`, item.status]),
    ...goals.filter((item) => item.goalId).map((item) => [`goal:${item.goalId}`, cockpitGoalStatus(item)])]);
}

export function hasNewCompletion(previous, next) {
  return [...next].some(([id, status]) => status === (id.startsWith("goal:") ? "accepted" : "completed") && previous.has(id)
    && previous.get(id) !== status);
}

// The cockpit currently has no audio lifecycle source. Its caller passes voice=off.
// Audio can only be drawn when a future connected caller supplies an explicit state and level.
export function sentinelVisualState(activity, voice = "off") {
  const normalized = Object.hasOwn(activityStates, activity) ? activity : "unavailable";
  const state = activityStates[normalized];
  const effectiveVoice = ["waiting", "unavailable", "loading"].includes(normalized) ? "off" : voice;
  return { ...state, voice: effectiveVoice, audioVisible: ["listening", "speaking"].includes(effectiveVoice) };
}

export function sentinelOrbitalColor(activity) {
  const state = activityStates[activity] || activityStates.unavailable;
  if (activity === "idle") return activityStates.working.particleColor;
  return ["waiting", "unavailable", "loading"].includes(activity) || !Object.hasOwn(activityStates,activity) ? state.color : state.particleColor;
}

// A blocked task is an accent, not a replacement for the blue/gold material.
const defaultOrbitalTreatment = Object.freeze({ coverage: 1, energy: 1 });
const blockedOrbitalTreatment = Object.freeze({ coverage: .16, energy: .55 });
export function sentinelOrbitalTreatment(activity) {
  return activity === "blocked" ? blockedOrbitalTreatment : defaultOrbitalTreatment;
}
