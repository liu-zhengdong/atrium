import type { TaskRow } from "./ledger-model.ts";
import type { TaskStatus } from "./state.ts";
import { oneLine, width } from "../text-width.ts";
import { MAX_CHECK_RERUNS } from "./check-outcome.ts";
import { quietMinutes } from "./check-quiet.ts";
import { hangLabel } from "../leaders/hang.ts";

/**
 * 未结束任务「现在球在谁手里」（#355 追加）：状态栏与 top 按它显示，不再自己从状态和 PR 猜。
 * 纯函数：事实由 holder-facts.ts 从账本、收件箱取来。
 *
 * - worker：执行者在做；
 * - merge：合入流水线（审阅、排队合入、合入中、等发版上线），运行时自己推进；
 * - queue：排队等额度或执行者、等上游依赖，运行时到点自己派；
 * - leader：leader aN 在处理或待处理；
 * - secretary：秘书（或其他订阅者）在处理或待处理；
 * - user：真的在等用户拍板——只有这一类用醒目颜色写「等你」。
 */
export type HolderKind =
  "worker" | "merge" | "queue" | "leader" | "secretary" | "user";

export type Holder = {
  kind: HolderKind;
  /** 执行者组合、aN、secretary、u1；运行时自己推进时为 null。 */
  who: string | null;
  /** 一句话：卡在哪、谁在接手，如「本地检查没过 · a1 已交回执行者」。单行，至多 HOLDER_WIDTH 显示宽度。 */
  text: string;
  /** 摘要背后的原因全文（审阅意见、检查输出）；只有单个任务视图（`task show`）给。 */
  detail?: string | null;
};

/** 持球人一句话的显示宽度上限：状态栏与 top 一行里放得下。 */
export const HOLDER_WIDTH = 60;

export type HolderFacts = {
  status: TaskStatus;
  delivery_stage: TaskRow["delivery_stage"];
  online_wait: number;
  worker: string | null;
  /** 正在执行的远程主机名；本机或没有执行者为 null。 */
  host?: string | null;
  /** 在排队时的原因；不在排队为 null。 */
  queued: { reason: string | null } | null;
  /** 审阅关卡派出的审阅任务短号。 */
  review_task: string | null;
  schedule_state: string | null;
  schedule_reason: string | null;
  /** 排期在等的上游条件（如「t3 上线」）；不在等为空。 */
  waiting_for: string[];
  auto: boolean;
  /** 最近一次受阻（block 事件）的原因与关卡名；从没受阻为 null。 */
  block: { reason: string | null; gates: string[] } | null;
  /** 最近一次受阻之后，把任务交回执行者的：捎话作者或运行时合入交回。 */
  returned: { by: string | null; via: "tell" | "merge" | "rerun" } | null;
  /** 最近一次合入交回执行者的原因（rebase 冲突、检查没过等）。 */
  merge_returned: string | null;
  /** 受阻之后的上交：交给了谁、谁交的。 */
  escalated: { to: string; from: string } | null;
  /** 受阻之后写了备注（有人在处理）：谁。 */
  processing_by: string | null;
  /** 受阻之后收件箱里这条任务最新的事件：投给了谁、确认了没有。 */
  inbox: { subscriber: string; acked: boolean } | null;
  /** 任务事件缺省投给谁（taskRoute），没有收件箱记录时用它。 */
  route: string;
  /** 本地检查正在跑（交付后或合入队列重跑）：在哪台（hN，旧记录没有）；没在跑为 null。 */
  checking?: { host: string | null } | null;
  /** 被紧急任务抢占暂停（t215）：被哪件（tN）；没被暂停为 null。 */
  preempted?: { by: string | null } | null;
  /** 排队合入时，其他任务的合入因这些紧急任务（tN）暂停（t215）；没暂停为空。 */
  merge_held_by?: string[];
  /** 合入检查没跑成、在等自动重跑（t204）：第几次、没跑成的原因；不在等为 null。 */
  rerun?: { attempt: number; reason: string | null } | null;
  /** 正在跑的检查日志太久没新输出（t260）：提醒那一句（「检查 5 分钟没输出：卡在 …」）；之后又有输出或没在检查为 null。 */
  check_quiet?: string | null;
  /** 执行者这段多久没进展（t260，毫秒）；没提醒过或之后又有进展为 null。 */
  worker_quiet_ms?: number | null;
  /** 受阻任务的球什么时候到现在这位手里（受阻或被上交给它的时刻，t253）；不在受阻为 null。 */
  held_since?: number | null;
  /** 这一段里运行时叫醒过持球 leader 的时刻（t253）；没叫醒过为 null。 */
  hang_nudged?: number | null;
  /** 取事实的时刻：算 leader 手里挂了多久。 */
  now?: number;
};

