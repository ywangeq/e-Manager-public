import fs from "node:fs";
import path from "node:path";
import { sanitizeRuntimeTaskFeedbackDiagnosticChain } from "./agent-runtime/runtime-task-feedback-diagnostic-chain.mjs";

const DEFAULT_ACCEPTED_SCOPES = ["capability_request", "distribution_mapping", "invocation_policy", "quality_event"];
const ALLOWED_MANAGEMENT_SCOPES = new Set([...DEFAULT_ACCEPTED_SCOPES, "discovery_only"]);
const REQUIRED_HANDSHAKE_CHECKS = [
  ["registration_match", "注册信息一致"],
  ["summary_reachable", "安全摘要接口可达"],
  ["contract_match", "协议版本匹配"],
  ["distribution_bound", "分发映射已绑定"],
  ["invocation_bound", "调用门禁已绑定"],
  ["quality_feedback_bound", "质量回流已验证"],
  ["owner_confirmed", "Owner 双确认"],
];

export function createControlPlaneStore({
  projectRoot,
  storePath,
  seedCapabilityRequests = [],
  seedQualityEvents = [],
  seedSubsystems = [],
  redactError = (error) => String(error?.message || error),
  fetch = globalThis.fetch,
}) {
  function readSubsystems() {
    const store = readStore();
    ensureSeedSubsystems(store);
    writeStore(store);
    return Object.values(store.subsystems || {}).map(sanitizeSubsystem).sort((left, right) => left.id.localeCompare(right.id));
  }

  function readCapabilityRequests() {
    const store = readStore();
    ensureSeedCapabilityRequests(store);
    writeStore(store);
    return Object.values(store.capabilityRequests || {}).map(sanitizeCapabilityRequest).sort(sortUpdatedDesc);
  }

  function readDigitalEmployeeAccessRequests() {
    const store = readStore();
    return Object.values(store.digitalEmployeeAccessRequests || {})
      .map(sanitizeDigitalEmployeeAccessRequest)
      .sort(sortUpdatedDesc);
  }

  function readDesktopChannelAvailability() {
    const store = readStore();
    return Object.values(store.desktopChannelAvailability || {})
      .map(sanitizeDesktopChannelAvailability)
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId));
  }

  function saveCapabilityRequest(request = {}) {
    const store = readStore();
    ensureSeedCapabilityRequests(store);
    const next = sanitizeCapabilityRequest(request);
    if (!next.id) return next;
    const existingKey = findCapabilityRequestKey(store.capabilityRequests, next);
    const storeKey = existingKey || next.id;
    const existing = existingKey ? sanitizeCapabilityRequest(store.capabilityRequests[existingKey]) : {};
    store.capabilityRequests[storeKey] = sanitizeCapabilityRequest({
      ...existing,
      ...next,
      id: storeKey,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.capabilityRequests[storeKey];
  }

  function saveDigitalEmployeeAccessRequest(request = {}) {
    const store = readStore();
    store.digitalEmployeeAccessRequests = store.digitalEmployeeAccessRequests || {};
    const next = sanitizeDigitalEmployeeAccessRequest(request);
    if (!next.id) return next;
    const existing = sanitizeDigitalEmployeeAccessRequest(store.digitalEmployeeAccessRequests[next.id] || {});
    store.digitalEmployeeAccessRequests[next.id] = sanitizeDigitalEmployeeAccessRequest({
      ...existing,
      ...next,
      id: next.id,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.digitalEmployeeAccessRequests[next.id];
  }

  function saveDesktopChannelAvailability(availability = {}) {
    const store = readStore();
    store.desktopChannelAvailability = store.desktopChannelAvailability || {};
    const next = sanitizeDesktopChannelAvailability(availability);
    if (!next.employeeId) return next;
    const existing = sanitizeDesktopChannelAvailability(store.desktopChannelAvailability[next.employeeId] || {});
    store.desktopChannelAvailability[next.employeeId] = sanitizeDesktopChannelAvailability({
      ...existing,
      ...next,
      employeeId: next.employeeId,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.desktopChannelAvailability[next.employeeId];
  }

  function readQualityEvents() {
    const store = readStore();
    ensureSeedQualityEvents(store);
    writeStore(store);
    return Object.values(store.qualityEvents || {}).map(sanitizeQualityEvent).sort(sortUpdatedDesc);
  }

  function readSkillMountRequests() {
    const store = readStore();
    return Object.values(store.skillMountRequests || {}).map(sanitizeSkillMountRequest).sort(sortUpdatedDesc);
  }

  function readToolBindingRequests() {
    const store = readStore();
    return Object.values(store.toolBindingRequests || {}).map(sanitizeToolBindingRequest).sort(sortUpdatedDesc);
  }

  function saveQualityEvent(event = {}) {
    const store = readStore();
    ensureSeedQualityEvents(store);
    const next = sanitizeQualityEvent(event);
    if (!next.id) return next;
    const existingKey = findQualityEventKey(store.qualityEvents, next);
    const storeKey = existingKey || next.id;
    const existing = existingKey ? sanitizeQualityEvent(store.qualityEvents[existingKey]) : {};
    store.qualityEvents[storeKey] = sanitizeQualityEvent({
      ...existing,
      ...next,
      id: storeKey,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.qualityEvents[storeKey];
  }

  function saveSkillMountRequest(request = {}) {
    const store = readStore();
    store.skillMountRequests = store.skillMountRequests || {};
    const next = sanitizeSkillMountRequest(request);
    if (!next.id) return next;
    const existing = sanitizeSkillMountRequest(store.skillMountRequests[next.id] || {});
    store.skillMountRequests[next.id] = sanitizeSkillMountRequest({
      ...existing,
      ...next,
      id: next.id,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.skillMountRequests[next.id];
  }

  function saveToolBindingRequest(request = {}) {
    const store = readStore();
    store.toolBindingRequests = store.toolBindingRequests || {};
    const next = sanitizeToolBindingRequest(request);
    if (!next.id) return next;
    const existing = sanitizeToolBindingRequest(store.toolBindingRequests[next.id] || {});
    store.toolBindingRequests[next.id] = sanitizeToolBindingRequest({
      ...existing,
      ...next,
      id: next.id,
    });
    store.updatedAt = new Date().toISOString();
    writeStore(store);
    return store.toolBindingRequests[next.id];
  }

  function registerSubsystem(input = {}, actor = null) {
    const now = new Date().toISOString();
    const store = readStore();
    ensureSeedSubsystems(store);
    const subsystem = sanitizeSubsystem({
      ...input,
      id: normalizeId(input.id || input.subsystemId),
      status: input.status || "已登记",
      supportedContracts: input.supportedContracts,
      createdAt: now,
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
      registration: {
        status: "registered",
        registeredAt: formatChinaTime(now),
        registeredBy: sanitizeActor(actor),
        nextGate: "发起纳管握手",
      },
    });
    validateSubsystemRegistration(subsystem);
    store.subsystems[subsystem.id] = sanitizeSubsystem({
      ...(store.subsystems[subsystem.id] || {}),
      ...subsystem,
      managementHandshake: store.subsystems[subsystem.id]?.managementHandshake || null,
    });
    store.updatedAt = now;
    writeStore(store);
    return store.subsystems[subsystem.id];
  }

  function updateSubsystemAssignment(subsystemId, input = {}, actor = null) {
    const store = readStore();
    ensureSeedSubsystems(store);
    const subsystem = sanitizeSubsystem(store.subsystems[normalizeId(subsystemId)]);
    if (!subsystem.id) {
      return { statusCode: 404, body: { ok: false, error: "subsystem_not_found", contractVersion: "subsystem-assignment.v1" } };
    }

    const now = new Date().toISOString();
    const assignmentDraft = sanitizeSubsystemAssignment({
      contractVersion: "subsystem-assignment.v1",
      status: "归属草案已保存",
      departmentId: input.departmentId || subsystem.departmentId,
      businessDomain: input.businessDomain || subsystem.businessDomain,
      owner: input.owner || subsystem.owner,
      managementScopes: normalizeManagementScopes(input.managementScopes, subsystem.managementScopes || subsystem.managementHandshake?.acceptedScopes),
      ownerConfirmed: Boolean(input.ownerConfirmed),
      note: input.note || input.notes,
      reviewGate: "平台管理员 + 部门 owner/RBAC 复核后生效；当前仅写入 LAN MVP 治理草案。",
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
    });

    if (!assignmentDraft.departmentId || !assignmentDraft.businessDomain || !assignmentDraft.owner) {
      return {
        statusCode: 400,
        body: { ok: false, error: "invalid_subsystem_assignment", contractVersion: "subsystem-assignment.v1" },
      };
    }
    if (hasUnsafeText([assignmentDraft.businessDomain, assignmentDraft.owner, assignmentDraft.note])) {
      return {
        statusCode: 422,
        body: { ok: false, error: "unsafe_subsystem_assignment", contractVersion: "subsystem-assignment.v1" },
      };
    }

    store.subsystems[subsystem.id] = sanitizeSubsystem({
      ...subsystem,
      departmentId: assignmentDraft.departmentId,
      businessDomain: assignmentDraft.businessDomain,
      owner: assignmentDraft.owner,
      managementScopes: assignmentDraft.managementScopes,
      assignmentDraft,
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
    });
    store.updatedAt = now;
    writeStore(store);
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: "assignment_draft_saved",
        contractVersion: "subsystem-assignment.v1",
        assignmentDraft,
        subsystem: store.subsystems[subsystem.id],
      },
    };
  }

  async function startHandshake(subsystemId, input = {}, actor = null, context = {}) {
    const store = readStore();
    ensureSeedSubsystems(store);
    const subsystem = sanitizeSubsystem(store.subsystems[normalizeId(subsystemId)]);
    if (!subsystem.id) {
      return { statusCode: 404, body: { ok: false, error: "subsystem_not_found", contractVersion: "subsystem-handshake.v1" } };
    }

    const now = new Date().toISOString();
    const summaryResult = await fetchSubsystemSummary(subsystem, input);
    if (!summaryResult.ok) {
      return {
        statusCode: summaryResult.statusCode || 409,
        body: {
          ok: false,
          error: summaryResult.error || "subsystem_summary_unreachable",
          contractVersion: "subsystem-handshake.v1",
        },
      };
    }

    const requestedScopes = cleanList(input.requestedScopes || subsystem.managementHandshake?.acceptedScopes || DEFAULT_ACCEPTED_SCOPES);
    const summary = summaryResult.summary || {};
    const checks = buildHandshakeChecks({ subsystem, summary, requestedScopes, context });
    const status = checks.every((check) => check.status === "通过") ? "待平台确认" : "待补充";
    const handshake = sanitizeHandshake({
      id: `HND-${subsystem.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`,
      contractVersion: "subsystem-handshake.v1",
      subsystemId: subsystem.id,
      status,
      startedAt: formatChinaTime(now),
      updatedAt: now,
      requestedScopes,
      acceptedScopes: requestedScopes,
      summaryHash: hashSummary(summary),
      summaryContractVersion: cleanShortText(summary.contractVersion),
      safeSummary: safeSummaryFromSubsystemSummary(summary),
      checks,
      nextGate: status === "待平台确认" ? "平台管理员和业务系统 owner 确认纳管" : "补齐纳管握手缺口后重新提交",
      createdBy: sanitizeActor(actor),
    });

    store.subsystems[subsystem.id] = sanitizeSubsystem({
      ...subsystem,
      status: status === "待平台确认" ? "握手待确认" : "握手待补充",
      managementHandshake: handshake,
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
    });
    store.updatedAt = now;
    writeStore(store);
    return {
      statusCode: 202,
      body: {
        ok: true,
        status: "pending_confirmation",
        contractVersion: "subsystem-handshake.v1",
        handshake,
        subsystem: store.subsystems[subsystem.id],
      },
    };
  }

  function confirmHandshake(subsystemId, handshakeId, input = {}, actor = null) {
    const store = readStore();
    ensureSeedSubsystems(store);
    const subsystem = sanitizeSubsystem(store.subsystems[normalizeId(subsystemId)]);
    if (!subsystem.id) {
      return { statusCode: 404, body: { ok: false, error: "subsystem_not_found", contractVersion: "subsystem-handshake.v1" } };
    }
    const handshake = sanitizeHandshake(subsystem.managementHandshake);
    if (!handshake.id || handshake.id !== cleanShortText(handshakeId)) {
      return { statusCode: 404, body: { ok: false, error: "handshake_not_found", contractVersion: "subsystem-handshake.v1" } };
    }
    const decision = cleanShortText(input.decision || input.outcome || "approve");
    if (!["approve", "approved", "confirm", "confirmed"].includes(decision)) {
      return { statusCode: 400, body: { ok: false, error: "handshake_decision_required", contractVersion: "subsystem-handshake.v1" } };
    }
    const incompleteChecks = (handshake.checks || []).filter((check) => check.status !== "通过");
    if (incompleteChecks.length) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: "handshake_checks_incomplete",
          contractVersion: "subsystem-handshake.v1",
          incompleteChecks,
        },
      };
    }

    const now = new Date().toISOString();
    const confirmedHandshake = sanitizeHandshake({
      ...handshake,
      status: "已确认纳管",
      acceptedAt: formatChinaTime(now),
      confirmedBy: cleanShortText(input.confirmedBy || actor?.name || "平台管理员"),
      confirmationNote: cleanText(input.notes || input.note || ""),
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
      nextGate: "可提交能力申请、分发映射、调用门禁和质量回流",
    });
    store.subsystems[subsystem.id] = sanitizeSubsystem({
      ...subsystem,
      status: "已纳管",
      managementHandshake: confirmedHandshake,
      updatedAt: now,
      updatedBy: sanitizeActor(actor),
    });
    store.updatedAt = now;
    writeStore(store);
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: "managed",
        contractVersion: "subsystem-handshake.v1",
        subsystem: store.subsystems[subsystem.id],
      },
    };
  }

  function readStore() {
    try {
      if (!fs.existsSync(storePath)) return emptyStore();
      const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (!data || typeof data !== "object") return emptyStore();
      return {
        version: "control-plane-subsystems.v1",
        subsystems: data.subsystems && typeof data.subsystems === "object" ? data.subsystems : {},
        capabilityRequests: data.capabilityRequests && typeof data.capabilityRequests === "object" ? data.capabilityRequests : {},
        digitalEmployeeAccessRequests: data.digitalEmployeeAccessRequests && typeof data.digitalEmployeeAccessRequests === "object"
          ? data.digitalEmployeeAccessRequests
          : {},
        desktopChannelAvailability: data.desktopChannelAvailability && typeof data.desktopChannelAvailability === "object"
          ? data.desktopChannelAvailability
          : {},
        qualityEvents: data.qualityEvents && typeof data.qualityEvents === "object" ? data.qualityEvents : {},
        skillMountRequests: data.skillMountRequests && typeof data.skillMountRequests === "object" ? data.skillMountRequests : {},
        toolBindingRequests: data.toolBindingRequests && typeof data.toolBindingRequests === "object" ? data.toolBindingRequests : {},
        updatedAt: data.updatedAt || "",
      };
    } catch (error) {
      console.warn("[control-plane-store] Failed to read store:", redactError(error));
      return emptyStore();
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  function emptyStore() {
    return {
      version: "control-plane-subsystems.v1",
      subsystems: {},
      capabilityRequests: {},
      digitalEmployeeAccessRequests: {},
      desktopChannelAvailability: {},
      qualityEvents: {},
      skillMountRequests: {},
      toolBindingRequests: {},
      updatedAt: "",
    };
  }

  function ensureSeedSubsystems(store) {
    store.subsystems = store.subsystems || {};
    for (const seed of seedSubsystems) {
      const subsystem = sanitizeSubsystem(seed);
      if (!subsystem.id || store.subsystems[subsystem.id]) continue;
      store.subsystems[subsystem.id] = sanitizeSubsystem({
        ...subsystem,
        source: "seeded-real-subsystem",
        createdAt: subsystem.createdAt || new Date().toISOString(),
        updatedAt: subsystem.updatedAt || new Date().toISOString(),
      });
    }
  }

  function ensureSeedCapabilityRequests(store) {
    store.capabilityRequests = store.capabilityRequests || {};
    for (const seed of seedCapabilityRequests) {
      const request = sanitizeCapabilityRequest(seed);
      if (!request.id || store.capabilityRequests[request.id]) continue;
      store.capabilityRequests[request.id] = {
        ...request,
        source: "seeded-control-plane-request",
      };
    }
  }

  function ensureSeedQualityEvents(store) {
    store.qualityEvents = store.qualityEvents || {};
    for (const seed of seedQualityEvents) {
      const event = sanitizeQualityEvent(seed);
      if (!event.id || store.qualityEvents[event.id]) continue;
      store.qualityEvents[event.id] = {
        ...event,
        source: "seeded-control-plane-quality-event",
      };
    }
  }

  return {
    confirmHandshake,
    readCapabilityRequests,
    readDesktopChannelAvailability,
    readDigitalEmployeeAccessRequests,
    readQualityEvents,
    readSkillMountRequests,
    readSubsystems,
    readToolBindingRequests,
    registerSubsystem,
    saveCapabilityRequest,
    saveDesktopChannelAvailability,
    saveDigitalEmployeeAccessRequest,
    saveQualityEvent,
    saveSkillMountRequest,
    saveToolBindingRequest,
    startHandshake,
    updateSubsystemAssignment,
  };

  async function fetchSubsystemSummary(subsystem, input) {
    const expectedBaseUrl = cleanShortText(input.expectedBaseUrl || subsystem.baseUrl);
    const expectedSummaryEndpoint = cleanShortText(input.expectedSummaryEndpoint || subsystem.summaryEndpoint || "/api/control-plane/summary");
    if (!expectedBaseUrl || !expectedSummaryEndpoint) {
      return { ok: false, statusCode: 400, error: "subsystem_summary_endpoint_required" };
    }
    let summaryUrl;
    try {
      summaryUrl = new URL(expectedSummaryEndpoint, ensureTrailingSlash(expectedBaseUrl)).toString();
    } catch {
      return { ok: false, statusCode: 400, error: "invalid_subsystem_summary_url" };
    }
    try {
      const response = await fetch(summaryUrl, { headers: { Accept: "application/json" } });
      const summary = await response.json().catch(() => ({}));
      if (!response.ok || summary.ok === false) {
        return { ok: false, statusCode: 409, error: "subsystem_summary_unreachable" };
      }
      return { ok: true, summary };
    } catch {
      return { ok: false, statusCode: 409, error: "subsystem_summary_unreachable" };
    }
  }
}

function sanitizeDigitalEmployeeAccessRequest(request = {}) {
  const applicant = request.applicant && typeof request.applicant === "object" ? request.applicant : {};
  const target = request.target && typeof request.target === "object" ? request.target : {};
  const decision = request.decision && typeof request.decision === "object" ? request.decision : {};
  const allowedStatuses = new Set(["pending_review", "approved", "rejected", "revoked"]);
  const status = cleanShortText(request.status || "pending_review");
  return {
    id: cleanShortText(request.id),
    contractVersion: "digital-employee-access-request.v1",
    status: allowedStatuses.has(status) ? status : "pending_review",
    requestedActions: cleanList(request.requestedActions || ["conversation"]),
    requestedScope: cleanShortText(request.requestedScope || "self"),
    safeReason: cleanText(request.safeReason || request.reason),
    sourceChannelId: normalizeId(request.sourceChannelId || "desktop"),
    createdAt: cleanShortText(request.createdAt),
    updatedAt: cleanShortText(request.updatedAt),
    applicant: {
      id: cleanShortText(applicant.id),
      name: cleanShortText(applicant.name),
      departmentId: cleanShortText(applicant.departmentId),
      departmentName: cleanShortText(applicant.departmentName || applicant.department),
      identitySource: cleanShortText(applicant.identitySource),
    },
    target: {
      employeeId: normalizeId(target.employeeId || request.employeeId),
      employeeName: cleanShortText(target.employeeName || request.employeeName),
      employeeVersion: cleanShortText(target.employeeVersion || request.employeeVersion),
      ownerDepartmentId: cleanShortText(target.ownerDepartmentId || request.ownerDepartmentId),
    },
    decision: {
      outcome: cleanShortText(decision.outcome),
      decidedAt: cleanShortText(decision.decidedAt),
      note: cleanText(decision.note),
      decidedBy: sanitizeActor(decision.decidedBy),
    },
  };
}

function sanitizeDesktopChannelAvailability(availability = {}) {
  return {
    employeeId: normalizeId(availability.employeeId),
    enabled: availability.enabled === true,
    updatedAt: cleanShortText(availability.updatedAt),
    updatedBy: sanitizeActor(availability.updatedBy),
  };
}

function sanitizeCapabilityRequest(request = {}) {
  return {
    id: cleanShortText(request.id),
    sourceSystemId: normalizeId(request.sourceSystemId || request.systemId),
    sourceRequestId: cleanShortText(request.sourceRequestId),
    requestType: cleanShortText(request.requestType || "business_digital_employee_application"),
    requestTypeLabel: cleanShortText(request.requestTypeLabel),
    departmentId: cleanShortText(request.departmentId),
    businessDomain: cleanShortText(request.businessDomain),
    requester: cleanShortText(request.requester),
    ownerHint: cleanShortText(request.ownerHint),
    status: cleanShortText(request.status || "待平台评审"),
    risk: cleanShortText(request.risk || "待评估"),
    submittedAt: cleanShortText(request.submittedAt),
    updatedAt: cleanShortText(request.updatedAt),
    capabilityName: cleanShortText(request.capabilityName),
    capabilityKind: cleanShortText(request.capabilityKind),
    targetEmployeeId: cleanShortText(request.targetEmployeeId),
    targetEmployeeName: cleanShortText(request.targetEmployeeName),
    targetSkillId: cleanShortText(request.targetSkillId),
    targetSkillName: cleanShortText(request.targetSkillName),
    targetSkillIds: cleanList(request.targetSkillIds),
    requestedSkillIds: cleanList(request.requestedSkillIds),
    requestedSkills: sanitizeCapabilityRequestedSkills(request.requestedSkills),
    applicationScope: cleanShortText(request.applicationScope),
    applicationTarget: cleanShortText(request.applicationTarget),
    targetSourceRef: cleanShortText(request.targetSourceRef),
    sourceAlignment: cleanShortText(request.sourceAlignment),
    customCapability: sanitizeCustomCapability(request.customCapability),
    requestedCapabilities: cleanList(request.requestedCapabilities),
    candidateTargetEmployees: cleanList(request.candidateTargetEmployees),
    candidateTargetSkills: cleanList(request.candidateTargetSkills),
    safeSummary: cleanText(request.safeSummary),
    reviewGate: cleanText(request.reviewGate),
    preReview: request.preReview && typeof request.preReview === "object" ? request.preReview : null,
    reviewDecision: sanitizeCapabilityReviewDecision(request.reviewDecision || request.approvalDecision),
    warnings: cleanList(request.warnings),
    tags: cleanList(request.tags),
    source: cleanShortText(request.source),
  };
}

function sanitizeCapabilityRequestedSkills(skills = []) {
  return (Array.isArray(skills) ? skills : []).slice(0, 20).map((skill) => ({
    id: cleanShortText(skill.id),
    skillApiId: cleanShortText(skill.skillApiId || skill.id),
    sourceSkillId: cleanShortText(skill.sourceSkillId),
    name: cleanShortText(skill.name || skill.id),
    status: cleanShortText(skill.status),
    risk: cleanShortText(skill.risk),
    reviewGate: cleanText(skill.reviewGate),
    capabilities: cleanList(skill.capabilities).slice(0, 4),
  }));
}

function sanitizeCapabilityReviewDecision(decision = null) {
  if (!decision || typeof decision !== "object") return null;
  return {
    decision: cleanShortText(decision.decision),
    status: cleanShortText(decision.status),
    summary: cleanText(decision.summary),
    nextGate: cleanText(decision.nextGate),
    decidedAt: cleanShortText(decision.decidedAt),
    decidedBy: sanitizeActor(decision.decidedBy),
    notes: cleanText(decision.notes),
  };
}

function sanitizeQualityEvent(event = {}) {
  return {
    id: cleanShortText(event.id),
    sourceSystemId: normalizeId(event.sourceSystemId || event.systemId),
    sourceEventId: cleanShortText(event.sourceEventId),
    eventType: cleanShortText(event.eventType || "badcase_summary"),
    occurredAt: cleanShortText(event.occurredAt || event.eventAt || event.createdAt || event.submittedAt),
    reportedAt: cleanShortText(event.reportedAt || event.submittedAt || event.updatedAt || event.createdAt),
    departmentId: cleanShortText(event.departmentId),
    businessDomain: cleanShortText(event.businessDomain),
    executionMode: cleanShortText(event.executionMode),
    platformPolicyId: cleanShortText(event.platformPolicyId),
    entityType: cleanShortText(event.entityType || "数字员工"),
    entityId: cleanShortText(event.entityId),
    entityVersion: cleanShortText(event.entityVersion),
    capabilityVersion: cleanShortText(event.capabilityVersion),
    modelId: cleanShortText(event.modelId),
    modelVersion: cleanShortText(event.modelVersion),
    promptVersion: cleanShortText(event.promptVersion),
    severity: cleanShortText(event.severity || "P2"),
    status: cleanShortText(event.status || "待平台质量复盘"),
    errorDomain: cleanShortText(event.errorDomain || "quality"),
    errorCode: cleanShortText(event.errorCode || "SUBSYSTEM_QUALITY_EVENT"),
    rootCauseCategory: cleanShortText(event.rootCauseCategory || "pending_analysis"),
    resolutionAction: cleanShortText(event.resolutionAction || "pending_review"),
    evidenceSummary: cleanText(event.evidenceSummary),
    expectedSummary: cleanText(event.expectedSummary),
    actualSummary: cleanText(event.actualSummary),
    evalCandidate: Boolean(event.evalCandidate),
    archiveMode: cleanShortText(event.archiveMode),
    archiveWindow: cleanShortText(event.archiveWindow),
    diagnosticChain: sanitizeRuntimeTaskFeedbackDiagnosticChain(event.diagnosticChain),
    preReview: event.preReview && typeof event.preReview === "object" ? event.preReview : null,
    reviewTask: sanitizeQualityReviewTask(event.reviewTask),
    reviewGate: cleanText(event.reviewGate),
    warnings: cleanList(event.warnings),
    tags: cleanList(event.tags),
    source: cleanShortText(event.source),
    updatedAt: cleanShortText(event.updatedAt),
  };
}

function sanitizeSkillMountRequest(request = {}) {
  const action = cleanShortText(request.action || "mount");
  return {
    id: cleanShortText(request.id),
    contractVersion: cleanShortText(request.contractVersion || "skill-mount-change-request.v1"),
    action: ["mount", "unmount"].includes(action) ? action : "mount",
    actionLabel: cleanShortText(request.actionLabel || (action === "unmount" ? "取消挂载" : "挂载")),
    mountActionId: cleanShortText(request.mountActionId),
    requestMode: cleanShortText(request.requestMode || "request"),
    status: cleanShortText(request.status || "待管理员审核"),
    employeeId: normalizeId(request.employeeId),
    employeeName: cleanShortText(request.employeeName),
    employeeVersion: cleanShortText(request.employeeVersion),
    employeeLevel: cleanShortText(request.employeeLevel),
    skillId: normalizeId(request.skillId),
    skillApiId: cleanShortText(request.skillApiId || request.skillId),
    sourceSkillId: cleanShortText(request.sourceSkillId),
    skillName: cleanShortText(request.skillName),
    skillVersion: cleanShortText(request.skillVersion),
    skillKind: cleanShortText(request.skillKind || "business_skill"),
    departmentId: cleanShortText(request.departmentId),
    requestedBy: sanitizeActor(request.requestedBy),
    requestedRole: cleanShortText(request.requestedRole),
    reason: cleanText(request.reason),
    riskLevel: cleanShortText(request.riskLevel || "待评估"),
    safeSummary: cleanText(request.safeSummary),
    impactSummary: cleanText(request.impactSummary),
    rollbackPlan: cleanText(request.rollbackPlan),
    reviewGate: cleanText(request.reviewGate),
    precheck: sanitizeSkillMountPrecheck(request.precheck),
    attributionPlan: sanitizeAttributionPlan(request.attributionPlan),
    dependencyClosure: cleanList(request.dependencyClosure),
    affectedDistributions: sanitizeDistributionRefs(request.affectedDistributions),
    decision: sanitizeSkillMountDecision(request.decision),
    warnings: cleanList(request.warnings),
    tags: cleanList(request.tags),
    submittedAt: cleanShortText(request.submittedAt),
    updatedAt: cleanShortText(request.updatedAt),
    source: cleanShortText(request.source),
  };
}

function sanitizeToolBindingRequest(request = {}) {
  const action = cleanShortText(request.action || "enable");
  const normalizedAction = ["enable", "disable", "configure"].includes(action) ? action : "enable";
  return {
    id: cleanShortText(request.id),
    contractVersion: cleanShortText(request.contractVersion || "tool-binding-change-request.v1"),
    action: normalizedAction,
    actionLabel: cleanShortText(request.actionLabel || (normalizedAction === "disable" ? "关闭工具" : normalizedAction === "configure" ? "配置操作权限" : "开启工具")),
    toolActionId: cleanShortText(request.toolActionId),
    requestMode: cleanShortText(request.requestMode || "approval_required"),
    status: cleanShortText(request.status || "待工具审批"),
    employeeId: normalizeId(request.employeeId),
    employeeName: cleanShortText(request.employeeName),
    employeeVersion: cleanShortText(request.employeeVersion),
    employeeLevel: cleanShortText(request.employeeLevel),
    toolId: normalizeId(request.toolId),
    toolBindingId: cleanShortText(request.toolBindingId),
    toolName: cleanShortText(request.toolName),
    toolType: cleanShortText(request.toolType),
    toolVendor: cleanShortText(request.toolVendor),
    source: cleanShortText(request.source),
    sourceUrl: cleanShortText(request.sourceUrl),
    departmentId: cleanShortText(request.departmentId),
    owner: cleanShortText(request.owner),
    ownerDepartmentId: cleanShortText(request.ownerDepartmentId),
    requestedBy: sanitizeActor(request.requestedBy),
    requestedRole: cleanShortText(request.requestedRole),
    reason: cleanText(request.reason),
    riskLevel: cleanShortText(request.riskLevel || "待评估"),
    safeSummary: cleanText(request.safeSummary),
    permissionBoundary: cleanText(request.permissionBoundary),
    credentialBoundary: cleanText(request.credentialBoundary),
    credentialMode: cleanShortText(request.credentialMode),
    writebackBoundary: cleanText(request.writebackBoundary),
    runtimeBoundary: cleanText(request.runtimeBoundary),
    reviewGate: cleanText(request.reviewGate),
    readinessChecks: sanitizeToolReadinessChecks(request.readinessChecks),
    identityModes: cleanList(request.identityModes),
    scopeGroups: cleanList(request.scopeGroups),
    policyMode: cleanShortText(request.policyMode),
    allowedOperations: cleanList(request.allowedOperations),
    allowedCapabilities: cleanList(request.allowedCapabilities),
    allowedRisks: cleanList(request.allowedRisks),
    contractDigest: cleanShortText(request.contractDigest),
    approvedWritePolicyDigests: sanitizeDigestMap(request.approvedWritePolicyDigests),
    policyContractDigest: cleanShortText(request.policyContractDigest),
    boundSkillIds: cleanList(request.boundSkillIds),
    channelBindings: cleanList(request.channelBindings),
    decision: sanitizeToolBindingDecision(request.decision),
    warnings: cleanList(request.warnings),
    tags: cleanList(request.tags),
    submittedAt: cleanShortText(request.submittedAt),
    updatedAt: cleanShortText(request.updatedAt),
  };
}

function sanitizeDigestMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .slice(0, 100)
    .map(([capability, digest]) => [cleanShortText(capability).toLowerCase(), cleanShortText(digest)])
    .filter(([capability, digest]) => /^[a-z0-9_.:-]{1,180}$/.test(capability) && /^sha256:[a-f0-9]{64}$/.test(digest)));
}

function sanitizeToolReadinessChecks(checks = []) {
  if (!Array.isArray(checks)) return [];
  return checks.slice(0, 20).map((check) => ({
    id: cleanShortText(check?.id),
    label: cleanShortText(check?.label),
    status: cleanShortText(check?.status),
  })).filter((check) => check.id || check.label || check.status);
}

function sanitizeToolBindingDecision(decision = null) {
  if (!decision || typeof decision !== "object") return null;
  return {
    decision: cleanShortText(decision.decision),
    decidedAt: cleanShortText(decision.decidedAt),
    decidedBy: sanitizeActor(decision.decidedBy),
    notes: cleanText(decision.notes),
  };
}

function sanitizeSkillMountPrecheck(precheck = null) {
  if (!precheck || typeof precheck !== "object") return null;
  return {
    status: cleanShortText(precheck.status || "completed"),
    checkedAt: cleanShortText(precheck.checkedAt),
    mountedBefore: Boolean(precheck.mountedBefore),
    skillReviewStatus: cleanShortText(precheck.skillReviewStatus),
    employeeStatus: cleanShortText(precheck.employeeStatus),
    ownerAlignment: cleanShortText(precheck.ownerAlignment),
    dependencyStatus: cleanShortText(precheck.dependencyStatus),
    attributionRequired: Boolean(precheck.attributionRequired ?? true),
    findings: cleanList(precheck.findings),
    missingItems: cleanList(precheck.missingItems),
  };
}

function sanitizeAttributionPlan(plan = null) {
  const source = plan && typeof plan === "object" ? plan : {};
  return {
    required: Boolean(source.required ?? true),
    baselineWindow: cleanShortText(source.baselineWindow || "最近 7 天同员工/Skill 安全调用摘要"),
    expectedImpact: cleanText(source.expectedImpact || "记录挂载变更对输出质量、调用门禁和人工复核成本的影响。"),
    guardrailMetrics: cleanList(source.guardrailMetrics || ["P0/P1 未关闭数", "eval 通过率", "人工退回率"]),
    regressionCandidates: cleanList(source.regressionCandidates),
    rollbackTrigger: cleanText(source.rollbackTrigger || "出现 P0/P1、eval 下降或 owner 要求回退时恢复上一挂载关系。"),
  };
}

function sanitizeDistributionRefs(items = []) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).map((item) => ({
    id: cleanShortText(item?.id),
    targetSystemId: normalizeId(item?.targetSystemId),
    status: cleanShortText(item?.status),
  })).filter((item) => item.id || item.targetSystemId);
}

