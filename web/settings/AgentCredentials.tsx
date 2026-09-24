import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { api, messageOf } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import type { ProviderEntry } from "../../shared/providers.ts";
import { AssignmentPicker } from "./AssignmentPicker.tsx";
import { useAccounts } from "./useAccounts.ts";
import type { Credentials } from "./types.ts";

/** 身份视角的账号摘要；分配动作仍复用模型账号页的 AssignmentPicker。 */
export function AgentCredentials({
  agent,
  openAccounts,
  compact = false,
  visible = true,
}: {
  agent: Agent;
  openAccounts: () => void;
  compact?: boolean;
  visible?: boolean;
}) {
  const {
    accounts,
    error: accountsError,
    change,
    reload: reloadAccounts,
  } = useAccounts(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  async function reload() {
    try {
      setCredentials(await api<Credentials>(`/credentials/${agent.ref}`));
      setError("");
    } catch (e) {
      setError(messageOf(e));
    }
  }
  useEffect(() => {
    if (!visible) return;
    void reload();
    void reloadAccounts();
    void api<ProviderEntry[]>("/providers")
      .then(setProviders)
      .catch(() => {
        /* 缺少供应商目录时保留供应商 id。 */
      });
  }, [agent.ref, visible, reloadAccounts]);
  const assigned = credentials?.assigned ?? [];
  const providerName = (id: string) =>
    providers.find((provider) => provider.id === id)?.name || id;
  const selected =
    accounts?.find((account) => account.id === picker) ??
    accounts?.find((account) =>
      assigned.some(({ account: id }) => id === account.id),
    ) ??
    accounts?.[0];
  async function assign<T>(task: () => Promise<T>): Promise<T | undefined> {
    const result = await change(task);
    await reload();
    return result;
  }
  return (
    <section className={compact ? "space-y-1 text-xs" : "settings-section"}>
      {!compact && <h3>账号</h3>}
      {(error || accountsError) && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error || accountsError}
        </p>
      )}
      {!credentials && !error && (
        <p className="text-xs text-muted">正在读取账号…</p>
      )}
      {credentials && (
        <>
          {assigned.length ? (
            assigned.map(({ provider, account }) => {
              const item = accounts?.find((entry) => entry.id === account);
              return (
                <p
                  key={provider}
                  className="m-0 truncate text-xs text-muted"
                  title={`${providerName(provider)} · ${item?.name ?? "账号不可用"} · ${account}`}
                >
                  {compact && "账号 · "}
                  {providerName(provider)} · {item?.name ?? "账号不可用"} ·{" "}
                  {account}
                </p>
              );
            })
          ) : (
            <p className="m-0 text-xs text-muted">未分配账号</p>
          )}
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="text-xs text-accent-strong hover:underline"
              >
                {assigned.length ? "调整分配" : "分配账号"}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={6}
                aria-label="管理账号分配"
                onInteractOutside={(event) => {
                  if (document.querySelector('[aria-label="确认分配"]'))
                    event.preventDefault();
                }}
                className="z-50 w-[min(340px,calc(100vw-32px))] space-y-3 rounded-xl bg-white p-4 shadow-xl"
              >
                {accounts?.length ? (
                  <>
                    <div
                      className="max-h-44 space-y-0.5 overflow-y-auto"
                      aria-label="可分配的账号"
                    >
                      {accounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          aria-pressed={selected?.id === account.id}
                          className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs hover:bg-soft ${selected?.id === account.id ? "bg-soft text-accent-strong" : "text-ink"}`}
                          onClick={() => setPicker(account.id)}
                        >
                          {providerName(account.provider)} · {account.name} ·{" "}
                          {account.id}
                        </button>
                      ))}
                    </div>
                    {selected && (
                      <AssignmentPicker
                        key={selected.id}
                        account={selected}
                        accounts={accounts}
                        agents={[agent]}
                        change={assign}
                        openAgent={() => setOpen(false)}
                      />
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-accent-strong hover:underline"
                    onClick={openAccounts}
                  >
                    还没有账号，去添加
                  </button>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </>
      )}
    </section>
  );
}
