import { BadgeCheck, KeyRound, Settings2, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import EmployeeDepartmentChangePanel from "./EmployeeDepartmentChangePanel";
import EmployeeDisplayNameEditor from "./EmployeeDisplayNameEditor";
import EmployeeResponsibilityPanel from "./EmployeeResponsibilityPanel";

function compactList(...values) {
  return values
    .flat()
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function uniqueList(items = []) {
  return items.filter((item, index, source) => source.indexOf(item) === index);
}

function employeeDepartmentProfile(employee = {}) {
  const catalogPrimaryDepartment = String(employee.department || "").trim();
  const departmentNames = uniqueList(compactList(employee.departmentNames, catalogPrimaryDepartment));
  const primaryDepartment = catalogPrimaryDepartment || departmentNames[0] || employee.ownerDepartmentId || employee.departmentId;
  return {
    primaryDepartment,
    authorizedDepartments: uniqueList(compactList(employee.authorizedDepartmentNames)),
  };
}

function channelGroupSummary(employee = {}) {
  if (employee.channelGroups?.length) return employee.channelGroups.join(" / ");
  if (employee.channelGroupScope) return employee.channelGroupScope;
  return "未开放群聊";
}

function memoryPolicyLabel(employee = {}) {
  const policy = employee.memoryPolicy || employee.userMemory || {};
  return policy.mode || policy.summary || policy.policy || "未配置可保存用户偏好";
}

function responsibilityLabel(assignment = null) {
  if (!assignment) return "未登记";
  const owner = assignment.assigneeName || assignment.assigneeId;
  const department = assignment.departmentName || assignment.departmentId || "未登记部门";
  return owner ? `${owner}（${department}）` : `${department}（待登记负责人）`;
}

function ProfileHero({ icon, eyebrow, title, description, meta = [], stats = [] }) {
  return (
    <article className="employee-profile-hero">
      <span className="employee-profile-hero-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="employee-profile-hero-copy">
        <small>{eyebrow}</small>
        <h3>{title}</h3>
        <p>{description}</p>
        {meta.length ? (
          <div className="employee-profile-meta">
            {meta.filter(Boolean).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
      {stats.length ? (
        <div className="employee-profile-stats">
          {stats
            .filter((item) => item.value)
            .map((item) => (
              <span key={item.label}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            ))}
        </div>
      ) : null}
    </article>
  );
}

function ProfileSection({ icon, title, description, children, className = "" }) {
  return (
    <article className={["employee-profile-section", className].filter(Boolean).join(" ")}>
      <div className="employee-config-section-head">
        {icon}
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
      </div>
      {children}
    </article>
  );
}

function ProfileInfoList({ items }) {
  const visibleItems = items.filter(([, value]) => value);

  return (
    <dl className="employee-profile-info-list">
      {visibleItems.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProfileTagGroup({ title, items }) {
  const visibleItems = items.filter(Boolean);
  if (!visibleItems.length) return null;

  return (
    <div className="employee-profile-tag-group">
      <span>{title}</span>
      <div>
        {visibleItems.map((item) => (
          <b key={item}>{item}</b>
        ))}
      </div>
    </div>
  );
}

export function EmployeeIdentityPanel({
  employee,
  modelBindingLabel,
  promptConfig,
  permissionLabel,
  canConfigure = false,
  canRename = false,
  onEmployeeChange = null,
  responsibilityOpenRequest = 0,
}) {
  const capabilityItems = uniqueList(compactList(employee.capabilities, employee.objective));
  const sourceItems = uniqueList(compactList(employee.sourceTargets, employee.apiEndpoints));
  const departmentProfile = employeeDepartmentProfile(employee);
  const responsibilities = employee.responsibilityAssignments || {};

  return (
    <section className="employee-profile-shell">
      <ProfileHero
        icon={<UserRound size={20} />}
        eyebrow="IDENTITY.md / 结构化来源"
        title={employee.name}
        description={employee.objective}
        meta={[employee.title, employee.department, employee.level, employee.status]}
        stats={[
          { label: "员工 ID", value: employee.id },
          { label: "实体版本", value: employee.version },
        ]}
      />

      <div className="employee-profile-layout">
        <ProfileSection
          icon={<KeyRound size={16} />}
          title="归属与权限"
          description="owner、部门和权限范围不能混成文件说明"
        >
          <ProfileInfoList
            items={[
              ["主责部门", departmentProfile.primaryDepartment],
              ["授权使用部门", departmentProfile.authorizedDepartments.join(" / ") || "未配置"],
              ["业务 Owner", employee.owner || "未指定"],
              ["技术 Owner 责任", responsibilityLabel(responsibilities.technicalOwner)],
              ["平台质量审核", responsibilityLabel(responsibilities.qualityReviewer)],
              ["告警接收", responsibilityLabel(responsibilities.alertReceiver)],
              ["权限范围", permissionLabel],
              ["权限说明", employee.permissionSummary],
              ["审核门禁", employee.reviewGate || promptConfig.promptReviewGate],
            ]}
          />
          <EmployeeDepartmentChangePanel
            employee={employee}
            canConfigure={canConfigure}
            onEmployeeChange={onEmployeeChange}
          />
          <EmployeeResponsibilityPanel
            employee={employee}
            canConfigure={canConfigure}
            onEmployeeChange={onEmployeeChange}
            openRequest={responsibilityOpenRequest}
          />
          <details className="employee-ownership-technical-details">
            <summary>技术标识</summary>
            <ProfileInfoList items={[
              ["Owner 主键", employee.ownerUserId],
              ["主责部门主键", employee.ownerDepartmentId || employee.departmentId],
            ]} />
          </details>
        </ProfileSection>

        <ProfileSection
          icon={<Settings2 size={16} />}
          title="运行身份"
          description="模型、Prompt 元数据和输出契约"
        >
          <ProfileInfoList
            items={[
              ["模型", modelBindingLabel],
              ["Prompt Scope", promptConfig.promptScope],
              ["Prompt 版本", promptConfig.promptVersion],
              ["Prompt 指纹", promptConfig.promptHash || "待生成"],
              ["输出契约", employee.outputContract],
              ["Raw Prompt", promptConfig.rawPromptStored ? "不合规：需迁出" : "未保存"],
            ]}
          />
        </ProfileSection>

        <ProfileSection
          icon={<BadgeCheck size={16} />}
          title="能力摘要"
          description="只展示已声明的能力、来源和接口边界"
          className="is-wide"
        >
          <ProfileTagGroup title="能力" items={capabilityItems.length ? capabilityItems : ["待补齐能力声明"]} />
          <ProfileTagGroup title="来源/API" items={sourceItems} />
          <ProfileInfoList
            items={[
              ["技能包", employee.skillPackage],
              ["质量焦点", employee.quality?.rootCauseFocus],
              ["写回边界", employee.writebackBoundary],
            ]}
          />
        </ProfileSection>

        <ProfileSection
          icon={<UserRound size={16} />}
          title="身份字段"
          description="这些字段仍可导出到 IDENTITY.md 审计阅读"
        >
          <EmployeeDisplayNameEditor
            employee={employee}
            canRename={canRename}
            onEmployeeChange={onEmployeeChange}
          />
          <ProfileInfoList
            items={[
              ["岗位/用途", employee.title],
              ["层级", employee.level],
              ["状态", employee.status],
              ["所属部门", employee.department],
            ]}
          />
        </ProfileSection>
      </div>
    </section>
  );
}

export function EmployeeUserProfilePanel({ employee, channels, permissionLabel, isBusinessEmployee }) {
  const serviceEntrances = uniqueList(compactList(channels.length ? channels : ["管理台"]));
  const userPreferenceItems = uniqueList(
    compactList(
      employee.userProfile?.preferences,
      employee.userPreferences,
      employee.memoryPolicy?.safeFacts,
      employee.userMemory?.safeFacts,
    ),
  );
  const privacyItems = uniqueList(
    compactList(
      employee.reviewOutputSpec?.privacyBoundary,
      "不保存 raw prompt",
      "不保存 provider key",
      "不保存模型 trace / 执行 payload",
      "不保存客户数据或员工 PII",
    ),
  );

  return (
    <section className="employee-profile-shell employee-user-profile-shell">
      <ProfileHero
        icon={<UsersRound size={20} />}
        eyebrow="USER.md / 服务对象配置"
        title="用户档案"
        description="用户侧上下文只进入安全摘要和可审计字段，不承载个人隐私原文。"
        meta={[employee.permissionSummary || permissionLabel, employee.department, isBusinessEmployee ? "用户授权模式" : "平台治理身份"]}
        stats={[
          { label: "服务入口", value: serviceEntrances.join(" / ") },
          { label: "记忆策略", value: memoryPolicyLabel(employee) },
        ]}
      />

      <div className="employee-profile-layout">
        <ProfileSection
          icon={<UsersRound size={16} />}
          title="服务对象"
          description="USER.md 的结构化服务对象配置"
        >
          <ProfileInfoList
            items={[
              ["可服务对象", employee.permissionSummary || permissionLabel],
              ["部门范围", employee.department],
              ["身份模式", isBusinessEmployee ? "经 owner/RBAC 授权后沿用用户身份" : "仅平台治理身份"],
              ["单聊范围", employee.channelDirectScope || employee.singleChatScope || permissionLabel],
              ["群聊范围", channelGroupSummary(employee)],
              ["记忆策略", memoryPolicyLabel(employee)],
            ]}
          />
        </ProfileSection>

        <ProfileSection
          icon={<ShieldCheck size={16} />}
          title="隐私与记忆边界"
          description="只展示允许沉淀的安全摘要"
        >
          <ProfileTagGroup title="隐私边界" items={privacyItems} />
          <ProfileTagGroup title="可保存偏好" items={userPreferenceItems.length ? userPreferenceItems : ["未配置可保存用户偏好"]} />
        </ProfileSection>

        <ProfileSection
          icon={<KeyRound size={16} />}
          title="入口与可见性"
          description="和渠道配置共用结构化数据源"
        >
          <ProfileTagGroup title="服务入口" items={serviceEntrances} />
          <ProfileInfoList
            items={[
              ["渠道群组", channelGroupSummary(employee)],
              ["回复策略", employee.channelReplyPolicy || "未配置"],
              ["可调用 API", employee.apiEndpoints?.length ? `${employee.apiEndpoints.length} 个已声明` : "未声明"],
            ]}
          />
        </ProfileSection>

        <ProfileSection
          icon={<Settings2 size={16} />}
          title="USER.md 输出关系"
          description="文件工作台保留审计阅读，配置以本页结构为准"
        >
          <ProfileInfoList
            items={[
              ["文件角色", "可读说明 / 导出 / 审计"],
              ["主配置源", "employee 结构化字段"],
              ["敏感数据", "不进入前端配置文件"],
              ["缺失字段", "显示待配置，不生成样例数据"],
            ]}
          />
        </ProfileSection>
      </div>
    </section>
  );
}
