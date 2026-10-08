import { createHash } from "node:crypto";
import { validateJsonValue } from "./openapi-contract.mjs";

const RESULT_STATUSES = new Set(["completed", "blocked", "failed"]);
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_DEFINITION_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 12;

function createReplayToolExecutor({ dataClass = "", fixtures = [], resultPolicy, toolDefinitions = [] } = {}) {
  if (!["synthetic", "derived"].includes(dataClass)) throw replayError("replay_data_class_required", "dataClass");
  const policy = normalizeResultPolicy(resultPolicy);
  const definitions = normalizeDefinitions(toolDefinitions);
  const definitionMap = new Map(definitions.map((definition) => [definition.name, definition]));
  const fixtureMap = new Map();
  for (const [index, fixture] of boundedArray(fixtures, "fixtures").entries()) {
    const normalized = normalizeFixture(fixture, index, policy);
    if (!definitionMap.has(normalized.name)) throw replayError("replay_fixture_tool_not_declared", `fixtures[${index}].name`);
    const key = fixtureKey(normalized.name, normalized.argumentsDigest);
    if (fixtureMap.has(key)) throw replayError("replay_fixture_conflict", `fixtures[${index}]`);
    fixtureMap.set(key, normalized);
  }
  const plans = [];

  return {
    agentResultFor(result = {}) {
      return {
        status: result.status,
        resultCode: result.resultCode,
        facts: structuredClone(result.facts || []),
        counts: structuredClone(result.counts || {}),
      };
    },
    availableAgentContent() {
      return [];
    },
    async execute({ name = "", arguments: input = {} } = {}) {
      const toolName = controlledToken(name, "toolCall.name");
      if (!definitionMap.has(toolName)) return recordBlocked(toolName, "", "tool_not_allowed");
      const definition = definitionMap.get(toolName);
      const schemaResult = validateJsonValue(definition.parameters || {}, input, "arguments");
      if (!schemaResult.ok) return recordBlocked(toolName, "", "replay_arguments_invalid");
      try {
        assertSafeReplayArguments(input, definition.parameters || {}, "arguments", 0, dataClass);
      } catch (error) {
        if (error?.code === "replay_argument_value_unsafe") return recordBlocked(toolName, "", error.code);
        throw error;
      }
      const argumentsDigest = replayArgumentsDigest(input);
      const fixture = fixtureMap.get(fixtureKey(toolName, argumentsDigest));
      if (!fixture) return recordBlocked(toolName, argumentsDigest, "replay_fixture_missing");
      const result = {
        ok: fixture.result.status === "completed",
        status: fixture.result.status,
        resultCode: fixture.result.resultCode,
        facts: structuredClone(fixture.result.facts),
        counts: structuredClone(fixture.result.counts),
        argumentsDigest,
        replay: true,
      };
      plans.push(planFor(toolName, argumentsDigest, result));
      return result;
    },
    plans() {
      return structuredClone(plans);
    },
    runtimeStatus() {
      return {
        status: "offline_replay",
        dataClass,
        fixtureCount: fixtureMap.size,
        productionEffect: "none",
      };
    },
    safeToolCatalog() {
      return definitions.map((definition) => ({
        id: definition.name,
        name: definition.name,
        description: String(definition.description || "").trim().slice(0, 500),
      }));
    },
    safetyEvidence() {
      return {
        executionMode: "offline_replay",
        toolMode: "fixture_only",
        networkMode: "disabled",
        scheduleMode: "disabled",
        productionEffect: "none",
        externalRequestCount: 0,
        credentialResolutionCount: 0,
        writebackAttemptCount: 0,
        scheduleStartCount: 0,
      };
    },
    toolDefinitions() {
      return structuredClone(definitions);
    },
  };

  function recordBlocked(toolName, argumentsDigest, resultCode) {
    const result = {
      ok: false,
      status: "blocked",
      resultCode,
      facts: [],
      counts: {},
      argumentsDigest,
      replay: true,
    };
    plans.push(planFor(toolName, argumentsDigest, result));
    return result;
  }
}

