import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, AtSign, LoaderCircle } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { resolveMentions } from "../../shared/mentions.ts";
import { api } from "../api.ts";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export function MessageComposer({
  active,
  agents,
  onSent,
}: {
  active: Overview["chats"][number] | undefined;
  agents: Agent[];
  onSent: () => void;
}) {
  const chatId = active?.id;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0),
    [mentionHidden, setMentionHidden] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submission = useRef<{ key: string; id: string } | null>(null);
  const draft = chatId ? (drafts[chatId] ?? "") : "";
  const query = draft.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const candidates =
    !mentionHidden && query !== undefined
      ? agents
          .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6)
      : [];
  const mentionIds = resolveMentions(draft, agents);
  useEffect(() => {
    setMentionHidden(false);
    setMentionIndex(0);
    setError("");
  }, [chatId]);
  function chooseMention(a: Agent) {
    if (!chatId) return;
    setDrafts((old) => ({
      ...old,
      [chatId]: draft.replace(/@[^@\n]*$/, `@${a.name} `),
    }));
    setMentionHidden(true);
    setMentionIndex(0);
    textarea.current?.focus();
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!chatId || !draft.trim() || sending) return;
    const target = chatId,
      body = draft;
    setSending(true);
    setError("");
    const key = JSON.stringify([target, body, mentionIds]);
    if (submission.current?.key !== key)
      submission.current = { key, id: crypto.randomUUID() };
    try {
      await api("/messages", "POST", {
        chat_id: target,
        body,
        mentions: mentionIds,
        client_id: submission.current.id,
      });
      submission.current = null;
      setDrafts((old) => ({
        ...old,
        [target]: old[target] === body ? "" : old[target],
      }));
      onSent();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  // The component stays mounted even while a newly created chat is loading.
  if (!active) return null;
  return (
    <div className="px-[35px] pb-[14px] min-[1450px]:px-[max(40px,calc((100vw-1160px)/2))] max-[720px]:px-5 max-[720px]:pb-3 max-[560px]:px-3 max-[560px]:pb-2.5">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="relative rounded-[11px] border border-[#dfdcd3] bg-white shadow-[0_2px_4px_#312b1c04] transition-[border-color] duration-150 focus-within:border-[#c4b9a4]"
        onSubmit={send}
      >
        {candidates.length > 0 && (
          <div
            className="absolute bottom-[calc(100%+7px)] left-0 z-[2] w-[min(400px,100%)] rounded-[9px] border border-line bg-white p-[5px] shadow-[0_7px_28px_#30220d12]"
            role="listbox"
            aria-label="提及 Agent"
          >
            {candidates.map((a, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                className={`flex w-full items-center gap-[11px] rounded-[5px] p-2.5 text-left ${
                  index === mentionIndex ? "bg-[#f3f1ea]" : ""
                }`}
                key={a.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseMention(a)}
              >
                <Avatar small name={a.name} online={a.available} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-xs font-[550]">{a.name}</strong>
                  <small className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#8e8779]">
                    {a.work || runtimeLabel(a)}
                  </small>
                </span>
                <span className="muted small-text">{runtimeLabel(a)}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="plain-field block max-h-[200px] min-h-[70px] w-full resize-y rounded-[11px] border-0 bg-transparent px-[17px] pb-1.5 pt-[17px] text-[13px] leading-[1.7] text-[#434137] placeholder:text-[#aaa396] max-[560px]:min-h-[66px]"
          aria-label="消息"
          placeholder={
            active.kind === "group"
              ? `发送到 ${active.name}，输入 @ 提及 Agent…`
              : `发送给 ${active.name}…`
          }
          value={draft}
          rows={2}
          maxLength={6000}
          onChange={(e) => {
            setDrafts((old) => ({ ...old, [chatId!]: e.target.value }));
            setMentionHidden(false);
            setMentionIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (candidates.length && ["ArrowDown", "ArrowUp"].includes(e.key)) {
              e.preventDefault();
              setMentionIndex(
                (i) =>
                  (i + (e.key === "ArrowDown" ? 1 : -1) + candidates.length) %
                  candidates.length,
              );
            } else if (
              candidates.length &&
              (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
            ) {
              e.preventDefault();
              chooseMention(candidates[mentionIndex] ?? candidates[0]);
            } else if (e.key === "Escape") setMentionHidden(true);
            else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-[9px] px-2.5 pb-2.5 pt-1 text-[10px] text-[#a09b8d]">
          <button
            type="button"
            className="icon-button"
            aria-label="提及 Agent"
            onClick={() => {
              setDrafts((old) => ({
                ...old,
                [chatId!]: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`,
              }));
              setMentionHidden(false);
              textarea.current?.focus();
            }}
          >
            <AtSign size={18} />
          </button>
          <span className="text-[10px] text-[#aaa395] max-[560px]:text-[9px]">
            {mentionIds.length
              ? `将通知 ${mentionIds.length} 位 Agent`
              : "Enter 发送 · Shift + Enter 换行"}
          </span>
          <button
            className="ml-auto flex h-[29px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-[#45463c] text-white disabled:bg-[#e9e7de] disabled:text-[#b1aa99]"
            aria-label="发送消息"
            disabled={!draft.trim() || sending}
          >
            {sending ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ArrowUp size={19} />
            )}
          </button>
        </div>
      </form>
      <p className="mx-0.5 mt-2 text-[10px] text-[#aaa395]">
        {active.kind === "group"
          ? "普通消息按对方心跳节奏提醒；明确 @ 不等待。"
          : "消息会保留；离线时等待 Agent 上线，或按运行设置自动启动。"}
      </p>
    </div>
  );
}
