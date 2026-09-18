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
      className={`trace-item ${active ? "active" : ""} ${item.state === "error" ? "failed" : ""}`}
    >
      <span className="trace-node" aria-hidden="true">
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
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <div className="trace-caption">
            <time dateTime={new Date(item.at).toISOString()}>
              {time(item.at)}
            </time>
            <span>
              {active
                ? "进行中"
                : unknown
                  ? "状态未知"
                  : item.state === "error"
                    ? "失败"
                    : ""}
            </span>
          </div>
          <div className="trace-title">
            <span>{item.title}</span>
            <ChevronRight size={14} />
          </div>
        </summary>
        {open && (
          <div className="trace-detail">
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
                    <h4>调用参数</h4>
                    <pre>{detail.input}</pre>
                  </>
                )}
                {detail.output && (
                  <>
                    <h4>{item.kind === "tool" ? "执行结果" : "内容"}</h4>
                    <pre>{detail.output}</pre>
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
    <section className="trace-panel" aria-label="运行轨迹">
      <div className="trace-status" aria-live="polite">
        {agent.runtime?.busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Activity size={15} />
        )}
        <div>
          <span>实际运行</span>
          <strong>
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
        <p className="trace-warning" role="status">
          {runtimeError}
        </p>
      )}
      {error && (
        <p className="error trace-warning" role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>重试</button>
        </p>
      )}
      <div
        className="trace-scroll"
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
          <p className="loading">
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
                className="older"
                disabled={paging}
                onClick={() => void loadOlder()}
              >
                {paging ? "正在加载…" : "查看更早轨迹"}
              </button>
            )}
            <ol className="trace-list">
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
          className="trace-latest button secondary"
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
      <p className="trace-footnote">
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
      {newSession && <li className="trace-session">新的运行会话</li>}
      <TraceAction agent={agent} item={item} />
    </>
  );
}
