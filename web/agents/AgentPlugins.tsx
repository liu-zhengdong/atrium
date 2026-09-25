import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, RotateCw, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { blockImeSubmit } from "../keys.ts";

type Plugin = {
  source: string;
  name: string;
  kind: "npm" | "git" | "local" | "bundled";
  version: string | null;
  enabled: boolean;
};
type List = { mode: "own"; packages: Plugin[] };
type Action = "add" | "remove" | "update" | "enable" | "disable" | "update-all";
const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function AgentPlugins({
  agentId,
  available,
  refresh,
}: {
  agentId: string;
  available: boolean;
  refresh: () => void;
}) {
  const [list, setList] = useState<List | null>(null);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [removeSource, setRemoveSource] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    setList(null);
    setRemoveSource(null);
    setChanged(false);
    setError("");
    api<List>(`/agents/${agentId}/plugins`)
      .then((value) => {
        if (active) setList(value);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function act(action: Action, value?: string) {
    setBusy(`${action}:${value ?? ""}`);
    setError("");
    try {
      const next = await api<List>(`/agents/${agentId}/plugins`, "POST", {
        action,
        spec: value,
      });
      setList(next);
      setChanged(true);
      if (action === "add") setSpec("");
      if (action === "remove") setRemoveSource(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  }
  async function restart() {
    setBusy("restart");
    setError("");
    try {
      await api(`/agents/${agentId}/stop`, "POST");
      await api(`/agents/${agentId}/start`, "POST");
      setChanged(false);
      refresh();
    } catch (reason) {
      setError(errorMessage(reason));
      refresh();
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="settings-section" aria-label="插件">
      <div className="flex items-center justify-between gap-2">
        <h3>插件</h3>
        {list && (
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void act("update-all")}
          >
            全部更新
          </button>
        )}
      </div>
      {!list && !error && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <LoaderCircle size={14} className="spin" />
          加载插件…
        </p>
      )}
      {list && (
        <>
          <p className="text-xs text-muted">
            插件会运行代码，安装前请确认来源。
          </p>
          <form
            onKeyDown={blockImeSubmit}
            className="flex flex-wrap gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void act("add", spec.trim());
            }}
          >
            <input
              className="field min-w-[160px] flex-1"
              required
              value={spec}
              onChange={(event) => setSpec(event.target.value)}
              placeholder="npm:包名、git:地址或绝对路径"
              aria-label="插件来源"
            />
            <button className="button" disabled={!!busy}>
              <Plus size={14} />
              添加
            </button>
          </form>
        </>
      )}
      {list && list.packages.length > 8 && (
        <input
          className="field mb-2"
          placeholder="筛选插件"
          aria-label="筛选插件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {list &&
        (list.packages.length ? (
          <ul className="list-none space-y-1 p-0">
            {list.packages
              .filter((item) =>
                `${item.name} ${item.source}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((item) => (
                <li
                  key={item.source}
                  className="rounded-xl bg-white p-3 shadow-lift"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-xs font-medium text-ink"
                        title={item.name}
                      >
                        {item.name}{" "}
                        {item.version && (
                          <span className="font-normal text-muted">
                            {item.version}
                          </span>
                        )}
                      </div>
                      <div
                        className="mt-1 truncate text-[11px] text-muted"
                        title={item.source}
                      >
                        {item.kind === "local"
                          ? "本地路径"
                          : item.kind === "bundled"
                            ? "应用内置"
                            : item.kind === "npm"
                              ? ""
                              : item.kind}
                        {item.kind === "npm" ? "" : " · "}
                        {item.kind === "bundled"
                          ? "随 Atrium 更新"
                          : item.source}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <label
                        className="switch-row !m-0 !p-0"
                        title={
                          item.kind === "bundled"
                            ? "应用内置，不可修改"
                            : `切换 ${item.name}`
                        }
                      >
                        <input
                          type="checkbox"
                          role="switch"
                          className="disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`启用 ${item.name}`}
                          checked={item.enabled}
                          disabled={!!busy || item.kind === "bundled"}
                          onChange={() =>
                            void act(
                              item.enabled ? "disable" : "enable",
                              item.source,
                            )
                          }
                        />
                      </label>
                      {item.kind !== "bundled" && (
                        <>
                          {item.kind !== "local" && (
                            <button
                              type="button"
                              className="icon-button disabled:opacity-50"
                              aria-label={`更新 ${item.name}`}
                              title={`更新 ${item.name}`}
                              disabled={!!busy}
                              onClick={() => void act("update", item.source)}
                            >
                              <RotateCw size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-button disabled:opacity-50"
                            aria-label={`移除 ${item.name}`}
                            title={`移除 ${item.name}`}
                            disabled={!!busy}
                            onClick={() => setRemoveSource(item.source)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {removeSource === item.source && (
                    <div
                      role="dialog"
                      aria-label={`确认移除 ${item.name}`}
                      className="mt-3 rounded-xl bg-soft p-3 text-xs"
                    >
                      <p className="m-0">
                        移除「{item.name}」？运行中的 Agent 需重启后生效。
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          className="button"
                          disabled={!!busy}
                          onClick={() => void act("remove", item.source)}
                        >
                          确认移除
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() => setRemoveSource(null)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">没有安装插件</p>
        ))}
      {busy && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted">
          <LoaderCircle size={14} className="spin" />
          {busy === "restart" ? "重启中…" : "正在处理插件…"}
        </p>
      )}
      {error && (
        <p role="alert" className="error break-all">
          {error}
        </p>
      )}
      {changed && (
        <div className="rounded-xl bg-[#f2f6f2] p-3 text-xs text-muted">
          {available ? (
            <>
              运行中的 Agent 需重启后生效。{" "}
              <button
                type="button"
                className="inline-flex items-center gap-1 text-accent-strong disabled:opacity-50"
                disabled={!!busy}
                onClick={() => void restart()}
              >
                <RotateCw size={13} />
                重启
              </button>
            </>
          ) : (
            "下次启动生效。"
          )}
        </div>
      )}
    </section>
  );
}
