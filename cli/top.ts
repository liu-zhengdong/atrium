import { setTimeout as delay } from "node:timers/promises";
import { Problem } from "../server/problem.ts";
import { recordNext } from "./contract.ts";
import { oneLine, pad, printJson, width } from "./format.ts";
import type { Client } from "./service.ts";
import type { Command, Values } from "./main.ts";
import { PLAN_LINES, renderPlan, type PlanView } from "./top-plan.ts";
import { renderTopMap } from "./map.ts";
import { DEPTH_MAX, type MapTreeNode } from "../server/map/view.ts";
import type { LeaderWake } from "../server/leaders/model.ts";
import { wakeText } from "./leaders.ts";
import type { HostView } from "../server/tasks/host-load.ts";
import {
  secretaryText,
  type SecretaryView,
} from "../server/tasks/secretary-watch.ts";
import type { Holder } from "../server/tasks/holder.ts";
import type { TopTotal } from "../server/tasks/top.ts";
import { pendingLine, type PendingChoice } from "../server/choices/model.ts";
import { tagTitle } from "../server/tasks/priority.ts";
import {
  typeCountsText,
  typeTag,
  type TypeCounts,
} from "../server/tasks/task-type.ts";
import {
  verifyActionText,
  verifyStateText,
  type VerifyView,
} from "../server/tasks/verify-view.ts";

/**
 * `atrium top`（#262）：谁在干活、哪些任务在进行的实时视图。数据全部经服务取，不直接开数据库。
 * 默认全屏刷新，q / Ctrl-C 退出并还原终端；非 TTY 或 --once 只打一次，--json 给脚本。
 * 下面接全景段（根下各块的状态、在跑数与一句是什么，取自 `/api/map/tree`，#322）
 * 和排期（就绪、依赖链、等待中、因上游卡住，取自 `/api/tasks/plan`）。
 */

export type TopRow = {
  ref: string;
  title: string;
  status: string;
  delivery_stage?:
    "reviewing" | "merge_queued" | "merging" | "merged" | "online" | null;
  merge_queued_at?: number | null;
  worker: string | null;
  /** 在远程主机上跑（#358，hN）；本机或旧版服务没有。 */
  host?: string | null;
  host_name?: string | null;
  started_at: number | null;
  ended_at: number | null;
  queued_at: number | null;
  reason: string | null;
  /** 标了紧急（t113）；旧版服务没有这个字段。 */
  urgent?: boolean;
  /** 闲时（t136）：排在普通任务后面；旧版服务没有这个字段。 */
  idle?: boolean;
  /** 任务类型（t237）：feature 功能、fix 修复；旧版服务没有这个字段。 */
  type?: string;
  updated_at: number;
  note: string | null;
  note_by: string | null;
  note_at: number | null;
  processing: boolean;
  /** 捎话条数与未送达条数；旧版服务没有这个字段。 */
  tells?: { total: number; pending: number } | null;
  /** 现在球在谁手里（服务端判定）；旧版服务没有这个字段。 */
  holder?: Holder | null;
  checking?: { host: string | null } | null;
  /** 日志最后写入时刻；没有日志为 0。 */
  log_at: number;
  action: { text: string; kind: string } | null;
  /** 最近的总任务（t190）；不在总任务下为 null，旧版服务没有这个字段。 */
  total?: TopTotal | null;
  /** 上线后的端到端验证（t182）；没做验证为 null，旧版服务没有这个字段。 */
  verify?: VerifyView | null;
  /** 这是上线验证任务：验证的是哪个任务；旧版服务没有这个字段。 */
  verify_of?: string | null;
};

/**
 * 按最近的总任务分组（t190）：组里的行挪到组里第一行的位置、前面加一行总任务；
 * 没有总任务的照旧单行。返回画的次序，heading 为 null 的是普通行。
 */
export function groupByTotal(
  rows: readonly TopRow[],
): { heading: TopTotal | null; rows: TopRow[] }[] {
  const out: { heading: TopTotal | null; rows: TopRow[] }[] = [];
  const groups = new Map<string, TopRow[]>();
  for (const row of rows) {
    if (!row.total) {
      out.push({ heading: null, rows: [row] });
      continue;
    }
    const group = groups.get(row.total.ref);
    if (group) group.push(row);
    else {
      const created = [row];
      groups.set(row.total.ref, created);
      out.push({ heading: row.total, rows: created });
    }
  }
  return out;
}

