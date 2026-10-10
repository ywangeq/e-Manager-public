import { useEffect, useId, useRef } from "react";

export function AutomationSettingsDialog({title, busy = false, onClose, children}) {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="automation-settings-dialog" aria-labelledby={titleId} onCancel={event => {event.preventDefault();if (!busy) onClose();}}>
    <h3 id={titleId}>{title}</h3>
    {children}
  </dialog>;
}
