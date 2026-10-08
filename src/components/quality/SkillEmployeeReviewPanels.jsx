import { CheckCircle2, ClipboardList, Settings2, UsersRound, XCircle } from "lucide-react";
import { preReviewWorkers } from "../../data/catalog";
import { displaySkillStatus, statusClass } from "../../lib/consoleCatalog";
import { DetailGrid, ExpandableList, ExpandableRow, SkillChips } from "../ConsolePrimitives";
import AgentPreReviewPanel from "./AgentPreReviewPanel";

const preReviewWorkerById = new Map(preReviewWorkers.map((worker) => [worker.id, worker]));

function mountedSkillDisplayNames(draft = {}) {
  const summaries = Array.isArray(draft.mountedSkillSummaries) ? draft.mountedSkillSummaries : [];
  const names = summaries
    .map((skill) => skill?.name || skill?.skillApiId || skill?.id)
    .filter(Boolean);
  if (names.length) return [...new Set(names)];
  return draft.mountedSkillHints?.length ? draft.mountedSkillHints : ["待确认是否补充 Skill 评审"];
}

export function AuditRequestBoard({ requests }) {
  return (
    <div className="audit-request-inline-board">
      <div className="panel-head compact-panel-head">
        <div>
          <p className="eyebrow">Audit Request Board</p>
          <h2>外部审计 Request 评审看板</h2>
        </div>
        <span className="status-pill warn">数字员工先检查，管理员再通过</span>
      </div>
      {requests.length ? (
        <ExpandableList>
          {({ openRowId, setOpenRowId }) => requests.map((request) => {
            const preReview = request.preReview || {};
            const worker = preReviewWorkerById.get(preReview.workerId);
            const codexLabel = preReview.codexConfig
              ? [preReview.codexConfig.model, preReview.codexConfig.reasoningEffort].filter(Boolean).join(" / ")
              : "";
            return (
              <ExpandableRow
                key={request.id}
                rowId={request.id}
                listId="external-audit-requests"
                openRowId={openRowId}
                setOpenRowId={setOpenRowId}
                icon={<ClipboardList size={18} />}
                title={request.title}
                description={request.checkSummary}
                status={<span className={`status-pill ${statusClass(request.status)}`}>{request.status}</span>}
                summary={[
                  request.requestType,
                  request.targetEntity,
                  request.auditorEmployee,
                  request.checkResult,
                  `风险 ${request.risk}`,
                  preReview.lane,
                  ...(request.tags || []),
                ]}
              >
                <div className="gate-line">
                  <CheckCircle2 size={16} />
                  {request.gate}
                </div>
                <DetailGrid
                  items={[
                    ["Request ID", request.id],
                    ["请求方", request.requester],
                    ["目标对象", request.targetEntity],
                    ["目标版本", request.targetVersion],
                    ["预审 Worker", worker?.name || preReview.workerId],
                    ["触发方式", preReview.triggerMode],
                    ["触发来源", preReview.triggerSource],
                    ["执行 ID", preReview.executionId],
                    ["Worker lane", preReview.lane],
                    ["预审状态", preReview.status],
                    ["Provider", preReview.provider],
                    ["执行配置", codexLabel],
                    ["服务端租约", preReview.keyLeaseMode === "pinned" ? "固定路由偏好" : "按需签发"],
                    ["租约引用", preReview.leaseRef || "服务端按需签发"],
                    ["推荐决策", preReview.recommendedDecision],
                    ["检查数字员工", request.auditorEmployee],
                    ["管理员", request.reviewer],
                    ["提交时间", request.submittedAt],
                    ["排队时间", preReview.queuedAt],
                    ["开始时间", preReview.startedAt],
                    ["完成时间", preReview.completedAt],
                    ["检查结论", request.checkResult],
                    ["风险等级", request.risk],
                  ]}
                />
                {preReview.queueNote ? (
                  <div className="gate-line">
                    <Settings2 size={16} />
                    {preReview.queueNote}
                  </div>
                ) : null}
                <SkillChips title="检查发现" items={request.findings} />
              </ExpandableRow>
            );
          })}
        </ExpandableList>
      ) : (
        <p className="business-system-empty">当前没有外部审计 request。</p>
      )}
    </div>
  );
}

