function normalizeWorkerEmployeeId(value = "") {
  const employeeId = String(value || "").trim();
  if (!employeeId) throw new Error("feishu_worker_employee_id_required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(employeeId)) {
    throw new Error("feishu_worker_employee_id_invalid");
  }
  return employeeId;
}

function parseEmployeeIdArgument(argv = []) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--employee-id") {
      values.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--employee-id=")) {
      values.push(argument.slice("--employee-id=".length));
    }
  }
  const normalized = values.map(normalizeWorkerEmployeeId);
  if (new Set(normalized).size > 1) throw new Error("feishu_worker_employee_id_conflict");
  return normalized[0] || "";
}

function resolveWorkerEmployeeId({ argv = [], env = {} } = {}) {
  const cliEmployeeId = parseEmployeeIdArgument(argv);
  const envEmployeeId = env.FEISHU_EMPLOYEE_ID
    ? normalizeWorkerEmployeeId(env.FEISHU_EMPLOYEE_ID)
    : "";
  if (cliEmployeeId && envEmployeeId && cliEmployeeId !== envEmployeeId) {
    throw new Error("feishu_worker_employee_id_conflict");
  }
  return normalizeWorkerEmployeeId(cliEmployeeId || envEmployeeId);
}

export {
  normalizeWorkerEmployeeId,
  parseEmployeeIdArgument,
  resolveWorkerEmployeeId,
};
