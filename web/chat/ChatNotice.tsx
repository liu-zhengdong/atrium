import { useState } from "react";
import { Megaphone } from "lucide-react";

/** 群公告：默认一行，点开看全文。 */
export function ChatNotice({ notice }: { notice: string }) {
  const [open, setOpen] = useState(false);
  if (!notice) return null;
  return (
    <button
      className="flex w-full items-start gap-2 border-b border-[#eadfc8] bg-[#faf6ed] px-[35px] py-2 text-left text-[11.5px] leading-[1.7] text-[#7a6849] max-[560px]:px-[18px]"
      aria-expanded={open}
      title={open ? "收起公告" : "展开公告"}
      onClick={() => setOpen(!open)}
    >
      <Megaphone size={13} className="mt-0.5 flex-none text-[#b39a6a]" />
      <span
        className={`min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] ${open ? "" : "line-clamp-1"}`}
      >
        {notice}
      </span>
    </button>
  );
}
