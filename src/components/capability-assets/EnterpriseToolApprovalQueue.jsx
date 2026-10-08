import { RotateCcw, ShieldCheck } from "lucide-react";
import { statusClass } from "../../lib/consoleCatalog";
import { isPendingToolRequest } from "../../lib/enterpriseTools";

export default function EnterpriseToolApprovalQueue({ requests = [], canManage = false, decisionState = {}, employeeNameById, onDecision }) {
  const sortedRequests = [...requests].sort((left, right) => {
    const leftPending = isPendingToolRequest(left) ? 1 : 0;
    const rightPending = isPendingToolRequest(right) ? 1 : 0;
    if (leftPending !== rightPending) return rightPending - leftPending;
    return String(right.updatedAt || right.submittedAt || right.id).localeCompare(String(left.updatedAt || left.submittedAt || left.id));
  });
  const pendingRequests = sortedRequests.filter(isPendingToolRequest);
  return (
    <section className={`enterprise-tool-approval-panel ${pendingRequests.length ? "" : "is-quiet"}`}>
      <div className="enterprise-tool-approval-head">
        <div>
          <strong>Tool 开关审批</strong>
          <span>{pendingRequests.length ? "员工工具页提交的开启/关闭申请会持久化到后端控制面文件存储。" : "暂无待审项，历史记录保留在后端。"}</span>
        </div>
        <em className={`status-pill ${pendingRequests.length && canManage ? "warn" : "muted"}`}>{canManage ? `${pendingRequests.length} 条待审` : "只读"}</em>
      </div>
      {pendingRequests.length ? (
        <div className="enterprise-tool-approval-list">
          {pendingRequests.slice(0, 8).map((request) => {
            const pending = isPendingToolRequest(request);
            const busy = decisionState[request.id] === "saving";
            return (
              <article className="enterprise-tool-approval-row" key={request.id}>
                <div>
                  <strong>{request.toolName || request.toolId}</strong>
                  <span>{request.action === "disable" ? "关闭" : "开启"} / {employeeNameById.get(request.employeeId) || request.employeeName || request.employeeId}</span>
                  <small>{request.reason || request.safeSummary}</small>
                </div>
                <span className={`status-pill ${statusClass(request.status)}`}>{request.status}</span>
                <code>{request.id}</code>
                <div className="enterprise-tool-approval-actions">
                  {pending && canManage ? (
                    <>
                      <button type="button" onClick={() => onDecision(request, "approved")} disabled={busy}>
                        <ShieldCheck size={14} />
                        通过
                      </button>
                      <button type="button" onClick={() => onDecision(request, "rejected")} disabled={busy}>
                        <RotateCcw size={14} />
                        驳回
                      </button>
                    </>
                  ) : (
                    <small>{request.decision?.decidedAt || request.submittedAt || "待处理"}</small>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="enterprise-tool-approval-empty">需要开关变更时，从数字员工的“工具”页发起申请。</p>
      )}
    </section>
  );
}
