import { Problem } from "../problem.ts";
import { clip, oneLine } from "../text-width.ts";

/**
 * 选项单（产品部第 2 步）的判定：字段校验、能不能拍板、拍板后生成的任务详述与决定记录、
 * 状态栏一行。全是纯函数、穷举测试；读写在 store.ts。
 * 一份选项单挂在一个节点上（它要演进的那一块），3–5 个选项；用户选中的在该节点下建任务，
 * 没选的连同说明记成决定记录，下一轮产品部读得到。
 */

export const OPTIONS_MIN = 3;
export const OPTIONS_MAX = 5;
export const CHOICE_LIMITS = {
  title: 80,
  option_title: 80,
  gain: 800,
  why_now: 800,
  cost: 800,
  skip: 800,
  basis_item: 300,
  basis_count: 10,
  why: 1000,
  note: 1000,
  small_count: 10,
  small_title: 80,
  small_why: 400,
};
/** 决定记录的上限（memos/decisions.ts 的 DECISION_LIMITS）。 */
const DECISION_TEXT = 300;
const DECISION_WHY = 1000;

export type ChoiceStatus = "open" | "picked" | "passed";
export const CHOICE_STATUSES: readonly ChoiceStatus[] = [
  "open",
  "picked",
  "passed",
];
export const STATUS_TEXT: Record<ChoiceStatus, string> = {
  open: "等你拍板",
  picked: "已拍板",
  passed: "这轮都不要",
};

const CHOICE_RE = /^c([1-9][0-9]{0,15})$/;
export const choiceRef = (id: number) => `c${id}`;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

export function parseChoiceRef(value: unknown, field = "选项单"): number {
  const match = typeof value === "string" ? CHOICE_RE.exec(value.trim()) : null;
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw usage(`${field}: 选项单短号应为 c1 这样的格式`);
  return id;
}

export type OptionInput = {
  title: string;
  /** 能多做到什么。 */
  gain: string;
  /** 为什么现在。 */
  why_now: string;
  /** 代价：大概多少活、占哪些额度。 */
  cost: string;
  /** 不做会怎样。 */
  skip: string;
  /** 依据：巡检发现 fN、任务 tN、决定 dN、链接等。 */
  basis: string[];
};

/** 小改进：一两个任务、一天内能做完、不改变用户用法的修补与优化。不进选项单，交项目 leader 自己定。 */
export type SmallInput = {
  title: string;
  /** 为什么值得做、做了好在哪。 */
  why: string;
  /** 依据：fN、tN、dN、链接等。 */
  basis: string[];
};

export type ChoiceInput = {
  title: string;
  options: OptionInput[];
  /** 推荐选哪几个（选项号，从 1 起）。 */
  recommend: number[];
  /** 推荐理由。 */
  why: string;
  /** 小改进（可没有）：不给拍板人看，建单时投给项目 leader。 */
  small: SmallInput[];
};

/** 选项字段的人话名，报错时用。 */
const OPTION_FIELDS: Record<keyof Omit<OptionInput, "basis">, string> = {
  title: "标题",
  gain: "能多做到什么",
  why_now: "为什么现在",
  cost: "代价",
  skip: "不做会怎样",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw usage(`${where}不能为空`);
  const trimmed = value.trim();
  if (Array.from(trimmed).length > max)
    throw usage(`${where}不能超过 ${max} 字`);
  return trimmed;
}

/**
 * 选项单的字段校验（纯函数）：只认列出的字段，报错写到第几个选项的哪一项，
 * 用人话名而不是接口字段名。选项号是给人看的，从 1 起。
 */
