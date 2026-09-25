import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Terminal,
} from "lucide-react";
import type { TraceDetail, TraceItem, TracePage } from "../../shared/trace.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { api } from "../api.ts";
import { Empty } from "../components/Empty.tsx";
import { TraceValue } from "../components/JsonTree.tsx";

export function mergeTrace(old: TraceItem[], incoming: TraceItem[]) {
  const rows = new Map(old.map((item) => [item.id, item]));
  for (const item of incoming) rows.set(item.id, item);
  return [...rows.values()].sort((a, b) => a.id - b.id);
}

const traceTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const lifecycleKinds = new Set(["session", "run_start", "run_end", "delivery"]);
const fileActions = new Set(["read", "edit", "write"]);

/** Keep the filename visible even when the parent path exceeds the row width. */
function fileLabel(item: TraceItem, cwd: string, input?: string) {
  if (item.kind !== "tool" || !fileActions.has(item.name)) return null;
  const divider = item.title.indexOf(" · ");
  if (divider < 0) return null;
  let path = item.title.slice(divider + 3);
  if (path.endsWith("…")) {
    try {
      const args: unknown = JSON.parse(input ?? "");
      if (args && typeof args === "object") {
        const fields = args as Record<string, unknown>;
        path =
          typeof fields.path === "string"
            ? fields.path
            : typeof fields.file_path === "string"
              ? fields.file_path
              : "…";
      } else path = "…";
    } catch {
      path = "…";
    }
  }
  const relative = cwd && path.startsWith(`${cwd.replace(/\/$/, "")}/`);
  const parts = path.split("/");
  const shown = relative
    ? path.slice(cwd.replace(/\/$/, "").length + 1)
    : path.startsWith("/") && parts.length > 3
      ? `…/${parts.slice(-2).join("/")}`
      : path;
  const cut = shown.lastIndexOf("/");
  const action = item.title.slice(0, divider);
  return {
    action,
    parent: shown.slice(0, cut + 1),
    filename: shown.slice(cut + 1),
    full: `${action} · ${path}`,
  };
}

