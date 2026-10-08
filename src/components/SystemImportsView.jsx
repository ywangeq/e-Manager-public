import { CheckCircle2, DatabaseZap, RefreshCcw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { digitalEmployees } from "../data/catalog";
import { badcasesForEntity, skillNameById, statusClass } from "../lib/consoleCatalog";
import { DetailGrid, ExpandableList, ExpandableRow, GovernanceBlock, SkillChips } from "./ConsolePrimitives";
import MetricCard from "./MetricCard";

export default function SystemImports({ pipelines, onNavigate }) {
  const alignedCount = pipelines.filter((pipeline) => pipeline.status === "API 对齐").length;
  const [importJobs, setImportJobs] = useState([]);
  const [jobsStatus, setJobsStatus] = useState("loading");
  const [jobsError, setJobsError] = useState("");
  const [reviewNotes, setReviewNotes] = useState({});
  const [reviewStatus, setReviewStatus] = useState({});
  const jobRows = useMemo(
    () => importJobs.map((job) => ({ job, jobRow: importJobRow(job) })),
    [importJobs],
  );
  const activeJobRows = jobRows.filter(({ jobRow }) => !isRejectedJobRow(jobRow));
  const rejectedJobRows = jobRows.filter(({ jobRow }) => isRejectedJobRow(jobRow));
  const reviewStepCount = activeJobRows.reduce((total, { jobRow }) => total + jobRow.steps.length, 0);
  const autoAgentCount = activeJobRows.reduce((total, { jobRow }) => total + (jobRow.autoWorkflow?.agentPreReviewCount || 0), 0);

  async function loadImportJobs() {
    setJobsStatus("loading");
    setJobsError("");
    try {
      const response = await fetch("/api/system-imports/jobs", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "安装草案读取失败");
      setImportJobs(data.importJobs || []);
      setJobsStatus("ready");
    } catch (error) {
      setImportJobs([]);
      setJobsStatus("error");
      setJobsError(error?.message || "安装草案读取失败");
    }
  }

  async function reviewJob(job, jobRow, decision) {
    const reviewKey = jobRow.rowId;
    setReviewStatus((current) => ({ ...current, [reviewKey]: { state: "loading", message: "" } }));
    try {
      const response = await fetch(`/api/system-imports/jobs/${encodeURIComponent(job.jobId)}/review`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: reviewNotes[reviewKey] || defaultJobReviewNote(decision, jobRow),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "评审操作失败");
      setImportJobs((current) => current.map((item) => (item.jobId === job.jobId ? data.importJob : item)));
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: {
          state: "ready",
          message: jobReviewSuccessMessage(decision, jobRow),
        },
      }));
    } catch (error) {
      setReviewStatus((current) => ({
        ...current,
        [reviewKey]: { state: "error", message: error?.message || "评审操作失败" },
      }));
    }
  }

  useEffect(() => {
    loadImportJobs();
  }, []);

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="接入管线" value={pipelines.length} detail="Skill / 更新 / 分发 / 需求" />
        <MetricCard label="API 对齐" value={alignedCount} detail="契约草案已声明" />
        <MetricCard label="人审门禁" value={pipelines.filter((pipeline) => pipeline.reviewGate).length} detail="导入后不自动入库" />
        <MetricCard label="接入状态" value={activeJobRows.length} detail={jobsStatus === "ready" ? `${autoAgentCount} 个 Agent 预审 / ${reviewStepCount} 个后台状态` : "读取中"} onClick={loadImportJobs} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Intake State</p>
            <h2>接入状态与自动预审核</h2>
          </div>
          <button className="ghost-action" type="button" onClick={loadImportJobs} disabled={jobsStatus === "loading"}>
            <RefreshCcw size={16} />
            刷新
          </button>
        </div>
        <p className="import-review-guide">
          上传后系统只保留轻量接入状态；Skill 内容由系统级数字员工自动预审核，人工只在「技能/员工评审」里消费整理后的评审稿。Job ID、Worker lane 只作为技术追踪字段。
        </p>
        {jobsStatus === "error" ? (
          <p className="business-system-empty">{jobsError}</p>
        ) : importJobs.length ? (
          <>
            {activeJobRows.length ? (
              <ImportJobRows
                rows={activeJobRows}
                listId="system-import-drafts"
                reviewNotes={reviewNotes}
                reviewStatus={reviewStatus}
                setReviewNotes={setReviewNotes}
                reviewJob={reviewJob}
                onNavigate={onNavigate}
              />
            ) : (
              <p className="business-system-empty">
                当前没有接入状态需要处理。已驳回的记录已收纳到下方，可展开回看。
              </p>
            )}
            {rejectedJobRows.length ? (
              <details className="import-rejected-archive">
                <summary>
                  <span>
                    <strong>已驳回收纳</strong>
                    <small>这些草案已记录驳回结论，不再占用待处理队列。</small>
                  </span>
                  <b>{rejectedJobRows.length} 项</b>
                </summary>
                <ImportJobRows
                  rows={rejectedJobRows}
                  listId="system-import-rejected-drafts"
                  reviewNotes={reviewNotes}
                  reviewStatus={reviewStatus}
                  setReviewNotes={setReviewNotes}
                  reviewJob={reviewJob}
                  onNavigate={onNavigate}
                />
              </details>
            ) : null}
          </>
        ) : (
          <p className="business-system-empty">
            {jobsStatus === "loading" ? "正在读取接入状态..." : "当前后端进程内还没有接入状态。提交上传请求后会出现在这里。"}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">System Intake</p>
            <h2>自动解析与技能更新接入</h2>
          </div>
          <span className="status-pill warn">上传后自动预审</span>
        </div>
        <ExpandableList>
          {({ openRowId, setOpenRowId }) => pipelines.map((pipeline) => (
            <ExpandableRow
              key={pipeline.id}
              rowId={pipeline.id}
              listId="system-imports"
              openRowId={openRowId}
              setOpenRowId={setOpenRowId}
              icon={<DatabaseZap size={18} />}
              title={pipeline.name}
              description={`${pipeline.source} -> ${pipeline.target}`}
              status={<span className={`status-pill ${statusClass(pipeline.status)}`}>{pipeline.status}</span>}
              summary={[
                pipeline.version,
                skillNameById(pipeline.ownerEmployeeId, digitalEmployees),
                pipeline.output,
                "API 见 docs/api.md",
              ]}
            >
              <div className="gate-line">
                <CheckCircle2 size={16} />
                {pipeline.reviewGate}
              </div>
              <DetailGrid
                items={[
                  ["来源", pipeline.source],
                  ["目标", pipeline.target],
                  ["Owner 数字员工", skillNameById(pipeline.ownerEmployeeId, digitalEmployees)],
                  ["版本", pipeline.version],
                  ["输出", pipeline.output],
                  ["API 文档", "docs/api.md"],
                ]}
              />
              <GovernanceBlock constraints={pipeline.constraints} promptKeys={[pipeline.apiEndpoint]} badcases={badcasesForEntity(pipeline.id)} />
            </ExpandableRow>
          ))}
        </ExpandableList>
      </section>
    </section>
  );
}

