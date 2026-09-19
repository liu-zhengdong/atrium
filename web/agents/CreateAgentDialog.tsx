import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";

function SourcePicker({
  agents,
  value,
  onChange,
}: {
  agents: Agent[];
  value: string;
  onChange: (source: string) => void;
}) {
  const sources = agents.filter((agent) => agent.agent_directory);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const matches = query.trim().toLowerCase();
  const visible = sources.filter((agent) =>
    `${agent.name} ${agent.description}`.toLowerCase().includes(matches),
  );
  const builtinShown =
    !matches || "内置 builtin 默认配置类型".includes(matches);
  const selectedAgent = sources.find((agent) => agent.name === value);
  const searchable = sources.length >= 8;

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    if (searchable) searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, searchable]);

  function choose(source: string) {
    onChange(source);
    setQuery("");
    setOpen(false);
    triggerRef.current?.focus();
  }

  if (!sources.length) {
    return (
      <div className="field flex items-center gap-2 text-left">
        <span className="min-w-0 flex-1">内置</span>
        <span className="muted shrink-0 text-[10px]">预置类型</span>
      </div>
    );
  }

  return (
    <div ref={root} className={`relative ${open ? "source-picker-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="field flex items-center gap-2 text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="基于"
        onClick={() =>
          setOpen((current) => {
            if (current) setQuery("");
            return !current;
          })
        }
      >
        {selectedAgent ? (
          <>
            <Avatar small name={selectedAgent.name} />
            <span className="min-w-0 flex-1 truncate">
              {selectedAgent.name}
            </span>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1">内置</span>
            <span className="muted shrink-0 text-[10px]">预置类型</span>
          </>
        )}
        <ChevronDown
          size={16}
          className={`shrink-0 text-[#968a75] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute top-full z-20 mt-1.5 w-full overflow-hidden rounded-[6px] border border-[#ddd7ca] bg-white shadow-[0_8px_24px_#3629191a]">
          {searchable && (
            <input
              ref={searchRef}
              className="w-full border-0 border-b border-[#eee8dc] px-2.5 py-2 text-xs outline-none"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索身份"
              aria-label="搜索身份"
            />
          )}
          <ul
            role="listbox"
            className="m-0 max-h-52 list-none overflow-auto p-0 py-1"
          >
            {builtinShown && (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === "builtin"}
                  className={`flex w-full items-center gap-2 px-2.5 py-[7px] text-left text-xs ${
                    value === "builtin" ? "bg-[#f5f4f0]" : "hover:bg-[#f8f7f4]"
                  }`}
                  onClick={() => choose("builtin")}
                >
                  <span className="min-w-0 flex-1">内置</span>
                  <span className="muted shrink-0 text-[10px]">预置类型</span>
                </button>
              </li>
            )}
            {visible.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === agent.name}
                  className={`flex w-full items-center gap-2 px-2.5 py-[7px] text-left text-xs ${
                    value === agent.name ? "bg-[#f5f4f0]" : "hover:bg-[#f8f7f4]"
                  }`}
                  onClick={() => choose(agent.name)}
                >
                  <Avatar small name={agent.name} />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                </button>
              </li>
            ))}
            {!builtinShown && !visible.length && (
              <li className="px-2.5 py-2 text-xs text-[#968a75]">
                没有匹配的来源
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  const [source, setSource] = useState("builtin");
  async function submit(data: FormData) {
    const result = await api<{ agent: Agent; start_error?: string }>(
      "/agents",
      "POST",
      {
        name: data.get("name"),
        description: data.get("description"),
        source,
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
        <span className="form-title">名称</span>
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
        <span className="form-title">
          自我介绍 <span className="muted font-normal">（可选）</span>
        </span>
        <textarea
          className="field"
          name="description"
          maxLength={1000}
          placeholder="擅长什么，主要负责什么"
          rows={2}
        />
      </label>
      <div className="form-label">
        <span className="form-title">基于</span>
        <SourcePicker agents={agents} value={source} onChange={setSource} />
      </div>
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
