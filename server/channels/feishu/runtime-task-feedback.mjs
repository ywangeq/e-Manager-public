import {
  archiveRuntimeTaskFeedbackIfDue as archiveRuntimeTaskFeedbackIfDueForChannel,
  isRuntimeTaskFeedbackArchivePending,
  markRuntimeTaskFeedbackDelivery as markRuntimeTaskFeedbackDeliveryForChannel,
  markRuntimeTaskFeedbackReceived as markRuntimeTaskFeedbackReceivedForChannel,
  refreshRuntimeTaskFeedbackArchives as refreshRuntimeTaskFeedbackArchivesForChannel,
  runtimeTaskFeedbackArchiveDelay as runtimeTaskFeedbackArchiveDelayForChannel,
} from "../../agent-runtime/runtime-task-feedback.mjs";

const FEISHU_FEEDBACK_CONTRACT_VERSION = "feishu-answer-feedback.v1";
const FEISHU_FEEDBACK_ARCHIVE_AFTER_HOURS = 6;
const FEISHU_FEEDBACK_POLICY_ID = "feishu_feedback_auto_archive_6h";
const FEISHU_FEEDBACK_SOURCE_CHANNEL = "feishu_app_bot";

function feishuFeedbackOptions(args = {}) {
  return {
    ...args,
    sourceChannel: args.sourceChannel || FEISHU_FEEDBACK_SOURCE_CHANNEL,
    feedbackContractVersion: args.feedbackContractVersion || FEISHU_FEEDBACK_CONTRACT_VERSION,
    policyId: args.policyId || FEISHU_FEEDBACK_POLICY_ID,
    autoArchiveAfterHours: args.autoArchiveAfterHours || FEISHU_FEEDBACK_ARCHIVE_AFTER_HOURS,
  };
}

function markRuntimeTaskFeedbackDelivery(args = {}) {
  return markRuntimeTaskFeedbackDeliveryForChannel(feishuFeedbackOptions(args));
}

function markRuntimeTaskFeedbackReceived(args = {}) {
  return markRuntimeTaskFeedbackReceivedForChannel(feishuFeedbackOptions(args));
}

function refreshRuntimeTaskFeedbackArchives(args = {}) {
  return refreshRuntimeTaskFeedbackArchivesForChannel(feishuFeedbackOptions(args));
}

function archiveRuntimeTaskFeedbackIfDue(args = {}) {
  return archiveRuntimeTaskFeedbackIfDueForChannel(feishuFeedbackOptions(args));
}

function runtimeTaskFeedbackArchiveDelay(task = {}, nowMs = Date.now(), options = {}) {
  return runtimeTaskFeedbackArchiveDelayForChannel(task, nowMs, feishuFeedbackOptions(options));
}

export {
  FEISHU_FEEDBACK_ARCHIVE_AFTER_HOURS,
  archiveRuntimeTaskFeedbackIfDue,
  isRuntimeTaskFeedbackArchivePending,
  markRuntimeTaskFeedbackDelivery,
  markRuntimeTaskFeedbackReceived,
  refreshRuntimeTaskFeedbackArchives,
  runtimeTaskFeedbackArchiveDelay,
};
