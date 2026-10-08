import { fileURLToPath } from "node:url";

// Transport configuration only. Candidate selection and retry policy belong to the
// reviewed operations Skill and HR Train; the shared OpenAPI executor owns dispatch.
export function createHrTrainingOperationsTool({ baseUrl = "", apiKey = "" } = {}) {
  return {
    toolId: "hr-training-operations-api",
    toolNamePrefix: "hr_training_operations",
    baseUrl,
    openApiFile: fileURLToPath(new URL("./contracts/hr-training-operations.openapi.json", import.meta.url)),
    managedCredentialHeader: "X-HR-Train-API-Key",
    managedRequestHeaders: [{ name: "X-HR-Train-API-Key", value: apiKey }],
    unavailableMessage: "HR Train 运维 Tool 合同或 HTTPS 目标尚未就绪。",
  };
}
