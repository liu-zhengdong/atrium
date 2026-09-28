/**
 * 规划任务（t275）的纯函数：执行者写的子任务清单怎么校验、按依赖排先后、详述模板、采纳时每件子任务的详述、
 * 归属部分能不能写。读写账在 store.ts，拉起与自动派在 runtime.ts；这里只判定与排版，穷举测试。
 *
 * 规划任务派一个执行者读代码与总任务详述，只在工作目录写 plan.json，不改代码；
 * 负责的 leader 看过后一条命令采纳（批量建子任务、设依赖、就绪的自动派出），也可以改了再采纳或驳回。
 */

/** 执行者在工作目录写的清单文件名；运行时在任务完成后读它。 */
export const PLAN_FILE = "plan.json";
export const PLAN_FILE_MAX = 64 * 1024;
export const PLAN_TASKS_MAX = 30;
export const SUMMARY_MAX = 1000;
export const TITLE_MAX = 100;
export const ITEM_BRIEF_MAX = 4000;
export const ASK_MAX = 5;
export const NAME_MAX = 40;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 子任务大小（u1 09-28 提速）：目标是一个执行者半小时左右交付，超过的继续拆。
 * 小：十来分钟，改一两处；中：半小时左右；大：半小时以上又拆不开的（少用，详述里写明为什么拆不开）。
 */
export const SIZES = ["小", "中", "大"] as const;
export type Size = (typeof SIZES)[number];
const SIZE_ALIASES: Record<string, Size> = {
  小: "小",
  中: "中",
  大: "大",
  s: "小",
  small: "小",
  m: "中",
  medium: "中",
  l: "大",
  large: "大",
};

/** 没写执行者时按大小建议：小的用快的，中大的用强的（只是建议，派不出去就按候选挑）。 */
export const SIZE_WORKERS: Record<Size, string> = {
  小: "cursor+auto",
  中: "claude+opus:high",
  大: "claude+opus:high",
};

export type PlanItem = {
  /** 清单里的代号（字母数字），只用来写先后依赖。 */
  key: string;
  title: string;
  /** 详述要点：做什么、改哪里、怎么验收。 */
  brief: string;
  /** 先做完哪几件（代号）。 */
  after: string[];
  /** 建议干活的专员。 */
  by: string | null;
  /** 建议请来审的专员。 */
  ask: string[];
  /** 大小：小 / 中 / 大。 */
  size: Size;
  /** 建议执行者（工具+模型[:强度]）；没写按大小建议（suggestedWorker）。 */
  worker: string | null;
  /** 归属部分（节点短号或路径）；不写就是总任务所在的部分。 */
  part: string | null;
};

export type Plan = { summary: string; tasks: PlanItem[] };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const length = (text: string) => Array.from(text).length;

const TOP_KEYS = ["summary", "tasks"];
const ITEM_KEYS = [
  "key",
  "title",
  "brief",
  "after",
  "by",
  "ask",
  "size",
  "worker",
  "part",
];

function text(
  value: unknown,
  where: string,
  max: number,
  required: boolean,
): Result<string | null> {
  if (value === undefined || value === null || value === "")
    return required
      ? { ok: false, error: `${where} 不能为空` }
      : { ok: true, value: null };
  if (typeof value !== "string")
    return { ok: false, error: `${where} 应为文本` };
  const trimmed = value.trim();
  if (!trimmed)
    return required
      ? { ok: false, error: `${where} 不能为空` }
      : { ok: true, value: null };
  if (length(trimmed) > max)
    return { ok: false, error: `${where} 至多 ${max} 字` };
  return { ok: true, value: trimmed };
}

function names(
  value: unknown,
  where: string,
  max: number,
  itemMax: number,
): Result<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const list =
    typeof value === "string"
      ? value
          .split(/[,，、]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : value;
  if (!Array.isArray(list))
    return { ok: false, error: `${where} 应为数组，如 ["a", "b"]` };
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim())
      return { ok: false, error: `${where} 里每一项应为非空文本` };
    if (length(item.trim()) > itemMax)
      return { ok: false, error: `${where} 里每一项至多 ${itemMax} 字` };
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  if (out.length > max) return { ok: false, error: `${where} 至多 ${max} 项` };
  return { ok: true, value: out };
}

