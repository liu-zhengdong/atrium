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
import { time } from "../time.ts";
import { Empty } from "../components/Empty.tsx";

export function mergeTrace(old: TraceItem[], incoming: TraceItem[]) {
  const rows = new Map(old.map((item) => [item.id, item]));
  for (const item of incoming) rows.set(item.id, item);
  return [...rows.values()].sort((a, b) => a.id - b.id);
}

function TraceAction({ agent, item }: { agent: Agent; item: TraceItem }) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
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
  }, [open, agent.id, item.id, item.ended_at, item.state, retry]);
  const active =
    item.state === "running" &&
    agent.runtime?.busy &&
    agent.runtime.generation === item.generation;
  const unknown =
    item.state === "unknown" || (item.state === "running" && !active);
  return (
    <li
      className={`relative border-l border-line pb-5 pl-[23px] last:border-transparent last:pb-0`}
    >
      <span
        className={`absolute -left-[10px] top-0 grid h-[23px] w-[19px] place-items-center bg-[#faf9f6] ${
          active
            ? "text-[#8a6b37]"
            : item.state === "error"
              ? "text-[#a35338]"
              : "text-[#918875]"
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
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group/details"
      >
        <summary className="group cursor-pointer list-none rounded-[5px] focus-visible:outline-2 focus-visible:outline-[#8a7756] focus-visible:outline-offset-[3px] [&::-webkit-details-marker]:hidden">
          <div className="flex justify-between text-[10px] leading-[23px] text-muted">
            <time dateTime={new Date(item.at).toISOString()}>
              {time(item.at)}
            </time>
            <span className="text-[#92724b]">
              {active
                ? "进行中"
                : unknown
                  ? "状态未知"
                  : item.state === "error"
                    ? "失败"
                    : ""}
            </span>
          </div>
          <div className="flex items-baseline gap-2.5 text-xs leading-[1.65] group-hover:text-[#8a6b37]">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {item.title}
            </span>
            <ChevronRight
              size={14}
              className="flex-shrink-0 text-[#aaa08f] transition-transform group-open/details:rotate-90"
            />
          </div>
        </summary>
        {open && (
          <div className="mt-[9px] rounded-[7px] border border-line bg-[#f5f3ee] px-3 py-[11px] text-[11px]">
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
                  <>
                    <h4 className="m-0 mb-1.5 text-[10px] font-medium text-muted">
                      调用参数
                    </h4>
                    <pre className="mb-3.5 max-h-[260px] overflow-auto whitespace-pre-wrap leading-[1.65] [overflow-wrap:anywhere] last:mb-0">
                      {detail.input}
                    </pre>
                  </>
                )}
                {detail.output && (
                  <>
                    <h4 className="m-0 mb-1.5 text-[10px] font-medium text-muted">
                      {item.kind === "tool" ? "执行结果" : "内容"}
                    </h4>
                    <pre className="mb-3.5 max-h-[260px] overflow-auto whitespace-pre-wrap leading-[1.65] [overflow-wrap:anywhere] last:mb-0">
                      {detail.output}
                    </pre>
                  </>
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
}: {
  agent: Agent;
  revision: number;
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
  }, [items, loading]);
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
        className="mx-6 mb-3 mt-[19px] flex items-center gap-3 rounded-[9px] border border-line bg-soft px-3.5 py-[13px] text-[#74684e]"
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
      <p className="flex-shrink-0 border-t border-line px-6 py-3 text-[10px] text-muted">
        真实运行记录 · 仅供你审阅，不自动共享给同伴
      </p>
    </section>
  );
}
function TraceGroup({
  newSession,
  agent,
  item,
}: {
  newSession: boolean;
  agent: Agent;
  item: TraceItem;
}) {
  return (
    <>
      {newSession && (
        <li className="list-none py-3 pb-[18px] pl-[23px] text-[10px] text-muted">
          新的运行会话
        </li>
      )}
      <TraceAction agent={agent} item={item} />
    </>
  );
}
