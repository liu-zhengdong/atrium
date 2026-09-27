import YAML from "yaml";
import { Problem } from "../problem.ts";

/**
 * 组织技能（#264 第 3b 步）的纯函数：文件与元数据校验、派活时的生效集合、行级差异与三方合并。
 * 不读库、不碰文件系统；读写在 store.ts / mount.ts / collect.ts。
 */

export const LIMITS = {
  /** 一个技能最多几个文件（含 SKILL.md）。 */
  files: 32,
  /** 一个技能全部文件合计字节数。 */
  bytes: 256 * 1024,
  /** 一次派活最多挂几个技能。 */
  perTask: 8,
  /** 全库技能数（列表有界）。 */
  skills: 200,
  description: 1024,
  name: 100,
  /** 提议里执行者自述原因的字数。 */
  proposalReason: 2000,
  /** 附属文件的目录深度。 */
  depth: 4,
} as const;

export type Files = Record<string, string>;

const bad = (field: string, message: string): never => {
  throw new Problem(400, `${field} ${message}`, "usage");
};

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** slug 同时是挂载目录名和各工具里的技能名（Claude、codex、opencode 都要求小写英数与连字符）。 */
export function validateSkillSlug(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !SLUG_RE.test(value))
    return bad("slug", "只能用小写英数和单个连字符，长度 1–64，如 web-design");
  return value;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** 技能内的相对路径：不许绝对路径、`..`、隐藏段、反斜杠，深度有限。 */
export function validateFilePath(path: string): string {
  const segments = path.split("/");
  if (
    !path ||
    segments.length > LIMITS.depth ||
    segments.some((seg) => !SEGMENT.test(seg) || seg.length > 100)
  )
    return bad(
      `files.${path || "（空）"}`,
      `路径不合法：只能是技能目录内的相对路径，段名用英数、点、下划线或连字符，不以点开头，最多 ${LIMITS.depth} 层`,
    );
  return path;
}

/** 校验并规范化文件集合：必须有 SKILL.md，数量与总大小有上限，内容是文本；按路径排序。 */
export function validateFiles(value: unknown): Files {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad("files", "应为 {相对路径: 文本}");
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.some(([path]) => path === "SKILL.md"))
    return bad("files", "缺少 SKILL.md");
  if (entries.length > LIMITS.files)
    return bad("files", `超过 ${LIMITS.files} 个文件`);
  let total = 0;
  const out: Files = {};
  for (const [path, content] of entries.sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    validateFilePath(path);
    if (typeof content !== "string" || content.includes("\0"))
      return bad(`files.${path}`, "应为文本文件");
    total += Buffer.byteLength(content, "utf8");
    out[path] = content;
  }
  if (total > LIMITS.bytes)
    return bad("files", `合计 ${total} 字节，超过 ${LIMITS.bytes / 1024} KB`);
  return out;
}

/** 读 SKILL.md 的 frontmatter；没有 frontmatter 返回 null，格式坏了报错。 */
export function readFrontmatter(
  skillMd: string,
): Record<string, unknown> | null {
  const source = skillMd.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---", 4);
  if (end < 0) return bad("SKILL.md", "frontmatter 缺少结尾 ---");
  try {
    const parsed = YAML.parseDocument(source.slice(4, end), {
      uniqueKeys: true,
    });
    if (parsed.errors.length) return bad("SKILL.md", "frontmatter 格式错误");
    const data = parsed.toJS({ maxAliasCount: 100 }) ?? {};
    if (typeof data !== "object" || Array.isArray(data))
      return bad("SKILL.md", "frontmatter 应为键值对");
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Problem) throw error;
    return bad("SKILL.md", "frontmatter 格式错误");
  }
}

/**
 * 从 SKILL.md 取描述：frontmatter 的 name 必须等于 slug，description 必填（各工具「只读简介、按需展开」靠它）。
 * SKILL.md 没有 frontmatter 时，用调用方给的 description 补一段（只在新建和整体替换时）。
 */
