import { useEffect, useState } from "react";
import { Activity, ChevronRight, Inbox, LoaderCircle } from "lucide-react";
import type { BoxMessage, Page } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { time } from "../time.ts";
import { SidePanel } from "../components/SidePanel.tsx";
import { AgentFailure } from "../components/AgentFailure.tsx";
import { Empty } from "../components/Empty.tsx";
import { AgentTrace } from "./AgentTrace.tsx";
import { AgentModel } from "./AgentModel.tsx";
import {
  agentPresence,
  Avatar,
  type Agent,
} from "../components/AgentAvatar.tsx";

export function AgentDrawer({
  agent,
  revision,
  close,
  openConfig,
}: {
  agent: Agent;
  revision: number;
  close: () => void;
  openConfig: () => void;
}) {
  const [tab, setTab] = useState<"trace" | "box">("trace");
  const [box, setBox] = useState<Page<BoxMessage> | null>(null);
  const [pages, setPages] = useState([0]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (tab !== "box") return;
    let active = true;
    void api<Page<BoxMessage>>(`/agents/${agent.id}/box?after=${pages.at(-1)}`)
      .then((value) => {
        if (active) setBox(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [agent.id, revision, pages, tab]);
  return (
    <SidePanel title={agent.name} close={close}>
      <div className="flex items-center gap-3 bg-[#f9faf9] px-5 py-4">
        <Avatar name={agent.name} presence={agentPresence(agent)} />
        <div className="min-w-0 flex-1 text-xs text-muted">
          {agent.failure ? (
            <AgentFailure
              agent={agent}
              retry={() => {
                void api(`/agents/${agent.id}/retry`, "POST").catch((e) =>
                  setError(String(e)),
                );
              }}
            />
          ) : (
            <p className="truncate" title={agent.work}>
              {agent.work || "尚未声明工作"}
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-5 px-5 text-xs">
        <button
          className={`py-3 ${tab === "trace" ? "text-accent-strong" : "text-muted"}`}
          onClick={() => setTab("trace")}
        >
          <Activity size={15} className="mr-1 inline" />
          运行轨迹
        </button>
        <button
          className={`py-3 ${tab === "box" ? "text-accent-strong" : "text-muted"}`}
          onClick={() => setTab("box")}
        >
          <Inbox size={15} className="mr-1 inline" />
          通知{" "}
          {agent.unread > 0 && <span className="badge">{agent.unread}</span>}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "trace" ? (
          <AgentTrace agent={agent} revision={revision} />
        ) : (
          <div className="px-5 py-4">
            {!box ? (
              <LoaderCircle className="spin" size={16} />
            ) : !box.items.length ? (
              <Empty icon={<Inbox size={26} />} title="通知箱暂时没有消息" />
            ) : (
              box.items.map((notice) => (
                <article key={notice.id} className="notice">
                  <div className="notice-meta">
                    <span>{notice.source}</span>
                    <time>{time(notice.created_at)}</time>
                  </div>
                  <h3>{notice.title}</h3>
                  <details>
                    <summary>查看消息内容</summary>
                    <pre className="whitespace-pre-wrap break-all">
                      {notice.body}
                    </pre>
                  </details>
                  {notice.url && (
                    <a href={notice.url} target="_blank" rel="noreferrer">
                      查看来源 <ChevronRight size={13} />
                    </a>
                  )}
                </article>
              ))
            )}
            {box && (pages.length > 1 || box.has_more) && (
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="button secondary"
                  disabled={pages.length === 1}
                  onClick={() => setPages((p) => p.slice(0, -1))}
                >
                  上一页
                </button>
                <button
                  className="button secondary"
                  disabled={!box.has_more}
                  onClick={() => setPages((p) => [...p, box.next_after])}
                >
                  下一页
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="space-y-2 px-5 py-4">
        <AgentModel agentId={agent.id} compact />
        <button
          className="w-full rounded-lg bg-soft px-3 py-2 text-left text-xs text-accent-strong hover:bg-[#e2ebe4]"
          onClick={openConfig}
        >
          配置 <ChevronRight size={14} className="float-right" />
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </SidePanel>
  );
}
