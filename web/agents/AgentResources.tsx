import { useEffect, useState } from "react";
import { api } from "../api.ts";

type Skill = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
};
type Mcp = {
  text: string;
  builtin: string;
  servers: { name: string; address: string }[];
};
type Rule = { name: string; text: string };
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AgentSkills({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Skill[] | null>(null);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Skill[]>(`/agents/${agentId}/skills`)
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function change(
    action: "enable" | "disable" | "remove" | "copy",
    key: string,
  ) {
    setBusy(true);
    setError("");
    try {
      setItems(
        await api<Skill[]>(`/agents/${agentId}/skills`, "POST", {
          action,
          name: key,
        }),
      );
      setConfirm(null);
      setName("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="技能">
      <h3>技能</h3>
      <p className="text-xs text-muted">
        修改后重启生效；Agent 也可以修改自己的技能。
      </p>
      {items === null && !error && (
        <p className="text-xs text-muted">读取中…</p>
      )}
      {items?.length === 0 && <p className="text-xs text-muted">没有技能</p>}
      <ul className="max-h-[340px] list-none space-y-2 overflow-y-auto p-0">
        {items?.map((item) => (
          <li key={item.key} className="rounded-xl bg-white p-3 shadow-lift">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <strong className="break-all text-xs font-medium">
                  {item.name}
                </strong>
                <p className="mt-1 break-words text-xs text-muted">
                  {item.description}
                </p>
              </div>
              <label
                className="switch-row !m-0 !p-0"
                title={item.enabled ? "停用" : "启用"}
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`启用 ${item.name}`}
                  checked={item.enabled}
                  disabled={busy}
                  onChange={() =>
                    void change(item.enabled ? "disable" : "enable", item.key)
                  }
                />
              </label>
            </div>
            {confirm === item.key ? (
              <div className="mt-2 text-xs">
                删除「{item.name}」？原文件会备份。
                <div className="mt-2 flex gap-2">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void change("remove", item.key)}
                  >
                    确认删除
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setConfirm(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="mt-2 text-xs text-muted hover:text-ink"
                disabled={busy}
                onClick={() => setConfirm(item.key)}
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void change("copy", name.trim());
        }}
      >
        <input
          className="field min-w-0 flex-1"
          aria-label="个人模板技能目录名"
          placeholder="个人 Pi 技能目录名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="button secondary" disabled={busy}>
          复制
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

export function AgentMcp({ agentId }: { agentId: string }) {
  const [value, setValue] = useState<Mcp | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<Mcp>(`/agents/${agentId}/mcp`)
      .then((next) => {
        if (active) {
          setValue(next);
          setText(next.text);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await api<Mcp>(`/agents/${agentId}/mcp`, "PUT", { text });
      setValue(next);
      setText(next.text);
      setSaved(true);
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="MCP">
      <div className="flex items-center justify-between">
        <h3>MCP</h3>
        {value && !editing && (
          <button className="button secondary" onClick={() => setEditing(true)}>
            编辑 JSON
          </button>
        )}
      </div>
      {!value && !error && <p className="text-xs text-muted">读取中…</p>}
      {value && (
        <>
          <div className="rounded-lg bg-soft p-2 text-xs">
            {value.builtin} · 内置
          </div>
          {value.servers.map((server) => (
            <div
              key={server.name}
              className="mt-2 min-w-0 rounded-lg bg-white p-2 text-xs shadow-lift"
            >
              <strong>{server.name}</strong>
              <p className="mt-1 break-all text-muted">{server.address}</p>
            </div>
          ))}
          {!value.servers.length && (
            <p className="text-xs text-muted">没有自定义服务</p>
          )}
        </>
      )}
      {editing && (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            凭据显示为 ********，保存时保留原值；重启后生效。
          </p>
          <textarea
            className="field h-56 w-full resize-none overflow-auto font-mono text-xs"
            aria-label="MCP JSON"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="button"
              disabled={busy}
              onClick={() => void save()}
            >
              保存
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setEditing(false);
                setText(value?.text ?? "");
                setError("");
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {saved && (
        <p role="status" className="text-xs text-muted">
          已保存，重启后生效
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

export function AgentRules({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Rule[] | null>(null);
  const [selected, setSelected] = useState("AGENTS.md");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<Rule[]>(`/agents/${agentId}/rules`)
      .then((next) => {
        if (active) {
          setItems(next);
          setSelected(next[0]?.name ?? "AGENTS.md");
          setText(next[0]?.text ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setItems(
        await api<Rule[]>(`/agents/${agentId}/rules`, "PUT", {
          name: selected,
          text,
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="规则文件">
      <h3>规则文件</h3>
      {!items && !error && <p className="text-xs text-muted">读取中…</p>}
      {items && (
        <>
          <div className="flex flex-wrap gap-2">
            {items.map((item) => (
              <button
                key={item.name}
                className={`rounded-md px-2 py-1 text-xs ${selected === item.name ? "bg-soft text-ink" : "text-muted hover:bg-soft"}`}
                onClick={() => {
                  setSelected(item.name);
                  setText(item.text);
                  setError("");
                  setSaved(false);
                }}
                type="button"
              >
                {item.name}
              </button>
            ))}
          </div>
          <textarea
            className="field h-56 w-full resize-none overflow-auto font-mono text-xs"
            aria-label={selected}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">
              {[...text].length} 字 · 重启后生效
            </span>
            <button
              className="button"
              disabled={
                busy ||
                text === items.find((item) => item.name === selected)?.text
              }
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </>
      )}
      {saved && (
        <p role="status" className="text-xs text-muted">
          已保存
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
