import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  Copy,
  GitPullRequest,
  Hash,
  Inbox,
  LoaderCircle,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import type {
  Overview,
  Message,
  BoxMessage,
  Subscription,
  Preferences,
  Page,
  LiveRuntime,
} from "../shared/schema.ts";
import { resolveMentions } from "../shared/mentions.ts";
import "./style.css";

type Agent = Overview["agents"][number];
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? `请求失败（${response.status}）`);
  return value;
}
const time = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
const runtimeLabel = (a: Agent) =>
  a.runtime ? (a.runtime.busy ? "执行中" : "在线") : "未连接";
function Mark() {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path
        d="M5 23V10a9 9 0 0 1 18 0v13M10 23V11a4 4 0 0 1 8 0v12M3 23h22"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Avatar({
  name,
  online,
  small = false,
}: {
  name: string;
  online?: boolean;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${small ? "small" : ""}`}>
      {name.slice(0, 1)}
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
  drawer = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "drawer" : ""}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button
        className="icon-button"
        aria-label="复制命令"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setFailed(false);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setFailed(true),
          );
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {failed && <span>请手动复制</span>}
    </div>
  );
}
function AgentDrawer({
  agent,
  revision,
  close,
  refresh,
  initialTab = "box",
}: {
  agent: Agent;
  revision: number;
  close: () => void;
  refresh: () => void;
  initialTab?: "box" | "settings";
}) {
  const [tab, setTab] = useState<"box" | "settings">(initialTab),
    [box, setBox] = useState<Page<BoxMessage> | null>(null);
  const [boxPages, setBoxPages] = useState([0]);
  const boxAfter = boxPages.at(-1)!;
  const [config, setConfig] = useState<Preferences>(agent.config);
  const [showRuntimes, setShowRuntimes] = useState(false);
  const [liveRuntimes, setLiveRuntimes] = useState<LiveRuntime[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
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
  }, [agent.id, revision, boxAfter]);
  useEffect(() => {
    setConfig(agent.config);
  }, [
    agent.config.auto_start,
    agent.config.message_threshold,
    agent.config.wake_interval_seconds,
  ]);
  async function scan() {
    setShowRuntimes(true);
    setScanning(true);
    setError("");
    try {
      setLiveRuntimes(
        (await api<{ runtimes: LiveRuntime[] }>("/runtimes")).runtimes,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }
  async function attach(runtimeId: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/attach`, "POST", {
        runtime_id: runtimeId,
      });
      setShowRuntimes(false);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
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
  return (
    <Modal title={agent.name} close={close} drawer>
      <div className="agent-summary">
        <Avatar name={agent.name} online={!!agent.runtime} />
        <div>
          <strong>{runtimeLabel(agent)}</strong>
          <p>{agent.work || "尚未声明工作内容"}</p>
        </div>
      </div>
      <div className="tabs">
        <button
          className={tab === "box" ? "active" : ""}
          onClick={() => setTab("box")}
        >
          <Inbox size={16} />
          收件箱{" "}
          {agent.unread > 0 && <span className="badge">{agent.unread}</span>}
        </button>
        <button
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          <Settings2 size={16} />
          运行设置
        </button>
      </div>
      <div className="drawer-content">
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
              <p className="loading">
                <LoaderCircle size={16} />
                加载收件箱…
              </p>
            ) : !box.items.length ? (
              <Empty icon={<Inbox size={26} />} title="收件箱暂时没有消息">
                <p>群聊提醒和订阅事件会送到这里。</p>
              </Empty>
            ) : (
              <div className="notice-list">
                {box.items.map((notice) => (
                  <article key={notice.id} className="notice">
                    <div className="notice-meta">
                      <span>
                        {notice.source === "github"
                          ? "GitHub"
                          : notice.source === "chat"
                            ? "群聊提醒"
                            : "系统通知"}
                      </span>
                      <time>{time(notice.created_at)}</time>
                      <span className={notice.read_at ? "" : "unread-label"}>
                        {notice.read_at ? "Agent 已读" : "未读"}
                      </span>
                    </div>
                    <h3>{notice.title}</h3>
                    {notice.source === "system" ? (
                      <p className="notice-body">{notice.body}</p>
                    ) : (
                      <details>
                        <summary>查看事件内容</summary>
                        <pre>
                          {JSON.stringify(JSON.parse(notice.body), null, 2)}
                        </pre>
                      </details>
                    )}
                    {notice.url && (
                      <a href={notice.url} target="_blank" rel="noreferrer">
                        查看 Pull Request <ChevronRight size={13} />
                      </a>
                    )}
                  </article>
                ))}
              </div>
            )}
            {(boxPages.length > 1 || box?.has_more) && (
              <div className="form-actions">
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
            <section className="settings-section">
              <h3>Pi 连接</h3>
              <p className="muted">将已有 Pi 接入这里，或启动一个后台 Pi。</p>
              {agent.error && <p className="error">{agent.error}</p>}
              {agent.runtime && (
                <div className="runtime-info">
                  <span>
                    {agent.runtime.mode.toUpperCase()} · PID {agent.runtime.pid}
                  </span>
                  <span>{agent.runtime.model}</span>
                </div>
              )}
              {!agent.runtime && (
                <>
                  <div className="runtime-actions">
                    <button
                      className="button"
                      disabled={busy || scanning}
                      onClick={() => void scan()}
                    >
                      接入已有 Pi
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void start()}
                    >
                      启动后台 Pi
                    </button>
                    {busy && (
                      <span className="loading small-text">
                        <LoaderCircle size={14} />
                        接入中…
                      </span>
                    )}
                  </div>
                  {showRuntimes && (
                    <div className="runtime-picker">
                      <div className="runtime-picker-title">
                        <strong>本机运行中的 Pi</strong>
                        <button
                          className="icon-button"
                          aria-label="刷新 Pi 列表"
                          disabled={busy || scanning}
                          onClick={() => void scan()}
                        >
                          <RefreshCw size={15} />
                        </button>
                      </div>
                      {scanning ? (
                        <p className="loading">
                          <LoaderCircle size={16} />
                          查找可接入的 Pi…
                        </p>
                      ) : (
                        liveRuntimes &&
                        (liveRuntimes.length ? (
                          <>
                            <p className="small-text muted">
                              请选择与此 Agent 工作目录一致的 Pi。
                            </p>
                            {liveRuntimes.map((runtime) => (
                              <div
                                className="runtime-choice"
                                key={runtime.runtimeId}
                              >
                                <div>
                                  <strong>Pi · PID {runtime.pid}</strong>
                                  <span title={runtime.cwd}>{runtime.cwd}</span>
                                </div>
                                <button
                                  className="button secondary"
                                  disabled={
                                    busy ||
                                    (!!runtime.bound_agent &&
                                      runtime.bound_agent !== agent.id)
                                  }
                                  onClick={() => void attach(runtime.runtimeId)}
                                >
                                  {runtime.bound_agent &&
                                  runtime.bound_agent !== agent.id
                                    ? "已绑定"
                                    : "接入"}
                                </button>
                              </div>
                            ))}
                          </>
                        ) : (
                          <p className="muted">
                            尚未发现可接入的 Pi。请确认已启用 pi-acp 通用扩展。
                          </p>
                        ))
                      )}
                    </div>
                  )}
                  <p className="small-text muted connection-help">
                    首次需准备 pi-acp 与固定模式 MCP 代理。
                    <a
                      href="https://github.com/liu-zhengdong/atrium#pi-接入"
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看准备步骤
                    </a>
                    。接入保留原进程与原会话。
                  </p>
                </>
              )}
            </section>
            <form onSubmit={save} className="settings-section">
              <h3>运行偏好</h3>
              <label className="switch-row">
                <span>
                  <strong>允许事件自动启动</strong>
                  <small>Pi 已退出时可被事件拉起；Agent 也能自行调整。</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={config.auto_start}
                  onChange={(e) => {
                    setSaved(false);
                    setConfig({ ...config, auto_start: e.target.checked });
                  }}
                />
              </label>
              <label>
                定时检查间隔（秒）
                <input
                  type="number"
                  min={30}
                  max={86400}
                  required
                  value={config.wake_interval_seconds}
                  onChange={(e) => {
                    setSaved(false);
                    setConfig({
                      ...config,
                      wake_interval_seconds: Number(e.target.value),
                    });
                  }}
                />
              </label>
              <label>
                累计消息阈值
                <input
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={config.message_threshold}
                  onChange={(e) => {
                    setSaved(false);
                    setConfig({
                      ...config,
                      message_threshold: Number(e.target.value),
                    });
                  }}
                />
              </label>
              <p className="muted small-text">
                普通通知合并限频；私聊和明确 @ 不等待这个阈值。
              </p>
              <button className="button" disabled={busy}>
                {saved ? "已保存" : busy ? "保存中…" : "保存设置"}
              </button>
            </form>
            <div className="settings-section">
              <h3>工作目录</h3>
              <code className="path">{agent.cwd}</code>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
function Integrations({
  overview,
  revision,
  refresh,
}: {
  overview: Overview;
  revision: number;
  refresh: () => void;
}) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]),
    [agentId, setAgentId] = useState(overview.agents[0]?.id ?? "");
  const [repository, setRepository] = useState(""),
    [event, setEvent] = useState("pull_request.opened"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Subscription[]>("/subscriptions")
      .then(setSubscriptions)
      .catch((e) => setError(e.message));
  }, [revision]);
  const events = {
    "pull_request.opened": "新建 PR",
    "pull_request.reopened": "重新打开 PR",
    "pull_request.synchronize": "更新 PR 提交",
    "pull_request.closed": "关闭或合入 PR",
  };
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agentId}/subscriptions`, "POST", {
        repository,
        event,
      });
      setRepository("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="main-header">
        <div>
          <h1>事件订阅</h1>
          <p>把外部世界的消息，送到合适的 Agent。</p>
        </div>
      </header>
      <div className="integration-content">
        <div className="integration-title">
          <GitPullRequest size={24} />
          <h2>GitHub</h2>
          <span
            className={`status-pill ${overview.github_enabled ? "ready" : ""}`}
          >
            {overview.github_enabled ? "已配置验签" : "尚未配置"}
          </span>
        </div>
        <details className="setup-help" open={!overview.github_enabled}>
          <summary>Webhook 接入说明</summary>
          <p>
            使用环境变量 <code>ATRIUM_GITHUB_SECRET</code>{" "}
            配置验签密钥，重启后端；GitHub Webhook 使用相同 Secret 和 JSON
            格式。
          </p>
          <CopyLine text={`${location.origin}/webhooks/github`} />
          <p>
            GitHub 需要可达的 HTTPS 回调。当前是本机地址，接入时只对外转发这个
            Webhook 路径，不公开管理接口。
          </p>
        </details>
        <h3 className="section-title">订阅规则</h3>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {subscriptions.length ? (
          <div className="subscription-list">
            {subscriptions.map((s) => (
              <div className="subscription" key={s.id}>
                <div>
                  <strong>{s.repository}</strong>
                  <p>
                    {events[s.event as keyof typeof events] ?? s.event}{" "}
                    <span>→</span>{" "}
                    {overview.agents.find((a) => a.id === s.agent_id)?.name}
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label={`删除 ${s.repository} 的订阅`}
                  onClick={() => {
                    void api(
                      `/agents/${s.agent_id}/subscriptions/${s.id}`,
                      "DELETE",
                    )
                      .then(refresh)
                      .catch((e) => setError(e.message));
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            还没有订阅。添加后，匹配的 PR 事件会进入 Agent 收件箱。
          </p>
        )}
        <form className="subscribe-form" onSubmit={add}>
          <label>
            接收 Agent
            <select
              required
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="" disabled>
                选择 Agent
              </option>
              {overview.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            仓库
            <input
              required
              placeholder="owner/repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
          </label>
          <label>
            事件
            <select value={event} onChange={(e) => setEvent(e.target.value)}>
              {Object.entries(events).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="button" disabled={!agentId || busy}>
            {busy ? "添加中…" : "添加订阅"}
          </button>
        </form>
      </div>
    </>
  );
}
function App() {
  const [overview, setOverview] = useState<Overview | null>(null),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false);
  const [section, setSection] = useState<"chat" | "events">("chat"),
    [chatId, setChatId] = useState<string | null>(null),
    [agentId, setAgentId] = useState<string | null>(null);
  const [modal, setModal] = useState<"agent" | "chat" | "members" | null>(null),
    [creating, setCreating] = useState(false),
    [modalError, setModalError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]),
    [members, setMembers] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [older, setOlder] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [sending, setSending] = useState(false),
    [mentionIndex, setMentionIndex] = useState(0),
    [mentionHidden, setMentionHidden] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false),
    [setupAgent, setSetupAgent] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  const submission = useRef<{ key: string; id: string } | null>(null);
  const loadedChat = useRef<string | null>(null),
    currentChat = useRef(chatId);
  currentChat.current = chatId;
  const active = overview?.chats.find((c) => c.id === chatId),
    selectedAgent = overview?.agents.find((a) => a.id === agentId);
  const draft = chatId ? (drafts[chatId] ?? "") : "";
  const query = draft.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const candidates =
    !mentionHidden && query !== undefined
      ? (overview?.agents
          .filter(
            (a) =>
              members.includes(a.id) &&
              a.name.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 6) ?? [])
      : [];
  const mentionIds = resolveMentions(
    draft,
    (overview?.agents ?? []).filter((a) => members.includes(a.id)),
  );
  const refresh = () => setRevision((r) => r + 1);
  useEffect(() => {
    let cancelled = false;
    void api<Overview>("/overview")
      .then((data) => {
        if (!cancelled) {
          setOverview(data);
          setChatId((current) => current ?? data.chats[0]?.id ?? null);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  useEffect(() => {
    const source = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      setConnected(true);
      refresh();
    };
    source.onerror = () => setConnected(false);
    source.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 80);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, []);
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    const first = loadedChat.current !== chatId;
    if (first) {
      setLoading(true);
      setMembers([]);
      nearBottom.current = true;
    }
    void Promise.all([
      api<{ items: Message[]; has_more: boolean }>(`/chats/${chatId}/messages`),
      api<{ members: string[] }>(`/chats/${chatId}`),
    ])
      .then(([page, info]) => {
        if (cancelled) return;
        setMembers(info.members);
        if (first) {
          setMessages(page.items);
          setOlder(page.has_more);
        } else
          setMessages((old) =>
            [
              ...new Map(
                [...old.filter((m) => m.chat_id === chatId), ...page.items].map(
                  (m) => [m.id, m],
                ),
              ).values(),
            ].sort((a, b) => a.id - b.id),
          );
        loadedChat.current = chatId;
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [revision, chatId]);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, loading]);
  function selectChat(id: string) {
    setChatId(id);
    setSection("chat");
    setMobileOpen(false);
    setMentionHidden(false);
  }
  function chooseMention(a: Agent) {
    if (!chatId) return;
    setDrafts((old) => ({
      ...old,
      [chatId]: draft.replace(/@[^@\n]*$/, `@${a.name} `),
    }));
    setMentionHidden(true);
    setMentionIndex(0);
    textarea.current?.focus();
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!chatId || !draft.trim() || sending) return;
    const target = chatId,
      body = draft;
    setSending(true);
    setError("");
    const key = JSON.stringify([target, body, mentionIds]);
    if (submission.current?.key !== key)
      submission.current = { key, id: crypto.randomUUID() };
    try {
      await api("/messages", "POST", {
        chat_id: target,
        body,
        mentions: mentionIds,
        client_id: submission.current.id,
      });
      submission.current = null;
      setDrafts((old) => ({
        ...old,
        [target]: old[target] === body ? "" : old[target],
      }));
      nearBottom.current = true;
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setCreating(true);
    setModalError("");
    try {
      if (modal === "agent") {
        const result = await api<{ agent: Agent }>("/agents", "POST", {
          name: data.get("name"),
          cwd: data.get("cwd"),
        });
        setSetupAgent(result.agent.id);
        setAgentId(result.agent.id);
      } else if (modal === "members") {
        await api(`/chats/${chatId}/members`, "POST", {
          agent_id: data.get("member"),
        });
      } else {
        const direct = data.get("direct")?.toString();
        const members = data.getAll("members");
        const result = await api<{ id: string }>(
          "/chats",
          "POST",
          direct
            ? {
                name: overview?.agents.find((a) => a.id === direct)?.name,
                members: [direct],
                direct_agent: direct,
              }
            : { name: data.get("name"), members },
        );
        selectChat(result.id);
      }
      setModal(null);
      refresh();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setCreating(false);
    }
  }
  return (
    <div className={`app ${mobileOpen ? "mobile-list" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span>Atrium</span>
          <span className="brand-caption">中庭</span>
        </div>
        <nav aria-label="主导航">
          <button
            className={section === "chat" ? "selected" : ""}
            onClick={() => {
              setSection("chat");
              setMobileOpen(false);
            }}
          >
            <MessageSquare size={17} />
            聊天
          </button>
          <button
            className={section === "events" ? "selected" : ""}
            onClick={() => {
              setSection("events");
              setMobileOpen(false);
            }}
          >
            <Radio size={17} />
            事件订阅
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="section-label">
            会话
            <button
              className="icon-button"
              aria-label="新建会话"
              onClick={() => {
                setModal("chat");
                setModalError("");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="chat-list">
            {overview?.chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-row ${chat.id === chatId && section === "chat" ? "selected" : ""}`}
                onClick={() => selectChat(chat.id)}
              >
                <span className="chat-symbol">
                  {chat.kind === "group" ? (
                    <Hash size={18} />
                  ) : (
                    <MessageSquare size={17} />
                  )}
                </span>
                <span>
                  <strong>{chat.name}</strong>
                  <small>{chat.preview ?? "开始这段对话"}</small>
                </span>
              </button>
            ))}
            {overview && !overview.chats.length && (
              <p className="sidebar-hint">还没有会话</p>
            )}
          </div>
        </div>
        <div className="sidebar-section agents-section">
          <div className="section-label">
            Agents
            <button
              className="icon-button"
              aria-label="添加 Agent"
              onClick={() => {
                setModal("agent");
                setModalError("");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {overview?.agents.map((a) => (
            <button
              className="agent-row"
              key={a.id}
              onClick={() => setAgentId(a.id)}
            >
              <Avatar name={a.name} online={!!a.runtime} small />
              <span>
                <strong>{a.name}</strong>
                <small>
                  {a.runtime ? a.work || runtimeLabel(a) : "未连接"}
                </small>
              </span>
              {a.unread > 0 && <span className="badge">{a.unread}</span>}
            </button>
          ))}
          {overview && !overview.agents.length && (
            <button
              className="add-agent"
              onClick={() => {
                setModal("agent");
                setModalError("");
              }}
            >
              <Plus size={15} />
              接入第一个 Agent
            </button>
          )}
        </div>
        <footer className="workspace">
          <span className={`connection-dot ${connected ? "ready" : ""}`} />
          {connected ? "本机工作区" : "正在重新连接…"}
          <span>v0.1</span>
        </footer>
      </aside>
      <main className="main">
        <button
          className="mobile-back icon-button"
          aria-label="打开导航"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <ArrowLeft size={20} />
        </button>
        {error && (
          <div className="global-error" role="alert">
            {error}
            <button onClick={refresh}>重试</button>
          </div>
        )}
        {!overview ? (
          <Empty
            icon={<LoaderCircle className="spin" size={26} />}
            title="正在连接中庭"
          >
            <p>读取你的会话与 Agent。</p>
          </Empty>
        ) : section === "events" ? (
          <Integrations
            overview={overview}
            revision={revision}
            refresh={refresh}
          />
        ) : !active ? (
          <Empty icon={<Mark />} title="从一段对话开始">
            <p>和 Agent 交流，让消息找到合适的回应。</p>
            <button
              className="button"
              onClick={() => {
                setModal(overview.agents.length ? "chat" : "agent");
                setModalError("");
              }}
            >
              {overview.agents.length ? "新建会话" : "接入 Agent"}
            </button>
            <span className="empty-caption">聊天 · 个人收件箱 · 外部事件</span>
          </Empty>
        ) : (
          <>
            <header className="main-header">
              <div>
                <h1>
                  {active.kind === "group" && <Hash size={21} />} {active.name}
                </h1>
                <p>
                  {members.length} 位 Agent ·{" "}
                  {active.kind === "group"
                    ? "@ 提及可及时送达"
                    : "私聊消息及时送达"}
                </p>
              </div>
              <div className="member-stack">
                {overview.agents
                  .filter((a) => members.includes(a.id))
                  .map((a) => (
                    <button
                      key={a.id}
                      aria-label={`查看 ${a.name} 的收件箱`}
                      title={`${a.name} · ${a.work || runtimeLabel(a)}`}
                      onClick={() => setAgentId(a.id)}
                    >
                      <Avatar small name={a.name} online={!!a.runtime} />
                    </button>
                  ))}
                {active.kind === "group" && (
                  <button
                    className="icon-button"
                    aria-label="添加群成员"
                    onClick={() => {
                      setModal("members");
                      setModalError("");
                    }}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
            </header>
            <div
              ref={scroll}
              className="timeline"
              onScroll={() => {
                const el = scroll.current;
                if (el)
                  nearBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 90;
              }}
            >
              {loading ? (
                <p className="loading">
                  <LoaderCircle className="spin" size={16} />
                  加载消息…
                </p>
              ) : (
                <>
                  {older && (
                    <button
                      className="older"
                      onClick={() => {
                        const target = chatId,
                          height = scroll.current?.scrollHeight ?? 0;
                        void api<{ items: Message[]; has_more: boolean }>(
                          `/chats/${chatId}/messages?before=${messages[0]?.id}`,
                        )
                          .then((page) => {
                            if (currentChat.current !== target) return;
                            nearBottom.current = false;
                            setMessages((old) => [
                              ...new Map(
                                [...page.items, ...old].map((m) => [m.id, m]),
                              ).values(),
                            ]);
                            setOlder(page.has_more);
                            requestAnimationFrame(() => {
                              if (scroll.current)
                                scroll.current.scrollTop =
                                  scroll.current.scrollHeight - height;
                            });
                          })
                          .catch((e) => setError(e.message));
                      }}
                    >
                      查看更早消息
                    </button>
                  )}
                  {!messages.length && (
                    <div className="conversation-start">
                      <Hash size={27} />
                      <h2>{active.name}</h2>
                      <p>
                        这是对话的开始。
                        {active.kind === "group"
                          ? "试着 @ 一位 Agent。"
                          : "发一条消息，和它聊聊。"}
                      </p>
                    </div>
                  )}
                  {messages.map((message, index) => {
                    const name =
                      message.sender === "user"
                        ? "你"
                        : (overview.agents.find((a) => a.id === message.sender)
                            ?.name ?? "Agent");
                    const continuation =
                      index > 0 &&
                      messages[index - 1].sender === message.sender &&
                      message.created_at - messages[index - 1].created_at <
                        180000;
                    return (
                      <article
                        className={`message ${continuation ? "continuation" : ""}`}
                        key={message.id}
                      >
                        {!continuation && <Avatar name={name} />}
                        <div className="message-content">
                          {!continuation && (
                            <div className="message-heading">
                              <strong>{name}</strong>
                              {message.sender !== "user" && (
                                <span className="agent-tag">Agent</span>
                              )}
                              <time>{time(message.created_at)}</time>
                            </div>
                          )}
                          <div className="markdown">
                            <Markdown
                              components={{
                                a: (props) => (
                                  <a
                                    {...props}
                                    target="_blank"
                                    rel="noreferrer"
                                  />
                                ),
                                img: ({ alt }) => (
                                  <span>[图片：{alt || "未加载"}]</span>
                                ),
                              }}
                            >
                              {message.body}
                            </Markdown>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </>
              )}
            </div>
            <div className="composer-wrap">
              <form className="composer" onSubmit={send}>
                {candidates.length > 0 && (
                  <div
                    className="mentions"
                    role="listbox"
                    aria-label="提及 Agent"
                  >
                    {candidates.map((a, index) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === mentionIndex}
                        className={index === mentionIndex ? "highlighted" : ""}
                        key={a.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => chooseMention(a)}
                      >
                        <Avatar small name={a.name} online={!!a.runtime} />
                        <span>
                          <strong>{a.name}</strong>
                          <small>{a.work || runtimeLabel(a)}</small>
                        </span>
                        <span className="muted small-text">
                          {runtimeLabel(a)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={textarea}
                  aria-label="消息"
                  placeholder={
                    active.kind === "group"
                      ? `发送到 ${active.name}，输入 @ 提及 Agent…`
                      : `发送给 ${active.name}…`
                  }
                  value={draft}
                  rows={2}
                  maxLength={6000}
                  onChange={(e) => {
                    setDrafts((old) => ({ ...old, [chatId!]: e.target.value }));
                    setMentionHidden(false);
                    setMentionIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (
                      candidates.length &&
                      ["ArrowDown", "ArrowUp"].includes(e.key)
                    ) {
                      e.preventDefault();
                      setMentionIndex(
                        (i) =>
                          (i +
                            (e.key === "ArrowDown" ? 1 : -1) +
                            candidates.length) %
                          candidates.length,
                      );
                    } else if (
                      candidates.length &&
                      (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
                    ) {
                      e.preventDefault();
                      chooseMention(candidates[mentionIndex] ?? candidates[0]);
                    } else if (e.key === "Escape") setMentionHidden(true);
                    else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="提及 Agent"
                    onClick={() => {
                      setDrafts((old) => ({
                        ...old,
                        [chatId!]: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`,
                      }));
                      setMentionHidden(false);
                      textarea.current?.focus();
                    }}
                  >
                    <AtSign size={18} />
                  </button>
                  <span className="compose-hint">
                    {mentionIds.length
                      ? `将通知 ${mentionIds.length} 位 Agent`
                      : "Enter 发送 · Shift + Enter 换行"}
                  </span>
                  <button
                    className="send-button"
                    aria-label="发送消息"
                    disabled={!draft.trim() || sending}
                  >
                    {sending ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <ArrowUp size={19} />
                    )}
                  </button>
                </div>
              </form>
              <p className="composer-note">
                {active.kind === "group"
                  ? "普通消息按订阅节奏提醒；明确 @ 不等待。"
                  : "消息会保留；未连接的 Agent 按自动启动设置处理。"}
              </p>
            </div>
          </>
        )}
      </main>
      {selectedAgent && (
        <AgentDrawer
          key={selectedAgent.id}
          agent={selectedAgent}
          revision={revision}
          initialTab={setupAgent === selectedAgent.id ? "settings" : "box"}
          close={() => {
            setAgentId(null);
            setSetupAgent(null);
          }}
          refresh={refresh}
        />
      )}
      {modal && (
        <Modal
          title={
            modal === "agent"
              ? "添加 Agent"
              : modal === "members"
                ? "添加群成员"
                : "新建会话"
          }
          close={() => !creating && setModal(null)}
        >
          <form className="create-form" onSubmit={create}>
            {modalError && (
              <p className="error" role="alert">
                {modalError}
              </p>
            )}
            {modal === "agent" ? (
              <>
                <p className="muted">
                  先建立身份，再连接已有 Pi 或启动新实例。
                </p>
                <label>
                  名称
                  <input
                    name="name"
                    required
                    maxLength={40}
                    placeholder="例如 Atlas"
                    autoFocus
                  />
                </label>
                <label>
                  工作目录
                  <input name="cwd" required placeholder="/绝对路径/工作目录" />
                </label>
                <p className="muted small-text">
                  Pi
                  使用该目录和你现有的权限运行，不是隔离沙箱。默认不自动启动。
                </p>
              </>
            ) : modal === "members" ? (
              <>
                <p className="muted">加入后可读取本群的聊天记录。</p>
                <label>
                  Agent
                  <select name="member" required defaultValue="">
                    <option value="" disabled>
                      选择要加入的 Agent
                    </option>
                    {overview?.agents
                      .filter((a) => !members.includes(a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  群聊名称
                  <input
                    name="name"
                    maxLength={40}
                    placeholder="例如 Chat 开发"
                    autoFocus
                  />
                </label>
                <fieldset>
                  <legend>群成员</legend>
                  {overview?.agents.map((a) => (
                    <label className="check-row" key={a.id}>
                      <input type="checkbox" name="members" value={a.id} />
                      <Avatar small name={a.name} />
                      {a.name}
                      <span className="muted">{runtimeLabel(a)}</span>
                    </label>
                  ))}
                  {!overview?.agents.length && (
                    <p className="muted">可先创建群聊，或关闭后添加 Agent。</p>
                  )}
                </fieldset>
                <label>
                  或直接发起私聊
                  <select name="direct" defaultValue="">
                    <option value="">创建上面的群聊</option>
                    {overview?.agents.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={creating}
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button className="button" disabled={creating}>
                {creating ? "创建中…" : "创建"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
