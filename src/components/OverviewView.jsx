import { Building2, ChevronDown, RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  badcaseRecords,
  basicSkills as catalogBasicSkills,
  businessSkills as catalogBusinessSkills,
  digitalEmployees as catalogDigitalEmployees,
  identityIntegration,
  permissionScopeLabels,
} from "../data/catalog";
import MetricCard from "./MetricCard";

const demoCapabilities = [
  {
    title: "资产可管",
    detail: "数字员工、Skill、Tool、Prompt 元数据、Owner、权限和版本统一建档。",
  },
  {
    title: "接入可审",
    detail: "外部包先解析安全摘要，再经 Agent 预审和人员/Skill 人审，不因上传自动上线。",
  },
  {
    title: "调用可控",
    detail: "管理台与飞书入口先经过 L2 门禁，再注入已批准的员工、Skill 与 Tool 契约。",
  },
  {
    title: "过程可追溯",
    detail: "质量事件、运行用量和成功下载资产包均保留安全摘要，原始业务数据不进入管理台。",
  },
];

const architectureLayers = [
  {
    id: "L1",
    name: "入口与触达",
    status: "已可演示",
    tone: "good",
    capability: "管理台登录、企业协同 AI 助理、飞书受控消息入口。",
    boundary: "入口只负责身份与渠道接入，不能绕过治理门禁。",
  },
  {
    id: "L2",
    name: "治理与调用门禁",
    status: "已可演示",
    tone: "good",
    capability: "能力申请、人员审核、调用策略、Skill 挂载和 Tool 绑定审批。",
    boundary: "每次 Tool 调用仍按动作、风险、范围和写回边界再次校验。",
  },
  {
    id: "L3",
    name: "资产与契约目录",
    status: "已可演示",
    tone: "good",
    capability: "员工、Skill、Tool、Prompt、输入输出、权限、版本和质量门禁。",
    boundary: "目录只描述受管资产，不保存密钥、原始 Prompt 或业务执行内容。",
  },
  {
    id: "L4",
    name: "Agent / Worker 运行适配",
    status: "MVP 已接通",
    tone: "good",
    capability: "受控 Agent 会话、Provider 适配、声明式 Tool、运行资源与安全任务队列。",
    boundary: "只执行已声明且通过 L2 的能力，缺少依赖或适配器时默认阻断。",
  },
  {
    id: "L5",
    name: "业务执行平面",
    status: "受控联调",
    tone: "warn",
    capability: "子系统登记、握手、能力映射和质量安全摘要已具备 MVP 联调路径。",
    boundary: "真实业务数据、局部 RBAC、生产写入和执行证据仍留在业务系统，生产接入待完成。",
  },
];