function normalizeDefinitions(value) {
  const definitions = boundedArray(value, "toolDefinitions").map((definition, index) => {
    if (!isObject(definition)) throw replayError("replay_tool_definition_invalid", `toolDefinitions[${index}]`);
    const name = controlledToken(definition.name, `toolDefinitions[${index}].name`);
    if (!isObject(definition.parameters) || definition.parameters.type !== "object" || definition.parameters.additionalProperties !== false) {
      throw replayError("replay_tool_schema_not_strict", `toolDefinitions[${index}].parameters`);
    }
    if (Buffer.byteLength(stableJson(definition), "utf8") > MAX_DEFINITION_BYTES) {
      throw replayError("replay_tool_definition_too_large", `toolDefinitions[${index}]`);
    }
    return structuredClone({ ...definition, name });
  });
  if (new Set(definitions.map((definition) => definition.name)).size !== definitions.length) {
    throw replayError("replay_tool_name_conflict", "toolDefinitions");
  }
  return definitions;
}

function normalizeFixture(value, index, policy) {
  const path = `fixtures[${index}]`;
  if (!isObject(value)) throw replayError("replay_fixture_invalid", path);
  exactKeys(value, ["name", "argumentsDigest", "result"], path);
  return {
    name: controlledToken(value.name, `${path}.name`),
    argumentsDigest: sha256Digest(value.argumentsDigest, `${path}.argumentsDigest`),
    result: normalizeFixtureResult(value.result, `${path}.result`, policy),
  };
}

function normalizeFixtureResult(value, path, policy) {
  if (!isObject(value)) throw replayError("replay_fixture_result_invalid", path);
  exactKeys(value, ["status", "resultCode", "facts", "counts"], path);
  if (!RESULT_STATUSES.has(value.status)) throw replayError("replay_fixture_status_invalid", `${path}.status`);
  return {
    status: value.status,
    resultCode: allowedCode(value.resultCode, policy.resultCodes, `${path}.resultCode`),
    facts: boundedArray(value.facts, `${path}.facts`).map((fact, index) => normalizeFact(fact, `${path}.facts[${index}]`, policy)),
    counts: normalizeCounts(value.counts, `${path}.counts`, policy),
  };
}

function normalizeFact(value, path, policy) {
  if (!isObject(value)) throw replayError("replay_fact_invalid", path);
  exactKeys(value, ["code", "booleanValue", "valueCode", "bucketCode"], path);
  const factPolicy = policy.factPolicies.get(String(value.code || ""));
  if (!factPolicy) throw replayError("replay_fact_code_rejected", `${path}.code`);
  const populated = ["booleanValue", "valueCode", "bucketCode"].filter((key) => value[key] !== undefined);
  if (populated.length !== 1) throw replayError("replay_fact_value_invalid", path);
  const expectedField = { boolean: "booleanValue", code: "valueCode", bucket: "bucketCode" }[factPolicy.valueType];
  if (populated[0] !== expectedField) throw replayError("replay_fact_value_invalid", path);
  const result = { code: factPolicy.code };
  if (value.booleanValue !== undefined) {
    if (typeof value.booleanValue !== "boolean") throw replayError("replay_fact_value_invalid", `${path}.booleanValue`);
    result.booleanValue = value.booleanValue;
  }
  if (value.valueCode !== undefined) result.valueCode = allowedCode(value.valueCode, factPolicy.allowedValues, `${path}.valueCode`);
  if (value.bucketCode !== undefined) result.bucketCode = allowedCode(value.bucketCode, factPolicy.allowedValues, `${path}.bucketCode`);
  return result;
}

function normalizeCounts(value, path, policy) {
  if (!isObject(value)) throw replayError("replay_counts_invalid", path);
  if (Object.keys(value).length > 100) throw replayError("replay_counts_invalid", path);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => [
    allowedCode(key, policy.countCodes, `${path}.key`),
    boundedInteger(count, `${path}.${key}`),
  ]));
}

