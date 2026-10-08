import crypto from "node:crypto";
import {
  CONTRACT_VERSION,
  FEISHU_EVENT_CALLBACK_PATH,
  RUNTIME_TASK_CONTRACT_VERSION,
  SOURCE_SYSTEM_ID,
  cleanShortText,
  cleanText,
  decryptFeishuEventPayload,
  digestValue,
  maskIdentifier,
} from "../../feishu-integration-support.mjs";
import {
  cardFeedbackSubscriptionReady,
  cardFeedbackToast,
  findDuplicateCardFeedback,
  parseFeishuCardFeedback,
} from "./card-feedback.mjs";
import {
  assembleRuntimeTurnContext,
  findRecentSessionReferences,
} from "../../agent-runtime/context-assembler.mjs";
import {
  prepareRuntimeContextSource,
  recordRuntimeConversationInput,
  recordRuntimeConversationTurn,
  readRuntimeConversationResult,
  submitRuntimeToolParameterContinuation,
} from "../../agent-runtime/runtime-context-session.mjs";
import { createRuntimeTaskExecutionInputResolver } from "../../agent-runtime/runtime-task-execution-input-resolver.mjs";
import { operationReceiptContextForExecutionOwnership } from "../../agent-runtime/operation-receipt-context.mjs";
import {
  PREDECESSOR_TASK_INPUT_ADAPTER_ID,
  createPredecessorTaskMaterialBindingDescriptor,
} from "../../agent-runtime/task-material-binding.mjs";
import { createTaskWorkspaceManager } from "../../agent-runtime/task-workspace-manager.mjs";
import { resolveSkillRuntimeProjection } from "../../agent-runtime/skill-runtime-projection.mjs";
import { createFeishuMaterialToolExecutor } from "./material-tool-executor.mjs";
import {
  FEISHU_MATERIAL_BINDING_ADAPTER_ID,
  createFeishuMaterialBindingDescriptor,
  feishuResourcesFromTaskMaterialBinding,
} from "./persistent-material-binding.mjs";
import { describeAgentRuntimeFailure } from "./algorithm-agent-runtime.mjs";
import { createFeishuConversationTurnCoordinator } from "./conversation-turn-coordinator.mjs";
import { createInboundTurnCoalescer } from "./inbound-turn-coalescer.mjs";
import { createFeishuBotIdentityResolver } from "./bot-identity.mjs";
import { currentUserToolExecutionIdentityFromFeishuAdmission } from "./current-user-tool-identity.mjs";
import { resolveEmployeeRuntimeResourceSetup } from "./employee-runtime-resource-setup.mjs";
import { evaluateFeishuGroupIngress } from "./group-ingress-policy.mjs";
import { createFeishuOutboundDelivery } from "./outbound-delivery.mjs";
import {
  buildFeishuToolParameterProcessingCard,
  parseFeishuToolParameterAction,
  parseFeishuToolParameterSubmission,
} from "./parameter-card.mjs";
import {
  buildFeishuToolConfirmationDecisionCard,
  parseFeishuToolConfirmationAction,
} from "./tool-confirmation-card.mjs";
import {
  extractTextMessageContent,
  isFeishuGroupBroadcastMention,
  normalizeFeishuInboundTurn,
  parseFeishuSessionCommand,
} from "./inbound-turn.mjs";
import {
  extractFeishuMessageResources,
  extractMaterialRefsFromFeishuMessage,
  saveRuntimeTaskFromFeishuEvent,
} from "./runtime-intake.mjs";
import {
  claimRuntimeTaskForExecution,
  settleRuntimeTaskFromAgentTurn,
  settleRuntimeTaskFromMaterialIntake,
} from "./runtime-task-lifecycle.mjs";
import {
  archiveRuntimeTaskFeedbackIfDue,
  isRuntimeTaskFeedbackArchivePending,
  markRuntimeTaskFeedbackDelivery,
  markRuntimeTaskFeedbackReceived,
  runtimeTaskFeedbackArchiveDelay,
} from "./runtime-task-feedback.mjs";
import {
  isRuntimeTaskWaiting,
  prepareRuntimeTaskAdmission,
  runtimeQueuePolicyForEmployee,
  taskQueueFullNoticeText,
  taskTimeoutNoticeText,
} from "./task-queue-policy.mjs";

const DUPLICATE_GUARD_STATUSES = new Set([
  "pending_turn_waiting_for_intent",
  "fragment_buffered_in_pending_turn",
  "fragment_coalesced_into_turn",
  "event_processing",
  "agent_reply_ready",
  "agent_partial_ready",
  "agent_reply_sent",
  "agent_feedback_reply_sent",
  "agent_streaming_reply_completed",
  "tool_parameter_card_sent",
  "tool_confirmation_card_sent",
  "send_skipped_for_local_test",
  "agent_runtime_notice_sent",
  "task_queue_notice_sent",
  "task_queue_wait_notice_sent",
]);