function ImportJobRows({ rows, listId, reviewNotes, reviewStatus, setReviewNotes, reviewJob, onNavigate }) {
  return (
    <ExpandableList className="import-draft-list">
      {({ openRowId, setOpenRowId }) =>
        rows.map(({ job, jobRow }) => (
          <ExpandableRow
            key={jobRow.rowId}
            rowId={jobRow.rowId}
            listId={listId}
            openRowId={openRowId}
            setOpenRowId={setOpenRowId}
            icon={<DatabaseZap size={18} />}
            title={jobRow.title}
            description={jobRow.description}
            status={<span className={`status-pill ${statusClass(jobRow.status)}`}>{jobRow.status}</span>}
            summary={jobRow.summary}
          >
            {jobRow.autoWorkflow ? <ImportAutoWorkflowSummary jobRow={jobRow} /> : null}
            {!jobRow.autoWorkflow ? <ImportJobContext job={job} jobRow={jobRow} /> : null}
            <ImportJobSummaryGroups job={job} jobRow={jobRow} />
            {jobRow.autoWorkflow ? (
              <details className="import-route-details">
                <summary>
                  <span>对象路由明细</span>
                  <b>{jobRow.steps.length} 个对象</b>
                </summary>
                <ImportJobSteps steps={jobRow.steps} />
              </details>
            ) : (
              <ImportJobSteps steps={jobRow.steps} />
            )}
            {jobRow.autoWorkflow ? (
              <details className="import-route-details">
                <summary>
                  <span>接入上下文</span>
                  <b>来源与 Worker</b>
                </summary>
                <ImportJobContext job={job} jobRow={jobRow} />
              </details>
            ) : null}
            <ImportJobReviewPanel
              jobRow={jobRow}
              note={reviewNotes[jobRow.rowId]}
              status={reviewStatus[jobRow.rowId]}
              onNoteChange={(note) => setReviewNotes((current) => ({ ...current, [jobRow.rowId]: note }))}
              onDecision={(decision) => reviewJob(job, jobRow, decision)}
              onNavigate={onNavigate}
            />
          </ExpandableRow>
        ))
      }
    </ExpandableList>
  );
}

