export function matchesWorkbenchAutomation(rule, scope) {
  return !scope || scope.employeeIds.includes(rule.employeeId) &&
    scope.taskIds.some(id => id === rule.sourceTaskId || id === rule.lastTaskId);
}

export function workbenchScheduledRules(rules, scope, now = Date.now()) {
  return rules.filter(rule => matchesWorkbenchAutomation(rule, scope) &&
    ["active", "paused", "attention_required"].includes(rule.state) && Date.parse(rule.expiresAt) > now);
}
