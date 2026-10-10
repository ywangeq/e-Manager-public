export function AutomationTaskHeader({employeeName,status,enabled,disabled,onToggle,label,actions}) {
  return <header className="automation-task-header">
    <div className="automation-task-identity"><strong>{employeeName}</strong><span role="status">{status}</span></div>
    <div className="automation-task-controls">
      {onToggle?<button type="button" role="switch" className="personal-automation-switch" aria-label={label} aria-checked={enabled} disabled={disabled} onClick={onToggle}><span aria-hidden="true"/></button>:null}
      {actions}
    </div>
  </header>;
}