/**
 * 按依赖排先后（稳定：没有先后关系的保持清单原来的顺序）；有环时报出环上的代号。
 * items 的代号与 after 须已校验过（都存在、不重复、不指向自己）。
 */
export function topoOrder(
  items: readonly Pick<PlanItem, "key" | "after">[],
): Result<string[]> {
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < items.length) {
    const next = items.find(
      (item) => !done.has(item.key) && item.after.every((k) => done.has(k)),
    );
    if (!next) {
      const left = items.filter((item) => !done.has(item.key));
      return {
        ok: false,
        error: `tasks: 先后依赖成环：${left.map((i) => i.key).join("、")}`,
      };
    }
    done.add(next.key);
    order.push(next.key);
  }
  return { ok: true, value: order };
}

/** 校验一份清单（执行者写的、或 leader 改过的）。 */
export function validatePlan(raw: unknown): Result<Plan> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {
      ok: false,
      error: "清单应为 JSON 对象：{ summary, tasks: [...] }",
    };
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!TOP_KEYS.includes(key))
      return {
        ok: false,
        error: `${key}: 是未知字段（只认 ${TOP_KEYS.join("、")}）`,
      };
  const summary = text(input.summary, "summary", SUMMARY_MAX, false);
  if (!summary.ok) return summary;
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    return { ok: false, error: "tasks: 至少要有一件子任务" };
  if (input.tasks.length > PLAN_TASKS_MAX)
    return {
      ok: false,
      error: `tasks: 至多 ${PLAN_TASKS_MAX} 件；再多先拆成几块总任务`,
    };
  const tasks: PlanItem[] = [];
  for (const [index, entry] of input.tasks.entries()) {
    const at = `tasks[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: `${at} 应为对象` };
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (!ITEM_KEYS.includes(key))
        return {
          ok: false,
          error: `${at}.${key}: 是未知字段（只认 ${ITEM_KEYS.join("、")}）`,
        };
    const key =
      item.key === undefined || item.key === null || item.key === ""
        ? `${index + 1}`
        : item.key;
    if (typeof key !== "string" && typeof key !== "number")
      return { ok: false, error: `${at}.key 应为字母数字代号` };
    const code = String(key).trim();
    if (!KEY_RE.test(code))
      return {
        ok: false,
        error: `${at}.key: 代号只用字母、数字、- 和 _，至多 32 个字符`,
      };
    if (tasks.some((t) => t.key === code))
      return { ok: false, error: `${at}.key: 代号 ${code} 重复` };
    const where = `${at}（${code}）`;
    const title = text(item.title, `${where}.title`, TITLE_MAX, true);
    if (!title.ok) return title;
    const brief = text(item.brief, `${where}.brief`, ITEM_BRIEF_MAX, true);
    if (!brief.ok) return brief;
    const after = names(item.after, `${where}.after`, PLAN_TASKS_MAX, 32);
    if (!after.ok) return after;
    const by = text(item.by, `${where}.by`, NAME_MAX, false);
    if (!by.ok) return by;
    const ask = names(item.ask, `${where}.ask`, ASK_MAX, NAME_MAX);
    if (!ask.ok) return ask;
    const size =
      typeof item.size === "string"
        ? SIZE_ALIASES[item.size.trim().toLowerCase()]
        : undefined;
    if (!size)
      return {
        ok: false,
        error: `${where}.size: 大小必填，只能是 ${SIZES.join("、")}（一个执行者半小时左右交付的是中；超过的继续拆）`,
      };
    const worker = text(item.worker, `${where}.worker`, 60, false);
    if (!worker.ok) return worker;
    const part = text(item.part, `${where}.part`, 200, false);
    if (!part.ok) return part;
    tasks.push({
      key: code,
      title: title.value!,
      brief: brief.value!,
      after: after.value,
      by: by.value,
      ask: ask.value,
      size,
      worker: worker.value,
      part: part.value,
    });
  }
  for (const item of tasks)
    for (const dep of item.after) {
      if (dep === item.key)
        return { ok: false, error: `${item.key}.after: 不能依赖自己` };
      if (!tasks.some((t) => t.key === dep))
        return {
          ok: false,
          error: `${item.key}.after: 清单里没有代号 ${dep}`,
        };
    }
  const order = topoOrder(tasks);
  if (!order.ok) return order;
  return { ok: true, value: { summary: summary.value ?? "", tasks } };
}

/** 文件内容 → 清单（纯函数）；null 是没写文件。 */
export function parsePlan(raw: string | null): Result<Plan> {
  if (raw === null)
    return { ok: false, error: `规划者没有在工作目录写 ${PLAN_FILE}` };
  const body = raw.replace(/^﻿/, "").trim();
  if (!body) return { ok: false, error: `${PLAN_FILE} 是空的` };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: `${PLAN_FILE} 不是合法的 JSON` };
  }
  const plan = validatePlan(value);
  return plan.ok ? plan : { ok: false, error: `${PLAN_FILE}：${plan.error}` };
}

/** 建议执行者：清单写了用清单的，没写按大小。 */
export const suggestedWorker = (item: Pick<PlanItem, "size" | "worker">) =>
  item.worker ?? SIZE_WORKERS[item.size];

/** 按依赖排好先后的清单。 */
export function orderedItems(plan: Plan): PlanItem[] {
  const order = topoOrder(plan.tasks);
  if (!order.ok) return plan.tasks;
  return order.value.map((key) => plan.tasks.find((t) => t.key === key)!);
}

/**
 * 子任务的归属部分能不能写（纯函数）：只能是总任务所在部分或它下面的；总任务没归属部分时不限。
 * parents 是节点 → 父节点。返回说明或 null。
 */
export function partVerdict(input: {
  where: string;
  part: number;
  home: number | null;
  parents: ReadonlyMap<number, number | null>;
}): string | null {
  if (input.home === null) return null;
  const seen = new Set<number>();
  let current: number | null | undefined = input.part;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current === input.home) return null;
    seen.add(current);
    current = input.parents.get(current);
  }
  return `${input.where}.part: o${input.part} 不在总任务所在的 o${input.home} 之下；别的部分的活先上交 cross 让对方接，或去掉 part 留在本部分`;
}

export type PlanFacts = {
  target: {
    ref: string;
    title: string;
    brief: string | null;
    repo: string | null;
  };
  part: { ref: string; name: string } | null;
  /** 归属部分的全景与要点（map context）。 */
  context: string;
  /** 总任务下已有的子任务。 */
  children: { ref: string; title: string; status: string }[];
  /** 这一部分可请的专员。 */
  specialists: { name: string; description: string }[];
};

const EXAMPLE = JSON.stringify(
  {
    summary: "先把存储拆出来，再在上面加接口和命令行；界面最后接。",
    tasks: [
      {
        key: "store",
        title: "新增规划结果的存储与校验",
        brief:
          "做什么：…；改哪里：server/plans/store.ts …；怎么验收：相关测试 …",
        by: "后端",
        size: "中",
      },
      {
        key: "cli",
        title: "命令行接上采纳与驳回",
        brief: "做什么：…；怎么验收：…",
        after: ["store"],
        by: "后端",
        ask: ["前端"],
        size: "中",
      },
      {
        key: "readme",
        title: "README 补一段用法",
        brief: "做什么：…；怎么验收：…",
        size: "小",
      },
    ],
  },
  null,
  2,
);

/** 规划执行者的详述：交付格式与规矩在前，材料在后。 */
export function planBrief(f: PlanFacts): string {
  return [
    `你在给总任务 ${f.target.ref}「${f.target.title}」做规划：读代码与下面的详述，拆成可以直接派给执行者的子任务清单。只出清单，不写代码。`,
    f.target.repo
      ? `仓库在 ${f.target.repo}，只读：不改、不删、不新建仓库里的任何文件，不跑会改仓库的命令（git commit、checkout、switch、reset、fetch、pull、push、stash、worktree，装依赖、构建），不推送，不开 PR，不建 issue 或任务。`
      : "这件总任务没写仓库；按详述与材料规划，需要看代码时只读，不改任何文件。",
    "不碰凭据：不打开 .env、密钥与证书、登录配置和名字带 secret、credential、password 的文件；看到像令牌、密码的内容不要抄进清单。",
    "",
    "## 交付",
    `在当前工作目录（不是仓库里）写 ${PLAN_FILE}（UTF-8 的 JSON 对象），例如：`,
    "```json",
    EXAMPLE,
    "```",
    `- summary：整体怎么拆、为什么这样拆，一两句（${SUMMARY_MAX} 字内）。`,
    `- tasks：${PLAN_TASKS_MAX} 件以内，按建议的先后排。每件：`,
    "  - key：代号（字母、数字、- 和 _），只用来写依赖；",
    `  - title：标题，一句话说清交付什么（${TITLE_MAX} 字内）；`,
    `  - brief：详述要点——做什么、改哪些文件或模块、怎么验收（跑哪些测试、看到什么结果），给接活的执行者看（${ITEM_BRIEF_MAX} 字内）；`,
    "  - after：要等哪几件先做完（代号数组）；只有真依赖（要用到它的代码或结果）才写，能并行的不要硬串；",
    "  - by：建议干活的专员（从下面的名单里挑，拿不准就不写）；ask：建议请来审的专员（可省）；",
    `  - size：大小，必填，${SIZES.join("、")}——小：十来分钟，改一两处；中：一个执行者半小时左右；大：半小时以上又拆不开的（少用，brief 里写明为什么拆不开）；`,
    `  - worker：建议执行者，写成 工具+模型[:强度]（可省）；不写按大小：小的用快的 ${SIZE_WORKERS.小}（或 codex:low），中大的用 ${SIZE_WORKERS.中}（或 codex:high）；自动派时先试它，派不出去再按候选挑；`,
    `  - part：归属部分（可省，缺省是总任务所在的${f.part ? ` ${f.part.ref}` : "部分"}；只能写它或它下面的部分）。`,
    "- 切小：每件只做一件事，目标是一个执行者半小时左右交付（一个 PR）；超过的继续拆，拆到中或小为止。",
    "- 已经有的子任务（下面列出）不要重复建；要改它们的写进 summary。",
    `- 写完用 node -e 'JSON.parse(require("fs").readFileSync("${PLAN_FILE}","utf8"))' 之类的办法自查一次；文件缺了或格式不对，这一轮就白做了。`,
    "- 最后的回复用几行说清楚拆成了几件、先后怎么排、哪里拿不准。",
    "",
    "## 总任务详述",
    f.target.brief?.trim() || "（没写详述，只有标题）",
    "",
    "## 已有的子任务",
    ...(f.children.length
      ? f.children.map((c) => `- ${c.ref} [${c.status}] ${c.title}`)
      : ["（没有）"]),
    "",
    `## 可请的专员${f.part ? `（${f.part.ref} ${f.part.name}）` : ""}`,
    ...(f.specialists.length
      ? f.specialists.map(
          (s) => `- ${s.name}${s.description ? `：${s.description}` : ""}`,
        )
      : ["（没有登记专员，by 与 ask 不写）"]),
    "",
    "## 归属部分的全景与要点",
    f.context.trim() || "（没有）",
  ].join("\n");
}

