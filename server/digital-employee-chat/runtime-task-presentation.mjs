export async function presentRuntimeTasks({
  tasks = [],
  session = {},
  runtimeTaskService,
  resolveRuntimeTaskActorDisplayName,
  resolveRuntimeTaskBusinessReference,
  resolveRuntimeTaskSourceDisplayName,
  actorDisplayNameTimeoutMs = 450,
  cleanText,
} = {}) {
  const actorResolutionPromises = new Map();
  return Promise.all(tasks.map(async (task) => {
    const systemSourceName = await resolveSystemSourceName(task, resolveRuntimeTaskSourceDisplayName, cleanText);
    const businessReference = await resolveBusinessReference(task, resolveRuntimeTaskBusinessReference, cleanText);
    const { businessReference: _untrustedBusinessReference, ...safeTask } = task;
    const admission = readTaskAdmission(task, runtimeTaskService);
    const ownedByCurrentUser = runtimeTaskService?.isTaskOwnedBy?.(task, session) === true ||
      actorLocatorMatchesCurrentSession(admission?.actorLocator, session, cleanText);
    let resolvedActor = null;
    if (!systemSourceName && !ownedByCurrentUser && typeof resolveRuntimeTaskActorDisplayName === "function") {
      try {
        const actorLocator = admission?.actorLocator || null;
        const resolutionKey = actorResolutionKey(actorLocator, task, cleanText);
        let resolution = actorResolutionPromises.get(resolutionKey);
        if (!resolution) {
          resolution = settleWithin(
            resolveRuntimeTaskActorDisplayName({ actorLocator, task }),
            actorDisplayNameTimeoutMs,
          );
          actorResolutionPromises.set(resolutionKey, resolution);
        }
        resolvedActor = await resolution;
      } catch {
        resolvedActor = null;
      }
    }
    const currentUserName = cleanText(session.name || session.displayName || "");
    const existingName = cleanText(task.submittedBy?.displayName || task.submittedBy?.name || "");
    const trustedExistingName = ["脱敏用户", "脱敏来源", "姓名待解析"].includes(existingName) ? "" : existingName;
    const resolvedName = cleanText(resolvedActor?.displayName || trustedExistingName);
    return {
      ...safeTask,
      ...(businessReference ? { businessReference } : {}),
      submittedBy: {
        ...(task.submittedBy || {}),
        displayName: systemSourceName || (ownedByCurrentUser ? currentUserName ? `${currentUserName}（我）` : "我" : resolvedName || "姓名待解析"),
        displayNameStatus: systemSourceName ? "system_source" : ownedByCurrentUser ? "current_user" : resolvedName ? "resolved" : "unresolved",
      },
    };
  }));
}

function settleWithin(value, timeoutMs) {
  const safeTimeoutMs = Number.isSafeInteger(Number(timeoutMs))
    ? Math.min(5_000, Math.max(1, Number(timeoutMs)))
    : 450;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), safeTimeoutMs);
    Promise.resolve(value)
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch(() => {
        clearTimeout(timeout);
        resolve(null);
      });
  });
}

function actorResolutionKey(actorLocator = null, task = {}, cleanText) {
  const parts = [
    task.employeeId || task.employee?.id,
    actorLocator?.identitySource,
    actorLocator?.subjectIdType,
    actorLocator?.subjectId,
  ].map((value) => cleanComparableText(value, cleanText));
  return parts.every(Boolean) ? parts.join("\0") : `task:${cleanComparableText(task.id, cleanText)}`;
}

function readTaskAdmission(task = {}, runtimeTaskService) {
  try {
    return runtimeTaskService?.readExecutionAdmission?.(task.id) || null;
  } catch {
    return null;
  }
}

function actorLocatorMatchesCurrentSession(actorLocator = null, session = {}, cleanText) {
  const subjectId = cleanComparableText(actorLocator?.subjectId, cleanText);
  const subjectIdType = cleanComparableText(actorLocator?.subjectIdType, cleanText).toLowerCase();
  if (!subjectId || !subjectIdType) return false;
  const identitySource = cleanComparableText(actorLocator?.identitySource, cleanText).toLowerCase();
  const sessionIdentitySource = cleanComparableText(session.identitySource || session.authorization?.identitySource, cleanText).toLowerCase();
  if (subjectIdType !== "feishu_sender_id" && identitySource && sessionIdentitySource && identitySource !== sessionIdentitySource) return false;
  if (["feishu_id", "feishu_sender_id"].includes(subjectIdType)) return sessionFeishuIds(session, cleanText).has(subjectId);
  if (subjectIdType === "employee_id") return subjectId === cleanComparableText(session.employeeId, cleanText);
  if (subjectIdType === "employee_no") return subjectId === cleanComparableText(session.employeeNo, cleanText);
  if (subjectIdType === "email") return subjectId.toLowerCase() === cleanComparableText(session.email, cleanText).toLowerCase();
  return false;
}

function sessionFeishuIds(session = {}, cleanText) {
  const values = [
    session.feishuUserId,
    session.feishuUnionId,
    cleanComparableText(session.userIdType, cleanText).toLowerCase() === "feishuid" ? session.employeeId : "",
  ].map((value) => cleanComparableText(value, cleanText)).filter(Boolean);
  return new Set(values);
}

function cleanComparableText(value, cleanText) {
  return typeof cleanText === "function"
    ? cleanText(value || "")
    : String(value || "").trim();
}

async function resolveBusinessReference(task, resolver, cleanText) {
  if (typeof resolver !== "function") return null;
  try {
    const reference = await resolver({ task });
    if (reference?.contractVersion !== "runtime-task-business-reference.v1") return null;
    const type = boundedText(reference.type, cleanText, 80);
    const label = boundedText(reference.label, cleanText, 80);
    const value = boundedText(reference.value, cleanText, 200);
    const sourceField = boundedText(reference.sourceField, cleanText, 120);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(type) || !label || !value ||
      !/^[A-Za-z][A-Za-z0-9_.]{0,119}$/.test(sourceField)) return null;
    return Object.freeze({
      contractVersion: "runtime-task-business-reference.v1",
      label,
      sourceField,
      type,
      value,
    });
  } catch {
    return null;
  }
}

function boundedText(value, cleanText, maximum) {
  const result = typeof cleanText === "function"
    ? cleanText(value || "")
    : String(value || "").trim();
  if (typeof result !== "string" || !result || result.length > maximum ||
    /[\u0000-\u001F\u007F]/.test(result)) return "";
  return result;
}

async function resolveSystemSourceName(task, resolveRuntimeTaskSourceDisplayName, cleanText) {
  if (cleanText(task?.trigger?.channel || "") !== "trigger") return "";
  if (typeof resolveRuntimeTaskSourceDisplayName !== "function") return "外部系统（Trigger）";
  try {
    const source = await resolveRuntimeTaskSourceDisplayName({ task });
    const displayName = cleanText(source?.displayName || "");
    return displayName ? `${displayName}（系统触发）` : "外部系统（Trigger）";
  } catch {
    return "外部系统（Trigger）";
  }
}
