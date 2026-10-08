function upsertStep(steps, nextStep) {
  const existingIndex = steps.findIndex((step) => step.id === nextStep.id);
  if (existingIndex === -1) return [...steps, nextStep];
  return steps.map((step, index) => (index === existingIndex ? { ...step, ...nextStep } : step));
}

export function reduceAssistantStreamEvent(message, event, data = {}) {
  if (message.status === "done" || message.status === "error") return message;
  const steps = message.steps || [];
  if (event === "accepted") {
    return {
      ...message,
      steps: steps.map((step) => step.id === "queued" && step.status === "running"
        ? { ...step, status: "done", label: "已提交到企业 AI 入口" }
        : step),
    };
  }
  if (event === "meta") return { ...message, meta: data };
  if (event === "step") return { ...message, steps: upsertStep(steps, data) };
  if (event === "thought") return { ...message, thought: `${message.thought || ""}${data.text || ""}` };
  if (event === "delta") return { ...message, content: `${message.content || ""}${data.text || ""}` };
  if (["done", "error", "end"].includes(event)) {
    const failed = event !== "done" || data.ok === false || steps.some((step) => step.status === "blocked");
    const settledSteps = steps.map((step) => step.status === "running"
      ? { ...step, status: failed ? "blocked" : "done" }
      : step);
    return {
      ...message,
      status: failed ? "error" : "done",
      error: failed ? data.message || (event === "end" ? "连接已结束，未收到完成确认，请查看任务状态" : "模型调用失败") : "",
      steps: failed
        ? upsertStep(settledSteps, { id: "error", status: "blocked", label: event === "end" ? "连接中断，任务状态待确认" : "模型流式请求失败" })
        : settledSteps,
    };
  }
  return message;
}
