export function createRuntimeTaskActorDisplayNameResolver({ cleanText = defaultCleanText, resolveFeishuCurrentUserProfile, tryFetchFortressUser } = {}) {
  return async function resolveRuntimeTaskActorDisplayName({ actorLocator, task } = {}) {
    const subjectId = cleanText(actorLocator?.subjectId || "");
    const subjectIdType = cleanText(actorLocator?.subjectIdType || "").toLowerCase();
    const identitySource = cleanText(actorLocator?.identitySource || "").toLowerCase();
    if (identitySource === "feishu" && subjectIdType === "feishu_sender_id") {
      const feishuProfile = await tryResolveFeishuProfile({
        employeeId: cleanText(task?.employeeId || task?.employee?.id || ""),
        resolveFeishuCurrentUserProfile,
        subjectId,
      });
      const feishuDisplayName = cleanText(feishuProfile?.subjectDisplayName || "");
      if (feishuDisplayName) return { displayName: feishuDisplayName, source: "feishu-contact-profile" };
      const unionId = feishuSubjectAlias(feishuProfile, "feishu_union_id", cleanText);
      if (unionId && typeof tryFetchFortressUser === "function") {
        const member = await tryFetchFortressUser(unionId, "feishuUnionID");
        const displayName = cleanText(member?.FullName || member?.NickName || "");
        if (displayName) return { displayName, source: "fortress-directory" };
      }
    }
    const fortressUserIdType = ["feishu_id", "feishu_sender_id"].includes(subjectIdType)
      ? "feishuID"
      : subjectIdType === "employee_no"
        ? "employeeNo"
        : subjectIdType === "employee_id" && identitySource === "fortress-sso-v3" ? "feishuID" : "";
    if (!subjectId || !fortressUserIdType || typeof tryFetchFortressUser !== "function") return null;
    const member = await tryFetchFortressUser(subjectId, fortressUserIdType);
    const displayName = cleanText(member?.FullName || member?.NickName || "");
    return displayName ? { displayName, source: "fortress-directory" } : null;
  };
}

function feishuSubjectAlias(profile = null, subjectIdType = "", cleanText) {
  const aliases = Array.isArray(profile?.subjectAliases) ? profile.subjectAliases : [];
  const match = aliases.find((alias) => cleanText(alias?.subjectIdType || "").toLowerCase() === subjectIdType);
  return cleanText(match?.subjectId || "");
}

async function tryResolveFeishuProfile({ employeeId = "", resolveFeishuCurrentUserProfile, subjectId = "" } = {}) {
  if (!employeeId || !subjectId || typeof resolveFeishuCurrentUserProfile !== "function") return null;
  try {
    const profile = await resolveFeishuCurrentUserProfile({ employeeId, subjectId });
    return profile?.subjectId === subjectId && profile?.subjectIdType === "feishu_sender_id" ? profile : null;
  } catch {
    return null;
  }
}

function defaultCleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}
