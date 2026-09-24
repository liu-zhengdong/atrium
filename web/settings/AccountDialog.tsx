import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Check, ChevronLeft, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import type { ProviderEntry, ProviderMethod } from "../../shared/providers.ts";
import type { Account } from "./types.ts";
import { LoginFlow } from "./LoginFlow.tsx";

const inputStyle =
  "field !border-transparent !bg-[#f1f5f2] focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none";
type Step = "method" | "provider" | "auth" | "name" | "login" | "assign";

export function AccountDialog({
  account,
  agents,
  accounts,
  close,
  reload,
}: {
  account?: Account;
  agents: Agent[];
  accounts: Account[];
  close: () => void;
  reload: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>(account ? "auth" : "method");
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
  const [method, setMethod] = useState<ProviderMethod>(
    account?.type === "oauth" ? "oauth" : "api_key",
  );
  const [provider, setProvider] = useState<ProviderEntry | null>(null);
  const [search, setSearch] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState(account?.name ?? "");
  const [login, setLogin] = useState<string | null>(null);
  const activeLogin = useRef<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (account) return;
    api<ProviderEntry[]>("/providers")
      .then(setProviders)
      .catch((e) => setError(String(e)));
  }, [account]);
  const dismiss = useCallback(() => {
    const pending = activeLogin.current;
    activeLogin.current = null;
    if (pending)
      void api(`/accounts/${pending}/login/cancel`, "POST")
        .then(reload)
        .catch(() => {});
    close();
  }, [close, reload]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [dismiss]);
  useEffect(
    () => () => {
      if (activeLogin.current)
        void api(`/accounts/${activeLogin.current}/login/cancel`, "POST").catch(
          () => {},
        );
    },
    [],
  );

  const title = account
    ? `重新登录 ${account.name}`
    : step === "assign"
      ? "分配给 Agent"
      : "添加账号";
  const available =
    providers?.filter(
      (item) =>
        item.methods.includes(method) &&
        `${item.id} ${item.name}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const back = () => {
    setError("");
    setStep(
      step === "provider"
        ? "method"
        : step === "auth"
          ? "provider"
          : step === "name"
            ? method === "oauth"
              ? "provider"
              : "auth"
            : "method",
    );
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (step === "auth" && !account) {
        if (!key.trim()) throw new Error("API Key 不能为空");
        setStep("name");
      } else if (step === "name" && provider) {
        const accountName = name.trim() || provider.name;
        const result =
          method === "oauth"
            ? await api<{ id: string }>("/accounts/login", "POST", {
                provider: provider.id,
                name: accountName,
              })
            : await api<{ id: string }>("/accounts", "POST", {
                provider: provider.id,
                name: accountName,
                key: key.trim(),
              });
        if (method === "oauth") {
          activeLogin.current = result.id;
          setLogin(result.id);
          setStep("login");
        } else {
          setCreated(result.id);
          setStep("assign");
          await reload();
        }
      } else if (step === "auth" && account) {
        const result = await api<{ id: string }>(
          `/accounts/${account.id}/login`,
          "POST",
        );
        activeLogin.current = result.id;
        setLogin(result.id);
        setStep("login");
        await reload();
      } else if (step === "assign" && created) {
        for (const id of selected)
          await api(`/assign/${encodeURIComponent(id)}`, "POST", {
            account: created,
          });
        await reload();
        close();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1e2b2280] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[480px] rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {!account && ["provider", "auth", "name"].includes(step) && (
              <button
                type="button"
                className="icon-button"
                aria-label="返回上一步"
                onClick={back}
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <h2 className="m-0 text-base font-medium">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭对话框"
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </div>
        {step === "method" && (
          <div className="mt-5 space-y-2">
            <p className="m-0 pb-1 text-xs text-muted">选择连接方式</p>
            {(["oauth", "api_key"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className="flex w-full items-center justify-between rounded-xl bg-[#f3f6f3] px-4 py-3 text-left text-sm hover:bg-[#e9f0ea]"
                onClick={() => {
                  setMethod(item);
                  setStep("provider");
                }}
              >
                {item === "oauth" ? "账号登录" : "API Key"}
              </button>
            ))}
          </div>
        )}
        {step === "provider" && (
          <div className="mt-5">
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                autoFocus
                className={`${inputStyle} !pl-9`}
                aria-label="筛选供应商"
                placeholder="搜索供应商"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div
              className="mt-2 max-h-[320px] space-y-1 overflow-y-auto"
              role="listbox"
              aria-label="供应商"
            >
              {!providers && !error && (
                <p className="px-3 py-4 text-xs text-muted">正在加载…</p>
              )}
              {providers && !available.length && (
                <p className="px-3 py-4 text-xs text-muted">没有匹配的供应商</p>
              )}
              {available.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={provider?.id === item.id}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-[#f1f5f2]"
                  onClick={() => {
                    setProvider(item);
                    setName(item.name);
                    setStep(
                      item.methods.includes(method) && method === "oauth"
                        ? "name"
                        : "auth",
                    );
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{item.name}</span>
                    <span className="text-xs text-muted">{item.id}</span>
                  </span>
                  {accounts.some(
                    (a) => a.provider === item.id && a.status === "ready",
                  ) && (
                    <span className="shrink-0 text-xs text-muted">已连接</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        {(step === "auth" || step === "name" || step === "assign") && (
          <form
            onSubmit={(event) => void submit(event)}
            className="mt-5 space-y-4"
          >
            {step === "auth" && !account && (
              <label className="block text-xs text-muted">
                API Key
                <input
                  autoFocus
                  className={`${inputStyle} mt-1.5`}
                  type="password"
                  autoComplete="off"
                  required
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
            )}
            {step === "name" && (
              <label className="block text-xs text-muted">
                账号名
                <input
                  autoFocus
                  className={`${inputStyle} mt-1.5`}
                  maxLength={80}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {step === "assign" && (
              <div
                className="max-h-[320px] space-y-1 overflow-y-auto"
                aria-label="分配给 Agent"
              >
                {agents.length === 0 && (
                  <p className="text-xs text-muted">
                    还没有 Agent，可以稍后分配。
                  </p>
                )}
                {agents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    aria-pressed={selected.includes(agent.id)}
                    onClick={() =>
                      setSelected((before) =>
                        before.includes(agent.id)
                          ? before.filter((id) => id !== agent.id)
                          : [...before, agent.id],
                      )
                    }
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f1f5f2]"
                  >
                    <span>
                      {agent.name}{" "}
                      <span className="text-xs text-muted">{agent.ref}</span>
                    </span>
                    {selected.includes(agent.id) && (
                      <Check size={16} className="text-accent-strong" />
                    )}
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-[#9a5b4b]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="button !border-0 !bg-transparent !text-[#3c5344] hover:!bg-[#f1f5f2]"
                type="button"
                onClick={step === "assign" ? close : dismiss}
              >
                {step === "assign" ? "跳过" : "取消"}
              </button>
              <button className="button" type="submit" disabled={busy}>
                {busy
                  ? "处理中…"
                  : step === "assign"
                    ? "完成"
                    : step === "auth" && account
                      ? "开始登录"
                      : "继续"}
              </button>
            </div>
          </form>
        )}
        {step === "login" && login && (
          <div className="mt-5">
            <LoginFlow
              id={login}
              finished={() => {
                activeLogin.current = null;
                void reload();
                if (!account) {
                  setCreated(login);
                  setStep("assign");
                }
              }}
              close={dismiss}
            />
          </div>
        )}
        {error && !["auth", "name", "assign"].includes(step) && (
          <p role="alert" className="mt-3 text-xs text-[#9a5b4b]">
            {error}
          </p>
        )}
      </section>
    </div>,
    document.body,
  );
}
