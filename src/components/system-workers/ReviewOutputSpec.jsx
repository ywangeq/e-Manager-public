import { Settings2 } from "lucide-react";
import { SkillChips } from "../ConsolePrimitives";

export default function ReviewOutputSpec({ spec }) {
  return (
    <div className="governance-block compact">
      <div className="governance-line">
        <Settings2 size={15} />
        <span>会写规范</span>
        <b>{spec.contractVersion}</b>
        <b>{spec.writebackTarget}</b>
      </div>
      <SkillChips title="必填字段" items={spec.requiredFields || []} compact />
      <SkillChips title="UI 分区" items={(spec.uiSections || []).map((section) => section.title || section.id)} compact />
      {spec.privacyBoundary ? <small className="model-binding-note">{spec.privacyBoundary}</small> : null}
    </div>
  );
}