export function validateChoice(body: unknown): ChoiceInput {
  if (!isObject(body)) throw usage("选项单应为对象");
  for (const key of Object.keys(body))
    if (!["title", "options", "recommend", "why", "small"].includes(key))
      throw usage(
        `${key}: 是未知字段（选项单只认 title、options、recommend、why、small）`,
      );
  const title = text(body.title, "title（选项单标题）", CHOICE_LIMITS.title);
  if (!Array.isArray(body.options))
    throw usage(`options: 应为 ${OPTIONS_MIN}–${OPTIONS_MAX} 个选项的列表`);
  if (body.options.length < OPTIONS_MIN || body.options.length > OPTIONS_MAX)
    throw usage(
      `options: 应有 ${OPTIONS_MIN}–${OPTIONS_MAX} 个选项，现在是 ${body.options.length} 个`,
    );
  const options = body.options.map((raw, index): OptionInput => {
    const at = `选项 ${index + 1}`;
    if (!isObject(raw)) throw usage(`${at}: 应为对象`);
    for (const key of Object.keys(raw))
      if (!["basis", ...Object.keys(OPTION_FIELDS)].includes(key))
        throw usage(`${at}: ${key} 是未知字段`);
    const field = (key: keyof typeof OPTION_FIELDS) =>
      text(
        raw[key],
        `${at}的「${OPTION_FIELDS[key]}」（${key}）`,
        key === "title" ? CHOICE_LIMITS.option_title : CHOICE_LIMITS[key],
      );
    const basis = raw.basis === undefined ? [] : raw.basis;
    if (!Array.isArray(basis)) throw usage(`${at}的「依据」（basis）应为列表`);
    if (basis.length > CHOICE_LIMITS.basis_count)
      throw usage(
        `${at}的「依据」（basis）至多 ${CHOICE_LIMITS.basis_count} 条`,
      );
    return {
      title: field("title"),
      gain: field("gain"),
      why_now: field("why_now"),
      cost: field("cost"),
      skip: field("skip"),
      basis: basis.map((item, i) =>
        text(item, `${at}的「依据」第 ${i + 1} 条`, CHOICE_LIMITS.basis_item),
      ),
    };
  });
  const seen = new Set<string>();
  for (const [index, option] of options.entries()) {
    const key = option.title.normalize("NFKC").toLowerCase();
    if (seen.has(key))
      throw usage(`选项 ${index + 1}: 标题「${option.title}」和前面的重复`);
    seen.add(key);
  }
  const recommend = body.recommend;
  if (!Array.isArray(recommend) || !recommend.length)
    throw usage("recommend: 推荐选哪几个，写选项号列表，如 [1, 3]");
  const picks = parsePicks(recommend, options.length, "recommend");
  return {
    title,
    options,
    recommend: picks,
    why: text(body.why, "why（推荐理由）", CHOICE_LIMITS.why),
    small: validateSmall(body.small),
  };
}

/** 小改进列表（纯函数）：可不写；写了每条要有做什么（title）、为什么（why），依据可选。 */
export function validateSmall(value: unknown): SmallInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw usage("small: 小改进应为列表，每条写 title、why，可带 basis");
  if (value.length > CHOICE_LIMITS.small_count)
    throw usage(
      `small: 小改进至多 ${CHOICE_LIMITS.small_count} 条，现在是 ${value.length} 条；挑最值得做的`,
    );
  const seen = new Set<string>();
  return value.map((raw, index): SmallInput => {
    const at = `小改进 ${index + 1}`;
    if (!isObject(raw)) throw usage(`${at}: 应为对象`);
    for (const key of Object.keys(raw))
      if (!["title", "why", "basis"].includes(key))
        throw usage(`${at}: ${key} 是未知字段（只认 title、why、basis）`);
    const title = text(
      raw.title,
      `${at}的「做什么」（title）`,
      CHOICE_LIMITS.small_title,
    );
    const key = title.normalize("NFKC").toLowerCase();
    if (seen.has(key)) throw usage(`${at}: 标题「${title}」和前面的重复`);
    seen.add(key);
    const basis = raw.basis === undefined ? [] : raw.basis;
    if (!Array.isArray(basis)) throw usage(`${at}的「依据」（basis）应为列表`);
    if (basis.length > CHOICE_LIMITS.basis_count)
      throw usage(
        `${at}的「依据」（basis）至多 ${CHOICE_LIMITS.basis_count} 条`,
      );
    return {
      title,
      why: text(raw.why, `${at}的「为什么」（why）`, CHOICE_LIMITS.small_why),
      basis: basis.map((item, i) =>
        text(item, `${at}的「依据」第 ${i + 1} 条`, CHOICE_LIMITS.basis_item),
      ),
    };
  });
}

