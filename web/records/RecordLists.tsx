import { Download, FileText } from "lucide-react";
import type { FileRecord, MessageHit, Overview } from "../../shared/schema.ts";
import { attachmentUrl, formatSize } from "../chat/Attachments.tsx";
import { convTime } from "../time.ts";
import { useRecordPages } from "./useRecordPages.ts";
import type { RecordFilters } from "./query.ts";

type Props = {
  filters: RecordFilters;
  /** 是否已经限定了单个会话：限定了就不用每条都重复会话名。 */
  scoped: boolean;
  openMessage: (chatId: string, messageId: number) => void;
};

/** 三块内容的加载态、错误态、空态和「加载更早的」长一个样，收在这里。 */
function Frame({
  loading,
  error,
  empty,
  more,
  loadMore,
  children,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  more: boolean;
  loadMore: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-[35px] py-4 max-[720px]:px-[22px]">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {children}
      {loading && <p className="muted mt-3">读取中…</p>}
      {!loading && !error && empty && (
        <p className="muted mt-3">没有符合条件的记录。</p>
      )}
      {more && !loading && (
        <button className="button mt-4" onClick={loadMore}>
          加载更早的
        </button>
      )}
    </div>
  );
}

/** 一条记录的来源：会话名与时间。限定了单个会话时只显示时间。 */
function Origin({
  scoped,
  chatName,
  at,
}: {
  scoped: boolean;
  chatName: string;
  at: number;
}) {
  return (
    <span className="muted small-text flex-none">
      {scoped ? "" : `${chatName} · `}
      {convTime(at)}
    </span>
  );
}

export function MessageRecords({
  filters,
  scoped,
  openMessage,
  chats,
}: Props & { chats: Overview["chats"] }) {
  const { items, more, loading, error, loadMore } = useRecordPages<MessageHit>(
    "messages",
    filters,
    (item) => item.id,
  );
  return (
    <Frame
      loading={loading}
      error={error}
      empty={!items.length}
      more={more}
      loadMore={loadMore}
    >
      <ul className="m-0 list-none p-0">
        {items.map((hit) => (
          <li key={`${hit.chat_id}:${hit.id}`}>
            <button
              className="block w-full rounded-xl px-3.5 py-3 text-left transition-colors hover:bg-[#f2f6f3]"
              title="回到这条消息"
              onClick={() => openMessage(hit.chat_id, hit.id)}
            >
              <span className="flex items-baseline justify-between gap-3">
                <strong className="truncate text-xs font-semibold text-ink">
                  {hit.sender_name}
                </strong>
                <Origin
                  scoped={
                    scoped ||
                    (chats.find((chat) => chat.id === hit.chat_id)?.kind ===
                      "direct" &&
                      hit.chat_name === hit.sender_name)
                  }
                  chatName={hit.chat_name}
                  at={hit.created_at}
                />
              </span>
              <span className="mt-1 line-clamp-2 overflow-hidden [overflow-wrap:anywhere] text-xs leading-relaxed text-ink/75">
                {hit.text}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

export function ImageRecords({ filters, scoped, openMessage }: Props) {
  const { items, more, loading, error, loadMore } = useRecordPages<FileRecord>(
    "images",
    filters,
    (item) => item.cursor,
  );
  return (
    <Frame
      loading={loading}
      error={error}
      empty={!items.length}
      more={more}
      loadMore={loadMore}
    >
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 p-0">
        {items.map((file) => (
          <li key={file.id}>
            <button
              className="group block w-full overflow-hidden rounded-xl border border-line bg-[#f8faf8] text-left transition-all hover:border-line-hover hover:shadow-[0_2px_8px_rgba(24,32,25,0.04)]"
              title={`${file.name} · ${scoped ? "" : `${file.chat_name} · `}${file.uploader_name}`}
              onClick={() => openMessage(file.chat_id, file.message_id)}
            >
              <img
                className="block aspect-square w-full object-cover"
                src={attachmentUrl(file.id)}
                alt={file.name}
                loading="lazy"
              />
              <span className="block truncate px-2.5 py-2 text-[11px] text-muted group-hover:text-ink">
                {scoped ? file.uploader_name : file.chat_name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

export function FileRecords({ filters, scoped, openMessage }: Props) {
  const { items, more, loading, error, loadMore } = useRecordPages<FileRecord>(
    "files",
    filters,
    (item) => item.cursor,
  );
  return (
    <Frame
      loading={loading}
      error={error}
      empty={!items.length}
      more={more}
      loadMore={loadMore}
    >
      <ul className="m-0 list-none p-0">
        {items.map((file) => (
          <li
            key={file.id}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-[#f2f6f3]"
          >
            <span className="flex-none text-muted">
              <FileText size={16} />
            </span>
            <button
              className="min-w-0 flex-1 text-left"
              title="回到这条消息"
              onClick={() => openMessage(file.chat_id, file.message_id)}
            >
              <span className="block truncate text-xs font-medium text-ink">
                {file.name}
              </span>
              <span className="muted text-[11px]">
                {file.uploader_name} · {formatSize(file.size)}
                {scoped ? "" : ` · ${file.chat_name}`}
              </span>
            </button>
            <Origin scoped chatName={file.chat_name} at={file.created_at} />
            <a
              className="icon-button flex-none"
              href={attachmentUrl(file.id)}
              download={file.name}
              aria-label={`下载 ${file.name}`}
            >
              <Download size={15} />
            </a>
          </li>
        ))}
      </ul>
    </Frame>
  );
}
