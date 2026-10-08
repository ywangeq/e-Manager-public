import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CaretDown, SpinnerGap } from "@phosphor-icons/react";
import "./artifact-delivery.css";

export function ArtifactDeliveryEntry({ gate, inline = false, onDeliverArtifact, onInspectArtifact }) {
  const [artifact, setArtifact] = useState(null);
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);
  const callbacks = useRef({ onDeliverArtifact, onInspectArtifact });
  callbacks.current = { onDeliverArtifact, onInspectArtifact };

  useEffect(() => {
    const current = ++generation.current;
    const active = () => generation.current === current;
    setArtifact(null);
    setNotice("");
    setOperation(gate?.ready ? "inspect" : "");
    async function synchronize() {
      try {
        const inspected = await callbacks.current.onInspectArtifact?.(gate);
        if (!active()) return;
        if (!inspected?.ok || !inspected.artifact) {
          setNotice(artifactDeliveryFailureLabel(inspected?.status));
          return;
        }
        setArtifact(inspected.artifact);
        if (inspected.artifact.localAvailability === "landed") return;
        setOperation("materialize");
        const result = await callbacks.current.onDeliverArtifact?.({ ...gate, action: "materialize" });
        if (!active()) return;
        if (result?.artifact) setArtifact(result.artifact);
        if (!result?.ok) setNotice(artifactDeliveryFailureLabel(result?.status));
      } catch {
        if (active()) setNotice(artifactDeliveryFailureLabel("service_unavailable"));
      } finally {
        if (active()) setOperation("");
      }
    }
    if (gate?.ready) void synchronize();
    return () => { generation.current += 1; };
  }, [gate?.employeeId, gate?.taskId, gate?.artifactId, gate?.ready, reloadKey]);

  async function deliver(action) {
    if (!gate?.ready || !artifact || operation) return;
    const current = generation.current;
    setOperation(action);
    setNotice("");
    try {
      const result = await callbacks.current.onDeliverArtifact?.({ ...gate, action });
      if (generation.current !== current) return;
      if (result?.artifact) setArtifact(result.artifact);
      setNotice(result?.ok
        ? ({ opened: "已打开", revealed: "已定位" }[result.status] || "已下载")
        : artifactDeliveryFailureLabel(result?.status));
    } catch {
      if (generation.current === current) setNotice(artifactDeliveryFailureLabel("service_unavailable"));
    } finally {
      if (generation.current === current) setOperation("");
    }
  }

  const landed = artifact?.localAvailability === "landed";
  const primaryAction = artifact?.canOpen ? "open" : "reveal";
  const primaryActionLabel = artifact?.canOpen ? "打开文件" : "在文件夹中显示";
  return (
    <section className={`artifact-delivery-entry ${inline ? "has-inline" : ""}`} aria-live="polite" aria-busy={Boolean(operation)}>
      {inline && artifact ? <button
        type="button"
        className="artifact-inline-link"
        title={landed ? `${artifact.fileName} · ${primaryActionLabel}` : `${artifact.fileName} · 等待下载完成`}
        aria-label={`${artifact.fileName}，${landed ? primaryActionLabel : "等待下载完成"}`}
        disabled={!landed || Boolean(operation)}
        onClick={() => deliver(primaryAction)}
      >{artifact.fileName}</button> : null}
      <div className="artifact-delivery">
        <div className="artifact-delivery-copy">
          {artifact ? <button
            type="button"
            className="artifact-delivery-name"
            title={landed ? `${artifact.fileName} · ${primaryActionLabel}` : `${artifact.fileName} · 等待下载完成`}
            aria-label={`${artifact.fileName}，${landed ? primaryActionLabel : "等待下载完成"}`}
            disabled={!landed || Boolean(operation)}
            onClick={() => deliver(primaryAction)}
          >{artifact.fileName}</button> : <strong>任务产物</strong>}
          <small>{artifact
            ? `${formatArtifactSize(artifact.sizeBytes)} · ${artifact.mimeType} · ${operation === "materialize" ? "下载中" : landed ? "已下载" : "待下载"}`
            : !gate?.ready ? "等待任务完成" : operation === "inspect" ? "加载中" : notice ? "加载失败" : "等待文件信息"}</small>
        </div>
        <div className="artifact-delivery-actions">
          {artifact ? <details className="artifact-open-menu">
            <summary title="选择打开方式"><ArrowSquareOut size={14} />打开方式<CaretDown size={12} /></summary>
            <div>
              {artifact.canOpen ? <button type="button" disabled={Boolean(operation)} onClick={() => deliver("open")}>打开</button> : null}
              <button type="button" title={!landed ? "等待下载完成" : undefined} disabled={!landed || Boolean(operation)} onClick={() => deliver("reveal")}>在文件夹中显示</button>
            </div>
          </details> : null}
          {!landed ? <button type="button" disabled={!gate?.ready || Boolean(operation)} onClick={() => setReloadKey((value) => value + 1)}>
            {operation ? <SpinnerGap className="spin" size={14} /> : <ArrowClockwise size={14} />}{operation ? "处理中" : "重试"}
          </button> : null}
        </div>
        {notice ? <small className="artifact-delivery-notice">{notice}</small> : null}
      </div>
    </section>
  );
}

function formatArtifactSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactDeliveryFailureLabel(status) {
  return ({
    access_denied: "当前身份无权交付",
    authentication_changed: "账号状态已变化，请重试",
    authentication_required: "登录已失效，请重新认证",
    busy: "交付队列已满，请稍后重试",
    destination_exists: "本机工作区已存在同名文件",
    expired: "产物已过期",
    integrity_failed: "产物完整性校验失败",
    invalid_reference: "产物引用无效",
    metadata_invalid: "服务端文件信息无效",
    network_unavailable: "无法连接 Digital Center",
    not_completed: "任务尚未完成",
    not_found: "产物不可用或无访问权限",
    open_failed: "系统无法打开该文件",
    local_conflict: "本机工作区存在冲突文件，未覆盖",
    local_unavailable: "本机文件不可用，请重试交付",
    open_not_allowed: "此文件类型无法直接打开",
    reveal_failed: "系统无法在文件夹中定位该文件",
    save_failed: "下载失败，请重试交付",
    service_unavailable: "产物交付服务暂不可用",
  })[status] || "暂时无法交付，请重试";
}
