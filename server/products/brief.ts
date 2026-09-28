import { CHOICE_LIMITS, OPTIONS_MAX, OPTIONS_MIN } from "../choices/model.ts";
import { DAY, HOUR, MINUTE } from "../schedules/plan.ts";

/**
 * 产品部的文字（纯函数，穷举测试）：研究任务的提示词模板、产品部节点的人话字段、leader 备忘。
 * 材料由 facts.ts 从库里取，这里只排版；空的一节写「（没有）」，不省略，免得研究者以为漏给了。
 */

/** 研究者在工作目录写的选项单文件名；运行时在任务结束后读它。 */
export const CHOICE_FILE = "choice.json";

/** 周期的人话：7d → 每周，3d → 每 3 天，12h → 每 12 小时。 */
export function everyHuman(ms: number): string {
  if (ms === 7 * DAY) return "每周";
  if (ms === DAY) return "每天";
  if (ms % DAY === 0) return `每 ${ms / DAY} 天`;
  if (ms % HOUR === 0) return `每 ${ms / HOUR} 小时`;
  return `每 ${Math.round(ms / MINUTE)} 分钟`;
}

const cut = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

export type ProductNames = {
  /** 父节点（产品部要演进的那一块）。 */
  parent: { ref: string; name: string; alias: string };
  /** 产品部节点。 */
  product: { ref: string; name: string };
  leader: string;
  schedule: string;
  every_ms: number;
};

const parentName = (names: Pick<ProductNames, "parent">) =>
  names.parent.alias || names.parent.name;

/** 「Atrium 的产品部」「运行时的产品部」：西文结尾空一格。 */
const possessive = (name: string) =>
  `${name}${/[A-Za-z0-9]$/.test(name) ? " " : ""}的`;

/** 产品部节点的人话字段：管的是父节点的演进，只调研和提选项。 */
export function productFields(
  names: Omit<ProductNames, "leader" | "schedule">,
) {
  const parent = parentName(names);
  return {
    alias: cut(`${possessive(parent)}产品部`, 40),
    what: cut(
      `管「${parent}」的演进：${everyHuman(names.every_ms)}调研一次现状、用户反馈与同类产品，提一份选项单（${OPTIONS_MIN}–${OPTIONS_MAX} 个下一步）给你拍板。只调研和提选项，不自己立项、不写代码。`,
      300,
    ),
    analogy: "像产品经理：看清现状和外面的动向，摆出几条路让你选",
    flow: [
      `${everyHuman(names.every_ms)}到点生成一轮研究任务`,
      `研究者读「${parent}」的全景、决定记录、巡检发现、失败与上线记录，上网看同类产品`,
      `写成选项单挂在「${parent}」上，秘书递给你`,
      `你拍板：选中的交「${parent}」的 leader 拆解，没选的记成决定记录，下一轮情况没变不重复提`,
    ].map((step) => cut(step, 300)),
  };
}

/** 产品部 leader 的备忘：它管什么、研究收尾出岔子时怎么补。 */
export function leaderMemo(names: ProductNames): string {
  const parent = parentName(names);
  return [
    `我是「${parent}」（${names.parent.ref}）的产品部 leader，负责 ${names.product.ref}。只调研和提选项：不立项、不派开发任务，用户拍板的才开工。`,
    `周期研究 ${names.schedule} ${everyHuman(names.every_ms)}一轮（atrium schedule show ${names.schedule}）。研究任务结束时运行时读它工作目录里的 ${CHOICE_FILE}，登记成挂在 ${names.parent.ref} 上的选项单，任务完成事件里带 choice: cN。`,
    `完成事件带 choice_error 时：看 atrium task show tN 与错误，修好文件后 atrium choice add ${names.parent.ref} --file 文件 --task tN；修不好就 atrium schedule run ${names.schedule} 重跑一轮。`,
    "选项单拍板后的知会只需确认；选中的活归上一层的 leader 拆解，不归我。",
  ].join("\n");
}

export type ResearchFacts = {
  names: Pick<ProductNames, "parent" | "product">;
  date: string;
  overview: {
    what: string;
    uses: string[];
    flow: string[];
    now: string;
    next: string;
  };
  /** 父节点下的其他部分（人话名）。 */
  parts: string[];
  choices: {
    ref: string;
    title: string;
    status_text: string;
    open: boolean;
    picked: string[];
    skipped: string[];
    note: string | null;
  }[];
  decisions: string[];
  findings: {
    ref: string;
    phenomenon: string;
    kind: string;
    status: string;
  }[];
  setbacks: { ref: string; title: string; what: string; why: string | null }[];
  shipped: { ref: string; title: string; what: string }[];
};

const FINDING_KIND: Record<string, string> = {
  broken: "坏了",
  awkward: "别扭",
};
const FINDING_STATUS: Record<string, string> = {
  new: "待处理",
  task: "已建任务",
  merged: "已合并",
  ignored: "已忽略",
};