/** 「▸ t174 离开电脑也能拍板 5/12 · 在做 t181、t183」 */
export function totalHeading(total: TopTotal, rows: readonly TopRow[]) {
  const live = rows.filter((row) => !FINISHED.has(phase(row)));
  return `▸ ${total.ref} ${total.title} ${total.progress}${live.length ? ` · 在做 ${live.map((row) => row.ref).join("、")}` : ""}`;
}

export type Snapshot = {
  now: number;
  recent_ms: number;
  subscriber: string;
  counts: {
    running: number;
    queued: number;
    reviewing?: number;
    merge_queued?: number;
    merging?: number;
    merged?: number;
    online?: number;
    verifying?: number;
    verify_failed?: number;
    unverifiable?: number;
    blocked: number;
    processing: number;
    done: number;
    failed: number;
    cancelled: number;
    events: number;
  };
  /** 在途任务按类型计数（t237）；旧版服务不给。 */
  types?: TypeCounts;
  rows: TopRow[];
  truncated: boolean;
  /** 本机负载与限额（#358）；旧版服务没有这个字段。 */
  host?: HostView;
  /** 秘书在不在听（t242）：看秘书的收件箱时给；旧版服务没有。 */
  secretary?: SecretaryView;
  /** 合入队列长度与预计还要多久（t254）；队列空或旧版服务不给。 */
  /** 接入的远程主机（#358 第 1 步）；没有远程主机时不给。 */
  hosts?: {
    ref: string;
    name: string;
    status: string;
    running: number;
    max: number | null;
  }[];
  /** leader 层：每位负责什么、最近一次唤醒在处理什么、还有几件要处理的事；没有 leader 时不给。 */
  leaders?: {
    ref: string;
    name: string;
    nodes: string[];
    wake: LeaderWake | null;
    events: number;
  }[];
  /** 等用户拍板的选项单（产品部）；没有时不给，旧版服务也没有。 */
  choices?: { open: number; list: PendingChoice[] };
  /** 进行中的紧急任务（t215）与太多时的提示；没有紧急任务时不给。 */
  urgent?: { count: number; refs: string[]; warning: string | null };
  /** 排期（`/api/tasks/plan` 第一页）；取不到为 null，原因在 plan_error。 */
  plan?: PlanView | null;
  plan_error?: string;
  /** 全景树（`/api/map/tree`，根下 depth 层）；取不到为 null，原因在 map_error。状态栏读这个字段。 */
  map?: { root: string | null; tree: MapTreeNode | null } | null;
  map_error?: string;
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
const MAX_WORKER = 32;

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

export function mapDepth(value: string | undefined) {
  if (value === undefined) return 2;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > DEPTH_MAX)
    throw new Problem(
      400,
      `--depth 应为 1～${DEPTH_MAX} 的整数（收到：${value}）`,
      "usage",
    );
  return Number(value);
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
  reviewing: "●",
  merge_queued: "◌",
  merging: "●",
  merged: "✓",
  online: "✓",
};
const FINISHED = new Set(["done", "failed", "cancelled"]);

/**
 * 行首符号：已上线的按验证状态（t182）画验证中 ●、验证没过 ✕；无法验证不是出了错，画中性的 ?（t255）。
 */
const VERIFY_SYMBOL: Record<string, string> = {
  running: "●",
  failed: "✕",
  unverifiable: "?",
};
function symbolOf(row: TopRow) {
  const kind = phase(row);
  const verify =
    kind === "online" && row.verify && VERIFY_SYMBOL[row.verify.state];
  if (verify) return verify;
  return (
    SYMBOL[row.processing && kind === "blocked" ? "processing" : kind] ?? "·"
  );
}

/** 视图里这一行算什么：排队优先于账本状态（排队重派会把状态改回 todo）。 */
export const phase = (row: TopRow) =>
  row.queued_at !== null
    ? "queued"
    : (row.delivery_stage ??
      (row.status === "running" || row.status === "blocked"
        ? row.status
        : row.status));

/** 任务行的标题：标了紧急的前面写「紧急」（t113），闲时的写「闲时」（t136）。 */
/** 标题前写「紧急」「闲时」「修复」（t237：功能不标，头部分开计数）；标题已带的不重复。 */
export const titleOf = (row: TopRow) =>
  tagTitle(
    row.urgent ? "紧急" : row.idle ? "闲时" : "",
    tagTitle(typeTag({ urgent: !!row.urgent, task_type: row.type }), row.title),
  );