export function SkillReviewDraftRow({ draft, openRowId, setOpenRowId, reviewNotes, reviewStatus, preReviewStatus, onNoteChange, onDecision, onPreReview }) {
  const reviewKey = `${draft.jobId}-${draft.draftId}`;
  const status = reviewStatus[reviewKey];
  const preStatus = preReviewStatus[reviewKey];
  const isBusy = status?.state === "loading";
  const agentPreReview = draft.agentPreReview;
  const agentBlocksApproval = ["failed", "blocked"].includes(agentPreReview?.status);
  const isUpdate = draft.draftKind === "skillUpdateDrafts" || draft.pipelineId === "external-skill-update-import";
  const versionTransition = [draft.previousVersion, draft.targetVersion || draft.versionIntent].filter(Boolean).join(" → ");
  const summary = [...new Set([
    isUpdate ? versionTransition : draft.versionIntent,
    draft.businessGroup,
    draft.targetDepartmentId,
    agentPreReview?.errorCode,
  ].filter(Boolean))];

  return (
    <ExpandableRow
      rowId={reviewKey}
      listId="skill-employee-review-drafts"
      openRowId={openRowId}
      setOpenRowId={setOpenRowId}
      icon={<ClipboardList size={18} />}
      title={draft.name}
      description={isUpdate && versionTransition ? `版本升级 ${versionTransition} · ${draft.manifestSummary || draft.sourceRef}` : draft.manifestSummary || draft.sourceRef}
      status={<span className={`status-pill ${statusClass(draft.status)}`}>{draft.status === "approved_deployment_failed" ? displaySkillStatus(draft.status) : isUpdate ? "技能升级" : displaySkillStatus(draft.status)}</span>}
      summary={summary}
    >
      <div className="gate-line">
        <CheckCircle2 size={16} />
        {draft.reviewGate}
      </div>
      <DetailGrid
        items={[
          ["来源类型", isUpdate ? "现有技能升级草案" : draft.draftKind === "catalogBusinessSkill" ? "专项业务技能目录" : "系统接入草案"],
          ["任务编号", draft.jobId],
          ["草案 ID", draft.draftId],
          ["技能接口标识", draft.skillApiId],
          ["来源技能标识", draft.sourceSkillId],
          ...(isUpdate ? [["当前版本", draft.previousVersion], ["目标版本", draft.targetVersion || draft.versionIntent]] : [["版本意图", draft.versionIntent]]),
          ["来源", draft.sourceRef],
          ["推荐业务组", draft.businessGroup],
          ["推荐依据", draft.businessGroupRecommendation?.rationale],
          ["推荐置信度", draft.businessGroupRecommendation?.confidence],
          ["归属部门", draft.targetDepartmentId],
          ["风险等级", draft.risk],
          ["运行执行类型", draft.runtimeExecutionProfile?.mode],
          ["部署状态", draft.deployment?.status === "failed" ? "部署失败，未生效" : draft.deployment?.status === "ready" ? "已验证" : "待审核部署"],
          ["部署错误码", draft.deployment?.errorCode],
        ]}
      />
      {isUpdate ? <SkillChips title="升级内容" items={draft.declaredChanges?.length ? draft.declaredChanges : ["待补充升级说明"]} compact /> : null}
      <SkillChips title="输入" items={draft.declaredInputs?.length ? draft.declaredInputs : ["待补充输入契约"]} compact />
      <SkillChips title="输出" items={draft.declaredOutputs?.length ? draft.declaredOutputs : ["待补充输出契约"]} compact />
      <SkillChips title="工具" items={draft.tools?.length ? draft.tools : ["待补充工具声明"]} compact />
      <SkillChips title="约束" items={draft.constraints?.length ? draft.constraints : ["待补充运行边界"]} compact />
      <SkillChips title="挂载影响" items={draft.mountHints?.length ? draft.mountHints : ["暂无挂载提示"]} compact />
      <AgentPreReviewPanel agentPreReview={agentPreReview} status={preStatus} onPreReview={onPreReview} />
      <section className="approval-action-panel">
        <div className="approval-action-head">
          <div>
            <strong>{isUpdate ? "技能升级评审" : "技能评审执行"}</strong>
            <p>{isUpdate ? "确认同一技能谱系、版本差异和回归影响；通过后生成目标版本的 MVP 发布记录，不新增技能标识、不自动挂载或分发。" : "先消费系统级 Agent 预审核结果，再由管理员确认；通过后只生成 MVP 发布记录，不执行仓库代码、不写正式目录、不自动挂载或分发。"}</p>
          </div>
          <span className={`status-pill ${agentBlocksApproval ? "warn" : "info"}`}>
            {agentBlocksApproval ? "需先处理预审核" : "待管理员确认"}
          </span>
        </div>
        <textarea
          className="review-note-input"
          rows={3}
          value={reviewNotes[reviewKey] || ""}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder={isUpdate ? "填写脱敏升级评审意见，例如：同一技能谱系、版本差异、兼容性和回归影响已确认。" : "填写脱敏评审意见，例如：技能标识、输入输出、提示词元数据、回归候选和挂载影响已确认。"}
        />
        <div className="approval-action-buttons" role="group" aria-label={`${draft.name} 技能评审动作`}>
          <button className="ghost-action table-action approval-pass" type="button" onClick={() => onDecision("approved")} disabled={isBusy || agentBlocksApproval}>
            <CheckCircle2 size={15} />
            {isUpdate ? "通过升级" : "通过发布"}
          </button>
          <button className="ghost-action table-action approval-return" type="button" onClick={() => onDecision("rejected")} disabled={isBusy}>
            <XCircle size={15} />
            驳回补充
          </button>
        </div>
        {status?.message ? <small className={`status-note ${status.state === "error" ? "danger-note" : ""}`}>{status.message}</small> : null}
      </section>
    </ExpandableRow>
  );
}