function ImportJobContext({ job, jobRow }) {
  return (
    <>
      <div className="gate-line">
        <CheckCircle2 size={16} />
        {jobRow.reviewGate || job.reviewGate}
      </div>
      <DetailGrid
        items={[
          ["状态对象", jobRow.reviewObject],
          ["来源摘要", jobRow.sourceSummary],
          ["下一步门禁", jobRow.nextGate],
          ["预审 Worker", jobRow.preReviewLabel],
          ["固定 Worker", jobRow.assignedWorkerLabel],
        ]}
      />
    </>
  );
}

function ImportAutoWorkflowSummary({ jobRow }) {
  const workflow = jobRow.autoWorkflow || {};
  const items = [
    ["来源状态", workflow.sourceState === "background_only" ? "已转后台状态" : workflow.sourceState],
    ["Skill 评审稿", workflow.agentPreReviewCount ? `${workflow.agentPreReviewCount} 个已由 Agent 预审` : ""],
    ["流转去向", workflow.nextGate],
  ];
  return (
    <section className="import-auto-summary" aria-label="自动流转摘要">
      <div>
        <span className="eyebrow">Auto Routed</span>
        <strong>系统已完成接入预处理</strong>
        <p>{workflow.note || "来源草案只保留为后台状态；人工确认消费结构化评审稿。"}</p>
      </div>
      <dl>
        {items.filter(([, value]) => value).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ImportJobSteps({ steps }) {
  return (
    <div className="import-job-steps" aria-label="导入审核步骤">
      {steps.map((step, index) => (
        <article className="import-job-step" key={step.rowId}>
          <div className="import-job-step-head">
            <span className="step-index">{index + 1}</span>
            <div>
              <strong>{step.stepTitle}</strong>
              <p>{step.stepDescription}</p>
            </div>
            <span className={`status-pill ${statusClass(step.status)}`}>{step.status}</span>
          </div>
          <div className="import-job-step-meta">
            {[step.reviewObject, step.nextGate ? `下一步：${step.nextGate}` : "", step.draftId ? `草案 ID：${step.draftId}` : ""]
              .filter(Boolean)
              .map((item) => (
                <b key={item}>{item}</b>
              ))}
          </div>
          {step.reviewDecision ? (
            <small className="status-note">
              已记录：{decisionText(step.reviewDecision.decision)} · {step.reviewDecision.workflowEffect || step.reviewDecision.nextGate}
            </small>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function ImportJobSummaryGroups({ job, jobRow }) {
  const groups = [
    {
      title: "对象与去向",
      description: "人只确认最终评审对象，不阅读原始来源草案。",
      items: [
        `${jobRow.steps.length} 个后台对象`,
        jobRow.autoWorkflow ? "来源草案后台留痕" : "",
        jobRow.nextGate ? `下一步：${jobRow.nextGate}` : "",
        jobRow.reviewObject,
      ],
    },
    {
      title: "包读取摘要",
      description: "只展示是否安全读取到必要声明，完整碎片收进追踪区。",
      items: compactPackageItems(jobRow.installClaims),
    },
    {
      title: "权限与边界",
      description: "聚合 Skill ID、输入输出、工具和平台记录边界。",
      items: compactBoundaryItems([...jobRow.claims, ...jobRow.platformRecordClaims]),
    },
    {
      title: "风险与缺口",
      description: jobRow.warnings.length ? "需要后续门禁关注。" : "当前接入状态没有额外阻断告警。",
      items: jobRow.warnings.length ? jobRow.warnings : ["无额外告警"],
      tone: jobRow.warnings.length ? "warn" : "good",
    },
  ];

  return (
    <section className="import-summary-groups" aria-label="接入信息聚合">
      {groups.map((group) => (
        <ImportSummaryGroup key={group.title} group={group} />
      ))}
      <details className="import-technical-trace">
        <summary>
          <span>技术追踪</span>
          <b>{job.jobId}</b>
        </summary>
        <DetailGrid
          items={[
            ["技术 Job ID", job.jobId],
            ["来源", job.sourceRef],
            ["管线", job.pipelineId],
            ["创建人", job.createdBy],
            ["创建时间", formatDateTime(job.createdAt)],
            ["持久化", "MVP 进程内草案"],
          ]}
        />
      </details>
    </section>
  );
}

function ImportSummaryGroup({ group }) {
  const items = uniqueItems(group.items);
  const visibleItems = items.slice(0, 4);
  const hiddenItems = items.slice(4);
  const className = ["import-summary-group", group.tone ? `is-${group.tone}` : ""].filter(Boolean).join(" ");
  return (
    <article className={className}>
      <div className="import-summary-group-head">
        <strong>{group.title}</strong>
        <span>{items.length}</span>
      </div>
      <p>{group.description}</p>
      <div className="import-summary-chips">
        {visibleItems.map((item) => (
          <b key={item}>{item}</b>
        ))}
      </div>
      {hiddenItems.length ? (
        <details className="import-summary-more">
          <summary>还有 {hiddenItems.length} 项</summary>
          <div className="import-summary-chips">
            {hiddenItems.map((item) => (
              <b key={item}>{item}</b>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function ImportJobReviewPanel({ jobRow, note, status, onNoteChange, onDecision, onNavigate }) {
  const isReviewed = jobRow.reviewDecision?.decision || jobRow.steps.every((step) => step.reviewDecision?.decision);
  const isBusy = status?.state === "loading";
  const decision = jobRow.reviewDecision?.decision;
  const decisionLabel = decision === "approved" ? "已通过" : decision === "rejected" ? "已驳回" : isReviewed ? "分项已评审" : "待评审";
  if (jobRow.autoWorkflow) {
    return (
      <section className="approval-action-panel">
        <div className="approval-action-head">
          <div>
            <strong>系统状态</strong>
            <p>无需在这里 check 原始草案；对应系统级数字员工已预审并写入结构化评审稿，人工只处理下一道门禁。</p>
          </div>
          <span className="status-pill info">自动预审核</span>
        </div>
        <DetailGrid
          items={[
            ["流程", jobRow.autoWorkflow.mode],
            ["Agent 预审", `${jobRow.autoWorkflow.agentPreReviewCount || 0} 个`],
            ["Skill 状态", `${jobRow.autoWorkflow.skillDraftCount || 0} 个`],
            ["员工状态", `${jobRow.autoWorkflow.employeeDraftCount || 0} 个`],
            ["下一步", jobRow.autoWorkflow.nextGate],
          ]}
        />
        <div className="approval-action-buttons" role="group" aria-label={`${jobRow.title} 后续动作`}>
          <button className="ghost-action table-action approval-pass" type="button" onClick={() => onNavigate?.("skillEmployeeReview")}>
            <CheckCircle2 size={15} />
            查看技能/员工评审
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="approval-action-panel">
      <div className="approval-action-head">
        <div>
          <strong>来源异常处理</strong>
          <p>
            只处理无法自动路由的来源或异常记录；正常 Skill 内容评审统一在「技能/员工评审」完成，不写正式目录、不调度 worker、不分配真实 provider key。
          </p>
        </div>
        <span className={`status-pill ${decision === "approved" ? "good" : decision === "rejected" ? "warn" : "muted"}`}>
          {decisionLabel}
        </span>
      </div>
      <textarea
        className="review-note-input"
        rows={3}
        value={note ?? jobRow.reviewDecision?.note ?? ""}
        onChange={(event) => onNoteChange(event.target.value)}
        placeholder="填写评审意见，例如：来源摘要、包边界和拆解结果可接受，提交到下一道人员/技能评审门禁。"
      />
      <div className="approval-action-buttons" role="group" aria-label={`${jobRow.title} 评审动作`}>
        <button className="ghost-action table-action approval-pass" type="button" onClick={() => onDecision("approved")} disabled={isBusy}>
          <CheckCircle2 size={15} />
          {jobRow.primaryActionLabel}
        </button>
        <button className="ghost-action table-action approval-return" type="button" onClick={() => onDecision("rejected")} disabled={isBusy}>
          <XCircle size={15} />
          驳回补充边界
        </button>
      </div>
      {jobRow.reviewDecision ? (
        <DetailGrid
          items={[
            ["评审人", jobRow.reviewDecision.decidedBy],
            ["评审时间", formatDateTime(jobRow.reviewDecision.decidedAt)],
            ["生产影响", jobRow.reviewDecision.productionEffect],
            ["流程影响", jobRow.reviewDecision.workflowEffect],
            ["下一步", jobRow.reviewDecision.nextGate],
          ]}
        />
      ) : null}
      {status?.message ? <small className={`status-note ${status.state === "error" ? "danger-note" : ""}`}>{status.message}</small> : null}
    </section>
  );
}

function importJobRow(job) {
  const steps = draftRowsForJob(job);
  const sourceLabel = sourceTypeLabel(job.sourceRef);
  const primaryStep = steps.find((step) => step.kindLabel === "业务 Skill 草案") || steps[0] || {};
  const skillStepCount = steps.filter((step) => step.kindLabel === "业务 Skill 草案" || step.kindLabel === "Skill 更新草案").length;
  const employeeStepCount = steps.filter((step) => step.kindLabel === "外部数字员工草案").length;
  const hasSkillPackageRegistration = steps.some((step) => step.isSkillPackageRegistration);
  const hasExternalEmployee = steps.some((step) => step.kindLabel === "外部数字员工草案" && !step.isSkillPackageRegistration);
  const preReview = job.preReview || {};
  const assignedWorkerLabel = uniqueItems(steps.map((step) => step.assignedWorkerLabel)).join(" / ");
  const sourceSummary = uniqueItems(steps.map((step) => step.sourceSummary))[0] || job.sourceRef;
  const nextGates = uniqueItems(steps.map((step) => step.nextGate));
  const reviewDecision = job.reviewDecision || null;

  return {
    rowId: job.jobId,
    title: jobTitleForSteps(job, steps, primaryStep),
    description: jobDescriptionForSteps({ sourceLabel, sourceSummary, hasSkillPackageRegistration, hasExternalEmployee, skillStepCount }),
    status: job.status,
    reviewGate: job.reviewGate,
    reviewDecision,
    autoWorkflow: job.autoWorkflow || null,
    reviewObject: hasSkillPackageRegistration ? "OpenAI Skill 包上传审核" : hasExternalEmployee ? "外部数字员工上传审核" : "外部能力导入审核",
    sourceSummary,
    nextGate: nextGates.join(" / "),
    steps,
    primaryActionLabel: hasSkillPackageRegistration || skillStepCount ? "确认来源并提交 Skill 评审" : hasExternalEmployee ? "登记审核通过" : "通过 MVP 评审",
    summary: [
      `来源：${sourceLabel}`,
      `${steps.length} 个后端步骤`,
      skillStepCount ? `${skillStepCount} 个 Skill 草案` : "",
      employeeStepCount && !hasSkillPackageRegistration ? `${employeeStepCount} 个员工草案` : "",
    ],
    preReviewLabel: [preReview.workerId, preReview.lane].filter(Boolean).join(" / "),
    assignedWorkerLabel,
    claims: uniqueItems(steps.flatMap((step) => step.claims)),
    installClaims: uniqueItems(steps.flatMap((step) => step.installClaims)),
    platformRecordClaims: uniqueItems(steps.flatMap((step) => step.platformRecordClaims)),
    warnings: uniqueItems(steps.flatMap((step) => step.warnings)),
  };
}

function compactPackageItems(items = []) {
  const preferred = [
    /包接收模式/,
    /已接收文件内容/,
    /已自动解压/,
    /已解析 manifest\/SKILL\.md/,
    /完整包|下载范围|安装/,
  ];
  return compactByPatterns(items, preferred, 6);
}

function compactBoundaryItems(items = []) {
  const preferred = [
    /Skill API ID/,
    /来源 Skill ID/,
    /追溯 Key/,
    /输入|输出/,
    /权限|工具|平台记录|不保存/,
  ];
  return compactByPatterns(items, preferred, 6);
}

function compactByPatterns(items = [], preferred = [], maxItems = 6) {
  const unique = uniqueItems(items);
  const selected = [];
  preferred.forEach((pattern) => {
    const match = unique.find((item) => pattern.test(item) && !selected.includes(item));
    if (match) selected.push(match);
  });
  unique.forEach((item) => {
    if (selected.length < maxItems && !selected.includes(item)) selected.push(item);
  });
  return selected.length ? selected : ["未声明"];
}

function isRejectedJobRow(jobRow = {}) {
  return jobRow.status === "mvp_review_rejected" ||
    jobRow.reviewDecision?.decision === "rejected" ||
    (jobRow.steps?.length > 0 && jobRow.steps.every((step) => step.status === "mvp_review_rejected" || step.reviewDecision?.decision === "rejected"));
}

function draftRowsForJob(job) {
  const drafts = job?.drafts || {};
  return [
    ...(drafts.skillDrafts || []).map((draft) => draftRow(job, draft, "业务 Skill 草案")),
    ...(drafts.skillUpdateDrafts || []).map((draft) => draftRow(job, draft, "Skill 更新草案")),
    ...(drafts.externalEmployeeDrafts || []).map((draft) => draftRow(job, draft, "外部数字员工草案")),
    ...(drafts.requirementDrafts || []).map((draft) => draftRow(job, draft, "需求候选草案")),
  ];
}

function draftRow(job, draft, kindLabel) {
  const assignedWorker = draft.assignedAiWorker;
  const preReview = job.preReview || {};
  const name = draft.name || draft.skillId || draft.externalEmployeeId || draft.sourceRef || draft.draftId;
  const downloadPolicy = draft.downloadPolicy || {};
  const packageBoundary = draft.packageBoundary || {};
  const packageIntake = draft.packageIntake || job.installDecomposition?.packageIntake || null;
  const sourceLabel = sourceTypeLabel(job.sourceRef || draft.sourceRef);
  const reviewObject = reviewObjectLabel(kindLabel, draft);
  const sourceSummary = draft.manifestSummary || draft.externalEmployeeSummary || draft.requirementSummary || draft.sourceRef || job.sourceRef;
  const nextGate = nextGateLabel(kindLabel, draft);
  const displayKind = displayKindLabel(kindLabel, draft);
  return {
    rowId: `${job.jobId}-${draft.draftId}`,
    draftId: draft.draftId,
    kindLabel,
    isSkillPackageRegistration: isSkillPackageIntakeDraft(draft),
    stepTitle: stepTitleForDraft(kindLabel, name, draft),
    stepDescription: stepDescriptionForDraft(kindLabel, sourceLabel, sourceSummary, draft),
    title: titleForDraft(kindLabel, name, draft),
    description: descriptionForDraft(kindLabel, sourceLabel, sourceSummary, draft),
    status: draft.status || job.status,
    reviewGate: draft.reviewGate,
    reviewDecision: draft.reviewDecision,
    reviewObject,
    sourceSummary,
    nextGate,
    actionKindLabel: isSkillPackageIntakeDraft(draft) ? "Skill 包来源登记" : kindLabel,
    summary: [
      `类型：${displayKind}`,
      `来源：${sourceLabel}`,
      nextGate ? `下一步：${nextGate}` : "",
      draft.skillId ? `Skill：${draft.name || draft.skillId}` : "",
      isSkillPackageIntakeDraft(draft) ? "登记项：Skill 包来源" : draft.externalEmployeeId ? `员工：${draft.name || draft.externalEmployeeId}` : "",
    ],
    preReviewLabel: [preReview.workerId, preReview.lane].filter(Boolean).join(" / "),
    assignedWorkerLabel: assignedWorker ? [assignedWorker.workerId, assignedWorker.lane].filter(Boolean).join(" / ") : "",
    claims: [
      draft.skillApiId ? `Skill API ID：${draft.skillApiId}` : "",
      draft.sourceSkillId ? `来源 Skill ID：${draft.sourceSkillId}` : "",
      draft.lineageKey ? `追溯 Key：${draft.lineageKey}` : "",
      ...(draft.declaredInputs || []),
      ...(draft.declaredOutputs || []),
      ...(draft.permissionClaims || []),
      ...(draft.toolClaims || []),
      ...(draft.mountedSkillHints || []),
      ...(draft.mountHints || []),
    ],
    installClaims: [
      draft.packageFormat,
      draft.packageCompleteness,
      draft.packageRecordBoundary,
      packageIntake ? `包接收模式：${packageIntake.mode}` : "",
      packageIntake ? `已接收文件内容：${packageIntake.contentReceived ? "是" : "否"}` : "",
      packageIntake ? `已自动解压：${packageIntake.unpacked ? "是" : "否"}` : "",
      packageIntake ? `已解析 manifest/SKILL.md：${packageIntake.manifestParsed ? "是" : "否"}` : "",
      packageIntake?.note,
      ...(packageBoundary.portableContents || []).map((item) => `包内：${item}`),
      downloadPolicy.permission,
      downloadPolicy.audience ? `下载范围：${downloadPolicy.audience}` : "",
      draft.installGranularity,
      draft.identityRule,
      ...(draft.decompositionRule || []),
      ...(draft.dependencySkillIds || []).map((id) => `依赖 Skill：${id}`),
      ...(draft.referenceSkillIds || []).map((id) => `Reference Skill：${id}`),
      draft.unitCapabilityRule,
      draft.lineageRule,
      ...(draft.dependencyPolicy || []),
      ...(draft.referencePolicy || []),
      ...(packageIntake?.requiredForAutoUnpack || []).map((item) => `自动拆包要求：${item}`),
    ].filter(Boolean),
    platformRecordClaims: [
      ...(packageBoundary.platformRecords || []).map((item) => `平台记录：${item}`),
      draft.privacyBoundary,
    ].filter(Boolean),
    warnings: [...(job.permissionWarnings || []), ...(job.warnings || [])],
  };
}

function jobTitleForSteps(job, steps, primaryStep = {}) {
  const source = String(job.sourceRef || "").replace(/^[a-z-]+:\/\//i, "");
  const fallback = source || job.jobId;
  if (steps.some((step) => step.isSkillPackageRegistration)) {
    const skillName = primaryStep.title?.replace(/^外部业务 Skill 导入草案：/, "");
    return `OpenAI Skill 包上传审核：${skillName || fallback}`;
  }
  if (steps.some((step) => step.kindLabel === "外部数字员工草案")) return `外部数字员工上传审核：${fallback}`;
  if (steps.some((step) => step.kindLabel === "Skill 更新草案")) return `Skill 更新审核：${fallback}`;
  return `导入审核：${fallback}`;
}

function jobDescriptionForSteps({ sourceLabel, sourceSummary, hasSkillPackageRegistration, hasExternalEmployee, skillStepCount }) {
  if (hasSkillPackageRegistration) {
    return `${sourceLabel} 的同一次上传；一起查看来源登记和 ${skillStepCount || 1} 个 Skill 草案，确认后分别进入后续门禁。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
  }
  if (hasExternalEmployee) {
    return `${sourceLabel} 的外部数字员工登记；一起查看来源、权限、工具和关联 Skill 线索。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
  }
  return `${sourceLabel} 的导入草案；一起查看拆解结果和下一步门禁。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
}

function stepTitleForDraft(kindLabel, name, draft) {
  if (isSkillPackageIntakeDraft(draft)) return "来源登记";
  if (kindLabel === "业务 Skill 草案") return `Skill 草案：${draft.name || draft.skillId || name}`;
  if (kindLabel === "Skill 更新草案") return `Skill 更新：${draft.name || draft.skillId || name}`;
  if (kindLabel === "外部数字员工草案") return `人员草案：${draft.name || draft.externalEmployeeId || name}`;
  if (kindLabel === "需求候选草案") return `需求草案：${name}`;
  return kindLabel;
}

function stepDescriptionForDraft(kindLabel, sourceLabel, sourceSummary, draft) {
  if (isSkillPackageIntakeDraft(draft)) return `${sourceLabel} 来源和安全摘要确认；不代表 Skill 已发布。`;
  if (kindLabel === "业务 Skill 草案") return `确认 Skill ID、输入输出、权限工具和挂载影响。${sourceSummary ? ` ${sourceSummary}` : ""}`;
  if (kindLabel === "外部数字员工草案") return `确认归属人、部门、权限边界和试运行资格。${sourceSummary ? ` ${sourceSummary}` : ""}`;
  return sourceSummary || draft.reviewGate || "";
}

function titleForDraft(kindLabel, name, draft) {
  if (isSkillPackageIntakeDraft(draft)) return "外部业务 Skill 包来源登记草案";
  if (kindLabel === "业务 Skill 草案") {
    const skillName = draft.name && !isGenericIntakeName(draft.name) ? draft.name : draft.skillId;
    return skillName ? `外部业务 Skill 导入草案：${skillName}` : "外部业务 Skill 导入草案";
  }
  if (kindLabel === "外部数字员工草案") {
    if (isGenericIntakeName(name) || name === "待拆解外部数字员工") return "外部数字员工来源登记草案";
    return `外部数字员工登记草案：${name}`;
  }
  return name;
}

function descriptionForDraft(kindLabel, sourceLabel, sourceSummary, draft) {
  if (isSkillPackageIntakeDraft(draft)) {
    return `${sourceLabel} 的来源登记记录；它不是正式 Skill，后续以拆解出的业务 Skill 草案进入技能/员工评审。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
  }
  if (kindLabel === "业务 Skill 草案") {
    return `${sourceLabel} 已拆解为待技能评审草案；请确认 Skill ID、输入输出、权限工具和挂载影响。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
  }
  if (kindLabel === "外部数字员工草案") {
    return `${sourceLabel} 已登记为外部数字员工候选；请确认归属人、部门、权限边界和试运行资格。${sourceSummary ? ` 来源摘要：${sourceSummary}` : ""}`;
  }
  return sourceSummary;
}

function reviewObjectLabel(kindLabel, draft) {
  if (isSkillPackageIntakeDraft(draft)) return "外部业务 Skill 包来源登记草案";
  if (kindLabel === "业务 Skill 草案") return "外部包 / repo link 拆解出的业务 Skill 草案";
  if (kindLabel === "外部数字员工草案") return "外部数字员工来源登记草案";
  if (kindLabel === "Skill 更新草案") return "已有 Skill 更新候选";
  if (kindLabel === "需求候选草案") return "业务需求候选草案";
  return draft.kind || kindLabel;
}

function nextGateLabel(kindLabel, draft) {
  if (isSkillPackageIntakeDraft(draft)) return "来源登记审核";
  if (kindLabel === "业务 Skill 草案" || kindLabel === "Skill 更新草案") return "技能/员工评审";
  if (kindLabel === "外部数字员工草案") return "人员审批";
  if (kindLabel === "需求候选草案") return "业务 owner 评审";
  return "平台复盘";
}

function displayKindLabel(kindLabel, draft) {
  if (isSkillPackageIntakeDraft(draft)) return "Skill 包来源登记";
  return kindLabel;
}

function sourceTypeLabel(sourceRef = "") {
  const source = String(sourceRef || "");
  if (/^openai-skill-package:\/\//i.test(source)) return "OpenAI Skill 包";
  if (/^external-agent-package:\/\//i.test(source)) return "外部员工包";
  if (/^repo:\/\//i.test(source)) return "Repo link";
  if (/^requirement:\/\//i.test(source)) return "需求来源";
  return "外部来源";
}

function isGenericIntakeName(name = "") {
  return ["专业技能上传登记", "业务技能上传登记", "专业技能上传安装登记", "外部业务 Skill 包登记"].includes(String(name || "").trim());
}

function isSkillPackageIntakeDraft(draft = {}) {
  return /Skill 包登记|专业技能上传|业务技能上传/i.test(String(draft.title || draft.name || "")) ||
    (draft.toolClaims || []).some((claim) => /SKILL\.md|OpenAI Skill|manifest 安装解析/i.test(String(claim || "")));
}

function defaultJobReviewNote(decision, jobRow = {}) {
  if (decision !== "approved") return "管理员退回，需补充治理边界后再评审。";
  if ((jobRow.steps || []).some((step) => step.isSkillPackageRegistration)) {
    return "登记员确认外部 Skill 包来源和拆解结果可进入后续 Skill 草案评审。";
  }
  if ((jobRow.steps || []).some((step) => step.kindLabel === "外部数字员工草案")) {
    return "登记员确认安全摘要可进入人员审批。";
  }
  return "管理员确认 MVP 安全摘要可进入下一门禁。";
}

function jobReviewSuccessMessage(decision, jobRow = {}) {
  if (decision !== "approved") return "已记录 MVP 驳回结论。";
  if ((jobRow.steps || []).some((step) => step.isSkillPackageRegistration)) return "已确认来源和拆解结果，Skill 草案进入待技能评审。";
  if ((jobRow.steps || []).some((step) => step.kindLabel === "外部数字员工草案")) return "登记审核通过，已进入待人员审批。";
  return "已记录 MVP 通过结论。";
}

function decisionText(decision = "") {
  if (decision === "approved") return "通过";
  if (decision === "rejected") return "驳回";
  if (decision.startsWith("auto_")) return "自动处理";
  return decision || "已记录";
}

function uniqueItems(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