/** 排队与受阻没有时长可言，直接说清在等什么。 */
function state(row: TopRow, now: number) {
  const kind = phase(row);
  if (kind === "queued") return `排队${row.reason ? `（${row.reason}）` : ""}`;
  if (kind === "reviewing") return "审阅中";
  if (kind === "merge_queued") return "排队合入";
  if (kind === "merging") return "合入中";
  if (kind === "merged") return "已合入";
  // 上线后的端到端验证（t182）：已上线 · 验证中／验证没过／无法验证／验证通过。
  if (kind === "online")
    return row.verify ? verifyStateText(row.verify) : "已上线";
  // 受阻由服务说清卡在哪、谁在接手；旧版服务没有 holder 时退回原写法。
  if (kind === "blocked")
    return row.holder
      ? row.holder.text
      : `${row.processing ? "处理中" : "卡住"}${row.reason ? `：${row.reason}` : ""}`;
  const from = row.started_at;
  const to = FINISHED.has(kind) ? (row.ended_at ?? now) : now;
  return from ? duration(to - from) : "—";
}

/** 最近动作加它距今多久；解析不出就说日志多久没动静，不猜。 */
function action(row: TopRow, now: number) {
  const kind = phase(row);
  if (kind === "queued" || kind === "blocked") return "";
  if (kind === "online" && row.verify) return verifyActionText(row.verify);
  // 检查进行中（#358 第 2 步）：说在哪台跑，执行者日志已经不动了。
  if (row.checking)
    return row.checking.host && row.checking.host !== "h1"
      ? `在 ${row.checking.host} 上跑检查`
      : "本地检查中";
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
  mapDepth?: number;
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

/** 执行者列：远程运行时在执行者后标机器名。 */
const workerCell = (row: TopRow) =>
  row.host_name
    ? `${row.worker ?? "执行者"} @ ${row.host_name}`
    : (row.worker ?? "");

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
    Math.max(0, ...rows.map((row) => width(workerCell(row)))),
    Math.max(
      0,
      width_ - (1 + 2 + refW + 2 + 2 + 2 + stateW + 2 + MIN_TITLE + MIN_ACTION),
    ),
  );
  const showWorker = width_ >= WORKER_MIN_WIDTH && workerW > 0;
  const overhead =
    1 + 2 + refW + 2 + 2 + (showWorker ? workerW + 2 : 0) + stateW + 2;
  const room = Math.max(MIN_TITLE + MIN_ACTION, width_ - overhead);
  const titleW = Math.max(
    MIN_TITLE,
    Math.min(
      Math.max(MIN_TITLE, ...rows.map((row) => width(titleOf(row)))),
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

/**
 * 抬头里的本机状态（#358）：只在暂停派新活时出现，放在排队数后面免得被截掉；
 * 写清是哪条线触发的（t113）：Atrium 自己占的核数，还是整机负载保护线，还是执行者满了。
 * top 抬头与状态栏共用这一句：没有排队的就不说「排队」，有就写几件。
 */
export function hostBrief(host: HostView | undefined, queued: number): string {
  if (!host?.paused) return "";
  const waiting = queued > 0 ? `，排队 ${queued} 件` : "";
  const load = (value: number) =>
    value >= 10 ? value.toFixed(0) : value.toFixed(1);
  const cores = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (
    host.paused_by === "own" &&
    host.own_cores != null &&
    host.busy_cores != null
  )
    return ` · 本机太忙${waiting}（Atrium 自己占了 ${cores(host.own_cores)} 核，超过 ${cores(host.busy_cores)}）`;
  if (
    host.paused_by === "load" ||
    (host.paused_by === undefined &&
      host.busy_load !== null &&
      host.load > host.busy_load)
  )
    return ` · 本机太忙${waiting}（整机负载 ${load(host.load)}，超过 ${load(host.busy_load!)}）`;
  return ` · 本机满 ${host.running}/${host.max_workers}${waiting}`;
}

/** 画一屏。排队与受阻那两列本来就是空的，所以原因长一点也不会顶掉别的列。 */
export function renderTop(snapshot: Snapshot, frame: Frame): string {
  // 同一总任务下的行排在一起，前面加一行总任务（t190）。
  const groups = groupByTotal(snapshot.rows);
  const rows = groups.flatMap((group) => group.rows);
  const headings = new Map<TopRow, string>();
  for (const group of groups)
    if (group.heading)
      headings.set(group.rows[0]!, totalHeading(group.heading, group.rows));
  // 原因可能是整篇（审阅意见、检查输出）：只取第一行，定宽和截断都按这一行算。
  const states = rows.map((row) => oneLine(state(row, frame.now), Infinity));
  // 状态列按时长那一类对齐；排队/受阻的原因是整段话，不参与定宽，借最近动作的空位展开。
  const stateW = Math.max(
    0,
    ...states.filter((_, index) => rowTakesStateWidth(rows[index]!)).map(width),
  );
  const plan = layoutOf(rows, frame.width, stateW);
  const clock = `${new Date(frame.now).toTimeString().slice(0, 5)} 刷新`;
  const head =
    // 在途任务按类型分开计数（t237）放最前：头部太长时截掉的是后面的细项。
    `Atrium · ${typeCountsText(snapshot.types) ? `${typeCountsText(snapshot.types)} · ` : ""}在跑 ${snapshot.counts.running}` +
    ` · 排队 ${snapshot.counts.queued}` +
    hostBrief(snapshot.host, snapshot.counts.queued) +
    (snapshot.counts.reviewing
      ? ` · 审阅中 ${snapshot.counts.reviewing}`
      : "") +
    (snapshot.counts.merge_queued
      ? ` · 排队合入 ${snapshot.counts.merge_queued}`
      : "") +
    (snapshot.counts.merging ? ` · 合入中 ${snapshot.counts.merging}` : "") +
    (snapshot.counts.merged ? ` · 已合入 ${snapshot.counts.merged}` : "") +
    (snapshot.counts.online ? ` · 已上线 ${snapshot.counts.online}` : "") +
    (snapshot.counts.verifying
      ? ` · 验证中 ${snapshot.counts.verifying}`
      : "") +
    (snapshot.counts.verify_failed
      ? ` · 验证没过 ${snapshot.counts.verify_failed}`
      : "") +
    (snapshot.counts.unverifiable
      ? ` · 无法验证 ${snapshot.counts.unverifiable}`
      : "") +
    ` · 处理中 ${snapshot.counts.processing}` +
    ` · 卡住 ${snapshot.counts.blocked}` +
    // 秘书在不在听（t242）；旧版服务没有这个字段，照旧只说未处理事件。
    (snapshot.secretary
      ? ` · ${secretaryText(snapshot.secretary).text}`
      : ` · 未处理事件 ${snapshot.counts.events}`);
  const headRoom = Math.max(10, frame.width - width(clock) - 1);
  const choice = snapshot.choices
    ? pendingLine(snapshot.choices.list, snapshot.choices.open)
    : null;
  const lines = [
    pad(oneLine(head, headRoom), headRoom) + clock,
    ...(choice ? [oneLine(choice, frame.width)] : []),
    // 紧急任务太多（t215）：不拒绝，只提醒。
    ...(snapshot.urgent?.warning
      ? [
          oneLine(
            `注意：${snapshot.urgent.warning}（${snapshot.urgent.refs.join("、")}）`,
            frame.width,
          ),
        ]
      : []),
    ...rows.flatMap((row, index) => {
      // 原因再长也不能顶出屏幕：状态列的上限是它自己的宽度加最近动作那段的空位。
      const cell = oneLine(states[index]!, plan.stateW + 2 + plan.actionW);
      const text = [
        `${symbolOf(row)} ${pad(row.ref, plan.refW)}`,
        pad(oneLine(titleOf(row), plan.titleW), plan.titleW),
        ...(plan.showWorker
          ? [pad(oneLine(workerCell(row), plan.workerW), plan.workerW)]
          : []),
        pad(cell, plan.stateW),
        pad(oneLine(action(row, frame.now), plan.actionW), plan.actionW),
      ]
        .join("  ")
        .trimEnd();
      // 无法验证的和已结束的一样淡着画（t255）：不是出了错。
      const quiet =
        FINISHED.has(phase(row)) || row.verify?.state === "unverifiable";
      const line = quiet && frame.color ? faint(text) : text;
      const heading = headings.get(row);
      return [
        ...(heading ? [oneLine(heading, frame.width)] : []),
        line,
        ...(row.note
          ? [
              `  ${oneLine(`备注（${row.note_by ?? "未知"} · ${new Date(row.note_at!).toLocaleString("zh-CN")}）：${row.note}`, frame.width - 2)}`,
            ]
          : []),
        ...(row.tells?.total
          ? [
              `  ${oneLine(`捎话 ${row.tells.total} 条${row.tells.pending ? `，${row.tells.pending} 条待送达` : "，都已送达"}`, frame.width - 2)}`,
            ]
          : []),
      ];
    }),
  ];
  if (!rows.length) lines.push("现在没有在跑、排队或受阻的任务");
  if (snapshot.truncated)
    lines.push(`（任务过多，只显示前 ${rows.length} 个）`);
  if (snapshot.hosts?.length)
    lines.push(
      "",
      oneLine(
        `主机：${snapshot.hosts.map((h) => `${h.ref} ${h.name} ${h.status} ${h.running}/${h.max ?? "不限"}`).join(" · ")}`,
        frame.width,
      ),
    );
  if (snapshot.leaders?.length)
    lines.push(
      "",
      "leader",
      ...snapshot.leaders.map(
        (l) =>
          `  ${oneLine(`${l.ref} ${l.name} · 负责 ${l.nodes.join("、") || "（无）"} · ${wakeText(l.wake)}${l.events ? ` · 待处理 ${l.events}` : ""}`, frame.width - 2)}`,
      ),
    );
  if (snapshot.map) {
    lines.push("");
    const room = frame.height
      ? Math.max(
          3,
          frame.height - lines.length - PLAN_MIN_LINES - (frame.footer ? 1 : 0),
        )
      : 20;
    lines.push(
      ...renderTopMap(
        snapshot.map.tree,
        frame.width,
        frame.mapDepth ?? 2,
        room,
      ),
    );
  } else if (snapshot.map === null)
    lines.push(
      "",
      oneLine(
        `全景：取不到（${snapshot.map_error ?? "未知原因"}）`,
        frame.width,
      ),
    );
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
      oneLine(
        `排期：取不到（${snapshot.plan_error ?? "未知原因"}）`,
        frame.width,
      ),
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

/** 看板、全景、排期一起取；附加接口取不到不影响看板。 */
export async function snapshotOf(
  api: Client,
  as: string | undefined,
  depth = 2,
): Promise<Snapshot> {
  const [snapshot, plan, map] = await Promise.all([
    api.get<Snapshot>(path(as)),
    api.get<PlanView>("/tasks/plan").then(
      (value) => ({ value }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    api
      .get<{
        root: string | null;
        tree: MapTreeNode | null;
      }>(`/map/tree?depth=${depth}`)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  ]);
  return {
    ...snapshot,
    ...("error" in map
      ? { map: null, map_error: map.error }
      : map.value && "tree" in map.value
        ? { map: { root: map.value.root, tree: map.value.tree } }
        : { map: null, map_error: "全景接口返回的格式看不懂" }),
    ...("error" in plan
      ? { plan: null, plan_error: plan.error }
      : plan.value?.groups && typeof plan.value.groups === "object"
        ? { plan: plan.value }
        : { plan: null, plan_error: "排期接口返回的格式看不懂" }),
  };
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
  depth = 2,
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
        snapshot = await snapshotOf(api, as, depth);
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
              mapDepth: depth,
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
  args: "[--once] [--json] [--interval 秒] [--width 列] [--depth N] [--as 订阅者]",
  about:
    "实时看谁在干活、全景图上两层各块的状态与在跑数，以及排期；--depth 展开全景层数；缺省每 2 秒刷新，q 或 Ctrl-C 退出",
  options: {
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    width: { type: "string" },
    depth: { type: "string" },
    as: { type: "string" },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const as = str(values, "as");
    if (as !== undefined && !as.trim())
      throw new Problem(400, "--as 不能为空", "usage");
    const seconds = interval(str(values, "interval"));
    const width_ = columns(str(values, "width"));
    const depth = mapDepth(str(values, "depth"));
    // 非终端、--once 与 --json 都只打一次；实时模式要能接管按键与清屏。
    const once =
      values.once === true ||
      json ||
      !process.stdout.isTTY ||
      !process.stdin.isTTY;
    const api = await client();
    if (!once) return watch(api, as, seconds, liveTerminal(), false, depth);
    const snapshot = await snapshotOf(api, as, depth);
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
          mapDepth: depth,
        }),
      );
      recordNext(`动作：${nextOf(snapshot.rows)}`);
    }
    return 0;
  },
};
