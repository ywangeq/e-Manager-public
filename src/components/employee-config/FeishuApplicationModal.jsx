import { AlertTriangle, Check, CircleHelp, Clock3, Copy, ExternalLink, KeyRound, Loader2, Plus, RadioTower, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { capabilityRequestReviewHash } from "../../lib/controlPlaneReview";
import {
  CHAT_REF_GROUPS,
  CONNECTION_FIELD_HELP,
  DEFAULT_CHANNEL_INTENT_OPTIONS,
  DEFAULT_CONNECTION_FORM,
  DEFAULT_CONNECTION_MODE_OPTIONS,
  DEFAULT_DELIVERY_OPTIONS,
  DEFAULT_FORM,
  DEFAULT_PROCESS_CONFIRMATIONS,
  DEFAULT_SCOPE_OPTIONS,
  FEISHU_APP_CONSOLE_URL,
  FEISHU_BOT_PERMISSION_SCOPES,
  FEISHU_REVIEW_DOC_URL,
  FEISHU_SCOPE_DOC_URL,
  PERMISSION_CHECK_COOLDOWN_SECONDS,
  allowedChatRefsForSubmit,
  allowedChatRefsFromConnection,
  allowedChatRefsFromValue,
  applicationSteps,
  buildPermissionRequestPayload,
  connectionStatusLabel,
  connectionTestMessage,
  createChatRefRow,
  createSteps,
  deliveryOptionLabel,
  deliveryOptionNote,
  elapsedSeconds,
  fetchJson,
  feishuAppConsoleUrl,
  feishuPermissionUrl,
  isApprovedApplication,
  isPendingApplication,
  latestActiveApplication,
  normalizeFeishuAppId,
  optionValue,
  permissionTestView,
  readinessTone,
  uniqueList,
} from "./FeishuApplicationModalModel";

function StepIcon({ status }) {
  if (status === "running") return <Loader2 size={15} className="feishu-application-spin" />;
  if (status === "done") return <Check size={15} />;
  if (status === "failed") return <AlertTriangle size={15} />;
  if (status === "waiting") return <Clock3 size={15} />;
  return null;
}

function helpText(help) {
  return typeof help === "string" ? help : help?.text || "";
}

function FieldHelp({ help }) {
  const text = helpText(help);
  const links = Array.isArray(help?.links) ? help.links : [];
  return (
    <span className="feishu-field-help" tabIndex={0} title={text} aria-label={text}>
      <CircleHelp size={13} />
      <span className="feishu-field-help-tip" role="tooltip">
        <span>{text}</span>
        {links.length ? (
          <span className="feishu-field-help-links">
            {links.map((link) => (
              <a href={link.href} target="_blank" rel="noreferrer" key={link.href}>{link.label}</a>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function FieldLabel({ children, help }) {
  return (
    <span className="feishu-field-label">
      <span>{children}</span>
      {help ? <FieldHelp help={help} /> : null}
    </span>
  );
}

export default function FeishuApplicationModal({ employee, open, onClose }) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [steps, setSteps] = useState(() => createSteps());
  const [runState, setRunState] = useState("idle");
  const [draft, setDraft] = useState(null);
  const [draftState, setDraftState] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [connection, setConnection] = useState(null);
  const [connectionDraft, setConnectionDraft] = useState(null);
  const [connectionState, setConnectionState] = useState("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connectionForm, setConnectionForm] = useState(DEFAULT_CONNECTION_FORM);
  const [permissionCopyState, setPermissionCopyState] = useState("idle");
  const [permissionCheckState, setPermissionCheckState] = useState("idle");
  const [permissionCheckCooldownSeconds, setPermissionCheckCooldownSeconds] = useState(0);
  const [activePage, setActivePage] = useState("application");

  const employeeId = employee.id;
  const integrationEndpoint = `/api/feishu/integrations/${encodeURIComponent(employeeId)}`;
  const draftEndpoint = `${integrationEndpoint}/draft`;
  const applyEndpoint = `${integrationEndpoint}/apply`;
  const cancelEndpoint = `${integrationEndpoint}/cancel`;
  const connectionEndpoint = `${integrationEndpoint}/connection`;
  const connectEndpoint = `${integrationEndpoint}/connect`;
  const eventSubscriptionEndpoint = `${integrationEndpoint}/connection/event-subscription`;
  const connectionTestEndpoint = `${integrationEndpoint}/connection/test`;
  const messageTestEndpoint = `${integrationEndpoint}/message-test`;
  const scopeOptions = useMemo(
    () => draft?.scopeOptions?.length ? draft.scopeOptions : DEFAULT_SCOPE_OPTIONS,
    [draft],
  );
  const channelIntentOptions = useMemo(
    () => draft?.channelIntentOptions?.length ? draft.channelIntentOptions : DEFAULT_CHANNEL_INTENT_OPTIONS,
    [draft],
  );
  const deliveryOptions = useMemo(
    () => draft?.messageDeliveryOptions?.length ? draft.messageDeliveryOptions : DEFAULT_DELIVERY_OPTIONS,
    [draft],
  );
  const selectedScope = scopeOptions.find((scope) => optionValue(scope) === form.requestScope) || scopeOptions[0];
  const selectedDeliveryOption = deliveryOptions.find((option) => option.id === form.deliveryMode) || deliveryOptions[0];
  const selectedChannelIntentIds = uniqueList(form.channelIntentIds || [form.channelIntent]).filter((intentId) =>
    channelIntentOptions.some((option) => option.id === intentId)
  );
  const selectedChannelIntents = channelIntentOptions.filter((option) => selectedChannelIntentIds.includes(option.id));
  const requestsGroupAccess = selectedChannelIntentIds.includes("ops_group_smoke");
  const allowedChatRows = Array.isArray(connectionForm.allowedChatRefs) ? connectionForm.allowedChatRefs : allowedChatRefsFromValue(connectionForm.allowedChatRefs);
  const isApplicationPending = runState === "pending_review";
  const isApplicationApproved = runState === "approved";
  const isCanceling = runState === "canceling";
  const isBusy = runState === "running" || isCanceling;
  const isConnectionPage = activePage === "connection" && isApplicationApproved;
  const isConnectionComplete = connection?.status === "connected";
  const currentApplication = result?.application || result?.applyData?.application || null;
  const pendingRequestId = result?.requestId || currentApplication?.capabilityRequestId || currentApplication?.sourceRequestId || currentApplication?.id || "";
  const canCancel = (isApplicationPending || isApplicationApproved) && !isConnectionComplete && Boolean(pendingRequestId) && !isCanceling;
  const shouldShowCancel = (isApplicationPending || isApplicationApproved || isCanceling) && !isConnectionComplete && Boolean(pendingRequestId);
  const cancelButtonLabel = isCanceling ? "撤销中" : isApplicationApproved ? "撤销并重提" : "撤销申请";
  const canSubmit = form.problemSummary.trim().length > 0 && selectedChannelIntentIds.length > 0 && !isBusy && !isApplicationPending && !isApplicationApproved;
  const primaryButtonClass = [
    "feishu-application-primary",
    isApplicationPending ? "is-pending" : "",
    isApplicationApproved ? "is-approved" : "",
  ].filter(Boolean).join(" ");
  const userFields = useMemo(
    () => draft?.userRequiredFields || ["申请范围", "一句话说明", "申请群（群内测试时可选）", "材料链接（可选）"],
    [draft],
  );
  const processConfirmations = draft?.processConfirmations?.length
    ? draft.processConfirmations
    : DEFAULT_PROCESS_CONFIRMATIONS;
  const postApprovalChannelActions = draft?.postApprovalChannelActions || [];
  const canChooseDeliveryMode = draft?.applicantMode === "admin" && deliveryOptions.some((option) => option.id !== "dry_run" && option.enabled !== false);
  const connectionMode = connectionForm.connectionMode || connectionDraft?.defaultConnectionMode || "websocket";
  const isWebhookConnection = connectionMode === "webhook";
  const connectionModeOptions = connectionDraft?.connectionModeOptions?.length ? connectionDraft.connectionModeOptions : DEFAULT_CONNECTION_MODE_OPTIONS;
  const fallbackReadinessChecks = isWebhookConnection ? [
    { id: "credentials", label: "飞书应用凭证", status: "待填写", detail: "填写后自动校验。" },
    { id: "callback_url", label: "公网 HTTPS 回调", status: "待配置", detail: connectionDraft?.callbackPublicUrl || "等待填写回调地址。" },
    { id: "event_challenge", label: "飞书回调确认", status: "等待飞书确认", detail: "保存事件订阅后自动确认。" },
    { id: "message_reaction", label: "消息下方状态标记权限", status: "待验证", detail: "开通 im:message.reactions:write_only 或 im:message。" },
    { id: "message_roundtrip", label: "消息与状态标记测试", status: "待真实消息", detail: "发送一条消息验证事件和状态标记。" },
    { id: "card_feedback", label: "回答质量反馈回调", status: "待订阅", detail: "订阅 card.action.trigger。" },
  ] : [
    { id: "credentials", label: "飞书应用凭证", status: "待填写", detail: "填写 App ID / App Secret 后自动校验。" },
    { id: "long_connection", label: "长连接事件订阅", status: "待飞书确认", detail: "事件订阅选择使用长连接接收事件。" },
    { id: "message_event", label: "消息事件权限", status: "待订阅", detail: "订阅 im.message.receive_v1。" },
    { id: "message_reaction", label: "消息下方状态标记权限", status: "待验证", detail: "开通 im:message.reactions:write_only 或 im:message。" },
    { id: "message_roundtrip", label: "消息与状态标记测试", status: "待真实消息", detail: "发送一条消息验证事件和状态标记。" },
    { id: "card_feedback", label: "回答质量反馈回调", status: "待订阅", detail: "订阅 card.action.trigger。" },
  ];
  const readinessChecks = connection?.readinessChecks?.length ? connection.readinessChecks : fallbackReadinessChecks;
  const cardFeedbackCheck = readinessChecks.find((check) => check.id === "card_feedback");
  const permissionTest = permissionTestView({
    connection,
    readinessChecks,
    connectionMode,
    checkState: permissionCheckState,
  });
  const isPermissionCheckCoolingDown = permissionCheckCooldownSeconds > 0;
  const permissionTestLabel = isPermissionCheckCoolingDown ? `请稍候 ${permissionCheckCooldownSeconds}s` : permissionTest.label;
  const adminDiagnostics = connection?.adminDiagnostics || null;
  const adminDiagnosticChecks = adminDiagnostics?.checks || [];
  const defaultConnectionTests = adminDiagnostics?.defaultConnectionTests || [];
  const applicantNextStep = connection?.userNextStep || "申请人只需要关注申请和试用状态；飞书后台配置由平台处理。";
  const permissionAppId = normalizeFeishuAppId(connectionForm.appId);
  const savedPermissionLink = typeof connection?.permissionUrl === "string" ? connection.permissionUrl : "";
  const savedAppConsoleLink = typeof connection?.appConsoleUrl === "string" ? connection.appConsoleUrl : "";
  const permissionLink = permissionAppId ? feishuPermissionUrl(permissionAppId) : savedPermissionLink;
  const appConsoleLink = permissionAppId ? feishuAppConsoleUrl(permissionAppId) : savedAppConsoleLink || FEISHU_APP_CONSOLE_URL;
  const savedAppIdDisplay = connection?.appIdMasked || connection?.tokenCheck?.appIdMasked || "";
  const permissionAppDisplay = permissionAppId || savedAppIdDisplay;
  const permissionPayload = buildPermissionRequestPayload({
    appId: permissionAppId,
    appIdDisplay: permissionAppDisplay,
    permissionUrl: permissionLink,
  });
  const hasValidatedCredentials = ["validated", "skipped_for_local_test"].includes(connection?.tokenCheck?.status);
  const canReuseSavedCredentials = hasValidatedCredentials && Boolean(savedAppIdDisplay);
  const hasConnectionAppId = Boolean(connectionForm.appId.trim() || canReuseSavedCredentials);
  const hasConnectionSecret = Boolean(connectionForm.appSecret.trim() || hasValidatedCredentials);
  const hasWebhookFields = !isWebhookConnection || Boolean(
    (connectionForm.verificationToken.trim() && connectionForm.callbackPublicUrl.trim()) ||
    (connection?.connectionMode === "webhook" && connection?.callbackPublicUrl)
  );
  const canManageConnection = Boolean(connectionDraft?.canEditConnection || adminDiagnostics || draft?.applicantMode === "admin");
  const canShowConnectionForm = canManageConnection && (
    draft?.applicantMode === "admin" ||
    isApplicationPending ||
    isApplicationApproved ||
    (connection && connection.status !== "not_configured")
  );
  const canSubmitConnection = Boolean(
    hasConnectionAppId &&
    hasConnectionSecret &&
    hasWebhookFields &&
    connectionState !== "saving"
  );
  const canRunPermissionCheck = canManageConnection && !permissionTest.disabled && !isPermissionCheckCoolingDown;
  const canConfirmCardFeedback = canManageConnection && !["通过", "已人工确认"].includes(cardFeedbackCheck?.status) && connectionState !== "saving";

  useEffect(() => {
    if (!open) return undefined;
    let canceled = false;
    setActivePage("application");
    setDraftState("loading");
    fetchJson(draftEndpoint)
      .then((data) => {
        if (canceled) return;
        setDraft(data.draft || null);
        setDraftState("ready");
        const activeApplication = latestActiveApplication(data.recentApplications, { id: employeeId });
        if (activeApplication) {
          const approved = isApprovedApplication(activeApplication);
          setSteps(applicationSteps(activeApplication));
          setResult({
            requestId: activeApplication.capabilityRequestId || activeApplication.sourceRequestId || activeApplication.id,
            application: activeApplication,
            restored: true,
          });
          setRunState(approved ? "approved" : isPendingApplication(activeApplication) ? "pending_review" : "idle");
          setActivePage(approved ? "connection" : "application");
        } else {
          setActivePage("application");
        }
      })
      .catch((error) => {
        if (canceled) return;
        setDraftState("error");
        setErrorMessage(error?.message || "飞书入口草案读取失败");
      });
    return () => {
      canceled = true;
    };
  }, [draftEndpoint, employeeId, open]);

  useEffect(() => {
    if (!open) {
      setPermissionCheckCooldownSeconds(0);
      return undefined;
    }
    if (permissionCheckCooldownSeconds <= 0) return undefined;
    const timer = setTimeout(() => {
      setPermissionCheckCooldownSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [open, permissionCheckCooldownSeconds]);

  useEffect(() => {
    if (!open) return undefined;
    let canceled = false;
    setConnectionState("loading");
    fetchJson(connectionEndpoint)
      .then((data) => {
        if (canceled) return;
        const nextConnection = data.connection || null;
        const nextDraft = data.connectDraft || null;
        setConnection(nextConnection);
        setConnectionDraft(nextDraft);
        setConnectionState("ready");
        setConnectionForm((current) => ({
          ...current,
          credentialOwnerName: current.credentialOwnerName || nextConnection?.credentialOwnerName || "",
          connectionMode: nextConnection?.connectionMode || current.connectionMode || nextDraft?.defaultConnectionMode || "websocket",
          callbackPublicUrl: current.callbackPublicUrl || nextConnection?.callbackPublicUrl || nextDraft?.callbackPublicUrl || "",
          allowedChatRefs: allowedChatRefsForSubmit(current.allowedChatRefs).length
            ? current.allowedChatRefs
            : allowedChatRefsFromConnection(nextConnection || {}),
        }));
      })
      .catch((error) => {
        if (canceled) return;
        setConnectionState("error");
        setConnectionMessage(error?.message || "飞书联通状态读取失败");
      });
    return () => {
      canceled = true;
    };
  }, [connectionEndpoint, open]);

  useEffect(() => {
    if (!scopeOptions.length) return;
    setForm((current) => {
      const nextScope = scopeOptions.find((scope) => optionValue(scope) === current.requestScope) || scopeOptions[0];
      const allowedChannelIntentIds = new Set(channelIntentOptions.map((option) => option.id));
      const currentChannelIntentIds = uniqueList(current.channelIntentIds || [current.channelIntent]);
      const nextChannelIntentIds = currentChannelIntentIds.filter((intentId) => allowedChannelIntentIds.has(intentId));
      const enabledDeliveryOptions = deliveryOptions.filter((option) => option.enabled !== false);
      const nextDeliveryMode = enabledDeliveryOptions.some((option) => option.id === current.deliveryMode)
        ? current.deliveryMode
        : enabledDeliveryOptions[0]?.id || "dry_run";
      return {
        ...current,
        requestScope: optionValue(nextScope),
        requestScopeType: nextScope?.requestScopeType || nextScope?.id || "personal",
        channelIntentIds: nextChannelIntentIds.length ? nextChannelIntentIds : [channelIntentOptions[0]?.id || "personal_chat"],
        deliveryMode: nextDeliveryMode,
      };
    });
  }, [channelIntentOptions, deliveryOptions, scopeOptions]);

  if (!open) return null;

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateConnectionForm(key, value) {
    setConnectionForm((current) => ({ ...current, [key]: value }));
  }

  function updateAllowedChatRef(clientId, key, value) {
    setConnectionForm((current) => ({
      ...current,
      allowedChatRefs: (current.allowedChatRefs || []).map((row) =>
        row.clientId === clientId ? { ...row, [key]: value } : row
      ),
    }));
  }

  function addAllowedChatRef(type) {
    setConnectionForm((current) => {
      const rows = Array.isArray(current.allowedChatRefs) ? current.allowedChatRefs : [];
      return {
        ...current,
        allowedChatRefs: [...rows, createChatRefRow(type, {}, rows.length + 1)],
      };
    });
  }

  function removeAllowedChatRef(clientId) {
    setConnectionForm((current) => ({
      ...current,
      allowedChatRefs: (current.allowedChatRefs || []).filter((row) => row.clientId !== clientId),
    }));
  }

  async function copyPermissionPayload() {
    if (!navigator.clipboard?.writeText) {
      setPermissionCopyState("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(permissionPayload);
      setPermissionCopyState("copied");
      window.setTimeout(() => setPermissionCopyState("idle"), 1800);
    } catch {
      setPermissionCopyState("error");
    }
  }

  function chooseScope(value) {
    const scope = scopeOptions.find((item) => optionValue(item) === value) || scopeOptions[0];
    setForm((current) => ({
      ...current,
      requestScope: optionValue(scope),
      requestScopeType: scope?.requestScopeType || scope?.id || "personal",
    }));
  }

  function toggleChannelIntent(intentId) {
    setForm((current) => {
      const currentIds = uniqueList(current.channelIntentIds || [current.channelIntent]);
      const exists = currentIds.includes(intentId);
      const nextIds = exists ? currentIds.filter((id) => id !== intentId) : [...currentIds, intentId];
      return { ...current, channelIntentIds: nextIds.length ? nextIds : currentIds };
    });
  }

  function chooseDeliveryMode(value) {
    const option = deliveryOptions.find((item) => item.id === value && item.enabled !== false) || deliveryOptions.find((item) => item.enabled !== false) || deliveryOptions[0];
    setForm((current) => ({ ...current, deliveryMode: option?.id || "dry_run" }));
  }

  function updateStep(stepId, patch) {
    setSteps((current) =>
      current.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
    );
  }

  function resetFlow() {
    setSteps(createSteps());
    setResult(null);
    setDraft(null);
    setErrorMessage("");
    setActivePage("application");
  }

  async function runApplication() {
    if (!canSubmit) return;
    resetFlow();
    setRunState("running");

    let activeStep = "draft";
    try {
      let startedAt = performance.now();
      updateStep("draft", { status: "running", detail: "正在生成飞书入口草案。" });
      const draftData = await fetchJson(draftEndpoint);
      const accessDraft = draftData.draft || {};
      setDraft(accessDraft);
      updateStep("draft", {
        status: "done",
        detail: `已准备 ${accessDraft.userRequiredFields?.length || 3} 个用户字段和 ${accessDraft.readinessChecks?.length || 0} 项门禁检查。`,
        meta: accessDraft.privacyBoundary || "安全摘要边界已确认。",
        elapsed: elapsedSeconds(startedAt),
      });

      const payload = {
        problemSummary: form.problemSummary,
        sceneType: "飞书入口申请",
        requestScope: form.requestScope,
        requestScopeType: form.requestScopeType,
        channelIntent: selectedChannelIntentIds[0],
        channelIntentIds: selectedChannelIntentIds,
        requestedGroupNames: requestsGroupAccess ? form.requestedGroupNames : "",
        evidenceRefs: form.evidenceRef ? [form.evidenceRef] : [],
        expectedOutput: form.expectedOutput,
        writebackIntent: form.writebackIntent,
      };

      activeStep = "review";
      startedAt = performance.now();
      updateStep("review", { status: "running", detail: "正在提交飞书待审申请。" });
      const applyData = await fetchJson(applyEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const requestId = applyData.capabilityRequest?.id || applyData.application?.capabilityRequestId || applyData.application?.id || "";
      updateStep("review", {
        status: "done",
        detail: requestId ? `${requestId} 已进入平台待审队列。` : "飞书入口申请已进入平台待审队列。",
        meta: applyData.nextGate || "这一步不是自动审批；管理员和研发负责人会在治理队列里确认。",
        elapsed: elapsedSeconds(startedAt),
      });

      activeStep = "message";
      startedAt = performance.now();
      updateStep("message", { status: "running", detail: "正在生成申请回执。" });
      const messageData = await fetchJson(messageTestEndpoint, {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          requestId,
          deliveryMode: form.deliveryMode,
        }),
      });
      updateStep("message", {
        status: "done",
        detail: messageData.delivery?.mode === "webhook"
          ? messageData.delivery?.sent
            ? "已向运维群发送测试消息。"
            : "申请回执已生成，未真实发送。"
          : messageData.messageTest?.status === "blocked"
            ? "申请回执已生成；该动作不在自动处理范围内。"
            : "申请回执已生成。",
        meta: messageData.invocationCheck?.nextGate || messageData.delivery?.note || "未请求真实发送。",
        elapsed: elapsedSeconds(startedAt),
      });

      updateStep("connect", {
        status: "waiting",
        detail: "当前弹窗只提交申请；审批通过后由平台继续开通。",
        meta: "App ID/App Secret 只由平台治理角色录入到服务端 Secret 管理；申请人只看申请和真实消息测试状态。",
        elapsed: "",
      });
      setResult({ requestId, applyData, messageData });
      setRunState("pending_review");
      setActivePage("application");
    } catch (error) {
      updateStep(activeStep, {
        status: "failed",
        detail: error?.message || "飞书申请流程失败。",
        meta: "请检查登录会话、后端服务或输入内容是否包含敏感字段。",
      });
      setErrorMessage(error?.message || "飞书申请流程失败");
      setRunState("error");
    }
  }

  async function cancelApplication() {
    if (!canCancel) return;
    const confirmed = window.confirm(isApplicationApproved
      ? "撤销当前已通过的飞书申请并退出联通配置？撤销后可以重新提交测试申请。"
      : "撤销当前飞书申请？撤销后可以重新提交测试申请。");
    if (!confirmed) return;
    setRunState("canceling");
    setErrorMessage("");
    try {
      const cancelData = await fetchJson(cancelEndpoint, {
        method: "POST",
        body: JSON.stringify({
          applicationId: currentApplication?.id,
          capabilityRequestId: currentApplication?.capabilityRequestId || pendingRequestId,
          reason: "申请人主动撤销",
        }),
      });
      setSteps(createSteps());
      setResult({
        requestId: cancelData.application?.capabilityRequestId || pendingRequestId,
        application: cancelData.application,
        cancelData,
      });
      setRunState("idle");
      setActivePage("application");
    } catch (error) {
      setErrorMessage(error?.message || "撤销申请失败");
      setRunState("pending_review");
    }
  }

  async function submitConnection() {
    if (!canSubmitConnection) return;
    setConnectionState("saving");
    setConnectionMessage("");
    try {
      const allowedChatRefs = allowedChatRefsForSubmit(connectionForm.allowedChatRefs);
      const appIdPatch = connectionForm.appId.trim();
      const appSecretPatch = connectionForm.appSecret.trim();
      const data = await fetchJson(connectEndpoint, {
        method: "POST",
        body: JSON.stringify({
          ...connectionForm,
          appId: appIdPatch || undefined,
          appSecret: appSecretPatch || undefined,
          reuseSavedCredentials: !appIdPatch && !appSecretPatch && canReuseSavedCredentials,
          applicationId: currentApplication?.id || result?.application?.id || result?.applyData?.application?.id,
          capabilityRequestId: pendingRequestId,
          allowedChatRefs,
          allowedChatNames: allowedChatRefs.map((item) => item.name).filter(Boolean),
          channelIntentIds: selectedChannelIntentIds,
        }),
      });
      setConnection(data.connection || null);
      setConnectionState("ready");
      setPermissionCheckState("idle");
      setConnectionMessage(data.nextGate || "联通资料已保存并完成自动检查。");
      const nextConnection = data.connection || {};
      setConnectionForm((current) => ({
        ...current,
        credentialOwnerName: nextConnection.credentialOwnerName || current.credentialOwnerName,
        connectionMode: nextConnection.connectionMode || current.connectionMode,
        callbackPublicUrl: nextConnection.callbackPublicUrl || current.callbackPublicUrl,
        allowedChatRefs: allowedChatRefsFromConnection(nextConnection),
        appId: "",
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
      }));
    } catch (error) {
      setConnectionState("error");
      setConnectionMessage(error?.message || "飞书联通配置失败");
    }
  }

  async function runPermissionCheck() {
    if (!canRunPermissionCheck) {
      if (isPermissionCheckCoolingDown) {
        setConnectionMessage(`刚刚已经触发过检查，请 ${permissionCheckCooldownSeconds} 秒后再试。`);
      }
      return;
    }
    setPermissionCheckState("checking");
    setPermissionCheckCooldownSeconds(PERMISSION_CHECK_COOLDOWN_SECONDS);
    setConnectionMessage("");
    try {
      const data = await fetchJson(connectionTestEndpoint, {
        method: "POST",
        body: JSON.stringify({
          applicationId: currentApplication?.id || result?.application?.id || result?.applyData?.application?.id,
          capabilityRequestId: pendingRequestId,
        }),
      });
      const nextConnection = data.connection || null;
      setConnection(nextConnection);
      setConnectionDraft(data.connectDraft || connectionDraft);
      setConnectionState("ready");
      setPermissionCheckState(nextConnection?.status === "connected" ? "passed" : "checked");
      setPermissionCheckCooldownSeconds(
        nextConnection?.status === "connected"
          ? 0
          : Math.max(Number(data.testResult?.retryAfterSeconds) || 0, PERMISSION_CHECK_COOLDOWN_SECONDS),
      );
      setConnectionMessage(connectionTestMessage({
        connection: nextConnection,
        testResult: data.testResult,
        fallback: data.nextGate,
      }));
    } catch (error) {
      setPermissionCheckState("error");
      setConnectionState("error");
      setConnectionMessage(error?.message || "飞书测试结果检查失败");
    }
  }

  async function confirmCardFeedbackSubscription() {
    if (!canConfirmCardFeedback) return;
    setConnectionState("saving");
    setConnectionMessage("");
    try {
      const data = await fetchJson(eventSubscriptionEndpoint, {
        method: "POST",
        body: JSON.stringify({
          applicationId: currentApplication?.id || result?.application?.id || result?.applyData?.application?.id,
          capabilityRequestId: pendingRequestId,
          confirmedItems: ["card_action"],
        }),
      });
      setConnection(data.connection || connection);
      setConnectionState("ready");
      setConnectionMessage("已确认回答质量反馈回调；后续成功答复会显示质量 OK / 存在问题。");
    } catch (error) {
      setConnectionState("error");
      setConnectionMessage(error?.message || "回答质量反馈回调确认失败");
    }
  }

  return (
    <div className="feishu-application-backdrop" role="presentation">
      <section className="feishu-application-modal" role="dialog" aria-modal="true" aria-labelledby="feishu-application-title">
        <div className="feishu-application-head">
          <span className="feishu-application-icon">
            {isConnectionPage ? <KeyRound size={20} /> : <RadioTower size={20} />}
          </span>
          <span>
            <strong id="feishu-application-title">{isConnectionPage ? "飞书联通配置" : "申请接入飞书"}</strong>
            <small>
              {employee.name} · {isConnectionPage
                ? "申请已审核通过，继续完成凭证、事件订阅和真实消息测试"
                : draft?.scopePolicy || "企业身份发起申请，管理员完成飞书连接"}
            </small>
          </span>
          <button className="feishu-application-close" type="button" aria-label="关闭飞书申请窗口" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {isConnectionPage ? (
          <div className="feishu-stage-banner">
            <span>
              <Check size={16} />
              <strong>申请已审核通过</strong>
              <small>{pendingRequestId ? `${pendingRequestId} 已进入联通配置阶段。` : "当前申请已进入联通配置阶段。"}</small>
            </span>
            <button type="button" onClick={() => setActivePage("application")}>
              查看申请摘要
            </button>
          </div>
        ) : (
          <>
        <div className="feishu-application-summary">
          <span>
            <ShieldCheck size={16} />
            <strong>申请信息摘要</strong>
            <small>
              {draftState === "loading"
                ? "正在读取平台草案"
                : draft?.applicantMode === "admin"
                  ? "将以管理员治理身份提交"
                  : "将以当前企业身份提交"}
            </small>
          </span>
          <span>
            <strong>需要填写</strong>
            <small>{userFields.join(" / ")}</small>
          </span>
        </div>

        <div className="feishu-application-flow-grid">
          {processConfirmations.map((flow) => (
            <article key={flow.id}>
              <strong>{flow.title}</strong>
              <small>{(flow.steps || []).join(" -> ")}</small>
            </article>
          ))}
        </div>

        {postApprovalChannelActions.length ? (
          <div className="feishu-application-deferred">
            <span>
              <strong>审批通过后由谁开通</strong>
              <small>申请人只提交希望开通的群；管理员审核后再配置真实白名单和状态标记策略。</small>
            </span>
            <div>
              {postApprovalChannelActions.map((action) => (
                <b key={action}>{action}</b>
              ))}
            </div>
          </div>
        ) : null}

        <div className="feishu-application-form">
          <label className="feishu-application-field feishu-application-field-wide">
            <span>一句话说明</span>
            <textarea
              rows={3}
              value={form.problemSummary}
              onChange={(event) => updateForm("problemSummary", event.target.value)}
            />
          </label>
          <label className="feishu-application-field">
            <span>申请范围</span>
            <select value={form.requestScope} onChange={(event) => chooseScope(event.target.value)}>
              {scopeOptions.map((scope) => (
                <option value={optionValue(scope)} key={scope.id || optionValue(scope)}>{scope.label || optionValue(scope)}</option>
              ))}
            </select>
            {selectedScope?.note ? <small>{selectedScope.note}</small> : null}
          </label>
          <div className="feishu-application-field" role="group" aria-label="对话场景">
            <span>对话场景</span>
            <div className="feishu-channel-intent-options">
              {channelIntentOptions.map((option) => (
                <button
                  className={selectedChannelIntentIds.includes(option.id) ? "is-selected" : ""}
                  type="button"
                  aria-pressed={selectedChannelIntentIds.includes(option.id)}
                  key={option.id}
                  onClick={() => toggleChannelIntent(option.id)}
                >
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            {selectedChannelIntents.length ? (
              <small>{selectedChannelIntents.map((option) => option.description).filter(Boolean).join(" · ")}</small>
            ) : null}
          </div>
          {canChooseDeliveryMode ? (
            <label className="feishu-application-field">
              <span>是否发飞书通知</span>
              <select value={form.deliveryMode} onChange={(event) => chooseDeliveryMode(event.target.value)}>
                {deliveryOptions.map((option) => (
                  <option value={option.id} key={option.id} disabled={option.enabled === false}>
                    {deliveryOptionLabel(option)}{option.enabled === false ? "（需管理员）" : ""}
                  </option>
                ))}
              </select>
              {selectedDeliveryOption ? <small>{deliveryOptionNote(selectedDeliveryOption)}</small> : null}
            </label>
          ) : null}
          {requestsGroupAccess ? (
            <label className="feishu-application-field">
              <span>希望开通的飞书群（可选）</span>
              <input
                value={form.requestedGroupNames}
                placeholder="如：算法运维群、现场问题群"
                onChange={(event) => updateForm("requestedGroupNames", event.target.value)}
              />
              <small>这里只作为申请材料；审批通过后由管理员配置真实白名单。</small>
            </label>
          ) : null}
          <label className="feishu-application-field">
            <span>材料链接 / evidenceRef（可选）</span>
            <input
              value={form.evidenceRef}
              placeholder="可选，仅填安全引用"
              onChange={(event) => updateForm("evidenceRef", event.target.value)}
            />
          </label>
          <button
            className="feishu-application-toggle"
            type="button"
            aria-pressed={form.writebackIntent}
            onClick={() => updateForm("writebackIntent", !form.writebackIntent)}
          >
            <span>
              需要远程执行/写回审批
              <small>改状态、提交代码、生产接口或客户承诺需额外审批</small>
            </span>
            <span className={form.writebackIntent ? "channel-setting-switch is-on" : "channel-setting-switch"} aria-hidden="true">
              <i />
            </span>
          </button>
        </div>

        <div className="feishu-application-step-list" aria-live="polite">
          {steps.map((step) => (
            <article className={`feishu-application-step is-${step.status}`} key={step.id}>
              <span className="feishu-application-step-dot">
                <StepIcon status={step.status} />
              </span>
              <span>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
                {step.meta ? <em>{step.meta}</em> : null}
              </span>
              {step.elapsed ? <b>{step.elapsed}</b> : null}
            </article>
          ))}
        </div>
          </>
        )}

        {isConnectionPage ? (
        <div className="feishu-connection-panel">
          <div className="feishu-connection-head">
            <span>
              <KeyRound size={16} />
              <strong>联通资料</strong>
              <small>
                {connection?.nextGate || connectionDraft?.privacyBoundary || "申请通过后填写必要连接信息，系统自动校验和保存。"}
              </small>
            </span>
            <b className={connection?.status === "connected" || connection?.status === "callback_verified" ? "status-pill good" : "status-pill muted"}>
              {connectionStatusLabel(connection?.status)}
            </b>
          </div>
          <div className="feishu-connection-checks">
            {readinessChecks.map((check) => (
              <span key={check.id}>
                <strong>{check.label}</strong>
                <em className={`status-pill ${readinessTone(check.status)}`}>{check.status}</em>
              </span>
            ))}
          </div>
          <div className="feishu-applicant-next-step">
            <span>
              <ShieldCheck size={15} />
              <strong>申请人看到的状态</strong>
            </span>
            <small>{applicantNextStep}</small>
          </div>
          {adminDiagnostics ? (
            <div className="feishu-admin-diagnostics">
              <div className="feishu-admin-diagnostics-head">
                <span>
                  <KeyRound size={15} />
                  <strong>管理员联通自检</strong>
                </span>
                <small>{connection?.adminNextStep || adminDiagnostics.summary}</small>
              </div>
              <div className="feishu-admin-diagnostic-grid">
                {adminDiagnosticChecks.map((check) => (
                  <span key={check.id}>
                    <strong>{check.label}</strong>
                    <em className={`status-pill ${readinessTone(check.status)}`}>{check.status}</em>
                    <small>{check.detail}</small>
                  </span>
                ))}
              </div>
              {defaultConnectionTests.length ? (
                <div className="feishu-admin-connection-tests">
                  <strong>长连接机器人自检顺序</strong>
                  <div>
                    {defaultConnectionTests.map((item) => (
                      <span key={item.id}>
                        <b>{item.label}</b>
                        <code>{item.command}</code>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {canConfirmCardFeedback ? (
                <button className="ghost-action" type="button" onClick={confirmCardFeedbackSubscription}>
                  <Check size={14} />
                  确认回答质量反馈回调
                </button>
              ) : null}
            </div>
          ) : null}
          {canManageConnection ? (
            <div className="feishu-permission-assistant">
              <div className="feishu-permission-assistant-head">
                <span>
                  <ShieldCheck size={15} />
                  <strong>飞书权限申请助手</strong>
                  <small>
                    {permissionLink
                      ? `已按${permissionAppId ? "当前" : "已保存"} App ID${permissionAppDisplay ? `（${permissionAppDisplay}）` : ""}和所需 scope 生成直达权限页入口；管理员仍需在飞书开放平台提交发布/审核。`
                      : "申请审核通过不等于已保存飞书凭证；需要先保存并校验以 cli_ 开头的 App ID。"}
                  </small>
                </span>
                <div>
                  {permissionLink ? (
                    <a href={permissionLink} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} />
                      打开权限申请页
                    </a>
                  ) : (
                    <span className="feishu-permission-disabled-action" aria-disabled="true">
                      <ExternalLink size={14} />
                      等待 App ID
                    </span>
                  )}
                  <a href={appConsoleLink} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    应用后台
                  </a>
                  <button type="button" onClick={copyPermissionPayload}>
                    <Copy size={14} />
                    {permissionCopyState === "copied" ? "已复制" : "复制清单"}
                  </button>
                  <button
                    className={`feishu-permission-test-pill is-${permissionTest.tone}${isPermissionCheckCoolingDown ? " is-cooling" : ""}`}
                    type="button"
                    onClick={runPermissionCheck}
                    disabled={!canRunPermissionCheck}
                    title={isPermissionCheckCoolingDown
                      ? `刚刚已经触发过检查，请 ${permissionCheckCooldownSeconds} 秒后再点。`
                      : "检查服务端是否已经收到真实飞书消息并完成消息下方状态标记；通过后会变成绿色。"}
                  >
                    {isPermissionCheckCoolingDown ? <Clock3 size={14} /> : null}
                    {!isPermissionCheckCoolingDown && permissionTest.icon === "loading" ? <Loader2 size={14} className="feishu-application-spin" /> : null}
                    {!isPermissionCheckCoolingDown && permissionTest.icon === "check" ? <Check size={14} /> : null}
                    {!isPermissionCheckCoolingDown && permissionTest.icon === "alert" ? <AlertTriangle size={14} /> : null}
                    {!isPermissionCheckCoolingDown && permissionTest.icon === "shield" ? <ShieldCheck size={14} /> : null}
                    {permissionTestLabel}
                  </button>
                </div>
              </div>
              <ul className="feishu-permission-scope-list" aria-label="飞书机器人所需权限 scope">
                {FEISHU_BOT_PERMISSION_SCOPES.map((scope) => (
                  <li key={scope.id}>
                    <code>{scope.id}</code>
                    <strong>{scope.label}</strong>
                    <small>{scope.reason}</small>
                  </li>
                ))}
              </ul>
              <p>
                事件订阅需要启用 <code>im.message.receive_v1</code> 和 <code>card.action.trigger</code>，并在应用发布通过后把机器人安装到测试单聊或群。测试时在飞书单聊机器人，或在测试群 @机器人 发送一条测试消息；服务端收到并在原消息下方挂上状态标记后这里会变为绿色已通过。回答后的质量 OK / 存在问题反馈会单独记录。权限清单只复制 scope 和操作项，不包含 App Secret、token 或消息原文。
                <a href={FEISHU_SCOPE_DOC_URL} target="_blank" rel="noreferrer">权限说明</a>
                <a href={FEISHU_REVIEW_DOC_URL} target="_blank" rel="noreferrer">发布审核</a>
              </p>
              {permissionCopyState === "error" ? <small className="feishu-permission-copy-error">当前浏览器不允许自动复制，请手动复制上方 scope 清单。</small> : null}
            </div>
          ) : null}
          {canShowConnectionForm ? (
            <div className="feishu-connection-form">
              <label>
                <FieldLabel help={CONNECTION_FIELD_HELP.credentialOwnerType}>凭证责任人</FieldLabel>
                <select value={connectionForm.credentialOwnerType} onChange={(event) => updateConnectionForm("credentialOwnerType", event.target.value)}>
                  {(connectionDraft?.credentialOwnerOptions || [
                    { id: "platform_admin", label: "平台管理员/运维" },
                    { id: "business_owner", label: "业务 Owner" },
                    { id: "applicant", label: "申请人本人" },
                  ]).map((option) => (
                    <option value={option.id} key={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help={CONNECTION_FIELD_HELP.credentialOwnerName}>责任人姓名</FieldLabel>
                <input
                  value={connectionForm.credentialOwnerName}
                  placeholder="默认当前操作人"
                  onChange={(event) => updateConnectionForm("credentialOwnerName", event.target.value)}
                />
              </label>
              <div className="feishu-connection-mode-field feishu-connection-full">
                <FieldLabel help={CONNECTION_FIELD_HELP.connectionMode}>连接方式</FieldLabel>
                <div className="feishu-connection-mode-options" role="radiogroup" aria-label="飞书连接方式">
                  {connectionModeOptions.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className={option.id === connectionMode ? "is-active" : ""}
                      onClick={() => updateConnectionForm("connectionMode", option.id)}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.description}</span>
                    </button>
                  ))}
                </div>
              </div>
              <label>
                <FieldLabel help={CONNECTION_FIELD_HELP.appId}>
                  {canReuseSavedCredentials ? "更换飞书 App ID（可选）" : "飞书 App ID"}
                </FieldLabel>
                <input
                  value={connectionForm.appId}
                  placeholder={canReuseSavedCredentials ? `${savedAppIdDisplay}（留空复用）` : "cli_xxx"}
                  onChange={(event) => updateConnectionForm("appId", event.target.value)}
                />
              </label>
              <label>
                <FieldLabel help={CONNECTION_FIELD_HELP.appSecret}>
                  {canReuseSavedCredentials ? "更换 App Secret（可选）" : "飞书 App Secret"}
                </FieldLabel>
                <input
                  value={connectionForm.appSecret}
                  type="password"
                  placeholder={canReuseSavedCredentials ? "已保存，留空复用；重新填写会覆盖" : "只提交到服务端加密保存"}
                  onChange={(event) => updateConnectionForm("appSecret", event.target.value)}
                />
              </label>
              {canReuseSavedCredentials ? (
                <p className="feishu-saved-credential-note feishu-connection-full">
                  已保存飞书应用 {savedAppIdDisplay} 的服务端凭证；本次只改测试对象或白名单时无需再输入 App ID / App Secret。
                </p>
              ) : null}
              {isWebhookConnection ? (
                <>
                  <label>
                    <FieldLabel help={CONNECTION_FIELD_HELP.verificationToken}>事件 Token</FieldLabel>
                    <input
                      value={connectionForm.verificationToken}
                      type="password"
                      placeholder="飞书事件订阅 Verification Token"
                      onChange={(event) => updateConnectionForm("verificationToken", event.target.value)}
                    />
                  </label>
                  <label>
                    <FieldLabel help={CONNECTION_FIELD_HELP.encryptKey}>Encrypt Key（可选）</FieldLabel>
                    <input
                      value={connectionForm.encryptKey}
                      type="password"
                      placeholder="启用加密事件时填写"
                      onChange={(event) => updateConnectionForm("encryptKey", event.target.value)}
                    />
                  </label>
                  <label className="feishu-connection-wide">
                    <FieldLabel help={CONNECTION_FIELD_HELP.callbackPublicUrl}>公网 HTTPS 回调地址</FieldLabel>
                    <input
                      value={connectionForm.callbackPublicUrl}
                      placeholder={connectionDraft?.callbackPublicUrl || `https://your-domain/api/feishu/events/${encodeURIComponent(employeeId)}`}
                      onChange={(event) => updateConnectionForm("callbackPublicUrl", event.target.value)}
                    />
                    <small>本机 LAN 地址只能页面联调；飞书云端需要可访问的 HTTPS 地址。</small>
                  </label>
                </>
              ) : (
                <p className="feishu-connection-mode-note feishu-connection-full">
                  飞书机器人长连接不需要 Verification Token、Encrypt Key 或公网 HTTPS 回调地址；请在飞书开放平台事件订阅选择“使用长连接接收事件”，并订阅 im.message.receive_v1 与 card.action.trigger。
                </p>
              )}
              <div className="feishu-chat-ref-editor feishu-connection-full">
                <FieldLabel help={CONNECTION_FIELD_HELP.allowedChatNames}>允许测试对象</FieldLabel>
                <div className="feishu-chat-ref-groups">
                  {CHAT_REF_GROUPS.map((group) => {
                    const rows = allowedChatRows.filter((row) => row.type === group.type);
                    return (
                      <section className="feishu-chat-ref-group" key={group.type}>
                        <div className="feishu-chat-ref-group-head">
                          <strong>{group.label}</strong>
                          <button type="button" onClick={() => addAllowedChatRef(group.type)}>
                            <Plus size={14} />
                            新增
                          </button>
                        </div>
                        {rows.length ? rows.map((row) => (
                          <div className="feishu-chat-ref-row" key={row.clientId}>
                            <input
                              value={row.name}
                              aria-label={`${group.label}名称`}
                              placeholder={group.namePlaceholder}
                              onChange={(event) => updateAllowedChatRef(row.clientId, "name", event.target.value)}
                            />
                            <input
                              value={row.feishuId}
                              aria-label={`${group.label}飞书 ID`}
                              placeholder={row.feishuIdMasked || group.idPlaceholder}
                              onChange={(event) => updateAllowedChatRef(row.clientId, "feishuId", event.target.value)}
                            />
                            <button type="button" aria-label={`删除${group.label}测试对象`} onClick={() => removeAllowedChatRef(row.clientId)}>
                              <X size={14} />
                            </button>
                          </div>
                        )) : (
                          <button className="feishu-chat-ref-empty" type="button" onClick={() => addAllowedChatRef(group.type)}>
                            <Plus size={14} />
                            新增{group.label}
                          </button>
                        )}
                      </section>
                    );
                  })}
                </div>
                <small>名称用于展示和审计；ID 用于自动白名单、单聊/群聊路由和后续消息测试。</small>
              </div>
              <button className="feishu-connection-submit" type="button" onClick={submitConnection} disabled={!canSubmitConnection}>
                {connectionState === "saving" ? <Loader2 size={14} className="feishu-application-spin" /> : <Check size={14} />}
                {canReuseSavedCredentials && !connectionForm.appId.trim() && !connectionForm.appSecret.trim()
                  ? "保存测试对象并检查"
                  : "保存并自动检查"}
              </button>
            </div>
          ) : (
            <p className="feishu-connection-empty">
              {canManageConnection
                ? "先提交申请。申请进入待审后，凭证责任人可在这里补齐 App ID 和 App Secret；公网回调与 Token 只在 HTTPS 回调高级模式下填写。"
                : "你不需要填写 App ID、App Secret 或事件订阅配置；平台管理员会完成凭证、长连接 worker、测试对象和真实消息回环。"}
            </p>
          )}
          {connectionMessage ? <p className={connectionState === "error" ? "feishu-application-error" : "feishu-connection-message"}>{connectionMessage}</p> : null}
        </div>
        ) : null}

        {!isConnectionPage && result ? (
          <div className={isApplicationPending ? "feishu-application-result is-pending" : isApplicationApproved ? "feishu-application-result is-approved" : "feishu-application-result"}>
            <a className="feishu-application-result-link" href={capabilityRequestReviewHash(result.requestId)} onClick={onClose}>
              <span>{result.requestId || "飞书申请已提交"}</span>
              <ExternalLink size={14} />
            </a>
            <small>
              {result.cancelData
                ? "申请已撤销；可以重新提交测试申请。"
                : isApplicationApproved
                ? "已通过平台审核；请进入联通配置继续开通。"
                : isApplicationPending
                ? "已进入平台待审队列；关闭窗口不会取消申请。"
                : result.messageData?.message?.title || result.applyData?.nextGate || "消息测试完成"}
            </small>
          </div>
        ) : null}
        {errorMessage ? <p className="feishu-application-error">{errorMessage}</p> : null}

        <div className="feishu-application-footer">
          <button className="ghost-action" type="button" onClick={onClose}>关闭</button>
          {shouldShowCancel ? (
            <button className="feishu-application-cancel" type="button" onClick={cancelApplication} disabled={!canCancel}>
              {isCanceling ? <Loader2 size={15} className="feishu-application-spin" /> : <X size={15} />}
              {cancelButtonLabel}
            </button>
          ) : null}
          {!isConnectionPage ? (
            <button
              className={primaryButtonClass}
              type="button"
              onClick={isApplicationApproved ? () => setActivePage("connection") : runApplication}
              disabled={isApplicationApproved ? false : !canSubmit}
            >
              {isBusy ? <Loader2 size={15} className="feishu-application-spin" /> : isApplicationPending ? <Clock3 size={15} /> : isApplicationApproved ? <Check size={15} /> : <Send size={15} />}
              {runState === "running" ? "申请中" : isCanceling ? "处理中" : isApplicationPending ? "申请中" : isApplicationApproved ? "进入联通配置" : "开始申请"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
