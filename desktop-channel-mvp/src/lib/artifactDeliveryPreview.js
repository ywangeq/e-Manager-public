const PREVIEW_ARTIFACTS = Object.freeze({
  default: Object.freeze({ fileName: "训练分析报告.md", mimeType: "text/markdown", sizeBytes: 28_416, canOpen: true }),
  long: Object.freeze({ fileName: "多模态算法训练与回归分析结果_最终审核版_2026-09-08_with-an-extra-long-name.md", mimeType: "text/markdown", sizeBytes: 128_416, canOpen: true }),
  csv: Object.freeze({ fileName: "sandbox_acceptance_summary_fixed.csv", mimeType: "text/csv", sizeBytes: 63, canOpen: false }),
  downloading: Object.freeze({ fileName: "正在下载的训练分析报告.md", mimeType: "text/markdown", sizeBytes: 72_180, canOpen: true }),
});

export function artifactDeliveryPreviewState(search = "") {
  const requested = new URLSearchParams(String(search || "")).get("artifactState") || "default";
  return ["long", "csv", "downloading", "error"].includes(requested) ? requested : "default";
}

export function inspectArtifactPreview({ artifactId = "", previewMode = "", state = "default" } = {}) {
  if (previewMode !== "reusable-material") return { ok: false, status: "service_unavailable" };
  if (state === "error") return { ok: false, status: "network_unavailable" };
  const fixture = PREVIEW_ARTIFACTS[state] || PREVIEW_ARTIFACTS.default;
  return {
    ok: true,
    status: "available",
    artifact: {
      artifactId,
      ...fixture,
      deliveryStatus: "available",
      localAvailability: state === "downloading" ? "remote" : "landed",
    },
  };
}

export function deliverArtifactPreview({ action = "", previewMode = "", state = "default" } = {}) {
  if (previewMode !== "reusable-material") return Promise.resolve({ ok: false, status: "service_unavailable" });
  if (state === "error") return Promise.resolve({ ok: false, status: "network_unavailable" });
  if (state === "downloading" && action === "materialize") return new Promise(() => {});
  if (action === "open") return Promise.resolve({ ok: true, status: "opened" });
  if (action === "reveal") return Promise.resolve({ ok: true, status: "revealed" });
  return Promise.resolve({ ok: false, status: "invalid_reference" });
}
