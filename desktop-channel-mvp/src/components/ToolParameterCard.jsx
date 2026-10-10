import { useEffect, useMemo, useState } from "react";
import { CaretDown, Check, Minus, Plus, SlidersHorizontal, Wrench } from "@phosphor-icons/react";
import {
  buildToolParameterCardSubmission,
  enumOptionLabel,
  fieldLabel,
  parameterCardFields,
  parameterGroup,
  setParameterValue,
  validateParameterCard,
} from "../lib/toolParameterCard.js";

const GROUP_LABELS = { path: "目标", query: "查询条件", headers: "请求选项", body: "任务参数", parameters: "参数" };

export function ToolParameterCard({ card, onSubmit, onDraftChange, compact = false, busy = false, onDefer, footer }) {
  const [expired, setExpired] = useState(() => cardExpired(card));
  const [expanded, setExpanded] = useState(() => !["submitted", "superseded"].includes(card.status) && !cardExpired(card));
  const [showOptional, setShowOptional] = useState(false);
  const [localValues, setValues] = useState(() => structuredClone(card.initialArguments || {}));
  const values = onDraftChange ? card.draftArguments || card.initialArguments || {} : localValues;
  const [errors, setErrors] = useState({});
  const clarification = card.requestKind === "clarification";
  const submitted = card.status === "submitted";
  const superseded = card.status === "superseded";
  const submitting = card.status === "submitting";
  const uncertain = card.status === "submission_unknown";
  const inactive = submitted || superseded || expired || submitting || uncertain || busy;
  const managedReferences = Array.isArray(card.managedReferences) ? card.managedReferences : [];
  const fields = useMemo(() => parameterCardFields(card.argumentSchema, values), [card.argumentSchema, values]);
  const requiredFields = fields.filter((field) => field.required || field.value !== undefined);
  const optionalFields = fields.filter((field) => !field.required && field.value === undefined);
  const visibleFields = showOptional ? fields : requiredFields;
  const groups = groupParameterFields(visibleFields);

  useEffect(() => {
    const expiresAt = Date.parse(String(card.expiresAt || ""));
    if (!Number.isFinite(expiresAt)) {
      setExpired(false);
      return undefined;
    }
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      setExpired(true);
      return undefined;
    }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), remainingMs + 20);
    return () => window.clearTimeout(timer);
  }, [card.expiresAt]);

  function update(field, nextValue) {
    const next = setParameterValue(values, field.path, nextValue);
    if (onDraftChange) onDraftChange(card, next);
    else setValues(next);
    setErrors((current) => {
      const next = { ...current };
      delete next[field.path.join(".")];
      return next;
    });
  }

  function submit() {
    if (inactive) return;
    const nextErrors = validateParameterCard(card.argumentSchema, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    onSubmit?.({ card, submission: buildToolParameterCardSubmission(card, values) });
  }

  return (
    <section data-pending-interaction-id={card.id} tabIndex={-1} className={`tool-parameter-card ${compact ? "is-compact" : ""} ${expanded ? "is-expanded" : ""}`} aria-label={`${clarification ? "回答" : "配置"} ${card.title}`}>
      <button type="button" className="tool-parameter-summary" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span className="tool-parameter-icon"><Wrench size={15} weight="fill" /></span>
        <span className="tool-parameter-title">
          <small>{clarification ? "需要你补充信息" : compact ? "需要你确认" : "Agent 已选择操作"}</small>
          <strong>{card.title || card.operationId}</strong>
          <span>{clarification ? `${card.fieldCount} 个问题` : <>{card.method ? `${card.method} · ` : ""}{managedReferences.length ? `${managedReferences.length} 个已选对象 · ` : ""}{card.fieldCount} 个可调参数</>}</span>
        </span>
        <span className={`tool-parameter-status is-${submitted ? "submitted" : superseded ? "superseded" : expired ? "expired" : "draft"}`}>
          {submitted ? <><Check size={12} />已提交</> : superseded ? "已更新" : expired ? "已过期" : submitting ? "正在提交" : uncertain ? "待同步" : clarification ? "等待你回答" : compact ? "等待你确认" : fields.length ? "待填写" : "待确认"}
        </span>
        <CaretDown className="tool-parameter-caret" size={14} />
      </button>
      {expanded ? (
        <div className="tool-parameter-body">
          {!compact && card.description ? <p className="tool-parameter-description">{card.description}</p> : null}
          {compact ? <details className="tool-parameter-explanation"><summary>说明与影响范围</summary><p>{card.writebackBoundary}</p><p>{clarification ? "回答用于补充当前任务信息；需要确认的操作会另行询问。" : "提交参数后仍按当前用户权限执行；高影响操作另行确认。"}</p></details> : null}
          {managedReferences.length ? (
            <section className="tool-parameter-references" aria-label="Agent 已选对象">
              <span className="tool-parameter-reference-heading">Agent 已从业务系统选定</span>
              {managedReferences.map((reference) => (
                <div className="tool-parameter-reference" key={reference.path.join(".")}>
                  <small>{reference.label}</small>
                  <strong>{reference.displayValue}</strong>
                  <span>已锁定</span>
                </div>
              ))}
            </section>
          ) : null}
          {groups.map(([group, groupFields]) => (
            <fieldset className="tool-parameter-group" key={group} disabled={inactive}>
              <legend>{clarification ? "问题" : GROUP_LABELS[group] || group}</legend>
              {groupFields.map((field) => (
                <ParameterField
                  error={errors[field.path.join(".")]}
                  field={field}
                  key={field.path.join(".")}
                  onChange={(nextValue) => update(field, nextValue)}
                  compact={compact}
                />
              ))}
            </fieldset>
          ))}
          {optionalFields.length ? (
            <button type="button" className="tool-parameter-optional" onClick={() => setShowOptional((current) => !current)}>
              <SlidersHorizontal size={14} />{showOptional ? (clarification ? "收起可选问题" : "收起可选参数") : `${clarification ? "更多问题" : "更多参数"} · ${optionalFields.length}`}
            </button>
          ) : null}
          {Object.keys(errors).length ? <p className="tool-parameter-form-error">还有 {Object.keys(errors).length} 项需要检查</p> : null}
          {compact ? <div className="tool-parameter-footnote">{footer}<span>{expired ? (clarification ? "问题已过期，请让员工更新后再回答。" : "参数卡已过期，请让员工更新后再确认。") : `有效至 ${new Date(card.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`}</span></div> : null}
          <div className="tool-parameter-actions">
            {compact && onDefer ? <button type="button" className="tool-parameter-reset" disabled={submitting || busy} onClick={onDefer}>稍后处理</button> : <button type="button" className="tool-parameter-reset" disabled={inactive} onClick={() => { const next = structuredClone(card.initialArguments || {}); if (onDraftChange) onDraftChange(card, next); else setValues(next); setErrors({}); }}>重置</button>}
            <button type="button" className="tool-parameter-submit" disabled={inactive} onClick={submit}>
              {submitted ? (clarification ? "回答已提交" : "参数已提交") : superseded ? (clarification ? "请回答新问题" : "请使用新参数卡") : expired ? (clarification ? "问题已过期" : "参数卡已过期") : submitting ? "正在提交" : uncertain ? "提交状态待同步" : clarification ? "提交回答" : compact ? "确认参数" : "使用这些参数"}
            </button>
          </div>
          {!compact ? <small className="tool-parameter-boundary">
            {card.writebackBoundary ? `本次影响范围：${card.writebackBoundary}。` : ""}
            {clarification ? "回答用于补充当前任务信息；需要确认的操作会另行询问。" : "提交后仍按当前用户权限与 Tool 门禁执行；高影响写操作会再次确认。"}
          </small> : null}
        </div>
      ) : null}
    </section>
  );
}

