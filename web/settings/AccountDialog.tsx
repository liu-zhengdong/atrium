import { useCallback, useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import type { Account } from "./types.ts";
import { LoginFlow } from "./LoginFlow.tsx";

const inputStyle =
  "field !border-transparent !bg-[#f1f5f2] focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none";
const providers = [
  "deepseek",
  "openrouter",
  "openai",
  "anthropic",
  "openai-codex",
  "antigravity",
];

export function AccountDialog({
  account,
  close,
  reload,
}: {
  account?: Account;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const [choice, setChoice] = useState(account?.provider ?? "deepseek");
  const [custom, setCustom] = useState("");
  const [name, setName] = useState(account?.name ?? "");
  const [key, setKey] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const provider = choice === "other" ? custom.trim() : choice;
  const oauth =
    account?.type === "oauth" ||
    ["openai-codex", "antigravity"].includes(provider);
  const dismiss = useCallback(() => {
    if (login)
      void api(`/accounts/${login}/login/cancel`, "POST")
        .then(reload)
        .catch(() => {});
    close();
  }, [login, close, reload]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [dismiss]);
  useEffect(
    () => () => {
      if (login)
        void api(`/accounts/${login}/login/cancel`, "POST").catch(() => {});
    },
    [login],
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (oauth) {
        const result = await api<{ id: string }>(
          account ? `/accounts/${account.id}/login` : "/accounts/login",
          "POST",
          account ? undefined : { provider, name: name.trim() },
        );
        setLogin(result.id);
        await reload();
      } else {
        if (!key.trim()) throw new Error("API key 不能为空");
        await api("/accounts", "POST", {
          provider,
          name: name.trim(),
          key: key.trim(),
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
        aria-label={account ? `重新登录 ${account.name}` : "添加账号"}
        className="w-full max-w-[480px] rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-base font-medium">
            {account
              ? account.name
              : login
                ? name.trim() || provider
                : "添加账号"}
          </h2>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </div>
        {login ? (
          <div className="mt-5">
            <LoginFlow id={login} finished={reload} close={dismiss} />
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="mt-5 space-y-4"
          >
            {account ? (
              <p className="m-0 text-xs text-muted">
                {account.provider} · 原有分配保留
              </p>
            ) : (
              <label className="block text-xs text-muted">
                Provider
                <select
                  className={`${inputStyle} mt-1.5`}
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  {providers.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                  <option value="other">其他 API key</option>
                </select>
              </label>
            )}
            {choice === "other" && !account && (
              <input
                className={inputStyle}
                aria-label="Provider 名称"
                required
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="Provider 名称"
              />
            )}
            {!account && (
              <label className="block text-xs text-muted">
                名称
                <input
                  className={`${inputStyle} mt-1.5`}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：工作账号"
                />
              </label>
            )}
            {!oauth && (
              <label className="block text-xs text-muted">
                API key
                <input
                  className={`${inputStyle} mt-1.5`}
                  type="password"
                  autoComplete="off"
                  required
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="粘贴后保存，不会回显"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-xs text-[#9a5b4b]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="button secondary"
                type="button"
                onClick={dismiss}
              >
                取消
              </button>
              <button className="button" type="submit" disabled={busy}>
                {busy ? "提交中…" : oauth ? "开始登录" : "保存账号"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>,
    document.body,
  );
}