function sanitizeSkillMountDecision(decision = null) {
  if (!decision || typeof decision !== "object") return null;
  return {
    decision: cleanShortText(decision.decision),
    decidedAt: cleanShortText(decision.decidedAt),
    decidedBy: sanitizeActor(decision.decidedBy),
    notes: cleanText(decision.notes),
  };
}

function sanitizeQualityReviewTask(task = null) {
  if (!task || typeof task !== "object") return null;
  return {
    id: cleanShortText(task.id),
    status: cleanShortText(task.status || "复盘已发起"),
    startedAt: cleanShortText(task.startedAt),
    startedBy: cleanShortText(task.startedBy),
    currentGate: cleanText(task.currentGate),
    evidenceRequest: sanitizeEvidenceRequest(task.evidenceRequest),
    evidencePackage: sanitizeEvidencePackage(task.evidencePackage),
    rootCauseDecision: sanitizeReviewDecision(task.rootCauseDecision),
    remediationPlan: sanitizeReviewDecision(task.remediationPlan),
    regressionPlan: sanitizeReviewDecision(task.regressionPlan),
    closure: sanitizeReviewDecision(task.closure),
    history: cleanReviewHistory(task.history),
  };
}

function sanitizeEvidenceRequest(request = null) {
  if (!request || typeof request !== "object") return null;
  return {
    id: cleanShortText(request.id),
    status: cleanShortText(request.status || "待子系统提交脱敏证据"),
    requestedAt: cleanShortText(request.requestedAt),
    requestedBy: cleanShortText(request.requestedBy),
    evidenceTemplate: cleanShortText(request.evidenceTemplate || "role_match_conflict_v1"),
    dueAt: cleanShortText(request.dueAt),
    requiredFields: cleanList(request.requiredFields),
    forbiddenFields: cleanList(request.forbiddenFields),
    requestNote: cleanText(request.requestNote),
    targetEndpoint: cleanShortText(request.targetEndpoint),
  };
}