/** 选项单展示里小改进只占一行（纯函数）；没有小改进为 null。 */
export function smallLine(count: number, to: string): string | null {
  if (count <= 0) return null;
  return `另有 ${count} 条小改进已交${to === "secretary" ? "秘书" : ` ${to} `}处理`;
}

/** 投给项目 leader 的小改进提示（纯函数）：自己定开任务、并入已有任务或不做，记决定，不必上交。 */
export function smallHint(
  ref: string,
  node: { ref: string; name: string },
  count: number,
) {
  return `产品部随 ${ref} 给${node.name}（${node.ref}）提了 ${count} 条小改进，不进选项单、由你定：逐条开任务（atrium task add 标题 --part ${node.ref} --size 小）、并入已有任务（atrium task note tN 补充）或不做，并记决定（atrium decision add 决定 --why 原因）；按节奏处理，性能等闲时活照旧排后，不必上交`;
}

/**
 * 选项号（纯函数）：接受 1、"2"、"1,3" 混写，去空白；每个都要在 1..count 内、不重复。
 * 结果按从小到大排。field 是报错时的参数名。
 */
export function parsePicks(
  values: readonly unknown[],
  count: number,
  field = "选项号",
): number[] {
  const out: number[] = [];
  for (const value of values) {
    const parts =
      typeof value === "number"
        ? [String(value)]
        : typeof value === "string"
          ? value.split(/[,，\s]+/).filter(Boolean)
          : [null];
    for (const part of parts) {
      if (part === null || !/^[1-9][0-9]*$/.test(part))
        throw usage(`${field}: 选项号应为 1 到 ${count} 的整数`);
      const n = Number(part);
      if (n > count)
        throw usage(`${field}: 没有选项 ${n}，这份只有 ${count} 个选项`);
      if (out.includes(n)) throw usage(`${field}: 选项 ${n} 写了两次`);
      out.push(n);
    }
  }
  if (!out.length) throw usage(`${field}: 至少写一个选项号`);
  return out.sort((a, b) => a - b);
}

/** 拍板说明：可不写；写了就去空白、限长。 */
export function noteOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage("--note: 应为文字");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (Array.from(trimmed).length > CHOICE_LIMITS.note)
    throw usage(`--note: 说明不能超过 ${CHOICE_LIMITS.note} 字`);
  return trimmed;
}

/**
 * 能不能拍板（纯函数）：只有开放中的能选或全不要；已定的说清是怎么定的。
 * archived 为选项单所在节点已归档。
 */
export function decideVerdict(input: {
  ref: string;
  status: ChoiceStatus;
  archived: boolean;
}): string | null {
  if (input.status === "picked")
    return `${input.ref} 已经拍过板了，不能再改；要做别的，等下一轮选项或直接 atrium task add`;
  if (input.status === "passed")
    return `${input.ref} 这轮已经定了都不要，不能再改；要做别的，等下一轮选项或直接 atrium task add`;
  if (input.archived) return `${input.ref} 挂的节点已归档，没法在那里建任务`;
  return null;
}

/** 选项单状态（纯函数）：拍板动作 → 新状态。 */
export function statusAfter(action: "pick" | "pass"): ChoiceStatus {
  return action === "pick" ? "picked" : "passed";
}

/** 谁拍板选项单：用户（缺省），或下放给选项单所在节点最近的 leader。 */
export type DeciderMode = "u1" | "leader";
export const DECIDER_MODES: readonly DeciderMode[] = ["u1", "leader"];

export function parseDecider(value: unknown): DeciderMode {
  if (value === "u1" || value === "leader") return value;
  throw usage(
    "--decider: 只能是 u1（用户拍板）或 leader（下放给该节点的 leader）",
  );
}

/** 从选项单所在节点往上到根的一段：节点上的设置与 leader（已归档的节点 leader 记 null）。 */
export type DeciderLink = {
  id: number;
  setting: DeciderMode | null;
  leader: string | null;
};
export type Decider = {
  /** 拍板人：u1 或 aN。 */
  decider: string;
  mode: DeciderMode;
  /** 设置写在哪个节点上；缺省为 null。 */
  set_at: number | null;
  why: string;
};

