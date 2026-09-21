import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useJson } from "../useJson.ts";

type Hit = {
  id: number;
  sender: string;
  sender_name: string;
  text: string;
  created_at: number;
};

/** 只搜这个会话的正文，命中后跳回原消息。 */
export function ChatSearch({
  chatId,
  openMessage,
}: {
  chatId: string;
  openMessage: (messageId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, error, loading } = useJson<{ items: Hit[] }>(
    settled ? `/chats/${chatId}/search?q=${encodeURIComponent(settled)}` : null,
  );
  const hits = data?.items ?? [];
  return (
    <div>
      {/* 图标跟 input 并排，不用绝对定位——.field 的背景与内边距会盖掉它。 */}
      <div className="flex items-center gap-2 rounded-[7px] border border-line bg-white px-3 py-2 focus-within:border-[#c4b9a4]">
        <Search size={15} className="flex-none text-[#a09b8d]" />
        <input
          className="plain-field min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink"
          value={query}
          placeholder="搜这个群的消息"
          aria-label="搜索群消息"
          autoComplete="off"
          data-autofocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="muted mt-3">搜索中…</p>}
      {!loading && settled && !hits.length && (
        <p className="muted mt-3">没有匹配的消息。</p>
      )}
      <ul className="m-0 mt-2 list-none p-0">
        {hits.map((hit) => (
          <li key={hit.id}>
            <button
              className="block w-full rounded-[9px] px-2 py-2.5 text-left hover:bg-[#f6f5f0]"
              onClick={() => openMessage(hit.id)}
            >
              <span className="flex items-baseline justify-between gap-2">
                <strong className="truncate text-[12.5px] font-[550]">
                  {hit.sender_name}
                </strong>
                <span className="muted small-text flex-none">
                  {new Date(hit.created_at).toLocaleDateString()}
                </span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[12px] text-[#6f6a5e]">
                {hit.text}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