function sanitizeEvidencePackage(pkg = null) {
  if (!pkg || typeof pkg !== "object") return null;
  return {
    id: cleanShortText(pkg.id),
    status: cleanShortText(pkg.status || "已提交"),
    submittedAt: cleanShortText(pkg.submittedAt),
    submittedBy: cleanShortText(pkg.submittedBy),
    sourceSystemId: normalizeId(pkg.sourceSystemId),
    sourceEventId: cleanShortText(pkg.sourceEventId),
    evidenceTemplate: cleanShortText(pkg.evidenceTemplate || "role_match_conflict_v1"),
    applicationRoleClass: cleanText(pkg.applicationRoleClass),
    recommendedRoleClass: cleanText(pkg.recommendedRoleClass),
    jdTaxonomyVersion: cleanShortText(pkg.jdTaxonomyVersion),
    conflictSummary: cleanText(pkg.conflictSummary),
    matchedRuleSummary: cleanText(pkg.matchedRuleSummary),
    expectedOutcome: cleanText(pkg.expectedOutcome),
    actualOutcome: cleanText(pkg.actualOutcome),
    recurrenceSummary: cleanText(pkg.recurrenceSummary),
    suggestedRootCause: cleanShortText(pkg.suggestedRootCause),
    suggestedAction: cleanShortText(pkg.suggestedAction),
    evalCandidate: Boolean(pkg.evalCandidate),
    privacyReview: cleanText(pkg.privacyReview),
    privacyBoundary: cleanText(pkg.privacyBoundary),
  };
}