/**
 * 规划建议的专员里哪些请得动（纯函数）：只留这一部分可选范围里的（按名称或 rN）；
 * 请不动的不挡采纳，记进详述，由 leader 另行 task set --by/--ask。
 */
export function pickSpecialists(
  item: Pick<PlanItem, "by" | "ask">,
  available: readonly { name: string; ref: string }[],
): { by: string | null; ask: string[]; dropped: string[] } {
  const known = (name: string) =>
    available.some((s) => s.name === name || s.ref === name);
  const by = item.by !== null && known(item.by) ? item.by : null;
  const ask = item.ask.filter(known);
  const dropped = [
    ...(item.by !== null && by === null ? [item.by] : []),
    ...item.ask.filter((name) => !known(name)),
  ];
  return { by, ask, dropped };
}

/** 采纳时每件子任务的详述：清单里的要点，加来源、建议执行者与没请成的专员。 */
export function itemBrief(
  item: PlanItem,
  source: { target: string; title: string; plan: string; by: string },
  dropped: readonly string[] = [],
): string {
  return [
    item.brief,
    "",
    "---",
    `来源：总任务 ${source.target}「${source.title}」的规划 ${source.plan}，由 ${source.by} 采纳。`,
    `大小：${item.size}；规划建议的执行者：${suggestedWorker(item)}（自动派时先试它）`,
    ...(dropped.length
      ? [
          `规划建议的专员 ${dropped.join("、")} 不在这一部分可选的范围里，没有请；要请用 atrium task set 本任务 --by 或 --ask。`,
        ]
      : []),
  ].join("\n");
}
