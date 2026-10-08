import { createEvaluationDatasetReviewStore } from "./evaluation-dataset-review-store.mjs";
import {
  defaultEvaluationDatasetNote,
  normalizeEvaluationDatasetDecision as normalizeEvaluationDatasetDecisionValue,
} from "./system-import-review-helpers.mjs";

export function createEvaluationDatasetReviewHandlers({
  cleanList,
  cleanText,
  draftId,
  findUnsafePayloadKeys,
  forbiddenDataWarning,
  readJsonBody,
  requirePermission,
  sendJson,
  storePath = "",
  unsafePayload,
}) {
  const reviewStore = createEvaluationDatasetReviewStore({
    storePath,
    cleanList,
    cleanText,
    defaultEvaluationDatasetNote,
    draftId,
    normalizeEvaluationDatasetDecision,
  });
  const reviews = reviewStore.reviews;

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/quality-reviews/evaluation-dataset") {
      listReviews(req, res, url);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/quality-reviews/evaluation-dataset") {
      await submitReview(req, res);
      return true;
    }

    return false;
  }

  function listReviews(req, res, url) {
    const session = requirePermission(req, res, "quality-reviews:read");
    if (!session) return undefined;
    const reviewStatus = cleanText(url.searchParams.get("reviewStatus") || "");
    const caseId = cleanText(url.searchParams.get("caseId") || "");
    const decisions = [...reviews.values()]
      .filter((item) => !reviewStatus || item.reviewStatus === reviewStatus)
      .filter((item) => !caseId || item.caseId === caseId)
      .sort((left, right) => String(right.reviewedAt).localeCompare(String(left.reviewedAt)));
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      contractVersion: "evaluation-dataset-review-list.v1",
      decisions,
      decisionsByCaseId: Object.fromEntries(decisions.map((decision) => [decision.caseId, decision])),
      persistence: {
        kind: storePath ? "mvp-file-store" : "mvp-process-memory",
        productionReady: false,
        path: storePath ? "data/local/evaluation-dataset-reviews.json" : "",
        note: storePath
          ? "当前 MVP 用 ignored data/local 文件保存测评集入库确认，可跨服务重启保留；生产仍需要正式评测样本库、审计和回归运行记录。"
          : "当前 MVP 用后端进程内存保存测评集入库确认；生产需要持久化评测样本库、审计和回归运行记录。",
      },
      privacyBoundary: "只保存 badcase/eval 安全摘要的 caseId、错误码、对象、确认结论和备注；不保存 raw prompt、模型 trace、执行 payload、凭证、客户数据或员工 PII。",
    });
  }

  async function submitReview(req, res) {
    const session = requirePermission(req, res, "quality-reviews:edit");
    if (!session) return undefined;
    const input = await readJsonBody(req);
    const unsafeKeys = findUnsafePayloadKeys(input);
    if (unsafeKeys.length) return unsafePayload(res, unsafeKeys);

    const caseId = cleanText(input.caseId || input.id || "");
    const decision = normalizeEvaluationDatasetDecision(input.decision || input.reviewStatus);
    if (!caseId || !decision) {
      return sendJson(res, 422, {
        ok: false,
        error: "evaluation_dataset_review_target_required",
        contractVersion: "evaluation-dataset-review.v1",
        requiredFields: ["caseId", "decision"],
        allowedDecisions: ["approved", "rejected"],
      });
    }

    const reviewedAt = new Date().toISOString();
    const review = {
      reviewId: draftId("EVR", caseId),
      caseId,
      sourceEventId: cleanText(input.sourceEventId || ""),
      badcaseId: cleanText(input.badcaseId || ""),
      sourceSystemId: cleanText(input.sourceSystemId || ""),
      entityType: cleanText(input.entityType || ""),
      entityId: cleanText(input.entityId || ""),
      entityName: cleanText(input.entityName || ""),
      title: cleanText(input.title || ""),
      sourceName: cleanText(input.sourceName || ""),
      sourceType: cleanText(input.sourceType || ""),
      sourceTypeLabel: cleanText(input.sourceTypeLabel || ""),
      eventType: cleanText(input.eventType || ""),
      severity: cleanText(input.severity || ""),
      qualityStatus: cleanText(input.qualityStatus || input.status || ""),
      errorDomain: cleanText(input.errorDomain || ""),
      errorCode: cleanText(input.errorCode || ""),
      entityVersion: cleanText(input.entityVersion || ""),
      promptVersion: cleanText(input.promptVersion || ""),
      owner: cleanText(input.owner || ""),
      rootCauseCategory: cleanText(input.rootCauseCategory || ""),
      resolutionAction: cleanText(input.resolutionAction || ""),
      evidenceSummary: cleanText(input.evidenceSummary || ""),
      expectedSummary: cleanText(input.expectedSummary || ""),
      actualSummary: cleanText(input.actualSummary || ""),
      occurredAt: cleanText(input.occurredAt || input.eventAt || input.createdAt || ""),
      reportedAt: cleanText(input.reportedAt || input.submittedAt || ""),
      tags: cleanList(input.tags),
      reviewStatus: decision,
      evalStatus: decision === "approved" ? "archived" : "candidate",
      reviewedAt,
      reviewedBy: session.employeeId,
      reviewNote: cleanText(input.reviewNote || input.safeNotes || defaultEvaluationDatasetNote(decision)),
      lastRunStatus: cleanText(input.lastRunStatus || "not_run"),
      lastRunId: cleanText(input.lastRunId || ""),
      lastRunAt: cleanText(input.lastRunAt || ""),
      lastRunSummary: cleanText(input.lastRunSummary || (decision === "approved" ? "已确认入测评集，等待首次回归运行。" : "暂缓入库，等待补齐测评标准或修复证据。")),
      productionEffect: "none",
      nextGate:
        decision === "approved"
          ? "样本已进入 MVP 测评集归档；生产仍需持久化样本库、审计、回归 runner 和版本对比。"
          : "样本暂缓入库；补齐测评标准、根因动作或 owner 复核后再确认。",
      privacyBoundary: "测评集确认只保存安全摘要索引和人工结论；不保存 raw prompt、包内容、执行 payload、模型 trace、provider key、客户数据或员工 PII。",
    };
    const safeReview = reviewStore.normalizeReview(review);
    const previousReview = reviews.get(caseId);
    reviews.set(caseId, safeReview);
    const persistResult = reviewStore.persist();
    if (!persistResult.ok) {
      if (previousReview) {
        reviews.set(caseId, previousReview);
      } else {
        reviews.delete(caseId);
      }
      return sendJson(res, 500, {
        ok: false,
        error: "evaluation_dataset_store_write_failed",
        contractVersion: "evaluation-dataset-review.v1",
        message: "测评集入库决策未能写入 MVP 文件存储，已回滚本次内存状态。",
        detail: persistResult.error,
      });
    }
    return sendJson(res, 201, {
      ok: true,
      status: safeReview.reviewStatus,
      contractVersion: "evaluation-dataset-review.v1",
      review: safeReview,
      decisionsByCaseId: decisionMap(),
      warnings: [
        storePath
          ? "MVP 测评集入库确认写入 ignored data/local 文件；不会启动真实回归运行或写生产审计。"
          : "MVP 测评集入库确认只写入当前后端进程状态；不会启动真实回归运行或写生产审计。",
        forbiddenDataWarning,
      ],
    });
  }

  function decisionMap() {
    return reviewStore.decisionMap();
  }

  function normalizeEvaluationDatasetDecision(value) {
    return normalizeEvaluationDatasetDecisionValue(value, cleanText);
  }

  return {
    decisionMap,
    handle,
    listReviews: () => [...reviews.values()],
  };
}
