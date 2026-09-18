import { useState } from "react";
import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";
import type { Agent } from "../components/AgentAvatar.tsx";
export function CreateAgentDialog({
  close,
  created,
}: {
  close: () => void;
  created: (agent: Agent, startError?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  async function submit(data: FormData) {
    const result = await api<{ agent: Agent; start_error?: string }>(
      "/agents",
      "POST",
      {
        name: data.get("name"),
        description: data.get("description"),
        ...(data.get("template") ? { template: data.get("template") } : {}),
        start: data.get("start") === "on",
      },
    );
    await created(result.agent, result.start_error);
  }
  return (
    <SubmitDialog
      title="新建 Agent"
      close={close}
      submit={submit}
      submitLabel="创建 Agent"
      pendingLabel="创建中…"
    >
      <p className="muted">身份长期保留；启动和退出不会改变它的名字与聊天。</p>
      <label>
        名称
        <input
          name="name"
          required
          maxLength={40}
          placeholder="例如 Atlas"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="muted small-text">
        专属工作目录自动创建为 ~/Atrium/{name.trim() || "〈名称〉"}
        /，每次启动固定使用，无需手动指定。
      </p>
      <label>
        <span>
          自我介绍 <span className="muted">（可选）</span>
        </span>
        <textarea
          name="description"
          maxLength={1000}
          placeholder="擅长什么，主要负责什么"
          rows={2}
        />
      </label>
      <details>
        <summary>配置与启动</summary>
        <label>
          配置模板目录
          <input name="template" placeholder="默认使用当前 Pi 配置" />
        </label>
        <label className="switch-row">
          <span>创建后在后台启动</span>
          <input name="start" type="checkbox" role="switch" />
        </label>
        <p className="muted small-text">
          设置与会话独立，扩展和技能复用已安装资源。不会复制登录凭据；内置 Pi
          认证需在该身份中登录，环境变量和插件自身认证沿用原机制。
        </p>
      </details>
      <p className="muted small-text">
        Pi
        使用该目录和你现有的权限运行，不是隔离沙箱。退出后默认不被事件自动拉起。
      </p>
    </SubmitDialog>
  );
}