function sanitizeReviewDecision(decision = null) {
  if (!decision || typeof decision !== "object") return null;
  return {
    status: cleanShortText(decision.status),
    decidedAt: cleanShortText(decision.decidedAt || decision.updatedAt),
    decidedBy: cleanShortText(decision.decidedBy || decision.updatedBy),
    summary: cleanText(decision.summary),
    rootCauseCategory: cleanShortText(decision.rootCauseCategory),
    resolutionAction: cleanShortText(decision.resolutionAction),
    owner: cleanShortText(decision.owner),
    dueAt: cleanShortText(decision.dueAt),
    regressionCaseId: cleanShortText(decision.regressionCaseId),
    regressionStatus: cleanShortText(decision.regressionStatus),
    closeReason: cleanText(decision.closeReason),
  };
}

function cleanReviewHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history.slice(-30).map((item) => ({
    at: cleanShortText(item?.at),
    actor: cleanShortText(item?.actor),
    action: cleanShortText(item?.action),
    status: cleanShortText(item?.status),
    note: cleanText(item?.note),
  }));
}

function findCapabilityRequestKey(requests = {}, request = {}) {
  const sourceSystemId = normalizeId(request.sourceSystemId);
  const sourceRequestId = cleanShortText(request.sourceRequestId);
  const requestType = cleanShortText(request.requestType);
  if (!sourceSystemId || !sourceRequestId) return "";
  return Object.entries(requests).find(([, value]) => {
    const existing = sanitizeCapabilityRequest(value);
    return (
      existing.sourceSystemId === sourceSystemId &&
      existing.sourceRequestId === sourceRequestId &&
      existing.requestType === requestType
    );
  })?.[0] || "";
}