/**
 * 拍板人（纯函数）：最近一个写了设置的节点说了算，都没写就是用户。下放给 leader 时找选项单所在节点
 * 往上最近的已登记 leader；找不到就仍由用户拍板，不让选项单没人管。
 */
export function resolveDecider(
  chain: readonly DeciderLink[],
  registered: ReadonlySet<string>,
): Decider {
  const at = chain.find((link) => link.setting !== null);
  if (!at || at.setting === "u1")
    return {
      decider: "u1",
      mode: "u1",
      set_at: at?.id ?? null,
      why: at ? `o${at.id} 设为用户拍板` : "缺省由用户拍板",
    };
  const lead = chain.find(
    (link) => link.leader !== null && registered.has(link.leader),
  );
  if (!lead)
    return {
      decider: "u1",
      mode: "leader",
      set_at: at.id,
      why: `o${at.id} 设为 leader 拍板，但往上找不到已登记的 leader，仍由用户拍板`,
    };
  return {
    decider: lead.leader!,
    mode: "leader",
    set_at: at.id,
    why: `o${at.id} 设为 leader 拍板：${lead.leader}（负责 o${lead.id}）`,
  };
}

/** 能不能拍板（纯函数）：用户始终可以；leader 只在拍板权下放给自己时可以。 */
export function decideRight(
  actor: string,
  decider: string,
  ref: string,
): string | null {
  if (actor === "u1" || actor === decider) return null;
  return decider === "u1"
    ? `${actor} 不能拍板 ${ref}：拍板人是用户（u1）；可以写意见：atrium choice comment ${ref} 意见 --prefer 选项号`
    : `${actor} 不能拍板 ${ref}：拍板人是 ${decider}`;
}

export const COMMENTS_MAX = 20;
export type CommentInput = { text: string; prefer: number[]; basis: string[] };

/**
 * 意见（纯函数）：一段话，可标倾向哪几个选项、补几条依据。existing 是这份已有的意见条数，
 * 到上限就不收，免得一份选项单被刷屏。
 */
export function validateComment(
  body: unknown,
  count: number,
  existing: number,
): CommentInput {
  if (!isObject(body)) throw usage("意见应为对象");
  for (const key of Object.keys(body))
    if (!["text", "prefer", "basis"].includes(key))
      throw usage(`${key}: 是未知字段（意见只认 text、prefer、basis）`);
  if (existing >= COMMENTS_MAX)
    throw new Problem(
      409,
      `这份选项单已有 ${COMMENTS_MAX} 条意见，不再收；要补充就合并成一条写进新的选项单`,
      "conflict",
    );
  const text_ = text(body.text, "意见", CHOICE_LIMITS.note);
  const preferRaw = body.prefer ?? [];
  const preferList = Array.isArray(preferRaw) ? preferRaw : [preferRaw];
  const prefer =
    preferList.length && preferList.some((v) => v !== "")
      ? parsePicks(preferList, count, "--prefer")
      : [];
  const basisRaw = body.basis ?? [];
  if (!Array.isArray(basisRaw)) throw usage("--basis: 应为列表");
  if (basisRaw.length > CHOICE_LIMITS.basis_count)
    throw usage(`--basis: 至多 ${CHOICE_LIMITS.basis_count} 条`);
  return {
    text: text_,
    prefer,
    basis: basisRaw.map((item, i) =>
      text(item, `--basis 第 ${i + 1} 条`, CHOICE_LIMITS.basis_item),
    ),
  };
}

export type CommentFacts = {
  by: string;
  text: string;
  prefer: number[];
  basis: string[];
};

/** 意见一行（纯函数）：谁、说了什么、倾向哪几个、补了什么依据。 */
export function commentLine(comment: CommentFacts): string {
  const prefer = comment.prefer.length
    ? `（倾向选项 ${comment.prefer.join("、")}）`
    : "";
  const basis = comment.basis.length
    ? `；补依据：${comment.basis.join("；")}`
    : "";
  const who = comment.by === "secretary" ? "秘书" : comment.by;
  return `${who}：${comment.text}${prefer}${basis}`;
}

