/**
 * 任务挂在 leader 手里没人推（t253）的判定（纯函数，穷举测试）：受阻任务的持球人是 aN，
 * 从球到它手里（受阻或被上交给它）算起超过时限就再叫醒它一次，叫醒后再过同样时长仍没动就上交上一层。
 * leader 的动作（重派、排进合入队列、改依赖、取消、上交）都会让任务离开「受阻、在 aN 手里」或重新起算，
 * 所以只看起算时刻与叫醒时刻；备注不改状态，不算动作。读库、投递在 hang-runtime.ts。
 */

export const HANG_MINUTES = 30;

export type HangStep =
  | { kind: "none" }
  | { kind: "nudge"; minutes: number }
  | { kind: "escalate"; minutes: number };

const MINUTE = 60_000;

export function hangStep(input: {
  /** 球到这位 leader 手里的时刻（受阻或上交给它）。 */
  since: number;
  /** 这一段里已经叫醒过的时刻；没叫醒过为 null。 */
  nudgedAt: number | null;
  now: number;
  /** 时限；0 或负数表示关闭。 */
  afterMs: number;
  /** 持球的 leader 还登记着；没登记的叫不醒，到点直接上交。 */
  registered: boolean;
}): HangStep {
  if (!(input.afterMs > 0)) return { kind: "none" };
  const held = input.now - input.since;
  if (held < input.afterMs) return { kind: "none" };
  const minutes = Math.floor(held / MINUTE);
  if (!input.registered) return { kind: "escalate", minutes };
  if (input.nudgedAt === null || input.nudgedAt < input.since)
    return { kind: "nudge", minutes };
  if (input.now - input.nudgedAt >= input.afterMs)
    return { kind: "escalate", minutes };
  return { kind: "none" };
}

/** 挂了多久的人话：不到 1 分钟不说；「挂 45 分钟」「挂 3 小时」「挂 2 天」。 */
export function hangLabel(ms: number): string {
  if (!(ms >= MINUTE)) return "";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `挂 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `挂 ${hours} 小时`;
  return `挂 ${Math.floor(hours / 24)} 天`;
}

/** 可以收尾的动作（leader 提示词与叫醒事件共用）：只写备注不算处理完。 */
export const CLOSING_ACTIONS = [
  "重新派发：atrium task run tN [--worker 工具+模型]",
  "重新排进合入队列（带 PR、关卡已过的受阻任务；专员否决你不认同时放行）：atrium task merge tN",
  "改依赖：atrium task set tN --after tM[,tK]（给 '' 去掉全部依赖）",
  "取消：atrium task set tN --status cancelled",
  "开修复任务：atrium task add 标题 --part 节点，再把原任务 --after 修复任务",
  "上交：atrium leader escalate --kind stuck|cross|beyond 说明 --task tN",
] as const;

/** 叫醒事件的说明：挂了多久、再不动会怎样、可选动作。 */
export function nudgeNote(input: {
  task: string;
  leader: string;
  minutes: number;
  afterMinutes: number;
  holder: string;
}): string {
  return [
    `${input.task} 在 ${input.leader} 手里已挂 ${input.minutes} 分钟（${input.holder}），期间没有重派、改状态或上交。`,
    `以一个动作收尾，只写备注不算处理完；再过 ${input.afterMinutes} 分钟仍没动，运行时上交上一层。`,
    `可选：${CLOSING_ACTIONS.map((a) => a.replaceAll("tN", input.task)).join("；")}`,
  ].join("");
}

/** 运行时代为上交时的说明。 */
export function hangEscalateNote(input: {
  task: string;
  leader: string;
  minutes: number;
  nudged: boolean;
  holder: string;
}): string {
  return `${input.task} 在 ${input.leader} 手里挂了 ${input.minutes} 分钟（${input.holder}）${
    input.nudged ? "，叫醒过一次仍没有动作" : `，${input.leader} 已不在登记里`
  }，运行时上交，请决定重派、改依赖、取消或换人处理。`;
}

/**
 * 上游失败后下游怎么办（t253）：列出受影响的下游与三种可选动作，写进给负责人的事件。
 * upstream 是失败（或上线失败、PR 关闭）的上游短号，downstream 是没结束的直接下游；more 是没列出的件数。
 */
export function downstreamHint(input: {
  upstream: readonly string[];
  downstream: readonly string[];
  more?: number;
}): string {
  if (!input.upstream.length || !input.downstream.length) return "";
  const up = input.upstream.join("、");
  const down = input.downstream.join("、");
  const first = input.downstream[0]!;
  const rerun = input.upstream.map((u) => `atrium task run ${u}`).join("；");
  return [
    `上游 ${up} 没成，下游 ${down}${input.more ? ` 等 ${input.downstream.length + input.more} 件` : ""} 在等它，不处理会一直卡着。可选：`,
    `① 重派上游（${rerun}），下游随上游完成自动恢复；`,
    `② 去掉依赖（atrium task set ${first} --after 其余上游，没有就给 ''），下游照常派；`,
    `③ 一起取消（atrium task set ${first} --status cancelled，每件下游各一次）。`,
  ].join("");
}
