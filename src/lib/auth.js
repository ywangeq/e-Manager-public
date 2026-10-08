import { readJson, removeItem, writeJson } from "./storage";
import { demoAccounts } from "../data/demoAccounts";

const ENTERPRISE_LOGIN_URL = import.meta.env.VITE_ENTERPRISE_LOGIN_URL || "";

export const DEMO_ACCOUNTS = demoAccounts;

export function currentSession() {
  return readJson("session", null);
}

export function enterpriseLoginUrl() {
  return ENTERPRISE_LOGIN_URL;
}

export async function fetchEnterpriseSession() {
  try {
    const response = await fetch("/api/me", { credentials: "include" });
    if (!response.ok) {
      removeItem("session");
      return null;
    }
    const data = await response.json();
    if (!data.ok || !data.session) return null;
    writeJson("session", data.session);
    return data.session;
  } catch {
    removeItem("session");
    return null;
  }
}

export async function login(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  try {
    const response = await fetch("/api/auth/demo/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: normalizedEmail, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.session) {
      return { ok: false, error: data.error || "账号或密码不正确" };
    }
    writeJson("session", data.session);
    return { ok: true, session: data.session };
  } catch {
    return { ok: false, error: "本地 Center 未启动，请先运行 pnpm start" };
  }
}

export async function logout() {
  try {
    await fetch("/api/auth/logout", { credentials: "include", method: "POST" });
  } catch {
    // Demo logout should still clear the local session if the backend is unavailable.
  }
  removeItem("session");
}
