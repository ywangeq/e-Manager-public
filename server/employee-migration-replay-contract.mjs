import { createHmac } from "node:crypto";

const CONTRACT_VERSION = "employee-migration-replay.v1";
const PROFILE_VERSION = "employee-migration-replay-profile.v1";
const BUSINESS_STATUSES = new Set(["succeeded", "partial_failed", "failed", "skipped_duplicate", "blocked"]);
const ACTION_OPERATIONS = new Set(["read", "create", "update", "delete", "retain"]);
const ACTION_DECISIONS = new Set(["planned", "skipped_guard", "skipped_duplicate", "failed"]);
const LEASE_OUTCOMES = new Set(["winner", "loser", "not_applicable"]);
const DEDUPE_DECISIONS = new Set(["execute", "skip_duplicate", "not_applicable"]);
const COUNT_KEYS = new Set(["inspected", "planned", "created", "updated", "deleted", "retained", "blocked", "failed", "skipped"]);

function normalizeEmployeeMigrationReplaySample(input, profileInput) {
  const profile = normalizeProfile(profileInput);
  object(input, "sample");
  exactKeys(input, [
    "contractVersion", "sampleId", "scenario", "employeeId", "dataClass", "producer", "writebackMode",
    "provenance", "trigger", "inputs", "result", "safetyEvidence",
  ], "sample");
  equal(input.contractVersion, CONTRACT_VERSION, "contract_version_unsupported", "sample.contractVersion");
  equal(input.employeeId, profile.employeeId, "profile_employee_mismatch", "sample.employeeId");
  equal(input.writebackMode, "preview_only", "writeback_mode_not_preview_only", "sample.writebackMode");
  const dataClass = enumeration(input.dataClass, new Set(["synthetic", "derived"]), "sample.dataClass");
  const scenario = profileCode(input.scenario, profile.scenarios, "sample.scenario");
  const normalized = {
    contractVersion: CONTRACT_VERSION,
    sampleId: safeReference(input.sampleId, "sample.sampleId", ["sample"]),
    scenario,
    employeeId: profile.employeeId,
    dataClass,
    producer: normalizeProducer(input.producer),
    writebackMode: "preview_only",
    provenance: normalizeProvenance(input.provenance),
    trigger: normalizeTrigger(input.trigger, dataClass),
    inputs: normalizeInputs(input.inputs, profile, dataClass),
    result: normalizeResult(input.result, profile, dataClass),
    safetyEvidence: normalizeSafetyEvidence(input.safetyEvidence),
  };
  assertResultInvariants(normalized.result, profile);
  return normalized;
}

function compareEmployeeMigrationReplaySamples(baselineInput, candidateInput, profileInput) {
  const baseline = normalizeEmployeeMigrationReplaySample(baselineInput, profileInput);
  const candidate = normalizeEmployeeMigrationReplaySample(candidateInput, profileInput);
  equal(baseline.producer.role, "legacy", "baseline_role_invalid", "baseline.producer.role");
  equal(candidate.producer.role, "candidate", "candidate_role_invalid", "candidate.producer.role");
  if (baseline.producer.runRef === candidate.producer.runRef) fail("producer_run_not_independent", "producer.runRef");
  if (baseline.producer.implementationDigest === candidate.producer.implementationDigest) {
    fail("producer_implementation_not_independent", "producer.implementationDigest");
  }
  const mismatches = [];
  compareValues(comparisonProjection(baseline), comparisonProjection(candidate), "$", mismatches);
  return {
    contractVersion: CONTRACT_VERSION,
    sampleId: baseline.sampleId,
    employeeId: baseline.employeeId,
    matched: mismatches.length === 0,
    mismatches,
  };
}

