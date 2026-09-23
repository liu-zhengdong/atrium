import { useEffect, useRef, useState } from "react";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { AssignmentPicker } from "./AssignmentPicker.tsx";
import type { Account } from "./types.ts";

function expiry(timestamp: number | null) {
  if (!timestamp) return "";
  const remaining = timestamp - Date.now();
  if (remaining < 0) return "已过期";
  if (remaining < 3_600_000)
    return `约 ${Math.max(1, Math.ceil(remaining / 60_000))} 分钟后到期`;
  if (remaining < 86_400_000)
    return `约 ${Math.ceil(remaining / 3_600_000)} 小时后到期`;
  return `约 ${Math.ceil(remaining / 86_400_000)} 天后到期`;
}

export function AccountRow({
  account,
  accounts,
  agents,
  change,
  reload,
  focused,
  openAgent,
}: {
  account: Account;
  accounts: Account[];
  agents: Agent[];
  change: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  reload: () => Promise<void>;
  focused: boolean;
  openAgent: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(focused);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) {
      setExpanded(true);
      root.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focused]);
  const agentNames = account.assigned.map(
    (id) => agents.find((agent) => agent.ref === id)?.name ?? id,
  );
  return (
    <section ref={root} className="rounded-2xl bg-white p-5 shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${account.status === "ready" ? "bg-[#63976c]" : account.status === "pending" ? "bg-[#d1a15b]" : "bg-[#ba7963]"}`}
              aria-label={`状态：${account.status}`}
              title={account.status}
            />
            <h2 className="m-0 truncate text-sm font-medium">{account.name}</h2>
            <span className="badge">{account.provider}</span>
          </div>
          <p className="mb-0 mt-1.5 text-xs text-muted">
            {account.type === "oauth" ? "OAuth" : "API key"}
            {expiry(account.expires) && ` · ${expiry(account.expires)}`}
            {account.last_error && ` · ${account.last_error}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="icon-button"
            aria-label={`重命名 ${account.name}`}
            onClick={() => {
              setName(account.name);
              setEditing(true);
            }}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`删除 ${account.name}`}
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void change(() =>
              api(`/accounts/${account.id}`, "PATCH", { name }),
            ).then((result) => {
              if (result) setEditing(false);
            });
          }}
          className="mt-3 flex gap-2"
        >
          <input
            className="field"
            required
            maxLength={80}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="新账号名称"
          />
          <button className="button" type="submit">
            保存
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => setEditing(false)}
          >
            取消
          </button>
        </form>
      )}
      {deleting && (
        <div
          role="dialog"
          aria-label="确认删除账号"
          className="mt-3 rounded-xl bg-[#fbf5ee] p-3 text-xs"
        >
          <p className="m-0">
            删除「{account.name}」？
            {agentNames.length > 0 &&
              `将撤销 ${agentNames.join("、")} 的分配。`}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className="button"
              onClick={() =>
                void change(() =>
                  api(`/accounts/${account.id}`, "DELETE"),
                ).then((result) => {
                  if (result) setDeleting(false);
                })
              }
            >
              确认删除
            </button>
            <button
              className="button secondary"
              onClick={() => setDeleting(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          className="flex min-w-0 items-center gap-1 text-xs text-muted hover:text-ink"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          <span className="truncate">
            {agentNames.length
              ? `已分配 · ${agentNames.join("、")}`
              : "尚未分配"}
          </span>
        </button>
        <span className="shrink-0 text-[11px] text-muted">{account.id}</span>
      </div>
      {expanded && (
        <div className="mt-4">
          <AssignmentPicker
            account={account}
            accounts={accounts}
            agents={agents}
            change={change}
            reload={reload}
            openAgent={openAgent}
          />
        </div>
      )}
    </section>
  );
}
