import { useState, type FormEvent } from "react";
import { api, messageOf } from "../api.ts";
import type { Account } from "./types.ts";
import type { CustomConfig } from "../../server/custom-providers.ts";

export function CustomAccountForm({
  account,
  initial,
  onCreated,
  onSaved,
}: {
  account?: Account;
  initial?: CustomConfig;
  onCreated: (provider: string, name: string, id: string) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(account?.provider ?? "");
  const [url, setUrl] = useState(initial?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(
    initial?.models.map((item) => item.id).join(", ") ?? "",
  );
  const [reasoning, setReasoning] = useState(
    initial?.models[0]?.reasoning ?? false,
  );
  const [contextWindow, setContextWindow] = useState(
    initial?.models[0]?.contextWindow ?? 128000,
  );
  const [developerRole, setDeveloperRole] = useState(
    initial?.supportsDeveloperRole ?? false,
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    initial?.supportsReasoningEffort ?? false,
  );
  const [models, setModels] = useState<string[]>([]);
  const [modelMode, setModelMode] = useState<"manual" | "list">("manual");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const config = (): CustomConfig => ({
    baseUrl: url.trim(),
    models: (model || "placeholder")
      .split(",")
      .map((id) => ({
        id: id.trim(),
        reasoning,
        contextWindow: Number(contextWindow),
      }))
      .filter((item) => item.id),
    supportsDeveloperRole: developerRole,
    supportsReasoningEffort: reasoningEffort,
  });
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await api<{ models: string[] }>(
        "/custom/models",
        "POST",
        { config: config(), key },
      );
      setModels(response.models);
      setModelMode(response.models.length ? "list" : "manual");
      if (!response.models.length) setError("未发现模型，请手填模型 ID");
    } catch (e) {
      setModelMode("manual");
      setError(`${messageOf(e)}；仍可手填模型 ID`);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!model.trim()) throw new Error("请选择或填写模型 ID");
      if (account) {
        await api(`/accounts/${account.id}/key`, "PUT", {
          key,
          custom: config(),
        });
        await onSaved();
      } else {
        const response = await api<{ id: string }>("/accounts", "POST", {
          provider: provider.trim(),
          name: provider.trim(),
          key,
          custom: config(),
        });
        await onCreated(provider.trim(), provider.trim(), response.id);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mt-5 max-h-[75vh] space-y-3 overflow-y-auto text-xs text-muted"
    >
      <label className="block">
        名称（供应商 ID）
        <input
          className="field mt-1"
          required
          disabled={!!account}
          pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
      </label>
      <label className="block">
        Base URL
        <input
          className="field mt-1"
          required
          type="url"
          placeholder="https://example.com/v1"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setModels([]);
            setModelMode("manual");
          }}
        />
      </label>
      <label className="block">
        API Key（本地服务可留空）
        <input
          className="field mt-1"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setModels([]);
            setModelMode("manual");
          }}
        />
      </label>
      <div className="flex gap-2">
        <button
          className="button secondary"
          type="button"
          disabled={busy || !url}
          onClick={() => void load()}
        >
          获取模型列表
        </button>
      </div>
      {models.length > 0 && modelMode === "list" ? (
        <div>
          <div className="flex items-center justify-between">
            <span>选择模型</span>
            <button
              type="button"
              className="text-accent-strong hover:underline"
              onClick={() => setModelMode("manual")}
            >
              手动填写
            </button>
          </div>
          <div className="mt-1 max-h-28 space-y-1 overflow-auto">
            {models.map((id) => (
              <label key={id} className="flex gap-2">
                <input
                  type="checkbox"
                  checked={model
                    .split(",")
                    .map((s) => s.trim())
                    .includes(id)}
                  onChange={(e) =>
                    setModel((current) => {
                      const selected = current
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      return (
                        e.target.checked
                          ? [...new Set([...selected, id])]
                          : selected.filter((s) => s !== id)
                      ).join(", ");
                    })
                  }
                />
                {id}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="custom-model-id">模型 ID（多个用逗号分开）</label>
            {models.length > 0 && (
              <button
                type="button"
                className="text-accent-strong hover:underline"
                onClick={() => setModelMode("list")}
              >
                从列表选择
              </button>
            )}
          </div>
          <input
            id="custom-model-id"
            className="field mt-1"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      )}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3 transition-transform group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m6 3 5 5-5 5" />
          </svg>
          高级选项
        </summary>
        <div className="mt-2 space-y-2">
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={developerRole}
              onChange={(e) => setDeveloperRole(e.target.checked)}
            />
            支持 developer role
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.checked)}
            />
            支持 reasoning effort
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
            />
            模型支持 reasoning
          </label>
          <label className="block">
            上下文长度
            <input
              className="field mt-1"
              type="number"
              min="1024"
              value={contextWindow}
              onChange={(e) => setContextWindow(Number(e.target.value))}
            />
          </label>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-[#9a5b4b]">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button className="button" disabled={busy}>
          {busy ? "正在校验…" : account ? "保存修改" : "添加账号"}
        </button>
      </div>
    </form>
  );
}
