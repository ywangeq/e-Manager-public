function currentUserToolExecutionIdentityFromFeishuAdmission({ admission = null, profile = null, task = null } = {}) {
  if (!admission || !task || admission.contractVersion !== "execution-admission.v1" ||
    admission.taskId !== task.taskId || admission.channelId !== "feishu" ||
    admission.routeBinding?.tenantScope !== task.tenantScope ||
    admission.routeBinding?.actorIssuer !== task.actorIssuer ||
    admission.routeBinding?.actorSubjectDigest !== task.actorSubjectDigest) {
    return null;
  }
  const locator = admission.actorLocator || {};
  if (locator.identitySource !== "feishu" || locator.subjectIdType !== "feishu_sender_id") return null;
  return Object.freeze({
    contractVersion: "current-user-tool-execution-identity.v1",
    accountStatus: "active",
    tenantScope: task.tenantScope,
    actorIssuer: task.actorIssuer,
    actorSubjectDigest: task.actorSubjectDigest,
    identitySource: locator.identitySource,
    subjectId: locator.subjectId,
    subjectIdType: locator.subjectIdType,
    ...(profile?.subjectId === locator.subjectId && profile?.subjectIdType === locator.subjectIdType
      ? {
          subjectDisplayName: profile.subjectDisplayName,
          departmentRefs: profile.departmentRefs,
        }
      : {}),
    permissionVersion: admission.permissionDigest,
    authorizationValidUntil: admission.expiresAt,
  });
}

export { currentUserToolExecutionIdentityFromFeishuAdmission };
