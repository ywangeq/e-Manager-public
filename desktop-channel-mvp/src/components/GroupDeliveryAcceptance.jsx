import { useEffect, useRef, useState } from "react";
import "./group-delivery-acceptance.css";
import { runStatusLabel } from "../lib/groupRunHistory.js";

export function GroupDeliveryAcceptance({ projection, requester, onProjection, onOpenArtifacts, stale = false }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(false);
  const pending = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const status = projection?.status;
  if (!["awaiting_review", "execution_completed", "awaiting_acceptance", "accepted", "rejected"].includes(status)) return null;
  const available = status === "awaiting_acceptance" && projection.delivery?.deliveryDigest && typeof requester === "function" && !stale;
  async function decide(decision) {
    if (!available || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await requester({ runId: projection.runId, body: { goalId: projection.goalId,
        expectedRevision: projection.casRevision, deliveryDigest: projection.delivery.deliveryDigest, decision } });
      if (!live.current) return;
      if (!result?.ok || result.projection?.runId !== projection.runId || result.projection?.goalId !== projection.goalId) throw new Error("invalid");
      onProjection(result.projection); setConfirming(false);
    } catch {
      if (live.current) setError("验收未确认，请刷新任务后重试。");
    } finally { pending.current = false; if (live.current) setBusy(false); }
  }
  return <div className="group-plan-review group-delivery-acceptance" aria-label="交付验收">
    <strong>{runStatusLabel(status)}</strong>
    <button type="button" className="group-plan-open" onClick={onOpenArtifacts}>查看交付物</button>
    {available && !confirming ? <button type="button" className="group-plan-adopt" onClick={() => setConfirming(true)}>验收交付</button> : null}
    {available && confirming ? <><small>确认已检查本次交付物？</small><button type="button" className="group-plan-adopt" disabled={busy} onClick={() => decide("accepted")}>确认验收通过</button><button type="button" className="group-plan-open" disabled={busy} onClick={() => decide("rejected")}>验收不通过</button><button type="button" className="group-plan-open" disabled={busy} onClick={() => setConfirming(false)}>暂不验收</button></> : null}
    {projection.acceptance?.decidedAt ? <small>{new Date(projection.acceptance.decidedAt).toLocaleString()}</small> : null}
    {error ? <small role="alert">{error}</small> : null}
  </div>;
}