function TraceAction({
  agent,
  item,
  highlight,
}: {
  agent: Agent;
  item: TraceItem;
  highlight: boolean;
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const needsPath =
    item.kind === "tool" &&
    fileActions.has(item.name) &&
    item.title.endsWith("…");
  useEffect(() => {
    if (!open && !needsPath) return;
    let alive = true;
    void api<TraceDetail>(`/agents/${agent.id}/trace/${item.id}`)
      .then((value) => {
        if (alive) {
          setDetail(value);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [open, needsPath, agent.id, item.id, item.ended_at, item.state, retry]);
  const label = fileLabel(item, agent.cwd, detail?.input);
  const active =
    item.state === "running" &&
    agent.runtime?.busy &&
    agent.runtime.generation === item.generation;
  const unknown =
    item.state === "unknown" || (item.state === "running" && !active);
  const lifecycle = lifecycleKinds.has(item.kind);
  const clock = traceTime.format(item.at);
  const hasDetails = !lifecycle || item.has_detail;
  const row = (
    <>
      {lifecycle && <span className="h-px min-w-2 flex-1 bg-black/[0.07]" />}
      {!lifecycle && (
        <span
          className={`grid w-4 flex-none place-items-center ${
            active
              ? "text-accent"
              : item.state === "error"
                ? "text-red-600"
                : "text-muted"
          }`}
          aria-hidden="true"
        >
          {active ? (
            <LoaderCircle size={13} className="spin" />
          ) : item.state === "error" || unknown ? (
            <CircleAlert size={13} />
          ) : item.kind === "tool" ? (
            <Terminal size={13} />
          ) : (
            <Check size={12} />
          )}
        </span>
      )}
      {!lifecycle && (
        <time
          dateTime={new Date(item.at).toISOString()}
          className="w-[59px] flex-none font-mono text-[10px] tabular-nums text-muted"
        >
          {clock}
        </time>
      )}
      <span
        className={`${lifecycle ? "max-w-[55%]" : "min-w-0 flex-1"} flex overflow-hidden group-hover:text-accent ${item.state === "error" ? "text-red-600" : ""}`}
      >
        {label ? (
          <>
            <span className="flex-none">{label.action} ·&nbsp;</span>
            <span className="min-w-0 truncate">{label.parent}</span>
            <span className="max-w-full flex-none truncate">
              {label.filename}
            </span>
          </>
        ) : (
          <span className="truncate">
            {item.title}
            {lifecycle && ` · ${clock}`}
            {unknown && " · 状态未知"}
          </span>
        )}
      </span>
      {lifecycle && <span className="h-px min-w-2 flex-1 bg-black/[0.07]" />}
      {hasDetails && (
        <ChevronRight
          size={12}
          className="flex-none text-[#aaa08f] transition-transform group-open/details:rotate-90"
          aria-hidden="true"
        />
      )}
    </>
  );
  const rowClass = `group flex h-7 min-w-0 items-center gap-2 rounded-md ${
    lifecycle ? "text-[10px] text-muted" : "text-xs text-ink"
  }`;
  if (!hasDetails)
    return (
      <li
        data-trace-id={item.id}
        className={`rounded-lg py-1 ${highlight ? "trace-flash" : ""}`}
      >
        <div className={rowClass}>{row}</div>
      </li>
    );
  return (
    <li
      data-trace-id={item.id}
      className={`${lifecycle ? "py-1" : ""} rounded-lg ${highlight ? "trace-flash" : ""}`}
    >
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group/details"
      >
        <summary
          title={label?.full ?? item.title}
          className={`${rowClass} cursor-pointer list-none hover:bg-[#f4f7f5] focus-visible:outline-2 focus-visible:outline-[#8a7756] [&::-webkit-details-marker]:hidden`}
        >
          {row}
        </summary>
        {open && (
          <div className="mt-2 rounded-lg border border-black/[0.04] bg-[#f4f7f5] px-3 py-2.5 text-xs">
            {error ? (
              <p role="alert" className="error">
                {error}{" "}
                <button onClick={() => setRetry((n) => n + 1)}>重试</button>
              </p>
            ) : !detail ? (
              <p className="muted">加载详情…</p>
            ) : (
              <>
                {detail.input && (
                  <TraceValue label="调用参数" text={detail.input} />
                )}
                {detail.output && (
                  <TraceValue
                    label={item.kind === "tool" ? "执行结果" : "内容"}
                    text={detail.output}
                  />
                )}
                {!detail.input && !detail.output && (
                  <p className="muted">此事件没有附加内容。</p>
                )}
                {detail.truncated && (
                  <p className="muted">内容较长，仅保留前 8,192 个字符。</p>
                )}
                {unknown && (
                  <p className="muted">
                    未观测到完整结束事件，不推断是否成功。
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </details>
    </li>
  );
}

export function AgentTrace({
  agent,
  revision,
  target,
}: {
  agent: Agent;
  revision: number;
  target: { id: number; serial: number } | null;
}) {
  const [items, setItems] = useState<TraceItem[]>([]),
    [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false),
    [paging, setPaging] = useState(false);
  const [error, setError] = useState(""),
    [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0),
    [atLatest, setAtLatest] = useState(true);
  const initial = useRef(true),
    nearBottom = useRef(true),
    alive = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    let timer: number | undefined;
    // The target might predate the currently loaded page. Page backwards in
    // one request instead of walking all intermediate pages.
    void api<TracePage>(`/agents/${agent.id}/trace?before=${target.id + 1}`)
      .then((page) => {
        if (cancelled || !page.items.some((item) => item.id === target.id))
          return;
        nearBottom.current = false;
        setAtLatest(false);
        setItems((old) => mergeTrace(old, page.items));
        setHighlight(target.id);
        timer = window.setTimeout(() => setHighlight(null), 2400);
      })
      .catch(() => {
        /* Trimmed between chat load and click: leave the drawer usable. */
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agent.id, target]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<TracePage>(`/agents/${agent.id}/trace`)
      .then((page) => {
        if (cancelled) return;
        setItems((old) => mergeTrace(old, page.items));
        if (initial.current) {
          setOlder(page.has_more);
          initial.current = false;
        }
        setRuntimeError(page.error);
        setError("");
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, revision, retry]);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    if (highlight && !loading)
      requestAnimationFrame(() => {
        scroll.current
          ?.querySelector(`[data-trace-id="${highlight}"]`)
          ?.scrollIntoView({ block: "center" });
      });
  }, [items, loading, highlight]);
  async function loadOlder() {
    if (paging || !items.length) return;
    setPaging(true);
    const height = scroll.current?.scrollHeight ?? 0,
      top = scroll.current?.scrollTop ?? 0;
    try {
      const page = await api<TracePage>(
        `/agents/${agent.id}/trace?before=${items[0].id}`,
      );
      if (!alive.current) return;
      nearBottom.current = false;
      setAtLatest(false);
      setItems((old) => mergeTrace(old, page.items));
      setOlder(page.has_more);
      setError("");
      requestAnimationFrame(() => {
        if (alive.current && scroll.current)
          scroll.current.scrollTop = top + scroll.current.scrollHeight - height;
      });
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setPaging(false);
    }
  }
  const current = items.findLast(
    (item) =>
      item.state === "running" && item.generation === agent.runtime?.generation,
  );
  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col"
      aria-label="运行轨迹"
    >
      <div
        className="mx-5 mb-3 mt-4 flex items-center gap-3 rounded-xl border border-black/[0.05] bg-[#f2f6f3] px-3.5 py-3 text-ink"
        aria-live="polite"
      >
        {agent.runtime?.busy ? (
          <LoaderCircle size={15} className="spin flex-shrink-0" />
        ) : (
          <Activity size={15} className="flex-shrink-0" />
        )}
        <div className="grid min-w-0 gap-[5px]">
          <span className="text-[10px] text-muted">实际运行</span>
          <strong className="truncate text-xs font-medium">
            {runtimeError
              ? "轨迹暂不可用"
              : agent.runtime?.busy
                ? (current?.title ?? "正在处理")
                : agent.available
                  ? "等待新任务"
                  : "已离线"}
          </strong>
        </div>
      </div>
      {runtimeError && (
        <p
          className="mx-6 mb-3 text-[11px] leading-[1.7] text-[#8a7254]"
          role="status"
        >
          {runtimeError}
        </p>
      )}
      {error && (
        <p className="error mx-6! mb-3! mt-0!" role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>重试</button>
        </p>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-6 pb-6 pt-1"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) {
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 50;
            setAtLatest(nearBottom.current);
          }
        }}
      >
        {loading ? (
          <p className="flex items-center gap-2 px-6 py-4 text-xs text-muted">
            <LoaderCircle size={16} className="spin" />
            加载轨迹…
          </p>
        ) : !items.length ? (
          <Empty icon={<Activity size={25} />} title="还没有运行轨迹">
            <p>连接后记录真实动作。此前未采集的执行过程不会补写。</p>
          </Empty>
        ) : (
          <>
            {older && (
              <button
                className="mx-auto mb-[30px] block rounded-md bg-[#f8f6f0] px-3 py-1.5 text-[11px] text-[#8e816b]"
                disabled={paging}
                onClick={() => void loadOlder()}
              >
                {paging ? "正在加载…" : "查看更早轨迹"}
              </button>
            )}
            <ol className="m-0 list-none p-0 pl-2">
              {items.map((item, index) => (
                <TraceGroup
                  key={item.id}
                  highlight={highlight === item.id}
                  newSession={
                    index > 0 && items[index - 1].generation !== item.generation
                  }
                  agent={agent}
                  item={item}
                />
              ))}
            </ol>
          </>
        )}
      </div>
      {!atLatest && (
        <button
          className="button secondary absolute bottom-[51px] right-[22px] text-[11px] shadow-[0_3px_12px_#44371a12]"
          onClick={() => {
            nearBottom.current = true;
            setAtLatest(true);
            if (scroll.current)
              scroll.current.scrollTop = scroll.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
      <p className="flex-shrink-0 border-t border-black/[0.04] px-6 py-3 text-[10px] text-muted">
        真实运行记录 · 仅供你审阅，不自动共享给同伴
      </p>
    </section>
  );
}
function TraceGroup({
  newSession,
  agent,
  item,
  highlight,
}: {
  newSession: boolean;
  agent: Agent;
  item: TraceItem;
  highlight: boolean;
}) {
  return (
    <>
      {newSession && (
        <li className="flex items-center gap-2 py-2 text-[10px] text-muted">
          <span className="h-px flex-1 bg-black/[0.07]" />
          新的运行会话
          <span className="h-px flex-1 bg-black/[0.07]" />
        </li>
      )}
      <TraceAction agent={agent} item={item} highlight={highlight} />
    </>
  );
}
