import { Problem } from "../problem.ts";

/**
 * 紧急通道（t215）：有紧急任务时全系统先保它。这里只放判定（纯函数、穷举测试），落库与执行在 `urgent-runtime.ts`、
 * `executors.ts`、`merge-runtime.ts`、`online-runtime.ts`、`review-runtime.ts`。
 *
 * - 谁能标：用户、秘书随时可标；leader 标须写原因（`--why`），并知会用户；不加审批。
 * - 先止损：`--stopgap` 只认三种动作（暂停主机、停掉任务、清理主机上 Atrium 拉起的残留进程），不执行任意命令。
 * - 抢占：没空位（本机满或太忙、独占工具被占）时先暂停在跑的闲时任务，不够再暂停普通任务；紧急的不暂停。
 *   被暂停的任务受阻并记下会话，紧急通道清空（没有紧急任务在跑、启动或排队）后原样续上。
 * - 合入：有紧急任务在合入流程（排队合入、合入中、已合入等上线）时，其他任务的合入先暂停；
 *   正在合入的普通任务在 gh 合入之前让路，回到队首。
 * - 换人：紧急任务的执行者连续 N 分钟（缺省 10，`ATRIUM_URGENT_IDLE_MINUTES`）没有进展就换执行者接着做，至多换两次。
 * - 同时进行的紧急任务多于 2 个时提示「太多就等于没有紧急」，不拒绝。
 */

/** 同时进行的紧急任务超过这么多就提示。 */
export const URGENT_CROWD = 2;
/** 紧急任务没有进展多久换执行者（分钟）。 */
export const URGENT_IDLE_MINUTES = 10;
/** 一件紧急任务至多换几次执行者；之后交给普通看门狗。 */
export const URGENT_MAX_SWAPS = 2;
/** 标紧急的原因至多多少字。 */
const WHY_MAX = 300;

const usage = (message: string) => new Problem(400, message, "usage");

// ---- 谁能标 ----

export type MarkVerdict =
  { ok: true; notify: boolean } | { ok: false; reason: string };

/**
 * 标紧急的权限：leader（aN 令牌）标紧急必须写原因，并知会用户；用户与秘书随时可标，不知会。
 * 取消紧急、或本来就不紧急的不管。
 */
export function markVerdict(input: {
  leader: string | undefined;
  urgent: boolean;
  why: string | null;
}): MarkVerdict {
  if (!input.urgent || !input.leader) return { ok: true, notify: false };
  if (!input.why)
    return {
      ok: false,
      reason: `why: ${input.leader} 标紧急须写原因，如 --why "线上满屏弹窗"`,
    };
  return { ok: true, notify: true };
}

/** 标紧急的原因：文本，至多 WHY_MAX 字；空为 null。 */
export function whyOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage("why: 应为文本");
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > WHY_MAX) throw usage(`why: 不能超过 ${WHY_MAX} 字`);
  return text;
}

/** 同时进行的紧急任务太多时的提示；不多为 null。 */
export function crowdWarning(count: number): string | null {
  return count > URGENT_CROWD
    ? `紧急任务有 ${count} 个，太多就等于没有紧急`
    : null;
}

// ---- 避开的主机 ----

const HOST_RE = /^h([1-9][0-9]{0,8})$/;

/** `--avoid-host h3,h4`（或数组）：主机短号列表，去重、至多 20 个；空为 []。 */
export function avoidHostsOf(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  const items =
    typeof value === "string"
      ? value.split(/[,，\s]+/)
      : Array.isArray(value)
        ? value
        : null;
  if (!items) throw usage("avoid_host: 应为主机短号，如 h3 或 h3,h4");
  const hosts: number[] = [];
  for (const item of items) {
    if (item === "") continue;
    const match =
      typeof item === "string" ? HOST_RE.exec(item.trim()) : undefined;
    if (!match) throw usage("avoid_host: 应为主机短号，如 h3 或 h3,h4");
    const id = Number(match[1]);
    if (!hosts.includes(id)) hosts.push(id);
  }
  if (hosts.length > 20) throw usage("avoid_host: 至多写 20 台主机");
  return hosts;
}

/** 库里存的避开主机（JSON 数组）；坏记录当没写。 */
export function storedHosts(text: string | null | undefined): number[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter(
          (item): item is number => Number.isSafeInteger(item) && item > 0,
        )
      : [];
  } catch {
    return [];
  }
}

