import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 一条消息里用户展开过的部分：body 是折起的长正文，details 是详情。 */
export type Expanded = { body?: boolean; details?: boolean };

/**
 * 各条消息折叠部分的展开状态，记在列表这一层：行滚出视口会卸载，滚回来时保持原样。
 * 展开、收起只由用户点击触发，点下去的元素留在屏幕原位。
 */
export function useFolds(
  scroll: RefObject<HTMLDivElement | null>,
  holdPosition: (settled: () => void) => void,
) {
  const [expanded, setExpanded] = useState<Record<number, Expanded>>({});
  const restoring = useRef<(() => void) | null>(null);
  // 高度一变，虚拟列表会调整滚动，包括短列表加载时没用上、等列表变长才补上的那次。
  // 调整发生在渲染里（setOptions）时，这一次提交的布局阶段挪回；发生在它的尺寸观察回调里时，
  // 由下面晚创建的 ResizeObserver 在它之后回调挪回。两种都在绘制之前。
  useLayoutEffect(() => restoring.current?.());
  /** anchor 是点击后要留在原位的元素。 */
  const toggle =
    (id: number) => (part: keyof Expanded, anchor: HTMLElement) => {
      const top = anchor.getBoundingClientRect().top;
      const restore = () => {
        if (scroll.current)
          scroll.current.scrollTop += anchor.getBoundingClientRect().top - top;
      };
      const observer = new ResizeObserver(restore);
      observer.observe(anchor.closest("[data-index]") ?? anchor);
      restoring.current = restore;
      holdPosition(() => {
        restore();
        observer.disconnect();
        restoring.current = null;
      });
      setExpanded((all) => ({
        ...all,
        [id]: { ...all[id], [part]: !all[id]?.[part] },
      }));
    };
  return { expanded, toggle };
}
