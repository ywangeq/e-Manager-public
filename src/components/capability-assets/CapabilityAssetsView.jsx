import { Boxes, BriefcaseBusiness, PlugZap, ShieldCheck } from "lucide-react";
import EnterpriseToolsView from "./EnterpriseToolsView";
import ManagedSandboxProfilePanel from "./ManagedSandboxProfilePanel";
import { BasicSkills, BusinessSkills } from "../SkillsViews";

const baseSheets = [
  {
    id: "tools",
    label: "企业工具",
    description: "CLI、连接器、受控 API 和 Tool 开关审核",
    icon: PlugZap,
  },
  {
    id: "sandbox",
    label: "Sandbox",
    description: "受管运行环境、工具链与隔离边界",
    icon: ShieldCheck,
  },
  {
    id: "enterpriseSkills",
    label: "企业技能",
    description: "平台基础 Skill、Prompt 元数据和挂载关系",
    icon: Boxes,
  },
  {
    id: "businessSkills",
    label: "业务专项技能",
    description: "部门业务 Skill、技能簇和专项治理",
    icon: BriefcaseBusiness,
  },
];

export default function CapabilityAssetsView({
  activeSheet = "tools",
  basicSkills = [],
  businessSkills = [],
  employees = [],
  isSystemAdmin = false,
  onSheetChange,
  onToolBindingChange = null,
  query = "",
  session = null,
  tools = [],
  toolCatalogStatus = "ready",
  onReloadTools,
}) {
  const sheets = isSystemAdmin ? baseSheets : baseSheets.filter((sheet) => sheet.id !== "tools" && sheet.id !== "sandbox");
  const selectedSheet = sheets.some((sheet) => sheet.id === activeSheet) ? activeSheet : sheets[0]?.id || "enterpriseSkills";

  return (
    <section className="view-stack capability-assets-view">
      {selectedSheet === "tools" && toolCatalogStatus !== "ready" ? <p role="status">
        {toolCatalogStatus === "loading" ? "正在读取受管 Tool 目录…" : "Tool 目录暂不可用。"}
        {toolCatalogStatus === "unavailable" ? <button type="button" onClick={onReloadTools}>重试</button> : null}
      </p> : null}
      <section className="panel capability-assets-sheet-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Capability Assets</p>
            <h2>能力资产</h2>
          </div>
          <span className="status-pill muted">Tool / Skill</span>
        </div>
        <div className="capability-assets-sheet-options" role="tablist" aria-label="能力资产分类">
          {sheets.map((sheet) => {
            const SheetIcon = sheet.icon;
            const isActive = selectedSheet === sheet.id;
            return (
              <button
                className={isActive ? "capability-assets-sheet-option is-active" : "capability-assets-sheet-option"}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`capability-assets-sheet-${sheet.id}`}
                id={`capability-assets-tab-${sheet.id}`}
                key={sheet.id}
                onClick={() => onSheetChange?.(sheet.id)}
              >
                <SheetIcon size={18} aria-hidden="true" />
                <span>
                  <strong>{sheet.label}</strong>
                  <small>{sheet.description}</small>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="capability-assets-sheet-content"
        id={`capability-assets-sheet-${selectedSheet}`}
        role="tabpanel"
        aria-labelledby={`capability-assets-tab-${selectedSheet}`}
      >
        {selectedSheet === "tools" ? (
          <EnterpriseToolsView onToolCatalogChange={onReloadTools} tools={tools} employees={employees} query={query} onToolBindingChange={onToolBindingChange} />
        ) : null}
        {selectedSheet === "sandbox" ? <ManagedSandboxProfilePanel /> : null}
        {selectedSheet === "enterpriseSkills" ? (
          <BasicSkills skills={basicSkills} isSystemAdmin={isSystemAdmin} />
        ) : null}
        {selectedSheet === "businessSkills" ? (
          <BusinessSkills skills={businessSkills} isSystemAdmin={isSystemAdmin} session={session} />
        ) : null}
      </section>
    </section>
  );
}
