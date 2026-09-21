import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

/** 滚到底且不是在翻历史时，把已读位置推到最新。 */
export function useReadReporter({
  chatId,
  latest,
  hidden,
  anchoredId,
  atBottom,
}: {
  chatId: string | null;
  latest: number;
  hidden: boolean;
  anchoredId: number | undefined;
  atBottom: () => boolean;
}) {
  const marked = useRef(0);
  useEffect(() => {
    marked.current = 0;
  }, [chatId]);
  useEffect(() => {
    if (!chatId || hidden || !latest || latest <= marked.current) return;
    if (anchoredId) return; // 定位到历史消息不代表读到了最新
    if (!atBottom()) return;
    marked.current = latest;
    void api(`/chats/${chatId}/read`, "POST", { through: latest }).catch(() => {
      marked.current = 0;
    });
  }, [chatId, latest, hidden, anchoredId]);
}

/**
 * 搜索或群文件跳转后，把目标消息滚到中间并闪一下。
 * 返回要高亮的消息 id：目标可能不在渲染窗口里，高亮交给列表按数据渲染，不查 DOM。
 */
export function useAnchorScroll({
  chatId,
  anchoredId,
  loading,
  scrollToMessage,
}: {
  chatId: string | null;
  anchoredId: number | undefined;
  loading: boolean;
  scrollToMessage: (id: number) => boolean;
}) {
  const scrolledTo = useRef("");
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    if (!anchoredId || loading) return;
    const key = `${chatId}:${anchoredId}`;
    if (scrolledTo.current === key) return;
    if (!scrollToMessage(anchoredId)) return;
    scrolledTo.current = key;
    setFlash(anchoredId);
  }, [anchoredId, loading, chatId, scrollToMessage]);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash]);
  return flash;
}
