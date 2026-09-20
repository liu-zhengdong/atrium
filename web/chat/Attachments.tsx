import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import type { Attachment } from "../../shared/schema.ts";

export function attachmentUrl(id: string) {
  return `/api/attachments/${id}`;
}

const FILE_COLORS: Record<string, string> = {
  pdf: "#b56a4a",
  doc: "#3d6bb3",
  docx: "#3d6bb3",
  xls: "#2f7d4a",
  xlsx: "#2f7d4a",
  ppt: "#b56a4a",
  pptx: "#b56a4a",
  zip: "#8a7150",
  gz: "#8a7150",
  png: "#5b7c99",
  jpg: "#5b7c99",
  jpeg: "#5b7c99",
  gif: "#5b7c99",
  webp: "#5b7c99",
  md: "#76674c",
  txt: "#76674c",
};

function extOf(name: string) {
  return name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024)
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageAttachments({
  attachments,
}: {
  attachments: Attachment[];
}) {
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");
  const [open, setOpen] = useState<number | null>(null);
  if (!attachments.length) return null;
  return (
    <div className="mt-1.5 flex w-full min-w-0 flex-col items-start gap-1.5 [.outgoing_&]:items-end">
      {images.length === 1 && (
        <button
          type="button"
          className="w-fit max-w-full overflow-hidden rounded-[10px] border border-[#eeede8] bg-[#f5f5f2] p-0 [.outgoing_&]:border-[#d9e3f0]"
          onClick={() => setOpen(0)}
        >
          <img
            src={attachmentUrl(images[0]!.id)}
            alt={images[0]!.name}
            className="block max-h-[200px] w-auto max-w-60 object-cover"
          />
        </button>
      )}
      {images.length > 1 && (
        <button
          type="button"
          className="relative h-[72px] p-0"
          style={{ width: 72 + Math.min(images.length, 4) * 14 }}
          aria-label={`${images.length} 张图片`}
          onClick={() => setOpen(0)}
        >
          {images.slice(0, 4).map((item, index) => (
            <img
              key={item.id}
              src={attachmentUrl(item.id)}
              alt=""
              className="absolute top-0 h-[72px] w-[72px] rounded-[10px] border-2 border-white object-cover shadow-[0_1px_4px_#30220d18]"
              style={{ left: index * 14, zIndex: index }}
            />
          ))}
          <span className="absolute -right-1 -top-1 z-[5] min-w-[20px] rounded-full bg-[#45463c] px-1.5 py-0.5 text-center text-[10px] font-[550] leading-none text-white">
            {images.length}
          </span>
        </button>
      )}
      {files.map((item) => (
        <FileCard key={item.id} item={item} />
      ))}
      {open !== null && images.length > 0 && (
        <Lightbox
          images={images}
          index={open}
          onClose={() => setOpen(null)}
          onIndex={setOpen}
        />
      )}
    </div>
  );
}

function FileCard({ item }: { item: Attachment }) {
  const ext = extOf(item.name);
  const color = FILE_COLORS[ext] ?? "#8a7150";
  return (
    <a
      href={attachmentUrl(item.id)}
      download={item.name}
      className="flex max-w-full items-center gap-2.5 rounded-[10px] border border-[#eeede8] bg-white px-2.5 py-2 no-underline [.outgoing_&]:border-[#d9e3f0] [.outgoing_&]:bg-[#f7f9fc]"
    >
      <span
        className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-[10px] font-[650] uppercase tracking-wide text-white"
        style={{ background: color }}
      >
        {ext.slice(0, 4) || <FileText size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-[12px] font-[550] text-[#3f3e38]">
          {item.name}
        </strong>
        <span className="text-[10px] text-[#8e8779]">
          {formatSize(item.size)}
        </span>
      </span>
    </a>
  );
}

function Lightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: Attachment[];
  index: number;
  onClose: () => void;
  onIndex: (index: number) => void;
}) {
  const current = images[index] ?? images[0]!;
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft")
        onIndex((index - 1 + images.length) % images.length);
      if (e.key === "ArrowRight") onIndex((index + 1) % images.length);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [index, images.length, onClose, onIndex]);
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-[#1c1b18]/88"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
    >
      <div className="flex items-center justify-between px-4 py-3 text-[12px] text-[#f4f1ea]">
        <span className="truncate">
          {current.name}
          {images.length > 1 ? `  ·  ${index + 1} / ${images.length}` : ""}
        </span>
        <button
          type="button"
          className="icon-button text-[#f4f1ea] hover:bg-white/10"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14">
        {images.length > 1 && (
          <button
            type="button"
            className="icon-button absolute left-4 text-[#f4f1ea] hover:bg-white/10"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index - 1 + images.length) % images.length);
            }}
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <img
          src={attachmentUrl(current.id)}
          alt={current.name}
          className="max-h-full max-w-full object-contain"
          onClick={(e) => e.stopPropagation()}
        />
        {images.length > 1 && (
          <button
            type="button"
            className="icon-button absolute right-4 text-[#f4f1ea] hover:bg-white/10"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index + 1) % images.length);
            }}
          >
            <ChevronRight size={22} />
          </button>
        )}
      </div>
      {images.length > 1 && (
        <div className="flex shrink-0 justify-center gap-2 px-4 pb-5 pt-2">
          {images.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={`h-12 w-12 overflow-hidden rounded-lg border-2 p-0 ${i === index ? "border-[#e8a87c]" : "border-transparent opacity-70 hover:opacity-100"}`}
              aria-label={`第 ${i + 1} 张`}
              onClick={(e) => {
                e.stopPropagation();
                onIndex(i);
              }}
            >
              <img
                src={attachmentUrl(item.id)}
                alt=""
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function StagedChip({
  item,
  onRemove,
}: {
  item: Attachment;
  onRemove: () => void;
}) {
  return (
    <span className="relative flex max-w-[160px] items-center gap-1.5 rounded-lg border border-[#e8e4db] bg-[#f7f5ef] py-1 pl-1 pr-7">
      {item.kind === "image" ? (
        <img
          src={attachmentUrl(item.id)}
          alt=""
          className="h-8 w-8 flex-none rounded-md object-cover"
        />
      ) : (
        <span
          className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-[9px] font-[650] uppercase text-white"
          style={{ background: FILE_COLORS[extOf(item.name)] ?? "#8a7150" }}
        >
          {extOf(item.name).slice(0, 4) || <FileText size={14} />}
        </span>
      )}
      <span className="min-w-0 truncate text-[11px] text-[#4a473e]">
        {item.name}
      </span>
      <button
        type="button"
        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[#8e8779] hover:bg-[#ece8df] hover:text-[#3c3b34]"
        aria-label={`移除 ${item.name}`}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export async function uploadAttachment(file: File) {
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
      "X-Mime": file.type || "application/octet-stream",
    },
    body: file,
  });
  const value = (await response.json()) as { error?: string } & Attachment;
  if (!response.ok)
    throw new Error(value.error ?? `请求失败（${response.status}）`);
  return value;
}