function normalizeProfile(value) {
  object(value, "profile");
  exactKeys(value, [
    "contractVersion", "profileId", "employeeId", "scenarios", "factPolicies", "artifactTypeCodes",
    "actionCategoryCodes", "guardCodes", "requiredPassedGuardsByOperation", "stageCodes", "errorCodes", "nextGateCodes",
  ], "profile");
  equal(value.contractVersion, PROFILE_VERSION, "profile_version_unsupported", "profile.contractVersion");
  const factPolicies = new Map(array(value.factPolicies, "profile.factPolicies").map((policy, index) => {
    const path = `profile.factPolicies[${index}]`;
    object(policy, path);
    exactKeys(policy, ["code", "valueType", "allowedValueCodes"], path);
    const code = token(policy.code, `${path}.code`);
    const valueType = enumeration(policy.valueType, new Set(["boolean", "code", "bucket"]), `${path}.valueType`);
    const allowedValueCodes = valueType === "boolean"
      ? []
      : uniqueTokens(policy.allowedValueCodes, `${path}.allowedValueCodes`);
    if (valueType !== "boolean" && !allowedValueCodes.length) fail("profile_fact_values_required", path);
    return [code, { code, valueType, allowedValueCodes: new Set(allowedValueCodes) }];
  }));
  if (factPolicies.size !== value.factPolicies.length) fail("profile_fact_code_duplicate", "profile.factPolicies");
  const requiredPassedGuardsByOperation = {};
  object(value.requiredPassedGuardsByOperation, "profile.requiredPassedGuardsByOperation");
  exactKeys(value.requiredPassedGuardsByOperation, [...ACTION_OPERATIONS], "profile.requiredPassedGuardsByOperation");
  for (const [operation, codes] of Object.entries(value.requiredPassedGuardsByOperation)) {
    requiredPassedGuardsByOperation[operation] = uniqueTokens(codes, `profile.requiredPassedGuardsByOperation.${operation}`);
  }
  return {
    profileId: token(value.profileId, "profile.profileId"),
    employeeId: token(value.employeeId, "profile.employeeId"),
    scenarios: new Set(uniqueTokens(value.scenarios, "profile.scenarios")),
    factPolicies,
    artifactTypeCodes: new Set(uniqueTokens(value.artifactTypeCodes, "profile.artifactTypeCodes")),
    actionCategoryCodes: new Set(uniqueTokens(value.actionCategoryCodes, "profile.actionCategoryCodes")),
    guardCodes: new Set(uniqueTokens(value.guardCodes, "profile.guardCodes")),
    requiredPassedGuardsByOperation,
    stageCodes: new Set(uniqueTokens(value.stageCodes, "profile.stageCodes")),
    errorCodes: new Set(uniqueTokens(value.errorCodes, "profile.errorCodes")),
    nextGateCodes: new Set(uniqueTokens(value.nextGateCodes, "profile.nextGateCodes")),
  };
}

function normalizeProducer(value) {
  object(value, "producer");
  exactKeys(value, ["role", "runRef", "implementationDigest"], "producer");
  return {
    role: enumeration(value.role, new Set(["legacy", "candidate"]), "producer.role"),
    runRef: safeReference(value.runRef, "producer.runRef", ["run"]),
    implementationDigest: digest(value.implementationDigest, "producer.implementationDigest"),
  };
}

function normalizeProvenance(value) {
  object(value, "provenance");
  exactKeys(value, [
    "sourceRevision", "ruleDigest", "promptDigest", "scheduleDigest", "runtimeVersion", "modelRouteId", "capabilityVersion",
  ], "provenance");
  return {
    sourceRevision: token(value.sourceRevision, "provenance.sourceRevision"),
    ruleDigest: digest(value.ruleDigest, "provenance.ruleDigest"),
    promptDigest: digest(value.promptDigest, "provenance.promptDigest"),
    scheduleDigest: digest(value.scheduleDigest, "provenance.scheduleDigest"),
    runtimeVersion: token(value.runtimeVersion, "provenance.runtimeVersion"),
    modelRouteId: token(value.modelRouteId, "provenance.modelRouteId"),
    capabilityVersion: token(value.capabilityVersion, "provenance.capabilityVersion"),
  };
}

