import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { reportsToOf } from "./reports-to.ts";

/**
 * 向谁汇报（#181）：默认发给用户，也可以选名册里的其他身份。
 * 筛选框按名字和短号找，身份多时也不用翻长列表；选中即保存，失败报错。
 */
export function ReportsToPicker({
  agent,
  agents,
  changed,
}: {
  agent: Agent;
  agents: Agent[];
  changed: () => void;
}) {
  const selected = reportsToOf(agent)?.ref ?? "";
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = useMemo(
    () =>
      agents
        .filter((item) => item.id !== agent.id)
        .filter((item) =>
          `${item.name} ${item.ref}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [agents, agent.id, query],
  );
  async function save(ref: string) {
    if (ref === selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/reports-to`, "PATCH", {
        reports_to: ref || null,
      });
      changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const rows = [
    { key: "", label: "用户（默认）" },
    ...options.map((item) => ({
      key: item.ref,
      label: `${item.name}（${item.ref}）`,
    })),
  ];
  return (
    <div className="space-y-3">
      <input
        className="field !border-transparent !bg-[#f1f5f2] focus:!border-[#b9c9bd] focus:!bg-white focus:!shadow-none"
        aria-label="筛选身份"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="查找身份"
      />
      <div className="max-h-48 space-y-0.5 overflow-auto">
        {rows.map(({ key, label }) => (
          <button
            key={key || "default"}
            aria-pressed={key === selected}
            disabled={busy}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-soft ${
              key === selected ? "text-accent-strong" : "text-ink"
            }`}
            onClick={() => void save(key)}
          >
            <Check
              size={13}
              className={key === selected ? "" : "invisible"}
              aria-hidden
            />
            <span className="min-w-0 truncate">{label}</span>
          </button>
        ))}
        {!rows.length && <p className="text-xs text-muted">没有匹配的身份</p>}
      </div>
      <p className="m-0 text-[11px] text-muted">
        出错与恢复的通知按这里路由；默认发给用户。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
