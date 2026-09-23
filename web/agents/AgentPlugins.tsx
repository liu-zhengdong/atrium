import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, RotateCw } from "lucide-react";
import { api } from "../api.ts";

type Plugin = {
  source: string;
  name: string;
  kind: "npm" | "git" | "local" | "bundled";
  version: string | null;
  enabled: boolean;
};
type List = { mode: "shared" | "own"; packages: Plugin[] };
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
  const [confirm, setConfirm] = useState<"own" | "shared" | null>(null);
  useEffect(() => {
    let active = true;
    setList(null);
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
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  }
  async function mode(value: "own" | "shared") {
    setConfirm(null);
    setBusy("mode");
    setError("");
    try {
      setList(
        await api<List>(`/agents/${agentId}/plugins/mode`, "PUT", {
          mode: value,
        }),
      );
      setChanged(true);
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
        {list?.mode === "own" && (
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
      {list?.mode === "shared" && (
        <div className="rounded-xl bg-[#f2f6f2] p-3 text-xs text-muted">
          <p>当前使用个人 Pi 的安装，个人更新也会影响此 Agent。</p>
          {confirm === "own" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>复制当前插件到此身份；运行中的 Agent 需要重启。</span>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => void mode("own")}
              >
                确认转换
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button secondary mt-2"
              disabled={!!busy}
              onClick={() => setConfirm("own")}
            >
              转为独立安装
            </button>
          )}
        </div>
      )}
      {list?.mode === "own" && (
        <>
          <p className="text-xs text-muted">
            仅此身份使用；插件会运行代码，安装前请确认来源。
          </p>
          <form
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
      {list &&
        (list.packages.length ? (
          <ul className="list-none space-y-1 p-0">
            {list.packages.map((item) => (
              <li
                key={item.source}
                className="rounded-xl bg-white p-3 shadow-lift"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-all text-xs font-medium text-ink">
                      {item.name}{" "}
                      {item.version && (
                        <span className="font-normal text-muted">
                          {item.version}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 break-all text-[11px] text-muted">
                      {item.kind === "local"
                        ? "本地路径"
                        : item.kind === "bundled"
                          ? "应用内置"
                          : item.kind}{" "}
                      · {item.kind === "bundled" ? "随中庭更新" : item.source}
                    </div>
                  </div>
                  <span className="text-[11px] text-muted">
                    {item.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                {list.mode === "own" && item.kind !== "bundled" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="text-xs text-accent-strong disabled:opacity-50"
                      disabled={!!busy}
                      onClick={() =>
                        void act(
                          item.enabled ? "disable" : "enable",
                          item.source,
                        )
                      }
                    >
                      {item.enabled ? "停用" : "启用"}
                    </button>
                    {item.kind !== "local" && (
                      <button
                        type="button"
                        className="text-xs text-accent-strong disabled:opacity-50"
                        disabled={!!busy}
                        onClick={() => void act("update", item.source)}
                      >
                        更新
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-xs text-muted disabled:opacity-50"
                      disabled={!!busy}
                      onClick={() => void act("remove", item.source)}
                    >
                      移除
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">没有安装插件</p>
        ))}
      {list?.mode === "own" &&
        (confirm === "shared" ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>切回创建前的共享列表；独立安装文件保留。</span>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void mode("shared")}
            >
              确认切回
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-muted underline"
            disabled={!!busy}
            onClick={() => setConfirm("shared")}
          >
            切回共享
          </button>
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