export function skillMeta(
  slug: string,
  files: Files,
  description?: string,
): { files: Files; description: string } {
  const front = readFrontmatter(files["SKILL.md"]!);
  if (!front) {
    const text = description?.trim();
    if (!text)
      return bad(
        "description",
        "必填：SKILL.md 没有 frontmatter 时须用 --description 给出一句简介",
      );
    checkDescription(text);
    const header = YAML.stringify(
      { name: slug, description: text },
      { lineWidth: 0 },
    );
    return {
      files: {
        ...files,
        "SKILL.md": `---\n${header}---\n\n${files["SKILL.md"]}`,
      },
      description: text,
    };
  }
  if (front.name !== slug)
    return bad(
      "SKILL.md",
      `frontmatter 的 name 应为 ${slug}（与技能 slug 一致），现在是 ${front.name === undefined ? "（空）" : String(front.name)}`,
    );
  const text =
    typeof front.description === "string" ? front.description.trim() : "";
  if (!text) return bad("SKILL.md", "frontmatter 缺少 description");
  if (description?.trim() && description.trim() !== text)
    return bad(
      "description",
      "与 SKILL.md frontmatter 里的 description 不一致；改 SKILL.md 即可",
    );
  checkDescription(text);
  return { files, description: text };
}

function checkDescription(text: string) {
  if (Array.from(text).length > LIMITS.description)
    bad("description", `超过 ${LIMITS.description} 字`);
}

export function sameFiles(a: Files, b: Files): boolean {
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return ka.length === kb.length && ka.every((key) => a[key] === b[key]);
}

// ---- 生效集合 ----

/** 任务所在节点链（根 → 本节点）里的一环。 */
export type ChainNode = { id: number; ref: string; path: string };
export type Picked = { slug: string; via: string };
export type Effective = {
  picked: Picked[];
  /** 超出每次上限没挂上的。 */
  dropped: Picked[];
  /** 档案里写了但库里没有（或已归档）的 slug。 */
  unknown: string[];
};

const listOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

/** 地址（o7 或 atrium/web）命中节点链上的某一环：写父节点也覆盖子节点的活。 */
export function chainHit(
  chain: readonly ChainNode[],
  address: string,
): ChainNode | undefined {
  const text = address.trim().replace(/^\/+|\/+$/g, "");
  return chain.find((node) => node.ref === text || node.path === text);
}

/**
 * 生效集合 = 节点链上绑定的（根 → 本节点）∪ 档案 skills ∪ 档案 skills_for 里命中节点链的，去重；
 * 超过上限的按这个顺序截掉，记进 dropped。
 */
export function effectiveSkills(input: {
  chain: readonly ChainNode[];
  bound: ReadonlyMap<number, readonly string[]>;
  profile?: { skills?: unknown; skills_for?: unknown };
  known: ReadonlySet<string>;
  max?: number;
}): Effective {
  const max = input.max ?? LIMITS.perTask;
  const order: Picked[] = [];
  for (const node of input.chain)
    for (const slug of input.bound.get(node.id) ?? [])
      order.push({ slug, via: `${node.ref} ${node.path}` });
  for (const slug of listOf(input.profile?.skills))
    order.push({ slug, via: "执行者档案" });
  const scoped = input.profile?.skills_for;
  if (scoped && typeof scoped === "object" && !Array.isArray(scoped))
    for (const [address, slugs] of Object.entries(scoped)) {
      const hit = chainHit(input.chain, address);
      if (hit)
        for (const slug of listOf(slugs))
          order.push({ slug, via: `执行者档案（做 ${hit.path} 的活）` });
    }
  const seen = new Set<string>();
  const unknown: string[] = [];
  const picked: Picked[] = [];
  const dropped: Picked[] = [];
  for (const item of order) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    if (!input.known.has(item.slug)) {
      unknown.push(item.slug);
      continue;
    }
    (picked.length < max ? picked : dropped).push(item);
  }
  return { picked, dropped, unknown };
}

/** 档案 avoid_nodes 命中任务节点链时的跳过原因；不命中返回 undefined。 */
export function avoidReason(
  chain: readonly ChainNode[],
  avoid: unknown,
): string | undefined {
  for (const address of listOf(avoid)) {
    const hit = chainHit(chain, address);
    if (hit) return `档案 avoid_nodes 避开 ${hit.ref} ${hit.path}`;
  }
  return undefined;
}

// ---- 行级差异与三方合并 ----

/** 大于这个规模（行数乘积）不做逐行比对，整段当作改动。 */
const LCS_CELLS = 4_000_000;

