import { Problem } from "../problem.ts";
import { MEMO_MAX } from "./model.ts";

/**
 * leader 唤醒与上交的判定（纯函数，穷举测试）：上交类型与输入校验、一次唤醒结束后怎么收尾、
 * 唤醒提示词。落库、拉进程在 runtime.ts。
 */

export const ESCALATE_KINDS = {
  shipped: "已上线",
  cross: "需要别的部分配合",
  beyond: "越过权限／预算／硬边界",
  stuck: "搞不定",
} as const;
export type EscalateKind = keyof typeof ESCALATE_KINDS;
export const NOTE_MAX = 2000;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

export function escalateInput(body: unknown): {
  kind: EscalateKind;
  note: string;
  task: string | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["kind", "note", "task"].includes(key))
      throw usage(`${key}: 是未知字段`);
  const kinds = Object.keys(ESCALATE_KINDS);
  if (typeof input.kind !== "string" || !kinds.includes(input.kind))
    throw usage(
      `--kind: 上交类型只能是 ${kinds.map((k) => `${k}（${ESCALATE_KINDS[k as EscalateKind]}）`).join("、")}`,
    );
  if (typeof input.note !== "string" || !input.note.trim())
    throw usage("说明: 不能为空，写清楚要上面做什么");
  const note = input.note.trim();
  if (Array.from(note).length > NOTE_MAX)
    throw usage(`说明: 至多 ${NOTE_MAX} 字，长内容放进任务备注或 PR`);
  let task: string | null = null;
  if (input.task !== undefined && input.task !== null && input.task !== "") {
    if (typeof input.task !== "string" || !/^t[1-9][0-9]*$/.test(input.task))
      throw usage("--task: 应为任务短号，如 t5");
    task = input.task;
  }
  if (input.kind === "shipped" && !task)
    throw usage("--task: 上交「已上线」要给上线的任务，附端到端验证");
  return { kind: input.kind as EscalateKind, note, task };
}

export type WakeExit = "ok" | "failed" | "timeout";

export type AfterWake =
  | { kind: "done"; failures: 0 }
  | { kind: "retry"; failures: number; note: string }
  | { kind: "handoff"; failures: 0; note: string };

/**
 * 一次唤醒结束后怎么办：进程正常退出且事件都确认了算处理完；
 * 超时直接转交；其余失败（退出非零、没确认完）累计，连续达到上限转交，否则释放事件稍后重试。
 */
export function afterWake(input: {
  exit: WakeExit;
  unacked: number;
  failures: number;
  maxFailures: number;
}): AfterWake {
  if (input.exit === "ok" && input.unacked === 0)
    return { kind: "done", failures: 0 };
  if (input.exit === "timeout")
    return { kind: "handoff", failures: 0, note: "唤醒超时，转交" };
  const failures = input.failures + 1;
  const why =
    input.exit === "failed"
      ? "leader 进程异常退出"
      : `leader 退出时还有 ${input.unacked} 条事件没确认`;
  if (failures >= input.maxFailures)
    return {
      kind: "handoff",
      failures: 0,
      note: `${why}，连续 ${failures} 次失败，转交`,
    };
  return {
    kind: "retry",
    failures,
    note: `${why}（第 ${failures} 次），稍后重试`,
  };
}

export type PromptEvent = {
  id: number;
  task: string | null;
  kind: string;
  count: number;
  detail: unknown;
};