function normalizeTrigger(value, dataClass) {
  object(value, "trigger");
  exactKeys(value, [
    "scheduleId", "taskId", "windowOrdinal", "windowOffsetMinutes", "windowDurationMinutes", "timezone", "leaseKeyRef",
  ], "trigger");
  return {
    scheduleId: token(value.scheduleId, "trigger.scheduleId"),
    taskId: token(value.taskId, "trigger.taskId"),
    windowOrdinal: integer(value.windowOrdinal, -1_000_000, 1_000_000, "trigger.windowOrdinal"),
    windowOffsetMinutes: integer(value.windowOffsetMinutes, -1_000_000, 1_000_000, "trigger.windowOffsetMinutes"),
    windowDurationMinutes: integer(value.windowDurationMinutes, 1, 1440, "trigger.windowDurationMinutes"),
    timezone: token(value.timezone, "trigger.timezone"),
    leaseKeyRef: sourceReference(value.leaseKeyRef, "trigger.leaseKeyRef", ["lease"], dataClass),
  };
}

function normalizeInputs(value, profile, dataClass) {
  object(value, "inputs");
  exactKeys(value, ["subjectRef", "scopeMatch", "facts", "artifacts"], "inputs");
  const facts = array(value.facts, "inputs.facts").map((item, index) => normalizeFact(item, index, "inputs.facts", profile));
  const artifacts = array(value.artifacts, "inputs.artifacts").map((item, index) => normalizeArtifact(item, index, profile, dataClass));
  assertUnique(facts, (item) => item.code, "fact_code_duplicate", "inputs.facts");
  assertUnique(artifacts, (item) => item.artifactRef, "artifact_ref_duplicate", "inputs.artifacts");
  return {
    subjectRef: sourceReference(value.subjectRef, "inputs.subjectRef", ["subject"], dataClass),
    scopeMatch: boolean(value.scopeMatch, "inputs.scopeMatch"),
    facts: facts.sort(compareByCode),
    artifacts: artifacts.sort((left, right) => left.artifactRef.localeCompare(right.artifactRef)),
  };
}

function normalizeFact(value, index, pathPrefix, profile) {
  const path = `${pathPrefix}[${index}]`;
  object(value, path);
  exactKeys(value, ["code", "booleanValue", "valueCode", "bucketCode"], path);
  const policy = profile.factPolicies.get(String(value.code || ""));
  if (!policy) fail("profile_fact_code_rejected", `${path}.code`);
  const populated = ["booleanValue", "valueCode", "bucketCode"].filter((key) => value[key] !== undefined);
  if (populated.length !== 1) fail("fact_value_count_invalid", path);
  if (policy.valueType === "boolean" && populated[0] !== "booleanValue") fail("fact_value_type_invalid", path);
  if (policy.valueType === "code" && populated[0] !== "valueCode") fail("fact_value_type_invalid", path);
  if (policy.valueType === "bucket" && populated[0] !== "bucketCode") fail("fact_value_type_invalid", path);
  const result = { code: policy.code };
  if (value.booleanValue !== undefined) result.booleanValue = boolean(value.booleanValue, `${path}.booleanValue`);
  if (value.valueCode !== undefined) result.valueCode = profileCode(value.valueCode, policy.allowedValueCodes, `${path}.valueCode`);
  if (value.bucketCode !== undefined) result.bucketCode = profileCode(value.bucketCode, policy.allowedValueCodes, `${path}.bucketCode`);
  return result;
}

function normalizeArtifact(value, index, profile, dataClass) {
  const path = `inputs.artifacts[${index}]`;
  object(value, path);
  exactKeys(value, ["artifactRef", "artifactTypeCode", "facts"], path);
  const facts = array(value.facts, `${path}.facts`).map((item, factIndex) => normalizeFact(item, factIndex, `${path}.facts`, profile));
  assertUnique(facts, (item) => item.code, "fact_code_duplicate", `${path}.facts`);
  return {
    artifactRef: sourceReference(value.artifactRef, `${path}.artifactRef`, ["artifact"], dataClass),
    artifactTypeCode: profileCode(value.artifactTypeCode, profile.artifactTypeCodes, `${path}.artifactTypeCode`),
    facts: facts.sort(compareByCode),
  };
}

