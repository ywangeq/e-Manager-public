import { useEffect, useRef, useState } from "react";

export function GroupReviewOpinions({ runId, requester }) {
  const [opinions, setOpinions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function read() {
    if (loading) return;
    const started = generation.current;
    setLoading(true); setError(""); setOpinions(null);
    try {
      if (!requester) throw new Error("desktop_group_request_unavailable");
      const result = await requester({ runId });
      if (generation.current === started) setOpinions(result.reviewOpinions || []);
    } catch (failure) {
      if (generation.current === started) setError(/^group_[a-z0-9_]+$/.test(failure?.code || "") ? failure.code : "group_review_opinion_unavailable");
    } finally { if (generation.current === started) setLoading(false); }
  }
  return <section className="group-attachment-feedback" aria-label="复核拒绝意见">
    <button type="button" onClick={read} disabled={loading}>{loading ? "正在读取…" : "查看拒绝意见"}</button>
    {error ? <p role="alert">{error}</p> : null}
    {opinions?.map(opinion => <article key={opinion.artifactId}><strong>{opinion.stepId} · 拒绝</strong><p style={{ whiteSpace: "pre-wrap" }}>{opinion.opinionSummary}</p></article>)}
    {opinions?.length === 0 ? <p>暂无可读取的拒绝意见。</p> : null}
  </section>;
}