function normalizeResultPolicy(value) {
  if (!isObject(value)) throw replayError("replay_result_policy_required", "resultPolicy");
  exactKeys(value, ["resultCodes", "factPolicies", "countCodes"], "resultPolicy");
  const factPolicies = new Map(boundedArray(value.factPolicies, "resultPolicy.factPolicies").map((item, index) => {
    const path = `resultPolicy.factPolicies[${index}]`;
    if (!isObject(item)) throw replayError("replay_fact_policy_invalid", path);
    exactKeys(item, ["code", "valueType", "allowedValueCodes"], path);
    const code = controlledToken(item.code, `${path}.code`);
    const valueType = String(item.valueType || "");
    if (!["boolean", "code", "bucket"].includes(valueType)) throw replayError("replay_fact_policy_invalid", `${path}.valueType`);
    const allowedValues = new Set((valueType === "boolean" ? [] : boundedArray(item.allowedValueCodes, `${path}.allowedValueCodes`))
      .map((entry, entryIndex) => controlledToken(entry, `${path}.allowedValueCodes[${entryIndex}]`)));
    if (valueType !== "boolean" && !allowedValues.size) throw replayError("replay_fact_policy_invalid", path);
    return [code, { code, valueType, allowedValues }];
  }));
  if (factPolicies.size !== value.factPolicies.length) throw replayError("replay_fact_policy_conflict", "resultPolicy.factPolicies");
  return {
    resultCodes: tokenSet(value.resultCodes, "resultPolicy.resultCodes"),
    factPolicies,
    countCodes: tokenSet(value.countCodes, "resultPolicy.countCodes"),
  };
}

function replayArgumentsDigest(value) {
  if (!isJsonValue(value, 0)) throw replayError("replay_arguments_not_json", "toolCall.arguments");
  const canonical = stableJson(value);
  if (Buffer.byteLength(canonical, "utf8") > MAX_ARGUMENT_BYTES) throw replayError("replay_arguments_too_large", "toolCall.arguments");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertSafeReplayArguments(value, schema, path, depth, dataClass) {
  if (depth > MAX_JSON_DEPTH) throw replayError("replay_argument_value_unsafe", path);
  if (typeof value === "string") {
    const allowed = Array.isArray(schema?.enum) && schema.enum.some((item) => item === value);
    const syntheticRef = /^synthetic:[a-z0-9][a-z0-9._-]{0,39}:[a-z0-9][a-z0-9._:-]{0,150}$/i.test(value);
    const hmacRef = /^hmac-sha256:[a-z0-9][a-z0-9._-]{0,39}:[a-f0-9]{64}$/i.test(value);
    const safeRef = hmacRef || (dataClass === "synthetic" && syntheticRef);
    if (!allowed && !safeRef) throw replayError("replay_argument_value_unsafe", path);
    return;
  }
  if (typeof value === "number") {
    if (!Array.isArray(schema?.enum) || !schema.enum.some((item) => item === value)) throw replayError("replay_argument_value_unsafe", path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeReplayArguments(item, schema?.items || {}, `${path}[${index}]`, depth + 1, dataClass));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childSchema = schema?.properties?.[key] || (isObject(schema?.additionalProperties) ? schema.additionalProperties : {});
      assertSafeReplayArguments(item, childSchema, `${path}.${key}`, depth + 1, dataClass);
    }
  }
}

function planFor(name, argumentsDigest, result) {
  return {
    name,
    argumentsDigest,
    status: result.status,
    resultCode: result.resultCode,
    productionEffect: "none",
  };
}

function fixtureKey(name, argumentsDigest) {
  return `${name}\u0000${argumentsDigest}`;
}

function sha256Digest(value, path) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw replayError("sha256_digest_required", path);
  return result;
}

function controlledToken(value, path) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(result)) throw replayError("controlled_token_required", path);
  return result;
}

function allowedCode(value, allowed, path) {
  const result = controlledToken(value, path);
  if (!allowed.has(result)) throw replayError("replay_code_rejected", path);
  return result;
}

function tokenSet(value, path) {
  const items = boundedArray(value, path).map((item, index) => controlledToken(item, `${path}[${index}]`));
  if (!items.length || new Set(items).size !== items.length) throw replayError("replay_code_set_invalid", path);
  return new Set(items);
}

function boundedInteger(value, path) {
  if (!Number.isInteger(value) || value < -1_000_000 || value > 1_000_000) throw replayError("bounded_integer_required", path);
  return value;
}

function boundedArray(value, path) {
  if (!Array.isArray(value) || value.length > 1000) throw replayError("bounded_array_required", path);
  return value;
}

function exactKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key)).sort()[0];
  if (extra) throw replayError("additional_property_rejected", `${path}.${extra}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isJsonValue(value, depth) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every((item) => isJsonValue(item, depth + 1));
  return isObject(value) && Object.keys(value).length <= 1000 && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function replayError(code, path) {
  const error = new Error(`${code}:${path}`);
  error.code = code;
  error.path = path;
  return error;
}

export { createReplayToolExecutor, replayArgumentsDigest };
