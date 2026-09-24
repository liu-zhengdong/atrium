import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { AccountRow } from "./AccountRow.tsx";
import { AccountDialog } from "./AccountDialog.tsx";
import { useAccounts } from "./useAccounts.ts";
import { matches, type Account } from "./types.ts";

export function AccountsPage({
  agents,
  query,
  focus,
  openAgent,
}: {
  agents: Agent[];
  query: string;
  focus: string | null;
  openAgent: (id: string) => void;
}) {
  const { accounts, error, reload, change } = useAccounts();
  const [dialog, setDialog] = useState<Account | "new" | null>(null);
  const visible = accounts?.filter((account) =>
    matches(
      query,
      account.name,
      account.provider,
      account.id,
      account.type,
      ...agents
        .filter((agent) => account.assigned.includes(agent.ref))
        .map((agent) => agent.name),
    ),
  );
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">模型账号</h1>
        </div>
        <button
          className="button flex items-center gap-1"
          onClick={() => setDialog("new")}
        >
          <Plus size={15} />
          添加账号
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-[#fbf5ee] p-3 text-xs text-[#9a5b4b]"
        >
          {error}{" "}
          <button className="underline" onClick={() => void reload()}>
            重试
          </button>
        </p>
      )}
      {dialog && (
        <AccountDialog
          agents={agents}
          accounts={accounts ?? []}
          account={dialog === "new" ? undefined : dialog}
          close={() => setDialog(null)}
          reload={reload}
        />
      )}
      {!accounts && !error && (
        <p className="py-8 text-center text-xs text-muted">正在读取账号…</p>
      )}
      {accounts && accounts.length === 0 && (
        <div className="py-12 text-center">
          <KeyRound className="mx-auto text-accent" size={24} />
          <p className="mb-1 mt-4 text-sm">还没有账号</p>
          <p className="mb-0 text-xs text-muted">点击「添加账号」开始。</p>
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <>
          {visible?.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">
              没有匹配的账号
            </p>
          ) : (
            <div className="divide-y divide-line-subtle">
              {visible?.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  accounts={accounts}
                  agents={agents}
                  change={change}
                  focused={focus === account.id}
                  openAgent={openAgent}
                  relogin={() => setDialog(account)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
