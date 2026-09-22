import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowUp, AtSign, LoaderCircle, Paperclip, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { api } from "../api.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { StagedChip } from "./Attachments.tsx";
import { isAllOption, useMentionPicker } from "./useMentionPicker.ts";
import { useStagedAttachments } from "./useStagedAttachments.ts";

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
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const submission = useRef<{ key: string; id: string } | null>(null);
  const draft = chatId ? (drafts[chatId] ?? "") : "";
  const setDraft = (text: string) =>
    chatId && setDrafts((old) => ({ ...old, [chatId]: text }));
  const files = useStagedAttachments({
    chatId: chatId ?? null,
    onError: setError,
  });
  const mention = useMentionPicker({
    draft,
    isGroup: active?.kind === "group",
    agents,
    replace: (text) => {
      setDraft(text);
      textarea.current?.focus();
    },
  });
  useEffect(() => {
    mention.reset();
    setError("");
  }, [chatId]);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!chatId || sending || files.uploading) return;
    if (!draft.trim() && !files.attached.length) return;
    const target = chatId,
      body = draft,
      attachments = files.attached.map((item) => item.id);
    setSending(true);
    setError("");
    const key = JSON.stringify([
      target,
      body,
      mention.mentionIds,
      mention.mentionAll,
      attachments,
    ]);
    if (submission.current?.key !== key)
      submission.current = { key, id: crypto.randomUUID() };
    try {
      await api("/messages", "POST", {
        chat_id: target,
        body,
        mentions: mention.mentionIds,
        mention_all: mention.mentionAll,
        client_id: submission.current.id,
        attachments,
      });
      submission.current = null;
      setDrafts((old) => ({
        ...old,
        [target]: old[target] === body ? "" : old[target],
      }));
      files.clear(target);
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
  const hint = mention.mentionAll
    ? `将通知全体成员（${agents.length} 位）`
    : mention.mentionIds.length
      ? `将通知 ${mention.mentionIds.length} 位 Agent`
      : "Enter 发送 · Shift + Enter 换行";
  return (
    <div className="px-[35px] pb-[14px] min-[1450px]:px-[max(40px,calc((100vw-1160px)/2))] max-[720px]:px-5 max-[720px]:pb-3 max-[560px]:px-3 max-[560px]:pb-2.5">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className={`relative rounded-[11px] border bg-white shadow-[0_2px_4px_#312b1c04] transition-[border-color,background-color] duration-150 focus-within:border-[#c4b9a4] ${dragging ? "border-[#c4b9a4] bg-[#faf8f3]" : "border-[#dfdcd3]"}`}
        onSubmit={send}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void files.add(e.dataTransfer.files);
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void files.add(e.target.files);
            e.target.value = "";
          }}
        />
        {files.attached.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-[17px] pt-3">
            {files.attached.map((item) => (
              <StagedChip
                key={item.id}
                item={item}
                onRemove={() => void files.remove(item.id)}
              />
            ))}
          </div>
        )}
        {mention.candidates.length > 0 && (
          <div
            className="absolute bottom-[calc(100%+7px)] left-0 z-[2] w-[min(400px,100%)] rounded-[9px] border border-line bg-white p-[5px] shadow-[0_7px_28px_#30220d12]"
            role="listbox"
            aria-label="提及 Agent"
          >
            {mention.candidates.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mention.index}
                className={`flex w-full items-center gap-[11px] rounded-[5px] p-2.5 text-left ${
                  index === mention.index ? "bg-[#f3f1ea]" : ""
                }`}
                key={isAllOption(item) ? "all" : item.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => mention.choose(item)}
              >
                {isAllOption(item) ? (
                  <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[#ece9df] text-[#7d7668]">
                    <Users size={14} />
                  </span>
                ) : (
                  <Avatar
                    small
                    name={item.name}
                    presence={agentPresence(item)}
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-xs font-[550]">
                    {isAllOption(item) ? "全体成员" : item.name}
                  </strong>
                  <small className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#8e8779]">
                    {isAllOption(item)
                      ? "群内每位成员都会立刻收到"
                      : item.work || runtimeLabel(item)}
                  </small>
                </span>
                {!isAllOption(item) && (
                  <span className="muted small-text">{runtimeLabel(item)}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="plain-field block max-h-[200px] min-h-[70px] w-full resize-none overflow-y-auto rounded-[11px] border-0 bg-transparent px-[17px] pb-1.5 pt-[17px] text-[13px] leading-[1.7] text-[#434137] placeholder:text-[#aaa396] max-[560px]:min-h-[66px]"
          aria-label="消息"
          placeholder={
            files.attached.length
              ? "添加说明，或直接发送"
              : active.kind === "group"
                ? `发送到 ${active.name}，输入 @ 提及 Agent…`
                : `发送给 ${active.name}…`
          }
          value={draft}
          rows={2}
          maxLength={6000}
          onChange={(e) => {
            setDraft(e.target.value);
            mention.reset();
          }}
          onPaste={(e) => {
            const dropped = [...e.clipboardData.files];
            if (!dropped.length) return;
            e.preventDefault();
            void files.add(dropped);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (mention.handleKey(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-[9px] px-2.5 pb-2.5 pt-1 text-[10px] text-[#a09b8d]">
          <button
            type="button"
            className="icon-button"
            aria-label="添加附件"
            disabled={files.uploading || files.full}
            onClick={() => picker.current?.click()}
          >
            <Paperclip size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="提及 Agent"
            onClick={() => {
              setDraft(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`);
              mention.reset();
              textarea.current?.focus();
            }}
          >
            <AtSign size={18} />
          </button>
          <span className="text-[10px] text-[#aaa395] max-[560px]:text-[9px]">
            {hint}
          </span>
          <button
            className="ml-auto flex h-[29px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-[#45463c] text-white disabled:bg-[#e9e7de] disabled:text-[#b1aa99]"
            aria-label="发送消息"
            disabled={
              (!draft.trim() && !files.attached.length) ||
              sending ||
              files.uploading
            }
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
          ? "普通消息按对方心跳节奏提醒；明确 @ 不等待，对方离线也会叫醒。"
          : "私聊不等待；对方离线就把它叫醒。"}
      </p>
    </div>
  );
}
