import { useEffect, useState, type RefObject } from "react";
import { api } from "../api.ts";
import type { Preferences } from "../../shared/schema.ts";
import {
  Avatar,
  agentPresence,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { AgentModel } from "../agents/AgentModel.tsx";
import { AgentPlugins } from "../agents/AgentPlugins.tsx";
import {
  AgentSkills,
  AgentMcp,
  AgentRules,
} from "../agents/AgentResources.tsx";
import { AgentCredentials } from "./AgentCredentials.tsx";
import { DeleteAgent } from "../agents/DeleteAgent.tsx";
import { ReportsToPicker } from "../agents/ReportsToPicker.tsx";
import { trackUnsaved } from "./unsaved.ts";

const sections = [
  { id: "model", title: "模型与账号" },
  { id: "plugins", title: "插件" },
  { id: "skills", title: "技能" },
  { id: "mcp", title: "MCP" },
  { id: "rules", title: "规则文件" },
  { id: "profile", title: "身份资料" },
  { id: "report", title: "向谁汇报" },
  { id: "heartbeat", title: "心跳" },
  { id: "access", title: "接入" },
  { id: "delete", title: "删除" },
] as const;

export function AgentConfigPage({
  agent,
  agents,
  changed,
  openAccounts,
  openChat,
  removed,
  scrollRoot,
}: {
  agent: Agent;
  agents: Agent[];
  changed: () => void;
  openAccounts: (account: string | null) => void;
  openChat: () => void;
  removed: () => void;
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const [config, setConfig] = useState<Preferences>(agent.config);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [savedProfile, setSavedProfile] = useState({
    name: agent.name,
    description: agent.description,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState<string>("model");
  const [adapters, setAdapters] = useState<{ files: string[] } | null>(null);
  const dirty =
    name !== savedProfile.name || description !== savedProfile.description;
  useEffect(() => {
    setConfig(agent.config);
  }, [agent.config]);
  useEffect(() => {
    let active = true;
    void api<{ files: string[] }>(`/agents/${agent.id}/adapters`)
      .then((value) => {
        if (active) setAdapters(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [agent.id]);
  useEffect(() => trackUnsaved(dirty), [dirty]);
  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const update = () => {
      const top =
        root.getBoundingClientRect().top +
        Math.min(160, root.clientHeight * 0.22);
      let current: string = sections[0].id;
      for (const section of sections) {
        const element = root.querySelector<HTMLElement>(`#${section.id}`);
        if (element && element.getBoundingClientRect().top <= top)
          current = section.id;
      }
      setActiveSection(current);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [scrollRoot]);
  async function heartbeat(value: number) {
    const previous = agent.config;
    setConfig({ ...config, heartbeat_seconds: value });
    setError("");
    try {
      await api(`/agents/${agent.id}/config`, "PATCH", {
        ...config,
        heartbeat_seconds: value,
      });
      changed();
    } catch (e) {
      setConfig(previous);
      setError(String(e));
    }
  }
  async function saveProfile() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/profile`, "PATCH", { name, description });
      setSavedProfile({ name, description });
      changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function addAdapter() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/adapters/github`, "POST", {});
      setAdapters(await api(`/agents/${agent.id}/adapters`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-[1060px] [&_.button.secondary]:!border-transparent [&_.button.secondary]:!bg-soft [&_.button.secondary]:hover:!bg-[#e9efeb]">
      <div className="mb-7 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={agent.name} presence={agentPresence(agent)} />
          <h1 className="truncate text-xl font-medium">{agent.name}</h1>
        </div>
        <button className="button secondary shrink-0" onClick={openChat}>
          进入对话
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {agent.runner?.revoked && (
        <p role="status" className="mb-6 rounded-lg bg-soft px-3 py-2 text-xs">
          运行器 {agent.runner.id} 已撤销。确认旧 Pi 已停止后，运行{" "}
          <code className="break-all">
            atrium runner reclaim {agent.ref} --confirm-stopped
          </code>
          ，再重新绑定或启动。
        </p>
      )}
      <div className="flex items-start gap-10">
        <div className="min-w-0 flex-1 space-y-10 [&_.settings-section]:!m-0 [&_.settings-section]:!border-0 [&_.settings-section]:!p-0">
          <section id="model" className="space-y-5">
            <h2 className="text-sm font-semibold">模型与账号</h2>
            <AgentModel agentId={agent.id} />
            <AgentCredentials
              agent={agent}
              openAccounts={() => openAccounts(null)}
              onChange={changed}
            />
            {!agent.available && !agent.unassigned && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void api(`/agents/${agent.id}/start`, "POST")
                    .then(changed)
                    .catch((e) => setError(String(e)))
                }
              >
                启动
              </button>
            )}
          </section>
          <section id="plugins">
            {agent.agent_directory && (
              <AgentPlugins
                agentId={agent.id}
                available={agent.available}
                refresh={changed}
              />
            )}
          </section>
          <section id="skills">
            {agent.agent_directory && <AgentSkills agentId={agent.id} />}
          </section>
          <section id="mcp">
            {agent.agent_directory && <AgentMcp agentId={agent.id} />}
          </section>
          <section id="rules">
            {agent.agent_directory && <AgentRules agentId={agent.id} />}
          </section>
          <section id="profile" className="space-y-3">
            <h2 className="text-sm font-semibold">身份资料</h2>
            <label className="form-label">
              名称
              <input
                className="field"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="form-label">
              自我介绍
              <textarea
                className="field resize-none"
                maxLength={1000}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={busy || !dirty || !name.trim()}
              onClick={() => void saveProfile()}
            >
              保存资料
            </button>
          </section>
          <section id="report" className="space-y-3">
            <h2 className="text-sm font-semibold">向谁汇报</h2>
            <ReportsToPicker agent={agent} agents={agents} changed={changed} />
          </section>
          <section id="heartbeat" className="space-y-3">
            <h2 className="text-sm font-semibold">心跳</h2>
            <label className="form-label">
              检查间隔（秒）
              <input
                className="field max-w-48"
                type="number"
                min={5}
                max={3600}
                value={config.heartbeat_seconds}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    heartbeat_seconds: Number(e.target.value),
                  })
                }
                onBlur={() => {
                  if (
                    config.heartbeat_seconds < 5 ||
                    config.heartbeat_seconds > 3600
                  ) {
                    setConfig(agent.config);
                    setError("检查间隔须为 5–3600 秒");
                  } else if (
                    config.heartbeat_seconds !== agent.config.heartbeat_seconds
                  ) {
                    void heartbeat(config.heartbeat_seconds);
                  }
                }}
              />
            </label>
          </section>
          <section id="access" className="space-y-4">
            <h2 className="text-sm font-semibold">接入</h2>
            <p className="text-xs text-muted">
              最近心跳{" "}
              {agent.last_wake
                ? new Date(agent.last_wake).toLocaleString("zh-CN")
                : "还没有"}
            </p>
            {agent.runtime && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api(`/agents/${agent.id}/stop`, "POST")
                    .then(changed)
                    .catch((e) => setError(String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                停止 Agent
              </button>
            )}
            <p className="text-xs text-muted">外部事件接收口</p>
            <p className="text-xs text-muted">
              在本机终端获取仅可投递给此身份的秘密地址；更换时加
              --rotate，关闭时加 --revoke。
            </p>
            <code className="path">atrium adapters url {agent.name}</code>
            {adapters &&
              (adapters.files.length ? (
                <p className="text-xs text-muted">
                  {adapters.files.join("、")}
                </p>
              ) : (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void addAdapter()}
                >
                  写入 GitHub 适配器模板
                </button>
              ))}
            <p className="text-xs text-muted">终端启动</p>
            <code className="path">atrium run {agent.name}</code>
          </section>
          <section id="delete">
            <DeleteAgent
              agent={agent}
              disabled={busy}
              stop={async () => {
                await api(`/agents/${agent.id}/stop`, "POST");
                changed();
              }}
              removed={removed}
            />
          </section>
        </div>
        <nav
          aria-label="配置目录"
          className="sticky top-0 hidden w-32 shrink-0 space-y-2 text-xs text-muted lg:grid"
        >
          {sections.map(({ id, title }) => (
            <a
              key={id}
              aria-current={activeSection === id ? "location" : undefined}
              className={`rounded-md px-2 py-1 hover:bg-soft hover:text-ink ${activeSection === id ? "bg-[#e2ebe4] text-accent-strong" : ""}`}
              href={`#${id}`}
              onClick={(e) => {
                e.preventDefault();
                setActiveSection(id);
                scrollRoot.current
                  ?.querySelector<HTMLElement>(`#${id}`)
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {title}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