/** 最长公共子序列的配对（a 下标 → b 下标）；规模过大返回 undefined。 */
function lcsPairs(a: string[], b: string[]): Map<number, number> | undefined {
  const n = a.length,
    m = b.length;
  if ((n + 1) * (m + 1) > LCS_CELLS) return undefined;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const pairs = new Map<number, number>();
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.set(i++, j++);
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

const lines = (text: string) => text.split("\n");

/** 逐行差异：`  ` 不变、`- ` 删除、`+ ` 新增；只留改动附近 context 行，其余折成「…」。 */
export function lineDiff(before: string, after: string, context = 2): string[] {
  const a = lines(before),
    b = lines(after);
  const pairs = lcsPairs(a, b);
  const out: { mark: " " | "-" | "+"; text: string }[] = [];
  if (!pairs) {
    out.push(...a.map((text) => ({ mark: "-" as const, text })));
    out.push(...b.map((text) => ({ mark: "+" as const, text })));
  } else {
    let i = 0,
      j = 0;
    for (const [pi, pj] of [...pairs, [a.length, b.length] as const]) {
      while (i < pi) out.push({ mark: "-", text: a[i++]! });
      while (j < pj) out.push({ mark: "+", text: b[j++]! });
      if (i < a.length && j < b.length) {
        out.push({ mark: " ", text: a[i]! });
        i++;
        j++;
      }
    }
  }
  const keep = out.map((line, index) =>
    out
      .slice(Math.max(0, index - context), index + context + 1)
      .some((near) => near.mark !== " "),
  );
  const result: string[] = [];
  out.forEach((line, index) => {
    if (keep[index]) result.push(`${line.mark} ${line.text}`);
    else if (keep[index - 1] || index === 0) result.push("…");
  });
  return result;
}

/** 文件集合的差异：每个有变化的文件一段。 */
export function filesDiff(before: Files, after: Files): string[] {
  const paths = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort();
  const out: string[] = [];
  for (const path of paths) {
    const a = before[path],
      b = after[path];
    if (a === b) continue;
    if (a === undefined)
      out.push(`新增 ${path}`, ...lines(b!).map((line) => `+ ${line}`));
    else if (b === undefined)
      out.push(`删除 ${path}`, ...lines(a).map((line) => `- ${line}`));
    else out.push(`修改 ${path}`, ...lineDiff(a, b));
  }
  return out;
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * 三方合并一段文本（diff3）：以 base 为准找两边都没动的稳定行，稳定行之间的块只有一边改了就取那一边，
 * 两边改得一样取任一边，否则算冲突（结果里不写冲突标记，冲突留给审核人）。
 */
export function merge3Text(
  base: string,
  ours: string,
  theirs: string,
): { text: string; conflict: boolean } {
  const b = lines(base),
    o = lines(ours),
    t = lines(theirs);
  const mo = lcsPairs(b, o),
    mt = lcsPairs(b, t);
  if (!mo || !mt)
    return ours === base
      ? { text: theirs, conflict: false }
      : theirs === base || theirs === ours
        ? { text: ours, conflict: false }
        : { text: ours, conflict: true };
  const out: string[] = [];
  let conflict = false;
  let i = 0,
    j = 0,
    k = 0;
  while (i < b.length || j < o.length || k < t.length) {
    let next = i;
    while (next < b.length && !(mo.has(next) && mt.has(next))) next++;
    const oEnd = next < b.length ? mo.get(next)! : o.length;
    const tEnd = next < b.length ? mt.get(next)! : t.length;
    if (next === i && oEnd === j && tEnd === k) {
      if (i >= b.length) break;
      out.push(b[i]!);
      i++;
      j++;
      k++;
      continue;
    }
    const bs = b.slice(i, next),
      os = o.slice(j, oEnd),
      ts = t.slice(k, tEnd);
    if (same(os, bs)) out.push(...ts);
    else if (same(ts, bs) || same(os, ts)) out.push(...os);
    else {
      conflict = true;
      out.push(...os);
    }
    i = next;
    j = oEnd;
    k = tEnd;
  }
  return { text: out.join("\n"), conflict };
}

/** 按文件三方合并；增删与修改冲突、两边各自新增同名文件且内容不同，都算冲突。 */
export function mergeFiles(
  base: Files,
  ours: Files,
  theirs: Files,
): { files: Files; conflicts: string[] } {
  const paths = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(ours),
      ...Object.keys(theirs),
    ]),
  ].sort();
  const files: Files = {};
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base[path],
      o = ours[path],
      t = theirs[path];
    let value: string | undefined;
    if (o === t || t === b) value = o;
    else if (o === b) value = t;
    else if (b === undefined || o === undefined || t === undefined) {
      conflicts.push(path);
      value = o;
    } else {
      const merged = merge3Text(b, o, t);
      if (merged.conflict) conflicts.push(path);
      value = merged.text;
    }
    if (value !== undefined) files[path] = value;
  }
  return { files, conflicts };
}
