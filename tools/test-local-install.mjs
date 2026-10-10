import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeLocalInstallation } from "./local-install.mjs";
import { verifyLocalPassword, assertLocalBinding } from "../server/auth/local-account.mjs";
import { digitalEmployees, basicSkills, businessSkills, preReviewWorkers, enterpriseTools, enterpriseToolBuiltinMigrations } from "../src/data/catalog.js";
import { DIGITAL_EMPLOYEE_CHARACTER_REGISTRY } from "../src/data/digitalEmployeeCharacters.js";
import { localCenterUrl } from "../desktop-channel-mvp/shared/local-center.mjs";

test("installation stores a hash and preserves an existing account", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e-manager-install-"));
  const prior = process.env.DIGITAL_WORKFORCE_DATA_DIR;
  process.env.DIGITAL_WORKFORCE_DATA_DIR = directory;
  try {
    const password = "local-test-password-123";
    const first = initializeLocalInstallation(directory, { password });
    const bytes = fs.readFileSync(first.accountFile, "utf8");
    const keys = fs.readFileSync(path.join(directory, "runtime-secrets.json"), "utf8");
    assert.equal(bytes.includes(password), false);
    assert.equal(verifyLocalPassword("admin@localhost", password), true);
    assert.equal(verifyLocalPassword("admin@localhost", "wrong-password"), false);
    assert.equal(verifyLocalPassword("other@localhost", password), false);
    assert.equal(initializeLocalInstallation(directory, { password: "another-password-123" }).created, false);
    assert.equal(fs.readFileSync(first.accountFile, "utf8"), bytes);
    assert.equal(fs.readFileSync(path.join(directory, "runtime-secrets.json"), "utf8"), keys);
    assert.equal(fs.existsSync(path.join(directory, "first-login.txt")), false);
  } finally {
    if (prior === undefined) delete process.env.DIGITAL_WORKFORCE_DATA_DIR;
    else process.env.DIGITAL_WORKFORCE_DATA_DIR = prior;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local authentication cannot bind to a network interface", () => {
  assert.doesNotThrow(() => assertLocalBinding("127.0.0.1"));
  assert.throws(() => assertLocalBinding("0.0.0.0"));
  assert.throws(() => assertLocalBinding("10.0.0.1"));
});

test("Group Studio local Center configuration cannot select enterprise or LAN servers", () => {
  assert.equal(localCenterUrl("http://127.0.0.1:14878"), "http://127.0.0.1:14878");
  assert.equal(localCenterUrl("https://center.example.com"), "");
  assert.equal(localCenterUrl("http://10.0.0.1:5173"), "");
  assert.equal(localCenterUrl("http://127.0.0.1:14878/path"), "");
});

test("distribution starts without business employees, Skills, workers, Tools or characters", () => {
  for (const collection of [digitalEmployees, basicSkills, businessSkills, preReviewWorkers, enterpriseTools, enterpriseToolBuiltinMigrations]) assert.deepEqual(collection, []);
  assert.deepEqual(DIGITAL_EMPLOYEE_CHARACTER_REGISTRY, {});
});

test("public distribution does not bind an upstream Skill or migrate unscoped integration secrets", async () => {
  const { ROOT_SKILL_ID, DEFAULT_CAPABILITIES } = await import("../server/channels/feishu/integration-contract.mjs");
  const { translateLegacyAlgorithmState } = await import("../server/channels/feishu/legacy-algorithm-state-compat.mjs");
  const { canonicalDigitalEmployeeId, digitalEmployeeReadIds } = await import("../src/data/digitalEmployeeIdentity.js");
  assert.equal(ROOT_SKILL_ID, "");
  assert.deepEqual(DEFAULT_CAPABILITIES, []);
  assert.equal(canonicalDigitalEmployeeId("example-user-employee"), "example-user-employee");
  assert.deepEqual(digitalEmployeeReadIds("example-user-employee"), ["example-user-employee"]);
  assert.throws(() => translateLegacyAlgorithmState({ secretVault: { fixture: "not-a-credential" } }), /unscoped_integration_state_not_supported/);
  assert.deepEqual(translateLegacyAlgorithmState({ connections: { "example-user-employee": { enabled: false } } }).connections, { "example-user-employee": { enabled: false } });
});
