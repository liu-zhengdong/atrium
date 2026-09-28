import { Problem } from "../problem.ts";

/**
 * 资料（t192 第 1 步）：挂在组织节点上的设计稿、调研报告这类文件或目录，短号 mN 全局持久、不复用。
 * 这里只放纯函数（穷举测试）：短号、路径与名称校验、上传校验、关联、清理线索与真删判定。
 * 落库与读写文件在 store.ts，周期任务顺带发线索在 hints.ts，接口在 routes.ts。
 */

/** 单个版本的总大小上限：超了让加的人压缩或放外链，不静默截断。 */
export const MATERIAL_MAX_BYTES = 20 * 1024 * 1024;
export const MATERIAL_MAX_FILES = 500;
export const NAME_MAX = 80;
export const NOTE_MAX = 200;
/** 一份资料最多关联几项（任务、要点、决定）。 */
export const LINKS_MAX = 20;
/** 每份资料留最近几条读取记录。 */
export const READS_KEPT = 50;
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

const DAY = 24 * 60 * 60 * 1000;
/** 清理线索的门槛（u1 09-28 定）。 */
export const STALE_MS = 90 * DAY;
/** 同一份疑似没用的资料，线索发过后隔多久才再提（leader 没决定的）。 */
export const HINT_AGAIN_MS = 30 * DAY;
/** 归档超过一年且大于 10 MB 的，列给用户确认后才真删。 */
export const PURGE_ARCHIVED_MS = 365 * DAY;
export const PURGE_MIN_BYTES = 10 * 1024 * 1024;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

export const materialRef = (id: number) => `m${id}`;

export function parseMaterialRef(value: unknown, field = "资料"): number {
  const match =
    typeof value === "string"
      ? /^m([1-9][0-9]{0,15})$/.exec(value.trim())
      : null;
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw usage(`${field}: 资料短号应为 m1 这样的格式`, "atrium material ls");
  return id;
}

/**
 * 一段路径名（文件名、目录名）的毛病；没毛病返回 null。纯函数。
 * 拒绝空段、`.` `..`、隐藏段（以 . 开头）、反斜杠、冒号（Windows 盘符与流）、控制字符。
 */
export function segmentProblem(segment: string): string | null {
  if (!segment) return "有空的一段";
  if (segment === "." || segment === "..") return "不能含 . 或 ..";
  if (segment.startsWith(".")) return `不能含隐藏的一段（${segment}）`;
  if (/[\\:]/.test(segment)) return `不能含反斜杠或冒号（${segment}）`;
  if (/[\u0000-\u001f\u007f]/.test(segment)) return "不能含控制字符";
  if (Array.from(segment).length > 255) return "有一段超过 255 字";
  return null;
}

/** 资料里一个文件的相对路径（用 / 分段）的毛病；绝对路径、盘符、越界都拒绝。纯函数。 */
export function pathProblem(path: string): string | null {
  if (typeof path !== "string" || !path) return "路径不能为空";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("\\"))
    return `不能是绝对路径（${path}）`;
  if (Array.from(path).length > 1024) return "路径超过 1024 字";
  for (const segment of path.split("/")) {
    const problem = segmentProblem(segment);
    if (problem) return `${problem}：${path}`;
  }
  return null;
}

/** 资料名称：一段安全的名字（取文件或目录名），get 时就用它落盘。 */
export function nameOf(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw usage("--name: 名称不能为空");
  if (Array.from(text).length > NAME_MAX)
    throw usage(`--name: 名称不能超过 ${NAME_MAX} 字`);
  if (text.includes("/")) throw usage("--name: 名称不能含 /");
  const problem = segmentProblem(text);
  if (problem) throw usage(`--name: 名称${problem}`);
  return text;
}

/** 一句话说明（新资料必填）、归档与留下的原因。 */
export function noteOf(
  value: unknown,
  flag = "--note",
  required = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw usage(`${flag}: 要写一句话`);
    return null;
  }
  if (typeof value !== "string") throw usage(`${flag}: 应为文本`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    if (required) throw usage(`${flag}: 要写一句话`);
    return null;
  }
  if (Array.from(text).length > NOTE_MAX)
    throw usage(`${flag}: 不能超过 ${NOTE_MAX} 字`);
  return text;
}

export type LinkKind = "task" | "point" | "decision";
export type Link = { kind: LinkKind; id: number };
const LINK_PREFIX: Record<string, LinkKind> = {
  t: "task",
  k: "point",
  d: "decision",
};
export const linkRef = (link: Link) =>
  `${{ task: "t", point: "k", decision: "d" }[link.kind]}${link.id}`;

/** 关联：t120,k3,d5 或数组；去重，最多 LINKS_MAX 项。纯函数。 */
export function parseLinks(value: unknown): Link[] {
  if (value === undefined || value === null || value === "") return [];
  const items = (Array.isArray(value) ? value : String(value).split(/[,，\s]+/))
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const item of items) {
    const match = /^([tkd])([1-9][0-9]{0,15})$/.exec(item);
    if (!match)
      throw usage(
        `--for: ${item} 不是任务 tN、要点 kN 或决定 dN（多个用逗号隔开）`,
      );
    const link = { kind: LINK_PREFIX[match[1]!]!, id: Number(match[2]) };
    if (seen.has(linkRef(link))) continue;
    seen.add(linkRef(link));
    links.push(link);
  }
  if (links.length > LINKS_MAX) throw usage(`--for: 最多关联 ${LINKS_MAX} 项`);
  return links;
}

