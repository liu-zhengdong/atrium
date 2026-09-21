import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, ChatReadState } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { mergeReadState } from "./readState.ts";
import { mergeMessages } from "./messages.ts";
import { useMessageWindow } from "./useMessageWindow.ts";

type MessagePage = {
  items: Message[];
  has_more: boolean;
  read_state: ChatReadState[];
};

export function useConversation(
  chatId: string | null,
  revision: number,
  anchorId?: number,
) {
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
    currentChat = useRef(chatId),
    anchored = useRef<number | undefined>(undefined);
  currentChat.current = chatId;

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    const first =
      loadedChat.current !== chatId || anchored.current !== anchorId;
    anchored.current = anchorId;
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
        anchorId
          ? `/chats/${chatId}/messages?around=${anchorId}`
          : `/chats/${chatId}/messages${loadedFrom.current ? `?read_from=${loadedFrom.current}` : ""}`,
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
        if (anchorId) {
          nearBottom.current = false;
          loadedFrom.current = page.items[0]?.id;
          setMessages(mergeMessages([], page.items, chatId));
          setOlder(false);
        } else if (first) {
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
  }, [revision, chatId, anchorId]);

  // 换会话或请求失败时，不能把上一个会话的消息显示在新标题下面。
  const visible = useMemo(
    () => messages.filter((message) => message.chat_id === chatId),
    [messages, chatId],
  );
  const { headerRef, virtualizer, scrollToMessage } = useMessageWindow(
    visible,
    scroll,
  );

  // 贴底时跟住最新消息。总高度变化也要重新贴底，因为行高先按估值算，
  // 挂载后测出真实高度、图片加载完成都会改变总高度。
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!nearBottom.current || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, loading, totalSize]);

  async function loadOlder() {
    if (!chatId) return;
    const target = chatId;
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
    } catch (e) {
      if (currentChat.current === target) setError(String(e));
    }
  }

  return {
    anchored: anchorId !== undefined,
    messages: visible,
    headerRef,
    virtualizer,
    scrollToMessage,
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
    atBottom() {
      return nearBottom.current;
    },
    followLatest() {
      nearBottom.current = true;
    },
  };
}
