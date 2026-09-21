import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "../../shared/schema.ts";

/** 没测量过的消息先按这个高度估算，只影响滚动条长度；元素挂载后换成实测值。 */
const ESTIMATED_HEIGHT = 140;
/** 最后一条消息下方留白，与 useConversation 的贴底判定共用 90px 容差。 */
const PADDING_END = 24;
const BOTTOM_THRESHOLD = 90;

/**
 * 只渲染视口附近的消息。
 * 顶部的翻页按钮和空态不进虚拟列表，用它们的实测高度当作列表起点。
 */
export function useMessageWindow(
  messages: Message[],
  scroll: RefObject<HTMLDivElement | null>,
) {
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    if (!header) return;
    const measure = () => setHeaderHeight(header.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [header]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ESTIMATED_HEIGHT,
    getItemKey: (index) => messages[index]?.id ?? index,
    paddingStart: headerHeight,
    paddingEnd: PADDING_END,
    overscan: 6,
    // 翻出更早的消息时以当前位置的那条为锚点还原偏移，眼前的内容不动。
    // 贴底跟随不交给 followOnAppend：多条消息在同一批到达时它会停在离底 125px，
    // 改由 useConversation 按自己的贴底判定重新贴到底。
    anchorTo: "end",
    scrollEndThreshold: BOTTOM_THRESHOLD,
  });

  /** 把某条消息滚到视口中间；它不在当前消息集里时返回 false。 */
  const scrollToMessage = useCallback(
    (id: number) => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return false;
      virtualizer.scrollToIndex(index, { align: "center" });
      return true;
    },
    [messages, virtualizer],
  );

  return { headerRef: setHeader, virtualizer, scrollToMessage };
}
