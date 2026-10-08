import { useState } from "react";
import { resolvePersonnel } from "../../lib/personnel/drafts";

export function PeopleConfirmationFlow({ addedPeopleCount, editingUser, enterpriseReady, isAddingUser, pendingPeopleCount }) {
  const steps = [
    {
      id: "sync",
      index: "01",
      label: "录入/同步",
      detail: isAddingUser ? "新增人员草案" : enterpriseReady ? "企业目录同步" : "demo 人员目录",
      active: isAddingUser || enterpriseReady,
    },
    {
      id: "resolve",
      index: "02",
      label: "目录补全",
      detail: "职位 / 部门 / 范围",
      active: isAddingUser,
    },
    {
      id: "confirm",
      index: "03",
      label: "待确认",
      detail: pendingPeopleCount ? `${pendingPeopleCount} 条人员草案待确认` : "无待确认人员草案",
      active: pendingPeopleCount > 0,
    },
    {
      id: "publish",
      index: "04",
      label: "后端草稿",
      detail: addedPeopleCount ? `${addedPeopleCount} 条新增草案已保存` : "MVP 后端持久化",
      active: Boolean(editingUser) || addedPeopleCount > 0,
    },
  ];

  return (
    <div className="people-flow-grid" aria-label="人员确认流程">
      {steps.map((step) => (
        <div className={`people-flow-step ${step.active ? "is-active" : ""}`} key={step.id}>
          <span className="people-flow-index">{step.index}</span>
          <strong>{step.label}</strong>
          <small>{step.detail}</small>
        </div>
      ))}
    </div>
  );
}