// ---- 先止损 ----

export type StopgapAction =
  /** 暂停往这台主机派活。 */
  | { kind: "host_pause"; host: number }
  /** 停掉这些任务（在跑的结束进程树，排队的移出队列）。 */
  | { kind: "task_stop"; tasks: number[] }
  /** 清理这台主机上 Atrium 拉起的残留进程：停掉在那台跑的非紧急执行者，本机再结束已结束任务留下的执行者进程树。 */
  | { kind: "host_clean"; host: number };

const STOPGAP_MAX = 10;
const STOPGAP_HINT =
  "可用 atrium pause --host hN、atrium task stop tN[,tM]、atrium host clean hN，用分号隔开";

const TASK_LIST_RE = /^t[1-9][0-9]{0,8}(,t[1-9][0-9]{0,8})*$/;

function parseStopgapLine(line: string, index: number): StopgapAction {
  const words = line.trim().split(/\s+/);
  if (words[0] === "atrium") words.shift();
  const [group, verb, target, ...rest] = words;
  const bad = () =>
    usage(
      `stopgap: 第 ${index + 1} 条看不懂「${line.trim()}」；${STOPGAP_HINT}`,
    );
  // 暂停主机走一键停机：atrium pause --host hN。
  if (group === "pause" && verb === "--host" && target && !rest.length) {
    const match = HOST_RE.exec(target);
    if (!match) throw bad();
    return { kind: "host_pause", host: Number(match[1]) };
  }
  if (rest.length || !target) throw bad();
  if (group === "host" && verb === "clean") {
    const match = HOST_RE.exec(target);
    if (!match) throw bad();
    return { kind: "host_clean", host: Number(match[1]) };
  }
  if (group === "task" && verb === "stop") {
    const list = target.replace(/，/g, ",");
    if (!TASK_LIST_RE.test(list)) throw bad();
    return {
      kind: "task_stop",
      tasks: [...new Set(list.split(",").map((ref) => Number(ref.slice(1))))],
    };
  }
  throw bad();
}

function parseStopgapObject(value: unknown, index: number): StopgapAction {
  const item = (value ?? {}) as Record<string, unknown>;
  const bad = () => usage(`stopgap: 第 ${index + 1} 条看不懂；${STOPGAP_HINT}`);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw bad();
  if (item.kind === "host_pause" || item.kind === "host_clean") {
    const match =
      typeof item.host === "string" ? HOST_RE.exec(item.host) : null;
    if (!match) throw bad();
    return { kind: item.kind, host: Number(match[1]) };
  }
  if (item.kind === "task_stop") {
    const tasks = Array.isArray(item.tasks) ? item.tasks : [];
    if (
      !tasks.length ||
      tasks.some((ref) => typeof ref !== "string" || !TASK_LIST_RE.test(ref))
    )
      throw bad();
    return {
      kind: "task_stop",
      tasks: [
        ...new Set((tasks as string[]).map((ref) => Number(ref.slice(1)))),
      ],
    };
  }
  throw bad();
}

/**
 * 止损动作：命令行写法（`atrium pause --host h3; atrium task stop t1,t2`，分号、换行或 && 隔开，atrium 可省）
 * 或结构化数组（`[{kind:"host_pause",host:"h3"}]`）。只认三种动作，不执行任意命令；至多 STOPGAP_MAX 条。
 */
