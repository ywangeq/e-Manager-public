import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchManagedSandboxProfiles } from "../../lib/controlPlane";

export default function ManagedSandboxProfilePanel() {
  const [state, setState] = useState({ profiles: [], status: "loading" });

  useEffect(() => {
    fetchManagedSandboxProfiles()
      .then((data) => setState({ profiles: data.profiles || [], status: "ready" }))
      .catch(() => setState({ profiles: [], status: "error" }));
  }, []);

  return (
    <section className="managed-sandbox-profile-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">受管执行环境</p>
          <h2>Sandbox 环境</h2>
          <small>为数字员工提供统一的通用命令与脚本运行边界。</small>
        </div>
        <span className="status-pill muted">{state.profiles.length} 个 Profile</span>
      </div>
      <div className="managed-sandbox-profile-list" aria-label="Sandbox Profile">
        {state.profiles.map((profile) => (
          <article className="managed-sandbox-profile-row" key={profile.profileId}>
            <span className="managed-sandbox-profile-icon" aria-hidden="true"><ShieldCheck size={17} /></span>
            <span className="managed-sandbox-profile-copy">
              <strong>{profile.displayName}</strong>
              <small>{toolchainLabel(profile.toolchain)} · 当前任务文件 · 默认禁网 · 不注入凭据</small>
            </span>
            <span className="status-pill muted">待接入 Runner</span>
          </article>
        ))}
      </div>
      <section className="managed-sandbox-profile-section" aria-label="运行边界">
        <div className="managed-sandbox-section-head">
          <strong>运行边界</strong>
          <small>命令不是逐条配置；工具链、隔离、网络和凭据由 Profile 统一约束。</small>
        </div>
        <div className="managed-sandbox-profile-facts">
          <span>任务 Workspace</span>
          <span>受限资源与进程树</span>
          <span>默认无网络</span>
          <span>默认无凭据</span>
          <span>无外部业务写回</span>
        </div>
      </section>
      <p className="model-binding-note">
        {state.status === "error"
          ? "暂时无法读取 Sandbox 环境状态。"
          : "所有数字员工默认具备该环境的候选资格；真实执行仍需任务授权、已证明的 Provider 和 Runner。"}
      </p>
    </section>
  );
}

function toolchainLabel(toolchain = []) {
  const labels = { curl: "curl", git: "Git", node: "Node", python: "Python", shell: "Shell" };
  return toolchain.map((tool) => labels[tool] || tool).join(" · ");
}
