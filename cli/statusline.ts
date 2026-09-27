import { Problem } from "../server/problem.ts";
import {
  HOLDER_WIDTH,
  type Holder,
  type HolderKind,
} from "../server/tasks/holder.ts";
import { printJson, oneLine } from "./format.ts";
import type { Command } from "./main.ts";
import type { Client } from "./service.ts";
import { duration, hostBrief, type Snapshot, type TopRow } from "./top.ts";
import type { PlanView } from "./top-plan.ts";

/**
 * `atrium statusline`（#355）：Claude Code 状态栏。数据经服务取（`/api/tasks/top` 与 `/api/tasks/plan`），
 * 服务不在就显示「未运行」，不拉起服务。每个未结束任务按服务给的 holder（球在谁手里）显示，
 * 不自己从状态或 PR 猜；只有真在等用户时用醒目颜色写「等你」。
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** 任务最多显示几行，多了折叠。 */
export const TASK_LINES = 8;
const TITLE_MAX = 28;

/** 先列等你的，再列在做的、leader 与秘书手里的、合入中的、排队的。 */
const ORDER: HolderKind[] = [
  "user",
  "worker",
  "leader",
  "secretary",
  "merge",
  "queue",
];
const MARK: Record<HolderKind, [mark: string, color: string]> = {
  user: ["✱", `${BOLD}${RED}`],
  worker: ["●", GREEN],
  leader: ["◇", YELLOW],
  secretary: ["◇", YELLOW],
  merge: ["◆", CYAN],
  queue: ["◌", DIM],
};

/** codex+gpt-6-sol:high → codex · gpt-6-sol；opencode+opencode/x → opencode · x。 */
export function workerLabel(worker: string | null): string {
  const [harness, rest = ""] = (worker ?? "?").split("+", 2);
  const model = rest.split(":")[0]!.split("/").at(-1) ?? "";
  return model ? `${harness} · ${model}` : harness!;
}

type Paint = (color: string, text: string) => string;

function taskLine(row: TopRow, full: Holder, now: number, paint: Paint) {
  // 旧版服务给的一句话可能是整篇原因，这里再截一次。
  const holder = { ...full, text: oneLine(full.text, HOLDER_WIDTH) };
  const [mark, color] = MARK[holder.kind];
  const tag = row.urgent
    ? `${paint(`${BOLD}${RED}`, "紧急")} `
    : row.idle
      ? `${paint(DIM, "闲时")} `
      : "";
  const title = `${tag}「${oneLine(row.title, TITLE_MAX)}」`;
  if (holder.kind === "user")
    return `${paint(color, mark)} ${row.ref} ${title} ${paint(color, `等你：${holder.text}`)}`;
  if (holder.kind === "worker") {
    const took = row.started_at ? ` ${duration(now - row.started_at)}` : "";
    // 在做就只写谁在做与用时；被挡回又交回的，把经过写上。
    const story = holder.text.endsWith(" 在做") ? "" : ` · ${holder.text}`;
    return `${paint(color, mark)} ${row.ref} ${title} ${workerLabel(row.worker)}${paint(DIM, took)}${story}`;
  }
  const text =
    holder.kind === "queue"
      ? paint(DIM, holder.text)
      : paint(color, holder.text);
  return `${paint(color, mark)} ${row.ref} ${title} ${text}`;
}

export type StatuslineInput = {
  snapshot: Snapshot & { rows: (TopRow & { holder?: Holder | null })[] };
  plan: PlanView | null;
  now: number;
  color: boolean;
};

