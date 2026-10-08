async function fetchRuntimeDigitalEmployeeCatalog({ baseUrl, fetch = globalThis.fetch } = {}) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  if (!origin) throw new Error("runtime_digital_employee_catalog_origin_required");
  const response = await fetch(`${origin}/api/digital-employees`);
  if (!response.ok) throw new Error(`runtime_digital_employee_catalog_unavailable:${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.digitalEmployees)) {
    throw new Error("runtime_digital_employee_catalog_contract_invalid");
  }
  return {
    digitalEmployees: payload.digitalEmployees,
    source: "management_catalog_api",
  };
}

export { fetchRuntimeDigitalEmployeeCatalog };
