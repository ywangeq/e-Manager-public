import fs from "node:fs";
import path from "node:path";

export function createEvaluationDatasetReviewStore({
  storePath = "",
  cleanList,
  cleanText,
  defaultEvaluationDatasetNote,
  draftId,
  normalizeEvaluationDatasetDecision,
}) {
  const reviews = load();

  function load() {
    const loadedReviews = new Map();
    if (!storePath) return loadedReviews;
    try {
      if (!fs.existsSync(storePath)) return loadedReviews;
      const raw = fs.readFileSync(storePath, "utf8");
      if (!raw.trim()) return loadedReviews;
      const parsed = JSON.parse(raw);
      const decisions = parsed.decisions || parsed.decisionsByCaseId || {};
      Object.values(decisions).forEach((item) => {
        const review = normalizeReview(item);
        if (review.caseId) loadedReviews.set(review.caseId, review);
      });
    } catch (error) {
      console.warn(`[system-import] failed to load evaluation dataset store: ${error?.message || error}`);
    }
    return loadedReviews;
  }

  function persist() {
    if (!storePath) return { ok: true };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            version: "evaluation-dataset-reviews.v1",
            updatedAt: new Date().toISOString(),
            decisions: decisionMap(),
          },
          null,
          2,
        ),
      );
      return { ok: true };
    } catch (error) {
      console.warn(`[system-import] failed to persist evaluation dataset store: ${error?.message || error}`);
      return { ok: false, error: cleanText(error?.message || error) };
    }
  }

  function normalizeReview(review = {}) {
    const caseId = cleanText(review.caseId || "");
    const decision = normalizeEvaluationDatasetDecision(review.reviewStatus || review.decision || "");
    const reviewStatus = decision || "approved";
    return {
      reviewId: cleanText(review.reviewId || (caseId ? draftId("EVR", caseId) : "")),
      caseId,
      sourceEventId: cleanText(review.sourceEventId || ""),
      badcaseId: cleanText(review.badcaseId || ""),
      sourceSystemId: cleanText(review.sourceSystemId || ""),
      entityType: cleanText(review.entityType || ""),
      entityId: cleanText(review.entityId || ""),
      entityName: cleanText(review.entityName || ""),
      title: cleanText(review.title || ""),
      sourceName: cleanText(review.sourceName || ""),
      sourceType: cleanText(review.sourceType || ""),
      sourceTypeLabel: cleanText(review.sourceTypeLabel || ""),
      eventType: cleanText(review.eventType || ""),
      severity: cleanText(review.severity || ""),
      qualityStatus: cleanText(review.qualityStatus || review.status || ""),
      errorDomain: cleanText(review.errorDomain || ""),
      errorCode: cleanText(review.errorCode || ""),
      entityVersion: cleanText(review.entityVersion || ""),
      promptVersion: cleanText(review.promptVersion || ""),
      owner: cleanText(review.owner || ""),
      rootCauseCategory: cleanText(review.rootCauseCategory || ""),
      resolutionAction: cleanText(review.resolutionAction || ""),
      evidenceSummary: cleanText(review.evidenceSummary || ""),
      expectedSummary: cleanText(review.expectedSummary || ""),
      actualSummary: cleanText(review.actualSummary || ""),
      occurredAt: cleanText(review.occurredAt || review.eventAt || review.createdAt || ""),
      reportedAt: cleanText(review.reportedAt || review.submittedAt || ""),
      tags: cleanList(review.tags),
      reviewStatus,
      evalStatus: cleanText(review.evalStatus || (reviewStatus === "approved" ? "archived" : "candidate")),
      reviewedAt: cleanText(review.reviewedAt || ""),
      reviewedBy: cleanText(review.reviewedBy || ""),
      reviewNote: cleanText(review.reviewNote || defaultEvaluationDatasetNote(reviewStatus)),
      lastRunStatus: cleanText(review.lastRunStatus || "not_run"),
      lastRunId: cleanText(review.lastRunId || ""),
      lastRunAt: cleanText(review.lastRunAt || ""),
      lastRunSummary: cleanText(review.lastRunSummary || ""),
      productionEffect: "none",
      nextGate: cleanText(review.nextGate || ""),
      privacyBoundary: "测评集确认只保存安全摘要索引和人工结论；不保存 raw prompt、包内容、执行 payload、模型 trace、provider key、客户数据或员工 PII。",
    };
  }

  function decisionMap() {
    return Object.fromEntries(reviews.entries());
  }

  return {
    decisionMap,
    normalizeReview,
    persist,
    reviews,
  };
}
