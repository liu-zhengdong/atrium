import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import type { Account, Credentials } from "./types.ts";

export function AssignmentPicker({
  account,
  accounts,
  agents,
  change,
  openAgent,
}: {
  account: Account;
  accounts: Account[];
  agents: Agent[];
  change: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  openAgent: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{
    agent: Agent;
    previous?: Account;
    shared: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        setPending(null);
      }
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [pending]);
  const filtered = agents.filter((agent) =>
    `${agent.name} ${agent.ref}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function select(agent: Agent) {
    setError("");
    setBusy(true);
    try {
      if (account.assigned.includes(agent.ref)) {
        await change(() =>
          api(`/assign/${agent.ref}/${account.provider}`, "DELETE"),
        );
      } else {
        const previous = accounts.find(
          (item) =>
            item.provider === account.provider &&
            item.assigned.includes(agent.ref),
        );
        const credentials = await api<Credentials>(`/credentials/${agent.ref}`);
        if (previous || credentials.mode === "shared")
          setPending({
            agent,
            previous,
            shared: credentials.mode === "shared",
          });
        else
          await change(() =>
            api(`/assign/${agent.ref}`, "POST", { account: account.id }),
          );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!pending) return;
    setBusy(true);
    const { agent, previous } = pending;
    try {
      const result = await change(() =>
        api(`/assign/${agent.ref}`, "POST", {
          account: account.id,
          replace: !!previous,
        }),
      );
      if (result) setPending(null);
      else setError("分配失败，请检查账号状态。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <input
        className="field !border-transparent !bg-[#f1f5f2] focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none"
        aria-label="筛选 Agent"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="查找 Agent"
      />
      <div className="max-h-48 space-y-0.5 overflow-auto">
        {filtered.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-soft"
          >
            <button
              className="min-w-0 truncate text-left text-xs text-accent-strong hover:underline"
              onClick={() => openAgent(agent.id)}
            >
              {agent.name} <span className="text-muted">{agent.ref}</span>
            </button>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={account.assigned.includes(agent.ref)}
                disabled={busy || !agent.agent_directory}
                onChange={() => void select(agent)}
              />
              <span className="sr-only">分配给 {agent.name}</span>
            </label>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted">没有匹配的 Agent</p>
        )}
      </div>
      {agents.some((agent) => !agent.agent_directory) && (
        <p className="m-0 text-[11px] text-muted">
          尚未启动、没有配置目录的 Agent 不能分配。
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error}
        </p>
      )}
      {pending &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#1e2b2280] p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="确认分配"
              className="w-full max-w-[400px] rounded-2xl bg-white p-5 text-xs shadow-xl"
            >
              <p className="m-0">
                {pending.previous
                  ? `将用「${account.name}」替换 ${pending.agent.name} 的账号「${pending.previous.name}」（${account.provider}）。`
                  : `将把 ${account.name} 分配给 ${pending.agent.name}。`}
              </p>
              {pending.shared && (
                <p className="mb-0 mt-2 text-muted">
                  该 Agent 将不再使用你个人 Pi 的登录，只用分配给它的账号。
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  确认分配
                </button>
                <button
                  className="button secondary"
                  onClick={() => setPending(null)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
