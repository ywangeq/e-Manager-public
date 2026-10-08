import path from "node:path";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";
import { createToolAssetRepository } from "../tool-registry/tool-asset-repository.mjs";
import { createToolConnectionAuthority, createRegisteredOpenApiTools } from "../tool-registry/registered-openapi-tools.mjs";
import { createSqliteTriggerConfigRepository } from "../triggers/sqlite-trigger-config-repository.mjs";
import { createFeishuManagedOpenApiTools } from "../channels/feishu/managed-openapi-tool-registry.mjs";

// Runtime owns capability assembly. Hosts supply services, never a Channel-specific Tool list.
export function createRuntimeToolCapabilities({ projectRoot, env = process.env, assetRepository = null,
  connectionAuthority = null, feishuEmployeeAppTokenLeaseService, managedReferenceCatalogStore } = {}) {
  const DATAFLOW_RESOURCE_REFERENCE_OVERLAY_FILE = path.join(projectRoot, "server", "contracts", "dataflow-resource-references.openapi.json");
  const HR_TRAINING_OPENAPI_FILE = path.join(projectRoot, "server", "contracts", "hr-training-assessment.openapi.json");
  let ownedAssets = null;
  let ownedConnections = null;
  let registered = null;
  function initializeReader() {
    if (registered) return;
    try {
      if (!assetRepository) {
        const dataDir = resolveDigitalWorkforceDataDir({ env, projectRoot });
        const configuredPath = String(env.TRIGGER_EVENT_DATABASE_PATH || "").trim();
        if (configuredPath && !path.isAbsolute(configuredPath)) throw new Error("invalid_connection_repository_path");
        ownedConnections = createSqliteTriggerConfigRepository({ databasePath: configuredPath || path.join(dataDir, "trigger-events.sqlite"), readOnly: true });
        connectionAuthority = createToolConnectionAuthority({ getConnections: () => ownedConnections.loadPublishedConfiguration() });
        ownedAssets = createToolAssetRepository({ databasePath: path.join(dataDir, "tool-assets.sqlite"), readOnly: true,
          validateReferences: connectionAuthority.validateReferences });
        assetRepository = ownedAssets;
      }
      registered = createRegisteredOpenApiTools({ repository: assetRepository, connectionAuthority, environment: env });
    } catch {
      close();
      throw new Error("runtime_tool_registry_unavailable");
    }
  }
  function close() {
    if (ownedAssets) { ownedAssets.close(); assetRepository = null; ownedAssets = null; }
    if (ownedConnections) { ownedConnections.close(); ownedConnections = null; }
    registered = null;
  }
  const builtinManagedOpenApiTools = [{
    allowSelfSignedCertificate: env.DATAFLOW_ALLOW_SELF_SIGNED_CERT === "1",
    baseUrl: env.DATAFLOW_API_BASE_URL || "",
    openApiFile: env.DATAFLOW_OPENAPI_FILE || "",
    openApiOverlayFiles: [
      DATAFLOW_RESOURCE_REFERENCE_OVERLAY_FILE,
      ...String(env.DATAFLOW_OPENAPI_OVERLAY_FILES || "").split(",").map((item) => item.trim()).filter(Boolean),
    ],
    openApiUrl: env.DATAFLOW_OPENAPI_URL || "",
    toolId: "dataflow-rest-api",
    toolNamePrefix: "dataflow",
    unavailableMessage: "DataFlow Tool 尚未载入机器可读 OpenAPI 合同；这不表示 DataFlow API 不存在。",
  }, {
    allowSelfSignedCertificate: env.HR_TALENTOS_ALLOW_SELF_SIGNED_CERT === "1",
    baseUrl: env.HR_TALENTOS_API_BASE_URL || "",
    openApiFile: env.HR_TALENTOS_OPENAPI_FILE || "",
    openApiUrl: env.HR_TALENTOS_OPENAPI_URL || "",
    toolId: "hr-talentos-api",
    toolNamePrefix: "hr_talentos",
    unavailableMessage: "HR 简历系统 Tool 尚未载入机器可读 OpenAPI 合同；这不表示 HR 业务能力不存在。",
  }, {
    allowSelfSignedCertificate: env.HR_TRAINING_ALLOW_SELF_SIGNED_CERT === "1",
    baseUrl: env.HR_TRAINING_API_BASE_URL || "",
    managedRequestHeaders: env.HR_TRAINING_SERVICE_API_KEY
      ? [{ name: "X-HR-Train-API-Key", value: env.HR_TRAINING_SERVICE_API_KEY }]
      : [],
    openApiFile: env.HR_TRAINING_OPENAPI_FILE || (env.HR_TRAINING_OPENAPI_URL ? "" : HR_TRAINING_OPENAPI_FILE),
    openApiUrl: env.HR_TRAINING_OPENAPI_URL || "",
    toolId: "hr-training-assessment-api",
    toolNamePrefix: "hr_training",
    unavailableMessage: "HR 培训考核 Tool 尚未载入受管 OpenAPI 合同或 HTTPS 目标。",
  }, ...createFeishuManagedOpenApiTools({ feishuEmployeeAppTokenLeaseService, managedReferenceCatalogStore })];
  function descriptors() {
    initializeReader();
    return [
      ...builtinManagedOpenApiTools.filter(tool => assetRepository.resolvePublished(tool.toolId)?.kind === "builtin")
        .map(tool => ({ ...tool, isCurrent: () => assetRepository.resolvePublished(tool.toolId)?.kind === "builtin" })),
      ...registered.descriptors(),
    ];
  }
  return Object.freeze({ descriptors, close });
}