function findQualityEventKey(events = {}, event = {}) {
  const sourceSystemId = normalizeId(event.sourceSystemId);
  const sourceEventId = cleanShortText(event.sourceEventId);
  const eventType = cleanShortText(event.eventType);
  if (!sourceSystemId || !sourceEventId) return "";
  return Object.entries(events).find(([, value]) => {
    const existing = sanitizeQualityEvent(value);
    return (
      existing.sourceSystemId === sourceSystemId &&
      existing.sourceEventId === sourceEventId &&
      existing.eventType === eventType
    );
  })?.[0] || "";
}

function sanitizeCustomCapability(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: cleanShortText(source.id || source.capabilityId),
    name: cleanShortText(source.name),
    capabilityType: cleanShortText(source.capabilityType),
    sourceRef: cleanShortText(source.sourceRef),
    version: cleanShortText(source.version),
    ownerHint: cleanShortText(source.ownerHint),
    inputSummary: cleanText(source.inputSummary),
    outputSummary: cleanText(source.outputSummary),
    toolSummary: cleanText(source.toolSummary),
    privacySummary: cleanText(source.privacySummary),
  };
}

function buildHandshakeChecks({ subsystem, summary, requestedScopes, context }) {
  const summarySubsystem = summary.subsystem || {};
  const supportedContracts = new Set(cleanList(subsystem.supportedContracts));
  const summaryContracts = new Set([
    cleanShortText(summary.contractVersion),
    ...cleanList(summary.supportedContracts),
    ...cleanList(summarySubsystem.supportedContracts),
  ]);
  const hasDistribution = (context.distributionPlans || []).some((plan) =>
    plan.targetSystemId === subsystem.id || plan.sourceSystemId === subsystem.id,
  );
  const hasInvocationPolicy = (context.invocationPolicies || []).some((policy) =>
    (policy.allowedCallers || []).includes(subsystem.id) || policy.sourceSystemId === subsystem.id,
  );
  const hasQualityContract =
    supportedContracts.has("quality-event.v1") ||
    summaryContracts.has("quality-event.v1");
  const ownerConfirmed = Boolean(subsystem.owner && context.ownerConfirmed);

  const checksById = {
    registration_match: (
      summarySubsystem.id === subsystem.id &&
      summarySubsystem.departmentId === subsystem.departmentId &&
      summarySubsystem.businessDomain === subsystem.businessDomain
    ),
    summary_reachable: summary.ok !== false && summary.contractVersion === "subsystem-summary.v1",
    contract_match: supportedContracts.has("capability-request.v1") || summaryContracts.has("capability-request.v1"),
    distribution_bound: hasDistribution || requestedScopes.includes("discovery_only"),
    invocation_bound: hasInvocationPolicy || !requestedScopes.includes("invocation_policy"),
    quality_feedback_bound: hasQualityContract,
    owner_confirmed: ownerConfirmed,
  };

  return REQUIRED_HANDSHAKE_CHECKS.map(([id, label]) => ({
    id,
    label,
    status: checksById[id] ? "通过" : "待确认",
  }));
}

