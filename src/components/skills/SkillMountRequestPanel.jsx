import { CheckCircle2, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchSkillMountRequests,
  postSkillMountDecision,
} from "../../lib/controlPlane";
import { DetailGrid, SkillChips } from "../ConsolePrimitives";

function requestTone(status = "") {
  if (status.includes("驳回") || status.includes("失败")) return "bad";
  if (status.includes("生效") || status.includes("通过")) return "good";
  if (status.includes("待")) return "warn";
  return "muted";
}

export default function SkillMountRequestPanel({ isSystemAdmin = false }) {
  const [requests, setRequests] = useState([]);
  const [canManage, setCanManage] = useState(isSystemAdmin);
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestIds, setOpenRequestIds] = useState(() => new Set());
  const [status, setStatus] = useState({ state: "idle", message: "" });

  async function refreshRequests() {
    try {
      const data = await fetchSkillMountRequests();
      setRequests(Array.isArray(data.skillMountRequests) ? data.skillMountRequests : []);
      setCanManage(Boolean(data.canManage || isSystemAdmin));
    } catch (error) {
      setStatus({ state: "error", message: error?.message || "挂载申请读取失败" });
    }
  }

  useEffect(() => {
    refreshRequests();
  }, []);

  async function decideRequest(requestId, decision) {
    setStatus({ state: "saving", message: "正在保存审核决定" });
    try {
      await postSkillMountDecision(requestId, {
        decision,
        notes: decision === "approved" ? "管理员确认挂载变更和归因测试计划。" : "退回补齐影响范围、回滚或 owner 确认。",
      });
      setStatus({ state: "ready", message: decision === "approved" ? "挂载变更已生效。" : "申请已退回。" });
      await refreshRequests();
    } catch (error) {
      setStatus({ state: "error", message: error?.message || "审核决定保存失败" });
    }
  }

  function toggleRequest(requestId) {
    setOpenRequestIds((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  const pendingRequests = requests.filter((request) => request.status === "待管理员审核");
  const recentRequests = requests.slice(0, 6);
  const visibleRequests = pendingRequests.length ? pendingRequests : recentRequests;

  if (!canManage) return null;

  return (
    <section className="skill-mount-panel skill-mount-review-panel">
      <button
        className="skill-intake-head skill-mount-review-toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls="skill-mount-review-body"
        onClick={() => setIsOpen((current) => !current)}
      >
        <div>
          <span className="eyebrow">Mount Review</span>
          <strong>挂载变更审核队列</strong>
          <p>用户在数字员工详情页提交挂载或取消挂载；这里只处理待审和最近台账。</p>
        </div>
        <span className="skill-mount-review-toggle-meta">
          <span className={`status-pill ${pendingRequests.length ? "warn" : "info"}`}>
            {pendingRequests.length ? `${pendingRequests.length} 待审核` : "台账已同步"}
          </span>
          <span className="entity-cue" aria-hidden="true">
            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
        </span>
      </button>

      {isOpen ? (
        <div className="skill-mount-review-body" id="skill-mount-review-body">
          {visibleRequests.length ? (
            <div className="skill-mount-request-list">
              {visibleRequests.map((request) => {
                const isRequestOpen = openRequestIds.has(request.id);
                const requestBodyId = `skill-mount-request-${request.id}-body`;

                return (
                  <article className="skill-mount-request" key={request.id}>
                    <button
                      className="skill-mount-request-head skill-mount-request-toggle"
                      type="button"
                      aria-expanded={isRequestOpen}
                      aria-controls={requestBodyId}
                      onClick={() => toggleRequest(request.id)}
                    >
                      <div>
                        <strong>{request.actionLabel} / {request.employeeName}</strong>
                        <p>{request.skillName} · {request.mountActionId}</p>
                      </div>
                      <span className="skill-mount-request-toggle-meta">
                        <span className={`status-pill ${requestTone(request.status)}`}>{request.status}</span>
                        <span className="entity-cue" aria-hidden="true">
                          {isRequestOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                        </span>
                      </span>
                    </button>
                    {isRequestOpen ? (
                      <div className="skill-mount-request-body" id={requestBodyId}>
                        <DetailGrid
                          items={[
                            ["申请 ID", request.id],
                            ["员工版本", request.employeeVersion],
                            ["Skill 版本", request.skillVersion],
                            ["模式", request.requestMode],
                            ["风险", request.riskLevel],
                            ["申请人", request.requestedBy?.name],
                            ["提交时间", request.submittedAt],
                          ]}
                        />
                        <SkillChips title="预检查" items={request.precheck?.findings || []} compact />
                        <SkillChips title="缺口" items={request.precheck?.missingItems || []} compact />
                        <SkillChips title="归因指标" items={request.attributionPlan?.guardrailMetrics || []} compact />
                        {request.status === "待管理员审核" ? (
                          <div className="approval-action-buttons" role="group" aria-label={`${request.id} 挂载审核`}>
                            <button className="ghost-action table-action approval-pass" type="button" onClick={() => decideRequest(request.id, "approved")}>
                              <CheckCircle2 size={15} />
                              通过
                            </button>
                            <button className="ghost-action table-action approval-return" type="button" onClick={() => decideRequest(request.id, "rejected")}>
                              <ShieldCheck size={15} />
                              退回
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="model-binding-note">暂无挂载变更申请。普通用户现在从数字员工详情页发起添加或取消挂载。</p>
          )}

          {status.message ? (
            <p className={`model-binding-note ${status.state === "error" ? "is-error" : ""}`}>{status.message}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
