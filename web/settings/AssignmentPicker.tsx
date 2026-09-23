import { useState } from "react";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import type { Account, Credentials } from "./types.ts";

export function AssignmentPicker({
  account,
  accounts,
  agents,
  change,
  reload,
  openAgent,
}: {
  account: Account;
  accounts: Account[];
  agents: Agent[];
  change: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  reload: () => Promise<void>;
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
    // Replacement requires two server calls: restore the old account if the new assignment fails.
    try {
      if (previous)
        await api(`/assign/${agent.ref}/${account.provider}`, "DELETE");
      await api(`/assign/${agent.ref}`, "POST", { account: account.id });
      await reload();
      setPending(null);
    } catch (e) {
      if (previous) {
        try {
          await api(`/assign/${agent.ref}`, "POST", { account: previous.id });
        } catch {
          setError("分配失败，原账号也未能恢复。请刷新后检查该 Agent。");
          await reload();
          setBusy(false);
          return;
        }
      }
      setError(String(e));
      await reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-xl bg-[#f6f8f6] p-3">
      <input
        className="field"
        aria-label="筛选 Agent"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="查找 Agent"
      />
      <div className="max-h-48 space-y-0.5 overflow-auto">
        {filtered.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-white"
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
      {pending && (
        <div
          role="dialog"
          aria-label="确认分配"
          className="rounded-lg bg-white p-3 text-xs shadow-lift"
        >
          <p className="m-0">
            {pending.previous
              ? `将替换 ${pending.agent.name} 的 ${account.provider} 账号「${pending.previous.name}」。`
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
      )}
    </div>
  );
}
