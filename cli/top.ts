import { setTimeout as delay } from "node:timers/promises";
import { Problem } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { clip, pad, printJson, width } from "./format.ts";
import type { Client } from "./service.ts";
import type { Command, Values } from "./main.ts";
import { PLAN_LINES, renderPlan, type PlanView } from "./top-plan.ts";

/**
 * `atrium top`（#262）：谁在干活、哪些任务在进行的实时视图。数据全部经服务取，不直接开数据库。
 * 默认全屏刷新，q / Ctrl-C 退出并还原终端；非 TTY 或 --once 只打一次，--json 给脚本。
 * 下面接一段排期（就绪、依赖链、等待中、因上游卡住），取自 `/api/tasks/plan`。
 */

export type TopRow = {
  ref: string;
  title: string;
  status: string;
  worker: string | null;
  started_at: number | null;
  ended_at: number | null;
  queued_at: number | null;
  reason: string | null;
  updated_at: number;
  note: string | null;
  note_by: string | null;
  note_at: number | null;
  processing: boolean;
  /** 捎话条数与未送达条数；旧版服务没有这个字段。 */
  tells?: { total: number; pending: number } | null;
  /** 日志最后写入时刻；没有日志为 0。 */
  log_at: number;
  action: { text: string; kind: string } | null;
};

export type Snapshot = {
  now: number;
  recent_ms: number;
  subscriber: string;
  counts: {
    running: number;
    queued: number;
    blocked: number;
    processing: number;
    done: number;
    failed: number;
    cancelled: number;
    events: number;
  };
  rows: TopRow[];
  truncated: boolean;
  /** 排期（`/api/tasks/plan` 第一页）；取不到为 null，原因在 plan_error。 */
  plan?: PlanView | null;
  plan_error?: string;
};

// 不从 main.ts 取值：测试先加载本模块，main.ts 再回头引入会撞上循环初始化。
const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async (): Promise<Client> =>
  (await import("./service.ts")).connect();

const REFRESH_SECONDS = 2;
const REFRESH_MAX = 60;
/** 窄于此宽度就不给执行者列，省给标题和最近动作。 */
export const WORKER_MIN_WIDTH = 80;
const MIN_TITLE = 12;
const MIN_ACTION = 10;
const MAX_WORKER = 20;

function interval(value: string | undefined) {
  if (value === undefined) return REFRESH_SECONDS;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > REFRESH_MAX)
    throw new Problem(
      400,
      `--interval 应为 1～${REFRESH_MAX} 的整数秒（收到：${value}）`,
      "usage",
    );
  return Number(value);
}

function columns(value: string | undefined) {
  if (value === undefined) return process.stdout.columns || 80;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 20 || number > 500)
    throw new Problem(
      400,
      `--width 应为 20～500 的整数列数（收到：${value}）`,
      "usage",
    );
  return number;
}

// ---- 一行画成什么样 ----

const SYMBOL: Record<string, string> = {
  running: "●",
  queued: "◌",
  blocked: "✕",
  processing: "●",
  done: "✓",
  failed: "✕",
  cancelled: "·",
};
const FINISHED = new Set(["done", "failed", "cancelled"]);

/** 视图里这一行算什么：排队优先于账本状态（排队重派会把状态改回 todo）。 */
export const phase = (row: TopRow) =>
  row.queued_at !== null
    ? "queued"
    : row.status === "running" || row.status === "blocked"
      ? row.status
      : row.status;

/** 排队与受阻没有时长可言，直接说清在等什么。 */
function state(row: TopRow, now: number) {
  const kind = phase(row);
  if (kind === "queued") return `排队${row.reason ? `（${row.reason}）` : ""}`;
  if (kind === "blocked")
    return `${row.processing ? "处理中" : "卡住"}${row.reason ? `：${row.reason}` : ""}`;
  const from = row.started_at;
  const to = FINISHED.has(kind) ? (row.ended_at ?? now) : now;
  return from ? duration(to - from) : "—";
}

/** 最近动作加它距今多久；解析不出就说日志多久没动静，不猜。 */
function action(row: TopRow, now: number) {
  const kind = phase(row);
  if (kind === "queued" || kind === "blocked") return "";
  if (row.action?.text)
    return `${row.action.text} · ${ago(row.log_at, now)} 前`;
  if (row.log_at) return `日志 ${ago(row.log_at, now)} 前有输出`;
  return "";
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}

export const ago = (at: number, now: number) => duration(now - at);

export type Frame = {
  width: number;
  now: number;
  footer: boolean;
  color: boolean;
  /** 终端行数；给了就让排期段填满剩下的高度，没给用 PLAN_LINES。 */
  height?: number;
};

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const faint = (text: string) => (text ? `${DIM}${text}${RESET}` : text);

export type Layout = {
  refW: number;
  workerW: number;
  showWorker: boolean;
  titleW: number;
  actionW: number;
  stateW: number;
};

/** 标题最多占剩下的 55%，免得它在窄屏上把最近动作挤没。 */
const TITLE_SHARE = 0.55;

