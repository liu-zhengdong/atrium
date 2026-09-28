import { Problem } from "../problem.ts";

/**
 * 任务类型（t237）：功能与修复分开计数、分开排节奏，调度给修复保底留名额。不是关卡。
 *
 * - 账本只存两档：功能 feature 与修复 fix，存 `tasks.task_type`；紧急只认 `tasks.urgent`（t215），
 *   显示时紧急的算「紧急」，不另存一份，免得两处对不上。`--type 紧急` 在命令行里等于 `--urgent`。
 * - 不写时推断（`inferType`）：来源明确的按来源（选项单来的是功能；巡检、上线验证没过、关卡交回派生的是修复），
 *   否则标题像修 bug 的算修复，再否则跟父任务，都没有算功能。
 * - 修复保底名额（`fixReserve` / `reserveHolds`）：每台主机按执行者上限的比例给修复留 1–2 个位置；
 *   有修复任务在等时功能任务不占这几个位置，没有修复在等时照常给功能用；紧急的照旧不看名额、可以抢占。
 *
 * 都是纯函数；读库拼事实在 `ledger-write.ts`（建任务）、`runner.ts`（主机候选）与 `queue.ts`（在等的修复）。
 */

export const TASK_TYPES = ["feature", "fix"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
/** 显示用的类型：紧急的另算。 */
export type ShownType = TaskType | "urgent";

export const TYPE_LABEL: Record<ShownType, string> = {
  feature: "功能",
  fix: "修复",
  urgent: "紧急",
};

const ALIASES: Record<string, ShownType> = {
  feature: "feature",
  fix: "fix",
  urgent: "urgent",
  功能: "feature",
  修复: "fix",
  紧急: "urgent",
};

/** 命令行的 `--type`：功能 / 修复 / 紧急（也认 feature、fix、urgent）；看不懂返回 undefined。 */
export function typeOption(value: string): ShownType | undefined {
  return ALIASES[value.trim().toLowerCase()];
}

/**
 * 接口里的 `type`：只收功能 / 修复。紧急走 `urgent`（leader 标要写原因、知会用户），
 * 不能借 type 绕过去，所以这里拒绝并说清怎么写。
 */
export function parseTaskType(value: unknown): TaskType {
  const found = typeof value === "string" ? typeOption(value) : undefined;
  if (found === "urgent")
    throw new Problem(400, "type: 紧急用 --urgent 标", "usage");
  if (!found) throw new Problem(400, "type: 只能是 功能 或 修复", "usage");
  return found;
}

/** 任务从哪来（建任务的运行时知道时传）：选项单、巡检、上线验证、关卡交回。 */
export type TypeSource = "choice" | "patrol" | "verify" | "gate";

const SOURCE_TYPE: Record<TypeSource, TaskType> = {
  choice: "feature",
  patrol: "fix",
  verify: "fix",
  gate: "fix",
};

/**
 * 标题像修 bug：修复、修掉、修好、修正、bug（debug 不算）、fix、报错、崩溃、回归、不生效、没生效，或以「修」开头（修改、修订不算）。
 * 故意收得窄：「失败重试」「没过才叫醒」这类讲机制的功能标题不算。
 */
const FIX_TITLE =
  /修复|修掉|修好|修正|\bbugs?\b|\bfix(?:es|ed)?\b|报错|崩溃|回归|不生效|没生效|^\s*修(?![改订饰建])/i;

export const fixLikeTitle = (title: string) => FIX_TITLE.test(title);

/** 不写类型时的推断：来源 → 标题 → 父任务 → 功能。 */
export function inferType(input: {
  title: string;
  source?: TypeSource | null;
  parent?: TaskType | null;
}): TaskType {
  if (input.source) return SOURCE_TYPE[input.source];
  if (fixLikeTitle(input.title)) return "fix";
  return input.parent ?? "feature";
}

/** 账本里的值读成类型：旧库没有列或写坏了按功能。 */
export const storedType = (value: unknown): TaskType =>
  value === "fix" ? "fix" : "feature";

/** 显示用的类型：标了紧急就是紧急，否则按账本。 */
export const shownType = (task: {
  urgent: number | boolean;
  task_type?: string | null;
}): ShownType => (task.urgent ? "urgent" : storedType(task.task_type));

export type TypeCounts = Record<ShownType, number>;

/** 各类型计数（纯函数）；n 是这一行代表几件（按类型分组查出的），不给算 1 件。 */
export function countTypes(
  rows: readonly {
    urgent: number | boolean;
    task_type?: string | null;
    n?: number;
  }[],
): TypeCounts {
  const counts: TypeCounts = { feature: 0, fix: 0, urgent: 0 };
  for (const row of rows) counts[shownType(row)] += row.n ?? 1;
  return counts;
}

/** 头部计数的写法：「功能 N · 修复 M · 紧急 K」；全是 0 时为空串。 */
export function typeCountsText(counts: TypeCounts | null | undefined) {
  if (!counts || counts.feature + counts.fix + counts.urgent === 0) return "";
  return `功能 ${counts.feature} · 修复 ${counts.fix} · 紧急 ${counts.urgent}`;
}

/** 修复任务在标题前的标记（功能不标，紧急另标）。 */
export const typeTag = (task: {
  urgent: number | boolean;
  task_type?: string | null;
}) => (shownType(task) === "fix" ? "修复" : "");

// ---- 修复保底名额 ----

/** 缺省按执行者上限的 25% 给修复留位置（至少 1、至多 2）。 */
export const FIX_RESERVE_PERCENT = 25;
export const FIX_RESERVE_MIN = 1;
export const FIX_RESERVE_MAX = 2;

/**
 * 一台主机给修复留几个位置（纯函数）：上限 × 比例四舍五入，夹在 1–2 之间，并至少给功能留 1 个；
 * 不限上限（null）、上限不到 2 或比例为 0 时不留。
 */
export function fixReserve(max: number | null, percent: number): number {
  if (max === null || max < 2 || !(percent > 0)) return 0;
  const byShare = Math.round((max * percent) / 100);
  const clamped = Math.min(FIX_RESERVE_MAX, Math.max(FIX_RESERVE_MIN, byShare));
  return Math.min(clamped, max - 1);
}

/**
 * 读 ATRIUM_FIX_RESERVE_PERCENT：0–100 的整数；0 或 off 不留。写错返回 undefined 让调用方按缺省并提示。
 */
export function parseReservePercent(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim().toLowerCase();
  if (text === "off" || text === "none" || text === "false") return 0;
  if (!/^(100|[1-9]?[0-9])$/.test(text)) return undefined;
  return Number(text);
}

/**
 * 保底名额挡不挡这件活（纯函数）：这台主机上限 max、在跑 running（含正在启动）、其中修复 fixRunning、
 * 留给修复的 reserve；有修复任务在等（fixWaiting）时，功能任务拉起后要给还没被修复占上的保底位置留空。
 * 修复、紧急的不挡；没有修复在等时不挡。返回 true 表示要挡。
 */
export function reserveHolds(input: {
  max: number | null;
  running: number;
  fixRunning: number;
  reserve: number;
  fixWaiting: boolean;
  type: TaskType;
  urgent: boolean;
}): boolean {
  if (input.urgent || input.type === "fix" || !input.fixWaiting) return false;
  if (input.max === null || input.reserve <= 0) return false;
  const open = Math.max(0, input.reserve - input.fixRunning);
  return input.running + 1 > input.max - open;
}

/** 被保底名额挡住时的说法。 */
export const reserveText = (host: string, reserve: number) =>
  `${host} 给修复留了 ${reserve} 个位置，有修复任务在等；位置空出来或修复都派出去后自动拉起`;
