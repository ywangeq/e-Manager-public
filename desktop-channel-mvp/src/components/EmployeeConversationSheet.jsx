import { useEffect, useRef } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import "./employee-conversation-sheet.css";

export function EmployeeConversationSheet({ employee, onClose, children }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    dialog.querySelector(".composer textarea, .composer input")?.focus();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={dialogRef} className="employee-conversation-sheet" aria-label={`${employee.name || employee.id}员工会话`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><button type="button" onClick={onClose}><ArrowLeft size={16} />返回工作台</button><span>员工直接处理 · 按需自行规划</span></header>
    <div className="employee-conversation-body">{children}</div>
  </dialog>;
}
