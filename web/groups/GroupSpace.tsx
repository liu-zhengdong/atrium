import { Fragment, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  Copy,
  Download,
  File,
  FileImage,
  FileText,
} from "lucide-react";
import { RichText } from "../components/RichText.tsx";
import { spaceFileKind, type SpaceListing } from "../../shared/space.ts";
import { useJson } from "../useJson.ts";
import { convTime } from "../time.ts";

const fileUrl = (chatId: string, path: string) =>
  `/api/chats/${chatId}/space/file?path=${encodeURIComponent(path)}`;

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const ICONS = {
  markdown: FileText,
  text: FileText,
  image: FileImage,
  other: File,
};

/** 群共享目录：成员直接读写的文件，这里只列出和预览。群里有新消息时重新列一次。 */
export function GroupSpace({
  chatId,
  revision,
}: {
  chatId: string;
  revision: number;
}) {
  const { data, error } = useJson<SpaceListing>(
    `/chats/${chatId}/space`,
    revision,
  );
  // 重新列目录时保留上一次的结果，免得每来一条消息列表就闪一下。
  const last = useRef<SpaceListing | undefined>(undefined);
  if (data) last.current = data;
  const listing = data ?? last.current;
  const [open, setOpen] = useState<string | null>(null);
  if (open)
    return (
      <SpacePreview chatId={chatId} path={open} back={() => setOpen(null)} />
    );
  return (
    <div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!listing && !error && <p className="muted">读取中…</p>}
      {listing && (
        <>
          <SpacePath path={listing.path} />
          {listing.files.length === 0 ? (
            <p className="muted py-6 text-center text-[12.5px]">还没有文件</p>
          ) : (
            <ul className="m-0 mt-2 list-none p-0">
              {listing.files.map((file) => {
                const Icon = ICONS[spaceFileKind(file.path).kind];
                const slash = file.path.lastIndexOf("/");
                return (
                  <li key={file.path}>
                    <button
                      className="flex w-full items-start gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-[#f6f5f0]"
                      onClick={() => setOpen(file.path)}
                    >
                      <Icon
                        size={16}
                        className="mt-px flex-none text-[#a39b8b]"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 break-all text-[13px] leading-5 text-[#45463c]">
                        {slash >= 0 && (
                          <span className="text-[#a39b8b]">
                            {file.path.slice(0, slash + 1)}
                          </span>
                        )}
                        {file.path.slice(slash + 1)}
                      </span>
                      <span className="flex-none text-[11.5px] leading-5 text-[#a39b8b]">
                        {convTime(file.mtime)} · {size(file.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {listing.truncated && (
            <p className="muted mt-2 text-[11.5px]">只列出最近修改的 300 个</p>
          )}
        </>
      )}
    </div>
  );
}

/** 目录的绝对路径，给用户复制到终端或编辑器里用。 */
function SpacePath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-start gap-2 rounded-[8px] bg-[#f6f5f0] px-3 py-2">
      {/* 只在 / 后面换行，路径不被拆在目录名中间。 */}
      <code className="min-w-0 flex-1 text-[11.5px] leading-[18px] text-[#6f6a5e] [overflow-wrap:anywhere]">
        {path.split("/").map((part, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <>
                /<wbr />
              </>
            )}
            {part}
          </Fragment>
        ))}
      </code>
      <button
        className="flex-none p-0 text-[#a39b8b] hover:text-[#5f5a4e]"
        aria-label={copied ? "已复制" : "复制路径"}
        title={copied ? "已复制" : "复制路径"}
        onClick={() =>
          void navigator.clipboard.writeText(path).then(() => setCopied(true))
        }
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

/** 单个文件：Markdown 渲染，文本原样，图片直接显示，其他只给下载。 */
function SpacePreview({
  chatId,
  path,
  back,
}: {
  chatId: string;
  path: string;
  back: () => void;
}) {
  const { kind } = spaceFileKind(path);
  const url = fileUrl(chatId, path);
  const [text, setText] = useState<{ body?: string; error?: string }>({});
  useEffect(() => {
    if (kind !== "markdown" && kind !== "text") return;
    let alive = true;
    fetch(url)
      .then(async (response) => {
        if (!response.ok)
          throw new Error((await response.json()).error ?? "读取失败");
        return response.text();
      })
      .then(
        (body) => alive && setText({ body }),
        (error) => alive && setText({ error: String(error.message ?? error) }),
      );
    return () => {
      alive = false;
    };
  }, [url, kind]);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          className="flex flex-none items-center gap-0.5 p-0 text-[12.5px] text-[#8e8779] hover:text-[#5f5a4e]"
          onClick={back}
        >
          <ChevronLeft size={16} aria-hidden />
          共享目录
        </button>
        <span className="min-w-0 flex-1 truncate text-right text-[12.5px] text-[#45463c]">
          {path}
        </span>
        <a
          className="flex-none text-[#a39b8b] hover:text-[#5f5a4e]"
          href={url}
          download={path.split("/").pop()}
          aria-label="下载"
          title="下载"
        >
          <Download size={15} />
        </a>
      </div>
      {text.error && (
        <p className="error" role="alert">
          {text.error}
        </p>
      )}
      {kind === "markdown" && text.body !== undefined && (
        <div className="markdown">
          <RichText>{text.body}</RichText>
        </div>
      )}
      {kind === "text" && text.body !== undefined && (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] bg-[#f7f6f2] p-3 text-[12px] leading-[1.7] text-[#42423c]">
          {text.body}
        </pre>
      )}
      {kind === "image" && (
        <img src={url} alt={path} className="max-w-full rounded-[8px]" />
      )}
      {kind === "other" && <p className="muted">这个类型不能预览，可以下载</p>}
    </div>
  );
}