function createFeishuEventGateway({
  employeeId,
  fetch = globalThis.fetch,
  nextRecordId = (prefix = "FEVT") => `${prefix}-${Date.now()}`,
  controlPlaneStore = null,
  checkpointRepository,
  createSessionRoute,
  createToolExecutor = null,
  resolveCurrentUserToolProfile = null,
  resolveEmployee = () => ({}),
  resolveRuntimeResourceSetup = resolveEmployeeRuntimeResourceSetup,
  inboundCoalescingPolicy = {},
  skillHarnessRunner = null,
  sessionRepository,
  toolParameterContinuationRepository = null,
  store,
  runtimeTaskService = null,
  persistentTaskExecution = false,
  resolveBotIdentity = null,
  turnDispatcher = null,
  validateFeishuCredentials,
  workspaceManager = null,
} = {}) {
  const targetEmployeeId = cleanShortText(employeeId);
  if (!targetEmployeeId) throw new Error("feishu event gateway requires employeeId");
  if (!store) throw new Error("feishu event gateway requires a store");
  if (typeof createSessionRoute !== "function") throw new Error("feishu event gateway requires createSessionRoute");
  if (!sessionRepository) throw new Error("feishu event gateway requires sessionRepository");
  if (!turnDispatcher || typeof turnDispatcher.prepareTurn !== "function" || typeof turnDispatcher.runTurn !== "function") {
    throw new Error("feishu event gateway requires turnDispatcher");
  }
  if (typeof validateFeishuCredentials !== "function") {
    throw new Error("feishu event gateway requires validateFeishuCredentials");
  }
  if (createToolExecutor !== null && typeof createToolExecutor !== "function") {
    throw new Error("feishu event gateway createToolExecutor must be a function");
  }
  if (resolveCurrentUserToolProfile !== null && typeof resolveCurrentUserToolProfile !== "function") {
    throw new Error("feishu event gateway resolveCurrentUserToolProfile must be a function");
  }
  const inFlightMessageDigests = new Set();
  const pendingToolParameterSubmissions = new Map();
  const pendingToolParameterCardIds = new Set();
  const issuedToolConfirmationRequests = new Map();
  const pendingToolConfirmationSubmissions = new Map();
  const pendingToolConfirmationIds = new Set();
  const initialEmployee = employeeForGateway();
  const targetEmployeeName = cleanShortText(initialEmployee.name || "数字员工");
  const connectionScope = cleanShortText(store.readConnection?.(targetEmployeeId)?.appIdDigest).slice(0, 16) || "default";
  const conversationTurnCoordinator = createFeishuConversationTurnCoordinator({
    accountId: connectionScope,
    employeeId: targetEmployeeId,
  });
  const inboundTurnCoalescer = createInboundTurnCoalescer(inboundCoalescingPolicy);
  const effectiveResolveBotIdentity = typeof resolveBotIdentity === "function"
    ? resolveBotIdentity
    : createFeishuBotIdentityResolver({
      fetch,
      readSecret: (key, candidateEmployeeId = targetEmployeeId) => store.readSecret?.(key, candidateEmployeeId),
      testBotOpenId: process.env.FEISHU_CONNECTION_SKIP_REMOTE_VALIDATION === "1"
        ? process.env.FEISHU_TEST_BOT_OPEN_ID
        : "",
      validateFeishuCredentials,
    });
  const effectiveTurnDispatcher = turnDispatcher;
  const executionInputResolver = createRuntimeTaskExecutionInputResolver({
    sessionRepository,
    resolveEmployee: async (candidateEmployeeId) => cleanShortText(candidateEmployeeId) === targetEmployeeId ? employeeForGateway() : null,
  });
  const effectiveWorkspaceManager = workspaceManager || createTaskWorkspaceManager();
  const {
    addFeishuProcessingReactionIfPossible,
    publicReaction,
    reactionCleanupPatch,
    reactionPermissionPatch,
    removeProcessingReactionAfterReply,
    sendAgentTurnReplyIfPossible,
    startAgentReplyStreamIfPossible,
  } = createFeishuOutboundDelivery({
    employeeId: targetEmployeeId,
    employeeName: targetEmployeeName,
    fetch,
    store,
    validateFeishuCredentials,
  });

  function employeeForGateway() {
    const employee = resolveEmployee(targetEmployeeId) || {};
    return cleanShortText(employee.id) === targetEmployeeId ? employee : {};
  }

  function canonicalRuntimeTaskAdmissionStore() {
    return {
      readRuntimeTasks: () => {
        try {
          return runtimeTaskService?.listTasks?.(targetEmployeeId, { includeAll: true }) || [];
        } catch {
          return [];
        }
      },
    };
  }

  async function resolveGroupIngress(messageEvent = {}) {
    const allowedChatIds = readAllowedGroupIds();
    let decision = evaluateFeishuGroupIngress({ allowedChatIds, messageEvent });
    if (decision.reason !== "bot_identity_unavailable") return decision;
    const botIdentity = await effectiveResolveBotIdentity({ employeeId: targetEmployeeId });
    return evaluateFeishuGroupIngress({
      allowedChatIds,
      botOpenId: botIdentity?.openId,
      messageEvent,
    });
  }

  function readAllowedGroupIds() {
    try {
      const references = JSON.parse(store.readSecret?.("allowedChatRefs", targetEmployeeId) || "[]");
      return (Array.isArray(references) ? references : [])
        .map((item) => cleanShortText(item?.feishuId))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function unwrapEncryptedEvent(rawInput = {}) {
    if (!rawInput?.encrypt) return { ok: true, event: rawInput || {} };
    const encryptKey = store.readSecret("encryptKey", targetEmployeeId);
    if (!encryptKey) {
      return {
        ok: false,
        error: "feishu_encrypt_key_missing",
        message: "收到加密事件，但服务端尚未配置 encrypt key。",
      };
    }
    try {
      const decrypted = decryptFeishuEventPayload(rawInput.encrypt, encryptKey);
      return { ok: true, event: JSON.parse(decrypted) };
    } catch {
      return {
        ok: false,
        error: "feishu_event_decrypt_failed",
        message: "飞书事件解密失败，请检查 encrypt key。",
      };
    }
  }

  function verifyEventToken(event = {}) {
    const expected = store.readSecret("verificationToken", targetEmployeeId);
    if (!expected) return { ok: false };
    const actual = String(event.token || event.header?.token || event.event?.token || "").trim();
    return { ok: actual === expected };
  }

  async function recordFeishuEvent({
    callbackPath = FEISHU_EVENT_CALLBACK_PATH,
    connection = store.readConnection(targetEmployeeId),
    event = {},
    receiveMode = "http_callback",
    submittedBy = { id: "feishu-event", name: "飞书事件回调", departmentId: "", role: "service" },
  } = {}) {
    const now = new Date().toISOString();
    if (event.challenge) {
      const nextConnection = store.saveConnection({
        ...connection,
        eventSubscription: {
          ...(connection.eventSubscription || {}),
          status: "challenge_verified",
          receiveMode,
          callbackPath,
          lastChallengeAt: now,
        },
        updatedAt: now,
      }, targetEmployeeId);
      return {
        ok: true,
        challenge: event.challenge,
        status: nextConnection.status,
        eventStatus: nextConnection.eventSubscription.status,
      };
    }

    const eventType = eventTypeOf(event);
    if (/card\.action\.trigger/i.test(eventType)) {
      const parameterCardResult = await recordToolParameterCardAction({ connection, event, receiveMode, submittedBy, now });
      if (parameterCardResult) return parameterCardResult;
      const confirmationCardResult = await recordToolConfirmationCardAction({ connection, event, receiveMode, submittedBy, now });
      if (confirmationCardResult) return confirmationCardResult;
      return recordCardFeedback({ connection, event, receiveMode, submittedBy, now });
    }
    if (/im\.message\.receive/i.test(eventType)) {
      const receivedMessageEvent = event.event || event || {};
      const messageId = cleanShortText(receivedMessageEvent.message?.message_id);
      const chatId = cleanShortText(receivedMessageEvent.message?.chat_id);
      const senderId = cleanShortText(
        receivedMessageEvent.sender?.sender_id?.open_id ||
        receivedMessageEvent.sender?.sender_id?.user_id ||
        receivedMessageEvent.sender?.sender_id?.union_id
      );
      const messageIdDigest = messageId ? digestValue(messageId) : "";
      const pendingToolParameterSubmission = pendingToolParameterSubmissions.get(messageId) || null;
      const pendingToolConfirmationSubmission = pendingToolConfirmationSubmissions.get(messageId) || null;
      const pendingToolConfirmation = toolConfirmationFromPendingSubmission(pendingToolConfirmationSubmission);
      const trustedToolConfirmationContinuation = Boolean(pendingToolConfirmation);
      const trustedToolContinuation = Boolean(pendingToolParameterSubmission || pendingToolConfirmationSubmission);
      const duplicateEvent = duplicateMessageEvent(messageIdDigest);
      if (duplicateEvent) return duplicateEvent;
      if (!trustedToolContinuation && isFeishuGroupBroadcastMention(receivedMessageEvent)) {
        return ignoreGroupBroadcastMention({
          eventRecordId: messageIdDigest ? `FEVT-${messageIdDigest.slice(0, 16)}` : nextRecordId("FEVT"),
          messageEvent: receivedMessageEvent,
          messageId,
          messageIdDigest,
          now,
          receiveMode,
          senderId,
          submittedBy,
        });
      }
      const groupIngress = trustedToolContinuation
        ? { action: "accept", reason: "trusted_tool_continuation" }
        : await resolveGroupIngress(receivedMessageEvent);
      if (groupIngress.action === "ignore") {
        return ignoreGroupMessage({ reason: groupIngress.reason });
      }
      const conversation = conversationTurnCoordinator.conversationForMessage(receivedMessageEvent);
      if (messageIdDigest) inFlightMessageDigests.add(messageIdDigest);
      const coalesced = await inboundTurnCoalescer.accept({
        key: conversation.sessionKey,
        fragment: {
          hasIntent: Boolean(extractTextMessageContent(receivedMessageEvent.message?.content)),
          id: messageIdDigest,
          messageEvent: receivedMessageEvent,
          messageIdDigest,
          receivedAtMs: Date.parse(now),
        },
      });
      if (coalesced.action !== "dispatch") {
        if (messageIdDigest) inFlightMessageDigests.delete(messageIdDigest);
        return recordCoalescedFragment({
          action: coalesced.action,
          eventRecordId: messageIdDigest ? `FEVT-${messageIdDigest.slice(0, 16)}` : nextRecordId("FEVT"),
          messageEvent: receivedMessageEvent,
          messageId,
          messageIdDigest,
          now,
          pendingFragmentCount: coalesced.pendingFragmentCount,
          reason: coalesced.reason,
          receiveMode,
          senderId,
          submittedBy,
        });
      }
      const batchFragments = coalesced.batch?.fragments || [];
      const messageEvent = combineMessageFragments(batchFragments);
      const sessionCommand = parseFeishuSessionCommand(messageEvent.message?.content);
      const materialMessages = batchFragments
        .map((fragment) => fragment.messageEvent?.message)
        .filter((message) => extractFeishuMessageResources(message).length > 0);
      return conversationTurnCoordinator.enqueueSessionTurn(conversation.sessionKey, async () => {
      const eventRecordId = messageIdDigest ? `FEVT-${messageIdDigest.slice(0, 16)}` : nextRecordId("FEVT");
      if (messageIdDigest && typeof store.saveMessageTest === "function") {
        store.saveMessageTest({
          id: eventRecordId,
          contractVersion: CONTRACT_VERSION,
          employeeId: targetEmployeeId,
          employeeName: targetEmployeeName,
          sourceSystemId: SOURCE_SYSTEM_ID,
          sceneType: receiveMode === "websocket_long_connection" ? "飞书长连接消息事件" : "飞书消息事件回调",
          requestScope: "飞书事件订阅",
          channelIntent: "personal_chat",
          channelIntentLabel: "可对话机器人",
          sourceMessageIdDigest: messageIdDigest,
          sourceMessageIdMasked: maskIdentifier(messageId),
          sourceChatIdMasked: maskIdentifier(chatId),
          sourceSenderIdMasked: maskIdentifier(senderId),
          status: "event_processing",
          messageContractOk: true,
          delivery: {
            mode: "feishu_ai_agent_reply",
            sent: false,
            status: "event_processing",
            messageContractOk: true,
            note: "飞书消息事件处理中，重复投递不会再次回复。",
          },
          submittedBy,
          submittedAt: now,
          updatedAt: now,
          warnings: ["AI agent 接收本次消息、加密本机会话 transcript 和安全上下文；明文不进入日志/API/UI/Git，不保存 raw prompt、模型 trace 或执行 payload。"],
        });
      }
      if (sessionCommand?.kind === "session_reset") {
        const route = createSessionRoute(conversation.routeDimensions);
        const resetReason = "manual_session_reset_command";
        const currentSession = await sessionRepository.readCurrentSession(route).catch(() => null);
        const resetResult = currentSession?.sessionId
          ? await sessionRepository.resetSession({
              route,
              reason: resetReason,
            })
          : {
              previousSession: null,
              session: await sessionRepository.openSession({ route }),
            };
        const responsePolicy = {
          id: "session-reset-command.v1",
          mode: "direct_feedback",
          allowTask: false,
          allowModel: false,
          capabilityDisclosure: "never",
        };
        const agentTurn = {
          ok: true,
          reason: resetReason,
          status: "session_reset_acknowledged",
          text: "已开启新会话。请重新发送启动指令。",
          responsePolicy,
          safeSummary: {
            employeeId: targetEmployeeId,
            runtime: "session_reset_command",
            command: sessionCommand.command,
            argumentsText: sessionCommand.argumentsText,
            previousSessionId: resetResult.previousSession?.sessionId || "",
            newSessionId: resetResult.session?.sessionId || "",
          },
        };
        const agentReply = await sendAgentTurnReplyIfPossible({
          connection,
          messageId,
          agentTurn,
          groupReplyMention: feishuGroupReplyMention(messageEvent),
        });
        const nextConnection = store.saveConnection({
          ...connection,
          eventSubscription: {
            ...(connection.eventSubscription || {}),
            status: agentReply?.sent ? "message_roundtrip_tested" : "event_received",
            receiveMode,
            callbackPath,
            lastEventAt: now,
          },
          lastEventSummary: {
            eventType: "session_reset_command",
            messageId: maskIdentifier(messageId),
            chatId: maskIdentifier(chatId),
            senderId: maskIdentifier(senderId),
            replyStatus: agentReply?.status || "session_reset_acknowledged",
            receivedAt: now,
          },
          workerBinding: {
            ...(connection.workerBinding || {}),
            status: agentReply?.sent ? "message_roundtrip_tested" : "event_received",
            updatedAt: now,
          },
          updatedAt: now,
        }, targetEmployeeId);
        store.saveMessageTest({
          id: eventRecordId,
          contractVersion: CONTRACT_VERSION,
          employeeId: targetEmployeeId,
          employeeName: targetEmployeeName,
          sourceSystemId: SOURCE_SYSTEM_ID,
          sceneType: receiveMode === "websocket_long_connection" ? "飞书长连接消息事件" : "飞书消息事件回调",
          requestScope: "飞书事件订阅",
          channelIntent: "personal_chat",
          channelIntentLabel: "可对话机器人",
          sourceMessageIdDigest: messageIdDigest,
          sourceMessageIdMasked: maskIdentifier(messageId),
          sourceChatIdMasked: maskIdentifier(chatId),
          sourceSenderIdMasked: maskIdentifier(senderId),
          status: agentReply ? agentReply.status : nextConnection.eventSubscription.status,
          messageContractOk: true,
          delivery: agentReply || {
            mode: "feishu_session_reset_command",
            sent: false,
            status: "session_reset_acknowledged",
            messageContractOk: true,
            note: "会话重置命令已处理。",
          },
          turnIntent: "session_reset",
          responsePolicy,
          runtimeAdapter: "control-plane-direct",
          submittedBy,
          submittedAt: now,
          updatedAt: now,
          warnings: ["AI agent 接收会话重置命令；明文不进入日志/API/UI/Git，不保存 raw prompt、模型 trace 或执行 payload。"],
        });
        return {
          ok: true,
          status: nextConnection.status,
          eventStatus: nextConnection.eventSubscription.status,
          reply: agentReply,
          marker: null,
          agentTurn,
          agentReply,
          markerCleanup: { attempted: false, status: "not_needed", messageContractOk: true },
          runtimeTask: null,
          turnIntent: "session_reset",
          responsePolicy,
        };
      }
      let materialToolExecutor = null;
      try {
        const employee = employeeForGateway();
        if (!employee.id) throw new Error(`digital employee ${targetEmployeeId} is not available to the Feishu worker`);
        const resourceSetup = resolveRuntimeResourceSetup({
          employee,
          resourceMonitors: typeof store.readResourceMonitors === "function" ? store.readResourceMonitors(targetEmployeeId) : [],
        }) || { ready: true, requiredResourceIds: [], resources: [], missingResources: [] };
        const inboundTurn = {
          ...normalizeFeishuInboundTurn({
            conversation,
            eventType,
            materialMessages,
            messageEvent,
            messageIdDigest,
            receiveMode,
          }),
          confirmationContext: confirmationContextFromPendingSubmission(pendingToolConfirmationSubmission) || {
            actorId: senderId,
            employeeId: targetEmployeeId,
            sessionKey: conversation.sessionKey,
          },
          toolConfirmation: pendingToolConfirmation,
        };
        const canonicalTaskMode = Boolean(runtimeTaskService?.runConversationTask);
        const persistentTaskMode = persistentTaskExecution && !trustedToolConfirmationContinuation &&
          Boolean(runtimeTaskService?.waitForConversationTask);
        const priorSessionReferences = canonicalTaskMode ? [] : findRecentSessionReferences({
          sessionKey: conversation.sessionKey,
          tasks: typeof store.readRuntimeTasks === "function" ? store.readRuntimeTasks() : [],
          now,
        });
        const contextSource = await prepareRuntimeContextSource({
          checkpointRepository,
          route: createSessionRoute(conversation.routeDimensions),
          sessionRepository,
        });
        const stableTurnId = messageIdDigest || eventRecordId;
        const persistedUserText = inboundTurn.text || "飞书材料任务";
        const executionInput = await recordRuntimeConversationInput({
          source: contextSource,
          turnId: stableTurnId,
          userText: persistedUserText,
        });
        contextSource.session = executionInput.session;
        const submittedParameterState = await submitRuntimeToolParameterContinuation({
          employeeId: targetEmployeeId,
          executionInput,
          repository: toolParameterContinuationRepository,
          source: contextSource,
          submission: pendingToolParameterSubmission,
        });
        const toolParameterContinuation = submittedParameterState?.continuation || null;
        const submittedPresentationEvidence = submittedParameterState?.presentationEvidence || null;
        const continuationIdentity = {
          employeeId: targetEmployeeId,
          routeDigest: contextSource.route.routeDigest,
          sessionId: executionInput.session.sessionId,
        };
        const channelPresentationEvidence = submittedPresentationEvidence || readChannelPresentationEvidence({
          allowSessionFallback: !submittedParameterState,
          executionInputRefId: executionInput.entry.entryId,
          identity: continuationIdentity,
          repository: toolParameterContinuationRepository,
        });
        if (submittedParameterState) contextSource.session = submittedParameterState.session;
        const turnDecision = effectiveTurnDispatcher.prepareTurn({
          connection,
          employee,
          priorSessionReferences,
          turn: inboundTurn,
        });
        const predecessorSource = canonicalTaskMode && inboundTurn.chatType === "p2p" && !inboundTurn.hasMaterial
          ? runtimeTaskService?.findRecentCompletedMaterialSource?.({ route: contextSource.route, sessionId: executionInput.session.sessionId }) || null
          : null;
        const continuesPrivateTask = inboundTurn.chatType === "p2p" && (priorSessionReferences.length > 0 || Boolean(predecessorSource));
        const requiresExecutionTask = canonicalTaskMode
          ? turnDecision.runtimeEligible
          : turnDecision.taskEligible || continuesPrivateTask;
        const queueAdmission = requiresExecutionTask && turnDecision.runtimeEligible
          ? prepareRuntimeTaskAdmission({ store: canonicalTaskMode ? canonicalRuntimeTaskAdmissionStore() : store, employee, now })
          : {
            accepted: turnDecision.runtimeEligible,
            reason: turnDecision.runtimeEligible ? "conversation_runtime_ready" : turnDecision.invocationCheck?.reason || "runtime_not_eligible",
          };
        const durableMaterialBinding = canonicalTaskMode
          ? inboundTurn.hasMaterial
            ? createFeishuMaterialBindingDescriptor({ messages: materialMessages, now: executionInput.entry.createdAt })
            : predecessorSource
              ? createPredecessorTaskMaterialBindingDescriptor({ sourceBinding: predecessorSource })
              : null
          : null;
        if (canonicalTaskMode && inboundTurn.hasMaterial && !durableMaterialBinding) {
          throw new Error("feishu_material_binding_unavailable");
        }
        let runtimeTask = null;
        if (requiresExecutionTask && canonicalTaskMode) {
          runtimeTask = queueAdmission?.accepted === false
            ? buildQueueFullRuntimeTask({
                employee,
                materialMessages,
                queueAdmission,
                resourceSetup,
                turnDecision,
                now,
              })
            : {
                ...runtimeTaskService.createConversationTask({
                  actorLocator: {
                    identitySource: "feishu",
                    subjectId: senderId,
                    subjectIdType: "feishu_sender_id",
                    conversationId: chatId,
                    conversationType: conversation.routeDimensions.conversationType,
                  },
                  employee,
                  executionInput,
                  materialBinding: durableMaterialBinding,
                  requestId: stableTurnId,
                  route: contextSource.route,
                  permissionDigest: feishuExecutionPermissionDigest(connection, employee, turnDecision.invocationCheck?.status),
                  sourceSystemId: SOURCE_SYSTEM_ID,
                  taskType: inboundTurn.hasMaterial ? "package_intake_analysis" : "digital_employee_chat",
                }),
                turnIntent: turnDecision.turnIntent,
                responsePolicy: turnDecision.responsePolicy,
                runtimeAdapter: turnDecision.runtimeAdapter,
                materialRefs: materialMessages.flatMap(extractMaterialRefsFromFeishuMessage),
                invocationCheck: turnDecision.invocationCheck,
              };
        } else if (requiresExecutionTask) {
          runtimeTask = saveRuntimeTaskFromFeishuEvent({
            store,
            employee,
            nextRecordId,
            connection,
            eventType,
            materialMessages,
            messageEvent,
            conversationKey: conversation.sessionKey,
            queueAdmission,
            receiveMode,
            resourceSetup,
            submittedBy,
            turnDecision,
            now,
          });
        }
        if (!canonicalTaskMode && runtimeTask && turnDecision.runtimeEligible && queueAdmission?.accepted !== false) {
          runtimeTask = claimRuntimeTaskForExecution({
            store,
            task: runtimeTask,
            now,
            executionMode: "feishu_event_controlled_runtime",
          });
        }
        const sourceTaskId = continuesPrivateTask ? priorSessionReferences[0]?.taskId || "" : "";
        const workspace = persistentTaskMode || !runtimeTask || !turnDecision.runtimeEligible || queueAdmission?.accepted === false
          ? null
          : inboundTurn.hasMaterial
            ? await effectiveWorkspaceManager.workspaceForTask(runtimeTask.id, { create: true })
            : sourceTaskId
              ? await effectiveWorkspaceManager.forkTaskWorkspace(sourceTaskId, runtimeTask.id)
              : null;
        const skillRuntimeProjection = !workspace ? null : await resolveSkillRuntimeProjection({
          skillHarnessRunner,
          runtimeTask,
          skillScope: turnDecision.dependencyContext?.skillScope,
        });
        materialToolExecutor = persistentTaskMode || !turnDecision.runtimeEligible || queueAdmission?.accepted === false || !workspace
          ? null
          : createFeishuMaterialToolExecutor({
            authorizeToolCall: (toolCall) => effectiveTurnDispatcher.authorizeToolCall?.({ decision: turnDecision, toolCall }),
            connection,
            completionEvidenceCapabilities: skillRuntimeProjection?.completionEvidenceCapabilities,
            employee,
            fetch,
            messages: materialMessages.length ? materialMessages : [messageEvent.message],
            readSecret: (key) => store.readSecret(key, targetEmployeeId),
            skillHarnessRunner: skillRuntimeProjection?.skillHarnessRunner || skillHarnessRunner,
            skillScope: turnDecision.dependencyContext?.skillScope,
            verifiedHarnessSkillIds: skillRuntimeProjection?.verifiedHarnessSkillIds,
            validateFeishuCredentials,
            workspace,
            workspaceManager: effectiveWorkspaceManager,
            workspaceTaskId: runtimeTask.id,
          });
        const markerStatusLabel = !requiresExecutionTask
          ? "回复中"
          : queueAdmission?.accepted === false
            ? turnDecision.runtimeEligible ? "队列已满" : "运行准入"
            : runtimeTask?.statusLabel || (resourceSetup.ready ? "结果总结中" : "等待运行资源");
        const marker = trustedToolConfirmationContinuation
          ? {
            sent: false,
            mode: "reaction",
            status: "trusted_tool_confirmation_continuation",
            statusLabel: markerStatusLabel,
            messageContractOk: true,
          }
          : await addFeishuProcessingReactionIfPossible({
            messageId,
            statusLabel: markerStatusLabel,
          });
        const queuePolicyTurn = buildQueuePolicyAgentTurn(runtimeTask);
        const groupReplyMention = feishuGroupReplyMention(messageEvent);
        const streamingSession = !trustedToolConfirmationContinuation && !persistentTaskMode &&
          !queuePolicyTurn && turnDecision.runtimeEligible && !materialToolExecutor
          ? await startAgentReplyStreamIfPossible({ connection, messageId, groupReplyMention })
          : null;
        const runtimeContext = assembleRuntimeTurnContext({
          decision: turnDecision,
          dependencyContext: turnDecision.dependencyContext,
          materialToolExecutor,
          priorSessionReferences,
          resourceSetup,
          runtimeTask,
          session: contextSource.session,
          turn: inboundTurn,
        });
        runtimeContext.contextSource = contextSource;
        runtimeContext.toolParameterContinuation = toolParameterContinuation;
        runtimeContext.channelPresentationEvidence = channelPresentationEvidence;
        let canonicalSettlement = null;
        const executeAgentTurn = async (ownership = null) => {
          const executionRuntimeTask = ownership?.task || runtimeTask;
          let executedTurn = queuePolicyTurn || (trustedToolConfirmationContinuation && canonicalTaskMode && runtimeTask
            ? await runApprovedToolConfirmationIfPossible({
              connection,
              decision: turnDecision,
              materialToolExecutor,
              operationReceiptContext: operationReceiptContextForExecutionOwnership(ownership),
              runtimeContext,
              runtimeTask: executionRuntimeTask,
              resourceSetup,
              signal: ownership?.signal || null,
            })
            : await runAgentTurnIfPossible({
              connection,
              decision: turnDecision,
              materialToolExecutor,
              messageEvent,
              onTextDelta: streamingSession?.push,
              operationReceiptContext: operationReceiptContextForExecutionOwnership(ownership),
              runtimeContext,
              runtimeTask: executionRuntimeTask,
              resourceSetup,
              signal: ownership?.signal || null,
            }));
          if (runtimeTask && materialToolExecutor && !canonicalTaskMode) {
            const persistedTask = typeof store.readRuntimeTasks === "function"
              ? store.readRuntimeTasks().find((task) => task.id === runtimeTask.id)
              : null;
            if (persistedTask?.status === "canceled") runtimeTask = persistedTask;
            const materialPatch = materialToolExecutor.taskPatch();
            if (materialPatch.toolResults.length || Object.keys(materialPatch.statusByDigest).length) {
              runtimeTask = store.saveRuntimeTask({
                ...runtimeTask,
                materialRefs: (runtimeTask.materialRefs || []).map((item) => ({
                  ...item,
                  intakeStatus: materialPatch.statusByDigest[item.refDigest] || item.intakeStatus,
                })),
                materialProcessing: materialPatch.toolResults,
                updatedAt: now,
              });
            }
            runtimeTask = settleRuntimeTaskFromMaterialIntake({ store, task: runtimeTask, resourceSetup, now });
          } else if (runtimeTask && materialToolExecutor) {
            const materialPatch = materialToolExecutor.taskPatch();
            runtimeTask = {
              ...runtimeTask,
              materialRefs: (runtimeTask.materialRefs || []).map((item) => ({
                ...item,
                intakeStatus: materialPatch.statusByDigest[item.refDigest] || item.intakeStatus,
              })),
              materialProcessing: materialPatch.toolResults,
            };
            const materialStatuses = [
              ...(runtimeTask.materialRefs || []).map((item) => item.intakeStatus),
              ...materialPatch.toolResults.map((item) => item.status),
            ];
            const modelInputReady = materialStatuses.includes("temporary_model_input_ready") ||
              materialStatuses.some((status) => /_completed$/.test(status));
            if (!modelInputReady && materialStatuses.some((status) => /metadata_only|missing|unavailable|download_.*failed|too_large/.test(status))) {
              canonicalSettlement = {
                status: "waiting",
                waitReasonCode: "pending_file_intake",
                lastErrorCode: "material_recovery_unavailable",
                resultSummary: "Material task is waiting for a recoverable governed input reference.",
              };
            } else if (!modelInputReady && resourceSetup?.ready === false) {
              canonicalSettlement = {
                status: "waiting",
                waitReasonCode: "pending_remote_resource",
                lastErrorCode: "runtime_resource_pending",
                resultSummary: "Material task is waiting for a governed runtime resource.",
              };
            }
          }
          executedTurn = addMaterialIntakeNotice(executedTurn, runtimeTask, messageEvent);
          if (!canonicalTaskMode) {
            runtimeTask = settleRuntimeTaskFromAgentTurn({ store, task: runtimeTask, agentTurn: executedTurn, now });
            runtimeTask = attachAgentRuntimeEvidenceToTask({ task: runtimeTask, agentTurn: executedTurn, now });
            runtimeTask = attachTurnDecisionToTask({ task: runtimeTask, turnDecision, now });
          }
          await recordRuntimeConversationTurn({
            source: contextSource,
            turnId: stableTurnId,
            turn: {
              userText: persistedUserText,
              assistantText: executedTurn.text,
              sourceMessageIdDigest: messageIdDigest,
              turnIntent: turnDecision.turnIntent,
              taskId: runtimeTask?.id || undefined,
              recordedAtMs: Date.parse(now),
              toolCalls: executedTurn?.toolCalls || executedTurn?.safeSummary?.agentRuntime?.toolCalls || [],
            },
          });
          return executedTurn;
        };
        let agentTurn;
        if (queuePolicyTurn) {
          agentTurn = await executeAgentTurn();
        } else if (persistentTaskMode && runtimeTask) {
          try {
            const settledTask = await runtimeTaskService.waitForConversationTask(runtimeTask, { timeoutMs: 600_000 });
            runtimeTask = { ...runtimeTask, ...settledTask };
            const resultEntry = await readRuntimeConversationResult({
              expectedSessionId: contextSource.session.sessionId,
              source: contextSource,
              taskId: canonicalRuntimeTaskId(runtimeTask),
            });
            if (!resultEntry?.message?.content) throw persistentGatewayError("execution_task_result_unavailable");
            agentTurn = {
              ok: true,
              status: "agent_reply_ready",
              reason: "persistent_execution_task",
              text: resultEntry.message.content,
              toolConfirmationRequests: effectiveTurnDispatcher.pendingToolConfirmationRequests?.({
                actorId: senderId,
                employeeId: targetEmployeeId,
                sessionKey: executionInput.session.sessionId,
              }) || [],
              toolParameterCards: toolParameterContinuationRepository?.listDrafts?.({
                employeeId: targetEmployeeId,
                routeDigest: contextSource.route.routeDigest,
                sessionId: contextSource.session.sessionId,
                sourceTaskId: canonicalRuntimeTaskId(runtimeTask),
              }) || [],
              safeSummary: { employeeId: targetEmployeeId, runtime: "persistent_execution_task" },
            };
          } catch (error) {
            const persistedTask = runtimeTaskService.findTask?.(runtimeTask.employeeId, runtimeTask.id);
            if (persistedTask) runtimeTask = { ...runtimeTask, ...persistedTask, materialRefs: runtimeTask.materialRefs };
            agentTurn = persistentGatewayFailureTurn(error, targetEmployeeName);
          }
        } else if (canonicalTaskMode && runtimeTask) {
          const execution = await runtimeTaskService.runConversationTask(runtimeTask, async (ownership) => ({
            agentTurn: await executeAgentTurn(ownership),
            ...(canonicalSettlement ? { settlement: canonicalSettlement } : {}),
          }));
          runtimeTask = { ...runtimeTask, ...execution.task };
          agentTurn = execution.value.agentTurn;
        } else {
          agentTurn = await executeAgentTurn();
        }
        if (canonicalTaskMode && runtimeTask) {
          runtimeTask = {
            ...runtimeTask,
            turnIntent: turnDecision.turnIntent,
            responsePolicy: turnDecision.responsePolicy,
            runtimeAdapter: turnDecision.runtimeAdapter,
            invocationCheck: invocationCheckFromAgentTurn(agentTurn),
            execution: {
              ...(runtimeTask.execution || {}),
              agentRuntime: agentTurn?.safeSummary?.agentRuntime || {},
            },
          };
        }
        rememberToolConfirmationRequests(agentTurn, persistentTaskMode
          ? {
            actorId: senderId,
            employeeId: targetEmployeeId,
            sessionKey: executionInput.session.sessionId,
          }
          : inboundTurn.confirmationContext);
        const agentReply = await sendAgentTurnReplyIfPossible({
          connection,
          messageId,
          agentTurn,
          runtimeTask,
          groupReplyMention,
          reportArtifacts: materialToolExecutor?.availableOutputArtifacts?.() || [],
          streamingSession,
        });
        runtimeTask = canonicalTaskMode ? runtimeTask : markRuntimeTaskFeedbackDelivery({
          store,
          task: runtimeTask,
          reply: agentReply,
          feedbackEnabled: Boolean(agentTurn?.ok && cardFeedbackSubscriptionReady(connection)),
          now,
        });
        scheduleTaskFeedbackArchiveIfNeeded({ runtimeTask });
        scheduleQueueWaitNoticeIfNeeded({ runtimeTask, messageId, groupReplyMention, submittedBy });
      const markerCleanup = await removeProcessingReactionAfterReply({
        messageId,
        marker,
        textReply: agentReply,
      });
      const nextConnection = store.saveConnection({
        ...connection,
        eventSubscription: {
          ...(connection.eventSubscription || {}),
          status: marker.sent ? "message_roundtrip_tested" : "event_received",
          receiveMode,
          callbackPath,
          lastEventAt: now,
          ...reactionPermissionPatch(marker, now),
          ...reactionCleanupPatch(markerCleanup, now),
        },
        lastEventSummary: {
          eventType,
          messageId: maskIdentifier(messageId),
          chatId: maskIdentifier(chatId),
          senderId: maskIdentifier(senderId),
          replyStatus: agentReply?.status || marker.status,
          receivedAt: now,
        },
        workerBinding: {
          ...(connection.workerBinding || {}),
          status: marker.sent ? "message_roundtrip_tested" : "event_received",
          updatedAt: now,
        },
        updatedAt: now,
      }, targetEmployeeId);
      store.saveMessageTest({
        id: eventRecordId,
        contractVersion: CONTRACT_VERSION,
        employeeId: targetEmployeeId,
        employeeName: targetEmployeeName,
        sourceSystemId: SOURCE_SYSTEM_ID,
        sceneType: receiveMode === "websocket_long_connection" ? "飞书长连接消息事件" : "飞书消息事件回调",
        requestScope: "飞书事件订阅",
        channelIntent: "personal_chat",
        channelIntentLabel: "可对话机器人",
        sourceMessageIdDigest: messageIdDigest,
        sourceMessageIdMasked: maskIdentifier(messageId),
        sourceChatIdMasked: maskIdentifier(chatId),
        sourceSenderIdMasked: maskIdentifier(senderId),
        status: agentReply ? agentReply.status : nextConnection.eventSubscription.status,
        messageContractOk: true,
        delivery: agentReply || {
          mode: receiveMode === "websocket_long_connection" ? "feishu_long_connection_reaction" : "feishu_event_reaction",
          sent: marker.sent,
          status: marker.status,
          messageContractOk: true,
          note: marker.statusLabel ? `飞书消息下方状态标记：${marker.statusLabel}` : "",
          httpStatus: marker.httpStatus,
          responseSummary: marker.responseSummary,
        },
        invocationCheck: runtimeTask?.invocationCheck || turnDecision.invocationCheck || invocationCheckFromAgentTurn(agentTurn),
        turnIntent: turnDecision.turnIntent,
        responsePolicy: turnDecision.responsePolicy,
        runtimeAdapter: turnDecision.runtimeAdapter || agentTurn?.safeSummary?.agentRuntime?.adapter || "control-plane-direct",
        submittedBy,
        submittedAt: now,
        updatedAt: now,
        warnings: ["AI agent 接收本次消息、加密本机会话 transcript 和安全上下文；明文不进入日志/API/UI/Git，不保存 raw prompt、模型 trace 或执行 payload。"],
      });
      return {
        ok: true,
        status: nextConnection.status,
        eventStatus: nextConnection.eventSubscription.status,
        reply: publicReaction(marker),
        marker: publicReaction(marker),
        agentTurn,
        agentReply,
        markerCleanup,
        runtimeTask,
        turnIntent: turnDecision.turnIntent,
        responsePolicy: turnDecision.responsePolicy,
      };
      } finally {
        await materialToolExecutor?.dispose?.();
        if (messageIdDigest) inFlightMessageDigests.delete(messageIdDigest);
      }
      });
    }

    const nextConnection = store.saveConnection({
      ...connection,
      eventSubscription: {
        ...(connection.eventSubscription || {}),
        status: "event_received",
        receiveMode,
        callbackPath,
        lastEventAt: now,
      },
      lastEventSummary: {
        eventType: eventType || "unknown",
        receivedAt: now,
      },
      workerBinding: {
        ...(connection.workerBinding || {}),
        status: "event_received",
        updatedAt: now,
      },
      updatedAt: now,
    }, targetEmployeeId);
    return {
      ok: true,
      status: nextConnection.status,
      eventStatus: nextConnection.eventSubscription.status,
    };
    }

  async function recordToolParameterCardAction({ connection = {}, event = {}, receiveMode = "", submittedBy = {}, now = new Date().toISOString() } = {}) {
    const action = parseFeishuToolParameterAction(event, targetEmployeeId);
    if (!action.matched) return null;
    if (!action.ok || !toolParameterContinuationRepository) {
      return parameterCardCallbackResult("tool_parameter_card_invalid", "这张参数卡无效，请重新生成。");
    }
    if (pendingToolParameterCardIds.has(action.cardId)) {
      return parameterCardCallbackResult("tool_parameter_card_processing", "参数已提交，请等待处理。", "info");
    }
    pendingToolParameterCardIds.add(action.cardId);
    let resolved;
    try {
      resolved = await resolveToolParameterCardCallback(action);
    } catch {
      pendingToolParameterCardIds.delete(action.cardId);
      return parameterCardCallbackResult("tool_parameter_card_unavailable", "参数卡暂时不可用，请稍后重新生成。", "warning");
    }
    if (!resolved) {
      pendingToolParameterCardIds.delete(action.cardId);
      return parameterCardCallbackResult("tool_parameter_card_expired", "这张参数卡已过期或已提交，请重新生成。", "warning");
    }
    const verifiedAction = {
      ...action,
      schemaDigest: action.schemaDigest || resolved.card.schemaDigest,
    };
    const submission = parseFeishuToolParameterSubmission(resolved.card, verifiedAction);
    if (!submission.ok) {
      pendingToolParameterCardIds.delete(action.cardId);
      return parameterCardCallbackResult(submission.error, submission.message || "参数校验失败，请检查后重试。", "warning");
    }
    const pending = {
      arguments: submission.arguments,
      cardId: verifiedAction.cardId,
      schemaDigest: verifiedAction.schemaDigest,
    };
    pendingToolParameterSubmissions.set(action.messageId, pending);
    store.saveConnection({
      ...connection,
      eventSubscription: {
        ...(connection.eventSubscription || {}),
        cardActionSubscribedAt: connection.eventSubscription?.cardActionSubscribedAt || now,
        cardActionLastReceivedAt: now,
        cardActionReceiveMode: cleanShortText(receiveMode),
      },
      updatedAt: now,
    }, targetEmployeeId);
    setImmediate(async () => {
      try {
        await recordFeishuEvent({
          connection: store.readConnection?.(targetEmployeeId) || connection,
          event: {
            event_type: "im.message.receive_v1",
            sender: { sender_id: { open_id: action.operatorId }, sender_type: "user" },
            message: {
              message_id: action.messageId,
              chat_id: action.chatId,
              chat_type: resolved.chatType,
              message_type: "text",
              content: JSON.stringify({ text: "用户已提交参数卡，请按结构化参数继续当前任务。" }),
            },
          },
          receiveMode: "trusted_tool_parameter_continuation",
          submittedBy,
        });
      } catch (error) {
        await sendAgentTurnReplyIfPossible({
          connection: store.readConnection?.(targetEmployeeId) || connection,
          messageId: action.messageId,
          agentTurn: {
            ok: false,
            status: cleanShortText(error?.code || "tool_parameter_continuation_failed"),
            text: "参数卡未能继续执行，请重新生成后再试。",
          },
        }).catch(() => {});
      } finally {
        pendingToolParameterSubmissions.delete(action.messageId);
        pendingToolParameterCardIds.delete(action.cardId);
      }
    });
    const callbackResponse = {
      toast: { type: "success", content: "已收到参数，正在处理。" },
      card: { type: "raw", data: buildFeishuToolParameterProcessingCard(resolved.card) },
    };
    return {
      ok: true,
      status: "tool_parameter_card_submitted",
      callbackResponse,
      toast: callbackResponse.toast,
    };
  }

  async function recordToolConfirmationCardAction({ connection = {}, event = {}, receiveMode = "", submittedBy = {}, now = new Date().toISOString() } = {}) {
    const action = parseFeishuToolConfirmationAction(event, targetEmployeeId);
    if (!action.matched) return null;
    if (!action.ok) return parameterCardCallbackResult("tool_confirmation_card_invalid", "这张确认卡无效，请重新发起操作。");
    pruneToolConfirmationRequests();
    const request = issuedToolConfirmationRequests.get(action.confirmationId);
    if (!request) return parameterCardCallbackResult("tool_confirmation_card_expired", "这张确认卡已过期或已处理，请重新发起操作。", "warning");
    if (pendingToolConfirmationIds.has(action.confirmationId)) {
      return parameterCardCallbackResult("tool_confirmation_card_processing", "本次确认正在处理，请勿重复点击。", "info");
    }
    const chatType = await resolveToolConfirmationChatType(action);
    if (!chatType) return parameterCardCallbackResult("tool_confirmation_context_missing", "当前会话已失效，请重新发起操作。", "warning");
    issuedToolConfirmationRequests.delete(action.confirmationId);
    if (action.decision === "declined") {
      const callbackResponse = {
        toast: { type: "info", content: "已取消，本次操作不会执行。" },
        card: { type: "raw", data: buildFeishuToolConfirmationDecisionCard(request, "declined") },
      };
      return { ok: true, status: "tool_confirmation_declined", callbackResponse, toast: callbackResponse.toast };
    }
    pendingToolConfirmationIds.add(action.confirmationId);
    pendingToolConfirmationSubmissions.set(action.messageId, {
      confirmation: {
        contractVersion: "tool-call-confirmation.v1",
        id: action.confirmationId,
        decision: "approved",
      },
      confirmationContext: request.confirmationContext || null,
    });
    store.saveConnection({
      ...connection,
      eventSubscription: {
        ...(connection.eventSubscription || {}),
        cardActionSubscribedAt: connection.eventSubscription?.cardActionSubscribedAt || now,
        cardActionLastReceivedAt: now,
        cardActionReceiveMode: cleanShortText(receiveMode),
      },
      updatedAt: now,
    }, targetEmployeeId);
    setImmediate(async () => {
      try {
        await recordFeishuEvent({
          connection: store.readConnection?.(targetEmployeeId) || connection,
          event: {
            event_type: "im.message.receive_v1",
            sender: { sender_id: { open_id: action.operatorId }, sender_type: "user" },
            message: {
              message_id: action.messageId,
              chat_id: action.chatId,
              chat_type: chatType,
              message_type: "text",
              content: JSON.stringify({ text: "用户已在一次性确认卡中批准本次准确 Tool 操作。" }),
            },
          },
          receiveMode: "trusted_tool_confirmation_continuation",
          submittedBy,
        });
      } catch (error) {
        console.warn("[feishu-gateway] tool confirmation continuation failed", JSON.stringify({
          employeeId: targetEmployeeId,
          confirmationIdDigest: digestValue(action.confirmationId).slice(0, 16),
          status: safeGatewayErrorCode(error, "tool_confirmation_continuation_failed"),
        }));
        await sendAgentTurnReplyIfPossible({
          connection: store.readConnection?.(targetEmployeeId) || connection,
          messageId: action.messageId,
          agentTurn: {
            ok: false,
            status: "tool_confirmation_continuation_failed",
            text: "确认已收到，但本次操作未能继续执行；请重新发起，系统不会复用本次确认。",
          },
        }).catch(() => {});
      } finally {
        pendingToolConfirmationSubmissions.delete(action.messageId);
        pendingToolConfirmationIds.delete(action.confirmationId);
      }
    });
    const callbackResponse = {
      toast: { type: "success", content: "确认已收到，正在执行本卡绑定的操作。" },
      card: { type: "raw", data: buildFeishuToolConfirmationDecisionCard(request, "approved") },
    };
    return { ok: true, status: "tool_confirmation_approved", callbackResponse, toast: callbackResponse.toast };
  }

  function safeGatewayErrorCode(error = null, fallback = "feishu_gateway_error") {
    const raw = cleanShortText(error?.code || error?.name || fallback);
    return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120) || fallback;
  }

  function rememberToolConfirmationRequests(agentTurn = {}, confirmationContext = {}) {
    pruneToolConfirmationRequests();
    for (const request of Array.isArray(agentTurn.toolConfirmationRequests) ? agentTurn.toolConfirmationRequests : []) {
      if (request?.contractVersion !== "tool-call-confirmation.v1" || !request.id || !Number.isFinite(Date.parse(request.expiresAt))) continue;
      issuedToolConfirmationRequests.set(request.id, {
        ...structuredClone(request),
        confirmationContext: safeConfirmationContext(confirmationContext),
      });
    }
    while (issuedToolConfirmationRequests.size > 100) {
      issuedToolConfirmationRequests.delete(issuedToolConfirmationRequests.keys().next().value);
    }
  }

  async function resolveToolConfirmationChatType(action) {
    for (const chatType of ["p2p", "group"]) {
      const conversation = conversationTurnCoordinator.conversationForMessage({
        sender: { sender_id: { open_id: action.operatorId } },
        message: { chat_id: action.chatId, chat_type: chatType },
      });
      const route = createSessionRoute(conversation.routeDimensions);
      const session = await sessionRepository.readCurrentSession(route).catch(() => null);
      if (session?.sessionId) return chatType;
    }
    return "";
  }

  function pruneToolConfirmationRequests() {
    const at = Date.now();
    for (const [id, request] of issuedToolConfirmationRequests) {
      if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= at) issuedToolConfirmationRequests.delete(id);
    }
  }

  async function resolveToolParameterCardCallback(action) {
    for (const chatType of ["p2p", "group"]) {
      const conversation = conversationTurnCoordinator.conversationForMessage({
        sender: { sender_id: { open_id: action.operatorId } },
        message: { chat_id: action.chatId, chat_type: chatType },
      });
      const route = createSessionRoute(conversation.routeDimensions);
      const session = await sessionRepository.readCurrentSession(route).catch(() => null);
      if (!session) continue;
      const cards = toolParameterContinuationRepository.listDrafts({
        employeeId: targetEmployeeId,
        routeDigest: route.routeDigest,
        sessionId: session.sessionId,
      });
      const card = cards.find((candidate) => candidate.id === action.cardId &&
        (!action.schemaDigest || candidate.schemaDigest === action.schemaDigest));
      if (card) return { card, chatType };
    }
    return null;
  }

  function parameterCardCallbackResult(status, content, type = "error") {
    const toast = { type, content };
    return { ok: true, status, callbackResponse: { toast }, toast };
  }

  function recordCardFeedback({ connection = {}, event = {}, receiveMode = "", submittedBy = {}, now = new Date().toISOString() } = {}) {
    const parsed = parseFeishuCardFeedback(event, now, targetEmployeeId);
    if (!parsed.ok) {
      return {
        ok: true,
        status: "card_action_ignored",
        feedback: null,
        ...cardFeedbackToast({ duplicate: true }),
      };
    }

    const feedback = parsed.feedback;
    const records = typeof store.readCardFeedback === "function" ? store.readCardFeedback() : [];
    const duplicate = findDuplicateCardFeedback(records, feedback);
    if (duplicate) {
      return {
        ok: true,
        status: "card_feedback_duplicate",
        feedback: publicCardFeedback(duplicate),
        ...cardFeedbackToast({ duplicate: true, rating: duplicate.rating }),
      };
    }

    const qualityEvent = feedback.rating === "not_helpful"
      ? saveNegativeFeedbackQualityEvent(feedback, now)
      : null;
    const savedFeedback = typeof store.saveCardFeedback === "function"
      ? store.saveCardFeedback({
          ...feedback,
          qualityEventId: qualityEvent?.id || "",
          qualityStatus: feedback.rating === "not_helpful"
            ? qualityEvent ? "pending_quality_review" : "quality_store_unavailable"
            : "quality_ok",
        })
      : feedback;
    markRuntimeTaskFeedbackReceived({
      store,
      feedback: savedFeedback,
      qualityStatus: savedFeedback.qualityStatus,
      qualityEventId: savedFeedback.qualityEventId,
      now,
    });
    const nextConnection = store.saveConnection({
      ...connection,
      eventSubscription: {
        ...(connection.eventSubscription || {}),
        cardActionSubscribedAt: connection.eventSubscription?.cardActionSubscribedAt || now,
        cardActionLastReceivedAt: now,
        cardActionReceiveMode: cleanShortText(receiveMode),
      },
      updatedAt: now,
    }, targetEmployeeId);
    return {
      ok: true,
      status: feedback.rating === "not_helpful" ? "card_feedback_issue_recorded" : "card_feedback_ok_recorded",
      connectionStatus: nextConnection.status,
      feedback: publicCardFeedback(savedFeedback),
      qualityEvent: qualityEvent ? {
        id: qualityEvent.id,
        status: qualityEvent.status,
        contractVersion: "quality-event.v1",
      } : null,
      ...cardFeedbackToast({ rating: feedback.rating }),
    };
  }

  function saveNegativeFeedbackQualityEvent(feedback = {}, now = new Date().toISOString()) {
    if (typeof controlPlaneStore?.saveQualityEvent !== "function") return null;
    const employee = employeeForGateway();
    try {
      return controlPlaneStore.saveQualityEvent({
        id: nextRecordId("QEFDBK"),
        sourceSystemId: SOURCE_SYSTEM_ID,
        sourceEventId: `feishu-card-feedback:${feedback.answerId}:${feedback.operatorIdDigest}`,
        eventType: "badcase_summary",
        occurredAt: feedback.receivedAt || now,
        reportedAt: now,
        departmentId: cleanShortText(employee.departmentId || employee.ownerDepartmentId),
        businessDomain: cleanShortText(employee.businessDomain || employee.domain),
        executionMode: "platform_hosted",
        platformPolicyId: "INVOKE-FEISHU-EMPLOYEE-001",
        entityType: "数字员工",
        entityId: feedback.employeeId || targetEmployeeId,
        entityVersion: feedback.employeeVersion,
        capabilityVersion: feedback.skillId,
        promptVersion: feedback.promptVersion,
        severity: "P2",
        status: "待平台质量复盘",
        errorDomain: "user_feedback",
        errorCode: "FEISHU_ANSWER_NOT_HELPFUL",
        rootCauseCategory: "pending_analysis",
        resolutionAction: "pending_review",
        expectedSummary: "用户期望本次飞书对话回答能够解决当前问题。",
        actualSummary: "用户在飞书对话回答中标记为“存在问题”。",
        evidenceSummary: `飞书回答 ${feedback.answerId} 收到负向质量反馈；仅保留关联键和脱敏操作人摘要。`,
        evalCandidate: true,
        reviewGate: "质量治理确认根因、修复动作和回归候选后入库。",
        warnings: ["未保存飞书原话、回答原文、raw prompt、模型 trace 或执行 payload。"],
        tags: ["feishu-card-feedback", "user-negative-feedback", "mvp-control-plane-draft"],
        updatedAt: now,
      });
    } catch {
      return null;
    }
  }

  function duplicateMessageEvent(messageIdDigest = "") {
    if (!messageIdDigest) return null;
    if (!inFlightMessageDigests.has(messageIdDigest) && !previouslyRepliedToMessage(messageIdDigest)) return null;
    return {
      ok: true,
      status: "duplicate_event_ignored",
      eventStatus: "duplicate_event_ignored",
      duplicate: true,
      reply: publicReaction({
        sent: false,
        mode: "feishu_ai_agent_reply",
        status: "duplicate_event_ignored",
        messageContractOk: true,
        note: "同一飞书消息事件已处理过，本次不重复回复。",
      }),
      marker: publicReaction({
        sent: false,
        mode: "reaction",
        status: "duplicate_event_ignored",
        messageContractOk: true,
        note: "同一飞书消息事件已处理过，本次不重复添加状态标记。",
      }),
      agentTurn: {
        ok: false,
        status: "duplicate_event_ignored",
        reason: "source_message_already_replied",
        text: "",
      },
      agentReply: {
        sent: false,
        mode: "feishu_ai_agent_reply",
        status: "duplicate_event_ignored",
        messageContractOk: true,
        note: "同一飞书消息事件已处理过，本次不重复回复。",
      },
      markerCleanup: {
        attempted: false,
        status: "not_needed",
        messageContractOk: true,
        note: "重复事件无需清理状态标记。",
      },
      runtimeTask: null,
    };
  }

  function previouslyRepliedToMessage(messageIdDigest = "") {
    const records = typeof store.readMessageTests === "function" ? store.readMessageTests() : [];
    return records.some((record) => (
      record.sourceMessageIdDigest === messageIdDigest &&
      isDuplicateGuardStatus(record.status || record.delivery?.status || "")
    ));
  }

  function isDuplicateGuardStatus(status = "") {
    return DUPLICATE_GUARD_STATUSES.has(cleanShortText(status));
  }

  function recordCoalescedFragment({
    action = "buffered",
    eventRecordId = "",
    messageEvent = {},
    messageId = "",
    messageIdDigest = "",
    now = new Date().toISOString(),
    receiveMode = "",
    reason = "",
    senderId = "",
    submittedBy = {},
    pendingFragmentCount = 0,
  } = {}) {
    const chatId = cleanShortText(messageEvent.message?.chat_id);
    const waitingForIntent = reason === "pending_turn_waiting_for_intent";
    const buffered = action === "buffered";
    const delivery = {
      mode: "feishu_inbound_turn_coalescing",
      sent: false,
      status: waitingForIntent
        ? "pending_turn_waiting_for_intent"
        : buffered
          ? "fragment_buffered_in_pending_turn"
          : "fragment_coalesced_into_turn",
      messageContractOk: true,
      note: waitingForIntent
        ? "输入片段已进入同会话 pending turn；尚未封口，因此不会创建任务、调用模型或发送文字回复。"
        : buffered
          ? "输入片段已追加到同会话 pending turn；等待 quiet window 封口，不会单独创建任务或回复。"
          : "输入片段已合并到同会话的后续 Agent turn；不会单独创建任务或回复。",
    };
    if (eventRecordId && typeof store.saveMessageTest === "function") {
      store.saveMessageTest({
        id: eventRecordId,
        contractVersion: CONTRACT_VERSION,
        employeeId: targetEmployeeId,
        employeeName: targetEmployeeName,
        sourceSystemId: SOURCE_SYSTEM_ID,
        sceneType: receiveMode === "websocket_long_connection" ? "飞书长连接输入片段" : "飞书输入片段回调",
        requestScope: "飞书会话输入聚合",
        channelIntent: "pending_user_turn",
        channelIntentLabel: "同会话输入聚合",
        sourceMessageIdDigest: messageIdDigest,
        sourceMessageIdMasked: maskIdentifier(messageId),
        sourceChatIdMasked: maskIdentifier(chatId),
        sourceSenderIdMasked: maskIdentifier(senderId),
        status: delivery.status,
        messageContractOk: true,
        delivery,
        submittedBy,
        submittedAt: now,
        updatedAt: now,
        warnings: [`pending turn 当前包含 ${Number(pendingFragmentCount) || 1} 个片段；只在服务端短时内存聚合，不持久化文件 key、文件内容、用户原话、raw prompt 或模型 trace。`],
      });
    }
    return {
      ok: true,
      status: delivery.status,
      eventStatus: delivery.status,
      reply: publicReaction(delivery),
      marker: publicReaction(delivery),
      agentTurn: {
        ok: false,
        status: delivery.status,
        reason: waitingForIntent ? "awaiting_turn_intent" : buffered ? "pending_turn_collecting" : "coalesced_into_later_turn",
        text: "",
      },
      agentReply: delivery,
      markerCleanup: {
        attempted: false,
        status: "not_needed",
        messageContractOk: true,
        note: "输入聚合阶段不发送正式回复。",
      },
      runtimeTask: null,
    };
  }

  function ignoreGroupMessage({ reason = "group_message_not_activated" } = {}) {
    const notAllowlisted = reason === "group_not_allowlisted";
    const status = notAllowlisted ? "group_message_not_allowlisted" : "group_message_not_activated";
    const delivery = {
      mode: "feishu_group_ingress_guard",
      sent: false,
      status,
      messageContractOk: true,
      note: notAllowlisted
        ? "该群不在当前数字员工的精确群白名单中，消息未进入会话或任务。"
        : "群消息未精确 @ 当前机器人，消息未进入会话或任务。",
    };
    return {
      ok: true,
      status,
      eventStatus: status,
      reply: publicReaction(delivery),
      marker: publicReaction(delivery),
      agentTurn: {
        ok: false,
        status,
        reason: cleanShortText(reason),
        text: "",
      },
      agentReply: delivery,
      markerCleanup: {
        attempted: false,
        status: "not_needed",
        messageContractOk: true,
        note: "群入口门禁在会话、任务、模型和 Tool 之前结束处理。",
      },
      runtimeTask: null,
    };
  }

  function ignoreGroupBroadcastMention({
    eventRecordId = "",
    messageEvent = {},
    messageId = "",
    messageIdDigest = "",
    now = new Date().toISOString(),
    receiveMode = "",
    senderId = "",
    submittedBy = {},
  } = {}) {
    const chatId = cleanShortText(messageEvent.message?.chat_id);
    const delivery = {
      mode: "feishu_group_broadcast_guard",
      sent: false,
      status: "broadcast_mention_ignored",
      messageContractOk: true,
      note: `群聊 @所有人 不触发${targetEmployeeName}；请直接 @机器人或单聊机器人提交任务。`,
    };
    if (eventRecordId && typeof store.saveMessageTest === "function") {
      store.saveMessageTest({
        id: eventRecordId,
        contractVersion: CONTRACT_VERSION,
        employeeId: targetEmployeeId,
        employeeName: targetEmployeeName,
        sourceSystemId: SOURCE_SYSTEM_ID,
        sceneType: receiveMode === "websocket_long_connection" ? "飞书长连接群广播忽略" : "飞书群广播事件忽略",
        requestScope: "飞书群聊触发保护",
        channelIntent: "group_broadcast_guard",
        channelIntentLabel: "@所有人不触发",
        sourceMessageIdDigest: messageIdDigest,
        sourceMessageIdMasked: maskIdentifier(messageId),
        sourceChatIdMasked: maskIdentifier(chatId),
        sourceSenderIdMasked: maskIdentifier(senderId),
        status: delivery.status,
        messageContractOk: true,
        delivery,
        submittedBy,
        submittedAt: now,
        updatedAt: now,
        warnings: ["群聊广播 mention 只记录脱敏忽略状态；不保存用户原话、raw prompt、模型 trace 或执行 payload。"],
      });
    }
    return {
      ok: true,
      status: delivery.status,
      eventStatus: delivery.status,
      reply: publicReaction(delivery),
      marker: publicReaction(delivery),
      agentTurn: {
        ok: false,
        status: delivery.status,
        reason: "group_broadcast_mention",
        text: "",
      },
      agentReply: delivery,
      markerCleanup: {
        attempted: false,
        status: "not_needed",
        messageContractOk: true,
        note: "群聊 @所有人已被触发规则拦截，不发送处理中状态。",
      },
      runtimeTask: null,
    };
  }

  async function runApprovedToolConfirmationIfPossible({
    connection = {},
    decision = {},
    materialToolExecutor = null,
    operationReceiptContext = null,
    runtimeContext = {},
    runtimeTask = null,
    resourceSetup = {},
    signal = null,
  } = {}) {
    const approvedToolCall = effectiveTurnDispatcher.approvedToolCall?.({
      confirmation: decision.turn?.toolConfirmation,
      context: decision.turn?.confirmationContext,
    });
    if (!approvedToolCall) {
      return {
        ok: false,
        status: "agent_turn_blocked",
        reason: "tool_confirmation_execution_not_verified",
        text: "确认已收到，但本次确认记录已失效、已使用或与当前执行上下文不匹配；系统不会执行外部写操作。请重新发起并使用最新确认卡。",
        safeSummary: {
          employeeId: targetEmployeeId,
          runtime: "tool_confirmation_direct_execution",
          agentRuntime: {
            adapter: "governed_tool_execution",
            mode: "tool_confirmation_direct_execution",
            realModelRequested: false,
            status: "tool_confirmation_execution_not_verified",
            blockedReason: "tool_confirmation_execution_not_verified",
            requestCount: 0,
            toolCallCount: 0,
            usage: {},
          },
        },
      };
    }
    if (typeof effectiveTurnDispatcher.runApprovedToolCall !== "function" || typeof createToolExecutor !== "function") {
      return {
        ok: false,
        status: "agent_turn_blocked",
        reason: "approved_tool_call_executor_unavailable",
        text: "确认已收到，但当前运行器不能执行已确认 Tool；系统不会复用本次确认。",
        safeSummary: {
          employeeId: targetEmployeeId,
          runtime: "tool_confirmation_direct_execution",
          agentRuntime: {
            adapter: "governed_tool_execution",
            mode: "tool_confirmation_direct_execution",
            realModelRequested: false,
            status: "approved_tool_call_executor_unavailable",
            blockedReason: "approved_tool_call_executor_unavailable",
            requestCount: 0,
            toolCallCount: 0,
            usage: {},
          },
        },
      };
    }
    const executionTask = runtimeTask
      ? Object.freeze({ ...runtimeTask, id: canonicalRuntimeTaskId(runtimeTask) })
      : null;
    const admission = runtimeTaskService?.readExecutionAdmission?.(canonicalRuntimeTaskId(executionTask)) || null;
    const currentUserToolProfile = resolveCurrentUserToolProfile && admission
      ? await resolveCurrentUserToolProfile({
        admission,
        employee: decision.authorizationEmployee || employeeForGateway(),
        employeeId: targetEmployeeId,
        signal,
        subjectId: admission.actorLocator?.subjectId,
      })
      : null;
    const executionIdentity = admission
      ? currentUserToolExecutionIdentityFromFeishuAdmission({
        admission,
        profile: currentUserToolProfile,
        task: executionTask,
      })
      : null;
    const toolExecutor = await createToolExecutor({
      admission,
      decision,
      employee: decision.authorizationEmployee || employeeForGateway(),
      executionIdentity,
      materialToolExecutor,
      runtimeTask: executionTask,
      signal,
    });
    return effectiveTurnDispatcher.runApprovedToolCall({
      approvedToolCall,
      decision,
      runtimeContext: {
        ...runtimeContext,
        safeContext: {
          ...(runtimeContext.safeContext || {}),
          toolAccess: {
            mode: "agent_selected_governed_tools",
            availableTools: toolExecutor?.safeToolCatalog?.() || [],
            inputIds: toolExecutor?.availableInputIds?.() || [],
          },
        },
      },
      runtimeInput: {
        connection,
        materialToolExecutor,
        operationReceiptContext,
        resourceSetup,
        runtimeTask: executionTask,
        signal,
        toolExecutor,
      },
    });
  }

  async function runAgentTurnIfPossible({
    connection = {},
    decision = {},
    materialToolExecutor = null,
    messageEvent = {},
    onTextDelta = null,
    operationReceiptContext = null,
    runtimeContext = {},
    runtimeTask = null,
    resourceSetup = {},
    signal = null,
  } = {}) {
    if (!effectiveTurnDispatcher || typeof effectiveTurnDispatcher.runTurn !== "function") {
      return {
        ok: false,
        status: "agent_runtime_unavailable",
        reason: "agent_runtime_not_wired",
        text: `飞书 Channel 已收到消息，但${targetEmployeeName}的 AI agent runtime 还没有接入，不能冒充在职员工回答。`,
      };
    }
    try {
      return await effectiveTurnDispatcher.runTurn({
        decision,
        runtimeContext,
        runtimeInput: { connection, messageEvent, materialToolExecutor, onTextDelta, operationReceiptContext, runtimeTask, resourceSetup, signal },
      });
    } catch (error) {
      const failure = describeAgentRuntimeFailure(error);
      return {
        ok: false,
        status: "agent_runtime_failed",
        reason: failure.reason,
        text: failure.text,
        safeSummary: {
          employeeId: targetEmployeeId,
          runtime: "agent_runtime_failed",
          agentRuntime: {
            mode: "responses_api_agent_runtime",
            realModelRequested: true,
            status: failure.reason,
            blockedReason: failure.reason,
          },
        },
      };
    }
  }

  function attachAgentRuntimeEvidenceToTask({ task = null, agentTurn = {}, now = new Date().toISOString() } = {}) {
    if (!task || typeof store.saveRuntimeTask !== "function") return task;
    const evidence = agentTurn?.safeSummary?.agentRuntime;
    if (!evidence || typeof evidence !== "object" || !Object.keys(evidence).length) return task;
    const contractInvalid = ["model_request_invalid", "model_response_contract_invalid"].includes(cleanShortText(evidence.status));
    const nextGate = contractInvalid
      ? cleanShortText(evidence.status) === "model_request_invalid"
        ? "检查 Provider 适配器与 Tool schema 后重试；附件工具尚未执行。"
        : "模型网关恢复标准 Responses 响应后，重新发送处理指令；附件工具尚未执行。"
      : task.nextGate;
    return store.saveRuntimeTask({
      ...task,
      updatedAt: now,
      nextGate,
      execution: {
        ...(task.execution || {}),
        agentRuntime: evidence,
        ...(contractInvalid ? {
          resultSummary: cleanShortText(evidence.status) === "model_request_invalid"
            ? "Provider 拒绝了当前 Agent Tool 请求契约，附件工具尚未执行。"
            : "模型网关响应结构异常，附件工具尚未执行。",
          nextGate,
        } : {}),
      },
    });
  }

  function attachTurnDecisionToTask({ task = null, turnDecision = {}, now = new Date().toISOString() } = {}) {
    if (!task || typeof store.saveRuntimeTask !== "function") return task;
    return store.saveRuntimeTask({
      ...task,
      turnIntent: cleanShortText(turnDecision.turnIntent),
      responsePolicy: turnDecision.responsePolicy || {},
      runtimeAdapter: cleanShortText(turnDecision.runtimeAdapter || task.runtimeAdapter),
      updatedAt: now,
    });
  }

  function addMaterialIntakeNotice(agentTurn = {}, runtimeTask = null, messageEvent = {}) {
    const statuses = (runtimeTask?.materialRefs || []).map((item) => cleanShortText(item.intakeStatus));
    const processing = Array.isArray(runtimeTask?.materialProcessing) ? runtimeTask.materialProcessing : [];
    const completedSkill = processing.find((item) => item.skillId && /_completed$/.test(cleanShortText(item.status)));
    const preparedMaterial = processing.find((item) => ["temporary_material_ready", "temporary_model_input_ready"].includes(cleanShortText(item.status)));
    const failedMaterial = processing.find((item) => /failed|rejected|limit_exceeded|unavailable|not_available|not_installed/.test(cleanShortText(item.status)));
    const failedArchive = processing.find((item) => cleanShortText(item.toolId) === "safe-archive-intake" && /archive_.*(?:failed|rejected|limit_exceeded)/.test(cleanShortText(item.status)));
    let notice = "";
    if (completedSkill) {
      notice = agentTurn?.ok
        ? "附件已在受控临时工作区由已挂载 Skill 处理，算法运行时 Agent 已基于本轮真实证据完成后续分析。"
        : "附件已由已挂载 Skill 完成阶段性处理，但算法运行时 Agent 尚未完成最终回复。";
    } else if (preparedMaterial) {
      if (agentTurn?.ok) return agentTurn;
      notice = "附件已进入受控临时区；模型原生支持的格式会进入同一 Agent 回合，其他格式由已挂载 Tool 或 Skill 继续处理。";
    } else if (statuses.includes("download_too_large")) {
      notice = `该飞书附件超过 100 MB，受飞书消息资源接口限制，${targetEmployeeName}无法下载。请将资料拆成每个不超过 90 MB 的独立 ZIP；或提供已登记 Remote/集群的资源名称（或资源 ID）与只读数据路径；也可以提供对象存储 Dataset/Branch/版本。系统会先核验资源绑定、路径范围和读取授权，请勿发送账号、密码、token 或 SSH Key。`;
    } else if (statuses.includes("download_request_failed")) {
      notice = "附件下载请求未成功；请确认 im:message:readonly 已通过审批，且机器人仍在该消息所在会话中。";
    } else if (statuses.some((status) => /download_credentials/.test(status))) {
      notice = "附件下载暂不可用；服务端还不能取得可用于附件读取的飞书凭证。";
    } else if (failedArchive) {
      notice = "附件未能通过受控资料接入；请检查 ZIP 完整性、大小限制和目录结构后重试。";
    } else if (failedMaterial) {
      notice = cleanShortText(failedMaterial.nextGate || failedMaterial.summary) || "附件未能进入受控资料处理流程，请检查文件完整性、格式支持和读取权限后重试。";
    } else if (statuses.includes("temporary_downloaded")) {
      notice = "附件已在受控临时区下载；尚未自动解压、解析或提交给模型。";
    }
    if (!notice) return agentTurn;
    if (!completedSkill && !materialTroubleshootingRequested(messageEvent)) {
      return { ...agentTurn, text: notice };
    }
    return {
      ...agentTurn,
      text: [notice, agentTurn.text || "附件已收到，等待后续受控处理。"].join("\n\n"),
    };
  }

  function materialTroubleshootingRequested(messageEvent = {}) {
    const text = extractTextMessageContent(messageEvent.message?.content);
    return /为什么|为何|原因|怎么(办|处理|排查)|如何(排查|处理)|排查|诊断|报错|错误|权限|日志|配置|缺什么|需要什么材料|debug/i.test(text);
  }

  function materialConversationText(runtimeTask = null) {
    const names = (runtimeTask?.materialRefs || []).map((item) => cleanShortText(item.name)).filter(Boolean);
    return names.length ? `用户发送附件：${names.join(" / ")}` : "用户发送了待处理附件。";
  }

  function buildQueueFullRuntimeTask({
    employee = {},
    materialMessages = [],
    queueAdmission = {},
    resourceSetup = {},
    turnDecision = {},
    now: submittedAt = new Date().toISOString(),
  } = {}) {
    const queuePolicy = queueAdmission.policy?.totalTaskCapacity
      ? queueAdmission.policy
      : runtimeQueuePolicyForEmployee(employee);
    const nextGate = cleanShortText(queueAdmission.nextGate || queueAdmission.message) ||
      taskQueueFullNoticeText(queuePolicy, queueAdmission.queueState || {});
    const materialRefs = materialMessages.flatMap(extractMaterialRefsFromFeishuMessage);
    const employeeName = cleanShortText(employee.name || employee.displayName || targetEmployeeName || "数字员工");
    return {
      id: "",
      contractVersion: RUNTIME_TASK_CONTRACT_VERSION,
      employeeId: cleanShortText(employee.id) || targetEmployeeId,
      employeeName,
      sourceSystemId: SOURCE_SYSTEM_ID,
      turnIntent: cleanShortText(turnDecision.turnIntent),
      responsePolicy: turnDecision.responsePolicy || {},
      runtimeAdapter: cleanShortText(turnDecision.runtimeAdapter),
      taskType: materialRefs.length ? "package_intake_analysis" : "digital_employee_chat",
      taskTitle: `飞书${employeeName}任务未接收`,
      problemSummary: "模型容量保护拒收；用户原话未保存。",
      status: "queue_full",
      statusLabel: "队列已满",
      queueLane: "execution_task_v1",
      queuePolicy,
      queueStateAtAdmission: queueAdmission.queueState || {},
      invocationCheck: {
        status: "rejected",
        outcome: "queue_capacity_full",
        reason: "runtime_queue_full",
        nextGate,
      },
      execution: {
        mode: "execution_task_v1_admission",
        status: "rejected",
        resultSummary: "Model capacity was full before canonical task creation.",
      },
      materialRefs,
      requiredResourceIds: Array.isArray(resourceSetup.requiredResourceIds) ? resourceSetup.requiredResourceIds : [],
      nextGate,
      submittedAt,
      updatedAt: submittedAt,
      warnings: ["模型容量保护未创建执行任务；不保存用户原话、raw prompt、模型 trace、Tool 凭证或执行 payload。"],
    };
  }

  function buildQueuePolicyAgentTurn(runtimeTask = null) {
    if (!runtimeTask || runtimeTask.status !== "queue_full") return null;
    return {
      ok: false,
      status: "task_queue_full",
      reason: "runtime_queue_full",
      text: runtimeTask.nextGate || taskQueueFullNoticeText(runtimeTask.queuePolicy, runtimeTask.queueStateAtAdmission),
    };
  }

  function invocationCheckFromAgentTurn(agentTurn = {}) {
    if (agentTurn?.reason === "runtime_queue_full") {
      return {
        status: "rejected",
        outcome: "queue_capacity_full",
        reason: "runtime_queue_full",
        nextGate: agentTurn.text || taskQueueFullNoticeText(),
      };
    }
    if (agentTurn?.reason === "task_queue_wait_notice") {
      return {
        status: "allowed",
        outcome: "queue_wait_notice",
        reason: "task_queue_wait_notice",
        nextGate: agentTurn.text || "任务仍在队列中，等待 Worker 领取。",
      };
    }
    if (agentTurn?.ok) {
      return {
        status: "allowed",
        outcome: "ai_agent_runtime_reply",
        reason: agentTurn.reason || "feishu_agent_turn",
        nextGate: "AI agent 已完成本次飞书回复；已启用的运行器会自动处理后续任务。",
      };
    }
    return {
      status: "blocked",
      outcome: "agent_runtime_unavailable",
      reason: agentTurn?.reason || "agent_runtime_not_configured",
      nextGate: "飞书 Channel 已收到消息，但 AI agent runtime 尚未接入；请补齐运行器配置。",
    };
  }

  function scheduleQueueWaitNoticeIfNeeded({ runtimeTask = null, messageId = "", groupReplyMention = null, submittedBy = {} } = {}) {
    if (!runtimeTask || !isRuntimeTaskWaiting(runtimeTask) || !messageId) return;
    const policy = runtimeTask.queuePolicy?.totalTaskCapacity
      ? runtimeTask.queuePolicy
      : runtimeQueuePolicyForEmployee(employeeForGateway());
    const queuedAtMs = Date.parse(runtimeTask.queuedAt || runtimeTask.submittedAt);
    const noticeMs = policy.taskBufferMinutes * 60 * 1000;
    if (!Number.isFinite(queuedAtMs) || noticeMs <= 0) return;
    const delayMs = Math.max(0, queuedAtMs + noticeMs - Date.now());
    const timer = setTimeout(async () => {
      const currentTask = typeof store.readRuntimeTasks === "function"
        ? store.readRuntimeTasks().find((task) => task.id === runtimeTask.id)
        : null;
      if (!currentTask || !isRuntimeTaskWaiting(currentTask)) return;
      const nextGate = taskTimeoutNoticeText(policy);
      await sendAgentTurnReplyIfPossible({
        connection: store.readConnection(targetEmployeeId),
        messageId,
        groupReplyMention,
        runtimeTask: {
          ...currentTask,
          nextGate,
          submittedBy: currentTask.submittedBy || submittedBy,
        },
        agentTurn: {
          ok: false,
          status: "task_queue_wait_notice",
          reason: "task_queue_wait_notice",
          text: nextGate,
        },
      });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function scheduleTaskFeedbackArchiveIfNeeded({ runtimeTask = null } = {}) {
    if (!runtimeTask || !isRuntimeTaskFeedbackArchivePending(runtimeTask)) return;
    const delayMs = runtimeTaskFeedbackArchiveDelay(runtimeTask);
    if (!Number.isFinite(delayMs)) return;
    const timer = setTimeout(() => {
      const currentTask = typeof store.readRuntimeTasks === "function"
        ? store.readRuntimeTasks().find((task) => task.id === runtimeTask.id)
        : null;
      if (!currentTask) return;
      archiveRuntimeTaskFeedbackIfDue({
        store,
        task: currentTask,
        now: new Date().toISOString(),
      });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function feishuGroupReplyMention(messageEvent = {}) {
    const message = messageEvent.message || {};
    const sender = messageEvent.sender || {};
    const chatType = cleanShortText(message.chat_type || message.chatType).toLowerCase();
    const senderId = cleanShortText(
      sender.sender_id?.open_id ||
      sender.sender_id?.user_id ||
      sender.sender_id?.union_id
    );
    if (!senderId || !/group|chat|room/.test(chatType) || chatType === "p2p") return null;
    return { userId: senderId };
  }

  function publicCardFeedback(feedback = {}) {
    return {
      answerId: cleanShortText(feedback.answerId),
      rating: cleanShortText(feedback.rating),
      taskId: cleanShortText(feedback.taskId),
      qualityEventId: cleanShortText(feedback.qualityEventId),
      qualityStatus: cleanShortText(feedback.qualityStatus),
      receivedAt: cleanShortText(feedback.receivedAt),
    };
  }

  function resolvePersistentTaskExecutor(task) {
    if (task?.channelId !== "feishu" || task.employeeId !== targetEmployeeId) return null;
    if (task.taskType === "package_intake_analysis") {
      return (ownership) => recoverPersistentFeishuTextTask(task, ownership, { materialRequired: true });
    }
    if (task.taskType !== "digital_employee_chat") return null;
    return (ownership) => recoverPersistentFeishuTextTask(task, ownership);
  }

  async function recoverPersistentFeishuTextTask(task, ownership, { materialRequired = false } = {}) {
    const admission = runtimeTaskService?.readExecutionAdmission?.(task.taskId);
    if (!admission) return persistentBlockedSettlement("execution_task_admission_unavailable");
    if (!feishuAdmissionMatchesTask(admission, task)) {
      return persistentBlockedSettlement("execution_task_admission_binding_mismatch");
    }
    const employee = employeeForGateway();
    if (!employee.id || String(employee.version || "") !== task.employeeVersion) {
      return persistentBlockedSettlement("execution_task_input_employee_version_changed");
    }
    const connection = store.readConnection?.(targetEmployeeId) || {};
    const connectionRecoveryError = feishuConnectionRecoveryError({ admission, connection, employeeId: targetEmployeeId, store });
    if (connectionRecoveryError) return persistentBlockedSettlement(connectionRecoveryError);
    const actorRouteProbe = createSessionRoute({
      accountId: "feishu-actor-revalidation",
      actorIssuer: task.actorIssuer,
      actorSubjectId: admission.actorLocator.subjectId,
      channelId: "feishu",
      conversationId: "feishu-actor-revalidation",
      conversationType: "direct",
      employeeId: targetEmployeeId,
    });
    if (actorRouteProbe.actorSubjectDigest !== task.actorSubjectDigest) {
      return persistentBlockedSettlement("execution_task_actor_binding_mismatch");
    }
    const turn = { text: "pending", messageType: materialRequired ? "file" : "text", hasMaterial: materialRequired };
    const policyProbe = effectiveTurnDispatcher.prepareTurn({ connection, employee, priorSessionReferences: [], turn });
    const permissionDigest = feishuExecutionPermissionDigest(connection, employee, policyProbe.invocationCheck?.status);
    if (!policyProbe.runtimeEligible || permissionDigest !== admission.permissionDigest) {
      return persistentBlockedSettlement(policyProbe.invocationCheck?.reason || "execution_task_permission_changed");
    }
    const route = await sessionRepository.readVerifiedRoute(task.sessionId).catch(() => null);
    const currentSession = route ? await sessionRepository.readCurrentSession(route).catch(() => null) : null;
    if (!route || route.routeDigest !== admission.routeBinding.routeDigest || currentSession?.sessionId !== task.sessionId) {
      return persistentBlockedSettlement("execution_task_session_rotated");
    }
    let resolved;
    try {
      resolved = await executionInputResolver.resolve(task);
    } catch (error) {
      return persistentBlockedSettlement(error?.code || "execution_task_input_unavailable");
    }
    if (ownership.isCancellationRequested()) return persistentBlockedSettlement("agent_turn_canceled");
    const contextSource = await prepareRuntimeContextSource({
      checkpointRepository,
      excludeEntryId: task.executionInputRef.refId,
      expectedSessionId: task.sessionId,
      route: resolved.route,
      sessionRepository,
    });
    const existingResult = await readRuntimeConversationResult({
      expectedSessionId: task.sessionId,
      source: contextSource,
      taskId: task.taskId,
    });
    if (existingResult?.message?.role === "assistant") {
      if (!ownership.appendResultAvailable?.()) return persistentBlockedSettlement("execution_task_ownership_lost");
      return { settlement: { status: "completed", resultSummary: "Persistent Feishu text result already existed in Session Foundation." } };
    }
    const materialBinding = runtimeTaskService?.readTaskMaterialBinding?.(task.taskId, { tenantScope: task.tenantScope }) || null;
    if (materialRequired && !materialBinding) return persistentBlockedSettlement("task_material_binding_unavailable");
    if (materialBinding && !feishuTaskMaterialBindingMatchesScope(materialBinding, { admission, task })) {
      return persistentBlockedSettlement("task_material_binding_scope_mismatch");
    }
    let materialResources = [];
    try {
      materialResources = materialBinding?.sourceKind === "channel_resource" ? feishuResourcesFromTaskMaterialBinding(materialBinding) : [];
    } catch (error) {
      return persistentBlockedSettlement(error?.code || "feishu_material_binding_invalid");
    }
    if (materialRequired && materialBinding?.sourceKind !== "channel_resource") {
      return persistentBlockedSettlement("feishu_material_binding_invalid");
    }
    let predecessorReference = null;
    if (materialBinding?.sourceKind === "predecessor_task_input") {
      if (materialRequired || admission.actorLocator?.conversationType !== "direct") {
        return persistentBlockedSettlement("feishu_material_lineage_not_allowed");
      }
      const sourceBinding = runtimeTaskService?.readTaskMaterialBinding?.(materialBinding.sourceTaskId, { tenantScope: task.tenantScope });
      const sourceTask = runtimeTaskService?.readCanonicalExecutionTask?.(materialBinding.sourceTaskId, { tenantScope: task.tenantScope });
      if (!sourceBinding || sourceBinding.bindingDigest !== materialBinding.sourceBindingDigest || sourceTask?.status !== "completed" ||
        !sameFeishuMaterialOwner(sourceBinding, materialBinding) || !sameFeishuTaskOwner(sourceTask, task)) {
        return persistentBlockedSettlement("feishu_material_lineage_invalid");
      }
      predecessorReference = {
        taskId: sourceTask.taskId,
        status: sourceTask.status,
        taskType: sourceTask.taskType,
        updatedAt: sourceTask.updatedAt,
        materialHandles: [],
      };
    }
    const workspace = materialBinding?.sourceKind === "channel_resource"
      ? await effectiveWorkspaceManager.workspaceForTask(task.taskId, { create: true })
      : materialBinding?.sourceKind === "predecessor_task_input"
        ? await effectiveWorkspaceManager.forkTaskWorkspace(materialBinding.sourceTaskId, task.taskId)
        : null;
    if (materialRequired && !workspace) return persistentBlockedSettlement("task_material_workspace_unavailable");
    const confirmationContext = {
      actorId: admission.actorLocator.subjectId,
      employeeId: targetEmployeeId,
      sessionKey: task.sessionId,
    };
    const decision = effectiveTurnDispatcher.prepareTurn({
      runtimeTask: task,
      connection,
      employee: resolved.employee,
      priorSessionReferences: [],
      turn: { ...turn, text: resolved.userText, confirmationContext },
    });
    if (!decision.runtimeEligible) return persistentBlockedSettlement(decision.invocationCheck?.reason || "execution_task_invocation_blocked");
    const skillRuntimeProjection = !workspace ? null : await resolveSkillRuntimeProjection({
      skillHarnessRunner,
      runtimeTask: task,
      skillScope: decision.dependencyContext?.skillScope,
    });
    const materialToolExecutor = workspace ? createFeishuMaterialToolExecutor({
      authorizeToolCall: (toolCall) => effectiveTurnDispatcher.authorizeToolCall?.({ decision, toolCall }),
      connection,
      employee: resolved.employee,
      fetch,
      readSecret: (key) => store.readSecret(key, targetEmployeeId),
      resources: materialResources,
      skillHarnessRunner: skillRuntimeProjection?.skillHarnessRunner || skillHarnessRunner,
      skillScope: decision.dependencyContext?.skillScope,
      verifiedHarnessSkillIds: skillRuntimeProjection?.verifiedHarnessSkillIds,
      validateFeishuCredentials,
      workspace,
      workspaceManager: effectiveWorkspaceManager,
      workspaceTaskId: task.taskId,
    }) : null;
    const executionTask = ownership?.task || task;
    const runtimeTask = Object.freeze({ ...executionTask, id: executionTask.taskId });
    const currentUserToolProfile = resolveCurrentUserToolProfile
      ? await resolveCurrentUserToolProfile({
          admission,
          employee: resolved.employee,
          employeeId: targetEmployeeId,
          signal: ownership.signal,
          subjectId: admission.actorLocator?.subjectId,
        })
      : null;
    const executionIdentity = currentUserToolExecutionIdentityFromFeishuAdmission({
      admission,
      profile: currentUserToolProfile,
      task: executionTask,
    });
    const toolExecutor = createToolExecutor
      ? await createToolExecutor({
          admission,
          decision,
          employee: resolved.employee,
          executionIdentity,
          materialToolExecutor,
          runtimeTask,
          signal: ownership.signal,
        })
      : materialToolExecutor;
    const continuationIdentity = {
      employeeId: task.employeeId,
      routeDigest: contextSource.route.routeDigest,
      sessionId: task.sessionId,
    };
    const toolParameterContinuation = toolParameterContinuationRepository?.continuationForExecutionInput?.(
      task.executionInputRef.refId,
      continuationIdentity,
    ) || null;
    const channelPresentationEvidence = toolParameterContinuationRepository?.presentationEvidenceForExecutionInput?.(
      task.executionInputRef.refId,
      continuationIdentity,
    ) || toolParameterContinuationRepository?.latestPresentationEvidence?.(continuationIdentity) || null;
    const runtimeContext = assembleRuntimeTurnContext({
      decision,
      dependencyContext: decision.dependencyContext,
      materialToolExecutor,
      toolExecutor,
      priorSessionReferences: predecessorReference ? [predecessorReference] : [],
      resourceSetup: { ready: true },
      runtimeTask,
      session: contextSource.session,
      turn: {
        ...turn,
        text: resolved.userText,
        confirmationContext,
      },
    });
    runtimeContext.contextSource = contextSource;
    runtimeContext.toolParameterContinuation = toolParameterContinuation;
    runtimeContext.channelPresentationEvidence = channelPresentationEvidence;
    if (!ownership.appendProgress?.({
      eventKey: "provider:started",
      stage: "provider",
      status: "running",
      code: "provider_started",
    })) return persistentBlockedSettlement("execution_task_ownership_lost");
    const agentTurn = await effectiveTurnDispatcher.runTurn({
      decision,
      runtimeContext,
      runtimeInput: {
        connection,
        materialToolExecutor,
        onTextDelta: null,
        operationReceiptContext: operationReceiptContextForExecutionOwnership(ownership),
        runtimeTask,
        resourceSetup: { ready: true },
        signal: ownership.signal,
        toolExecutor,
      },
    });
    if (ownership.isCancellationRequested()) return persistentBlockedSettlement("agent_turn_canceled");
    if (!agentTurn?.ok) return persistentBlockedSettlement(agentTurn?.reason || "agent_turn_blocked");
    if (agentTurn.toolParameterCards?.length && !toolParameterContinuationRepository?.saveDraft) {
      return persistentBlockedSettlement("tool_parameter_continuation_repository_unavailable");
    }
    for (const card of agentTurn.toolParameterCards || []) {
      try {
        toolParameterContinuationRepository.saveDraft({
          card,
          employeeId: task.employeeId,
          routeDigest: contextSource.route.routeDigest,
          sessionId: task.sessionId,
          sourceTaskId: canonicalRuntimeTaskId(task),
        });
      } catch (error) {
        return persistentBlockedSettlement(error?.code || "tool_parameter_card_persistence_failed");
      }
    }
    if (!toolExecutor && Number(agentTurn?.safeSummary?.agentRuntime?.toolCallCount || 0) > 0) {
      return persistentBlockedSettlement("tool_execution_deferred_c004");
    }
    if (materialRequired) {
      const materialPatch = materialToolExecutor.taskPatch();
      const materialStatuses = [
        ...Object.values(materialPatch.statusByDigest),
        ...materialPatch.toolResults.map((item) => cleanShortText(item.status)),
      ];
      const materialReady = materialStatuses.some((status) =>
        ["temporary_material_ready", "temporary_model_input_ready"].includes(status) || /_completed$/.test(status));
      if (!materialReady) {
        return {
          agentTurn,
          settlement: {
            status: "blocked",
            lastErrorCode: "material_recovery_unavailable",
            resultSummary: "Material task did not produce verified governed input preparation evidence.",
          },
        };
      }
    }
    if (!ownership.appendProgress?.({
      eventKey: "provider:completed",
      stage: "provider",
      status: "completed",
      code: "provider_completed",
    })) return persistentBlockedSettlement("execution_task_ownership_lost");
    await recordRuntimeConversationTurn({
      commitGuard: () => !ownership.isCancellationRequested(),
      expectedSessionId: task.sessionId,
      source: contextSource,
      turnId: task.taskId,
      turn: {
        assistantText: agentTurn.text,
        taskId: task.taskId,
        toolCalls: agentTurn.toolCalls,
      },
    });
    if (ownership.isCancellationRequested()) return persistentBlockedSettlement("agent_turn_canceled");
    if (!ownership.appendResultAvailable?.()) return persistentBlockedSettlement("execution_task_ownership_lost");
    return {
      agentTurn,
      settlement: { status: "completed", resultSummary: "Persistent Feishu text task completed after current policy revalidation." },
    };
  }

  return {
    addFeishuProcessingReactionIfPossible,
    recordFeishuEvent,
    resolvePersistentTaskExecutor,
    unwrapEncryptedEvent,
    verifyEventToken,
  };

}

function readChannelPresentationEvidence({
  allowSessionFallback = false,
  executionInputRefId = "",
  identity = {},
  repository = null,
} = {}) {
  const exact = repository?.presentationEvidenceForExecutionInput?.(executionInputRefId, identity) || null;
  if (exact || !allowSessionFallback) return exact;
  return repository?.latestPresentationEvidence?.(identity) || null;
}

function feishuAdmissionMatchesTask(admission = {}, task = {}) {
  const binding = admission.routeBinding || {};
  return admission.taskId === task.taskId &&
    admission.channelId === task.channelId &&
    admission.employeeVersion === task.employeeVersion &&
    admission.actorLocator?.identitySource === "feishu" &&
    admission.actorLocator?.subjectIdType === "feishu_sender_id" &&
    Boolean(admission.actorLocator?.conversationId) &&
    Boolean(admission.actorLocator?.conversationType) &&
    binding.tenantScope === task.tenantScope &&
    binding.actorIssuer === task.actorIssuer &&
    binding.actorSubjectDigest === task.actorSubjectDigest &&
    binding.employeeId === task.employeeId &&
    binding.sessionId === task.sessionId &&
    binding.entryId === task.executionInputRef?.refId;
}

function feishuTaskMaterialBindingMatchesScope(binding = {}, { admission = {}, task = {} } = {}) {
  const adapterMatches = binding.sourceKind === "channel_resource"
    ? binding.adapterId === FEISHU_MATERIAL_BINDING_ADAPTER_ID
    : binding.sourceKind === "predecessor_task_input" && binding.adapterId === PREDECESSOR_TASK_INPUT_ADAPTER_ID;
  return binding.contractVersion === "task-material-binding.v1" && adapterMatches &&
    binding.taskId === task.taskId &&
    binding.tenantScope === task.tenantScope &&
    binding.actorIssuer === task.actorIssuer &&
    binding.actorSubjectDigest === task.actorSubjectDigest &&
    binding.employeeId === task.employeeId &&
    binding.employeeVersion === task.employeeVersion &&
    binding.sessionId === task.sessionId &&
    binding.channelId === task.channelId &&
    binding.routeDigest === admission.routeBinding?.routeDigest &&
    binding.transcriptEntryId === task.executionInputRef?.refId;
}

function sameFeishuMaterialOwner(left = {}, right = {}) {
  return left.tenantScope === right.tenantScope && left.actorIssuer === right.actorIssuer &&
    left.actorSubjectDigest === right.actorSubjectDigest && left.employeeId === right.employeeId &&
    left.employeeVersion === right.employeeVersion && left.sessionId === right.sessionId && left.channelId === right.channelId;
}

function sameFeishuTaskOwner(left = {}, right = {}) {
  return left.tenantScope === right.tenantScope && left.actorIssuer === right.actorIssuer &&
    left.actorSubjectDigest === right.actorSubjectDigest && left.employeeId === right.employeeId &&
    left.sessionId === right.sessionId && left.channelId === right.channelId;
}

function feishuConnectionRecoveryError({ admission = {}, connection = {}, employeeId = "", store = null } = {}) {
  const credentialOk = ["validated", "skipped_for_local_test"].includes(connection.tokenCheck?.status);
  const workerBinding = connection.workerBinding || {};
  const disallowedWorkerState = ["worker_failed", "worker_stopped"].includes(workerBinding.status);
  let governedChatRefs = [];
  try {
    governedChatRefs = JSON.parse(store?.readSecret?.("allowedChatRefs", employeeId) || "[]");
  } catch {
    governedChatRefs = [];
  }
  const allowedDigests = governedChatRefs.map((item) => digestValue(item?.feishuId)).filter(Boolean);
  const actorLocator = admission.actorLocator || {};
  const routeAllowed = actorLocator.conversationType === "direct"
    ? Boolean(actorLocator.subjectId)
    : actorLocator.conversationType === "group" && allowedDigests.includes(digestValue(actorLocator.conversationId));
  if (connection.employeeId !== employeeId || connection.applicationEnabled !== true) return "feishu_registration_revoked";
  if (!credentialOk || !store?.readSecret?.("appId", employeeId) || !store?.readSecret?.("appSecret", employeeId)) {
    return "feishu_connection_credential_unavailable";
  }
  if (workerBinding.employeeId !== employeeId || !workerBinding.status || disallowedWorkerState) {
    return "feishu_worker_binding_unavailable";
  }
  if (!routeAllowed) return "feishu_route_authorization_revoked";
  return "";
}

function feishuExecutionPermissionDigest(connection = {}, employee = {}, invocationStatus = "") {
  return crypto.createHash("sha256").update(JSON.stringify({
    applicationEnabled: connection.applicationEnabled === true,
    appIdDigest: connection.appIdDigest || "",
    channelIntentIds: [...(connection.channelIntentIds || [])].map(cleanShortText).filter(Boolean).sort(),
    credentialStatus: connection.tokenCheck?.status || "",
    employeeId: connection.employeeId || "",
    employeeVersion: employee.version || "",
    invocationStatus: cleanShortText(invocationStatus),
    workerBoundAt: connection.workerBinding?.boundAt || "",
    workerEmployeeId: connection.workerBinding?.employeeId || "",
    workerRouteKey: connection.workerBinding?.routeKey || "",
  })).digest("hex");
}

function persistentBlockedSettlement(code = "execution_task_blocked") {
  return {
    settlement: {
      status: "blocked",
      lastErrorCode: cleanShortText(code) || "execution_task_blocked",
      resultSummary: "Persistent Feishu execution stopped at a governed recovery boundary.",
    },
  };
}

function persistentGatewayError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function persistentGatewayFailureTurn(error, employeeName) {
  const code = cleanShortText(error?.code || "execution_task_unavailable");
  return {
    ok: false,
    status: code === "execution_task_wait_timeout" ? "task_queued" : "agent_runtime_unavailable",
    reason: code,
    text: code === "execution_task_wait_timeout"
      ? `「${employeeName}」已接收任务，后台队列仍在处理；当前飞书消息不会自动重复投递。`
      : `「${employeeName}」已停止本次处理；请在运行台账查看安全状态后重试。`,
    safeSummary: { runtime: "persistent_execution_task", blockedReason: code },
  };
}

function canonicalRuntimeTaskId(task = {}) {
  return cleanShortText(task.taskId || task.id);
}

function toolConfirmationFromPendingSubmission(submission = null) {
  const value = submission?.confirmation || submission;
  if (value?.contractVersion !== "tool-call-confirmation.v1" || value?.decision !== "approved" || !value?.id) return null;
  return {
    contractVersion: "tool-call-confirmation.v1",
    id: cleanShortText(value.id),
    decision: "approved",
  };
}

function confirmationContextFromPendingSubmission(submission = null) {
  return safeConfirmationContext(submission?.confirmationContext);
}

function safeConfirmationContext(context = null) {
  const actorId = cleanText(context?.actorId, 500);
  const employeeId = cleanShortText(context?.employeeId);
  const sessionKey = cleanText(context?.sessionKey, 500);
  return employeeId && sessionKey ? { actorId, employeeId, sessionKey } : null;
}

function eventTypeOf(event = {}) {
  return cleanShortText(
    event.header?.event_type ||
    event.event?.event_type ||
    event.event_type ||
    event.type
  );
}

function combineMessageFragments(fragments = []) {
  const available = (Array.isArray(fragments) ? fragments : []).filter((fragment) => fragment?.messageEvent?.message);
  const primary = [...available].reverse().find((fragment) => fragment.hasIntent) || available.at(-1) || {};
  const messageEvent = primary.messageEvent || {};
  const text = available
    .map((fragment) => extractTextMessageContent(fragment.messageEvent?.message?.content))
    .filter(Boolean)
    .join("\n");
  return {
    ...messageEvent,
    message: {
      ...(messageEvent.message || {}),
      ...(text ? { content: JSON.stringify({ text }) } : {}),
    },
  };
}

export { createFeishuEventGateway, feishuExecutionPermissionDigest };
