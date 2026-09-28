import { OVERVIEW_LISTS, OVERVIEW_TEXT } from "../org/overview.ts";

/**
 * 从仓库起草全景初稿（t186）的纯函数：哪些文件算凭据不读、执行者的详述模板、初稿文件的校验、
 * 写进节点前后的对比。材料由 materials.ts 读，这里只判定与排版，穷举测试。
 */

/** 执行者在工作目录写的初稿文件名；运行时在任务结束后读它。 */
export const DRAFT_FILE = "overview.json";
export const DRAFT_FILE_MAX = 64 * 1024;
/** 组成部分至多几块、名字与类比的上限（字）。 */
export const PARTS_MAX = 12;
export const PART_NAME_MAX = 40;
export const NAME_MAX = 100;

/** 目录里不列、提示执行者不打开的名字：环境变量文件、密钥与证书、登录配置、名字带 secret / credential 的。 */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.?env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|crt|cer|der|gpg|asc)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(npmrc|netrc|pypirc|htpasswd|pgpass|git-credentials)$/i,
  /(^|[._-])(secrets?|credentials?|passwords?|private[._-]?key)([._-]|$)/i,
  /^service[-_]?account.*\.json$/i,
];
export const isSecretName = (name: string) =>
  SECRET_NAMES.some((pattern) => pattern.test(name));

/** 目录树里不展开的：依赖、产物、缓存（列出名字，不往下走）。 */
export const OPAQUE_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
]);

/** 远端地址去掉内嵌的用户名与令牌（https://user:token@host/...）。 */
export const stripUserinfo = (url: string) =>
  url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