export type UploadFile = { path: string; bytes: Buffer };
export type Upload = {
  node: string;
  kind: "file" | "dir";
  name: string;
  note: string | null;
  supersedes: number | null;
  links: Link[];
  files: UploadFile[];
  size: number;
};

export const sizeText = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const tooBig = (size: number, max = MATERIAL_MAX_BYTES) =>
  `资料 ${sizeText(size)}，超过上限 ${sizeText(max)}；压缩后再加（截图转成小一些的格式、删掉不用的文件），或把大文件放到网盘、仓库，只在 --note 里写链接`;

/** 上传校验（纯函数）：只认列出的字段；路径逐个过 pathProblem，不重名；数量与总大小有上限。 */
export function validateUpload(
  body: unknown,
  max = MATERIAL_MAX_BYTES,
): Upload {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (
      !["node", "kind", "name", "note", "supersedes", "for", "files"].includes(
        key,
      )
    )
      throw usage(`${key}: 是未知字段`);
  if (typeof input.node !== "string" || !input.node.trim())
    throw usage("节点: 要挂在哪个节点上，如 o4 或 atrium/org");
  const kind =
    input.kind === "file" || input.kind === "dir" ? input.kind : null;
  if (!kind) throw usage("kind: 应为 file 或 dir");
  const name = nameOf(input.name);
  if (!Array.isArray(input.files) || !input.files.length)
    throw usage("文件|目录: 没有可加的文件（隐藏文件不收）");
  if (input.files.length > MATERIAL_MAX_FILES)
    throw usage(
      `文件|目录: ${input.files.length} 个文件，超过上限 ${MATERIAL_MAX_FILES} 个；打成压缩包再加`,
    );
  const seen = new Set<string>();
  let size = 0;
  const files: UploadFile[] = [];
  for (const raw of input.files) {
    const file = (raw ?? {}) as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const problem = pathProblem(path);
    if (problem) throw usage(`文件|目录: ${problem}`);
    if (seen.has(path)) throw usage(`文件|目录: ${path} 重复`);
    seen.add(path);
    if (
      typeof file.data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      throw usage(`文件|目录: ${path} 的内容应为 base64`);
    const bytes = Buffer.from(file.data, "base64");
    size += bytes.length;
    if (size > max) throw usage(tooBig(size, max));
    files.push({ path, bytes });
  }
  if (kind === "file" && (files.length !== 1 || files[0]!.path !== name))
    throw usage("文件|目录: 单个文件的资料只收这一个文件，路径就是名称");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    node: input.node.trim(),
    kind,
    name,
    note: noteOf(input.note),
    supersedes:
      input.supersedes === undefined ||
      input.supersedes === null ||
      input.supersedes === ""
        ? null
        : parseMaterialRef(input.supersedes, "--supersedes"),
    links: parseLinks(input.for),
    files,
    size,
  };
}

/** 清理线索要的事实（store 取，这里只判）。 */
export type StaleFacts = {
  archived_at: number | null;
  keep_at: number | null;
  superseded_by: number | null;
  /** 当前版本加上去的时间。 */
  updated_at: number;
  last_read_at: number | null;
  /** 关联的任务、要点、决定各自是否已结束（任务结束、要点删了、决定被推翻或不在了）。 */
  links: readonly boolean[];
};

export type Stale = { kind: "superseded" | "unused"; reason: string };

/**
 * 疑似没用（纯函数）：已归档、leader 写过「留」的不提；被新资料取代的提；
 * 90 天没读（从没读过按当前版本加上去的时间算）且关联都已结束（没关联算结束）的提。
 */
export function staleVerdict(facts: StaleFacts, now: number): Stale | null {
  if (facts.archived_at !== null || facts.keep_at !== null) return null;
  if (facts.superseded_by !== null)
    return {
      kind: "superseded",
      reason: `已被 ${materialRef(facts.superseded_by)} 取代`,
    };
  const since = Math.max(facts.last_read_at ?? 0, facts.updated_at);
  if (now - since < STALE_MS) return null;
  if (facts.links.some((ended) => !ended)) return null;
  const days = Math.floor((now - since) / DAY);
  return {
    kind: "unused",
    reason: `${facts.last_read_at === null ? "加上后 " : ""}${days} 天没人读${facts.links.length ? "，关联的都已结束" : ""}`,
  };
}

/** 线索发过的，隔 HINT_AGAIN_MS 再提；没发过的马上提。纯函数。 */
export const hintDue = (hinted_at: number | null, now: number) =>
  hinted_at === null || now - hinted_at >= HINT_AGAIN_MS;

/** 可以真删（要用户点头）：归档超过一年且大于 10 MB，还没问过。纯函数。 */
export function purgeVerdict(
  facts: {
    archived_at: number | null;
    bytes: number;
    purge_asked_at: number | null;
  },
  now: number,
): boolean {
  return (
    facts.archived_at !== null &&
    facts.purge_asked_at === null &&
    now - facts.archived_at >= PURGE_ARCHIVED_MS &&
    facts.bytes > PURGE_MIN_BYTES
  );
}
