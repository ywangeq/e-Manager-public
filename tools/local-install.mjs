import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

export function initializeLocalInstallation(dataDir, { password } = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error("local_data_dir_must_be_absolute");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secretsFile = path.join(dataDir, "runtime-secrets.json");
  if (!fs.existsSync(secretsFile)) {
    fs.writeFileSync(secretsFile, JSON.stringify({
      version: 1,
      encryptionKey: randomBytes(32).toString("base64"),
      routeDigestKey: randomBytes(32).toString("base64"),
      sessionSecret: randomBytes(32).toString("hex"),
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  const file = path.join(dataDir, "local-account.json");
  if (fs.existsSync(file)) return { created: false, accountFile: file };
  if (password !== undefined && (typeof password !== "string" || password.length < 12 || password.length > 1024)) {
    throw new Error("local_password_must_have_12_to_1024_characters");
  }
  const generated = password === undefined;
  const secret = password ?? randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const account = { version: 1, email: "admin@localhost", salt, passwordHash: scryptSync(secret, salt, 64).toString("hex") };
  fs.writeFileSync(file, JSON.stringify(account, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (generated) fs.writeFileSync(path.join(dataDir, "first-login.txt"), `本地体验账号：admin@localhost\n密码：${secret}\n首次读取后可删除此文件；账号校验使用独立的密码哈希。\n`, { mode: 0o600, flag: "wx" });
  return { created: true, accountFile: file, ...(generated ? { passwordFile: path.join(dataDir, "first-login.txt") } : {}) };
}
