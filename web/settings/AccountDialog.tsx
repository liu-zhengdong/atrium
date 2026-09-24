import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ChevronLeft, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api, messageOf } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import {
  accountLabel,
  assignedAccountLabel,
  assignmentFailure,
  assignmentSummary,
  currentAssignment,
  defaultAccountName,
  type ProviderEntry,
  type ProviderMethod,
} from "../../shared/providers.ts";
import type { Account } from "./types.ts";
import { LoginFlow } from "./LoginFlow.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { AgentAssignment } from "./AgentAssignment.tsx";
import { CustomAccountForm } from "./CustomAccountForm.tsx";
import type { CustomConfig } from "../../server/custom-providers.ts";

const inputStyle =
  "field !border-transparent !bg-[#f1f5f2] focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none";
type Step =
  | "method"
  | "provider"
  | "auth"
  | "name"
  | "login"
  | "assign"
  | "custom"
  | "local";

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
  const dismissed = useRef(false);
  const [created, setCreated] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [completed, setCompleted] = useState<string[]>([]);
  const [result, setResult] = useState("");
  const [failed, setFailed] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [replaced, setReplaced] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [checkingFailed, setCheckingFailed] = useState("");
  const [custom, setCustom] = useState<CustomConfig | null>(null);
  useEffect(() => {
    if (account?.type === "api_key")
      void api<CustomConfig | null>(
        `/custom/${encodeURIComponent(account.provider)}`,
      )
        .then((config) => {
          if (config) {
            setCustom(config);
            setStep("custom");
          }
        })
        .catch(() => {});
  }, [account]);
  const [error, setError] = useState("");
  const loadProviders = useCallback(async () => {
    setError("");
    try {
      setProviders(await api<ProviderEntry[]>("/providers"));
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    if (!account) void loadProviders();
  }, [account, loadProviders]);
  const dismiss = useCallback(() => {
    dismissed.current = true;
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
  const back = () => {
    setError("");
    setStep(
      step === "provider" || step === "custom" || step === "local"
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
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (step === "assign" && result && !failed) {
      close();
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (step === "local") {
        const result = await api<{ id: string }>("/accounts/local", "POST", {
          provider: "claude-bridge",
        });
        setCreated(result.id);
        setStep("assign");
        await reload();
      } else if (
        (step === "auth" && !account) ||
        (step === "name" && provider)
      ) {
        if (!provider) throw new Error("请先选择供应商");
        if (method === "api_key" && !key.trim())
          throw new Error("API Key 不能为空");
        const accountName =
          name.trim() || defaultAccountName(provider, accounts);
        const result =
          method === "oauth"
            ? await api<{ id: string }>("/accounts/login", "POST", {
                provider: provider.id,
                name: accountName,
              })
            : await api<{
                id: string | null;
                validation: { status: string; reason?: string };
              }>("/accounts", "POST", {
                provider: provider.id,
                name: accountName,
                key: key.trim(),
                ...(checkingFailed ? { allowUnverified: true } : {}),
              });
        if (!result.id) {
          setCheckingFailed(
            "validation" in result
              ? (result.validation.reason ?? "没能校验")
              : "没能校验",
          );
          return;
        }
        if (method === "oauth") {
          if (dismissed.current) {
            await api(`/accounts/${result.id}/login/cancel`, "POST");
            await reload();
            return;
          }
          activeLogin.current = result.id;
          setLogin(result.id);
          setStep("login");
        } else {
          setCreated(result.id);
          setStep("assign");
          await reload();
        }
      } else if (step === "auth" && account && account.type === "api_key") {
        if (!key.trim()) throw new Error("API Key 不能为空");
        const result = await api<{
          updated: boolean;
          validation: { reason?: string };
        }>(`/accounts/${account.id}/key`, "PUT", {
          key: key.trim(),
          ...(checkingFailed ? { allowUnverified: true } : {}),
        });
        if (!result.updated) {
          setCheckingFailed(result.validation.reason ?? "没能校验");
          return;
        }
        await reload();
        close();
      } else if (step === "auth" && account) {
        const result = await api<{ id: string }>(
          `/accounts/${account.id}/login`,
          "POST",
        );
        if (dismissed.current) {
          await api(`/accounts/${result.id}/login/cancel`, "POST");
          await reload();
          return;
        }
        activeLogin.current = result.id;
        setLogin(result.id);
        setStep("login");
        await reload();
      } else if (step === "assign" && created && provider) {
        const newAdded = [...added],
          newReplaced = [...replaced];
        const failures: string[] = [];
        const done = [...completed];
        for (const id of selected.filter((id) => !completed.includes(id))) {
          const agent = agents.find((item) => item.id === id)!;
          const previous = currentAssignment(agent.ref, provider.id, accounts);
          try {
            await api(`/assign/${encodeURIComponent(id)}`, "POST", {
              account: created,
              ...(previous ? { replace: true } : {}),
            });
            done.push(id);
            if (previous)
              newReplaced.push(
                `${agent.name}（${agent.ref}）：${assignedAccountLabel(agent.ref, provider.id, accounts)} → ${name}（${created}）`,
              );
            else newAdded.push(`${agent.name}（${agent.ref}）`);
          } catch (e) {
            failures.push(assignmentFailure(agent, e, provider, accounts));
          }
        }
        setCompleted(done);
        setAdded(newAdded);
        setReplaced(newReplaced);
        setFailed(failures.length > 0);
        setResult(
          assignmentSummary(newAdded, newReplaced, failures) ||
            "未分配；可以稍后分配",
        );
        await reload();
      }
    } catch (e) {
      setError(messageOf(e));
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
            {!account &&
              ["provider", "auth", "name", "custom", "local"].includes(
                step,
              ) && (
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
        {provider && ["auth", "name", "login"].includes(step) && (
          <p className="mb-0 mt-2 text-xs text-muted">
            {provider.name} · {method === "oauth" ? "账号登录" : "API Key"}
          </p>
        )}
        {account && step === "login" && (
          <p className="mb-0 mt-2 text-xs text-muted">
            {account.provider} · 账号登录
          </p>
        )}
        {step === "method" && (
          <div className="mt-5 space-y-2">
            <p className="m-0 pb-1 text-xs text-muted">选择连接方式</p>
            {(["oauth", "api_key"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className="w-full rounded-xl bg-[#f3f6f3] px-4 py-3 text-left hover:bg-[#e9f0ea]"
                onClick={() => {
                  setMethod(item);
                  setStep("provider");
                }}
              >
                <span className="block text-sm">
                  {item === "oauth" ? "账号登录" : "API Key"}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {item === "oauth"
                    ? "用已有订阅在浏览器登录，如 ChatGPT、Claude、Copilot"
                    : "粘贴供应商后台生成的密钥"}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="w-full rounded-xl bg-[#f3f6f3] px-4 py-3 text-left hover:bg-[#e9f0ea]"
              onClick={() => {
                setMethod("local");
                setProvider({
                  id: "claude-bridge",
                  name: "Claude Code（本机登录）",
                  methods: ["local"],
                  packagePath: null,
                });
                setName("Claude Code（本机登录）");
                setStep("local");
              }}
            >
              <span className="block text-sm">Claude Code（本机登录）</span>
              <span className="mt-1 block text-xs text-muted">
                使用这台电脑已登录的 Claude CLI，不保存密钥
              </span>
            </button>
            <button
              type="button"
              className="w-full rounded-xl bg-[#f3f6f3] px-4 py-3 text-left text-sm hover:bg-[#e9f0ea]"
              onClick={() => setStep("custom")}
            >
              自定义（OpenAI 兼容）
            </button>
          </div>
        )}
        {step === "local" && (
          <div className="mt-5 space-y-4">
            <p className="m-0 text-sm">
              将使用这台电脑的 Claude CLI 登录。登录由 Claude CLI 管理，Atrium
              不保存凭据。
            </p>
            <p className="m-0 text-xs text-muted">
              添加时仅检查 Claude CLI
              版本，不读取登录信息；运行模型前需自行登录。
            </p>
            {error && (
              <p role="alert" className="text-xs text-[#9a5b4b]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="button secondary" onClick={back}>
                返回
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "正在检查…" : "添加本机登录"}
              </button>
            </div>
          </div>
        )}
        {step === "custom" && (
          <CustomAccountForm
            key={account?.id ?? "new"}
            account={account}
            initial={custom ?? undefined}
            onSaved={async () => {
              await reload();
              close();
            }}
            onCreated={async (id, label, ref) => {
              setProvider({
                id,
                name: id,
                methods: ["api_key"],
                packagePath: null,
              });
              setName(label);
              setCreated(ref);
              setStep("assign");
              await reload();
            }}
          />
        )}
        {step === "provider" && (
          <ProviderPicker
            method={method}
            providers={providers}
            search={search}
            setSearch={setSearch}
            accounts={accounts}
            error={error}
            retry={() => void loadProviders()}
            changeMethod={(next) => {
              setMethod(next);
              setError("");
            }}
            choose={(item) => {
              setProvider(item);
              setName(defaultAccountName(item, accounts));
              setStep(method === "oauth" ? "name" : "auth");
            }}
          />
        )}
        {(step === "auth" || step === "name" || step === "assign") && (
          <form
            onSubmit={(event) => void submit(event)}
            className="mt-5 space-y-4"
          >
            {step === "auth" && (!account || account.type === "api_key") && (
              <label className="block text-xs text-muted">
                API Key
                <input
                  autoFocus
                  className={`${inputStyle} mt-1.5`}
                  type="password"
                  autoComplete="off"
                  required
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setCheckingFailed("");
                  }}
                />
              </label>
            )}
            {(step === "name" || (step === "auth" && !account)) && (
              <label className="block text-xs text-muted">
                账号名
                <input
                  autoFocus={step === "name"}
                  className={`${inputStyle} mt-1.5`}
                  maxLength={80}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {step === "assign" && (
              <AgentAssignment
                agents={agents}
                selected={selected}
                completed={completed}
                provider={provider!}
                accounts={accounts}
                setSelected={(next) => {
                  setSelected(next);
                  setResult("");
                }}
              />
            )}
            {step === "assign" && provider && created && (
              <p className="text-xs text-muted">
                {accountLabel(provider, name, created)}
                {method === "api_key"
                  ? "已保存"
                  : method === "local"
                    ? "已登记"
                    : "已连接"}
              </p>
            )}
            {result && (
              <p role="status" className="text-xs">
                {result.split("\n").map((line) => (
                  <span
                    key={line}
                    className={`block ${line.startsWith("失败：") ? "text-[#9a5b4b]" : "text-muted"}`}
                  >
                    {line}
                  </span>
                ))}
              </p>
            )}
            {checkingFailed && (
              <p role="alert" className="text-xs text-[#9a5b4b]">
                {checkingFailed}。继续将保存为「未校验」。
              </p>
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
                {step === "assign" ? (result ? "关闭" : "跳过") : "取消"}
              </button>
              <button className="button" type="submit" disabled={busy}>
                {busy
                  ? method === "api_key"
                    ? "正在校验…"
                    : "处理中…"
                  : step === "assign"
                    ? failed
                      ? "重试失败项"
                      : "完成"
                    : step === "auth" && account?.type === "oauth"
                      ? "开始登录"
                      : checkingFailed
                        ? "仍然保存"
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
        {error &&
          !["provider", "auth", "name", "assign", "local"].includes(step) && (
            <p role="alert" className="mt-3 text-xs text-[#9a5b4b]">
              {error}
            </p>
          )}
      </section>
    </div>,
    document.body,
  );
}
