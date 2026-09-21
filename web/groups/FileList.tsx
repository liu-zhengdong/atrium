import { useEffect, useState } from "react";
import { Download, FileText, ImageIcon } from "lucide-react";
import { api } from "../api.ts";
import { attachmentUrl, formatSize } from "../chat/Attachments.tsx";

type ChatFile = {
  id: string;
  message_id: number;
  kind: "image" | "file";
  name: string;
  size: number;
  created_at: number;
  uploader_name: string;
  cursor: number;
};
type FilePage = { items: ChatFile[]; has_more: boolean };

/** 群文件就是这个会话里发过的附件，按时间倒序。 */
export function FileList({
  chatId,
  openMessage,
}: {
  chatId: string;
  openMessage: (messageId: number) => void;
}) {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function load(before?: number) {
    setBusy(true);
    setError("");
    try {
      const page = await api<FilePage>(
        `/chats/${chatId}/files${before ? `?before=${before}` : ""}`,
      );
      setFiles((old) => (before ? [...old, ...page.items] : page.items));
      setMore(page.has_more);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [chatId]);
  return (
    <div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="m-0 list-none p-0">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex items-center gap-3 rounded-[9px] px-2 py-2.5 hover:bg-[#f6f5f0]"
          >
            <span className="flex-none text-[#a39b8b]">
              {file.kind === "image" ? (
                <ImageIcon size={16} />
              ) : (
                <FileText size={16} />
              )}
            </span>
            <button
              className="min-w-0 flex-1 text-left"
              title="回到这条消息"
              onClick={() => openMessage(file.message_id)}
            >
              <span className="block truncate text-[13px]">{file.name}</span>
              <span className="muted small-text">
                {file.uploader_name} · {formatSize(file.size)} ·{" "}
                {new Date(file.created_at).toLocaleDateString()}
              </span>
            </button>
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
      {busy && <p className="muted">读取中…</p>}
      {!busy && !files.length && (
        <p className="muted">这个群还没有发过文件或图片。</p>
      )}
      {more && (
        <button
          className="button mt-3"
          disabled={busy}
          onClick={() => void load(files.at(-1)?.cursor)}
        >
          加载更早的
        </button>
      )}
    </div>
  );
}
