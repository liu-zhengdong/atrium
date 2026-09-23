/** 群共享目录里的一个文件；path 是目录内的相对路径，用 / 分隔。 */
export type SpaceFile = { path: string; size: number; mtime: number };
export type SpaceListing = {
  /** 目录的绝对路径，成员用自己的读写工具直接改。 */
  path: string;
  files: SpaceFile[];
  /** 文件太多或层级太深，没有列全。 */
  truncated: boolean;
};

const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const TEXT = new Set(
  "txt log json jsonl csv tsv yaml yml toml ini xml html css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp sh sql diff patch".split(
    " ",
  ),
);

/** 按扩展名决定怎么预览、以什么类型返回；服务端与界面共用这一处。 */
export function spaceFileKind(path: string) {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "md" || ext === "markdown")
    return { kind: "markdown", mime: "text/plain; charset=utf-8" } as const;
  if (TEXT.has(ext))
    return { kind: "text", mime: "text/plain; charset=utf-8" } as const;
  if (IMAGES[ext]) return { kind: "image", mime: IMAGES[ext] } as const;
  return { kind: "other", mime: "application/octet-stream" } as const;
}
