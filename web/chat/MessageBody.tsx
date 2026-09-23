import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { RichText } from "../components/RichText.tsx";
import type { Message } from "../../shared/schema.ts";
import type { Expanded } from "./useFolds.ts";

/** 正文渲染高度超过 FOLD_OVER 才折叠，折起后留 FOLDED 高；只多出两三行的不折。 */
const FOLD_OVER = 420;
const FOLDED = 260;

export function MessageBody({
  message,
  expanded,
  toggle,
}: {
  message: Message;
  expanded: Expanded;
  /** anchor 是点击后要留在屏幕原位的元素。 */
  toggle: (part: keyof Expanded, anchor: HTMLElement) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const tall = useTallContent(content);
  const folded = tall && !expanded.body;
  return (
    <div className="markdown w-full min-w-0 rounded-[4px_13px_13px_13px] border border-[#eeede8] bg-[#f5f5f2] px-3.5 py-2.5 max-[560px]:px-3 max-[560px]:py-[9px] [.outgoing_&]:rounded-[13px_4px_13px_13px] [.outgoing_&]:border-[#e0e8f4] [.outgoing_&]:bg-[#eaf0fa]">
      <div
        ref={content}
        className={
          folded
            ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
            : undefined
        }
        style={folded ? { maxHeight: FOLDED } : undefined}
      >
        <RichText>{message.body}</RichText>
      </div>
      {tall && (
        <Toggle
          open={!folded}
          // 展开时继续读折线以下，正文顶端不动；收起时按钮不动。
          onClick={(event) =>
            toggle("body", folded ? content.current! : event.currentTarget)
          }
          label={folded ? "展开全文" : "收起"}
        />
      )}
      {message.details && (
        <>
          <Toggle
            open={!!expanded.details}
            onClick={(event) => toggle("details", event.currentTarget)}
            label={
              expanded.details
                ? "收起详情"
                : `详情 · ${message.details.length} 字`
            }
          />
          {expanded.details && (
            <div className="mt-1.5 border-t border-black/[0.07] pt-2">
              <RichText>{message.details}</RichText>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Toggle({
  open,
  label,
  onClick,
}: {
  open: boolean;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      aria-expanded={open}
      className="mt-1 flex items-center gap-1 p-0 text-xs leading-6 text-[#8e816b] hover:text-[#5d5446]"
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      {label}
    </button>
  );
}

/** 内容实际渲染高度是否超过折叠线；宽度变了行数跟着变，所以持续观察。 */
function useTallContent(ref: React.RefObject<HTMLDivElement | null>) {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // 折起时 scrollHeight 仍是全文高度，展开前后判断一致。
    const measure = () => setTall(element.scrollHeight > FOLD_OVER);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return tall;
}
