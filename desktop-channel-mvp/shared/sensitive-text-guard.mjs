const REDACTION = "[已拦截凭证]";
const AUTHORIZATION_BEARER = /authorization\s*:\s*bearer\s+[^\s<>"']{8,}/gi;
const PREFIXED_BEARER = /\bbearer\s+(?:eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|[a-z0-9._~+/=-]{24,})/gi;
const JWT = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi;
const MAX_CREDENTIAL_LENGTH = 8 * 1024;

function containsCredentialText(value = "") {
  const text = String(value || "");
  return patterns().some((pattern) => pattern.test(text));
}

function redactCredentialText(value = "") {
  let text = String(value || "");
  for (const pattern of patterns()) text = text.replace(pattern, REDACTION);
  return text;
}

function removeCredentialText(value = "") {
  let text = String(value || "");
  for (const pattern of patterns()) text = text.replace(pattern, "");
  return text;
}

function isCredentialOnlyText(value = "") {
  if (!containsCredentialText(value)) return false;
  return removeCredentialText(value)
    .replace(/[\s.,;:!?，。；：！？'"`()\[\]{}<>]+/g, "") === "";
}

function normalizeManualBearerInput(value = "") {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_CREDENTIAL_LENGTH || /[\r\n\0]/.test(text)) return "";
  const match = text.match(/^(?:(?:authorization\s*:\s*)?bearer\s+)?([a-z0-9._~+/=-]{8,})$/i);
  return match?.[1] ? `Bearer ${match[1]}` : "";
}

function patterns() {
  return [new RegExp(AUTHORIZATION_BEARER), new RegExp(PREFIXED_BEARER), new RegExp(JWT)];
}

export { containsCredentialText, isCredentialOnlyText, normalizeManualBearerInput, redactCredentialText, removeCredentialText };
