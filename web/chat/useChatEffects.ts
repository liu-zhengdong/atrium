import { useEffect, useRef } from "react";
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

/** 搜索或群文件跳转后，把目标消息滚到中间并闪一下。 */
export function useAnchorScroll({
  chatId,
  anchoredId,
  loading,
}: {
  chatId: string | null;
  anchoredId: number | undefined;
  loading: boolean;
}) {
  const scrolledTo = useRef("");
  useEffect(() => {
    if (!anchoredId || loading) return;
    const key = `${chatId}:${anchoredId}`;
    if (scrolledTo.current === key) return;
    const target = document.getElementById(`msg-${anchoredId}`);
    if (!target) return;
    scrolledTo.current = key;
    target.scrollIntoView({ block: "center" });
    target.classList.add("flash");
    const timer = setTimeout(() => target.classList.remove("flash"), 2400);
    return () => clearTimeout(timer);
  }, [anchoredId, loading, chatId]);
}
