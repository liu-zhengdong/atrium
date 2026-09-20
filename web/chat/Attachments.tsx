import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import type { Attachment } from "../../shared/schema.ts";

export function attachmentUrl(id: string) {
  return `/api/attachments/${id}`;
}

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
          className="w-fit max-w-full overflow-hidden rounded-[10px] border border-[#e7e4da] bg-white p-[3px] shadow-[0_2px_8px_#312b1c14]"
          onClick={() => setOpen(0)}
        >
          <img
            src={attachmentUrl(images[0]!.id)}
            alt={images[0]!.name}
            className="block max-h-[200px] w-auto max-w-60 rounded-[7px] object-cover"
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
          <span className="absolute right-0 bottom-1 z-[5] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-black/55 px-1 text-[10px] leading-none font-semibold text-white backdrop-blur-[2px]">
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
  return (
    <a
      href={attachmentUrl(item.id)}
      download={item.name}
      className="flex max-w-full items-center gap-2.5 rounded-[10px] border border-[#e7e4da] bg-white px-2.5 py-2 no-underline transition-colors hover:border-[#d8d2c2]"
    >
      <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-[#f4f1ea] text-[#8a8374]">
        <FileText size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-[12px] font-[550] text-[#3f3e38]">
          {item.name}
        </strong>
        <span className="text-[10px] text-[#8e8779]">
          {formatSize(item.size)}
          {ext ? ` · ${ext.toUpperCase()}` : ""}
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
    <span className="relative flex max-w-[170px] items-center gap-1.5 rounded-lg border border-[#e7e4da] bg-white py-1 pr-7 pl-1">
      {item.kind === "image" ? (
        <img
          src={attachmentUrl(item.id)}
          alt=""
          className="h-8 w-8 flex-none rounded-md border border-[#eeeae0] object-cover"
        />
      ) : (
        <span className="grid h-8 w-8 flex-none place-items-center rounded-md bg-[#f4f1ea] text-[#8a8374]">
          <FileText size={14} />
        </span>
      )}
      <span className="min-w-0 truncate text-[11px] text-[#4a473e]">
        {item.name}
      </span>
      <button
        type="button"
        className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[#b8b2a2] hover:bg-[#f5f2ec] hover:text-[#57503f]"
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