export function PublishedSkillSummary({ publications }) {
  return (
    <div className="governance-meta">
      <span>最近 MVP 发布</span>
      {publications.slice(0, 4).map((publication) => (
        <span key={publication.publicationId}>
          {publication.name || publication.skillId} · {displaySkillStatus(publication.status)}
        </span>
      ))}
    </div>
  );
}

export function defaultSkillReviewNote(decision, draft) {
  const isUpdate = draft.draftKind === "skillUpdateDrafts" || draft.pipelineId === "external-skill-update-import";
  const subject = isUpdate
    ? `${draft.name} 从 ${draft.previousVersion} 升级到 ${draft.targetVersion || draft.versionIntent}`
    : draft.name;
  if (decision === "approved") {
    return `确认 ${subject} 的技能标识、输入输出、提示词元数据、回归候选和挂载影响可进入 MVP 发布记录。`;
  }
  return `退回 ${subject}，需补齐技能标识、输入输出、提示词元数据、回归候选或挂载影响。`;
}

export function EmployeeReviewDraftRow({ draft, openRowId, setOpenRowId, reviewNotes = {}, reviewStatus = {}, onNoteChange, onAction, readOnly = false }) {
  const reviewKey = employeeReviewKey(draft);
  const status = reviewStatus[reviewKey];
  const isBusy = status?.state === "loading";
  const mountedSkillNames = mountedSkillDisplayNames(draft);

  return (
    <ExpandableRow
      rowId={reviewKey}
      listId="skill-employee-review-employees"
      openRowId={openRowId}
      setOpenRowId={setOpenRowId}
      icon={<UsersRound size={18} />}
      title={draft.name}
      description={draft.objective || draft.summary || draft.sourceRef}
      status={<span className={`status-pill ${statusClass(draft.status)}`}>{draft.status}</span>}
      summary={[
        draft.employeeId,
        draft.department,
        draft.businessGroup,
        draft.domain,
        draft.versionIntent,
        draft.pipelineId,
      ]}
    >
      <div className="gate-line">
        <CheckCircle2 size={16} />
        {draft.nextGate || draft.reviewGate}
      </div>
      <DetailGrid
        items={[
          ["来源类型", draft.draftKind === "catalogBusinessEmployee" ? "数字员工目录" : "系统接入草案"],
          ["Job ID", draft.jobId],
          ["草案 ID", draft.draftId],
          ["员工 ID", draft.employeeId],
          ["岗位", draft.title],
          ["归属部门", draft.department],
          ["业务组", draft.businessGroup],
          ["业务域", draft.domain],
          ["owner 线索", draft.ownerHint],
          ["输出契约", draft.outputContract],
          ["预审 Worker", draft.assignedAiWorker?.workerName || draft.assignedAiWorker?.workerId],
          ["包/平台边界", draft.packageRecordBoundary],
        ]}
      />
      <SkillChips title="权限声明" items={draft.permissionClaims?.length ? draft.permissionClaims : ["待确认权限范围"]} compact />
      <SkillChips title="工具边界" items={draft.toolClaims?.length ? draft.toolClaims : draft.tools?.length ? draft.tools : ["待确认工具边界"]} compact />
      <SkillChips title="挂载 Skill" items={mountedSkillNames} compact />
      <SkillChips title="运行规则" items={draft.rules?.length ? draft.rules : ["人员审批通过后进入在线状态"]} compact />
      <section className="approval-action-panel employee-review-action-panel">
        <div className="approval-action-head">
          <div>
            <strong>{readOnly ? "审核记录" : "人员审批执行"}</strong>
            <p>
              {readOnly
                ? "人员审批已通过；这里展示安全审核摘要，不提供重复审批动作。"
                : "确认归属、权限范围、输出契约、挂载 Skill 状态和停用策略；通过后数字员工进入在线状态。"}
            </p>
          </div>
          <span className={`status-pill ${readOnly ? "good" : "warn"}`}>
            {readOnly ? "已通过" : "待人员审批"}
          </span>
        </div>
        {readOnly ? (
          <DetailGrid
            items={[
              ["人员审批", draft.personnelApproval?.status],
              ["审批时间", draft.personnelApproval?.approvedAt],
              ["上线状态", draft.status],
              ["上线时间", draft.personnelApproval?.approvedAt || draft.reviewDecision?.decidedAt],
              ["审核意见", draft.reviewDecision?.note || draft.personnelApproval?.safeNotes],
              ["下一门禁", draft.reviewDecision?.nextGate],
            ]}
          />
        ) : (
          <>
            <textarea
              className="review-note-input"
              rows={3}
              value={reviewNotes[reviewKey] || ""}
              onChange={(event) => onNoteChange(event.target.value)}
              placeholder="填写人员审批意见，例如：归属、权限范围、输出契约、停用边界和挂载 Skill 状态已确认。"
            />
            <div className="approval-action-buttons" role="group" aria-label={`${draft.name} 员工评审动作`}>
              <>
                <button className="ghost-action table-action approval-pass" type="button" onClick={() => onAction("approve_personnel")} disabled={isBusy}>
                  <CheckCircle2 size={15} />
                  通过并上线
                </button>
                <button className="ghost-action table-action approval-return" type="button" onClick={() => onAction("reject_personnel")} disabled={isBusy}>
                  <XCircle size={15} />
                  驳回补充
                </button>
              </>
            </div>
          </>
        )}
        {status?.message ? <small className={`status-note ${status.state === "error" ? "danger-note" : ""}`}>{status.message}</small> : null}
      </section>
    </ExpandableRow>
  );
}

export function employeeReviewKey(draft) {
  return `employee-${draft.jobId}-${draft.draftId}`;
}

export function defaultEmployeeReviewNote(action, draft) {
  if (action === "reject_personnel") {
    return `退回 ${draft.name}，需补齐归属、权限范围、输出契约、挂载 Skill 状态或停用策略。`;
  }
  return `确认 ${draft.name} 的归属、权限范围、输出契约、挂载 Skill 状态和停用策略，人员审批通过并上线。`;
}

export function defaultEmployeeCheckedItems(action) {
  return ["归属部门", "业务 owner", "权限范围", "运行链路", "输出契约", "挂载 Skill 状态", "停用策略"];
}