function cardExpired(card = {}) {
  const expiresAt = Date.parse(String(card.expiresAt || ""));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function ParameterField({ error, field, onChange, compact }) {
  const schema = field.schema || {};
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  const label = fieldLabel(field);
  const description = String(schema.description || "").trim();
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  const accessibleLabel = `${label}${field.required ? " 必填" : " 可选"}`;
  return (
    <div className={`tool-parameter-field ${error ? "has-error" : ""}`} role="group" aria-label={accessibleLabel}>
      <span className="tool-parameter-field-label"><strong>{label}</strong>{field.required ? <em>必填</em> : <small>可选</small>}</span>
      {description ? compact ? <details className="tool-parameter-field-details"><summary>说明</summary><span>{description}</span></details> : <span className="tool-parameter-field-help">{description}</span> : null}
      {enumValues.length === 1 && field.value === enumValues[0] ? (
        <input aria-label={accessibleLabel} type="text" readOnly value={enumOptionLabel(schema, enumValues[0], 0)} title="仅一个可用选项，已默认选中" />
      ) : !compact && enumValues.length && enumValues.length <= 4 ? (
        <span className="tool-parameter-segments" aria-label={accessibleLabel}>
          {enumValues.map((option, index) => <button type="button" aria-pressed={field.value === option} className={field.value === option ? "is-selected" : ""} key={String(option)} onClick={() => onChange(option)}>{enumOptionLabel(schema, option, index)}</button>)}
        </span>
      ) : enumValues.length ? (
        <select aria-label={accessibleLabel} value={enumValues.includes(field.value) ? enumValues.indexOf(field.value) : ""} onChange={(event) => onChange(event.target.value === "" ? "" : enumValues[Number(event.target.value)])}>
          <option value="">请选择</option>
          {enumValues.map((option, index) => <option key={String(option)} value={index}>{enumOptionLabel(schema, option, index)}</option>)}
        </select>
      ) : type === "boolean" ? (
        <button type="button" role="switch" aria-checked={field.value === true} className={`tool-parameter-switch ${field.value === true ? "is-on" : ""}`} onClick={() => onChange(field.value !== true)}>
          <span />{field.value === true ? "开启" : "关闭"}
        </button>
      ) : ["integer", "number"].includes(type) ? (
        <span className="tool-parameter-number">
          <button type="button" aria-label={`减少 ${label}`} onClick={() => onChange(stepNumber(field.value, schema, -1))}><Minus size={13} /></button>
          <input aria-label={accessibleLabel} type="number" value={field.value ?? ""} min={schema.minimum} max={schema.maximum} step={schema.multipleOf || (type === "integer" ? 1 : "any")} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
          <button type="button" aria-label={`增加 ${label}`} onClick={() => onChange(stepNumber(field.value, schema, 1))}><Plus size={13} /></button>
        </span>
      ) : (
        <input aria-label={accessibleLabel} type="text" value={field.value ?? ""} placeholder={schema.example !== undefined ? String(schema.example) : "请输入"} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <span className="tool-parameter-error">{error}</span> : null}
    </div>
  );
}

function stepNumber(value, schema, direction) {
  const step = Number(schema.multipleOf || (schema.type === "integer" ? 1 : 0.1));
  const base = Number.isFinite(value) ? value : Number(schema.default || schema.minimum || 0);
  const next = base + direction * step;
  return Math.min(Number.isFinite(schema.maximum) ? schema.maximum : next, Math.max(Number.isFinite(schema.minimum) ? schema.minimum : next, next));
}

function groupParameterFields(fields) {
  const grouped = new Map();
  for (const field of fields) {
    const group = parameterGroup(field);
    grouped.set(group, [...(grouped.get(group) || []), field]);
  }
  return [...grouped.entries()];
}
