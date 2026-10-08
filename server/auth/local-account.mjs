import fs from "node:fs";
import path from "node:path";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";

function readAccount() {
  const file = path.join(resolveDigitalWorkforceDataDir(), "local-account.json");
  const account = JSON.parse(fs.readFileSync(file, "utf8"));
  if (account.version !== 1 || account.email !== "admin@localhost"
    || !/^[a-f0-9]{32}$/.test(account.salt) || !/^[a-f0-9]{128}$/.test(account.passwordHash)) {
    throw new Error("local_account_invalid_run_local_install");
  }
  return account;
}

export function getLocalAccounts() {
  readAccount();
  return [{ email: "admin@localhost", name: "本地管理员", role: "admin", department: "本地工作区" }];
}

export function verifyLocalPassword(email, password) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const account = readAccount();
  const actual = scryptSync(password, account.salt, 64);
  return email === account.email && timingSafeEqual(actual, Buffer.from(account.passwordHash, "hex"));
}

export function assertLocalBinding(host) {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("local_center_requires_loopback_binding");
}
