import { cleanShortText, digestValue } from "../../feishu-integration-support.mjs";
import { createMaterialToolExecutor } from "../../agent-runtime/material-tool-executor.mjs";
import { downloadFeishuMessageResource } from "./message-resource-intake.mjs";
import { extractFeishuMessageResources } from "./runtime-intake.mjs";

function createFeishuMaterialToolExecutor({
  fetch = globalThis.fetch,
  message = {},
  messageId = "",
  messages = [],
  resources = [],
  readSecret = () => "",
  validateFeishuCredentials,
  ...runtimeOptions
} = {}) {
  const sourceMessages = Array.isArray(messages) && messages.length ? messages : [message];
  const resolvedResources = Array.isArray(resources) && resources.length
    ? resources.map((resource) => ({ ...resource, sourceMessageId: cleanShortText(resource.messageId) }))
    : sourceMessages.flatMap((sourceMessage) => extractFeishuMessageResources(sourceMessage).map((resource) => ({
      ...resource,
      sourceMessageId: cleanShortText(sourceMessage.message_id) || cleanShortText(messageId),
    })));
  const feishuInputs = resolvedResources.map((resource, index) => ({ ...resource, inputId: `channel-input-${index + 1}` }));
  const feishuInputById = new Map(feishuInputs.map((resource) => [resource.inputId, resource]));
  const channelInputs = feishuInputs.map((resource) => ({
    inputId: resource.inputId,
    name: cleanShortText(resource.name),
    sourceRef: digestValue(resource.fileKey),
  }));

  return createMaterialToolExecutor({
    ...runtimeOptions,
    channelInputs,
    prepareChannelInput: async ({ channelInput }) => {
      const resource = feishuInputById.get(channelInput.inputId);
      if (!resource?.sourceMessageId || !resource.fileKey) {
        return { ok: false, status: "channel_input_not_found", summary: "当前 Channel 输入不存在或已失效。" };
      }
      const appId = readSecret("appId");
      const appSecret = readSecret("appSecret");
      if (!appId || !appSecret) {
        return { ok: false, status: "download_credentials_missing", summary: "服务端尚未配置可读取该 Channel 附件的凭证。" };
      }
      const credentials = await validateFeishuCredentials?.({ appId, appSecret });
      if (!credentials?.ok || !credentials.tenantAccessToken) {
        return { ok: false, status: "download_credentials_unavailable", summary: "服务端尚未取得可读取该 Channel 附件的短时凭证。" };
      }
      const downloaded = await downloadFeishuMessageResource({
        fetch,
        fileKey: resource.fileKey,
        fileName: resource.name,
        messageId: resource.sourceMessageId,
        messageType: resource.messageType,
        tenantAccessToken: credentials.tenantAccessToken,
      });
      if (downloaded.ok) return downloaded;
      return {
        ...downloaded,
        summary: downloaded.status === "download_too_large"
          ? "飞书附件超过 100 MB 消息资源下载上限，未进入数字员工工作区。"
          : "Channel 输入下载失败，请检查访问范围、文件完整性和短时凭证。",
      };
    },
  });
}

export { createFeishuMaterialToolExecutor };
