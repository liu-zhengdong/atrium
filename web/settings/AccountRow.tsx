import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, UsersRound } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { api } from "../api.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
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
  focused,
  openAgent,
  relogin,
}: {
  account: Account;
  accounts: Account[];
  agents: Agent[];
  change: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  focused: boolean;
  openAgent: (id: string) => void;
  relogin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) {
      root.current?.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, [focused]);
  const assignedAgents = account.assigned
    .map((id) => agents.find((agent) => agent.ref === id))
    .filter((agent): agent is Agent => !!agent);
  const agentNames = assignedAgents.map((agent) => agent.name);
  return (
    <section ref={root} className="py-5 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 truncate text-sm font-medium">{account.name}</h2>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${account.status === "ready" ? "bg-[#63976c]" : account.status === "pending" ? "bg-[#d1a15b]" : "bg-[#ba7963]"}`}
              aria-label={`状态：${account.status}`}
              title={account.status}
            />
            <span className="badge">{account.provider}</span>
          </div>
          <p className="mb-0 mt-1.5 text-xs text-muted">
            {account.type === "oauth" ? "OAuth" : "API key"}
            {expiry(account.expires) && ` · ${expiry(account.expires)}`}
            {account.last_error &&
              ` · ${account.last_error === "未知错误" && !account.expires ? "登录未完成" : account.last_error}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {account.type === "api_key" && account.status === "error" && (
            <button className="button secondary !text-xs" onClick={relogin}>
              更换 Key
            </button>
          )}
          {account.type === "oauth" &&
            (account.status === "error" ||
              (account.expires !== null && account.expires < Date.now())) && (
              <button className="button secondary !text-xs" onClick={relogin}>
                {account.last_error === "登录未完成" ||
                (!account.expires && account.last_error === "未知错误")
                  ? "继续登录"
                  : "重新登录"}
              </button>
            )}
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
      <div className="mt-4 flex items-center gap-2 border-t border-[#edf1ed] pt-3">
        <span className="shrink-0 text-xs text-muted">分配</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {assignedAgents.length ? (
            assignedAgents.map((agent) => (
              <button
                key={agent.id}
                className="flex min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-xs hover:bg-soft"
                title={`查看 ${agent.name}`}
                onClick={() => openAgent(agent.id)}
              >
                <Avatar name={agent.name} tiny />
                <span className="truncate">{agent.name}</span>
              </button>
            ))
          ) : (
            <span className="text-xs text-muted">尚未分配</span>
          )}
        </div>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="icon-button"
              aria-label={`分配 ${account.name}`}
              title="分配"
            >
              <UsersRound size={17} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-50 w-[min(340px,calc(100vw-32px))] rounded-xl bg-white p-4 shadow-xl"
              aria-label={`分配 ${account.name}`}
              onInteractOutside={(event) => {
                if (document.querySelector('[aria-label="确认分配"]'))
                  event.preventDefault();
              }}
            >
              <AssignmentPicker
                account={account}
                accounts={accounts}
                agents={agents}
                change={change}
                openAgent={openAgent}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </section>
  );
}