/** 检查在别的主机上跑时说「在 hN 上」；本机（h1）或不知道时不说。 */
const where = (checking: HolderFacts["checking"]) =>
  checking?.host && checking.host !== "h1" ? `在 ${checking.host} 上` : "";

/** 合入检查没跑成、等重跑的一句话；原因全文给 `task show`（holderDetail）。 */
const rerunShort = (attempt: number) =>
  `检查没跑成，等重跑（${attempt}/${MAX_CHECK_RERUNS}）`;

const FINISHED = new Set<TaskStatus>(["done", "failed", "cancelled"]);

const STATUS_TEXT: Record<string, string> = {
  todo: "待办",
  running: "在跑",
  blocked: "卡住",
};
/** 排期给的条件里上游状态是 `[running]` 这样的英文标记，换成中文。 */
const readable = (text: string) =>
  text.replace(
    / \[([a-z]+)\]/g,
    (_, status: string) => ` ${STATUS_TEXT[status] ?? status}`,
  );

/** 订阅者属于哪一类：u1 是用户，aN 是 leader，其余（secretary 与负责人）归秘书这一侧。 */
export function kindOf(who: string): HolderKind {
  if (who === "u1") return "user";
  if (/^a[1-9][0-9]*$/.test(who)) return "leader";
  return "secretary";
}

/** 人话名字：u1 → 你，secretary → 秘书，runtime → 运行时，其余原样。 */
export function whoLabel(who: string): string {
  return who === "u1"
    ? "你"
    : who === "secretary"
      ? "秘书"
      : who === "runtime"
        ? "运行时"
        : who;
}

const GATE_LABEL: Record<string, string> = {
  local_check: "本地检查没过",
  ci: "CI 没过",
  pr_exists: "没找到 PR",
  finished: "执行者没做完",
  file_growth: "改动规模超限",
  claims_verified: "自述与事实对不上",
  concern: "专员没通过",
  review: "审阅打回",
};

/** 受阻原因缩成一句：关卡不过按关卡名说，其余取第一行第一段、至多 40 显示宽度（20 个汉字）。 */
export function blockShort(
  block: { reason: string | null; gates: string[] } | null,
): string {
  if (!block) return "受阻";
  const gate = block.gates.find((g) => GATE_LABEL[g]);
  if (gate) return GATE_LABEL[gate]!;
  const reason = (block.reason ?? "").trim();
  if (!reason) return "受阻";
  const line = oneLine(reason, Infinity);
  return oneLine(line.split(/[：；]/)[0]!.trim() || line, 40);
}