function normalizeResult(value, profile, dataClass) {
  object(value, "result");
  exactKeys(value, ["businessStatus", "counts", "errors", "actions", "dedupe", "resultFacts", "nextGateCode"], "result");
  const errors = array(value.errors, "result.errors").map((item, index) => normalizeError(item, index, profile, dataClass));
  const actions = array(value.actions, "result.actions").map((item, index) => normalizeAction(item, index, profile, dataClass));
  const resultFacts = array(value.resultFacts, "result.resultFacts")
    .map((item, index) => normalizeFact(item, index, "result.resultFacts", profile));
  assertUnique(resultFacts, (item) => item.code, "fact_code_duplicate", "result.resultFacts");
  assertUnique(actions, semanticActionKey, "semantic_action_duplicate", "result.actions");
  return {
    businessStatus: enumeration(value.businessStatus, BUSINESS_STATUSES, "result.businessStatus"),
    counts: normalizeCounts(value.counts),
    errors: errors.sort(compareStableObjects),
    actions: actions.sort(compareStableObjects),
    dedupe: normalizeDedupe(value.dedupe, dataClass),
    resultFacts: resultFacts.sort(compareByCode),
    nextGateCode: profileCode(value.nextGateCode, profile.nextGateCodes, "result.nextGateCode"),
  };
}

function normalizeCounts(value) {
  object(value, "result.counts");
  exactKeys(value, [...COUNT_KEYS], "result.counts");
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, integer(item, 0, 1_000_000, `result.counts.${key}`)]));
}

function normalizeError(value, index, profile, dataClass) {
  const path = `result.errors[${index}]`;
  object(value, path);
  exactKeys(value, ["stageCode", "operation", "errorCode", "retryable", "targetRef"], path);
  return {
    stageCode: profileCode(value.stageCode, profile.stageCodes, `${path}.stageCode`),
    operation: enumeration(value.operation, ACTION_OPERATIONS, `${path}.operation`),
    errorCode: profileCode(value.errorCode, profile.errorCodes, `${path}.errorCode`),
    retryable: boolean(value.retryable, `${path}.retryable`),
    targetRef: sourceReference(value.targetRef, `${path}.targetRef`, ["subject", "artifact"], dataClass),
  };
}

function normalizeAction(value, index, profile, dataClass) {
  const path = `result.actions[${index}]`;
  object(value, path);
  exactKeys(value, ["operation", "categoryCode", "targetRef", "guards", "decision", "errorCode"], path);
  const guards = array(value.guards, `${path}.guards`).map((item, guardIndex) => normalizeGuard(item, path, guardIndex, profile));
  assertUnique(guards, (item) => item.code, "guard_code_duplicate", `${path}.guards`);
  const result = {
    operation: enumeration(value.operation, ACTION_OPERATIONS, `${path}.operation`),
    categoryCode: profileCode(value.categoryCode, profile.actionCategoryCodes, `${path}.categoryCode`),
    targetRef: sourceReference(value.targetRef, `${path}.targetRef`, ["subject", "artifact"], dataClass),
    guards: guards.sort(compareByCode),
    decision: enumeration(value.decision, ACTION_DECISIONS, `${path}.decision`),
  };
  if (value.errorCode !== undefined) result.errorCode = profileCode(value.errorCode, profile.errorCodes, `${path}.errorCode`);
  return result;
}

function normalizeGuard(value, parentPath, index, profile) {
  const path = `${parentPath}.guards[${index}]`;
  object(value, path);
  exactKeys(value, ["code", "passed"], path);
  return {
    code: profileCode(value.code, profile.guardCodes, `${path}.code`),
    passed: boolean(value.passed, `${path}.passed`),
  };
}