export function renderStatusline(input: StatuslineInput): string {
  const paint: Paint = (color, text) =>
    input.color && text ? `${color}${text}${RESET}` : text;
  const { snapshot, now } = input;
  const held = snapshot.rows
    .filter((row): row is TopRow & { holder: Holder } => !!row.holder)
    .sort(
      (a, b) =>
        ORDER.indexOf(a.holder.kind) - ORDER.indexOf(b.holder.kind) ||
        (a.started_at ?? a.updated_at) - (b.started_at ?? b.updated_at),
    );
  const count = (kind: HolderKind) =>
    held.filter((row) => row.holder.kind === kind).length;
  const leaders = (snapshot.leaders ?? []).filter(
    (l) => l.wake?.status === "running" || l.events > 0,
  );
  const events = snapshot.counts.events;
  const ready = input.plan?.groups.ready.length ?? 0;
  const waiting = input.plan?.groups.waiting.length ?? 0;
  if (!held.length && !leaders.length && !events && !ready && !waiting)
    return paint(DIM, "Atrium 空闲");
  const parts = [
    `在做 ${count("worker")}`,
    ...(count("leader") ? [`leader 处理 ${count("leader")}`] : []),
    ...(count("secretary") ? [`秘书处理 ${count("secretary")}`] : []),
    ...(count("merge") ? [`合入 ${count("merge")}`] : []),
    ...(count("queue") ? [`排队 ${count("queue")}`] : []),
  ];
  const head = [
    // 暂停派新活时写清是哪条线（t113）：Atrium 自己占的核、整机负载保护线，还是执行者满了。
    `Atrium ${parts.join(" · ")}${hostBrief(snapshot.host)}`,
    ...(count("user") ? [paint(`${BOLD}${RED}`, `等你 ${count("user")}`)] : []),
    ...(events
      ? [
          paint(
            YELLOW,
            `${snapshot.subscriber === "secretary" ? "秘书" : snapshot.subscriber}未处理事件 ${events}`,
          ),
        ]
      : []),
  ].join(" · ");
  const lines = [head];
  for (const row of held.slice(0, TASK_LINES))
    lines.push(taskLine(row, row.holder, now, paint));
  if (held.length > TASK_LINES)
    lines.push(
      paint(DIM, `  …还有 ${held.length - TASK_LINES} 个，atrium top 看全部`),
    );
  for (const leader of leaders) {
    const doing =
      leader.wake?.status === "running"
        ? `处理中${leader.wake.summary ? `：${oneLine(leader.wake.summary, 40)}` : ""}`
        : "";
    const pending = leader.events ? `待处理 ${leader.events} 件` : "";
    lines.push(
      `${paint(YELLOW, "◎")} ${leader.ref} ${leader.name} ${paint(DIM, [doing, pending].filter(Boolean).join(" · "))}`,
    );
  }
  if (ready || waiting)
    lines.push(paint(DIM, `接下来：就绪 ${ready} · 等待中 ${waiting}`));
  return lines.join("\n");
}

/** 两个接口一起取；排期取不到不影响任务与 leader 段。 */
async function fetchState(api: Client, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  const [snapshot, plan] = await Promise.all([
    api.get<StatuslineInput["snapshot"]>("/tasks/top", undefined, signal),
    api.get<PlanView>("/tasks/plan", undefined, signal).catch(() => null),
  ]);
  return { snapshot, plan: plan?.groups ? plan : null };
}

/** Claude Code 把会话信息写进标准输入：读掉丢弃，免得它写入时撞上已关的管道。 */
function drainStdin() {
  if (process.stdin.isTTY) return () => {};
  process.stdin.on("data", () => {});
  process.stdin.on("error", () => {});
  return () => process.stdin.destroy();
}

export const statuslineCommand: Command = {
  args: "[--json]",
  about:
    "Claude Code 状态栏：未结束任务各在谁手里（执行者、合入、leader、秘书、等你）、leader 在处理什么、未处理事件；服务不在只显示未运行，不拉起",
  positionals: [0, 0],
  async run({ json }) {
    const done = drainStdin();
    try {
      const { connectRunning } = await import("./service.ts");
      const api = connectRunning();
      if (!api) {
        if (json) printJson({ running: false });
        else console.log("Atrium 未运行");
        return;
      }
      let state: Awaited<ReturnType<typeof fetchState>>;
      try {
        state = await fetchState(api, 1500);
      } catch (error) {
        if (json) throw error;
        const why =
          error instanceof Problem && error.code === "auth_required"
            ? "认证失效，运行 atrium auth rotate"
            : "服务没响应";
        console.log(`Atrium ${why}`);
        return;
      }
      if (json) printJson({ running: true, ...state });
      else
        console.log(
          renderStatusline({
            ...state,
            now: Date.now(),
            color: !process.env.NO_COLOR,
          }),
        );
    } finally {
      done();
    }
  },
};