/** 标识符、路径、数字里的字符：截断不落在两个这样的字符之间。 */
const ID_CHAR = /[\w./:@#$-]/;

/**
 * 按显示宽度截断，只在词或标点边界下刀，末尾带「…」（算一格）；
 * 连第一个词都放不下时返回空串，由调用方退回只写类别。
 */
export function clipWords(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (width(line) <= max) return line;
  const chars = [...line];
  let used = 0;
  let cut = 0;
  for (let i = 0; i < chars.length; i++) {
    used += width(chars[i]!);
    if (used > max - 1) break;
    const next = chars[i + 1];
    if (!next || !(ID_CHAR.test(chars[i]!) && ID_CHAR.test(next))) cut = i + 1;
  }
  const head = chars
    .slice(0, cut)
    .join("")
    .replace(/[\s、，,：:；;（(「“'"`-]+$/, "");
  return head ? `${head}…` : "";
}

/** 去掉 markdown 记号，留下给人读的文字。 */
const plainText = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();

const OPEN = "「『“（(";
const CLOSE = "」』”）)";

/** 第一句：到句末标点、分号或全角冒号为止；`a.ts:12` 这类半角冒号、引号和括号里的标点不断句。 */
function firstSentence(text: string): string {
  const chars = [...text];
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (
      !depth &&
      ("。！？!?；;：".includes(c) ||
        (c === ":" && /\s/.test(chars[i + 1] ?? "")))
    )
      return chars.slice(0, i).join("").trim();
  }
  return text.trim();
}

/** 代码位置：`a.ts:12`、`a.ts:12-30`、`a.ts:12-30、40`。 */
const LOCATION = /^[\w./-]+:\d+(?:[-–]\d+)?(?:[、,]\s*\d+(?:[-–]\d+)?)*/;

/** 条目开头的编号与「位置：」去掉后的第一句；只剩位置时退回位置本身。 */
function pointSentence(text: string): string {
  const plain = plainText(text).replace(/^\d+[.)、]\s*/, "");
  const at = LOCATION.exec(plain);
  const rest = at && /^\s*[：:]/.test(plain.slice(at[0].length));
  if (!rest) return firstSentence(plain);
  return (
    firstSentence(plain.slice(at[0].length).replace(/^\s*[：:]\s*/, "")) ||
    at[0]
  );
}

/** 放不下时先去掉开头的代码位置（`a.ts:12-30`）和括号里的补充说明，再按词截断。 */
function fitSentence(sentence: string, max: number): string {
  if (width(sentence) <= max) return sentence;
  const lean =
    sentence
      .replace(LOCATION, "")
      .replace(/（[^（）]*）|\([^()]*\)/g, "")
      .replace(/^[\s—–-]+/, "")
      .trim() || sentence;
  return clipWords(lean, max);
}

type ReviewLine = {
  text: string;
  /** 编号条目且以加粗起头：审阅者列问题的标题行。 */
  headline: boolean;
  heading: boolean;
  /** 所在小节是不作为打回理由的（可选建议、已看过没问题的）。 */
  aside: boolean;
};

/** 「必须改的问题」小标题；「必须改的问题：无」也算。 */
const MUST_FIX = /^必须(?:要)?改(?:的问题)?\s*(?:[：:]\s*(?:无|没有)?[。.]?)?$/;
const MUST_FIX_HEAD = /必须(?:要)?改/;
const ASIDE_HEAD =
  /可选|建议|不打回|不作为|供参考|没有问题|没问题|已看过|核对过/;

/**
 * 审阅意见逐行拆开：跳过代码块与分隔线；编号在加粗里（`**1. …**`）也算编号条目；
 * 小标题是非列表项里 `#` 开头、整行加粗、以冒号收尾或整行写「必须改的问题」的。
 */
function reviewLines(notes: string): ReviewLine[] {
  const lines: ReviewLine[] = [];
  let fenced = false;
  let aside = false;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim().replace(/^>\s*/, "");
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || /^[-=*_|:\s]+$/.test(line)) continue;
    const marker = /^(?:[-*+]\s+|(\d+)[.)、]\s*)/.exec(line);
    let text = marker ? line.slice(marker[0].length) : line;
    const boldNumber = /^\*\*\d+[.)、]\s*/.exec(text);
    if (boldNumber) text = `**${text.slice(boldNumber[0].length)}`;
    const item = !!marker || !!boldNumber;
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
    const plain = plainText(text);
    const heading =
      !item &&
      (line.startsWith("#") ||
        (!!bold && !bold[2]!.replace(/^[：:]\s*/, "")) ||
        /[：:]$/.test(plain) ||
        MUST_FIX.test(plain.replace(/^#+\s*/, "")));
    if (heading) aside = ASIDE_HEAD.test(plain) && !MUST_FIX_HEAD.test(plain);
    const headline =
      (!!marker?.[1] || !!boldNumber) && text.startsWith("**") && !aside;
    lines.push({ text, headline, heading, aside: aside && !heading });
  }
  return lines;
}

/** 「**现象**：…」这类标签式加粗：标签不是要点，读冒号后面的话。 */
const LABEL =
  /^\*\*(?:现象|位置|复现|复现结果|怎么改|改法|对照|实测|原因|影响|结果|目标|说明)\s*[：:]?\*\*\s*[：:]?\s*/;

/** 一行里要读的那句：跳过标签式加粗；加粗开头的取加粗部分，否则取第一句。 */
function lineSentence(text: string): string {
  const label = LABEL.exec(text);
  if (label) return pointSentence(text.slice(label[0].length));
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  return pointSentence(bold ? bold[1]! : text);
}

/**
 * 从审阅意见里挑打回的理由：「必须改的问题」小节的第一条；没有这一节时取「结论：」那句，
 * 再没有取第一个编号问题标题（开头被截掉、小节标题跟着没了的常见情形），
 * 最后取第一句完整句子（开头被截过、以「…」起头的不算）。可选建议、已看过的小节都不取。
 */
function reviewPoint(notes: string): string | null {
  const lines = reviewLines(notes);
  const section = lines.findIndex(
    (line) => line.heading && MUST_FIX_HEAD.test(line.text),
  );
  if (section >= 0) {
    for (const line of lines.slice(section + 1)) {
      if (line.heading && MUST_FIX_HEAD.test(line.text)) continue;
      if (line.heading) break;
      const sentence = lineSentence(line.text);
      if (sentence) return sentence;
    }
  }
  for (const line of lines) {
    const verdict = /^(?:\*\*)?结论(?:\*\*)?\s*[：:]\s*(.+)$/.exec(line.text);
    const sentence = verdict ? firstSentence(plainText(verdict[1]!)) : "";
    if (sentence) return sentence;
  }
  const readable = lines.filter(
    (line) =>
      !line.heading &&
      !line.aside &&
      !/^(?:…|\.\.\.)/.test(line.text) &&
      !/^(?:\*\*)?审阅结论/.test(line.text),
  );
  for (const line of readable.filter((line) => line.headline)) {
    const sentence = lineSentence(line.text);
    if (sentence) return sentence;
  }
  for (const line of readable) {
    const sentence = lineSentence(line.text);
    if (sentence) return sentence;
  }
  return null;
}

const REVIEW = /^审阅打回(?:（(t\d+)[^）]*）)?\s*[：:]?([\s\S]*)$/;
const RETURNED = " · 已交回执行者";
const MERGE_FAILED = "合入没过：";
/** 合入交回那一句的显示宽度上限：后面还要接「 · 已交回执行者」。 */
const MERGE_WIDTH = HOLDER_WIDTH - width(RETURNED);

/** rebase 冲突写冲突文件数；原因里没有文件清单（git 只给了报错）时只写类别。 */
function conflictShort(text: string): string {
  const list = /冲突\s*[：:]\s*(.+)$/.exec(oneLine(text, Infinity))?.[1];
  const files = list?.split("、").filter(Boolean) ?? [];
  if (!files.length || files.some((file) => /\s/.test(file)))
    return "rebase 冲突";
  // merge-runtime 最多列 30 个文件。
  return files.length >= 30
    ? "rebase 冲突（至少 30 个文件）"
    : `rebase 冲突（${files.length} 个文件）`;
}

/** 本地检查：超时单说；没过时写第一个失败用例名，没抓到用例名只写类别。 */
function checkShort(text: string, max: number): string {
  const head = /^本地检查\s*([^：:]*)[：:]?([\s\S]*)$/.exec(text)!;
  if (/超时|timeout/i.test(head[1]!)) return "本地检查超时";
  const label = "本地检查没过";
  if (!/failed|失败|未通过|没过/i.test(head[1]!)) return label;
  const body = head[2]!.replace(/；\s*日志[\s\S]*$/, "").trim();
  if (!body || /^退出码/.test(body)) return label;
  // 用例名里常带「、」：有耗时标记时按它切，没有才按「、」。
  const timed = /^(.+?)\s*\(\d+(?:\.\d+)?m?s\)/.exec(body);
  const name = (timed ? timed[1]! : body.split("、")[0]!).trim();
  const point = clipWords(name, max - width(`${label}：`));
  return point ? `${label}：${point}` : label;
}

/**
 * 合入交回原因缩成一行、至多 max 显示宽度：原因类别加一句话，如「审阅打回：性能目标没达到（t132）」
 * 「本地检查没过：用例名」「rebase 冲突：2 个文件」。全文由 `task show` 给（Holder.detail）。
 */
export function mergeShort(reason: string, max = MERGE_WIDTH): string {
  const text = reason.trim();
  const review = REVIEW.exec(text);
  if (review) {
    const by = review[1] ? `（${review[1]}）` : "";
    const point = reviewPoint(review[2]!);
    if (!point) return `审阅打回${by}`;
    const room = max - width("审阅打回：");
    const fitted = fitSentence(point, room - width(by));
    if (by && (!fitted || fitted.endsWith("…"))) {
      // 理由比审阅者短号要紧：带着短号要截断、去掉就放得下时不写短号。
      const alone = fitSentence(point, room);
      if (alone && !alone.endsWith("…")) return `审阅打回：${alone}`;
    }
    return fitted ? `审阅打回：${fitted}${by}` : `审阅打回${by}`;
  }
  if (/rebase\s*冲突|变基\s*冲突|rebase\s+conflict/i.test(text))
    return conflictShort(text);
  if (/^本地检查/.test(text)) return checkShort(text, max);
  const line = oneLine(text, Infinity);
  const head = firstSentence(line) || line;
  return clipWords(head, max) || oneLine(head, max);
}

/** 合入交回的一句：审阅打回自成一类，其余写「合入没过：原因」。 */
function mergeBack(reason: string | null): string {
  if (!reason) return "合入没过";
  if (REVIEW.test(reason.trim())) return mergeShort(reason);
  return `${MERGE_FAILED}${mergeShort(reason, MERGE_WIDTH - width(MERGE_FAILED))}`;
}

/** 已结束且不在合入流水线、也不在等拍板的任务没有持球人；一句话统一截成单行。 */
export function holderOf(f: HolderFacts): Holder | null {
  const holder = judge(f);
  return holder
    ? {
        ...holder,
        text: oneLine(
          holder.kind === "worker" &&
            f.status === "running" &&
            f.host &&
            !f.checking
            ? onHost(holder.text, f.worker ?? "执行者", f.host)
            : holder.text,
          HOLDER_WIDTH,
        ),
      }
    : null;
}

/** 远程执行者：以执行者起头的一句（「在做」「5 分钟没进展」）把主机插在名字后，其余接在后面。 */
function onHost(text: string, worker: string, host: string) {
  return text.startsWith(`${worker} `)
    ? `${worker} @ ${host} ${text.slice(worker.length + 1)}`
    : `${worker} @ ${host} · ${text}`;
}

/** 摘要背后的原因全文：合入交回看交回原因，受阻或受阻后交回看受阻原因；没有为 null。 */
export function holderDetail(f: HolderFacts): string | null {
  if (f.rerun) return f.rerun.reason;
  if (f.status === "running" && f.returned?.via === "merge")
    return f.merge_returned;
  if (f.status === "blocked" || (f.status === "running" && f.returned))
    return f.block?.reason ?? null;
  return null;
}

function judge(f: HolderFacts): Holder | null {
  if (f.delivery_stage === "reviewing")
    return {
      kind: "merge",
      who: null,
      text: `合入前审阅中${f.review_task ? `（${f.review_task}）` : ""}`,
    };
  if (f.delivery_stage === "merge_queued")
    return {
      kind: "merge",
      who: null,
      text: f.merge_held_by?.length
        ? `合入暂停：等紧急 ${f.merge_held_by.join("、")} 先上线`
        : f.rerun
          ? `合入前${rerunShort(f.rerun.attempt)}`
          : "排队合入",
    };
  if (f.delivery_stage === "merging")
    return {
      kind: "merge",
      who: null,
      text: f.check_quiet
        ? `${where(f.checking)}${f.check_quiet}`
        : where(f.checking)
          ? `合入中：${where(f.checking)}跑快检查`
          : "合入中：rebase 并跑快检查",
    };
  if (f.delivery_stage === "merged" && f.online_wait === 1)
    return { kind: "merge", who: null, text: "已合入，等发版上线" };
  if (FINISHED.has(f.status)) return null;
  if (f.queued)
    return {
      kind: "queue",
      who: null,
      // 闲时任务的「等空闲：前面还有 N 件普通任务」自己说清了在等什么（t136）。
      text: f.queued.reason?.startsWith("等空闲")
        ? f.queued.reason
        : `排队${f.queued.reason ? `：${f.queued.reason}` : ""}`,
    };
  if (f.status === "running") {
    const worker = f.worker ?? "执行者";
    if (f.checking)
      return {
        kind: "worker",
        who: f.worker,
        text: where(f.checking)
          ? `${worker} 交付了，${where(f.checking)}跑检查`
          : `${worker} 交付了，本地检查中`,
      };
    if (f.worker_quiet_ms)
      return {
        kind: "worker",
        who: f.worker,
        text: `${worker} ${quietMinutes(f.worker_quiet_ms)}没进展`,
      };
    if (f.returned?.via === "merge")
      return {
        kind: "worker",
        who: f.worker,
        text: `${mergeBack(f.merge_returned)}${RETURNED}`,
      };
    if (f.returned)
      return {
        kind: "worker",
        who: f.worker,
        text: `${blockShort(f.block)} · ${f.returned.by ? `${whoLabel(f.returned.by)} ` : ""}已交回执行者`,
      };
    return { kind: "worker", who: f.worker, text: `${worker} 在做` };
  }
  // 被紧急任务抢占暂停的（t215）：运行时会在紧急通道清空后自己续上，不是等谁处理。
  if (f.status === "blocked" && f.preempted)
    return {
      kind: "queue",
      who: null,
      text: `被紧急 ${f.preempted.by ?? "任务"} 抢占暂停，之后自动续上`,
    };
  if (f.status === "blocked") {
    const why = blockShort(f.block);
    // 在 leader 手里的（t253）句末写挂了多久；原因放不下时先截原因，不截时长。
    const held = (who: string, tail: string) => {
      const hang =
        kindOf(who) === "leader" && f.held_since != null && f.now != null
          ? hangLabel(f.now - f.held_since)
          : "";
      const rest = ` · ${tail}${hang ? ` · ${hang}` : ""}`;
      const room = HOLDER_WIDTH - width(rest);
      return `${width(why) <= room ? why : clipWords(why, room) || why}${rest}`;
    };
    if (f.escalated)
      return {
        kind: kindOf(f.escalated.to),
        who: f.escalated.to,
        text: held(
          f.escalated.to,
          `${whoLabel(f.escalated.from)} 上交${f.escalated.to === "u1" ? "，等你" : `给${whoLabel(f.escalated.to)}`}`,
        ),
      };
    if (f.processing_by)
      return {
        kind: kindOf(f.processing_by),
        who: f.processing_by,
        text: held(
          f.processing_by,
          f.processing_by === "u1"
            ? "你在处理"
            : `${whoLabel(f.processing_by)} 在处理`,
        ),
      };
    const who = f.inbox?.subscriber ?? f.route;
    return {
      kind: kindOf(who),
      who,
      text:
        who === "u1"
          ? `${why} · 等你处理`
          : held(
              who,
              f.inbox?.acked
                ? `${whoLabel(who)} 已接手`
                : `等 ${whoLabel(who)} 处理`,
            ),
    };
  }
  // todo：等上游或自动派发的由运行时派；手动的等负责的 leader 或秘书派。
  if (f.schedule_state === "waiting")
    return {
      kind: "queue",
      who: null,
      text: f.waiting_for.length
        ? `等 ${f.waiting_for.map(readable).join("、")}`
        : `等上游${f.schedule_reason ? `：${f.schedule_reason}` : "完成"}`,
    };
  if (f.auto) return { kind: "queue", who: null, text: "就绪，自动派发" };
  return {
    kind: kindOf(f.route),
    who: f.route,
    text:
      f.route === "u1"
        ? "待派：等你派活"
        : `待派：等 ${whoLabel(f.route)} 派活`,
  };
}