export function PeopleAccessRequestPanel({ departmentOptions, isSaving, onSubmit, session }) {
  const applicantName = session.name || session.email || session.employeeId || "当前登录人";
  const applicantMeta = [session.department, session.email || session.employeeId].filter(Boolean).join(" · ");
  const [form, setForm] = useState({
    requestedRole: "部门管理员",
    departmentId: session.departmentId || "",
    departmentName: session.department || "",
    sourceSystemId: "hr-talentos",
    sourceSystemName: "HR 简历系统",
    reason: "需要代表本部门/子系统提交数字员工或 Skill 能力申请，后续仍等待平台治理审核。",
  });
  const [status, setStatus] = useState({ state: "idle", message: "" });

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDepartment(departmentId) {
    const department = departmentOptions.find((item) => item.id === departmentId);
    setForm((current) => ({
      ...current,
      departmentId,
      departmentName: department?.path?.join(" / ") || department?.name || "",
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setStatus({ state: "loading", message: "正在提交权限申请" });
    try {
      const data = await onSubmit(form);
      setStatus({ state: "ready", message: data.message || "权限申请已提交，等待管理员审核。" });
    } catch (error) {
      setStatus({ state: "error", message: error?.message || "权限申请提交失败" });
    }
  }

  return (
    <form className="people-edit-panel" onSubmit={submit}>
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">Access Request</span>
          <strong>申请人员 / 子系统权限</strong>
          <p>当前申请人：{applicantName}{applicantMeta ? ` · ${applicantMeta}` : ""}</p>
        </div>
      </div>
      <div className="skill-draft-form">
        <label>
          <span>申请角色</span>
          <select value={form.requestedRole} onChange={(event) => updateField("requestedRole", event.target.value)}>
            <option value="部门管理员">部门管理员</option>
            <option value="业务系统 owner">业务系统 owner</option>
            <option value="控制面治理角色">控制面治理角色</option>
            <option value="质量治理角色">质量治理角色</option>
          </select>
        </label>
        <label>
          <span>部门范围</span>
          <select value={form.departmentId} onChange={(event) => updateDepartment(event.target.value)}>
            <option value="">待管理员确认</option>
            {departmentOptions.map((department) => (
              <option key={department.id} value={department.id}>
                {department.path?.join(" / ") || department.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>业务系统 ID</span>
          <input value={form.sourceSystemId} onChange={(event) => updateField("sourceSystemId", event.target.value)} />
        </label>
        <label>
          <span>业务系统名称</span>
          <input value={form.sourceSystemName} onChange={(event) => updateField("sourceSystemName", event.target.value)} />
        </label>
        <label className="wide">
          <span>申请理由</span>
          <textarea value={form.reason} onChange={(event) => updateField("reason", event.target.value)} />
        </label>
        <div className="skill-draft-actions">
          <span>{status.message || "申请会写入 MVP 后端草稿；管理员审核通过后才生成治理授权草案。"}</span>
          <button className="primary-action" type="submit" disabled={isSaving || status.state === "loading"}>
            {status.state === "loading" ? "提交中" : "提交权限申请"}
          </button>
        </div>
      </div>
    </form>
  );
}

export function PeopleAccessRequestReview({ accessRequests, isSystemAdmin, isSaving, onDecision }) {
  const requests = (Array.isArray(accessRequests) ? accessRequests : []).filter((request) => request.status === "pending_review");
  if (!requests.length) {
    return (
      <div className="identity-banner">
        <strong>暂无待审核权限申请</strong>
        <span>当前没有需要处理的人员 / 子系统权限申请。</span>
        <b>personnel-access-request.v1</b>
      </div>
    );
  }
  return (
    <div className="access-request-list" aria-label="权限申请列表">
      {requests.map((request) => {
        const isPending = request.status === "pending_review";
        const applicantName = request.applicant?.name || request.applicant?.email || request.applicant?.id || "未命名申请人";
        return (
          <article className="access-request-card" key={request.id}>
            <div>
              <span className={`status-pill ${request.status === "approved" ? "good" : request.status === "rejected" ? "bad" : "warn"}`}>
                {request.status === "approved" ? "已通过" : request.status === "rejected" ? "已驳回" : "待审核"}
              </span>
              <strong>{applicantName}</strong>
              <small>{request.requestedRole}</small>
            </div>
            <p>{request.reason || "未填写申请理由。"}</p>
            <div className="chip-line compact">
              <b>{request.target?.departmentName || request.target?.departmentId || "待确认部门"}</b>
              {request.sourceSystemName || request.sourceSystemId ? <b>{request.sourceSystemName || request.sourceSystemId}</b> : null}
              <b>{request.id}</b>
            </div>
            {request.decision?.note ? <small className="status-note">审核意见：{request.decision.note}</small> : null}
            {isSystemAdmin && isPending ? (
              <div className="table-actions">
                <button
                  className="ghost-action table-action confirm"
                  type="button"
                  disabled={isSaving}
                  onClick={() => onDecision(request.id, { decision: "approved", note: "管理员确认授权范围。" }).catch(() => {})}
                >
                  通过
                </button>
                <button
                  className="ghost-action table-action danger"
                  type="button"
                  disabled={isSaving}
                  onClick={() => onDecision(request.id, { decision: "rejected", note: "请补充授权范围或业务系统 owner 证明。" }).catch(() => {})}
                >
                  驳回
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function PeopleEditDraftPanel({ user, enterpriseReady, departmentOptions, isSaving, onCancel, onSave }) {
  const defaultDepartment = departmentOptions.find((department) => department.id === user.departmentId);
  const [form, setForm] = useState(() => ({
    displayName: user.name || "",
    role: user.role || "",
    departmentId: user.departmentId || defaultDepartment?.id || "",
    departmentName: user.department || defaultDepartment?.name || "",
    status: user.status || "待确认",
    governanceRole: user.governanceRole || "普通成员",
    note: "",
  }));

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDepartment(departmentId) {
    const department = departmentOptions.find((item) => item.id === departmentId);
    setForm((current) => ({
      ...current,
      departmentId,
      departmentName: department?.path?.join(" / ") || department?.name || "",
    }));
  }

  async function submitDraft(event) {
    event.preventDefault();
    await onSave({
      ...form,
      userId: user.id,
      source: enterpriseReady ? "fortress-runtime" : "mvp-backend-draft",
    }).catch(() => {});
  }

  return (
    <form className="people-edit-panel" onSubmit={submitDraft}>
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">People Draft</span>
          <strong>{user.name}</strong>
          <p>这里只生成编辑草案，不直接写回企业目录。</p>
        </div>
        <button className="ghost-action" type="button" onClick={onCancel}>
          收起
        </button>
      </div>
      <div className="skill-draft-form">
        <label>
          <span>显示名</span>
          <input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} />
        </label>
        <label>
          <span>角色/职位</span>
          <input value={form.role} onChange={(event) => updateField("role", event.target.value)} />
        </label>
        <label>
          <span>部门</span>
          <select value={form.departmentId} onChange={(event) => updateDepartment(event.target.value)}>
            <option value="">待选择部门</option>
            {departmentOptions.map((department) => (
              <option key={department.id} value={department.id}>
                {department.path?.join(" / ") || department.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>治理角色</span>
          <select value={form.governanceRole} onChange={(event) => updateField("governanceRole", event.target.value)}>
            <option value="系统管理员">系统管理员</option>
            <option value="部门负责人">部门负责人</option>
            <option value="部门管理员">部门管理员</option>
            <option value="普通成员">普通成员</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select value={form.status} onChange={(event) => updateField("status", event.target.value)}>
            <option value="启用">启用</option>
            <option value="待确认">待确认</option>
            <option value="停用">停用</option>
          </select>
        </label>
        <label className="wide">
          <span>变更说明</span>
          <textarea
            value={form.note}
            onChange={(event) => updateField("note", event.target.value)}
            placeholder="说明为什么调整人员权限、影响哪些部门或数字员工。"
          />
        </label>
        <div className="skill-draft-actions">
          <span>{enterpriseReady ? "来源：Fortress 运行时目录" : "来源：MVP 后端草稿"}</span>
          <button className="primary-action" type="submit" disabled={isSaving}>
            {isSaving ? "保存中" : "保存草案"}
          </button>
        </div>
      </div>
    </form>
  );
}

export function PeopleAddPanel({ departmentOptions, isSaving, onCancel, onResolved }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    departmentId: "",
    departmentName: "",
    governanceRole: "普通成员",
    scope: "ownDepartment",
  });
  const [status, setStatus] = useState({ state: "idle", message: "" });
  const activeAddStep = status.state === "loading" || status.state === "error" ? 1 : status.state === "ready" ? 2 : 0;

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDepartment(departmentId) {
    const department = departmentOptions.find((item) => item.id === departmentId);
    setForm((current) => ({
      ...current,
      departmentId,
      departmentName: department?.path?.join(" / ") || department?.name || "",
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setStatus({ state: "loading", message: "正在提交后端补全" });
    try {
      const data = await resolvePersonnel(form);
      await onResolved(data.personnel);
      setStatus({ state: "ready", message: data.source === "fortress-v3" ? "已从 Fortress 补全" : "未匹配目录，已生成待补全草案" });
    } catch (error) {
      setStatus({ state: "error", message: error?.message || "人员解析失败" });
    }
  }

  return (
    <form className="people-edit-panel" onSubmit={submit}>
      <div className="skill-draft-head">
        <div>
          <span className="eyebrow">Add Person</span>
          <strong>新增人员并写入后端草稿</strong>
          <p>企业 SSO 下会尝试 Fortress 补全；Demo 登录下直接生成 MVP 后端草稿。</p>
        </div>
        <button className="ghost-action" type="button" onClick={onCancel}>
          收起
        </button>
      </div>
      <PeopleAddSteps activeStep={activeAddStep} statusState={status.state} />
      <div className="skill-draft-form">
        <label>
          <span>姓名</span>
          <input value={form.name} onChange={(event) => updateField("name", event.target.value)} required />
        </label>
        <label>
          <span>邮箱</span>
          <input value={form.email} onChange={(event) => updateField("email", event.target.value)} type="email" required />
        </label>
        <label>
          <span>部门</span>
          <select value={form.departmentId} onChange={(event) => updateDepartment(event.target.value)}>
            <option value="">由企业目录补全</option>
            {departmentOptions.map((department) => (
              <option key={department.id} value={department.id}>
                {department.path?.join(" / ") || department.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>治理角色</span>
          <select value={form.governanceRole} onChange={(event) => updateField("governanceRole", event.target.value)}>
            <option value="普通成员">普通成员</option>
            <option value="部门管理员">部门管理员</option>
            <option value="部门负责人">部门负责人</option>
            <option value="系统管理员">系统管理员</option>
          </select>
        </label>
        <div className="skill-draft-actions">
          <span>{status.message || "新增后会按部门归属绑定治理范围，并写入 MVP 后端草稿"}</span>
          <button className="primary-action" type="submit" disabled={status.state === "loading" || isSaving}>
            {status.state === "loading" ? "补全中" : isSaving ? "保存中" : "补全并新增"}
          </button>
        </div>
      </div>
    </form>
  );
}

function PeopleAddSteps({ activeStep, statusState }) {
  const steps = [
    { label: "录入", detail: "姓名 / 邮箱" },
    { label: "后端补全", detail: statusState === "error" ? "补全失败" : "MVP / Fortress" },
    { label: "待确认", detail: "管理员确认" },
    { label: "后端草稿", detail: "MVP 持久化" },
  ];

  return (
    <div className="people-add-steps" aria-label="新增人员步骤">
      {steps.map((step, index) => {
        const isActive = index === activeStep;
        const isComplete = index < activeStep;
        const isError = statusState === "error" && index === activeStep;
        return (
          <div
            className={`people-add-step ${isActive ? "is-active" : ""} ${isComplete ? "is-complete" : ""} ${isError ? "is-error" : ""}`}
            key={step.label}
          >
            <span className="people-add-index">{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </div>
        );
      })}
    </div>
  );
}
