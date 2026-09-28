import { TELL_MODES, type Adapter, type TellMode } from "../adapters/index.ts";
import type { Exit, Stop } from "../gates/outcome.ts";
import type { TaskStatus } from "../ledger/state.ts";

/**
 * 给在跑的执行者捎话（#307 `atrium task tell`）：送达方式与收尾分派的判定。纯函数，不碰进程和数据库；
 * 写标准输入在 live-input.ts，落库在 tell-ledger.ts，续上与重派在 tell-runtime.ts。
 */

/** 一条捎话最多多少字。 */
export const TELL_MAX_CHARS = 4000;

/** 档案 `tell` 写了本工具支持的方式就用它，否则用适配器的缺省。 */
export function tellModeOf(adapter: Adapter, override: unknown): TellMode {
  if (!(TELL_MODES as readonly unknown[]).includes(override))
    return adapter.tell;
  const mode = override as TellMode;
  if (mode === "stdin" && adapter.tell !== "stdin") return adapter.tell;
  if (mode === "resume" && !adapter.resume) return adapter.tell;
  return mode;
}

/**
 * 这条捎话此刻怎么送：
 * stdin 即时写入；after_turn 等本轮结束后续上会话；restart 停掉带着补充重派；next_run 下次拉起时写进提示词。
 */
export type TellRoute =
  | { kind: "stdin" | "after_turn" | "restart" | "next_run" }
  | { kind: "reject"; reason: string };

export function routeTell(input: {
  status: TaskStatus;
  /** 服务手里有这个任务的执行者进程且还没退出。 */
  running: boolean;
  mode?: TellMode;
  /** 标准输入还开着（本轮还没结束，也不是服务重启后接管的进程）。 */
  live: boolean;
}): TellRoute {
  if (input.status === "done" || input.status === "cancelled")
    return {
      kind: "reject",
      reason: `任务已${input.status === "done" ? "完成" : "取消"}，捎话送不到；要改需求请建新任务或改回 todo 后重派`,
    };
  if (!input.running || !input.mode) return { kind: "next_run" };
  if (input.mode === "stdin")
    return { kind: input.live ? "stdin" : "after_turn" };
  return { kind: input.mode === "resume" ? "after_turn" : "restart" };
}

/**
 * 执行者退出后先看有没有没送到的捎话：
 * resume 带着补充续上原会话（关卡按续上后的结果判）；restart 保留工作树、带着补充重派；settle 照常收尾。
 * 被人工停止、卡死、空闲停下的不续；非 0 退出照常收尾，补充留到下次拉起时写进提示词。
 */
export type AfterExit = "resume" | "restart" | "settle";

export function afterExit(input: {
  stop?: Stop;
  exit: Exit;
  /** 还没送达的捎话条数。 */
  pending: number;
  /** 适配器支持续上且日志里取到了会话 id。 */
  session?: string;
  mode: TellMode;
}): AfterExit {
  if (input.stop?.kind === "tell") return "restart";
  if (input.stop || input.pending === 0) return "settle";
  const clean =
    input.exit === "unknown" ||
    (input.exit.code === 0 && input.exit.signal === null);
  if (!clean) return "settle";
  return input.session && input.mode !== "restart" ? "resume" : "restart";
}

export type TellEntry = { at: number; by: string; text: string };

const time = (at: number) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false });

/** 写进执行者会话的一条补充。 */
export const tellMessage = (tell: TellEntry) =>
  `补充说明（${tell.by} · ${time(tell.at)}）：\n\n${tell.text}\n\n与前文冲突时以这条为准。`;

/** 续上会话时一次送的补充：多条按时间排好。 */
export function resumeMessage(tells: readonly TellEntry[]) {
  if (tells.length === 1) return tellMessage(tells[0]!);
  return [
    "本轮结束后收到以下补充说明，与前文冲突时以最新的为准：",
    ...tells.map((tell) => `- ${tell.by} · ${time(tell.at)}：${tell.text}`),
  ].join("\n\n");
}

/** 重新拉起时写进提示词的「运行中收到的补充」；没有返回 undefined。 */
export function tellSection(tells: readonly TellEntry[]) {
  if (!tells.length) return undefined;
  return [
    "之前运行中收到的补充说明（按时间先后，与上文冲突时以最新的为准）：",
    ...tells.map((tell) => `- ${tell.by} · ${time(tell.at)}：${tell.text}`),
  ].join("\n");
}

/** 通用约束里说明运行中可能收到补充。 */
export const TELL_RULE =
  "运行中可能收到补充说明（新的用户消息，或本轮结束后接着原会话发来）；与前文冲突时以最新的为准。";
