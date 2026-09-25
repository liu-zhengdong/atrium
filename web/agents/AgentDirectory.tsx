import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import {
  Avatar,
  agentPresence,
  statusNote,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { failureSummary } from "../components/failure-summary.ts";
import { modelLabel, type ModelOption } from "../../shared/model.ts";
import { api } from "../api.ts";

export function AgentDirectory({
  overview,
  opening,
  openAgent,
  details,
  create,
}: {
  overview: Overview;
  opening: string | null;
  openAgent: (a: Agent) => void;
  details: (id: string) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let active = true;
    void api<ModelOption[]>("/models")
      .then((items) => {
        if (active) setModels(items);
      })
      .catch(() => {
        /* 无目录时显示原始 id。 */
      });
    return () => {
      active = false;
    };
  }, []);
  const [filter, setFilter] = useState<"all" | "busy" | "error" | "unread">(
    "all",
  );
  const agents = useMemo(
    () =>
      overview.agents
        .filter((a) =>
          `${a.name} ${a.ref} ${a.cwd}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        .filter(
          (a) =>
            filter === "all" ||
            (filter === "busy" && !!a.runtime?.busy) ||
            (filter === "error" && !!a.failure) ||
            (filter === "unread" && a.unread > 0),
        )
        .sort(
          (a, b) =>
            Number(!!b.failure) - Number(!!a.failure) ||
            Number(!!b.runtime?.busy) - Number(!!a.runtime?.busy) ||
            a.name.localeCompare(b.name, "zh-CN"),
        ),
    [overview.agents, query, filter],
  );
  return (
    <section className="min-h-0 flex-1 overflow-auto bg-white px-8 py-6 max-[560px]:px-4 max-[560px]:py-4">
      <header className="mb-5 flex flex-wrap items-center gap-3 max-[560px]:pl-8">
        <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-lg bg-soft px-3 text-muted max-[560px]:w-full">
          <Search size={15} />
          <input
            className="plain-field min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none"
            aria-label="搜索 Agent"
            placeholder="搜索 Agent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="button primary h-8" onClick={create}>
          <Plus size={15} />
          新建 Agent
        </button>
      </header>
      <div className="mb-4 flex flex-wrap gap-1.5" aria-label="筛选 Agent">
        {(
          [
            ["all", "全部"],
            ["busy", "工作中"],
            ["error", "出错"],
            ["unread", "有未读"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            className={`rounded-full px-3 py-1.5 text-xs ${filter === value ? "bg-[#e2ebe4] text-accent-strong" : "bg-soft text-muted hover:text-ink"}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {overview.discovery.error && (
        <p role="alert" className="error">
          {overview.discovery.error}
        </p>
      )}
      {agents.length ? (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[30px_minmax(90px,1fr)_minmax(100px,1.3fr)_minmax(80px,0.8fr)_36px_48px] gap-3 px-2.5 pb-2 text-[11px] text-muted max-[700px]:hidden">
            <span />
            <span>Agent</span>
            <span>在做什么</span>
            <span>模型</span>
            <span />
            <span />
          </div>
          {agents.map((a) => (
            <div
              key={a.id}
              className="group grid min-h-[36px] grid-cols-[30px_minmax(90px,1fr)_minmax(100px,1.3fr)_minmax(80px,0.8fr)_36px_48px] items-center gap-3 rounded-lg px-2.5 hover:bg-soft max-[700px]:min-h-[52px] max-[700px]:grid-cols-[30px_minmax(0,1fr)_36px_48px]"
            >
              <button
                aria-label={`查看 ${a.name} 详情`}
                className="shrink-0"
                onClick={() => details(a.id)}
              >
                <Avatar name={a.name} presence={agentPresence(a)} small />
              </button>
              <button
                className="col-span-3 grid min-w-0 grid-cols-subgrid items-center text-left text-xs max-[700px]:col-span-1 max-[700px]:flex max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-0.5"
                disabled={!!opening}
                onClick={() => openAgent(a)}
                aria-label={`与 ${a.name} 聊天`}
              >
                <strong className="min-w-0 max-w-full truncate font-medium text-ink">
                  {a.name}
                </strong>
                <span
                  className={`min-w-0 truncate max-w-full max-[700px]:empty:hidden ${a.unassigned || a.failure ? "text-[#9c3f2d]" : "text-muted"}`}
                  title={
                    a.unassigned
                      ? "未分配账号"
                      : statusNote(a) ||
                        (a.failure ? failureSummary(a.failure.text) : a.work)
                  }
                >
                  {a.unassigned
                    ? "未分配账号"
                    : statusNote(a) ||
                      (a.failure ? failureSummary(a.failure.text) : a.work)}
                </span>
                <span className="truncate text-muted max-[700px]:hidden">
                  {a.runtime?.model && a.runtime.model !== "unknown/unknown"
                    ? modelLabel(a.runtime.model, models)
                    : ""}
                </span>
              </button>
              <span className="text-right">
                {a.unread > 0 && (
                  <span className="badge" aria-label={`${a.unread} 条未读`}>
                    {a.unread}
                  </span>
                )}
              </span>
              <button
                className="w-12 text-xs text-muted hover:text-accent-strong"
                onClick={() => details(a.id)}
              >
                详情
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid justify-items-center gap-3 py-16 text-center text-xs text-muted">
          <Users size={25} />
          <p>{overview.agents.length ? "没有匹配的 Agent" : "还没有 Agent"}</p>
          {!overview.agents.length && (
            <button className="button" onClick={create}>
              新建 Agent
            </button>
          )}
        </div>
      )}
    </section>
  );
}