export function parseStopgap(value: unknown): StopgapAction[] {
  if (value === undefined || value === null || value === "") return [];
  const actions =
    typeof value === "string"
      ? value
          .split(/;|；|\n|&&/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map(parseStopgapLine)
      : Array.isArray(value)
        ? value.map(parseStopgapObject)
        : null;
  if (!actions) throw usage(`stopgap: 应为文本或动作列表；${STOPGAP_HINT}`);
  if (actions.length > STOPGAP_MAX)
    throw usage(`stopgap: 至多 ${STOPGAP_MAX} 条动作`);
  return actions;
}

/** 库里存的止损动作；坏记录当没写。 */
export function storedStopgap(text: string | null | undefined) {
  if (!text) return [];
  try {
    return parseStopgap(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

/** 存库与回执用的结构化写法（主机、任务写短号）。 */
export function stopgapJson(actions: readonly StopgapAction[]) {
  return actions.map((action) =>
    action.kind === "task_stop"
      ? { kind: action.kind, tasks: action.tasks.map((id) => `t${id}`) }
      : { kind: action.kind, host: `h${action.host}` },
  );
}

/** 一条动作的命令行写法（事件与回执里给人看）。 */
export function stopgapText(action: StopgapAction): string {
  if (action.kind === "task_stop")
    return `atrium task stop ${action.tasks.map((id) => `t${id}`).join(",")}`;
  return action.kind === "host_pause"
    ? `atrium pause --host h${action.host}`
    : `atrium host clean h${action.host}`;
}

// ---- 抢占 ----

/** 某台主机上一个在跑（含正在启动）的执行者。 */
export type RunningSlot = {
  id: number;
  tool: string;
  host: number;
  urgent: boolean;
  idle: boolean;
  /** 修复任务（t237，不算紧急的）；修复保底名额按它数；旧调用方不给。 */
  fix?: boolean;
  startedAt: number;
  /** 已在停（人工停、卡死、已被抢占、换人）：不再选它，也不指望它腾出更多。 */
  stopping: boolean;
};

export type PreemptPlan = {
  /** 要暂停的任务与原因：exclusive 独占工具被它占着，slot 腾执行者名额。 */
  victims: { id: number; why: "exclusive" | "slot" }[];
  /** 独占工具要等被暂停（或正在停）的那个退出后才能拉起：先排队，它一退出就轮到紧急的。 */
  wait: boolean;
};

/** 先暂停谁：闲时的在前、普通的在后，同一档先停最晚拉起的（丢的进度最少），再按任务号。 */
function victimOrder(a: RunningSlot, b: RunningSlot) {
  return (
    Number(b.idle) - Number(a.idle) || b.startedAt - a.startedAt || b.id - a.id
  );
}

/**
 * 紧急任务要在 host 上用 tool 时，为它暂停谁（纯函数）：
 * 独占工具被非紧急任务占着就暂停那个并等它退出（被紧急任务占着就只能排队等）；
 * 本机满或太忙（crowded）且还没因独占腾出名额，就在那台上按 victimOrder 暂停一个；没有能暂停的照旧超额拉起。
 */
export function preemptPlan(input: {
  self: number;
  host: number;
  tool: string;
  exclusive: boolean;
  crowded: boolean;
  running: readonly RunningSlot[];
}): PreemptPlan {
  const here = input.running.filter(
    (slot) => slot.host === input.host && slot.id !== input.self,
  );
  const victims: PreemptPlan["victims"] = [];
  let wait = false;
  if (input.exclusive) {
    const holders = here.filter((slot) => slot.tool === input.tool);
    if (holders.length) {
      wait = true;
      const holder = holders.find((slot) => !slot.urgent && !slot.stopping);
      if (holder && !holders.some((slot) => slot.urgent))
        victims.push({ id: holder.id, why: "exclusive" });
    }
  }
  if (input.crowded && !victims.length && !wait) {
    const candidate = here
      .filter((slot) => !slot.urgent && !slot.stopping)
      .sort(victimOrder)[0];
    if (candidate) victims.push({ id: candidate.id, why: "slot" });
  }
  return { victims, wait };
}

/** 暂停原因的人话（事件、受阻原因、看板）。 */
export function pausedText(by: number, why: "exclusive" | "slot") {
  return `被紧急任务 t${by} 抢占暂停（${why === "exclusive" ? "让出独占执行者" : "让出执行者名额"}），紧急通道清空后自动续上`;
}

// ---- 续上 ----

export type PausedEntry = {
  task: number;
  /** 被暂停的任务现在的状态。 */
  status: string;
  /** 已在排队、启动或在跑（有人手动派过了）。 */
  moving: boolean;
};

/**
 * 被暂停的任务何时续上（纯函数）：还有紧急任务在跑、启动或排队（urgentBusy > 0）就都等着；
 * 清空后按暂停先后续上仍在受阻的；被人取消、改了状态的不再管（drop），已在排队或启动的等它自己拉起。
 */
export function resumePlan(input: {
  urgentBusy: number;
  paused: readonly PausedEntry[];
}): { resume: number[]; drop: number[] } {
  // 在排队或启动的（有人手动派过）留着：拉起时照样续会话，拉起后记录自己关掉。
  const drop = input.paused
    .filter((entry) => !entry.moving && entry.status !== "blocked")
    .map((entry) => entry.task);
  if (input.urgentBusy > 0) return { resume: [], drop };
  return {
    resume: input.paused
      .filter((entry) => !entry.moving && entry.status === "blocked")
      .map((entry) => entry.task),
    drop,
  };
}

/** 续上时给执行者的说明（续会话时作为新一轮输入，不能续时写进重派的提示词）。 */
export function resumeNote(by: number | null, session: boolean) {
  const who = by ? `紧急任务 t${by} ` : "紧急任务";
  return session
    ? `你刚才被${who}抢占暂停，现在紧急通道已清空。接着把原任务做完：先看工作树里已有的改动与提交，再继续。`
    : `这件任务之前被${who}抢占暂停，工作树与分支都保留着（可能有上一位留下的改动与提交）。先看 git status 与 git log，接着做完，不要从头重来。`;
}

// ---- 合入队列 ----

export type MergeDecision =
  | { kind: "idle" }
  | { kind: "run"; id: number }
  /** 其他任务的合入先暂停：这些紧急任务还在合入流程里（排队合入、合入中、等上线）。 */
  | { kind: "hold"; by: number[] };

/**
 * 合入队列下一个做谁（纯函数）：NEXT_MERGE 挑出的队首是紧急的照做；不是紧急的，只要还有别的紧急任务在合入流程里
 * （排队合入、合入中、已合入等上线）就先暂停，等它们上线（或离开流程）后再继续。
 */
export function mergeDecision(input: {
  next: { id: number; urgent: boolean } | null;
  urgentFlow: readonly number[];
}): MergeDecision {
  if (!input.next) return { kind: "idle" };
  if (input.next.urgent) return { kind: "run", id: input.next.id };
  const by = input.urgentFlow.filter((id) => id !== input.next!.id);
  return by.length ? { kind: "hold", by } : { kind: "run", id: input.next.id };
}

/**
 * 正在合入的普通任务要不要让路（纯函数）：有紧急任务在等合入，且它还没发出 gh 合入（committed 为 false）就让；
 * 让路的回到排队合入、保留入队时刻，紧急的上线后接着做。
 */
export function mergeYield(input: {
  current: { urgent: boolean; committed: boolean } | null;
  urgentWaiting: boolean;
}): boolean {
  return (
    !!input.current &&
    !input.current.urgent &&
    !input.current.committed &&
    input.urgentWaiting
  );
}

/** 暂停中的合入在看板上的说法。 */
export function mergeHoldText(by: readonly number[]) {
  return `紧急任务 ${by.map((id) => `t${id}`).join("、")} 先合入上线，之后接着合入`;
}

// ---- 换人 ----

/** 读 ATRIUM_URGENT_IDLE_MINUTES：正数分钟（可带小数），其余按缺省并给出问题。 */
export function urgentIdleMs(env: NodeJS.ProcessEnv): {
  ms: number;
  problem: string | null;
} {
  const raw = env.ATRIUM_URGENT_IDLE_MINUTES;
  const fallback = URGENT_IDLE_MINUTES * 60_000;
  if (raw === undefined || raw.trim() === "")
    return { ms: fallback, problem: null };
  const value = Number(raw.trim());
  if (Number.isFinite(value) && value > 0 && value <= 24 * 60)
    return { ms: Math.round(value * 60_000), problem: null };
  return {
    ms: fallback,
    problem: `ATRIUM_URGENT_IDLE_MINUTES=${raw} 看不懂，按缺省 ${URGENT_IDLE_MINUTES} 分钟`,
  };
}

const minutesText = (ms: number) =>
  ms % 60_000 === 0
    ? `${ms / 60_000} 分钟`
    : ms >= 1000
      ? `${Math.round(ms / 1000)} 秒`
      : `${ms} 毫秒`;

/**
 * 紧急任务要不要换执行者（纯函数）：从最近一次进展（还没有进展就从拉起）算起超过 limitMs 就换；
 * 不是紧急、已在停、已经换够 maxSwaps 次的不换（交给普通看门狗）。
 */
export function swapDue(input: {
  urgent: boolean;
  stopping: boolean;
  startedAt: number;
  lastProgressAt: number | null;
  now: number;
  limitMs: number;
  swaps: number;
  maxSwaps?: number;
}): { kind: "ok" } | { kind: "swap"; reason: string } {
  if (!input.urgent || input.stopping) return { kind: "ok" };
  if (input.swaps >= (input.maxSwaps ?? URGENT_MAX_SWAPS))
    return { kind: "ok" };
  const since = input.lastProgressAt ?? input.startedAt;
  if (input.now - since < input.limitMs) return { kind: "ok" };
  return {
    kind: "swap",
    reason: `紧急任务的执行者 ${minutesText(input.limitMs)}没有进展，换执行者接着做`,
  };
}

/** 换上来的执行者在原工作树接着做的说明（写进提示词）。 */
export function swapNote(from: string, reason: string) {
  return `${reason}。前一位执行者（${from}）已停下，工作树与分支保留着它的改动；先看 git status 与 git log，接着把任务做完。`;
}

// ---- 挑人 ----

/** 紧急任务挑人时比较的一位候选。 */
export type UrgentRival = {
  /** 独占工具正忙（派了要排队或要抢占）。 */
  busy: boolean;
  /** 一次通过率（0～1）；没有记录为 null。 */
  firstPass: number | null;
  /** 交付少于 5 次，通过率只作参考。 */
  lowData: boolean;
  /** 交付耗时中位数（毫秒）；没有为 null。 */
  medianMs: number | null;
  /** 原来的排序位置（专员优先、固定顺序），最后的比较项。 */
  index: number;
};

/** 没有记录或记录太少时按这个一次通过率估。 */
const PRIOR_PASS = 0.5;

const passOf = (rival: UrgentRival) =>
  rival.firstPass === null
    ? PRIOR_PASS
    : rival.lowData
      ? (rival.firstPass + PRIOR_PASS) / 2
      : rival.firstPass;

/**
 * 紧急任务的候选先后（纯函数）：不看额度富余，先看正忙与否，再看一次通过率（记录少的向 0.5 收拢），
 * 通过率差不到 5 个百分点时看谁快（中位耗时短的在前、没数据的在后），最后按原来的顺序。
 */
export function urgentOrder(a: UrgentRival, b: UrgentRival): number {
  if (a.busy !== b.busy) return a.busy ? 1 : -1;
  const pass = passOf(b) - passOf(a);
  if (Math.abs(pass) >= 0.05) return pass;
  if (a.medianMs !== b.medianMs) {
    if (a.medianMs === null) return 1;
    if (b.medianMs === null) return -1;
    return a.medianMs - b.medianMs;
  }
  return pass || a.index - b.index;
}

// ---- 各阶段推送 ----

/** 紧急任务各阶段推送给谁（t215）：秘书（leaders/route.ts 的 SECRETARY）与用户（接推送前走事件）。 */
export const URGENT_WATCHERS = ["secretary", "u1"] as const;

/** 紧急阶段里要处理的三种（t219）：上线、卡住（换人也没进展）、止损动作失败。 */
export type UrgentAlert = "urgent_online" | "urgent_stuck" | "urgent_stopgap";

/**
 * 紧急任务的这个阶段要不要叫醒秘书、推给用户（t219）；其余阶段只作知会（进 events digest，不叫醒）。
 * 卡死判定（20 分钟）比换人（10 分钟没进展）晚，紧急任务报卡死就是换人也没进展。
 * 失败、受阻、上线失败另有普通结果事件按负责人投递，这里不重复叫醒。
 */
export function urgentAlert(
  kind: string,
  detail: Record<string, unknown> = {},
): UrgentAlert | null {
  if (kind === "online") return "urgent_online";
  if (kind === "stalled") return "urgent_stuck";
  if (
    kind === "stopgap" &&
    typeof detail.failed === "number" &&
    detail.failed > 0
  )
    return "urgent_stopgap";
  return null;
}

/** 紧急任务的阶段（推送给秘书与用户）；不是要推送的事件为 null。 */
export function urgentStage(kind: string): string | null {
  switch (kind) {
    case "start":
      return "开始";
    case "review_queued":
    case "merge_queued":
    case "done":
      return "交付";
    case "local_check_started":
    case "merge_check_started":
      return "检查";
    case "merged":
      return "合入";
    case "online":
      return "上线";
    case "online_failed":
      return "上线失败";
    case "failed":
      return "失败";
    case "blocked":
      return "受阻";
    case "stalled":
      return "卡死重试";
    case "urgent_swap":
      return "换人";
    case "stopgap":
      return "止损";
    case "preempting":
      return "抢占";
    default:
      return null;
  }
}
