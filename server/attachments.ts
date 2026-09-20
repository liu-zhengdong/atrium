import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "node:path";

export const MAX_ATTACHMENTS = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

export function sniffImage(bytes: Buffer): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      bytes.subarray(0, 6).equals(Buffer.from("GIF89a")))
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
  )
    return "image/webp";
  return null;
}

export function mimeFromName(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function safeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[\0\n\r]/g, "")
    .trim();
  return (base || "file").slice(0, 120);
}

export function classify(
  claimed: string,
  bytes: Buffer,
): { kind: "image" | "file"; mime: string } {
  const sniffed = sniffImage(bytes);
  const claimedMime = claimed === "image/jpg" ? "image/jpeg" : claimed;
  if (claimedMime.startsWith("image/") || IMAGE_MIMES.has(claimedMime)) {
    if (!sniffed) throw new Error("不是有效图片");
    if (
      claimedMime !== "application/octet-stream" &&
      claimedMime.startsWith("image/") &&
      claimedMime !== sniffed
    )
      throw new Error("图片类型与内容不一致");
    return { kind: "image", mime: sniffed };
  }
  return {
    kind: sniffed ? "image" : "file",
    mime: sniffed ?? (claimed || "application/octet-stream"),
  };
}

export function readFromCwd(
  cwd: string,
  path: string,
): { name: string; mime: string; bytes: Buffer } {
  const resolved = resolveInside(cwd, path);
  const name = basename(resolved);
  return { name, mime: mimeFromName(name), bytes: readFileSync(resolved) };
}

export function resolveInside(root: string, input: string): string {
  if (!input || input.includes("\0")) throw new Error("无效的文件路径");
  const base = realpathSync(root);
  const candidate = isAbsolute(input) ? input : join(base, input);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new Error("文件不存在");
  }
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("只能发送工作目录内的文件");
  if (!statSync(resolved).isFile()) throw new Error("只能发送普通文件");
  return resolved;
}

export function excerptOf(
  body: string,
  attachments: { kind: string; name: string }[],
): string {
  if (body.trim()) return body.slice(0, 100);
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind === "file");
  if (images.length && !files.length)
    return images.length === 1 ? "[图片]" : `[图片 ×${images.length}]`;
  if (files.length === 1 && !images.length) return files[0]!.name;
  if (!images.length && files.length) return `[文件 ×${files.length}]`;
  if (images.length && files.length)
    return `[${images.length} 张图片, ${files.length} 个文件]`;
  return "";
}

export function materialize(
  cwd: string,
  id: string,
  name: string,
  bytes: Buffer,
): string {
  const dir = join(cwd, ".atrium-inbox");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${id}-${safeFileName(name)}`);
  if (!existsSync(dest)) writeFileSync(dest, bytes);
  return dest;
}

export class AttachmentFiles {
  private memory = new Map<string, Buffer>();
  constructor(private dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  put(id: string, bytes: Buffer) {
    if (this.dir) writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    else this.memory.set(id, bytes);
  }
  get(id: string): Buffer {
    if (this.dir) {
      const path = join(this.dir, id);
      if (!existsSync(path)) throw new Error("附件不存在");
      return readFileSync(path);
    }
    const bytes = this.memory.get(id);
    if (!bytes) throw new Error("附件不存在");
    return bytes;
  }
  remove(id: string) {
    if (this.dir) {
      const path = join(this.dir, id);
      if (existsSync(path)) unlinkSync(path);
    }
    this.memory.delete(id);
  }
}

export function attachmentsDir(sqlitePath: string): string | null {
  if (sqlitePath === ":memory:") return null;
  return join(dirname(sqlitePath), "attachments");
}
