import type { TaskRow } from "./ledger-model.ts";
import type { TaskStatus } from "./state.ts";
import { oneLine } from "../text-width.ts";

/**
 * 未结束任务「现在球在谁手里」（#355 追加）：状态栏与 top 按它显示，不再自己从状态和 PR 猜。
 * 纯函数：事实由 holder-facts.ts 从账本、收件箱、会审表取来。
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
  /** 这是一场会审，且已上交用户拍板、还没定。 */
  council_escalated: boolean;
};

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

/** 人话名字：u1 → 你，secretary → 秘书，其余原样。 */
export function whoLabel(who: string): string {
  return who === "u1" ? "你" : who === "secretary" ? "秘书" : who;
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

/** 从审阅意见里挑一句：跳过标题与「必须改的问题：」这类小标题，列表项有加粗开头的取加粗部分。 */
function reviewPoint(notes: string): string | null {
  let fenced = false;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith("#")) continue;
    const item = line
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+]|\d+[.)、])\s*/, "");
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(item);
    // 整行只有加粗或以冒号收尾的，是小标题。
    if (bold && !bold[2]!.replace(/^[：:]\s*/, "")) continue;
    const plain = (bold ? bold[1]! : item)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!plain || /[：:]$/.test(plain) || /^[-=*_|:\s]+$/.test(plain)) continue;
    const sentence = plain.split(/[。！？；!?;]|[：:]/)[0]!.trim();
    if (sentence) return sentence;
  }
  return null;
}

/**
 * 合入交回原因缩成一行：原因类别加一句话，如「审阅打回：性能目标没达到（t132）」「本地检查没过」「rebase 冲突」。
 * 全文由 `task show` 给（Holder.detail）。
 */
export function mergeShort(reason: string): string {
  const text = reason.trim();
  const review = /^审阅打回(?:（(t\d+)[^）]*）)?\s*[：:]?([\s\S]*)$/.exec(text);
  if (review) {
    const point = reviewPoint(review[2]!);
    const by = review[1] ? `（${review[1]}）` : "";
    return point ? `审阅打回：${oneLine(point, 30)}${by}` : `审阅打回${by}`;
  }
  if (/rebase\s*冲突|变基\s*冲突|rebase\s+conflict/i.test(text))
    return "rebase 冲突";
  if (/^本地检查/.test(text))
    return /超时|timeout/i.test(text.split(/[：:]/)[0]!)
      ? "本地检查超时"
      : "本地检查没过";
  const line = oneLine(text, Infinity);
  return oneLine(line.split(/[：:]/)[0]!.trim() || line, 30);
}

/** 合入交回的一句：审阅打回自成一类，其余写「合入没过：原因」。 */
function mergeBack(reason: string | null): string {
  if (!reason) return "合入没过";
  const short = mergeShort(reason);
  return short.startsWith("审阅打回") ? short : `合入没过：${short}`;
}

/** 已结束且不在合入流水线、也不在等拍板的任务没有持球人；一句话统一截成单行。 */
export function holderOf(f: HolderFacts): Holder | null {
  const holder = judge(f);
  return holder
    ? { ...holder, text: oneLine(holder.text, HOLDER_WIDTH) }
    : null;
}

/** 摘要背后的原因全文：合入交回看交回原因，受阻或受阻后交回看受阻原因；没有为 null。 */
export function holderDetail(f: HolderFacts): string | null {
  if (f.status === "running" && f.returned?.via === "merge")
    return f.merge_returned;
  if (f.status === "blocked" || (f.status === "running" && f.returned))
    return f.block?.reason ?? null;
  return null;
}

function judge(f: HolderFacts): Holder | null {
  if (f.council_escalated)
    return { kind: "user", who: "u1", text: "会审上交，等你拍板" };
  if (f.delivery_stage === "reviewing")
    return {
      kind: "merge",
      who: null,
      text: `合入前审阅中${f.review_task ? `（${f.review_task}）` : ""}`,
    };
  if (f.delivery_stage === "merge_queued")
    return { kind: "merge", who: null, text: "排队合入" };
  if (f.delivery_stage === "merging")
    return { kind: "merge", who: null, text: "合入中：rebase 并重跑本地检查" };
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
    if (f.returned?.via === "merge")
      return {
        kind: "worker",
        who: f.worker,
        text: `${mergeBack(f.merge_returned)} · 已交回执行者`,
      };
    if (f.returned)
      return {
        kind: "worker",
        who: f.worker,
        text: `${blockShort(f.block)} · ${f.returned.by ? `${whoLabel(f.returned.by)} ` : ""}已交回执行者`,
      };
    return { kind: "worker", who: f.worker, text: `${worker} 在做` };
  }
  if (f.status === "blocked") {
    const why = blockShort(f.block);
    if (f.escalated)
      return {
        kind: kindOf(f.escalated.to),
        who: f.escalated.to,
        text: `${why} · ${whoLabel(f.escalated.from)} 上交${f.escalated.to === "u1" ? "，等你" : `给${whoLabel(f.escalated.to)}`}`,
      };
    if (f.processing_by)
      return {
        kind: kindOf(f.processing_by),
        who: f.processing_by,
        text: `${why} · ${f.processing_by === "u1" ? "你在处理" : `${whoLabel(f.processing_by)} 在处理`}`,
      };
    const who = f.inbox?.subscriber ?? f.route;
    return {
      kind: kindOf(who),
      who,
      text:
        who === "u1"
          ? `${why} · 等你处理`
          : `${why} · ${f.inbox?.acked ? `${whoLabel(who)} 已接手` : `等 ${whoLabel(who)} 处理`}`,
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
