import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toolAssetInput, toolAssetRequest } from "../../lib/toolAssets";

const empty = { toolId: "", displayName: "", description: "", ownerDepartmentId: "", sourceSystemId: "", risk: "中",
  permissionBoundary: "", writebackBoundary: "", baseUrl: "", credentialRef: "", openApiDocument: "" };
const stateLabel = record => record.pendingReview ? "待审核" : record.state === "published" ? "已发布" : record.state === "disabled" ? "已停用" : "未发布";

export default function ToolAssetRegistration({ onChanged }) {
  const [assets, setAssets] = useState([]);
  const [options, setOptions] = useState({ systems: [], credentials: [] });
  const [access, setAccess] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState("configuration");
  const [notice, setNotice] = useState("");
  const closeRef = useRef(null);
  async function refresh() {
    const [list, connections] = await Promise.all([toolAssetRequest(), toolAssetRequest("/connections")]);
    setAssets(list.assets || []); setAccess(Boolean(list.canManage)); setOptions(connections);
  }
  useEffect(() => { refresh().catch(error => setError(error.message)); }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const escape = event => { if (event.key === "Escape" && !busy) setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); if (previous?.isConnected) previous.focus(); };
  }, [open, busy]);
  function load(record) {
    setRecord(record);
    const source = record?.asset;
    setDraft(source ? { ...toolAssetInput(source), openApiDocument: JSON.stringify(source.openApiDocument, null, 2) } : { ...empty, toolId: record?.toolId || "" });
    setDirty(false);
  }
  async function select(id) {
    setError(""); setNotice(""); setBusy(true);
    try { load(id ? (await toolAssetRequest(`/${encodeURIComponent(id)}`)).asset : null); setTab("configuration"); setOpen(true); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  function edit(key, value) { setDraft(current => ({ ...current, [key]: value })); setDirty(true); }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const asset = toolAssetInput(draft);
      await toolAssetRequest("", { asset, expectedVersion: record?.revision || 0 });
      load((await toolAssetRequest(`/${encodeURIComponent(asset.toolId)}`)).asset);
      setTab("review"); setNotice("合同校验通过，登记已提交待审核；尚未对员工启用。");
      await refresh();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function decide(decision) {
    setBusy(true); setError(""); setNotice("");
    try {
      await toolAssetRequest(`/${encodeURIComponent(record.toolId)}/decision`, { expectedVersion: record.revision, decision });
      load((await toolAssetRequest(`/${encodeURIComponent(record.toolId)}`)).asset);
      await refresh(); onChanged?.();
      setNotice(decision === "publish" ? "已发布。请到数字员工的工具配置中单独启用并核对操作权限。" : decision === "disable" ? "已停用，后续调用将被拒绝。" : "已驳回本次草稿，原发布版本保持不变。");
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function upload(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setError("OpenAPI 文件不能超过 1 MB。"); return; }
    try { const text = await file.text(); JSON.parse(text); edit("openApiDocument", text); setError(""); }
    catch { setError("请选择有效的 OpenAPI JSON 文件。"); }
  }
  const registered = assets.filter(item => item.editable);
  return <section className="tool-asset-registration">
    <div className="panel-head"><strong>Tool 登记与发布</strong>
      <button type="button" className="ghost-action" disabled={!access || busy} onClick={() => select("")}>登记工具</button>
    </div>
    {!open && error ? <p role="alert">{error} <button type="button" onClick={() => refresh().then(() => setError("")).catch(error => setError(error.message))}>重试</button></p> : null}
    <table><thead><tr><th>名称 / ID</th><th>资产状态</th><th>版本</th><th>操作</th></tr></thead>
      <tbody>{registered.map(item => <tr key={item.toolId}>
        <td>{(item.draft || item.published)?.displayName}<small>{item.toolId}</small></td>
        <td>{stateLabel(item)}{item.pendingReview && item.state === "published" ? "（原版本仍生效）" : ""}</td>
        <td>{item.revision}</td><td><button type="button" disabled={busy} onClick={() => select(item.toolId)}>配置 / 审核</button></td>
      </tr>)}</tbody></table>
    {!registered.length ? <p>尚无通过通用接口登记的 Tool。下方为已有发布目录与员工启用审批。</p> : null}
    {open ? createPortal(<div className="enterprise-tool-detail-drawer-backdrop">
      <aside className="enterprise-tool-detail enterprise-tool-detail-drawer tool-asset-sheet" role="dialog" aria-modal="true" aria-label="Tool 登记审核">
        <div className="enterprise-tool-detail-head"><strong>{record ? draft.displayName || record.toolId : "登记工具"}</strong>
          <button type="button" ref={closeRef} disabled={busy} onClick={() => setOpen(false)}>关闭</button></div>
        <div role="tablist" aria-label="Tool 登记步骤">
          <button type="button" role="tab" aria-selected={tab === "configuration"} onClick={() => setTab("configuration")}>配置</button>
          <button type="button" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>审核与发布</button>
        </div>
        <p>当前支持 HTTPS OpenAPI 与服务端 API key 引用。登记和发布后，仍需为员工单独启用。</p>
        {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
        {tab === "configuration" ? <form onSubmit={save} className="tool-asset-form"><fieldset disabled={busy}>
          {[['toolId','稳定 ID'],['displayName','显示名称'],['ownerDepartmentId','责任部门 ID'],['description','用途说明']].map(([key,label]) => <label key={key}>{label}<input required value={draft[key]} disabled={key === "toolId" && Boolean(record)} onChange={event => edit(key,event.target.value)} /></label>)}
          <label>所属系统<select required value={draft.sourceSystemId} onChange={event => { edit("sourceSystemId",event.target.value); edit("credentialRef",""); }}><option value="">请选择</option>{options.systems.map(item => <option key={item.sourceSystemId} value={item.sourceSystemId}>{item.displayName || item.sourceSystemId}</option>)}</select></label>
          <label>API 根地址<input required type="url" value={draft.baseUrl} placeholder="https://…" onChange={event => edit("baseUrl",event.target.value)} /></label>
          <label>凭证引用<select required value={draft.credentialRef} onChange={event => edit("credentialRef",event.target.value)}><option value="">请选择已登记凭证</option>{options.credentials.filter(item => item.sourceSystemId === draft.sourceSystemId).map(item => <option key={item.credentialRef} value={item.credentialRef}>{item.displayName || item.credentialRef}</option>)}</select></label>
          <label>风险<select value={draft.risk} onChange={event => edit("risk",event.target.value)}>{["低","中","高"].map(value => <option key={value}>{value}</option>)}</select></label>
          {[["permissionBoundary","权限边界"],["writebackBoundary","写入边界"]].map(([key,label]) => <label key={key}>{label}<textarea required value={draft[key]} onChange={event => edit(key,event.target.value)} /></label>)}
          <label>上传 OpenAPI JSON<input type="file" accept=".json,application/json" onChange={event => upload(event.target.files?.[0])} /></label>
          <label>OpenAPI 合同（不得包含真实密钥和业务数据）<textarea required rows={12} value={draft.openApiDocument} onChange={event => edit("openApiDocument",event.target.value)} /></label>
          <button type="submit" disabled={!dirty}>校验并提交审核</button>
        </fieldset></form> : <div>
          {!record ? <p>请先保存登记配置。</p> : <>
            <dl className="enterprise-tool-detail-grid">
              {[["状态",stateLabel(record)],["系统",record.asset?.sourceSystemId],["接口地址",record.asset?.baseUrl],["凭证引用",record.asset?.credentialRef],["操作数量",record.asset?.operationCount],["合同摘要",record.asset?.contractDigest],["权限边界",record.asset?.permissionBoundary],["写入边界",record.asset?.writebackBoundary]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            {dirty ? <p>配置有未提交修改。先保存后再审核。</p> : null}
            <div className="tool-asset-actions">
              <button type="button" disabled={busy || dirty || !record.pendingReview} onClick={() => decide("publish")}>审核通过并发布</button>
              <button type="button" disabled={busy || dirty || !record.pendingReview} onClick={() => decide("reject")}>驳回草稿</button>
              <button type="button" disabled={busy || dirty || record.state !== "published"} onClick={() => decide("disable")}>停用 Tool</button>
            </div>
          </>}
        </div>}
      </aside>
    </div>, document.querySelector(".console-shell") || document.body) : null}
  </section>;
}