/** 列宽：短号与执行者按内容，标题与最近动作分剩下的宽度；两边都有下限。 */
export function layoutOf(
  rows: TopRow[],
  width_: number,
  stateW: number,
): Layout {
  const refW = Math.max(3, ...rows.map((row) => width(row.ref)));
  const workerW = Math.min(
    MAX_WORKER,
    Math.max(0, ...rows.map((row) => width(row.worker ?? ""))),
  );
  const showWorker = width_ >= WORKER_MIN_WIDTH && workerW > 0;
  const overhead =
    1 + 2 + refW + 2 + 2 + (showWorker ? workerW + 2 : 0) + stateW + 2;
  const room = Math.max(MIN_TITLE + MIN_ACTION, width_ - overhead);
  const titleW = Math.max(
    MIN_TITLE,
    Math.min(
      Math.max(MIN_TITLE, ...rows.map((row) => width(row.title))),
      Math.max(MIN_TITLE, Math.floor(room * TITLE_SHARE)),
    ),
  );
  return {
    refW,
    workerW,
    showWorker,
    titleW,
    stateW,
    actionW: Math.max(MIN_ACTION, room - titleW),
  };
}

/** 画一屏。排队与受阻那两列本来就是空的，所以原因长一点也不会顶掉别的列。 */
export function renderTop(snapshot: Snapshot, frame: Frame): string {
  const rows = snapshot.rows;
  const states = rows.map((row) => state(row, frame.now));
  // 状态列按时长那一类对齐；排队/受阻的原因是整段话，不参与定宽，借最近动作的空位展开。
  const stateW = Math.max(
    0,
    ...states.filter((_, index) => rowTakesStateWidth(rows[index]!)).map(width),
  );
  const plan = layoutOf(rows, frame.width, stateW);
  const clock = `${new Date(frame.now).toTimeString().slice(0, 5)} 刷新`;
  const head =
    `Atrium · 在跑 ${snapshot.counts.running}` +
    ` · 排队 ${snapshot.counts.queued}` +
    ` · 处理中 ${snapshot.counts.processing}` +
    ` · 卡住 ${snapshot.counts.blocked}` +
    ` · 未处理事件 ${snapshot.counts.events}`;
  const headRoom = Math.max(10, frame.width - width(clock) - 1);
  const lines = [
    pad(clip(head, headRoom), headRoom) + clock,
    ...rows.flatMap((row, index) => {
      // 原因再长也不能顶出屏幕：状态列的上限是它自己的宽度加最近动作那段的空位。
      const cell = clip(states[index]!, plan.stateW + 2 + plan.actionW);
      const text = [
        `${SYMBOL[row.processing && phase(row) === "blocked" ? "processing" : phase(row)] ?? "·"} ${pad(row.ref, plan.refW)}`,
        pad(clip(row.title, plan.titleW), plan.titleW),
        ...(plan.showWorker
          ? [pad(clip(row.worker ?? "", plan.workerW), plan.workerW)]
          : []),
        pad(cell, plan.stateW),
        pad(clip(action(row, frame.now), plan.actionW), plan.actionW),
      ]
        .join("  ")
        .trimEnd();
      const line = FINISHED.has(phase(row)) && frame.color ? faint(text) : text;
      return [
        line,
        ...(row.note
          ? [
              `  ${clip(`备注（${row.note_by ?? "未知"} · ${new Date(row.note_at!).toLocaleString("zh-CN")}）：${row.note}`, frame.width - 2)}`,
            ]
          : []),
        ...(row.tells?.total
          ? [
              `  ${clip(`捎话 ${row.tells.total} 条${row.tells.pending ? `，${row.tells.pending} 条待送达` : "，都已送达"}`, frame.width - 2)}`,
            ]
          : []),
      ];
    }),
  ];
  if (!rows.length) lines.push("现在没有在跑、排队或受阻的任务");
  if (snapshot.truncated)
    lines.push(`（任务过多，只显示前 ${rows.length} 个）`);
  if (snapshot.plan) {
    lines.push("");
    const room = frame.height
      ? frame.height - lines.length - (frame.footer ? 1 : 0)
      : PLAN_LINES;
    lines.push(
      ...renderPlan(snapshot.plan, {
        width: frame.width,
        now: frame.now,
        maxLines: Math.max(PLAN_MIN_LINES, room),
        wide: frame.width >= WORKER_MIN_WIDTH,
      }).lines,
    );
  } else if (snapshot.plan === null)
    lines.push(
      "",
      clip(`排期：取不到（${snapshot.plan_error ?? "未知原因"}）`, frame.width),
    );
  if (frame.footer) lines.push(`动作：${nextOf(rows)}`);
  return lines.join("\n");
}

const rowTakesStateWidth = (row: TopRow) => {
  const kind = phase(row);
  return kind !== "queued" && kind !== "blocked";
};

/** 下一步：先看在跑的，没有就看列表里第一个；一个都没有就叫建任务。 */
export const nextOf = (rows: TopRow[]) => {
  const live = rows.find((row) => phase(row) === "running") ?? rows[0];
  return live ? `atrium task show ${live.ref}` : "atrium task add 标题";
};