const field = (detail: unknown, key: string, max: number) => {
  const value = (detail as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value.slice(0, max) : "";
};

export function eventLine(event: PromptEvent) {
  return `- ${[
    `#${event.id}`,
    event.task,
    event.kind,
    field(event.detail, "title", 60),
    event.count > 1 ? `（合并 ${event.count} 次）` : "",
    field(event.detail, "pr_url", 300),
    field(event.detail, "reason", 300) || field(event.detail, "note", 300)
      ? `· ${field(event.detail, "reason", 300) || field(event.detail, "note", 300)}`
      : "",
  ]
    .filter(Boolean)
    .join(" ")}`;
}

/** 看板上的「在处理什么」：前几件事的任务与类型。 */
export function wakeSummary(events: readonly PromptEvent[]) {
  const parts = events
    .slice(0, 3)
    .map((e) => [e.task, e.kind].filter(Boolean).join(" "));
  return `${parts.join("、")}${events.length > 3 ? ` 等 ${events.length} 件` : ""}`;
}

export type PromptInput = {
  leader: string;
  name: string;
  nodes: { ref: string; name: string; path: string; context: string }[];
  memo: string;
  events: readonly PromptEvent[];
  /** 过程事件摘要（已自动确认）。 */
  digest: readonly string[];
  /** 上交投给谁（上一层 leader 或秘书）。 */
  upstream: string;
};

export function leaderPrompt(input: PromptInput): string {
  const ids = input.events.map((e) => e.id);
  const home = input.nodes[0]?.ref ?? "节点";
  return [
    `你是 Atrium 组织里的 leader ${input.leader}（${input.name}），负责：${input.nodes.map((n) => `${n.ref} ${n.name}（${n.path}）`).join("、") || "（暂无节点）"} 及其下属部分。`,
    "你是一次性进程：处理完这批事件、确认后退出。你的连续性存在 Atrium（节点要点、阶段、交付记录、你的备忘），不靠这次的记忆。",
    "你不写代码、不改仓库；活派给执行者，你负责判断、派、盯、收。",
    "",
    "## 你负责的部分",
    ...input.nodes.map((n) => n.context),
    "",
    `## 你的备忘（上次留给自己的，上限 ${MEMO_MAX} 字）`,
    input.memo || "（空）",
    "",
    `## 这批要处理的事件（${input.events.length} 条）`,
    ...input.events.map(eventLine),
    ...(input.digest.length
      ? [
          "",
          "## 过程摘要（已自动确认，供参考）",
          ...input.digest.map((d) => `- ${d}`),
        ]
      : []),
    "",
    "## 可用命令（都是 atrium，已按你的身份连到服务）",
    "- 看：atrium task show tN；atrium task log tN；atrium task tree tN；atrium top --once；atrium map oN --json",
    "- 重派：atrium task run tN [--worker 工具+模型[:强度]]；捎话：atrium task tell tN 补充；停：atrium task stop tN；备注：atrium task note tN 文字",
    `- 新活：atrium task add 标题 --part ${home} [--brief 文件] [--repo 路径] [--concern 专员]；再 atrium task run tN`,
    `- 请专员：atrium task set tN --concern 安全；会审：atrium review add 议题 --concerns 安全,质量 --part ${home}`,
    `- 要点：atrium org point-add ${home} 要点 --why 为什么 --by ${input.leader}；阶段：atrium org stages ${home} --file 阶段.yaml`,
    `- 子节点指派 leader：atrium org edit 子节点 --leader aM`,
    `- 备忘：atrium leader edit ${input.leader} --memo 文本（覆盖写，超过上限会被拒，先精简）`,
    "",
    "## 权限边界（服务端强制，越权会被拒）",
    "- 可以：在你负责的节点及子节点建任务、派活、重派、捎话、停、请专员与会审；改这些节点的要点、阶段与全景人话字段；写自己的备忘；给子节点指派下层 leader。",
    "- 不可以：动别的部分的任务、改章程与上层规矩、突破预算与硬边界、改仓库公开范围、花钱、拍板上交的会审。",
    "",
    `## 上交（投给 ${input.upstream}；只有这四类才上交，其余自己处理）`,
    "- shipped 已上线：只在里程碑／阶段达成时上交 → atrium leader escalate --kind shipped 说明 --task tN；单个任务上线运行时已自动通知秘书，不必再报",
    "- cross 需要别的部分配合 → atrium leader escalate --kind cross 说明 [--task tN]",
    "- beyond 越过权限／预算／硬边界 → atrium leader escalate --kind beyond 说明 [--task tN]",
    "- stuck 搞不定（同一件事卡住多次、拿不定）→ atrium leader escalate --kind stuck 说明 [--task tN]",
    "",
    "## 收尾",
    "1. 把要记住的（在等什么、下次先看什么）写进备忘。",
    `2. 处理完确认：atrium events ack ${ids.join(" ")}`,
    "3. 退出。没确认的事件会再次唤醒你，连续失败会转交上层。",
  ].join("\n");
}