function normalizeDedupe(value, dataClass) {
  object(value, "result.dedupe");
  exactKeys(value, ["reconcileKeyRef", "leaseOutcome", "dedupeDecision"], "result.dedupe");
  return {
    reconcileKeyRef: sourceReference(value.reconcileKeyRef, "result.dedupe.reconcileKeyRef", ["reconcile"], dataClass),
    leaseOutcome: enumeration(value.leaseOutcome, LEASE_OUTCOMES, "result.dedupe.leaseOutcome"),
    dedupeDecision: enumeration(value.dedupeDecision, DEDUPE_DECISIONS, "result.dedupe.dedupeDecision"),
  };
}

function assertResultInvariants(result, profile) {
  const failedCount = result.counts.failed ?? 0;
  const plannedCount = result.actions.filter((item) => item.decision === "planned").length;
  const skippedCount = result.actions.filter((item) => item.decision === "skipped_guard" || item.decision === "skipped_duplicate").length;
  if (result.counts.planned !== undefined && result.counts.planned !== plannedCount) fail("planned_count_mismatch", "result.counts.planned");
  if (result.counts.failed !== undefined && failedCount !== result.errors.length) fail("failed_count_mismatch", "result.counts.failed");
  if (result.counts.skipped !== undefined && result.counts.skipped !== skippedCount) fail("skipped_count_mismatch", "result.counts.skipped");
  if (result.businessStatus === "succeeded" && (result.errors.length || failedCount)) fail("succeeded_with_failures", "result.businessStatus");
  if (["partial_failed", "failed"].includes(result.businessStatus) && !result.errors.length) fail("failed_status_without_errors", "result.businessStatus");
  if (result.dedupe.leaseOutcome === "loser" && result.dedupe.dedupeDecision !== "skip_duplicate") fail("loser_dedupe_invalid", "result.dedupe");
  if (result.dedupe.dedupeDecision === "skip_duplicate" && plannedCount) fail("duplicate_with_planned_actions", "result.actions");
  if (result.businessStatus === "skipped_duplicate") {
    if (result.dedupe.leaseOutcome !== "loser" || result.dedupe.dedupeDecision !== "skip_duplicate") fail("duplicate_status_invalid", "result.dedupe");
    if (result.actions.some((item) => item.decision !== "skipped_duplicate")) fail("duplicate_status_action_invalid", "result.actions");
  }
  if (result.businessStatus === "blocked" && plannedCount) fail("blocked_with_planned_actions", "result.actions");
  for (const action of result.actions.filter((item) => item.decision === "planned")) {
    const guardMap = new Map(action.guards.map((guard) => [guard.code, guard.passed]));
    for (const requiredCode of profile.requiredPassedGuardsByOperation[action.operation] || []) {
      if (guardMap.get(requiredCode) !== true) fail("required_guard_not_passed", `result.actions.${action.operation}.${requiredCode}`);
    }
  }
}

function normalizeSafetyEvidence(value) {
  object(value, "safetyEvidence");
  exactKeys(value, [
    "executionMode", "toolMode", "networkMode", "scheduleMode", "productionEffect", "externalRequestCount",
    "credentialResolutionCount", "writebackAttemptCount", "scheduleStartCount",
  ], "safetyEvidence");
  for (const [key, expected] of Object.entries({
    executionMode: "offline_replay", toolMode: "fixture_only", networkMode: "disabled", scheduleMode: "disabled", productionEffect: "none",
    externalRequestCount: 0, credentialResolutionCount: 0, writebackAttemptCount: 0, scheduleStartCount: 0,
  })) equal(value[key], expected, `${key}_invalid`, `safetyEvidence.${key}`);
  return structuredClone(value);
}

function comparisonProjection(sample) {
  return {
    sampleId: sample.sampleId,
    scenario: sample.scenario,
    employeeId: sample.employeeId,
    dataClass: sample.dataClass,
    writebackMode: sample.writebackMode,
    provenance: {
      ruleDigest: sample.provenance.ruleDigest,
      promptDigest: sample.provenance.promptDigest,
      scheduleDigest: sample.provenance.scheduleDigest,
      modelRouteId: sample.provenance.modelRouteId,
      capabilityVersion: sample.provenance.capabilityVersion,
    },
    trigger: sample.trigger,
    inputs: sample.inputs,
    result: sample.result,
    safetyEvidence: sample.safetyEvidence,
  };
}

