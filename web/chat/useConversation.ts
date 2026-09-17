import { useEffect, useRef, useState } from "react";
import type { Message, ChatReadState } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { mergeReadState } from "./readState.ts";
import { mergeMessages } from "./messages.ts";

type MessagePage = {
  items: Message[];
  has_more: boolean;
  read_state: ChatReadState[];
};

export function useConversation(chatId: string | null, revision: number) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [readState, setReadState] = useState<ChatReadState[]>([]);
  const loadedFrom = useRef<number | undefined>(undefined);
  const [members, setMembers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true),
    [older, setOlder] = useState(false);
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  const loadedChat = useRef<string | null>(null),
    currentChat = useRef(chatId);
  currentChat.current = chatId;

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    const first = loadedChat.current !== chatId;
    if (first) {
      setLoading(true);
      setMessages([]);
      setReadState([]);
      loadedFrom.current = undefined;
      setOlder(false);
      setMembers([]);
      setError("");
      nearBottom.current = true;
    }
    void Promise.all([
      api<MessagePage>(
        `/chats/${chatId}/messages${loadedFrom.current ? `?read_from=${loadedFrom.current}` : ""}`,
      ),
      api<{ members: string[] }>(`/chats/${chatId}`),
    ])
      .then(([page, info]) => {
        if (cancelled) return;
        setMembers(info.members);
        setReadState((old) =>
          mergeReadState(first ? [] : old, page.read_state),
        );
        loadedFrom.current ??= page.items[0]?.id;
        if (first) {
          setMessages(mergeMessages([], page.items, chatId));
          setOlder(page.has_more);
        } else {
          setMessages((old) => mergeMessages(old, page.items, chatId));
        }
        loadedChat.current = chatId;
        setLoading(false);
        setError("");
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [revision, chatId]);

  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, loading]);

  async function loadOlder() {
    if (!chatId) return;
    const target = chatId,
      height = scroll.current?.scrollHeight ?? 0;
    try {
      const page = await api<MessagePage>(
        `/chats/${chatId}/messages?before=${messages[0]?.id}`,
      );
      if (currentChat.current !== target) return;
      nearBottom.current = false;
      loadedFrom.current = page.items[0]?.id ?? loadedFrom.current;
      setReadState((old) => mergeReadState(old, page.read_state));
      setMessages((old) => mergeMessages(old, page.items, target));
      setOlder(page.has_more);
      requestAnimationFrame(() => {
        if (currentChat.current === target && scroll.current)
          scroll.current.scrollTop = scroll.current.scrollHeight - height;
      });
    } catch (e) {
      if (currentChat.current === target) setError(String(e));
    }
  }

  return {
    // Before the effect runs, or if the new request fails, never show the
    // previous conversation's data beneath the newly selected heading.
    messages: messages.filter((message) => message.chat_id === chatId),
    members: loadedChat.current === chatId ? members : [],
    readState: loadedChat.current === chatId ? readState : [],
    loading,
    older: loadedChat.current === chatId && older,
    error,
    scroll,
    loadOlder,
    onScroll() {
      const el = scroll.current;
      if (el)
        nearBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    },
    followLatest() {
      nearBottom.current = true;
    },
  };
}
