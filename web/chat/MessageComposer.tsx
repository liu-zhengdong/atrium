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
  agentSummary,
  Avatar,
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
      : "";
  return (
    <div className="mx-auto w-full max-w-[820px] px-5 pb-5 max-[720px]:px-3.5 max-[720px]:pb-3.5 max-[560px]:px-2.5 max-[560px]:pb-2.5">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className={`relative rounded-xl border bg-white shadow-[0_2px_14px_rgba(24,32,25,0.04)] transition-all duration-150 ${
          dragging
            ? "border-accent bg-[#f2f6f4] shadow-[0_0_0_1px_#4b6f5a]"
            : "border-black/[0.06] hover:border-black/[0.1] focus-within:border-accent/40 focus-within:shadow-[0_4px_16px_rgba(43,79,58,0.06)]"
        }`}
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
          <div className="flex flex-wrap gap-1.5 px-4 pt-3">
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
            className="absolute bottom-[calc(100%+8px)] left-0 z-[2] w-[min(400px,100%)] rounded-xl border border-black/[0.05] bg-white p-1.5 shadow-[0_12px_32px_rgba(24,32,25,0.08),0_2px_8px_rgba(24,32,25,0.04)]"
            role="listbox"
            aria-label="提及 Agent"
          >
            {mention.candidates.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mention.index}
                className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors ${
                  index === mention.index
                    ? "bg-[#edf5f1] text-ink"
                    : "text-muted hover:bg-[#f2f6f4] hover:text-ink"
                }`}
                key={isAllOption(item) ? "all" : item.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => mention.choose(item)}
              >
                {isAllOption(item) ? (
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[#d7e8dd] text-[#204e35]">
                    <Users size={13} />
                  </span>
                ) : (
                  <Avatar
                    small
                    name={item.name}
                    presence={agentPresence(item)}
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-xs font-semibold text-ink">
                    {isAllOption(item) ? "全体成员" : item.name}
                  </strong>
                  <small className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted">
                    {isAllOption(item)
                      ? "群内每位成员都会立刻收到"
                      : agentSummary(item)}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="plain-field block max-h-[200px] min-h-[58px] w-full resize-none overflow-y-auto rounded-t-xl border-0 bg-transparent px-4 pb-1 pt-3.5 text-[13px] leading-[1.65] text-ink caret-accent placeholder:text-placeholder"
          aria-label="消息"
          placeholder={
            files.attached.length
              ? "添加说明，或直接发送"
              : active.kind === "group"
                ? `发送到 ${active.name}…`
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
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-0.5 text-xs text-muted">
          <button
            type="button"
            className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
            aria-label="添加附件"
            disabled={files.uploading || files.full}
            onClick={() => picker.current?.click()}
          >
            <Paperclip size={16} />
          </button>
          <button
            type="button"
            className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
            aria-label="提及 Agent"
            onClick={() => {
              setDraft(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`);
              mention.reset();
              textarea.current?.focus();
            }}
          >
            <AtSign size={16} />
          </button>
          {hint && (
            <span className="text-[11px] text-muted/75 max-[560px]:hidden">
              {hint}
            </span>
          )}
          <button
            className="ml-auto flex h-7 w-7 flex-none items-center justify-center rounded-md bg-accent text-white transition-colors hover:bg-accent-strong disabled:bg-[#e4ece6] disabled:text-[#9fb0a4]"
            aria-label="发送消息"
            disabled={
              (!draft.trim() && !files.attached.length) ||
              sending ||
              files.uploading
            }
          >
            {sending ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <ArrowUp size={15} />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
