import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  ChevronRight,
  Inbox,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import type { BoxMessage, Page, Preferences } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { time } from "../time.ts";
import { SidePanel } from "../components/SidePanel.tsx";
import { Empty } from "../components/Empty.tsx";
import { AgentTrace } from "./AgentTrace.tsx";
import { AgentModel } from "./AgentModel.tsx";
import { AgentPlugins } from "./AgentPlugins.tsx";
import { DeleteAgent } from "./DeleteAgent.tsx";
import { AgentCredentials } from "../settings/AgentCredentials.tsx";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export function AgentDrawer({
  agent,
  revision,
  close,
  refresh,
  initialTab = "trace",
  openAccounts,
}: {
  agent: Agent;
  revision: number;
  close: () => void;
  refresh: () => void;
  initialTab?: "trace" | "box" | "settings";
  openAccounts: (account: string | null) => void;
}) {
  const [tab, setTab] = useState<"trace" | "box" | "settings">(initialTab),
    [box, setBox] = useState<Page<BoxMessage> | null>(null);
  const [boxPages, setBoxPages] = useState([0]);
  const boxAfter = boxPages.at(-1)!;
  const [config, setConfig] = useState<Preferences>(agent.config);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const [name, setName] = useState(agent.name),
    [description, setDescription] = useState(agent.description);
  const [adapters, setAdapters] = useState<{
    dir: string;
    files: string[];
  } | null>(null);
  useEffect(() => {
    if (tab !== "box") return;
    let alive = true;
    void api<Page<BoxMessage>>(`/agents/${agent.id}/box?after=${boxAfter}`)
      .then((value) => {
        if (alive) setBox(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [agent.id, revision, boxAfter, tab]);
  useEffect(() => {
    setConfig(agent.config);
  }, [agent.config.heartbeat_seconds]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/config`, "PATCH", config);
      setSaved(true);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function profileSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/profile`, "PATCH", { name, description });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (tab !== "settings") return;
    let alive = true;
    api<{ dir: string; files: string[] }>(`/agents/${agent.id}/adapters`)
      .then((value) => {
        if (alive) setAdapters(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab, agent.id]);
  async function addGithubAdapter() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/adapters/github`, "POST", {});
      setAdapters(
        await api<{ dir: string; files: string[] }>(
          `/agents/${agent.id}/adapters`,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function promote() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/promote`, "POST", {});
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/start`, "POST");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/stop`, "POST");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SidePanel
      title={agent.name}
      close={close}
      badge={<span className="badge">{runtimeLabel(agent)}</span>}
    >
      <div className="flex items-center gap-[13px] border-b border-black/[0.04] bg-[#f9faf9] px-5 py-4">
        <Avatar name={agent.name} presence={agentPresence(agent)} />
        <div className="min-w-0">
          <strong className="text-xs font-semibold text-ink">
            {runtimeLabel(agent)}
          </strong>
          <p className="mt-[2px] text-xs text-muted [overflow-wrap:anywhere]">
            <span className="text-ink/60">工作声明 · </span>
            {agent.work || "尚未声明"}
          </p>
        </div>
      </div>
      <div
        className="flex gap-4 border-b border-black/[0.04] px-5"
        aria-label="Agent 信息"
      >
        <button
          className={`flex items-center gap-[7px] border-b-2 py-2.5 text-xs transition-colors ${
            tab === "trace"
              ? "border-accent font-medium text-accent-strong"
              : "border-transparent text-muted hover:text-ink"
          }`}
          onClick={() => setTab("trace")}
        >
          <Activity size={15} />
          运行轨迹
        </button>
        <button
          className={`flex items-center gap-[7px] border-b-2 py-2.5 text-xs transition-colors ${
            tab === "box"
              ? "border-accent font-medium text-accent-strong"
              : "border-transparent text-muted hover:text-ink"
          }`}
          onClick={() => setTab("box")}
        >
          <Inbox size={15} />
          通知{" "}
          {agent.unread > 0 && <span className="badge">{agent.unread}</span>}
        </button>
        <button
          className={`flex items-center gap-[7px] border-b-2 py-2.5 text-xs transition-colors ${
            tab === "settings"
              ? "border-accent font-medium text-accent-strong"
              : "border-transparent text-muted hover:text-ink"
          }`}
          onClick={() => setTab("settings")}
        >
          <Settings2 size={15} />
          运行设置
        </button>
      </div>
      {tab === "trace" ? (
        <AgentTrace agent={agent} revision={revision} />
      ) : (
        <div className="flex-1 overflow-auto px-[25px] pb-[30px] pt-5">
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {tab === "box" ? (
            <>
              <p className="muted small-text">
                审阅不会改变 Agent 的已读状态；已读不代表处理完成。
              </p>
              {!box ? (
                <p className="flex items-center gap-2 py-4 text-xs text-muted">
                  <LoaderCircle size={16} className="spin" />
                  加载收件箱…
                </p>
              ) : !box.items.length ? (
                <Empty icon={<Inbox size={26} />} title="通知箱暂时没有消息">
                  <p>群聊提醒和外部事件会送到这里；完整记录可追溯。</p>
                </Empty>
              ) : (
                <div>
                  {box.items.map((notice) => (
                    <article key={notice.id} className="notice">
                      <div className="notice-meta">
                        <span>
                          {notice.source === "chat"
                            ? "群聊提醒"
                            : notice.source === "system"
                              ? "系统通知"
                              : notice.source.startsWith("adapter:")
                                ? `适配器 · ${notice.source.slice(8)}`
                                : "外部原文"}
                        </span>
                        <time>{time(notice.created_at)}</time>
                        <span>{notice.done_at ? "已完成" : "未完成"}</span>
                      </div>
                      <h3>{notice.title}</h3>
                      <details>
                        <summary>查看消息内容</summary>
                        <NoticeBody body={notice.body} />
                      </details>
                      {notice.url && (
                        <a href={notice.url} target="_blank" rel="noreferrer">
                          查看来源 <ChevronRight size={13} />
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              )}
              {(boxPages.length > 1 || box?.has_more) && (
                <div className="mt-[25px] flex justify-end gap-[9px]">
                  <button
                    className="button secondary"
                    disabled={boxPages.length === 1}
                    onClick={() => setBoxPages((old) => old.slice(0, -1))}
                  >
                    上一页
                  </button>
                  <button
                    className="button secondary"
                    disabled={!box?.has_more}
                    onClick={() => {
                      if (box) setBoxPages((old) => [...old, box.next_after]);
                    }}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <AgentCredentials agentId={agent.id} open={openAccounts} />
              {agent.agent_directory && (
                <AgentPlugins
                  agentId={agent.id}
                  available={agent.available}
                  refresh={refresh}
                />
              )}
              <form className="settings-section" onSubmit={profileSave}>
                <h3>身份资料</h3>
                <label className="form-label">
                  名称
                  <input
                    className="field"
                    required
                    maxLength={40}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="form-label">
                  自我介绍
                  <textarea
                    className="field"
                    maxLength={1000}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <button className="button secondary" disabled={busy}>
                  保存资料
                </button>
              </form>
              <section className="settings-section">
                <h3>外部事件接收口</h3>
                <code className="path">
                  POST /api/agents/{agent.name}/inbox
                </code>
                <p className="muted small-text">
                  把外部事件 POST 到这里；adapters/
                  目录下的适配器把外部载荷整理成结构化通知。
                </p>
                {!adapters ? null : adapters.files.length === 0 ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void addGithubAdapter()}
                  >
                    写入 GitHub 适配器模板
                  </button>
                ) : (
                  <ul className="muted small-text">
                    {adapters.files.map((file) => (
                      <li key={file}>
                        <code>{file}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="settings-section">
                {agent.agent_directory ? (
                  <>
                    <h3>终端启动</h3>
                    <code className="path">atrium run {agent.name}</code>
                    <p className="muted small-text">
                      打开原生 Pi；该身份已在运行时不会另开实例。
                    </p>
                  </>
                ) : (
                  <>
                    <h3>旧身份记录</h3>
                    <p className="muted small-text">
                      聊天与历史保留。正常退出旧 Pi
                      后，可显式创建专属目录并启用单实例保护。
                    </p>
                    <button
                      className="button secondary"
                      disabled={busy || agent.available}
                      onClick={() => void promote()}
                    >
                      升级为长期身份
                    </button>
                  </>
                )}
              </section>
              <section className="settings-section">
                <h3>运行状态</h3>
                <p className="muted">在线时自动连接，离线消息会保留。</p>
                {agent.error && <p className="error">{agent.error}</p>}
                {agent.runtime && (
                  <div className="runtime-info">
                    <span>
                      {agent.runtime.mode.toUpperCase()} · PID{" "}
                      {agent.runtime.pid}
                    </span>
                    <span>{agent.runtime.model}</span>
                  </div>
                )}
                <p className="muted small-text">
                  心跳间隔 {agent.config.heartbeat_seconds} 秒；最近心跳{" "}
                  {agent.last_wake ? time(agent.last_wake) : "还没有"}
                </p>
                {!agent.available && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void start()}
                  >
                    {busy ? "启动中…" : "启动 Agent"}
                  </button>
                )}
                {agent.runtime && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void stop()}
                  >
                    {busy ? "停止中…" : "停止 Agent"}
                  </button>
                )}
              </section>
              {agent.agent_directory && <AgentModel agentId={agent.id} />}
              <form onSubmit={save} className="settings-section">
                <h3>运行偏好</h3>
                <p className="muted small-text">
                  离线时被私聊、@
                  或入群邀请叫醒；群里没点名它的消息和下面的消息箱提醒不开进程。
                </p>
                <label className="form-label">
                  心跳检查间隔（秒）
                  <input
                    className="field"
                    type="number"
                    min={5}
                    max={3600}
                    required
                    value={config.heartbeat_seconds}
                    onChange={(e) => {
                      setSaved(false);
                      setConfig({
                        ...config,
                        heartbeat_seconds: Number(e.target.value),
                      });
                    }}
                  />
                </label>
                <p className="muted small-text">
                  在跑的时候每隔这么久提醒一次消息箱里没处理完的消息，处理完就不再提醒。
                </p>
                <button className="button" disabled={busy}>
                  {saved ? "已保存" : busy ? "保存中…" : "保存设置"}
                </button>
              </form>
              <div className="settings-section">
                <h3>工作目录</h3>
                <code className="path">{agent.cwd}</code>
              </div>
              <DeleteAgent
                agent={agent}
                disabled={busy}
                removed={() => {
                  close();
                  refresh();
                }}
              />
            </>
          )}
        </div>
      )}
    </SidePanel>
  );
}

function NoticeBody({ body }: { body: string }) {
  try {
    return <pre>{JSON.stringify(JSON.parse(body), null, 2)}</pre>;
  } catch {
    return <pre>{body}</pre>;
  }
}
