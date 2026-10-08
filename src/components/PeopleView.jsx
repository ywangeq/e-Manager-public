import { Settings2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import {
  businessSkills,
  departmentGovernance,
  departments,
  digitalEmployees,
  externalAuditRequests,
  identityIntegration,
  permissionScopeLabels,
  personnel,
} from "../data/catalog";
import {
  departmentPath,
  flattenOrgDepartments,
  governanceAssetsForRule,
  governanceForUser,
  mountedSubsystemsByDepartmentId,
} from "../lib/consoleCatalog";
import {
  createPersonnelAccessRequest,
  createPersonnelDraftPerson,
  decidePersonnelAccessRequest,
  deletePersonnelDraftPerson,
  fetchPersonnelAccessRequests,
  fetchPersonnelDrafts,
  updateDepartmentOwnerDraft,
  updatePersonnelDraft,
} from "../lib/personnel/drafts";
import MetricCard from "./MetricCard";
import {
  PeopleAccessRequestPanel,
  PeopleAccessRequestReview,
  PeopleAddPanel,
  PeopleConfirmationFlow,
  PeopleEditDraftPanel,
} from "./people/PeoplePanels";
import { PeopleTable } from "./people/PeopleTable";
import { hydrateAddedPerson, pendingPersonnelStatuses, personDraftGovernance } from "./people/peopleDraftModel";

export default function People({
  session,
  onNavigate,
  isSystemAdmin,
  controlPlaneSubsystems = [],
  digitalEmployees: digitalEmployeeCatalog = digitalEmployees,
  businessSkills: businessSkillCatalog = businessSkills,
}) {
  const hasFortressSession = session?.identitySource === "fortress-sso-v3";
  const [enterpriseGovernance, setEnterpriseGovernance] = useState({
    rows: [],
    sync: null,
    status: "idle",
    error: "",
  });
  const [enterpriseOrg, setEnterpriseOrg] = useState({
    root: null,
    departments: [],
    status: "idle",
    error: "",
  });
  const [editingUserId, setEditingUserId] = useState("");
  const [userDrafts, setUserDrafts] = useState({});
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [addedPeople, setAddedPeople] = useState([]);
  const [accessRequests, setAccessRequests] = useState([]);
  const [departmentOwnerDrafts, setDepartmentOwnerDrafts] = useState({});
  const [draftStore, setDraftStore] = useState({
    status: "loading",
    error: "",
    persistence: null,
  });
  const mappedDepartment = departments.find((department) => department.id === session.departmentId);
  const enterpriseReady = hasFortressSession && enterpriseGovernance.status === "ready" && enterpriseGovernance.rows.length > 0;
  const orgDepartments = enterpriseOrg.root
    ? flattenOrgDepartments(enterpriseOrg.root).filter((department) => department.depth > 0)
    : departments.filter((department) => department.id !== "company").map((department) => ({
        id: department.id,
        name: department.name,
        path: departmentPath(department.id),
        depth: 1,
      }));
  const mountedSubsystemsByDepartment = mountedSubsystemsByDepartmentId(controlPlaneSubsystems, orgDepartments);
  const departmentOwnerRows = enterpriseReady
    ? enterpriseGovernance.rows.map((row) => ({
        rule: {
          departmentId: row.departmentId,
          ownerUserId: row.ownerUserId,
          scope: row.scope,
          policy: row.policy,
          source: "fortress",
          ownerConfidence: row.ownerConfidence,
          ownerEvidence: row.ownerEvidence,
        },
        department: { id: row.departmentId, name: row.departmentName },
        owner: row.ownerUserId
          ? {
              id: row.ownerUserId,
              name: row.ownerName || row.ownerUserId,
              email: "",
              role: row.ownerPosition || "部门负责人",
              departmentId: row.departmentId,
              department: row.departmentName,
              governanceRole: "部门负责人",
              status: "启用",
            }
          : null,
        assets: {
          editableEmployees: row.editableDigitalEmployees || [],
          editableBusinessSkills: row.editableBusinessSkills || [],
          reviewRequests: [],
          blockedDepartments: row.blockedDepartmentNames || [],
          memberCount: row.memberCount || 0,
          departmentCount: row.departmentCount || 0,
          mountedSubsystems: mountedSubsystemsByDepartment.get(row.departmentId) || [],
        },
      }))
    : departmentGovernance.map((rule) => ({
        rule,
        department: departments.find((department) => department.id === rule.departmentId),
        owner: personnel.find((user) => user.id === rule.ownerUserId),
        assets: {
          ...governanceAssetsForRule(rule, {
            digitalEmployees: digitalEmployeeCatalog,
            businessSkills: businessSkillCatalog,
            externalAuditRequests,
          }),
          mountedSubsystems: mountedSubsystemsByDepartment.get(rule.departmentId) || [],
        },
      }));
  const sessionPerson = {
    id: session.employeeId || session.feishuUserId || session.email || "current-user",
    name: session.name,
    email: session.email || session.nickName || session.employeeId,
    role: session.title || session.role,
    departmentId: session.departmentId,
    department: session.department,
    governanceRole: isSystemAdmin ? "系统管理员" : "当前登录员工",
    governance: isSystemAdmin
      ? { scope: "platformGovernance", editableDepartmentIds: ["*"], reviewDepartmentIds: ["*"] }
      : null,
    assets: isSystemAdmin
      ? {
          editableEmployees: digitalEmployeeCatalog,
          editableBusinessSkills: businessSkillCatalog,
          reviewRequests: externalAuditRequests,
          blockedDepartments: [],
        }
      : { editableEmployees: [], editableBusinessSkills: [], reviewRequests: [], blockedDepartments: [] },
    status: "启用",
  };
  const visibleAddedPeople = addedPeople.filter((person) => !isDepartmentOwnerCandidatePerson(person, userDrafts[person.id]));
  const directoryPeople = enterpriseReady
    ? []
    : personnel.map((user) => {
        const governance = governanceForUser(user);
        return {
          ...user,
          governance,
          assets: governanceAssetsForRule(governance, {
            digitalEmployees: digitalEmployeeCatalog,
            businessSkills: businessSkillCatalog,
            externalAuditRequests,
          }),
        };
      });
  const governedPeople = [sessionPerson, ...visibleAddedPeople, ...directoryPeople].filter((user, index, list) => {
    const key = user.id || user.email || user.name;
    return list.findIndex((item) => (item.id || item.email || item.name) === key) === index;
  });
  const departmentOwnerOptions = uniqueOwnerOptions([
    ...governedPeople,
    ...Object.values(departmentOwnerDrafts).map((draft) => ({
      id: draft.ownerUserId,
      name: draft.ownerName,
      role: draft.ownerRole,
      departmentId: draft.ownerDepartmentId,
      department: draft.ownerDepartmentName,
      status: "启用",
    })),
  ]);
  const coveredDepartments = enterpriseReady
    ? departmentOwnerRows.length
    : new Set(personnel.map((user) => user.departmentId)).size;
  const editingUser = governedPeople.find((user) => user.id === editingUserId);
  const pendingPeopleCount = governedPeople.filter((user) => pendingPersonnelStatuses.has(userDrafts[user.id]?.status || user.status)).length;
  const pendingAccessRequestCount = accessRequests.filter((request) => request.status === "pending_review").length;

  function applyDraftPayload(data) {
    setAddedPeople(Array.isArray(data.addedPeople) ? data.addedPeople.map(hydrateAddedPerson) : []);
    setUserDrafts(data.userDrafts && typeof data.userDrafts === "object" ? data.userDrafts : {});
    setDepartmentOwnerDrafts(data.departmentOwnerDrafts && typeof data.departmentOwnerDrafts === "object" ? data.departmentOwnerDrafts : {});
    setAccessRequests(Array.isArray(data.accessRequests) ? data.accessRequests : []);
    setDraftStore({
      status: "ready",
      error: "",
      persistence: data.persistence || null,
    });
  }

  async function saveDepartmentOwnerSelection(row, ownerUserId) {
    const selectedOwner = departmentOwnerOptions.find((person) => person.id === ownerUserId) || null;
    const departmentName = row.department?.name || row.rule.departmentId;
    await applyPersonnelDraftRequest(() =>
      updateDepartmentOwnerDraft(row.rule.departmentId, {
        departmentName,
        ownerUserId: selectedOwner?.id || "",
        ownerName: selectedOwner?.name || "",
        ownerRole: selectedOwner?.role || selectedOwner?.governanceRole || "",
        ownerDepartmentId: selectedOwner?.departmentId || "",
        ownerDepartmentName: selectedOwner?.department || "",
        status: selectedOwner ? "draft" : "cleared",
        source: enterpriseReady ? "fortress-runtime-owner-select" : "mvp-backend-draft",
        note: selectedOwner
          ? `管理员选择 ${selectedOwner.name} 作为 ${departmentName} 负责人草案。`
          : `管理员清空 ${departmentName} 负责人草案。`,
      }),
    );
  }

  async function applyPersonnelDraftRequest(request, nextStatus = "saving") {
    setDraftStore((current) => ({ ...current, status: nextStatus, error: "" }));
    try {
      const data = await request();
      applyDraftPayload(data);
      return data;
    } catch (error) {
      setDraftStore((current) => ({
        ...current,
        status: "error",
        error: error?.message || "人员草稿接口失败",
      }));
      throw error;
    }
  }

  async function saveUserDraft(userId, draft) {
    await applyPersonnelDraftRequest(() => updatePersonnelDraft(userId, draft));
    setEditingUserId("");
  }

  async function saveResolvedPerson(person) {
    const governance = personDraftGovernance(person);
    const user = {
      ...person,
      id: person.id || person.email || person.name,
      governance,
      assets: governanceAssetsForRule(governance, {
        digitalEmployees: digitalEmployeeCatalog,
        businessSkills: businessSkillCatalog,
        externalAuditRequests,
      }),
    };
    await applyPersonnelDraftRequest(() => createPersonnelDraftPerson(user));
    setIsAddingUser(false);
  }

  async function removeUserDraft(user) {
    if (addedPeople.some((person) => person.id === user.id)) {
      await applyPersonnelDraftRequest(() => deletePersonnelDraftPerson(user.id));
      setEditingUserId((current) => (current === user.id ? "" : current));
      return;
    }
    await saveUserDraft(user.id, {
      displayName: user.name,
      role: user.role,
      departmentId: user.departmentId,
      departmentName: user.department,
      governanceRole: user.governanceRole || "普通成员",
      status: "停用",
      note: "移除管理权限草案；不删除企业目录人员。",
      source: enterpriseReady ? "fortress-runtime" : "mvp-backend-draft",
    });
  }

  async function confirmUserDraft(user) {
    await saveUserDraft(user.id, {
      displayName: user.name,
      role: user.role,
      departmentId: user.departmentId,
      departmentName: user.department,
      governanceRole: user.governanceRole || "普通成员",
      status: "启用",
      note: "管理员确认目录候选；当前写入 MVP 后端草稿，正式上线仍需生产 RBAC、审计和审批接口。",
      source: enterpriseReady ? "fortress-runtime" : "mvp-backend-draft",
      action: "confirm",
    });
  }

  async function submitAccessRequest(accessRequest) {
    const data = await applyPersonnelDraftRequest(() => createPersonnelAccessRequest(accessRequest));
    return data;
  }

  async function decideAccessRequest(requestId, decision) {
    await applyPersonnelDraftRequest(() => decidePersonnelAccessRequest(requestId, decision));
  }

  useEffect(() => {
    let isMounted = true;
    setDraftStore((current) => ({ ...current, status: "loading", error: "" }));
    const request = isSystemAdmin ? fetchPersonnelDrafts() : fetchPersonnelAccessRequests();
    request
      .then((data) => {
        if (!isMounted) return;
        applyDraftPayload(data);
      })
      .catch((error) => {
        if (!isMounted) return;
        setDraftStore({
          status: "error",
          error: error?.message || "人员草稿读取失败",
          persistence: null,
        });
      });

    return () => {
      isMounted = false;
    };
  }, [isSystemAdmin, session.employeeId, session.email, session.feishuUserId]);

  useEffect(() => {
    let isMounted = true;
    if (!hasFortressSession) {
      setEnterpriseGovernance({ rows: [], sync: null, status: "idle", error: "" });
      return () => {
        isMounted = false;
      };
    }

    setEnterpriseGovernance((current) => ({ ...current, status: "loading", error: "" }));
    fetch("/api/org/department-governance?source=fortress", { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Fortress 负责人同步失败");
        return data;
      })
      .then((data) => {
        if (!isMounted) return;
        setEnterpriseGovernance({
          rows: data.departmentGovernance || [],
          sync: data.sync || null,
          status: "ready",
          error: "",
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setEnterpriseGovernance({
          rows: [],
          sync: null,
          status: "error",
          error: error?.message || "Fortress 负责人同步失败",
        });
      });

    return () => {
      isMounted = false;
    };
  }, [hasFortressSession]);

  useEffect(() => {
    let isMounted = true;
    if (!hasFortressSession) {
      setEnterpriseOrg({ root: null, departments: [], status: "idle", error: "" });
      return () => {
        isMounted = false;
      };
    }

    setEnterpriseOrg((current) => ({ ...current, status: "loading", error: "" }));
    fetch("/api/org/departments?source=fortress", { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Fortress 部门树读取失败");
        return data;
      })
      .then((data) => {
        if (!isMounted) return;
        setEnterpriseOrg({
          root: data.root || null,
          departments: data.departments || [],
          status: "ready",
          error: "",
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setEnterpriseOrg({
          root: null,
          departments: [],
          status: "error",
          error: error?.message || "Fortress 部门树读取失败",
        });
      });

    return () => {
      isMounted = false;
    };
  }, [hasFortressSession]);

  return (
    <section className="view-stack">
      <div className="metrics-grid">
        <MetricCard label="用户" value={governedPeople.length} detail={enterpriseReady ? "已管理人员" : "Demo 目录"} />
        <MetricCard label="治理负责人" value={departmentOwnerRows.length} detail={enterpriseReady ? "按企业目录聚合" : "按部门范围授权"} />
        <MetricCard label="部门" value={coveredDepartments} detail="按 departmentId 映射" />
        <MetricCard label="待确认" value={pendingPeopleCount} detail="新增 / 编辑草案" />
        <MetricCard label="权限申请" value={pendingAccessRequestCount} detail={isSystemAdmin ? "待管理员审核" : "我的申请"} />
        <MetricCard label="业务级资产" value={digitalEmployees.filter((employee) => employee.level !== "系统级").length} detail="按 ownerDepartmentId 归属" onClick={() => onNavigate("employees")} />
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Identity Mapping</p>
            <h2>登录与员工部门映射</h2>
          </div>
          <span className={`status-pill ${enterpriseReady ? "good" : hasFortressSession ? "warn" : "muted"}`}>
            {enterpriseReady ? "Fortress 已同步" : hasFortressSession ? "同步负责人中" : "demo 规则"}
          </span>
        </div>
        <div className="identity-grid">
          <div>
            <span>当前登录员工</span>
            <strong>{session.name}</strong>
            <small>{session.employeeId}</small>
          </div>
          <div>
            <span>部门节点</span>
            <strong>{mappedDepartment?.name || session.department}</strong>
            <small>{session.departmentPath || session.department}</small>
          </div>
          <div>
            <span>身份来源</span>
            <strong>{session.identitySource}</strong>
            <small>{identityIntegration.productionSource}</small>
          </div>
          <div>
            <span>映射字段</span>
            <strong>{identityIntegration.loginFields.join(" / ")}</strong>
            <small>{enterpriseReady ? `${enterpriseGovernance.sync?.ownerSource || "LeaderUserID"} 负责人建议` : "demo 只保存脱敏会话摘要"}</small>
          </div>
        </div>
        {hasFortressSession && enterpriseGovernance.status === "error" ? (
          <div className="identity-banner">
            <strong>负责人同步失败</strong>
            <span>{enterpriseGovernance.error}</span>
            <b>当前退回 demo 权限规则</b>
          </div>
        ) : null}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Department RBAC</p>
            <h2>部门负责人权限矩阵</h2>
          </div>
          <span className={`status-pill ${enterpriseReady ? "good" : "warn"}`}>
            {enterpriseReady ? "企业目录同步" : "demo 规则，生产服务端强校验"}
          </span>
        </div>
        <div className="governance-owner-grid">
          {departmentOwnerRows.map(({ rule, department, owner, assets }) => {
            const isEnterpriseRow = rule.source === "fortress";
            const ownerDraft = departmentOwnerDrafts[rule.departmentId];
            const selectedOwnerId = ownerDraft?.status === "cleared" ? "" : ownerDraft?.ownerUserId || (isEnterpriseRow ? "" : owner?.id) || "";
            const selectedOwner =
              departmentOwnerOptions.find((person) => person.id === selectedOwnerId) ||
              (ownerDraft?.ownerUserId
                ? {
                    id: ownerDraft.ownerUserId,
                    name: ownerDraft.ownerName,
                    role: ownerDraft.ownerRole,
                    department: ownerDraft.ownerDepartmentName,
                  }
                : isEnterpriseRow
                ? null
                : owner);
            return (
              <article className="governance-owner-card" key={rule.departmentId}>
                <div className="governance-owner-head">
                  <div>
                    <strong>{department?.name || rule.departmentId}</strong>
                    <span>{selectedOwner?.name || "未指定负责人"}</span>
                  </div>
                  <b>{permissionScopeLabels[rule.scope] || rule.scope}</b>
                </div>
                <label className="department-owner-select">
                  <span>部门负责人</span>
                  <select
                    value={selectedOwnerId}
                    disabled={!isSystemAdmin || draftStore.status === "saving" || departmentOwnerOptions.length === 0}
                    onChange={(event) => saveDepartmentOwnerSelection({ rule, department }, event.target.value).catch(() => {})}
                  >
                    <option value="">选择现有人员</option>
                    {departmentOwnerOptions.map((person) => (
                      <option key={person.id} value={person.id}>
                        {ownerOptionLabel(person)}
                      </option>
                    ))}
                  </select>
                </label>
                <dl>
                  <div>
                    <dt>可维护数字员工</dt>
                    <dd>{assets.editableEmployees.length}</dd>
                  </div>
                  <div>
                    <dt>可维护专项技能</dt>
                    <dd>{assets.editableBusinessSkills.length}</dd>
                  </div>
                  <div>
                    <dt>{isEnterpriseRow ? "目录成员" : "可评审请求"}</dt>
                    <dd>{isEnterpriseRow ? assets.memberCount : assets.reviewRequests.length}</dd>
                  </div>
                  <div>
                    <dt>挂载子系统</dt>
                    <dd>{(assets.mountedSubsystems || []).length}</dd>
                  </div>
                  <div>
                    <dt>{isEnterpriseRow ? "子部门节点" : "限制部门"}</dt>
                    <dd>{isEnterpriseRow ? assets.departmentCount : assets.blockedDepartments.length}</dd>
                  </div>
                </dl>
                <div className="governance-scope-lines">
                  <div>
                    <span>数字员工</span>
                    <SummaryChipLine items={assets.editableEmployees.map((employee) => employee.name)} limit={2} />
                  </div>
                  <div>
                    <span>专项技能</span>
                    <SummaryChipLine items={assets.editableBusinessSkills.map((skill) => skill.name)} limit={3} />
                  </div>
                  <div>
                    <span>挂载子系统</span>
                    <SubsystemChipLine
                      subsystems={assets.mountedSubsystems || []}
                      limit={3}
                      emptyLabel="暂无子系统"
                    />
                  </div>
                  <div>
                    <span>禁止越权</span>
                    <SummaryChipLine
                      items={assets.blockedDepartments.length ? assets.blockedDepartments : ["平台规则限制跨部门更新"]}
                      limit={4}
                    />
                  </div>
                </div>
                <p>{rule.policy}</p>
                {isEnterpriseRow && owner?.id ? <p>目录建议：{[owner.name, rule.ownerEvidence].filter(Boolean).join("；")}</p> : null}
              </article>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">User Admin</p>
            <h2>人员管理</h2>
          </div>
          <div className="panel-actions">
            {isSystemAdmin ? (
              <button className="ghost-action" type="button" onClick={() => setIsAddingUser((current) => !current)}>
                <UsersRound size={18} />
                新增人员
              </button>
            ) : null}
            <button
              className="ghost-action"
              type="button"
              disabled={!isSystemAdmin}
              onClick={() => setEditingUserId((current) => current || governedPeople[0]?.id || "")}
            >
              <Settings2 size={18} />
              {isSystemAdmin ? "编辑人员" : enterpriseReady ? "Fortress" : "Demo"}
            </button>
          </div>
        </div>
        {isSystemAdmin ? (
          <div className="identity-banner">
            <strong>系统管理员模式</strong>
            <span>新增、编辑、确认、移除会写入本机 MVP 后端草稿；正式上线仍需接入生产 RBAC、审批和审计。</span>
            <b>{draftStore.persistence ? `${draftStore.persistence.kind} · ${draftStore.persistence.path}` : session.name}</b>
          </div>
        ) : null}
        {isSystemAdmin && draftStore.status === "loading" ? (
          <div className="identity-banner">
            <strong>正在读取后端草稿</strong>
            <span>人员管理记录从本机 Node 后端加载，不再使用浏览器缓存。</span>
            <b>MVP 后端</b>
          </div>
        ) : null}
        {isSystemAdmin && draftStore.status === "saving" ? (
          <div className="identity-banner">
            <strong>正在保存</strong>
            <span>本次人员治理变更正在写入 MVP 后端草稿。</span>
            <b>请稍候</b>
          </div>
        ) : null}
        {isSystemAdmin && draftStore.status === "error" ? (
          <div className="identity-banner">
            <strong>人员草稿接口异常</strong>
            <span>{draftStore.error}</span>
            <b>请确认本机后端已启动</b>
          </div>
        ) : null}
        {!isSystemAdmin && draftStore.status === "error" ? (
          <div className="identity-banner">
            <strong>权限申请接口异常</strong>
            <span>{draftStore.error}</span>
            <b>请确认已登录数字化平台</b>
          </div>
        ) : null}
        {!isSystemAdmin ? (
          <PeopleAccessRequestPanel
            departmentOptions={orgDepartments}
            isSaving={draftStore.status === "saving"}
            onSubmit={submitAccessRequest}
            session={session}
          />
        ) : null}
        <PeopleAccessRequestReview
          accessRequests={accessRequests}
          isSystemAdmin={isSystemAdmin}
          isSaving={draftStore.status === "saving"}
          onDecision={decideAccessRequest}
        />
        <PeopleConfirmationFlow
          addedPeopleCount={visibleAddedPeople.length}
          editingUser={editingUser}
          enterpriseReady={enterpriseReady}
          isAddingUser={isAddingUser}
          pendingPeopleCount={pendingPeopleCount}
        />
        {editingUser ? (
          <PeopleEditDraftPanel
            user={editingUser}
            enterpriseReady={enterpriseReady}
            departmentOptions={orgDepartments}
            onCancel={() => setEditingUserId("")}
            onSave={(draft) => saveUserDraft(editingUser.id, draft)}
            isSaving={draftStore.status === "saving"}
          />
        ) : null}
        {isAddingUser ? (
          <PeopleAddPanel
            departmentOptions={orgDepartments}
            onCancel={() => setIsAddingUser(false)}
            onResolved={saveResolvedPerson}
            isSaving={draftStore.status === "saving"}
          />
        ) : null}
        <PeopleTable
          draftStoreStatus={draftStore.status}
          governedPeople={governedPeople}
          isSystemAdmin={isSystemAdmin}
          onConfirm={confirmUserDraft}
          onEdit={setEditingUserId}
          onRemove={removeUserDraft}
          sessionPersonId={sessionPerson.id}
          userDrafts={userDrafts}
        />
      </section>
    </section>
  );
}

function SummaryChipLine({ items, limit, emptyLabel = "暂无" }) {
  const [expanded, setExpanded] = useState(false);
  const safeItems = items.length ? items : [emptyLabel];
  const visibleItems = expanded ? safeItems : safeItems.slice(0, limit);
  const hiddenItems = safeItems.slice(limit);
  const hasHiddenItems = hiddenItems.length > 0;
  const hiddenLabel = hiddenItems.join(" / ");

  return (
    <>
      {visibleItems.map((item, index) => (
        <b key={`${item}-${index}`}>{item}</b>
      ))}
      {hasHiddenItems ? (
        <button
          className="chip-more"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "收起隐藏项" : `展开 ${hiddenItems.length} 项：${hiddenLabel}`}
          title={expanded ? "收起" : hiddenLabel}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "收起" : `+${hiddenItems.length}`}
        </button>
      ) : null}
    </>
  );
}

function SubsystemChipLine({ subsystems, limit, emptyLabel = "暂无子系统" }) {
  const [expanded, setExpanded] = useState(false);
  if (!subsystems.length) return <b>{emptyLabel}</b>;
  const visibleItems = expanded ? subsystems : subsystems.slice(0, limit);
  const hiddenItems = subsystems.slice(limit);
  const hasHiddenItems = hiddenItems.length > 0;
  const hiddenLabel = hiddenItems.map((subsystem) => subsystem.name || subsystem.id).join(" / ");

  return (
    <>
      {visibleItems.map((subsystem) => {
        const label = subsystem.name || subsystem.id;
        return subsystem.link ? (
          <a
            className="subsystem-link-chip"
            href={subsystem.link}
            key={subsystem.id || label}
            rel="noreferrer"
            target="_blank"
            title={[label, subsystem.businessDomain, subsystem.status].filter(Boolean).join(" / ")}
          >
            {label}
          </a>
        ) : (
          <b key={subsystem.id || label}>{label}</b>
        );
      })}
      {hasHiddenItems ? (
        <button
          className="chip-more"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "收起隐藏子系统" : `展开 ${hiddenItems.length} 个子系统：${hiddenLabel}`}
          title={expanded ? "收起" : hiddenLabel}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "收起" : `+${hiddenItems.length}`}
        </button>
      ) : null}
    </>
  );
}

function uniqueOwnerOptions(people) {
  const options = [];
  const seen = new Set();
  for (const person of people) {
    const id = person?.id || person?.email || person?.name;
    if (person?.status === "停用") continue;
    if (!id || !person?.name || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      name: person.name,
      email: person.email || "",
      role: person.role || person.governanceRole || "",
      governanceRole: person.governanceRole || "",
      departmentId: person.departmentId || "",
      department: person.department || "",
    });
  }
  return options.sort((left, right) => {
    const leftDepartment = left.department || "";
    const rightDepartment = right.department || "";
    return leftDepartment.localeCompare(rightDepartment, "zh-CN") || left.name.localeCompare(right.name, "zh-CN");
  });
}

function ownerOptionLabel(person) {
  return person.name;
}

function isDepartmentOwnerCandidatePerson(person, draft) {
  if (draft?.governanceRole && !/部门负责人候选|待确认负责人/.test(draft.governanceRole)) return false;
  const roleText = [person?.governanceRole, person?.role, draft?.governanceRole, draft?.role, draft?.displayName, person?.name]
    .filter(Boolean)
    .join(" ");
  return /部门负责人候选|待确认负责人/.test(roleText);
}