function validateSubsystemRegistration(subsystem) {
  if (!subsystem.id || !subsystem.name || !subsystem.departmentId || !subsystem.businessDomain) {
    const error = new Error("invalid_subsystem_registration");
    error.code = "invalid_subsystem_registration";
    throw error;
  }
  if (hasUnsafeText([subsystem.baseUrl, subsystem.summaryEndpoint, subsystem.privacyBoundary])) {
    const error = new Error("unsafe_subsystem_payload");
    error.code = "unsafe_subsystem_payload";
    throw error;
  }
}

function sanitizeSubsystem(subsystem = {}) {
  const supportedContracts = cleanList(subsystem.supportedContracts);
  const assignmentDraft = sanitizeSubsystemAssignment(subsystem.assignmentDraft || subsystem.governanceAssignment);
  const managementScopes = normalizeManagementScopes(
    subsystem.managementScopes || assignmentDraft?.managementScopes || subsystem.managementHandshake?.acceptedScopes,
  );
  return {
    id: normalizeId(subsystem.id || subsystem.subsystemId),
    name: cleanShortText(subsystem.name),
    departmentId: cleanShortText(subsystem.departmentId),
    businessDomain: cleanShortText(subsystem.businessDomain),
    baseUrl: cleanShortText(subsystem.baseUrl),
    status: cleanShortText(subsystem.status || "已登记"),
    owner: cleanShortText(subsystem.owner),
    summaryEndpoint: cleanShortText(subsystem.summaryEndpoint || "/api/control-plane/summary"),
    privacyBoundary: cleanText(subsystem.privacyBoundary || "只交换控制面安全摘要，不提交 raw 业务数据。"),
    supportedContracts: supportedContracts.length ? supportedContracts : ["capability-request.v1", "distribution.v1", "quality-event.v1"],
    managementScopes,
    assignmentDraft,
    managementHandshake: subsystem.managementHandshake ? sanitizeHandshake(subsystem.managementHandshake) : null,
    registration: subsystem.registration && typeof subsystem.registration === "object" ? {
      status: cleanShortText(subsystem.registration.status),
      registeredAt: cleanShortText(subsystem.registration.registeredAt),
      nextGate: cleanShortText(subsystem.registration.nextGate),
      registeredBy: sanitizeActor(subsystem.registration.registeredBy),
    } : null,
    source: cleanShortText(subsystem.source),
    createdAt: cleanShortText(subsystem.createdAt),
    updatedAt: cleanShortText(subsystem.updatedAt),
    updatedBy: sanitizeActor(subsystem.updatedBy),
  };
}

