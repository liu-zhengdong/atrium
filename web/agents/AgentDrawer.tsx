import { useEffect, useState } from "react";
import { Activity, ChevronRight, Inbox, LoaderCircle } from "lucide-react";
import type { BoxMessage, Page } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { time } from "../time.ts";
import { SidePanel } from "../components/SidePanel.tsx";
import { AgentFailure } from "../components/AgentFailure.tsx";
import { Empty } from "../components/Empty.tsx";
import { AgentModel } from "./AgentModel.tsx";
import { AgentNewSession } from "./AgentNewSession.tsx";
import { AgentCredentials } from "../settings/AgentCredentials.tsx";
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
  openTrace,
  visible,
}: {
  agent: Agent;
  revision: number;
  close: () => void;
  openConfig: () => void;
  openTrace: () => void;
  visible: boolean;
}) {
  const [box, setBox] = useState<Page<BoxMessage> | null>(null);
  const [pages, setPages] = useState([0]);
  const [error, setError] = useState("");
  useEffect(() => {
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
  }, [agent.id, revision, pages]);
  return (
    <SidePanel title={agent.name} close={close}>
      <div className="flex items-center gap-3 bg-[#f9faf9] px-5 py-4">
        <Avatar name={agent.name} presence={agentPresence(agent)} />
        <div className="min-w-0 flex-1 text-xs text-muted">
          {agent.unassigned ? (
            <p className="text-[#9c3f2d]">未分配账号 · 请在下方分配</p>
          ) : agent.failure ? (
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
      {agent.session_reset_at && (
        <details className="mx-5 my-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <summary className="cursor-pointer">
            已换新会话 · 旧会话保留 · {time(agent.session_reset_at)}
          </summary>
          <p className="mt-2 break-words text-amber-800">
            {agent.session_reset_reason}
          </p>
        </details>
      )}
      <div className="flex items-center justify-between px-5 text-xs">
        <h3 className="py-3 text-muted">
          <Inbox size={15} className="mr-1 inline" />
          通知{" "}
          {agent.unread > 0 && <span className="badge">{agent.unread}</span>}
        </h3>
        <button
          className="flex items-center gap-1 py-3 text-accent-strong hover:underline"
          onClick={openTrace}
        >
          <Activity size={15} />
          运行轨迹
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
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
      </div>
      <div className="space-y-2 px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium">模型 · 账号</h3>
          <AgentNewSession agent={agent} />
        </div>
        <AgentModel agentId={agent.id} compact />
        <AgentCredentials
          agent={agent}
          compact
          visible={visible}
          openAccounts={openConfig}
        />
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
