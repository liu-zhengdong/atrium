import { useState } from "react";
import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
export function CreateAgentDialog({
  close,
  created,
  desktopsRoot,
  agents,
}: {
  close: () => void;
  created: (agent: Agent, startError?: string) => Promise<void>;
  desktopsRoot?: string;
  agents: Agent[];
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("builtin");
  const sources = agents.filter((agent) => agent.agent_directory);
  const matches = query.trim().toLowerCase();
  const visible = sources.filter((agent) =>
    `${agent.ref} ${agent.name} ${agent.description}`
      .toLowerCase()
      .includes(matches),
  );
  const builtinShown =
    !matches || "内置 builtin 默认配置类型".includes(matches);
  const available = [
    ...(builtinShown ? ["builtin"] : []),
    ...visible.map((agent) => agent.ref),
  ];
  const selected = available.includes(source)
    ? source
    : (available[0] ?? "builtin");
  async function submit(data: FormData) {
    const result = await api<{ agent: Agent; start_error?: string }>(
      "/agents",
      "POST",
      {
        name: data.get("name"),
        description: data.get("description"),
        source: selected,
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
      <label className="form-label">
        名称
        <input
          className="field"
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
        专属工作目录自动创建为 {desktopsRoot ?? "…"}/{name.trim() || "〈名称〉"}
        /，每次启动固定使用，无需手动指定。
      </p>
      <label className="form-label">
        <span>
          自我介绍 <span className="muted">（可选）</span>
        </span>
        <textarea
          className="field"
          name="description"
          maxLength={1000}
          placeholder="擅长什么，主要负责什么"
          rows={2}
        />
      </label>
      <fieldset className="member-picker">
        <legend className="member-picker-legend">从哪里复制配置</legend>
        {sources.length > 8 && (
          <input
            className="field mb-2"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选来源"
            aria-label="筛选来源"
          />
        )}
        {builtinShown && (
          <label className="check-row">
            <input
              type="radio"
              name="source"
              value="builtin"
              checked={selected === "builtin"}
              onChange={() => setSource("builtin")}
            />
            内置
            <span className="muted">预置类型</span>
          </label>
        )}
        {visible.map((agent) => (
          <label className="check-row" key={agent.id}>
            <input
              type="radio"
              name="source"
              value={agent.ref}
              checked={selected === agent.ref}
              onChange={() => setSource(agent.ref)}
            />
            <Avatar small name={agent.name} />
            {agent.name}
            <span className="muted">{agent.ref}</span>
          </label>
        ))}
        {!builtinShown && !visible.length && (
          <p className="muted">没有匹配的来源</p>
        )}
      </fieldset>
      <details>
        <summary>启动</summary>
        <label className="switch-row">
          <span>创建后在后台启动</span>
          <input name="start" type="checkbox" role="switch" />
        </label>
        <p className="muted small-text">
          设置、规则和笔记归这个身份自己所有；扩展和技能复用已安装资源。不会复制登录凭据；内置
          Pi 认证需在该身份中登录，环境变量和插件自身认证沿用原机制。
        </p>
      </details>
      <p className="muted small-text">
        Pi
        使用该目录和你现有的权限运行，不是隔离沙箱。退出后默认不被事件自动拉起。
      </p>
    </SubmitDialog>
  );
}