export type ChoiceFacts = {
  ref: string;
  title: string;
  node: { ref: string; name: string };
  recommend: number[];
  why: string;
};
export type OptionFacts = OptionInput & { seq: number };

const bullet = (label: string, value: string) => `- ${label}：${value}`;

/**
 * 被选中的选项建成任务时的详述（纯函数）：选项全文、来源、拍板说明、各方意见，交节点 leader 拆解。
 * by 是拍板人（u1 或下放后的 aN）。
 */
export function pickedBrief(
  choice: ChoiceFacts,
  option: OptionFacts,
  note: string | null,
  by = "u1",
  comments: readonly CommentFacts[] = [],
): string {
  const who = by === "u1" ? "用户" : by;
  return [
    `# ${option.title}`,
    "",
    `来源：选项单 ${choice.ref}「${choice.title}」的选项 ${option.seq}，${who}拍板要做（${choice.node.ref}「${choice.node.name}」）。`,
    ...(note ? ["", `${who}说明：${note}`] : []),
    "",
    "## 选项全文",
    "",
    bullet("能多做到什么", option.gain),
    bullet("为什么现在", option.why_now),
    bullet("代价", option.cost),
    bullet("不做会怎样", option.skip),
    ...(option.basis.length ? [bullet("依据", option.basis.join("；"))] : []),
    "",
    `产品部推荐：选项 ${choice.recommend.join("、")}——${choice.why}`,
    ...(comments.length
      ? [
          "",
          "## 拍板前的意见",
          "",
          ...comments.map((c) => `- ${commentLine(c)}`),
        ]
      : []),
    "",
    "## 怎么接",
    "",
    `交 ${choice.node.ref} 的 leader 拆解：按上面的「能多做到什么」拆成可交付的子任务（atrium task add 标题 --parent 本任务 --size 小|中|大，写上大小：小活自动挑快且便宜的执行者，中、大挑高强度的），不另行扩大范围。`,
    "本任务是准备拆的总任务：先拆，不要直接派它。建了子任务后它自动成为总任务——不再派给执行者，状态与进度按全部子孙汇总（atrium task tree 本任务），整体上线时秘书收一条「整体已上线」。",
  ].join("\n");
}

/**
 * 没选的选项记成决定记录（纯函数）：决定写「这轮不做 X」，原因写用户说明；
 * 没写说明时写明「没写原因」，好让下一轮知道情况没变就不必重复提。长度按决定记录的上限截。
 */
export function skippedDecision(
  choice: ChoiceFacts,
  option: OptionFacts,
  note: string | null,
  action: "pick" | "pass",
  by = "u1",
): { text: string; why: string } {
  const where = `（${choice.ref} 选项 ${option.seq}）`;
  const head = "这轮不做「";
  const room =
    DECISION_TEXT - Array.from(head).length - 1 - Array.from(where).length;
  const title = clip(option.title, Math.max(8, room));
  const who = by === "u1" ? "用户" : by;
  const reason =
    note ??
    (action === "pass"
      ? `${who}这轮都不要，没写原因`
      : `${who}选了别的选项，没写原因`);
  const why = `${reason}。当时的说法：能多做到「${oneLine(option.gain, 200)}」；不做会「${oneLine(option.skip, 200)}」。情况没变就不再提。`;
  return {
    text: `${head}${title}」${where}`,
    why: clip(why, DECISION_WHY),
  };
}

export type PendingChoice = {
  ref: string;
  title: string;
  options: number;
  node: string;
  node_name: string;
};

/** 状态栏与 top 那一行（纯函数）：最早的一份 + 还有几份；没有就是 null。 */
export function pendingLine(
  pending: readonly PendingChoice[],
  total: number,
  max = 60,
): string | null {
  const first = pending[0];
  if (!first || total <= 0) return null;
  const more = total > 1 ? `，另有 ${total - 1} 份` : "";
  return `等你拍板：${first.ref} ${oneLine(first.title, max)}（${first.options} 个选项）${more}`;
}
