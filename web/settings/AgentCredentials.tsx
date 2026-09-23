import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../api.ts";
import type { Account, Credentials } from "./types.ts";

export function AgentCredentials({
  agentId,
  open,
}: {
  agentId: string;
  open: (account: string | null) => void;
}) {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"shared" | "assigned" | null>(null);
  const load = useCallback(async () => {
    try {
      const [mode, list] = await Promise.all([
        api<Credentials>(`/credentials/${agentId}`),
        api<Account[]>("/accounts"),
      ]);
      setCredentials(mode);
      setAccounts(list);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function switchMode(mode: "shared" | "assigned") {
    try {
      await api(`/credentials/${agentId}`, "PUT", { mode });
      setConfirm(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="settings-section">
      <h3>账号</h3>
      {error && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error}
        </p>
      )}
      {!credentials && !error && (
        <p className="text-xs text-muted">正在读取账号…</p>
      )}
      {credentials && (
        <>
          <p className="mb-1 mt-2 text-xs text-muted">
            {credentials.mode === "shared" ? "共享你的 Pi 登录" : "独立账号"}
          </p>
          {credentials.assigned.map(({ provider, account }) => (
            <button
              key={provider}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-soft"
              onClick={() => open(account)}
            >
              <span className="min-w-0 truncate">
                {provider} ·{" "}
                {accounts.find((item) => item.id === account)?.name ??
                  "账号不可用"}
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
          {!credentials.assigned.length && (
            <button
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-muted hover:bg-soft"
              onClick={() => open(null)}
            >
              前往账号设置 <ChevronRight size={15} />
            </button>
          )}
          {(credentials.mode === "assigned" ||
            credentials.assigned.length > 0) && (
            <button
              className="button secondary mt-3 !text-xs"
              onClick={() =>
                setConfirm(
                  credentials.mode === "assigned" ? "shared" : "assigned",
                )
              }
            >
              {credentials.mode === "assigned"
                ? "切回共享登录"
                : "使用已分配账号"}
            </button>
          )}
          {confirm && (
            <div
              className="mt-3 rounded-xl bg-soft p-4 text-xs"
              role="dialog"
              aria-label={
                confirm === "shared" ? "确认切回共享登录" : "确认使用已分配账号"
              }
            >
              <p className="m-0">
                {confirm === "shared"
                  ? "将重新使用你个人 Pi 的登录；现有分配保留，可随时恢复。"
                  : "将不再使用你个人 Pi 的登录，只用已分配账号。"}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="button"
                  onClick={() => void switchMode(confirm)}
                >
                  {confirm === "shared" ? "确认切回" : "确认使用"}
                </button>
                <button
                  className="button secondary"
                  onClick={() => setConfirm(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