const section = (title: string, lines: readonly string[]) =>
  [`### ${title}`, ...(lines.length ? lines : ["（没有）"])].join("\n");

/** 研究任务的详述：交付格式、规矩在前，材料在后（材料可能很长，截断时只截材料）。 */
export function researchBrief(facts: ResearchFacts): string {
  const parent = parentName(facts.names);
  const o = facts.overview;
  const lim = CHOICE_LIMITS;
  return [
    `你是「${parent}」（${facts.names.parent.ref}）的产品部（${facts.names.product.ref}）。这一轮的活：看清「${parent}」现在的样子和外面的动向，提一份选项单——${OPTIONS_MIN} 到 ${OPTIONS_MAX} 个「下一步可以做什么」，交给用户拍板。`,
    "你只调研和提选项：不写代码、不改仓库、不开 PR、不建任务，不读凭据。",
    "",
    "## 交付",
    `在当前工作目录写 ${CHOICE_FILE}（UTF-8 的 JSON 对象）：`,
    "```json",
    `{"title": "${cut(parent, 20)} 下一步（${facts.date}）", "options": [{"title": "…", "gain": "…", "why_now": "…", "cost": "…", "skip": "…", "basis": ["f3", "t120", "d4", "https://…"]}], "recommend": [1], "why": "…"}`,
    "```",
    `- options 写 ${OPTIONS_MIN}–${OPTIONS_MAX} 个，每个：title 一句话说做什么（${lim.option_title} 字内）；gain 做了用户能多做到什么；why_now 为什么是现在；cost 代价——大概多少活、占哪些额度；skip 不做会怎样；basis 依据，写下面材料里的短号（fN 巡检发现、tN 任务、dN 决定、cN 选项单）或外部链接，至多 ${lim.basis_count} 条。gain、why_now、cost、skip 各 ${lim.gain} 字内，说人话、写具体。`,
    `- recommend 推荐做哪几个（选项号从 1 起），why 推荐理由（${lim.why} 字内）。title 是这份选项单的标题（${lim.title} 字内）。`,
    `- 你结束后运行时读这个文件，挂到「${parent}」上等用户拍板；文件缺了或格式不对，这一轮就白做了。写完用 node -e 'JSON.parse(require("fs").readFileSync("${CHOICE_FILE}","utf8"))' 之类的办法自查一次。`,
    "- 最后的回复用几行说清楚提了哪几个选项、推荐哪个、为什么。",
    "",
    "## 规矩",
    "- 决定记录里「这轮不做」的方向，情况没变不要再提；要再提，在 why_now 写明什么变了。",
    "- 还在等拍板的选项单里已有的方向不重复。",
    "- 可以上网查同类产品、社区讨论与动向，外部材料写链接；需要看代码只读。",
    "- 选项要是用户能拍板的方向（能多做到什么），不是实现细节；代价写实，不夸大收益。",
    "",
    "## 材料",
    section(`「${parent}」全景`, [
      ...(o.what ? [`是什么：${o.what}`] : []),
      ...(o.uses.length
        ? ["能用它做什么：", ...o.uses.map((u) => `- ${u}`)]
        : []),
      ...(o.flow.length
        ? ["一件事怎么走完：", ...o.flow.map((s, i) => `${i + 1}. ${s}`)]
        : []),
      ...(facts.parts.length
        ? [`由哪几部分组成：${facts.parts.join("、")}`]
        : []),
      ...(o.now ? [`现在做到哪：${o.now}`] : []),
      ...(o.next ? [`接下来：${o.next}`] : []),
    ]),
    "",
    section(
      "最近的选项单（新的在前）",
      facts.choices.map((c) =>
        [
          `- ${c.ref} ${c.title} · ${c.open ? "还在等用户拍板，里面的方向不要重复" : c.status_text}`,
          c.picked.length ? `；选了「${c.picked.join("」「")}」` : "",
          c.skipped.length ? `；没选「${c.skipped.join("」「")}」` : "",
          c.note ? `；说明：${c.note}` : "",
        ].join(""),
      ),
    ),
    "",
    section(
      "决定记录（有效的，新的在前）",
      facts.decisions.map((d) => `- ${d}`),
    ),
    "",
    section(
      "近期巡检发现",
      facts.findings.map(
        (f) =>
          `- ${f.ref} [${FINDING_KIND[f.kind] ?? f.kind}] ${f.phenomenon}（${FINDING_STATUS[f.status] ?? f.status}）`,
      ),
    ),
    "",
    section(
      "失败与被打回的任务（近 30 天）",
      facts.setbacks.map(
        (s) => `- ${s.ref} ${s.title} · ${s.what}${s.why ? `：${s.why}` : ""}`,
      ),
    ),
    "",
    section(
      "近期完成与上线（近 30 天）",
      facts.shipped.map((s) => `- ${s.ref} ${s.title} · ${s.what}`),
    ),
  ].join("\n");
}
