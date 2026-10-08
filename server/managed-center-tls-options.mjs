import { readFileSync } from "node:fs";

function managedCenterTlsOptionsFromEnvironment({ environment = process.env, readFile = readFileSync } = {}) {
  const certificatePath = String(environment.DIGITAL_CENTER_TLS_CERT_PATH || "").trim();
  const keyPath = String(environment.DIGITAL_CENTER_TLS_KEY_PATH || "").trim();
  if (!certificatePath && !keyPath) return null;
  if (!certificatePath || !keyPath) throw new Error("digital_center_tls_configuration_invalid");
  let cert;
  let key;
  try {
    cert = readFile(certificatePath);
    key = readFile(keyPath);
  } catch {
    throw new Error("digital_center_tls_configuration_invalid");
  }
  if (!Buffer.isBuffer(cert) || !cert.length || !Buffer.isBuffer(key) || !key.length) {
    throw new Error("digital_center_tls_configuration_invalid");
  }
  return Object.freeze({ cert, key });
}

export { managedCenterTlsOptionsFromEnvironment };
