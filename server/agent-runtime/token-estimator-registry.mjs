import { getEncoding } from "js-tiktoken";

const TIKTOKEN_ESTIMATOR_PREFIX = "tiktoken:";
const UTF8_BYTE_UPPER_BOUND_ESTIMATOR_ID = "utf8-byte-upper-bound:v1";

function createTiktokenEstimatorRegistry({ loadEncoding = getEncoding } = {}) {
  const encodings = new Map();

  function resolve(estimatorId = "") {
    const id = String(estimatorId || "").trim();
    if (id === UTF8_BYTE_UPPER_BOUND_ESTIMATOR_ID) {
      // Byte-level tokenizers cannot emit more tokens than the serialized UTF-8 byte count.
      return (value) => Buffer.byteLength(stableJson(value), "utf8");
    }
    if (!id.startsWith(TIKTOKEN_ESTIMATOR_PREFIX)) return null;
    const encodingName = id.slice(TIKTOKEN_ESTIMATOR_PREFIX.length);
    if (!/^[a-z0-9_]{1,80}$/.test(encodingName)) return null;
    let encoding = encodings.get(encodingName);
    if (!encoding) {
      try {
        encoding = loadEncoding(encodingName);
      } catch {
        return null;
      }
      if (!encoding || typeof encoding.encode !== "function") return null;
      encodings.set(encodingName, encoding);
    }
    return (value) => encoding.encode(stableJson(value)).length;
  }

  function close() {
    for (const encoding of encodings.values()) encoding.free?.();
    encodings.clear();
  }

  return { close, resolve };
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export {
  TIKTOKEN_ESTIMATOR_PREFIX,
  UTF8_BYTE_UPPER_BOUND_ESTIMATOR_ID,
  createTiktokenEstimatorRegistry,
};
