// Shared validation for a server-selected response format. The same normalized
// value is used at admission, encrypted transcript persistence and execution.
export function normalizedOutputFormat(value) {
  const allowedFields = new Set(["description", "name", "schema", "strict", "type"]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(field => !allowedFields.has(field)) ||
      value.type !== "json_schema" || typeof value.name !== "string" ||
      !value.name.trim() || value.name.length > 120 || !value.schema ||
      typeof value.schema !== "object" || Array.isArray(value.schema)) {
    throw new TypeError("digital employee Agent execution outputFormat is invalid");
  }
  const serialized = JSON.stringify({ ...value, strict: value.strict !== false });
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw new TypeError("digital employee Agent execution outputFormat is too large");
  return Object.freeze(JSON.parse(serialized));
}
