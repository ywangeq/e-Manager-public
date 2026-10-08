const RESOLVER_CONTRACT_VERSION = "hr-training-task-reference-resolver.v1";

function createHrTrainingTaskReferenceResolver({ inputRepository, tenantScope } = {}) {
  if (typeof inputRepository?.getSafeByTask !== "function") {
    throw new TypeError("HR Training task reference resolver requires inputRepository.getSafeByTask");
  }
  const safeTenantScope = reference(tenantScope);

  function resolve({ task } = {}) {
    if (task?.trigger?.channel !== "trigger" || task?.sourceSystemId !== "hr-train") return null;
    const match = inputRepository.getSafeByTask({
      tenantScope: safeTenantScope,
      taskId: reference(task.id || task.taskId),
    });
    if (!match?.evaluationRef) return null;
    const capabilityLabel = match.capability === "hr_training.content_evaluate.v1" ? "内容评分"
      : match.capability === "hr_training.followup_answer_evaluate.v1" ? "追问反馈"
        : match.capability === "hr_training.followup_round_evaluate.v1" ? "追问整轮评分"
        : "HR培训";
    return Object.freeze({
      contractVersion: "runtime-task-business-reference.v1",
      label: "HR培训评估",
      sourceField: "hrTraining.evaluationRef",
      type: "hr_training_evaluation_ref",
      value: [capabilityLabel, match.evaluationRef, match.sessionRef, match.meetingRecordRef]
        .filter(Boolean).join(" · "),
    });
  }

  return Object.freeze({ contractVersion: RESOLVER_CONTRACT_VERSION, resolve });
}

function reference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    const error = new Error("hr_training_task_reference_invalid");
    error.code = "hr_training_task_reference_invalid";
    throw error;
  }
  return value;
}

export { RESOLVER_CONTRACT_VERSION, createHrTrainingTaskReferenceResolver };
