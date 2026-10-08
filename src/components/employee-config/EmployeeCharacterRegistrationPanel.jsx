import { BadgeCheck, Box, Fingerprint, Waves } from "lucide-react";
import { digitalEmployeeCharacterFor } from "../../data/digitalEmployeeCharacters";

export default function EmployeeCharacterRegistrationPanel({ employee }) {
  const character = digitalEmployeeCharacterFor(employee.id);

  if (!character) {
    return (
      <section className="employee-character-registration is-empty" aria-label={`${employee.name} 角色登记信息`}>
        <div className="employee-character-registration-empty">
          <Fingerprint size={24} />
          <span>
            <strong>角色原型未登记</strong>
            <small>该数字员工尚未建立独立的视觉身份资产。</small>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="employee-character-registration"
      aria-label={`${employee.name} 角色登记信息`}
      style={{ "--character-accent": character.accent }}
    >
      <div className="employee-character-stage">
        <span className="employee-character-stage-label"><Fingerprint size={14} />角色原型</span>
        <picture>
          <source media="(prefers-reduced-motion: reduce)" srcSet={character.staticSrc} />
          <img src={character.animatedSrc} alt={`${employee.name}角色原型：${character.codename}`} />
        </picture>
        <span className="employee-character-registration-state">
          <i aria-hidden="true" />
          视觉身份已登记
        </span>
      </div>

      <div className="employee-character-record">
        <div className="employee-character-record-head">
          <span>
            <small>角色登记信息</small>
            <strong>{character.codename}</strong>
          </span>
          <BadgeCheck size={20} aria-label="已登记" />
        </div>
        <p>{employee.title || employee.objective}</p>
        <dl>
          <div>
            <dt><Box size={14} />角色模块</dt>
            <dd>{character.roleModule}</dd>
          </div>
          <div>
            <dt><Waves size={14} />签名动作</dt>
            <dd>{character.signatureMotion}</dd>
          </div>
          <div>
            <dt>登记版本</dt>
            <dd>{character.contractVersion}</dd>
          </div>
          <div>
            <dt>员工实体</dt>
            <dd>{employee.id} · {employee.version || "版本待登记"}</dd>
          </div>
        </dl>
        <small className="employee-character-boundary">视觉登记只表达员工身份；不代表审批、授权、任务状态或 Runtime 已就绪。</small>
      </div>
    </section>
  );
}