function sanitizeSubsystemAssignment(assignment = null) {
  if (!assignment || typeof assignment !== "object") return null;
  return {
    contractVersion: cleanShortText(assignment.contractVersion || "subsystem-assignment.v1"),
    status: cleanShortText(assignment.status || "归属草案"),
    departmentId: cleanShortText(assignment.departmentId),
    businessDomain: cleanShortText(assignment.businessDomain),
    owner: cleanShortText(assignment.owner),
    managementScopes: normalizeManagementScopes(assignment.managementScopes),
    ownerConfirmed: Boolean(assignment.ownerConfirmed),
    note: cleanText(assignment.note),
    reviewGate: cleanText(assignment.reviewGate),
    updatedAt: cleanShortText(assignment.updatedAt),
    updatedBy: sanitizeActor(assignment.updatedBy),
  };
}

function sanitizeHandshake(handshake = {}) {
  return {
    id: cleanShortText(handshake.id),
    contractVersion: cleanShortText(handshake.contractVersion || "subsystem-handshake.v1"),
    subsystemId: normalizeId(handshake.subsystemId),
    status: cleanShortText(handshake.status),
    startedAt: cleanShortText(handshake.startedAt),
    acceptedAt: cleanShortText(handshake.acceptedAt),
    confirmedBy: cleanShortText(handshake.confirmedBy),
    confirmationNote: cleanText(handshake.confirmationNote),
    summaryHash: cleanShortText(handshake.summaryHash),
    summaryContractVersion: cleanShortText(handshake.summaryContractVersion),
    acceptedScopes: cleanList(handshake.acceptedScopes),
    requestedScopes: cleanList(handshake.requestedScopes),
    checks: Array.isArray(handshake.checks)
      ? handshake.checks.map((check) => ({
          id: cleanShortText(check.id),
          label: cleanShortText(check.label),
          status: cleanShortText(check.status),
        }))
      : [],
    safeSummary: cleanText(handshake.safeSummary),
    nextGate: cleanText(handshake.nextGate),
    createdBy: sanitizeActor(handshake.createdBy),
    updatedAt: cleanShortText(handshake.updatedAt),
    updatedBy: sanitizeActor(handshake.updatedBy),
  };
}

