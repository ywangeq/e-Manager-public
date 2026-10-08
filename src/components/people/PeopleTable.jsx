import { CheckCircle2, Settings2, Trash2 } from "lucide-react";
import { permissionScopeLabels } from "../../data/catalog";
import { statusClass } from "../../lib/consoleCatalog";
import { compactDepartmentName, departmentDetailName, draftStatusNote, pendingPersonnelStatuses } from "./peopleDraftModel";

export function PeopleTable({
  draftStoreStatus,
  governedPeople,
  isSystemAdmin,
  onConfirm,
  onEdit,
  onRemove,
  sessionPersonId,
  userDrafts,
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th>部门</th>
            <th>治理范围</th>
            <th>状态</th>
            {isSystemAdmin ? <th>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {governedPeople.map((user) => {
            const draft = userDrafts[user.id];
            const status = draft?.status || user.status;
            const isPendingPerson = pendingPersonnelStatuses.has(status);
            const assets = user.assets || { editableEmployees: [], editableBusinessSkills: [] };
            const departmentName = draft?.departmentName || user.department;
            const departmentDetail = departmentDetailName(departmentName);

            return (
              <tr key={user.id}>
                <td>
                  <span className="table-user">
                    <strong>{draft?.displayName || user.name}</strong>
                    <small>{user.email}</small>
                  </span>
                </td>
                <td>{draft?.role || user.role}</td>
                <td>
                  <span className="table-user">
                    <strong>{compactDepartmentName(departmentName)}</strong>
                    {departmentDetail ? <small>{departmentDetail}</small> : null}
                  </span>
                </td>
                <td>
                  <span className="table-user">
                    <strong>{draft?.governanceRole || user.governanceRole || "普通成员"}</strong>
                    <small>
                      {user.governance ? (permissionScopeLabels[user.governance.scope] || user.governance.scope) : "无权限"}
                      {" · "}
                      {assets.editableEmployees.length} 员工 / {assets.editableBusinessSkills.length} 技能
                    </small>
                  </span>
                </td>
                <td>
                  <span className="table-user">
                    <span className={`status-pill ${statusClass(status)}`}>{status}</span>
                    {draftStatusNote(status, draft) ? <small className="status-note">{draftStatusNote(status, draft)}</small> : null}
                  </span>
                </td>
                {isSystemAdmin ? (
                  <td>
                    <div className="table-actions">
                      {isPendingPerson ? (
                        <button
                          className="ghost-action table-action confirm"
                          type="button"
                          disabled={draftStoreStatus === "saving"}
                          onClick={() => onConfirm(user).catch(() => {})}
                        >
                          <CheckCircle2 size={15} />
                          确认
                        </button>
                      ) : null}
                      <button className="ghost-action table-action" type="button" onClick={() => onEdit(user.id)}>
                        <Settings2 size={15} />
                        编辑
                      </button>
                      <button
                        className="ghost-action table-action danger"
                        type="button"
                        disabled={user.id === sessionPersonId || draftStoreStatus === "saving"}
                        onClick={() => onRemove(user).catch(() => {})}
                      >
                        <Trash2 size={15} />
                        移除
                      </button>
                      {draft ? <small>草案 {draft.submittedAt}</small> : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
