export const TASK_OUTPUT_MANIFEST_CONTRACT = "task-output-manifest.v1";

export function taskOutputManifestFromPublishedArtifacts({
  publishedArtifacts = [],
  resultAvailable = true,
  taskId = "",
} = {}) {
  const stableTaskId = safeTaskId(taskId);
  const artifacts = (Array.isArray(publishedArtifacts) ? publishedArtifacts : [])
    .flatMap(projectPublishedArtifact)
    .slice(0, 3);
  if (!stableTaskId || (!artifacts.length && resultAvailable !== true)) return null;
  return Object.freeze({
    contractVersion: TASK_OUTPUT_MANIFEST_CONTRACT,
    taskId: stableTaskId,
    result: Object.freeze({
      kind: "conversation_history",
      available: resultAvailable === true,
    }),
    artifactCount: artifacts.length,
    artifacts: Object.freeze(artifacts),
    safeSummary: taskOutputManifestSummary({ artifactCount: artifacts.length, resultAvailable }),
  });
}

export function taskOutputManifestSummary({ artifactCount = 0, resultAvailable = false } = {}) {
  const count = Number.isSafeInteger(Number(artifactCount)) && Number(artifactCount) > 0
    ? Math.min(Number(artifactCount), 3)
    : 0;
  if (count > 0) {
    return `当前任务已${resultAvailable === true ? "保存最终回答并" : ""}登记 ${count} 个可交付文件；用户可在同一任务卡片的“查看交付”里，或“我的任务”详情中查看/保存交付物，不要把 output、workspace、本地路径、artifactId 或对象地址当作用户可打开链接。`;
  }
  return resultAvailable === true
    ? "当前任务已保存最终回答，没有登记文件交付物；用户可在任务详情查看文本结果。"
    : "当前任务尚未登记可交付结果。";
}

function projectPublishedArtifact(value = {}) {
  const artifactId = safeToken(value?.artifact?.artifactId || value?.artifactId || value?.event?.data?.artifactId, 160);
  return artifactId ? [Object.freeze({
    artifactId,
    deliveryStatus: "registered",
  })] : [];
}

function safeTaskId(value) {
  return safeToken(value, 160);
}

function safeToken(value, maxLength) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text) && text.length <= maxLength ? text : "";
}