export default function Overview({
  session,
  onNavigate,
  digitalEmployees = catalogDigitalEmployees,
  basicSkills = catalogBasicSkills,
  businessSkills = catalogBusinessSkills,
}) {
  const resolvedDigitalEmployees = Array.isArray(digitalEmployees) ? digitalEmployees : catalogDigitalEmployees;
  const resolvedBasicSkills = Array.isArray(basicSkills) ? basicSkills : catalogBasicSkills;
  const resolvedBusinessSkills = Array.isArray(businessSkills) ? businessSkills : catalogBusinessSkills;
  const [fortressOrg, setFortressOrg] = useState({
    root: null,
    departments: [],
    summary: null,
    status: "idle",
    error: "",
  });
  const onlineEmployees = resolvedDigitalEmployees.filter((employee) => employee.status === "在线").length;
  const activeBasicSkills = resolvedBasicSkills.filter((skill) => ["已上线", "试运行"].includes(skill.status)).length;
  const activeBusinessSkills = resolvedBusinessSkills.filter((skill) => ["可复用", "试运行"].includes(skill.status)).length;
  const reviewGates = resolvedBusinessSkills.filter((skill) => skill.reviewGate).length;
  const openBadcases = badcaseRecords.filter((item) => !["已关闭", "closed"].includes(item.status)).length;
  const systemEmployees = resolvedDigitalEmployees.filter((employee) => employee.level === "系统级").length;
  const hasFortressSession = session?.identitySource === "fortress-sso-v3";
  const [orgRefreshToken, setOrgRefreshToken] = useState(0);
  const [runtimeInfrastructure, setRuntimeInfrastructure] = useState({ status: "idle", data: null });
  const orgSummary = fortressOrg.summary;
  const topLevelDepartmentCount = fortressOrg.root?.children?.length;
  const orgSourceLabel = fortressOrg.root ? "Fortress 实时部门树" : "等待企业 SSO 同步";
  const canManageRuntimeInfrastructure = session?.role === "admin" || (session?.permissions || []).includes("runtime-infrastructure:*");
  const runtimeResources = Array.isArray(runtimeInfrastructure.data?.infrastructure) ? runtimeInfrastructure.data.infrastructure : [];
  const availableRuntimeResources = runtimeResources.filter((item) => item.status === "available").length;
  const runtimeDetail = runtimeInfrastructure.status === "ready"
    ? availableRuntimeResources === runtimeResources.length && runtimeResources.length
      ? "Remote、集群均可用"
      : `${availableRuntimeResources}/${runtimeResources.length} 个可用`
    : runtimeInfrastructure.status === "error" ? "暂时无法读取" : "读取中";

  useEffect(() => {
    let isMounted = true;

    if (!hasFortressSession) {
      setFortressOrg({
        root: null,
        departments: [],
        summary: null,
        status: "requires-auth",
        error: "",
      });
      return undefined;
    }

    setFortressOrg((current) => ({ ...current, status: "loading", error: "" }));
    const refreshQuery = orgRefreshToken ? "&refresh=1" : "";
    fetch(`/api/org/departments?source=fortress${refreshQuery}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Fortress 部门树读取失败");
        return data;
      })
      .then((data) => {
        if (!isMounted) return;
        setFortressOrg({
          root: data.root || null,
          departments: data.departments || [],
          summary: data.summary || null,
          status: "ready",
          error: "",
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setFortressOrg({
          root: null,
          departments: [],
          summary: null,
          status: "error",
          error: error?.message || "Fortress 部门树读取失败",
        });
      });

    return () => {
      isMounted = false;
    };
  }, [hasFortressSession, orgRefreshToken]);

  useEffect(() => {
    if (!canManageRuntimeInfrastructure) return undefined;
    let cancelled = false;
    const loadRuntimeInfrastructure = () => {
      fetch("/api/runtime-infrastructure", { credentials: "include" })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error();
          if (!cancelled) setRuntimeInfrastructure({ status: "ready", data });
        })
        .catch(() => {
          if (!cancelled) setRuntimeInfrastructure({ status: "error", data: null });
        });
    };
    loadRuntimeInfrastructure();
    const refreshTimer = window.setInterval(loadRuntimeInfrastructure, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [canManageRuntimeInfrastructure]);

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="一级部门" value={topLevelDepartmentCount ?? "待同步"} detail={orgSourceLabel} onClick={() => onNavigate("people")} />
        <MetricCard label="数字员工" value={resolvedDigitalEmployees.length} detail={`${onlineEmployees} 个在线`} onClick={() => onNavigate("employees")} />
        <MetricCard label="系统级员工" value={systemEmployees} detail="导入、登记、契约对齐" onClick={() => onNavigate("employees")} />
        <MetricCard label="企业技能" value={resolvedBasicSkills.length} detail={`${activeBasicSkills} 个可用或试运行`} onClick={() => onNavigate("basicSkills")} />
        <MetricCard label="业务专项技能" value={resolvedBusinessSkills.length} detail={`${activeBusinessSkills} 个进入业务流程`} onClick={() => onNavigate("businessSkills")} />
        <MetricCard label="质量审核" value={openBadcases} detail="badcase 与技能评审" onClick={() => onNavigate("qualityManagement")} />
        {canManageRuntimeInfrastructure ? <MetricCard label="运行设备" value={runtimeInfrastructure.status === "ready" ? runtimeResources.length : "—"} detail={runtimeDetail} onClick={() => onNavigate("runtimeInfrastructure")} /> : null}
      </div>

      <section className="panel demo-snapshot-panel" aria-label="老板演示能力摘要">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Demo Snapshot</p>
            <h2>当前已完成的治理能力</h2>
          </div>
          <span className="status-pill good">LAN MVP 可演示</span>
        </div>
        <p className="demo-snapshot-lead">把 AI 能力从“能用”变成“知道谁在用、按什么规则用、出了问题怎么回看”。</p>
        <div className="demo-capability-grid">
          {demoCapabilities.map((item, index) => (
            <article className="demo-capability" key={item.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel architecture-demo-panel" aria-label="L1 到 L5 分层说明">
        <div className="panel-head">
          <div>
            <p className="eyebrow">L1 - L5</p>
            <h2>从入口到执行的分层治理</h2>
          </div>
          <span className="status-pill muted">AI 不能绕过 L2</span>
        </div>
        <p className="architecture-demo-lead">L1 接入请求，L2 判断是否允许，L3 提供已批准资产契约，L4 受控运行，L5 执行业务动作，并只回传安全摘要。</p>
        <div className="architecture-layer-grid">
          {architectureLayers.map((layer) => (
            <article className="architecture-layer" key={layer.id}>
              <div className="architecture-layer-head">
                <span>{layer.id}</span>
                <b>{layer.name}</b>
                <i className={`status-pill ${layer.tone}`}>{layer.status}</i>
              </div>
              <p>{layer.capability}</p>
              <small>{layer.boundary}</small>
            </article>
          ))}
        </div>
        <div className="architecture-demo-boundary">
          <strong>演示边界</strong>
          <span>当前是 LAN MVP：生产仍需集中审计、正式 SSO/RBAC、隔离执行环境和 L5 真实写入审批。</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Operating Model</p>
            <h2>公司层级治理结构</h2>
          </div>
          <span className="status-pill good">主键：{identityIntegration.recommendedUserKey}</span>
        </div>

        <div className="identity-banner identity-banner-strong">
          <strong>身份目录驱动部门映射</strong>
          <span>{identityIntegration.departmentMapping}</span>
          <b>{reviewGates} 个业务技能设置人审门禁</b>
        </div>

        <div className="governance-structure">
          <article className="governance-root">
            <span className="eyebrow">Company Root</span>
            <strong>{fortressOrg.root?.name || "公司级治理"}</strong>
            <p>
              {hasFortressSession
                ? "Fortress 部门树是组织结构事实源；本系统只保存治理资产引用和安全摘要。"
                : "使用企业登录后，这里会切换为 Fortress 返回的真实公司部门树。"}
            </p>
          </article>
          <div className="governance-layers">
            {[
              ["部门树", orgSummary ? `${orgSummary.departmentCount} 个节点` : "待同步", identityIntegration.departmentKey],
              ["员工身份", orgSummary ? `${orgSummary.memberCount} 个目录成员` : "待同步", identityIntegration.recommendedUserKey],
              ["一级部门", topLevelDepartmentCount ? `${topLevelDepartmentCount} 个` : "待同步", "可逐级展开 Children"],
              ["数字员工", `${resolvedDigitalEmployees.length} 个治理资产`, `${identityIntegration.departmentKey} + ownerUserId`],
            ].map(([title, value, detail]) => (
              <article className="governance-layer" key={title}>
                <span>{title}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </article>
            ))}
          </div>
        </div>

        <FortressOrgTree
          root={fortressOrg.root}
          status={fortressOrg.status}
          error={fortressOrg.error}
          onRefresh={() => setOrgRefreshToken((current) => current + 1)}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Governance Loop</p>
            <h2>数字员工到 Skill 的管理闭环</h2>
          </div>
        </div>
        <div className="loop-flow" aria-label="数字员工到 Skill 的治理闭环流程">
          {[
            ["资产建档", "登记", "建立数字员工、基础 Skill、专项业务 Skill 目录，记录 owner 和实体版本。"],
            ["版本治理", "Prompt", "Prompt 独立版本管理，只固化 key、版本、hash 和作用域。"],
            ["接入预审", "接入", "系统级员工解析 Skill、外部员工、技能更新和需求，先形成待审核草案。"],
            ["契约同步", "API", "目录、导入、badcase 都同步 API 契约、ID 和版本边界。"],
            ["受控运行", "执行", "明确工具、输入、输出、约束和人审门禁后，才进入业务流程。"],
            ["质量回流", "审核", "质量审核承载 request 评审、Skill ID 升级校验和 badcase 复盘。"],
          ].map(([phase, title, body], index) => (
            <article key={title} className="loop-step">
              <div className="loop-step-head">
                <span className="loop-step-index">{index + 1}</span>
                <small>{phase}</small>
              </div>
              <strong>{title}</strong>
              <p>{body}</p>
            </article>
          ))}
        </div>
        <div className="loop-return">
          <span>审核结果回写目录、Prompt、API 契约和版本边界</span>
          <b>形成下一轮可追溯发布</b>
        </div>
      </section>
    </section>
  );
}

function FortressOrgTree({ root, status, error, onRefresh }) {
  const isReady = status === "ready" && root;
  const topDepartments = isReady ? root.children || [] : [];
  const defaultOpenIds = new Set(topDepartments.slice(0, 1).map((department) => department.id));

  return (
    <section className="org-tree-panel" aria-label="公司真实部门结构">
      <div className="org-tree-head">
        <div>
          <p className="eyebrow">Department Tree View</p>
          <h3>真实部门树与数字员工</h3>
        </div>
        <div className="org-tree-actions">
          <button className="ghost-action" type="button" onClick={onRefresh} disabled={status === "loading"}>
            <RefreshCcw size={15} />
            刷新
          </button>
          <span className={`status-pill ${isReady ? "good" : status === "error" ? "warn" : "muted"}`}>
            {isReady ? "Fortress 已同步" : status === "loading" ? "读取中" : "需要企业登录"}
          </span>
        </div>
      </div>

      {isReady ? (
        <DepartmentTree rootDepartments={topDepartments} defaultOpenIds={defaultOpenIds} />
      ) : (
        <div className="org-tree-empty">
          <strong>{status === "error" ? "部门树读取失败" : "企业登录后显示一级部门"}</strong>
          <p>
            {status === "error"
              ? error
              : "当前 Demo 登录没有 Fortress 会话；公司真实部门树会从后端运行时接口读取，不会写入前端代码或 Git。"}
          </p>
        </div>
      )}

      {isReady && topDepartments.length ? (
        <div className="org-tree-note">
          <span>{topDepartments.length} 个一级部门</span>
          <span>直属下级=当前节点 Children，部门节点=当前节点整棵子树</span>
        </div>
      ) : null}
    </section>
  );
}

function DepartmentTree({ rootDepartments, defaultOpenIds }) {
  const [openIds, setOpenIds] = useState(defaultOpenIds);

  function toggleDepartment(departmentId) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  }

  return (
    <div className="org-tree-list">
      {rootDepartments.map((department) => (
        <DepartmentTreeNode
          key={department.id}
          department={department}
          depth={0}
          isOpen={openIds.has(department.id)}
          openIds={openIds}
          onToggle={toggleDepartment}
        />
      ))}
    </div>
  );
}

function DepartmentTreeNode({ department, depth, isOpen, openIds, onToggle }) {
  const employees = department.governanceAssets?.digitalEmployees || [];
  const secondaryDepartments = department.governanceAssets?.secondaryDepartments || [];
  const businessSkillCount = department.governanceAssets?.businessSkillCount || 0;
  const children = department.children || [];
  const actualChildCount = children.length;
  const visibleSecondaryDepartments = secondaryDepartments.slice(0, 4);
  const employeesByDepartment = new Map();

  employees.forEach((employee) => {
    const label = employee.departmentLabel || "未标注二级";
    const current = employeesByDepartment.get(label) || [];
    current.push(employee);
    employeesByDepartment.set(label, current);
  });

  const ownershipGroups = visibleSecondaryDepartments.map((item) => ({
    ...item,
    employees: employeesByDepartment.get(item.name) || [],
  }));

  return (
    <div className="org-tree-node" style={{ "--tree-depth": depth }}>
      <button className="org-tree-node-main" type="button" onClick={() => onToggle(department.id)}>
        <span className="org-tree-node-icon">
          {children.length ? <ChevronDown className={isOpen ? "is-open" : ""} size={16} /> : <Building2 size={16} />}
        </span>
        <span className="org-tree-node-title">
          <strong>{department.name}</strong>
          <small>{depth === 0 ? "一级部门" : `第 ${depth + 1} 级部门`}</small>
        </span>
        <span className="org-tree-node-metrics">
          <b>{actualChildCount} 直属下级</b>
          <b>{department.departmentCount || 1} 部门节点</b>
          <b>{department.subtreeMemberCount ?? department.memberCount ?? 0} 目录成员</b>
          <b>{employees.length} 数字员工</b>
          <b>{businessSkillCount} 业务 Skill</b>
        </span>
      </button>

      {isOpen ? (
        <div className="org-tree-node-detail">
          <div className="org-node-summary-grid">
            <span>直属下级：{actualChildCount ? children.map((child) => child.name).slice(0, 8).join(" / ") : "无"}</span>
            <span>当前节点成员：{department.memberCount || 0}</span>
            <span>映射主键：{identityIntegration.departmentKey}</span>
          </div>
          {ownershipGroups.length ? (
            <div className="org-asset-line">
              <span>数字员工绑定</span>
              <div className="org-asset-groups">
                {ownershipGroups.map((group) => (
                  <div className="org-asset-group" key={group.name}>
                    <div className="org-asset-department">
                      <b>{group.name}</b>
                      <small>{group.digitalEmployeeCount}</small>
                    </div>
                    {group.employees.length ? (
                      <div className="org-asset-employees">
                        {group.employees.slice(0, 3).map((employee) => (
                          <b key={employee.id} className="org-employee-chip">
                            <span>{employee.name}</span>
                            <small>{permissionScopeLabels[employee.permissionScope] || employee.permissionScope}</small>
                          </b>
                        ))}
                        {group.employees.length > 3 ? <b className="org-employee-more">+{group.employees.length - 3}</b> : null}
                      </div>
                    ) : null}
                  </div>
                ))}
                {secondaryDepartments.length > visibleSecondaryDepartments.length ? (
                  <small className="org-asset-more">其他 {secondaryDepartments.length - visibleSecondaryDepartments.length} 个归属节点</small>
                ) : null}
              </div>
            </div>
          ) : null}
          {children.length ? (
            <div className="org-tree-children">
              {children.map((child) => (
                <DepartmentTreeNode
                  key={child.id}
                  department={child}
                  depth={depth + 1}
                  isOpen={openIds.has(child.id)}
                  openIds={openIds}
                  onToggle={onToggle}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