/** 终端再矮，排期段也至少留这么几行（含标题与折叠提示）。 */
const PLAN_MIN_LINES = 4;

/** 看板与排期一起取；排期取不到（如旧版服务）不影响看板，原因留在屏上。 */
export async function snapshotOf(
  api: Client,
  as: string | undefined,
): Promise<Snapshot> {
  const [snapshot, plan] = await Promise.all([
    api.get<Snapshot>(path(as)),
    api.get<PlanView>("/tasks/plan").then(
      (value) => ({ value }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);
  if ("error" in plan)
    return { ...snapshot, plan: null, plan_error: plan.error };
  if (!plan.value?.groups || typeof plan.value.groups !== "object")
    return { ...snapshot, plan: null, plan_error: "排期接口返回的格式看不懂" };
  return { ...snapshot, plan: plan.value };
}

export const path = (as: string | undefined) =>
  as === undefined ? "/tasks/top" : `/tasks/top?${new URLSearchParams({ as })}`;

// ---- 实时刷新 ----

/** 终端这一侧要做的事；抽出来是为了 --once 与测试不走终端分支。 */
export type Terminal = {
  columns: () => number;
  rows?: () => number;
  color: () => boolean;
  enter: () => void;
  leave: () => void;
  frame: (text: string) => void;
  onQuit: (quit: () => void) => void;
  offQuit: () => void;
};

/** 真的终端才接管按键与清屏；q、Q、Ctrl-C、Ctrl-D 退出，其余按键忽略。 */
export function liveTerminal(): Terminal {
  let release: (() => void) | undefined;
  return {
    columns: () => process.stdout.columns || 80,
    rows: () => process.stdout.rows || 24,
    color: () => Boolean(process.stdout.isTTY),
    enter: () => process.stdout.write("\x1b[?1049h\x1b[?25l"),
    leave: () => process.stdout.write("\x1b[?25h\x1b[?1049l"),
    frame: (text) => process.stdout.write(`\x1b[H\x1b[0J${text}\n`),
    onQuit: (quit) => {
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (/[qQ]/.test(text) || text.includes("\x03") || text.includes("\x04"))
          quit();
      };
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      release = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      };
    },
    offQuit: () => {
      release?.();
      release = undefined;
    },
  };
}

/** 循环到用户退出：取一次、画一屏、等 interval 秒；服务不可用就把原因留在屏上继续试。 */
export async function watch(
  api: Client,
  as: string | undefined,
  seconds: number,
  terminal: Terminal,
  once = false,
) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  if (!once) {
    terminal.enter();
    terminal.onQuit(stop);
    // 终端状态在退出时必须还原（含信号与未捕获异常），否则用户的 shell 留在备用屏里。
    const restore = () => {
      if (stopped) return;
      stopped = true;
      terminal.offQuit();
      terminal.leave();
    };
    process.once("exit", restore);
    process.once("SIGINT", restore);
    process.once("SIGTERM", restore);
  }
  try {
    // 每轮开头看一次退出标志：按键是在 delay 期间到的，下一轮就会收手。
    while (!stopped) {
      let snapshot: Snapshot | undefined;
      let reason: string | null = null;
      try {
        snapshot = await snapshotOf(api, as);
      } catch (error) {
        reason =
          error instanceof Problem
            ? error.message
            : `取数据失败：${error instanceof Error ? error.message : String(error)}`;
      }
      terminal.frame(
        snapshot
          ? renderTop(snapshot, {
              width: terminal.columns(),
              now: Date.now(),
              footer: true,
              color: terminal.color(),
              height: terminal.rows?.(),
            })
          : `Atrium · ${reason}`,
      );
      if (once) break;
      await delay(seconds * 1000);
    }
  } finally {
    if (!once) {
      terminal.offQuit();
      terminal.leave();
    }
  }
  return 0;
}

export const topCommand: Command = {
  args: "[--once] [--json] [--interval 秒] [--width 列] [--as 订阅者]",
  about:
    "实时看谁在干活：在跑、排队、受阻与刚结束的任务，带执行者、已运行时长与最近一个动作；下面是排期（就绪、依赖链、等待中及在等谁）；缺省每 2 秒刷新，q 或 Ctrl-C 退出",
  options: {
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    width: { type: "string" },
    as: { type: "string" },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const as = str(values, "as");
    if (as !== undefined && !as.trim())
      throw new Problem(400, "--as 不能为空", "usage");
    const seconds = interval(str(values, "interval"));
    const width_ = columns(str(values, "width"));
    // 非终端、--once 与 --json 都只打一次；实时模式要能接管按键与清屏。
    const once =
      values.once === true ||
      json ||
      !process.stdout.isTTY ||
      !process.stdin.isTTY;
    const api = await client();
    if (!once) return watch(api, as, seconds, liveTerminal());
    const snapshot = await snapshotOf(api, as);
    if (json) {
      printJson(snapshot);
      recordNext("实时看：atrium top");
    } else {
      console.log(
        renderTop(snapshot, {
          width: width_,
          now: Date.now(),
          footer: false,
          color: false,
        }),
      );
      recordNext(`动作：${nextOf(snapshot.rows)}`);
    }
    return 0;
  },
};