/** GitHub 远端 → owner/name；不是 GitHub 为 null。 */
export function githubSlug(url: string | null): string | null {
  if (!url) return null;
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

export type Materials = {
  repo: string;
  /** 仓库目录名。 */
  name: string;
  /** 已去掉内嵌凭据的 origin 地址。 */
  origin: string | null;
  readme: { file: string; text: string; truncated: boolean } | null;
  /** 两层目录，目录名后带「/」。 */
  tree: string[];
  tree_truncated: boolean;
  /** 因像凭据而没列出的文件数。 */
  skipped: number;
  /** 最近提交：「短号 日期 标题」。 */
  commits: string[];
};

const section = (title: string, lines: readonly string[]) =>
  [`### ${title}`, ...(lines.length ? lines : ["（没有）"])].join("\n");

const EXAMPLE = JSON.stringify({
  name: "OpenQuota",
  alias: "额度表",
  analogy: "像手机里看流量还剩多少的页面",
  what: "看清各家 AI 订阅还剩多少额度、什么时候重置，好知道活该派给谁。",
  uses: ["一眼看到各家额度还剩多少", "额度快用完时提前换人"],
  flow: ["读本机各家的登录", "问各家用量接口", "汇总成一张表"],
  parts: [
    { name: "读取器", analogy: "去各家查用量的跑腿" },
    { name: "汇总表", analogy: "把各家读数排成一张表" },
  ],
});

/** 执行者的详述：交付格式与规矩在前，材料在后（材料可能很长，截断时只截材料）。 */
export function draftBrief(m: Materials): string {
  const gh = githubSlug(m.origin);
  const text = OVERVIEW_TEXT;
  const lists = OVERVIEW_LISTS;
  return [
    `你在给 Atrium 的全景图起草「${m.name}」这一块的人话介绍。仓库在 ${m.repo}。这一轮只起草：用户看过、确认后才会写进全景图。`,
    "只读仓库：不改、不删、不新建仓库里的任何文件，不跑会改仓库的命令（git commit、checkout、switch、reset、fetch、pull、push、stash、worktree，装依赖、构建、跑测试），不推送，不开 PR，不建 issue 或任务。",
    "不碰凭据：不打开 .env 之类的环境变量文件、密钥与证书（*.pem、*.key、id_rsa…）、登录配置（.npmrc、.netrc…）和名字带 secret、credential、password 的文件，不读 ~/.ssh 与钥匙串；看到像令牌、密码的内容不要抄进初稿，也不要写进回复。",
    "",
    "## 交付",
    `在当前工作目录（不是仓库里）写 ${DRAFT_FILE}（UTF-8 的 JSON 对象），例如：`,
    "```json",
    EXAMPLE,
    "```",
    `- name：这一块叫什么，一般是产品或仓库名（${PART_NAME_MAX} 字内）。`,
    `- alias：外行一眼能懂的人话名（可省，${text.alias} 字内）；analogy：打个比方（可省，${text.analogy} 字内）。`,
    `- what：是什么，一两句（必填，${text.what} 字内，最好 100 字内）。`,
    `- uses：用户能用它做什么，2–6 条，每条一句（必填，至多 ${lists.uses} 条）。`,
    `- flow：一件事从头到尾怎么走完，3–8 步，每步一句（必填，至多 ${lists.flow} 步）。`,
    `- parts：由哪几部分组成，2–8 块，每块 {"name": "…", "analogy": "…"}：name 用人话（${PART_NAME_MAX} 字内），analogy 一句话说它管什么（${text.analogy} 字内）；按用户看得见的功能分，不照搬目录名（至多 ${PARTS_MAX} 块）。`,
    "- 中文、直白、短：写给不看代码的用户，不写实现细节、文件名和术语；拿不准的照你看到的写，不编。",
    `- 写完用 node -e 'JSON.parse(require("fs").readFileSync("${DRAFT_FILE}","utf8"))' 之类的办法自查一次；文件缺了或格式不对，这一轮就白做了。`,
    "- 最后的回复用几行说清楚这一块是什么、分了哪几部分。",
    "",
    "## 可以读",
    "- 下面的材料：运行时已读好，隐藏文件与像凭据的文件已跳过。",
    "- 需要时只读地看仓库里的代码和文档。",
    gh
      ? `- 开着的 issue：gh issue list -R ${gh} --state open --limit 30（只读；gh 用不了就跳过，别为此卡住）。`
      : "- 开着的 issue：这个仓库的 origin 不是 GitHub，没有可查的 issue，跳过。",
    "",
    "## 材料",
    section(
      `README${m.readme ? `（${m.readme.file}${m.readme.truncated ? "，只取了开头" : ""}）` : ""}`,
      m.readme ? [m.readme.text.trim()] : [],
    ),
    "",
    section(
      `目录（两层${m.tree_truncated ? "，太多只列了前面" : ""}${m.skipped ? `；${m.skipped} 个像凭据的文件没列` : ""}）`,
      m.tree,
    ),
    "",
    section(
      "最近提交（新的在前）",
      m.commits.map((c) => `- ${c}`),
    ),
  ].join("\n");
}

export type DraftPart = { name: string; analogy?: string };
export type Draft = {
  name?: string;
  alias?: string;
  analogy?: string;
  what: string;
  uses: string[];
  flow: string[];
  parts: DraftPart[];
};

const chars = (text: string) => Array.from(text).length;

/** 文件内容 → 初稿（纯函数）；null 是没写文件。只认已知字段，其余忽略。 */
export function parseDraft(
  raw: string | null,
): { ok: true; draft: Draft } | { ok: false; error: string } {
  if (raw === null)
    return { ok: false, error: `执行者没有在工作目录写 ${DRAFT_FILE}` };
  const body = raw.replace(/^﻿/, "").trim();
  if (!body) return { ok: false, error: `${DRAFT_FILE} 是空的` };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: `${DRAFT_FILE} 不是合法的 JSON` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: `${DRAFT_FILE} 应为 JSON 对象` };
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  const text = (key: string, max: number, required = false) => {
    const v = input[key];
    if (v === undefined || v === null || v === "") {
      if (required) errors.push(`${key} 必填`);
      return undefined;
    }
    if (typeof v !== "string") return void errors.push(`${key} 应为文本`);
    const trimmed = v.trim();
    if (!trimmed) {
      if (required) errors.push(`${key} 必填`);
      return undefined;
    }
    if (chars(trimmed) > max) errors.push(`${key} 超过 ${max} 字`);
    return trimmed;
  };
  const list = (key: string, count: number) => {
    const v = input[key];
    if (!Array.isArray(v)) {
      errors.push(`${key} 应为文本列表`);
      return [];
    }
    const items = v.map((item, i) => {
      if (typeof item !== "string") errors.push(`${key}[${i}] 应为文本`);
      else if (chars(item.trim()) > 300)
        errors.push(`${key}[${i}] 超过 300 字`);
      return typeof item === "string" ? item.trim() : "";
    });
    const kept = items.filter(Boolean);
    if (!kept.length) errors.push(`${key} 至少写一条`);
    if (kept.length > count) errors.push(`${key} 超过 ${count} 条`);
    return kept;
  };
  const draft: Draft = {
    name: text("name", NAME_MAX),
    alias: text("alias", OVERVIEW_TEXT.alias!),
    analogy: text("analogy", OVERVIEW_TEXT.analogy!),
    what: text("what", OVERVIEW_TEXT.what!, true) ?? "",
    uses: list("uses", OVERVIEW_LISTS.uses!),
    flow: list("flow", OVERVIEW_LISTS.flow!),
    parts: [],
  };
  const parts = input.parts ?? [];
  if (!Array.isArray(parts)) errors.push("parts 应为列表");
  else {
    if (parts.length > PARTS_MAX) errors.push(`parts 超过 ${PARTS_MAX} 块`);
    parts.forEach((item, i) => {
      const at = `parts[${i}]`;
      if (!item || typeof item !== "object" || Array.isArray(item))
        return void errors.push(`${at} 应为 {"name": "…", "analogy": "…"}`);
      const part = item as Record<string, unknown>;
      const name = typeof part.name === "string" ? part.name.trim() : "";
      if (!name) return void errors.push(`${at}.name 必填`);
      if (chars(name) > PART_NAME_MAX)
        errors.push(`${at}.name 超过 ${PART_NAME_MAX} 字`);
      const analogy =
        typeof part.analogy === "string" ? part.analogy.trim() : "";
      if (part.analogy !== undefined && typeof part.analogy !== "string")
        errors.push(`${at}.analogy 应为文本`);
      if (chars(analogy) > OVERVIEW_TEXT.analogy!)
        errors.push(`${at}.analogy 超过 ${OVERVIEW_TEXT.analogy} 字`);
      draft.parts.push(analogy ? { name, analogy } : { name });
    });
  }
  if (errors.length)
    return { ok: false, error: `${DRAFT_FILE} 不合格：${errors.join("；")}` };
  for (const key of ["name", "alias", "analogy"] as const)
    if (draft[key] === undefined) delete draft[key];
  return { ok: true, draft };
}

/** 写进节点的人话字段（组成部分不是字段，由建节点另做）。 */
export const WRITTEN = ["alias", "analogy", "what", "uses", "flow"] as const;
export type Written = (typeof WRITTEN)[number];

export function fieldsOf(draft: Draft): Partial<Record<Written, unknown>> {
  return Object.fromEntries(
    WRITTEN.filter((key) => draft[key] !== undefined).map((key) => [
      key,
      draft[key],
    ]),
  );
}

export type Change = {
  field: Written;
  before: string | string[] | null;
  after: string | string[];
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** 初稿写进节点会改哪些字段（没给的字段不动，一样的不算）。 */
export function changesOf(
  current: Record<string, unknown>,
  draft: Draft,
): Change[] {
  const out: Change[] = [];
  for (const [key, after] of Object.entries(fieldsOf(draft)) as [
    Written,
    string | string[],
  ][]) {
    const raw = current[key];
    const before =
      typeof raw === "string" || Array.isArray(raw)
        ? (raw as string | string[])
        : null;
    if (!same(before, after)) out.push({ field: key, before, after });
  }
  return out;
}
