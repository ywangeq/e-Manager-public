// Upstream unscoped integration state is not accepted by the local distribution.
export const ALGORITHM_EMPLOYEE_ID = "";
export const LEGACY_ALGORITHM_EMPLOYEE_ID = "";
export const LEGACY_ALGORITHM_STATE_COMPATIBILITY = Object.freeze({ enabled: false });
export function translateLegacyAlgorithmState(data = {}) {
  if (Object.keys(data.connection || {}).length || Object.keys(data.secretVault || {}).length) {
    throw new Error("unscoped_integration_state_not_supported");
  }
  return { ...data, version: "feishu-employee-integrations.v2", connection: {}, secretVault: {} };
}
