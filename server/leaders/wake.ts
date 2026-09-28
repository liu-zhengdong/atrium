import { Problem } from "../problem.ts";
import { MEMO_MAX } from "./model.ts";
import { forwardedOf } from "./route.ts";
import { CLOSING_ACTIONS } from "./actions.ts";
import { DUE, spanText } from "../tasks/watch/overdue.ts";

/**
 * leader 唤醒与上交的判定（纯函数，穷举测试）：上交类型与输入校验、一次唤醒结束后怎么收尾、
 * 唤醒提示词。落库、拉进程在 runtime.ts。
 */

export const ESCALATE_KINDS = {
  shipped: "已上线",
  cross: "需要别的部门配合",
  beyond: "越过权限／额度／根上的原则",
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
  /** 转交的下层上交事件编号；没给时按同任务同类型自动认。 */
  event: number | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["kind", "note", "task", "event"].includes(key))
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
  let event: number | null = null;
  if (input.event !== undefined && input.event !== null && input.event !== "") {
    const text = String(input.event).replace(/^#/, "");
    if (
      !["number", "string"].includes(typeof input.event) ||
      !/^[1-9][0-9]*$/.test(text) ||
      !Number.isSafeInteger(Number(text))
    )
      throw usage("--event: 应为要转交的事件编号，如 589");
    event = Number(text);
  }
  if (input.kind === "shipped" && !task && event === null)
    throw usage("--task: 上交「已上线」要给上线的任务");
  return { kind: input.kind as EscalateKind, note, task, event };
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
  if (event.kind === "material_stale" || event.kind === "material_purge") {
    const detail = event.detail as {
      node?: string;
      materials?: { ref: string; name: string; reason: string }[];
      more?: number;
    } | null;
    return `- #${event.id} ${event.kind === "material_stale" ? `疑似没用的资料 ${detail?.node ?? ""}` : "可以真删的资料（问用户）"}：${(
      detail?.materials ?? []
    )
      .map((m) => `${m.ref} ${m.name.slice(0, 40)}（${m.reason}）`)
      .join("；")}${detail?.more ? `；另有 ${detail.more} 份` : ""}`;
  }
  if (event.kind === "secret_stale") {
    const detail = event.detail as {
      node?: string;
      secrets?: { name: string; node: string; reason: string }[];
      more?: number;
    } | null;
    return `- #${event.id} 疑似没用的凭据 ${detail?.node ?? ""}：${(
      detail?.secrets ?? []
    )
      .map((s) => `${s.node} ${s.name.slice(0, 64)}（${s.reason}）`)
      .join("；")}${detail?.more ? `；另有 ${detail.more} 个` : ""}`;
  }
  // 到期（overdue.ts）：说明里写了挂多久、下一步。
  if (event.kind === "overdue")
    return `- #${event.id} ${event.task ?? ""} 到期没动 ${field(event.detail, "title", 60)}：${field(event.detail, "reason", 300)}；${field(event.detail, "next", 1200)}`;
  if (event.kind === "choice_small") {
    const detail = event.detail as {
      choice?: string;
      node?: string;
      small?: { title?: unknown; why?: unknown; basis?: unknown }[];
    } | null;
    const items = Array.isArray(detail?.small) ? detail.small.slice(0, 10) : [];
    const text = (value: unknown, max: number) =>
      typeof value === "string" ? value.slice(0, max) : "";
    return [
      `- #${event.id} 调研小改进 ${detail?.choice ?? ""} ${detail?.node ?? ""}（${items.length} 条，你自己定）：`,
      ...items.map((m, i) => {
        const basis = Array.isArray(m.basis)
          ? m.basis.filter((b) => typeof b === "string").slice(0, 10)
          : [];
        return `  ${i + 1}. ${text(m.title, 80)}——${text(m.why, 400)}${basis.length ? `（依据：${basis.join("；")}）` : ""}`;
      }),
    ].join("\n");
  }
  return `- ${[
    `#${event.id}`,
    event.task,
    event.kind,
    field(event.detail, "title", 60),
    event.count > 1 ? `（合并 ${event.count} 次）` : "",
    // 总任务级通知（t190）：「t174 整体已上线（12/12）」「t174 下的 t183 卡住要你」。
    event.kind.startsWith("total_") ? field(event.detail, "message", 200) : "",
    field(event.detail, "pr_url", 300),
    field(event.detail, "reason", 300) || field(event.detail, "note", 300)
      ? `· ${field(event.detail, "reason", 300) || field(event.detail, "note", 300)}`
      : "",
    ...forwardedOf(event.detail).map(
      (f) => `· ${f.by} 转交：${f.note.slice(0, 300)}`,
    ),
    // 上游失败（t253）：下游有哪些、可选动作。
    field(event.detail, "downstream_hint", 800)
      ? `· ${field(event.detail, "downstream_hint", 800)}`
      : "",
  ]
    .filter(Boolean)
    .join(" ")}`;
}

/** 事件类型的人话（看板、全景、状态栏）；没列的原样给类型名。 */
export const EVENT_WORDS: Record<string, string> = {
  done: "完成",
  failed: "失败",
  blocked: "受阻",
  stalled: "卡住",
  ready: "可以派了",
  waiting: "在等",
  online: "上线",
  online_failed: "上线失败",
  total_online: "整体已上线",
  total_stuck: "下面有子任务卡住",
  merged: "已合入",
  merge_returned: "合入被打回",
  escalated: "上交",
  ci_failure: "远端检查失败",
  ci_success: "远端检查通过",
  ci_unavailable: "远端检查跑不了",
  recovery: "服务重启后接管",
  review_passed: "审阅通过",
  schedule_failed: "周期任务没建成",
  material_stale: "资料疑似没用",
  material_purge: "资料可以真删",
  secret_stale: "凭据疑似没用",
  choice_small: "调研小改进",
  overdue: "到期没动",
};
export const eventWord = (kind: string) => EVENT_WORDS[kind] ?? kind;

/** 看板上的「在处理什么」：前几件事的任务与人话类型，如「t84 上线」。 */
export function wakeSummary(events: readonly PromptEvent[]) {
  const parts = events
    .slice(0, 3)
    .map((e) => [e.task, eventWord(e.kind)].filter(Boolean).join(" "));
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
    `你是 Atrium 组织里的 leader ${input.leader}（${input.name}），负责：${input.nodes.map((n) => `${n.ref} ${n.name}（${n.path}）`).join("、") || "（暂无节点）"} 及其下属部门。`,
    "你是一次性进程：处理完这批事件、确认后退出。你的连续性存在 Atrium（要点、阶段、任务备注、你的备忘），不靠这次的记忆。",
    "你不写代码、不改仓库；活派给执行者，你负责判断、派、盯、收。",
    "",
    "## 你负责的部门与要守的规矩",
    ...input.nodes.map((n) => n.context || `${n.ref} ${n.name}：还没有要点`),
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
    `- 新活：atrium task add 标题 --part ${home} [--priority 修复|普通|闲时] [--brief 文件] [--repo 路径] [--by 专员]；再 atrium task run tN（入队，按优先级拉起）`,
    "- 优先级：审阅打回或合入交回派生的写 --priority 修复（巡检直接建修复任务，同标题没结束的会被拒）（排在普通任务前面）；只有影响使用的才写 --priority 紧急（另跳过本机负载限制）",
    "- 调研的小改进（choice_small）：由你按节奏自行处理——逐条开任务、并入已有任务（atrium task note tN）或不做，在任务备注里写一句为什么；不必上交",
    `- 规矩只写成要点（挂在部门上、往下继承；跨几块的放共同上级；同一层靠前的更重要）：atrium org point-add ${home} 要点 --why 为什么 --by ${input.leader} [--pos N]；阶段：atrium map edit ${home} --stages 阶段.yaml`,
    `- 子节点指派 leader：atrium org edit 子节点 --leader aM`,
    "- 资料：atrium material ls --node oN；疑似没用的（资料清理线索）你来定：用不上就 atrium material archive mN --note 原因（只归档不删，可恢复），要留就 atrium material keep mN --note 原因（之后不再提）；拿不准先 atrium material show mN 看谁读过",
    "- 凭据：atrium secret ls --node oN（只有名称与最近使用，没有值）；疑似没用的（90 天没用过）你来定：用不上就 atrium secret archive oN 名称 --note 原因（派活不再注入，可恢复），要留就 atrium secret keep oN 名称 --note 原因；任务要用就 task add/set --secret 名称，派活时按名称注入执行者",
    `- 周期任务（巡检、调研）：atrium schedule add ${home} --kind patrol --every 1d --at 09:30；atrium schedule run/rm sN`,
    "- 备忘：atrium memo edit 文本（覆盖写，超过上限会被拒，先精简）；看全：atrium memo show",
    "- 处理过程、取舍与原因写任务备注：atrium task note tN 文字；决定记录只记用户拍板的事（由秘书记），你不写",
    "",
    "## 新能力先试点再铺开（做法，不设关卡）",
    "- 新能力上线后先在小范围用：一台主机、一两个任务、一个部门；跑通再放开。",
    "- 放开前在那件任务上写一句试点结果：atrium task note tN 试点结果：在哪试、跑了什么、结果如何",
    "- 挑试点时先看 PR「碰到哪些已有能力」一节，优先试它列出的组合（远程主机、Windows、合入队列……），问题多出在新旧能力的组合上；端到端验证由执行者合入前在隔离实例跑、输出贴在 PR 里。",
    "",
    "## 权限边界（服务端强制，越权会被拒）",
    "- 可以：在你负责的节点及子节点建任务、派活、重派、捎话、停；改这些节点的要点、阶段与全景人话字段；加、归档、恢复、留下这些节点的资料，设值、归档、恢复、留下这些节点的凭据；给这些节点排周期任务；写自己的备忘与决定记录；给子节点指派下层 leader。",
    "- 不可以：动别的部门的任务、改上层的要点与根上的原则、突破额度与花费上限、改仓库公开范围、花钱、真删资料或凭据。",
    "",
    `## 上交（投给 ${input.upstream}；只有这四类才上交，其余自己处理）`,
    "- shipped 已上线：只在里程碑／阶段达成时上交 → atrium leader escalate --kind shipped 说明 --task tN；单个任务上线运行时已自动通知秘书，不必再报",
    "- cross 需要别的部门配合 → atrium leader escalate --kind cross 说明 [--task tN]",
    "- beyond 越过权限／额度／根上的原则 → atrium leader escalate --kind beyond 说明 [--task tN]",
    "- stuck 搞不定（同一件事卡住多次、拿不定）→ atrium leader escalate --kind stuck 说明 [--task tN]",
    "- 下层 leader 上交给你、你也要往上报的：转交那一条，atrium leader escalate --kind 同类型 你的意见 --event 编号 [--task tN]；上面只收一条，能看到原文和你的意见，原事件随之确认。不要另写一条内容相同的上交",
    "",
    "## 每件事以一个动作收尾",
    "处理一件事要落到一个动作上，让任务状态变或者球离开你手里；只写备注、只看不动不算处理完，任务会一直挂在「等你处理」。可选动作：",
    ...CLOSING_ACTIONS.map((a) => `- ${a}`),
    `- 运行时盯着：受阻任务在你手里 ${spanText(DUE.leader.ms)}没有上面这些动作，会再叫醒你一次（事件「到期没动」）；再过 ${spanText(DUE.leader.ms)}仍没动，运行时替你上交上一层。备注不算动作。`,
    "- 确实要等（等用户、等别的部门）：上交写清在等什么，而不是留在自己手里。",
    "",
    "## 收尾",
    "1. 把要记住的（在等什么、下次先看什么）写进备忘；这次做了取舍的，写进那件任务的备注。",
    "   用户纠正了或要立新规矩：规矩一律写成要点（你负责的部门上 atrium org point-add；该放在上层或根上的，上交 beyond 写明放哪、写什么）；做法写进技能，执行者档案只写工具与模型的事实。",
    `2. 处理完确认：atrium events ack ${ids.join(" ")}`,
    "3. 退出。没确认的事件会再次唤醒你，连续失败会转交上层。",
  ].join("\n");
}
