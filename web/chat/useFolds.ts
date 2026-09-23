import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 一条消息里用户展开过的部分：body 是折起的长正文，details 是详情。 */
export type Expanded = { body?: boolean; details?: boolean };

/**
 * 各条消息折叠部分的展开状态，记在列表这一层：行滚出视口会卸载，滚回来时保持原样。
 * 展开、收起只由用户点击触发，点下去的元素留在屏幕原位。
 */
export function useFolds(
  scroll: RefObject<HTMLDivElement | null>,
  holdPosition: () => void,
) {
  const [expanded, setExpanded] = useState<Record<number, Expanded>>({});
  const held = useRef<{ element: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const hold = held.current,
      scroller = scroll.current;
    held.current = null;
    if (!hold || !scroller) return;
    // 收起长正文时按钮上方变短、按钮上移，滚回去让它停在原处；其余情况位移为 0。
    scroller.scrollTop += hold.element.getBoundingClientRect().top - hold.top;
  }, [expanded, scroll]);
  /** anchor 是点击后要留在原位的元素。 */
  const toggle =
    (id: number) => (part: keyof Expanded, anchor: HTMLElement) => {
      held.current = {
        element: anchor,
        top: anchor.getBoundingClientRect().top,
      };
      holdPosition();
      setExpanded((all) => ({
        ...all,
        [id]: { ...all[id], [part]: !all[id]?.[part] },
      }));
    };
  return { expanded, toggle };
}