function createEmployeeMigrationReplayReference(referenceType, value, key) {
  const type = String(referenceType || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(type)) fail("reference_type_invalid", "reference.type");
  const source = String(value || "");
  const secret = String(key || "");
  if (!source) fail("reference_source_required", "reference.value");
  if (Buffer.byteLength(secret, "utf8") < 32) fail("hmac_key_too_short", "reference.key");
  const payload = `${CONTRACT_VERSION}\u0000${type}\u0000${source}`;
  return `hmac-sha256:${type}:${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
}

function sourceReference(value, path, types, dataClass) {
  const result = safeReference(value, path, types);
  if (dataClass === "derived" && result.startsWith("synthetic:")) fail("derived_reference_requires_hmac", path);
  return result;
}

function safeReference(value, path, types) {
  const result = String(value || "").trim().toLowerCase();
  const match = result.match(/^(synthetic|hmac-sha256):([a-z0-9][a-z0-9._-]{0,39}):([a-z0-9][a-z0-9._:-]{0,150})$/);
  if (!match || !types.includes(match[2])) fail("typed_safe_reference_required", path);
  if (match[1] === "hmac-sha256" && !/^[a-f0-9]{64}$/.test(match[3])) fail("typed_safe_reference_required", path);
  return result;
}

function semanticActionKey(action) {
  return `${action.operation}\u0000${action.categoryCode}\u0000${action.targetRef}`;
}

function compareValues(left, right, path, mismatches) {
  if (Object.is(left, right)) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) mismatches.push({ path: `${path}.length`, baseline: left.length, candidate: right.length });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) compareValues(left[index], right[index], `${path}[${index}]`, mismatches);
    return;
  }
  if (isObject(left) && isObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) compareValues(left[key], right[key], `${path}.${key}`, mismatches);
    return;
  }
  mismatches.push({ path, baseline: left ?? null, candidate: right ?? null });
}

function profileCode(value, allowed, path) {
  const result = token(value, path);
  if (!allowed.has(result)) fail("profile_code_rejected", path);
  return result;
}

function assertUnique(items, keyFor, code, path) {
  const keys = items.map(keyFor);
  if (new Set(keys).size !== keys.length) fail(code, path);
}

function uniqueTokens(value, path) {
  const result = array(value, path).map((item, index) => token(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail("profile_code_duplicate", path);
  return result;
}

function exactKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key)).sort()[0];
  if (extra) fail("additional_property_rejected", `${path}.${extra}`);
}

function digest(value, path) {
  const result = String(value || "").trim().toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(result)) return result;
  fail("sha256_digest_required", path);
}

function token(value, path) {
  const result = String(value || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(result)) return result;
  fail("controlled_token_required", path);
}

function integer(value, minimum, maximum, path) {
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  fail("bounded_integer_required", path);
}

function boolean(value, path) {
  if (typeof value === "boolean") return value;
  fail("boolean_required", path);
}

function enumeration(value, allowed, path) {
  if (allowed.has(value)) return value;
  fail("enum_value_rejected", path);
}

function array(value, path) {
  if (Array.isArray(value) && value.length <= 1000) return value;
  fail("bounded_array_required", path);
}

function object(value, path) {
  if (isObject(value)) return value;
  fail("object_required", path);
}

function equal(actual, expected, code, path) {
  if (actual !== expected) fail(code, path);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareByCode(left, right) {
  return left.code.localeCompare(right.code);
}

function compareStableObjects(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function fail(code, path) {
  const error = new Error(`${code}:${path}`);
  error.code = code;
  error.path = path;
  throw error;
}

export {
  CONTRACT_VERSION,
  PROFILE_VERSION,
  compareEmployeeMigrationReplaySamples,
  createEmployeeMigrationReplayReference,
  normalizeEmployeeMigrationReplaySample,
};
