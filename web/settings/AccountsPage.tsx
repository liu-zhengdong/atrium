import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { AccountRow } from "./AccountRow.tsx";
import { LoginFlow } from "./LoginFlow.tsx";
import { useAccounts } from "./useAccounts.ts";
import { matches } from "./types.ts";

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
  const { accounts, error, busy, reload, change } = useAccounts();
  const [form, setForm] = useState<"key" | "oauth" | null>(null);
  const [provider, setProvider] = useState("deepseek");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const finished = useCallback(() => {
    void reload();
  }, [reload]);
  // Leaving settings should not leave an OAuth worker waiting for a code indefinitely.
  useEffect(
    () => () => {
      if (login)
        void api(`/accounts/${login}/login/cancel`, "POST").catch(() => {});
    },
    [login],
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form === "key") {
      if (!key.trim()) return;
      const result = await change(() =>
        api<{ id: string }>("/accounts", "POST", {
          provider: provider.trim(),
          name: name.trim(),
          key: key.trim(),
        }),
      );
      if (result) {
        setKey("");
        setName("");
        setForm(null);
      }
    } else {
      const result = await change(() =>
        api<{ id: string }>("/accounts/login", "POST", {
          provider,
          name: name.trim(),
        }),
      );
      if (result) {
        setLogin(result.id);
        setForm(null);
        setName("");
      }
    }
  }
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
          <h1 className="m-0 text-xl font-medium">账号</h1>
          <p className="mb-0 mt-1 text-xs text-muted">
            为 Agent 分配独立的模型登录。
          </p>
        </div>
        <button
          className="button flex items-center gap-1"
          onClick={() => {
            setForm("key");
            setProvider("deepseek");
          }}
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
      {form && (
        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-4 rounded-2xl bg-white p-5 shadow-lift"
        >
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-sm font-medium">
              {form === "key" ? "添加 API key" : "OAuth 登录"}
            </h2>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setForm(null);
                setKey("");
              }}
            >
              取消
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Provider
              {form === "oauth" ? (
                <select
                  className="field mt-1.5"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                >
                  <option value="openai-codex">openai-codex</option>
                  <option value="antigravity">antigravity</option>
                </select>
              ) : (
                <input
                  className="field mt-1.5"
                  value={provider}
                  required
                  onChange={(event) => setProvider(event.target.value)}
                  placeholder="deepseek"
                />
              )}
            </label>
            <label className="text-xs text-muted">
              名称
              <input
                className="field mt-1.5"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：工作账号"
              />
            </label>
          </div>
          {form === "key" && (
            <label className="block text-xs text-muted">
              API key
              <input
                className="field mt-1.5"
                type="password"
                autoComplete="off"
                required
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="粘贴后保存，不会回显"
              />
            </label>
          )}
          <button className="button" type="submit" disabled={busy}>
            {busy ? "提交中…" : form === "key" ? "保存账号" : "开始登录"}
          </button>
        </form>
      )}
      {login && (
        <LoginFlow
          id={login}
          finished={finished}
          close={() => {
            setLogin(null);
            void reload();
          }}
        />
      )}
      {!accounts && !error && (
        <p className="py-8 text-center text-xs text-muted">正在读取账号…</p>
      )}
      {accounts && accounts.length === 0 && !form && (
        <div className="rounded-2xl bg-white px-5 py-12 text-center shadow-lift">
          <KeyRound className="mx-auto text-accent" size={24} />
          <p className="mb-1 mt-4 text-sm">还没有账号</p>
          <p className="mb-4 text-xs text-muted">
            添加 API key，或用 OAuth 登录。
          </p>
          <button
            className="button secondary"
            onClick={() => {
              setProvider("openai-codex");
              setForm("oauth");
            }}
          >
            OAuth 登录
          </button>
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <>
          <div className="flex justify-end">
            <button
              className="text-xs text-accent-strong hover:underline"
              onClick={() => {
                setProvider("openai-codex");
                setForm("oauth");
              }}
            >
              用 OAuth 登录
            </button>
          </div>
          {visible?.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">
              没有匹配的账号
            </p>
          ) : (
            <div className="space-y-3">
              {visible?.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  accounts={accounts}
                  agents={agents}
                  change={change}
                  reload={reload}
                  focused={focus === account.id}
                  openAgent={openAgent}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
