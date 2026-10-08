import { readFileSync } from "node:fs";

function testTlsOptionsFromEnvironment({ environment = process.env, host = "", readFile = readFileSync } = {}) {
  const certificatePath = String(environment.AUTH_TEST_TLS_CERT_PATH || "").trim();
  const keyPath = String(environment.AUTH_TEST_TLS_KEY_PATH || "").trim();
  if (!certificatePath && !keyPath) return null;
  if (!certificatePath || !keyPath || !isLoopbackHost(host)) {
    throw new Error("auth_test_tls_configuration_invalid");
  }
  const cert = readFile(certificatePath);
  const key = readFile(keyPath);
  if (!Buffer.isBuffer(cert) || !cert.length || !Buffer.isBuffer(key) || !key.length) {
    throw new Error("auth_test_tls_configuration_invalid");
  }
  return Object.freeze({ cert, key });
}

function isLoopbackHost(host = "") {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || "").trim().toLowerCase());
}

export { isLoopbackHost, testTlsOptionsFromEnvironment };
