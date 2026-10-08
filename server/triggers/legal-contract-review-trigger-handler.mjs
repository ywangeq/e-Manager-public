import { readFile } from "node:fs/promises";
import {
  TRIGGER_MATERIAL_REVIEW_SKILL_RESULT_CONTRACT_VERSION,
  createMaterialReviewWritebackTriggerHandler,
} from "./material-review-writeback-trigger-handler.mjs";

const COMPOSITION_VERSION = "legal-contract-review-trigger-composition.v1";
const SAFE_RESULT_VERSION = "smore-legal-approval-safe-result.v1";
const SAFE_CODE = /^[a-z][a-z0-9_]{1,119}$/;

function createLegalContractReviewTriggerHandler({
  commentComposer,
  enabled = true,
  handlerVersion,
  materialAdapter,
  materialBindingRegistry,
  resolvePublishedSkill,
  resultRepository,
  reviewStatus = "approved",
  skillHarnessRunner,
  skillId,
  skillVersion,
  taskDefinitionId,
  workspaceService,
  writebackBindingRegistry,
  writebackEffect,
} = {}) {
  requireMethod(commentComposer, "compose");
  requireMethod(materialAdapter, "acquireReferences");
  requireMethod(materialAdapter, "resolveDownloadUrls");
  requireMethod(materialBindingRegistry, "resolve");
  requireFunction(resolvePublishedSkill, "resolvePublishedSkill");
  requireMethod(skillHarnessRunner, "inspectHarnessReadiness");
  requireMethod(skillHarnessRunner, "run");
  requireMethod(workspaceService, "prepare");
  requireMethod(writebackBindingRegistry, "resolve");
  const expectedSkillId = requiredReference(skillId);
  const expectedSkillVersion = requiredReference(skillVersion);

  return createMaterialReviewWritebackTriggerHandler({
    taskDefinitionId,
    handlerVersion,
    enabled,
    reviewStatus,
    resultRepository,
    writebackEffect,
    resolveMaterialBinding: async ({ binding, triggerEvent }) => {
      const subject = requireSubject(triggerEvent);
      const resolution = Object.freeze({
        sourceObjectApiName: subject.objectApiName,
        sourceSystemId: binding.sourceSystemId,
        taskDefinitionId: binding.taskDefinitionId,
      });
      const materialBinding = materialBindingRegistry.resolve(resolution);
      const writebackBinding = writebackBindingRegistry.resolve(resolution);
      if (!materialBinding || !writebackBinding) {
        throw compositionError("trigger_legal_review_binding_unavailable");
      }
      return Object.freeze({ materialBinding, writebackBinding });
    },
    acquireWorkspace: async ({ materialBinding, signal, triggerEvent }) => {
      const subject = requireSubject(triggerEvent);
      const material = await materialAdapter.acquireReferences({
        binding: materialBinding,
        subject,
        signal,
      });
      const downloadUrls = await materialAdapter.resolveDownloadUrls({
        binding: materialBinding,
        material,
        signal,
      });
      return workspaceService.prepare({
        downloadUrls,
        material,
        signal,
      });
    },
    runSkill: async ({ employee, signal, workspace }) => {
      if (!Array.isArray(employee.businessSkillIds) ||
        !employee.businessSkillIds.includes(expectedSkillId)) {
        return skillOutcome("blocked", "trigger_review_skill_not_mounted", null);
      }
      const published = await resolvePublishedSkill(expectedSkillId);
      if (!published || published.version !== expectedSkillVersion ||
        published.runtimeEligibility?.allowed !== true) {
        return skillOutcome("blocked", "trigger_review_skill_version_unavailable", null);
      }
      const readiness = await skillHarnessRunner.inspectHarnessReadiness([expectedSkillId]);
      if (!readiness?.verifiedSkillIds?.includes(expectedSkillId)) {
        return skillOutcome("blocked", "trigger_review_skill_harness_unavailable", null);
      }
      const result = await skillHarnessRunner.run({
        skillId: expectedSkillId,
        explicitlyRequested: true,
        material: {
          workspace: workspace.workspacePath,
          files: [workspace.legalApprovalMaterialPath],
        },
        signal,
      });
      return projectHarnessResult(result, expectedSkillId);
    },
    composeReviewComment: async ({ employee, result, signal, task, workspace, writebackBinding }) => {
      const material = await readJson(workspace.legalApprovalMaterialPath);
      return commentComposer.compose({
        contractText: requireDocumentText(material.documents),
        employee,
        form: requireFormFields(material.formFields),
        maxCommentChars: writebackBinding.maxCommentChars,
        runtimeTask: task,
        safeResult: result,
        signal,
      });
    },
  });
}

function projectHarnessResult(value, expectedSkillId) {
  if (!isPlainObject(value) || value.skillId !== expectedSkillId ||
    typeof value.status !== "string" || !SAFE_CODE.test(value.status)) {
    throw compositionError("trigger_review_skill_result_invalid");
  }
  if (!value.status.startsWith("completed_")) {
    const status = value.status.startsWith("blocked_") ? "blocked" : "failed";
    return skillOutcome(status, value.status, null);
  }
  if (!isPlainObject(value.details) || value.details.contractVersion !== SAFE_RESULT_VERSION) {
    throw compositionError("trigger_review_skill_result_invalid");
  }
  const { runtimeHarnessEvidence: _runtimeHarnessEvidence, ...details } = value.details;
  const safeResult = Object.freeze({
    ...details,
    contractVersion: SAFE_RESULT_VERSION,
    status: value.status,
    summary: String(value.summary || "").trim(),
    nextGate: String(value.nextGate || "").trim(),
  });
  return skillOutcome("completed", "material_review_completed", safeResult);
}

function skillOutcome(status, safeResultCode, result) {
  return Object.freeze({
    contractVersion: TRIGGER_MATERIAL_REVIEW_SKILL_RESULT_CONTRACT_VERSION,
    status,
    safeResultCode,
    result,
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw compositionError("trigger_review_workspace_material_invalid");
  }
}

function requireSubject(triggerEvent) {
  const subject = triggerEvent?.event?.subject;
  if (!isPlainObject(subject) || typeof subject.objectApiName !== "string" ||
    typeof subject.objectId !== "string") {
    throw compositionError("trigger_review_subject_invalid");
  }
  return subject;
}

function requireForm(value) {
  if (!isPlainObject(value)) {
    throw compositionError("trigger_review_form_unavailable");
  }
  return value;
}

function requireFormFields(value) {
  if (!Array.isArray(value)) throw compositionError("trigger_review_form_invalid");
  return requireForm(Object.fromEntries(value.map((field) => {
    const label = typeof field?.label === "string" ? field.label.trim() : "";
    if (!label || !Object.hasOwn(field || {}, "value")) {
      throw compositionError("trigger_review_form_invalid");
    }
    return [label, field.value];
  })));
}

function requireDocumentText(value) {
  if (!Array.isArray(value)) throw compositionError("trigger_review_contract_text_invalid");
  return value.map((document) => typeof document?.extractedText === "string"
    ? document.extractedText.trim()
    : "").filter(Boolean).join("\n\n");
}

function requiredReference(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new TypeError("legal review composition reference invalid");
  }
  return value;
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`legal review composition requires ${method}`);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`legal review composition requires ${name}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function compositionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export {
  COMPOSITION_VERSION as LEGAL_CONTRACT_REVIEW_TRIGGER_COMPOSITION_VERSION,
  createLegalContractReviewTriggerHandler,
};
