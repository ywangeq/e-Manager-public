import { RefreshCcw, ShieldAlert } from "lucide-react";
import { DetailGrid, SkillChips } from "../ConsolePrimitives";

export default function AgentPreReviewPanel({ agentPreReview, status, onPreReview }) {
  if (!agentPreReview) {
    return (
      <section className="agent-pre-review-panel">
        <div className="approval-action-head">
          <div>
            <strong>Agent 预审核</strong>
            <p>外部 Skill 需要先由系统级 Agent / AI Worker 预审核，再进入人工确认。</p>
          </div>
          <button className="ghost-action table-action" type="button" onClick={onPreReview} disabled={status?.state === "loading"}>
            <RefreshCcw size={15} />
            执行 AI 预审核
          </button>
        </div>
        {status?.message ? <small className={`status-note ${status.state === "error" ? "danger-note" : ""}`}>{status.message}</small> : null}
      </section>
    );
  }

  const percent = Math.max(0, Math.min(100, Number(agentPreReview.progressPercent || 0)));
  const statusTone = ["failed", "blocked"].includes(agentPreReview.status) ? "warn" : agentPreReview.status === "completed" ? "good" : "info";
  const leaseRef = agentPreReview.credentialLease?.leaseRef || agentPreReview.leaseRef || "";
  const reviewDraft = agentPreReview.reviewDraft || null;

  return (
    <section className="agent-pre-review-panel">
      <div className="agent-pre-review-head">
        <div className="agent-progress-ring" style={{ "--progress": `${percent}%` }} aria-label={`AI 预审核进度 ${percent}%`}>
          <span>{percent}%</span>
        </div>
        <div>
          <span className="eyebrow">Agent Pre-review</span>
          <strong>{agentPreReview.workerName || agentPreReview.workerId}</strong>
          <p>{[agentPreReview.reviewDraftTitle, agentPreReview.progressLabel || agentPreReview.status, agentPreReview.recommendation].filter(Boolean).join(" · ")}</p>
        </div>
        <span className={`status-pill ${statusTone}`}>{agentPreReview.status}</span>
      </div>
      <DetailGrid
        items={[
          ["执行 ID", agentPreReview.executionId],
          ["Agent 员工", agentPreReview.agentEmployeeId || agentPreReview.workerEmployeeId],
          ["Worker lane", agentPreReview.lane],
          ["Provider / Model", [agentPreReview.provider, agentPreReview.model, agentPreReview.reasoningEffort].filter(Boolean).join(" / ")],
          ["服务端租约", leaseRef],
          ["错误码", agentPreReview.errorCode],
          ["错误域", agentPreReview.errorDomain],
          ["置信度", agentPreReview.confidence ? `${Math.round(agentPreReview.confidence * 100)}%` : ""],
          ["测评归口", agentPreReview.qualityRoute?.targetLabel],
          ["测评事件", agentPreReview.qualityRoute?.eventType],
        ]}
      />
      <SkillChips title="执行阶段" items={(agentPreReview.progressSegments || []).map((item) => `${item.label}：${item.status}`)} compact />
      {reviewDraft ? <StructuredReviewDraft reviewDraft={reviewDraft} /> : null}
      {!reviewDraft ? <SkillChips title="Agent 发现" items={agentPreReview.safeFindings || []} compact /> : null}
      {!reviewDraft ? <SkillChips title="缺口 / 错误" items={agentPreReview.missingItems || []} compact /> : null}
      {agentPreReview.qualityRoute ? (
        <div className="gate-line">
          <ShieldAlert size={16} />
          已归入质量评审 / {agentPreReview.qualityRoute.targetLabel || "测评审核"}：{agentPreReview.qualityRoute.errorCode || agentPreReview.errorCode}
        </div>
      ) : null}
      {agentPreReview.qualityEvent ? (
        <div className="governance-meta">
          <span>失败案例</span>
          <span>{agentPreReview.qualityEvent.status}</span>
          <span>{agentPreReview.qualityEvent.severity}</span>
          <span>{agentPreReview.qualityEvent.sourceEventId}</span>
        </div>
      ) : null}
      <div className="approval-action-buttons" role="group" aria-label="AI 预审核动作">
        <button className="ghost-action table-action" type="button" onClick={onPreReview} disabled={status?.state === "loading"}>
          <RefreshCcw size={15} />
          {status?.state === "loading" ? "预审核中" : "重跑 AI 预审核"}
        </button>
      </div>
      {status?.message ? <small className={`status-note ${status.state === "error" ? "danger-note" : ""}`}>{status.message}</small> : null}
    </section>
  );
}

function StructuredReviewDraft({ reviewDraft }) {
  const sections = Array.isArray(reviewDraft.sections) ? reviewDraft.sections : [];
  const missingItems = Array.isArray(reviewDraft.missingItems) ? reviewDraft.missingItems : [];
  const safeFindings = Array.isArray(reviewDraft.safeFindings) ? reviewDraft.safeFindings : [];
  const writebackPlan = reviewDraft.writebackPlan || {};
  return (
    <div className="agent-review-draft">
      <div className="agent-review-draft-head">
        <div>
          <span className="eyebrow">Review Draft</span>
          <strong>{reviewDraft.title || reviewDraft.uiDisplay?.primaryTitle || "Agent 评审稿"}</strong>
          <p>结构化预审结果，供人工确认对象、归属、能力边界与下一步门禁。</p>
        </div>
        <span className="status-pill info">{reviewDraft.contractVersion || "agent-skill-review-draft.v1"}</span>
      </div>
      <div className="agent-review-draft-sections">
        {sections.map((section, sectionIndex) => (
          <section className="agent-review-draft-section" data-section={section.id} key={section.id || section.title}>
            <div className="agent-review-draft-section-head">
              <span>{String(sectionIndex + 1).padStart(2, "0")}</span>
              <strong>{section.title}</strong>
            </div>
            <ul>
              {(section.items || []).filter(Boolean).map((item, itemIndex) => {
                const fieldMatch = String(item).match(/^([^:：]{1,24})[:：]\s*(.+)$/);
                return (
                  <li className={fieldMatch ? "is-field" : ""} key={`${section.id || section.title}-${itemIndex}`}>
                    {fieldMatch ? <span className="agent-review-draft-label">{fieldMatch[1]}</span> : null}
                    <span>{fieldMatch ? fieldMatch[2] : item}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {safeFindings.length ? <SkillChips title="Agent 发现" items={safeFindings} compact /> : null}
      {missingItems.length ? <SkillChips title="缺口 / 错误" items={missingItems} compact /> : null}
      <DetailGrid
        items={[
          ["写回目标", writebackPlan.target],
          ["人审页面", writebackPlan.humanReviewPage],
          ["生产影响", writebackPlan.productionEffect],
          ["展示顺序", (reviewDraft.uiDisplay?.sectionOrder || []).join(" / ")],
        ]}
      />
      {reviewDraft.privacyBoundary ? <small className="status-note">{reviewDraft.privacyBoundary}</small> : null}
    </div>
  );
}
