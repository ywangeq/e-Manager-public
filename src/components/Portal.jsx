import { ArrowRight, Building2, KeyRound, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import FaultyTerminal from "./FaultyTerminal";

export default function Portal({ enterpriseLoginUrl, onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    const result = await onLogin(email, password);
    setIsSubmitting(false);
    if (!result.ok) setError(result.error);
  }

  function startEnterpriseLogin() {
    if (!enterpriseLoginUrl) return;
    window.location.assign(enterpriseLoginUrl);
  }

  return (
    <main className="portal">
      <FaultyTerminal
        className="portal-pillar portal-terminal"
        scale={2.08}
        gridMul={[2.35, 1.38]}
        digitSize={1.16}
        timeScale={0.14}
        scanlineIntensity={0.18}
        glitchAmount={0.22}
        flickerAmount={0.2}
        noiseAmp={1.12}
        chromaticAberration={0}
        dither={0.24}
        curvature={0.02}
        tint="#8bdcff"
        mouseReact
        mouseStrength={0.08}
        pageLoadAnimation
        brightness={1.02}
      />
      <section className="portal-copy">
        <div className="brand-lockup">
          <span className="brand-mark">
            <Sparkles size={20} />
          </span>
          <span>Digital Workforce OS</span>
        </div>
        <p className="eyebrow">Company Portal</p>
        <h1>数字员工管理系统</h1>
        <p className="portal-subtitle">
          面向公司层级统一治理数字员工、基础技能、专项业务技能和人员权限，让每个 AI 能力都有归属、版本、边界和复核入口。
        </p>
        <div className="portal-proof">
          <span>
            <Building2 size={18} /> 组织级目录
          </span>
          <span>
            <ShieldCheck size={18} /> 人审门禁
          </span>
          <span>
            <LockKeyhole size={18} /> 本地登录
          </span>
        </div>
      </section>

      <section className="login-panel" aria-label="登录表单">
        <div>
          <p className="eyebrow">Sign In</p>
          <h2>进入管理台</h2>
          <p>本地单用户版本。账号为 admin@localhost，首次登录密码见安装时生成的 first-login.txt。</p>
        </div>
        <button
          className="enterprise-action"
          disabled={!enterpriseLoginUrl}
          onClick={startEnterpriseLogin}
          type="button"
        >
          <KeyRound size={18} />
          企业登录
          <span>{enterpriseLoginUrl ? "跳转认证" : "本地版本未启用"}</span>
        </button>
        <div className="login-divider">
          <span>本地账号登录</span>
        </div>
        <form onSubmit={submit}>
          <label>
            账号
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
          </label>
          <label>
            密码
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button className="primary-action" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "登录中" : "登录管理台"} <ArrowRight size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}