function safeSummaryFromSubsystemSummary(summary = {}) {
  const subsystem = summary.subsystem || {};
  return cleanText(
    subsystem.summary ||
    summary.privacyBoundary ||
    `子系统 ${subsystem.id || "unknown"} 已返回控制面安全摘要。`,
  );
}

function hashSummary(summary) {
  const stable = JSON.stringify({
    contractVersion: summary.contractVersion,
    subsystem: summary.subsystem,
    qualitySignals: summary.qualitySignals,
    candidateSummary: summary.candidateSummary,
    recommendedPlatformMapping: summary.recommendedPlatformMapping,
    privacyBoundary: summary.privacyBoundary,
  });
  let hash = 0;
  for (let index = 0; index < stable.length; index += 1) {
    hash = ((hash << 5) - hash + stable.charCodeAt(index)) | 0;
  }
  return `safe-summary:${Math.abs(hash).toString(16)}`;
}

function hasUnsafeText(values = []) {
  return values.some((value) => /(token=|ticket=|password=|secret=|api[_-]?key=|cookie=)/i.test(String(value || "")));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function cleanShortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function cleanList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、]+/);
  return [...new Set(items.map(cleanShortText).filter(Boolean))].slice(0, 40);
}

function normalizeManagementScopes(value, fallback = DEFAULT_ACCEPTED_SCOPES) {
  const requested = cleanList(value);
  const scoped = requested.filter((item) => ALLOWED_MANAGEMENT_SCOPES.has(item));
  if (scoped.length) return scoped;
  const fallbackScopes = cleanList(fallback).filter((item) => ALLOWED_MANAGEMENT_SCOPES.has(item));
  return fallbackScopes.length ? fallbackScopes : [...DEFAULT_ACCEPTED_SCOPES];
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sanitizeActor(actor) {
  if (!actor || typeof actor !== "object") return null;
  return {
    id: cleanShortText(actor.employeeId || actor.id || actor.email),
    name: cleanShortText(actor.name),
    role: cleanShortText(actor.role),
    identitySource: cleanShortText(actor.identitySource),
  };
}

function formatChinaTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function ensureTrailingSlash(value) {
  return String(value || "").endsWith("/") ? value : `${value}/`;
}

function sortUpdatedDesc(left, right) {
  return String(right.updatedAt || right.submittedAt || right.id).localeCompare(String(left.updatedAt || left.submittedAt || left.id));
}
