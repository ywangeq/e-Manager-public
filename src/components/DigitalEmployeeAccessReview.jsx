import { ArrowLeft, Check, RefreshCcw, ShieldCheck, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  decideDigitalEmployeeAccessRequest,
  fetchDigitalEmployeeAccessRequests,
  pendingDigitalEmployeeAccessRequestCount,
} from "../lib/digitalEmployeeAccessRequests";

const statusLabels = {
  pending_review: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  revoked: "已撤销",
};

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function canDecideRequest(session = {}, request = {}) {
  if (session.role === "admin") return true;
  const permissions = new Set(Array.isArray(session.permissions) ? session.permissions : []);
  if (permissions.has("system:*") || permissions.has("digital-employees:*")) return true;
  const managedDepartmentIds = new Set(Array.isArray(session.managedDepartmentIds) ? session.managedDepartmentIds : []);
  return managedDepartmentIds.has("*") || managedDepartmentIds.has(request.target?.ownerDepartmentId);
}

export default function DigitalEmployeeAccessReview({ session = {}, onBack, onPendingCountChange = null }) {
  const [queue, setQueue] = useState({ status: "loading", requests: [], error: "" });
  const [activeQueue, setActiveQueue] = useState("pending");
  const [decisionState, setDecisionState] = useState({});

  async function loadQueue() {
    setQueue((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const data = await fetchDigitalEmployeeAccessRequests();
      setQueue({ status: "ready", requests: data.accessRequests || [], error: "" });
    } catch (error) {
      setQueue({ status: "error", requests: [], error: error?.message || "使用授权申请读取失败" });
    }
  }

  useEffect(() => {
    loadQueue();
  }, []);

  const pendingRequests = useMemo(
    () => queue.requests.filter((request) => request.status === "pending_review"),
    [queue.requests],
  );
  const completedRequests = useMemo(
    () => queue.requests.filter((request) => request.status !== "pending_review"),
    [queue.requests],
  );
  const visibleRequests = activeQueue === "pending" ? pendingRequests : completedRequests;

  useEffect(() => {
    if (queue.status === "ready") {
      onPendingCountChange?.(pendingDigitalEmployeeAccessRequestCount(queue.requests));
    }
  }, [onPendingCountChange, queue.requests, queue.status]);

  async function decide(request, decision) {
    const stateKey = request.id;
    const decisionLabel = decision === "approved" ? "通过" : "驳回";
    setDecisionState((current) => ({ ...current, [stateKey]: { status: "saving", message: `${decisionLabel}中` } }));
    try {
      await decideDigitalEmployeeAccessRequest(request.id, {
        decision,
        note: decision === "approved"
          ? "已确认申请人、目标数字员工、版本和基础对话授权范围。"
          : "当前授权范围未通过，请补充业务场景后重新申请。",
      });
      setDecisionState((current) => ({ ...current, [stateKey]: { status: "saved", message: `已${decisionLabel}` } }));
      await loadQueue();
      setDecisionState((current) => {
        const next = { ...current };
        delete next[stateKey];
        return next;
      });
    } catch (error) {
      setDecisionState((current) => ({
        ...current,
        [stateKey]: { status: "error", message: error?.message || `${decisionLabel}失败` },
      }));
    }
  }

  return (
    <section className="panel digital-employee-access-review">
      <div className="digital-employee-access-review-head">
        <div>
          <p className="eyebrow">Digital Employee Access</p>
          <h2>使用授权</h2>
          <span>审核个人对指定数字员工版本的基础对话使用权。</span>
        </div>
        <div className="digital-employee-access-review-actions">
          <button className="ghost-action" type="button" onClick={onBack}>
            <ArrowLeft size={15} />
            员工目录
          </button>
          <button className="ghost-action" type="button" disabled={queue.status === "loading"} onClick={loadQueue}>
            <RefreshCcw size={15} />
            {queue.status === "loading" ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>

      <div className="digital-employee-access-review-toolbar" role="tablist" aria-label="使用授权申请状态">
        <button
          className={activeQueue === "pending" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeQueue === "pending"}
          onClick={() => setActiveQueue("pending")}
        >
          待审核 <b>{pendingRequests.length}</b>
        </button>
        <button
          className={activeQueue === "completed" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeQueue === "completed"}
          onClick={() => setActiveQueue("completed")}
        >
          已处理 <b>{completedRequests.length}</b>
        </button>
      </div>

      {queue.status === "error" ? <p className="digital-employee-access-review-message is-error">{queue.error}</p> : null}
      {queue.status === "loading" && !queue.requests.length ? (
        <p className="digital-employee-access-review-message">正在读取使用授权申请...</p>
      ) : visibleRequests.length ? (
        <div className="digital-employee-access-review-table-wrap">
          <table className="digital-employee-access-review-table">
            <thead>
              <tr>
                <th>申请人</th>
                <th>目标数字员工</th>
                <th>申请原因</th>
                <th>申请时间</th>
                <th>状态 / 操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRequests.map((request) => {
                const state = decisionState[request.id] || {};
                const canDecide = request.status === "pending_review" && canDecideRequest(session, request);
                return (
                  <tr key={request.id}>
                    <td>
                      <span className="digital-employee-access-review-person">
                        <UserRound size={14} />
                        <strong>{request.applicant?.name || request.applicant?.id || "未命名申请人"}</strong>
                        <small>{request.applicant?.departmentName || request.applicant?.departmentId || "未声明部门"}</small>
                      </span>
                    </td>
                    <td>
                      <span className="digital-employee-access-review-target">
                        <strong>{request.target?.employeeName || request.target?.employeeId || "未知数字员工"}</strong>
                        <small>{request.target?.employeeVersion || "未声明版本"}</small>
                      </span>
                    </td>
                    <td><span className="digital-employee-access-review-reason">{request.safeReason || "未填写申请原因"}</span></td>
                    <td>{formatDateTime(request.createdAt)}</td>
                    <td>
                      <div className="digital-employee-access-review-decision">
                        <span className={`status-pill ${request.status === "approved" ? "good" : request.status === "pending_review" ? "warn" : "bad"}`}>
                          {statusLabels[request.status] || request.status}
                        </span>
                        {canDecide ? (
                          <span className="digital-employee-access-review-buttons">
                            <button
                              className="ghost-action table-action confirm"
                              type="button"
                              disabled={state.status === "saving"}
                              onClick={() => decide(request, "approved")}
                            >
                              <Check size={14} />
                              通过
                            </button>
                            <button
                              className="ghost-action table-action danger"
                              type="button"
                              disabled={state.status === "saving"}
                              onClick={() => decide(request, "rejected")}
                            >
                              <X size={14} />
                              驳回
                            </button>
                          </span>
                        ) : null}
                        {request.decision?.note ? <small>{request.decision.note}</small> : null}
                        {state.message ? <small className={state.status === "error" ? "is-error" : ""}>{state.message}</small> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="digital-employee-access-review-empty">
          <ShieldCheck size={20} />
          <strong>{activeQueue === "pending" ? "当前没有待审核申请" : "当前没有已处理记录"}</strong>
          <span>{activeQueue === "pending" ? "新申请提交后会出现在这里。" : "完成审批后会保留处理结果。"}</span>
        </div>
      )}
    </section>
  );
}
