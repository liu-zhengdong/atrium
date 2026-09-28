/** leader 收尾受阻任务可选的动作，与上游失败后下游怎么办（leader 提示词、到期叫醒与失败事件共用）。 */

/** 可以收尾的动作（leader 提示词与叫醒事件共用）：只写备注不算处理完。 */
export const CLOSING_ACTIONS = [
  "重新派发：atrium task run tN [--worker 工具+模型]",
  "重新排进合入队列（带 PR、关卡已过的受阻任务；专员否决你不认同时放行）：atrium task merge tN",
  "改依赖：atrium task set tN --after tM[,tK]（给 '' 去掉全部依赖）",
  "取消：atrium task set tN --status cancelled",
  "开修复任务：atrium task add 标题 --part 节点，再把原任务 --after 修复任务",
  "上交：atrium leader escalate --kind stuck|cross|beyond 说明 --task tN",
] as const;

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
