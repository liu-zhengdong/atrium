import type { PickSpecialists } from "../server/tasks/specialist-scope.ts";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import { TASK_STATUSES, isTaskStatus } from "../server/tasks/state.ts";
import { DELIVERS, type Deliver } from "../server/tasks/deliver.ts";
import type {
  Task,
  TaskEventRow,
  TaskNode,
  TaskTree,
} from "../server/tasks/ledger.ts";
import {
  TREE_MAX,
  TREE_RECENT,
  TREE_ROOTS,
} from "../server/tasks/ledger-model.ts";
import { formatChildSummary } from "../server/tasks/ledger-summary.ts";
import { planCounts } from "../server/tasks/plan-count.ts";
import {
  progressOf,
  rollupLabel,
  rollupText,
  type Rollup,
} from "../server/tasks/rollup.ts";
import { recordNext } from "./contract.ts";
import {
  defaultActor,
  defaultSubscriber,
  leaderSession,
} from "./worker-guard.ts";
import { longWait, waitSeconds } from "./long-wait.ts";
import { clip, printJson, table, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { concernsText, hintLines } from "./task-concerns.ts";
import { signedPercent } from "../server/tasks/percent.ts";
import type {
  PickAccount,
  PickCandidate,
  PickView,
  RunPick,
} from "../server/tasks/pick.ts";
import { briefInput } from "./brief-input.ts";
import { URGENT_NOTE } from "../server/tasks/host-load.ts";
import {
  IDLE_NOTE,
  PRIORITY_LABEL,
  parsePriority,
  priorityTag,
} from "../server/tasks/priority.ts";

/** 任务账本的命令行（#262）：只经 HTTP 调服务，不直接开数据库。 */

// 不从 main.ts 取值：测试会先加载本模块，main.ts 再回头引入时会撞上循环初始化。
const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();
const displayStatus = (
  task: Pick<Task, "status" | "delivery_stage" | "processing"> & {
    queued_reason?: string | null;
    rollup?: Rollup | null;
  },
) =>
  // 总任务（t190）：状态与进度按全部子孙汇总，自己的交付记录只作历史。
  task.rollup
    ? task.status === "cancelled"
      ? `取消 ${progressOf(task.rollup)}`
      : `${rollupLabel(task.rollup)} ${progressOf(task.rollup)}`
    : task.queued_reason
      ? "排队"
      : task.processing
        ? "处理中"
        : task.status === "blocked"
          ? "卡住"
          : task.delivery_stage === "reviewing"
            ? "审阅中"
            : task.delivery_stage === "merge_queued"
              ? "排队合入"
              : task.delivery_stage === "merging"
                ? "合入中"
                : task.delivery_stage === "merged"
                  ? "已合入"
                  : task.delivery_stage === "online"
                    ? "已上线"
                    : task.status;
/** 排队中的任务说清在等什么。 */
const queueLine = (task: Task) =>
  task.queued_reason ? `  排队原因：${task.queued_reason}` : null;
/** 备注作者：leader 给名字带短号（Atrium 负责人（a1）），其余照短号。 */
const noteAuthor = (task: Task) =>
  task.note_by_name
    ? `${task.note_by_name}（${task.note_by}）`
    : (task.note_by ?? "未知");
const noteLine = (task: Task) =>
  task.note
    ? `  备注（${noteAuthor(task)} · ${when(task.note_at!)}）：${task.note.replace(/\s+/g, " ")}`
    : null;

/** 标了紧急的回执说清紧急通道做什么（t113、t215）；闲时的说清怎么排（t136）。 */
const urgentLines = (task: Task) =>
  task.urgent === 1 ? [URGENT_NOTE] : priorityTag(task) ? [IDLE_NOTE] : [];

/** 紧急通道的回执附加（t215）：止损结果、紧急任务太多的提示。 */
type UrgentReceipt = {
  stopgap_results?: { action: string; ok: boolean; detail: string }[];
  urgent_warning?: string;
};
const laneLines = (result: UrgentReceipt) => [
  ...(result.stopgap_results ?? []).map(
    (item) => `止损 ${item.ok ? "✓" : "✗"} ${item.action}：${item.detail}`,
  ),
  ...(result.urgent_warning ? [`注意：${result.urgent_warning}`] : []),
];

/** 库里存的止损动作（JSON）写成命令行的样子；读不懂原样给。 */
function stopgapLine(text: string) {
  try {
    const actions = JSON.parse(text) as {
      kind: string;
      host?: string;
      tasks?: string[];
    }[];
    return actions
      .map((a) =>
        a.kind === "task_stop"
          ? `atrium task stop ${(a.tasks ?? []).join(",")}`
          : `atrium host ${a.kind === "host_pause" ? "pause" : "clean"} ${a.host}`,
      )
      .join("; ");
  } catch {
    return text;
  }
}

/** --why、--avoid-host、--stopgap（t215）：原样交给服务校验。 */
function laneInput(values: Values) {
  const body: Record<string, string> = {};
  const why = str(values, "why");
  if (why !== undefined) body.why = why;
  const avoid = str(values, "avoid-host");
  if (avoid !== undefined) body.avoid_host = avoid;
  const stopgap = str(values, "stopgap");
  if (stopgap !== undefined) body.stopgap = stopgap;
  return body;
}

/** 标题前的「紧急 」「闲时 」。 */
const tagText = (task: Pick<Task, "urgent" | "priority">) => {
  const tag = priorityTag(task);
  return tag ? `${tag} ` : "";
};

/** 排队原因：闲时任务的「等空闲：…」本身说清了在等什么，其余前面加「排队：」。 */
const queuedText = (reason: string) =>
  reason.startsWith("等空闲") ? reason : `排队：${reason}`;

/** --priority 闲时|普通（也认 idle、normal）；写错时用参数名说清。 */
function priorityInput(values: Values) {
  const text = str(values, "priority");
  if (text === undefined) return {};
  try {
    return { priority: parsePriority(text) };
  } catch {
    throw new Problem(400, "--priority 只能是 闲时 或 普通", "usage");
  }
}

/** 命令行只认 t 开头的短号；接口另外接受纯数字。 */
function ref(value: string | undefined, flag: string) {
  if (!value || !/^t[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `${flag === "任务" ? "任务短号应为 t1 这样的格式" : `${flag} 要填任务短号，如 t1`}（收到：${value ?? "空"}）`,
      "usage",
      undefined,
      "atrium task ls",
    );
  return value;
}
function status(value: string | undefined) {
  if (!isTaskStatus(value))
    throw new Problem(
      400,
      `--status 只能是 ${TASK_STATUSES.join("、")}（收到：${value ?? "空"}）`,
      "usage",
    );
  return value;
}
function deliver(value: string | undefined): Deliver {
  if (!DELIVERS.includes(value as Deliver))
    throw new Problem(
      400,
      `--deliver 只能是 ${DELIVERS.join("、")}（收到：${value ?? "空"}）`,
      "usage",
    );
  return value as Deliver;
}
function issue(value: string | undefined): number {
  const number = Number(value);
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number))
    throw new Problem(400, "--issue 应为正整数 issue 号", "usage");
  return number;
}
function existing(value: string, flag: string, kind: "file" | "directory") {
  const path = resolve(value);
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Problem(
      400,
      `${flag} 指向的${kind === "file" ? "文件" : "目录"}不存在：${path}`,
      "usage",
    );
  return path;
}

function queuedReason(events: TaskEventRow[]) {
  const detail = events.findLast((event) => event.kind === "queued")?.detail;
  if (detail) {
    try {
      const reason = (JSON.parse(detail) as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    } catch {
      /* malformed historical event: use the generic receipt */
    }
  }
  return "等待执行者可用后自动拉起";
}

const line = (task: TaskNode) =>
  task.rollup
    ? [
        task.ref,
        `[${displayStatus(task)}]`,
        task.title,
        "· 总任务",
        ...rollupDetail(task.rollup),
      ].join(" ")
    : [
        task.ref,
        `[${displayStatus(task)}]`,
        task.title,
        `· ${task.deliver}${task.issue ? ` #${task.issue}` : ""}`,
        task.child_summary ? `· ${formatChildSummary(task.child_summary)}` : "",
        task.worker ? `· ${task.worker}` : "",
        task.pr_url ? `· ${task.pr_url}` : "",
      ]
        .filter(Boolean)
        .join(" ");

/** 总任务一行后面的在做、卡住（带短号）；状态与进度已在方括号里。 */
function rollupDetail(rollup: Rollup): string[] {
  const refs = (list: string[], count: number) =>
    list.length
      ? `（${list.join("、")}${count > list.length ? "…" : ""}）`
      : "";
  return [
    rollup.running
      ? `· 在做 ${rollup.running}${refs(rollup.running_refs, rollup.running)}`
      : "",
    rollup.stuck
      ? `· 卡住 ${rollup.stuck}${refs(rollup.stuck_refs, rollup.stuck)}`
      : "",
  ].filter(Boolean);
}

export function renderTree(nodes: TaskNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${line(node)}`,
    ...renderTree(node.children, depth + 1),
  ]);
}

/** role 是旧 .agents 写法、还没对应组织节点时提示迁移命令；不报错，照常可派（没有岗位说明）。 */
function roleHint(task: Task): string[] {
  return task.role && !task.node_ref
    ? [
        `岗位 ${task.role} 没有对应组织节点，派活时没有岗位说明；关联节点：atrium org link-roles`,
      ]
    : [];
}

/** --part 节点；旧写法 --goal gN 照传给服务，按目标树迁移映射到负责节点。两个都给报错。 */
function partInput(values: Values): { part?: string; goal?: string } {
  const part = str(values, "part"),
    goal = str(values, "goal");
  if (part !== undefined && goal !== undefined)
    throw new Problem(
      400,
      "--part 与 --goal 只能给一个；--goal 已改为归属部分，用 --part",
      "usage",
    );
  return part !== undefined ? { part } : goal !== undefined ? { goal } : {};
}

/** 牵涉的部分：显式的照写，自动的标「自动」。 */
function alsoText(task: Task) {
  return [
    ...(task.also ?? []),
    ...(task.also_auto ?? []).map((r) => `${r}（自动）`),
  ].join("、");
}

const add: Command = {
  args: "标题 [--parent tN] [--part 节点] [--also 部分[,部分]] [--by 专员] [--ask 专员[,专员]] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent [--why 原因] [--stopgap 止损动作]] [--avoid-host hN[,hM]] [--priority 闲时|普通] [--from 节点] [--repo 路径] [--brief 文件|-] [--owner 订阅者] [--deliver pr|comment|none] [--issue 号]",
  about:
    "建任务；--by 指定干活的专员（派活附技能与交付关卡），--ask 请专员按清单审（可多位）；--part 写归属部分（负责与汇报只在这一处），--also 写还牵涉的部分（派活附它们的要点、可请它们的专员、知会它们的 leader；管方面的要点适用于归属部分的自动牵涉），--from 写投任务的节点，--brief 附任务详述 md（建任务时读入存库，至多 64 KB；- 从标准输入读）；--urgent 标紧急，走紧急通道（没空位先暂停闲时再普通任务、按一次通过率与速度挑人、检查与合入插到最前、审阅不挡合入、合入后立即发版、10 分钟没进展换人；leader 标须 --why 写原因，并知会用户）；--stopgap 写先执行的止损动作（atrium host pause hN; atrium task stop tN,tM; atrium host clean hN，建好就执行并记事件）；--avoid-host 派活与检查避开这些主机；--priority 闲时|普通（不写按归属部分：管方面的部分缺省闲时，排在普通任务后面、有空闲执行者才派）；旧 --job、--concern、--role 暂可用",
  options: {
    parent: { type: "string" },
    part: { type: "string" },
    also: { type: "string" },
    concern: { type: "string" },
    ask: { type: "string" },
    goal: { type: "string" },
    role: { type: "string" },
    job: { type: "string" },
    by: { type: "string" },
    from: { type: "string" },
    repo: { type: "string" },
    brief: { type: "string" },
    owner: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
    urgent: { type: "boolean" },
    why: { type: "string" },
    stopgap: { type: "string" },
    "avoid-host": { type: "string" },
    priority: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [title], values, json }) {
    for (const [old, replacement] of [
      ["job", "by"],
      ["concern", "ask"],
    ])
      if (str(values, old) !== undefined)
        console.error(`--${old} 已改为 --${replacement}；旧写法暂可用`);
    if (str(values, "role") !== undefined)
      console.error(
        "--role 已过时；专员用 --by，归属部分用 --part；旧写法暂可用",
      );
    const parent = str(values, "parent");
    const repo = str(values, "repo");
    const brief = str(values, "brief");
    const kind = str(values, "deliver");
    const issueText = str(values, "issue");
    if (kind === "comment" && issueText === undefined)
      throw new Problem(
        400,
        "--deliver comment 需同时给 --issue <号>",
        "usage",
      );
    if (!title?.trim())
      throw new Problem(
        400,
        "标题不能为空",
        "usage",
        undefined,
        "atrium task add 标题",
      );
    const body = {
      title,
      ...(parent === undefined ? {} : { parent: ref(parent, "--parent") }),
      ...(str(values, "job") === undefined ? {} : { job: str(values, "job") }),
      ...(str(values, "by") === undefined ? {} : { by: str(values, "by") }),
      ...(str(values, "role") === undefined
        ? {}
        : { role: str(values, "role") }),
      ...(str(values, "from") === undefined
        ? {}
        : { from: str(values, "from") }),
      ...partInput(values),
      ...(str(values, "also") === undefined
        ? {}
        : { also: str(values, "also") }),
      ...(str(values, "concern") === undefined
        ? {}
        : { concern: str(values, "concern") }),
      ...(str(values, "ask") === undefined ? {} : { ask: str(values, "ask") }),
      ...(repo === undefined
        ? {}
        : { repo: existing(repo, "--repo", "directory") }),
      ...(brief === undefined
        ? {}
        : await briefInput(brief, (path) => existing(path, "--brief", "file"))),
      ...(str(values, "owner") === undefined
        ? {}
        : { owner: str(values, "owner") }),
      ...(kind === undefined ? {} : { deliver: deliver(kind) }),
      ...(issueText === undefined ? {} : { issue: issue(issueText) }),
      ...(str(values, "after") === undefined
        ? {}
        : { after: str(values, "after") }),
      ...(str(values, "after-pr") === undefined
        ? {}
        : { after_pr: str(values, "after-pr") }),
      ...(values.auto === true ? { auto: true } : {}),
      ...(values.urgent === true ? { urgent: true } : {}),
      ...laneInput(values),
      ...priorityInput(values),
    };
    const task = await (
      await client()
    ).post<Task & UrgentReceipt>("/tasks", body);
    if (json) printJson(task);
    else
      console.log(
        [
          `已建 ${task.ref}：${task.title}${task.parent_ref ? `（父任务 ${task.parent_ref}）` : ""}${task.node_ref ? ` · 记在 ${task.node_ref}` : ""}${task.origin_ref ? ` · ${task.origin_ref} 投来` : ""}${task.part_ref ? ` · 归属 ${task.part_ref}` : ""}${alsoText(task) ? ` · 牵涉 ${alsoText(task)}` : ""}${task.concerns?.length ? ` · 请了 ${task.concerns.map((c) => c.name).join("、")}` : ""}`,
          ...(task.parent_ref
            ? [
                `${task.parent_ref} 是总任务：不派给执行者，状态与进度按全部子孙汇总（atrium task tree ${task.parent_ref}）`,
              ]
            : []),
          ...urgentLines(task),
          ...laneLines(task),
          ...roleHint(task),
          ...hintLines(task),
        ].join("\n"),
      );
    recordNext(
      task.urgent === 1 && !task.parent_ref
        ? `马上派：atrium task run ${task.ref}`
        : str(values, "after") ||
            str(values, "after-pr") ||
            values.auto === true
          ? "看排期：atrium task plan"
          : task.parent_ref
            ? `看候选并派活：atrium task pick ${task.ref}`
            : `拆子任务：atrium task add 标题 --parent ${task.ref}`,
    );
  },
};

const ls: Command = {
  args: "[--status S] [--parent tN] [--after tN]",
  about: "列任务，按短号升序，每页 200 条",
  options: {
    status: { type: "string" },
    parent: { type: "string" },
    after: { type: "string" },
  },
  positionals: [0, 0],
  async run({ values, json }) {
    const search = new URLSearchParams();
    const wanted = str(values, "status");
    if (wanted !== undefined) search.set("status", status(wanted));
    const parent = str(values, "parent");
    if (parent !== undefined) search.set("parent", ref(parent, "--parent"));
    const after = str(values, "after");
    if (after !== undefined) search.set("after", ref(after, "--after"));
    const result = await (
      await client()
    ).get<{ tasks: Task[]; next_after: string | null }>(
      `/tasks${search.size ? `?${search}` : ""}`,
    );
    if (json) printJson(result);
    else if (!result.tasks.length)
      console.log(
        wanted || parent || after ? "没有符合条件的任务" : "还没有任务",
      );
    else {
      const lines = table([
        ["短号", "状态", "父任务", "标题", "执行者", "PR"],
        ...result.tasks.map((task) => [
          task.ref,
          displayStatus(task),
          task.parent_ref ?? "",
          clip(`${tagText(task)}${task.title}`, 40),
          task.worker ?? "",
          task.pr_url ?? "",
        ]),
      ]).split("\n");
      console.log(
        [
          lines[0],
          ...result.tasks.flatMap((task, i) =>
            [lines[i + 1], queueLine(task), noteLine(task)].filter(
              (line): line is string => !!line,
            ),
          ),
        ].join("\n"),
      );
    }
    if (result.next_after) {
      search.set("after", result.next_after);
      const flags = [...search]
        .map(([key, value]) => `--${key} ${value}`)
        .join(" ");
      recordNext(`下一页：atrium task ls ${flags}`);
    } else if (result.tasks[0])
      recordNext(
        `在跑的在实时视图里看（--once 打印一次、--json 给脚本）：atrium top\n看详情：atrium task show ${result.tasks[0].ref}`,
      );
    else recordNext("建任务：atrium task add 标题");
  },
};

const show: Command = {
  args: "tN",
  about: "看任务详情与最近事件",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const task = await (
      await client()
    ).get<
      Task & {
        children: number;
        child_summary: TaskNode["child_summary"];
        events: TaskEventRow[];
        last_check?: string | null;
      }
    >(`/tasks/${ref(reference, "任务")}`);
    if (json) printJson(task);
    else {
      const rows: [string, string | number | null][] = [
        ["标题", task.title],
        ["状态", displayStatus(task)],
        [
          "紧急",
          task.urgent === 1
            ? `是（紧急通道）${task.urgent_by ? `，${task.urgent_by} 标的` : ""}${task.urgent_why ? `：${task.urgent_why}` : ""}`
            : null,
        ],
        ["止损动作", task.stopgap ? stopgapLine(task.stopgap) : null],
        [
          "避开主机",
          task.avoid_host_refs?.length ? task.avoid_host_refs.join("、") : null,
        ],
        [
          "优先级",
          task.priority === "idle"
            ? `${PRIORITY_LABEL.idle}（排在普通任务后面，有空闲执行者才派）`
            : null,
        ],
        ["合入交回次数", task.merge_returns || null],
        ["审阅任务", task.review_task ? `t${task.review_task}` : null],
        ["排队原因", task.queued_reason ?? null],
        ["球在谁手里", task.holder?.text ?? null],
        ["最新备注", task.note],
        ["备注作者", task.note ? noteAuthor(task) : null],
        ["备注时间", task.note_at ? when(task.note_at) : null],
        ["父任务", task.parent_ref],
        [
          "总任务",
          task.rollup
            ? `是：不派给执行者，派它下面的子任务；按全部子孙汇总 ${rollupText(task.rollup)}`
            : null,
        ],
        ["子任务", task.children || null],
        [
          "子任务汇总",
          task.child_summary ? formatChildSummary(task.child_summary) : null,
        ],
        [
          "岗位",
          task.role
            ? `${task.role}${task.node_ref && task.node_ref !== task.role ? `（${task.node_ref}）` : ""}`
            : task.node_ref,
        ],
        ["投任务的节点", task.origin_ref],
        ["归属部分", task.part_ref],
        ["牵涉部分", alsoText(task) || null],
        ["请的专员", concernsText(task.concerns)],
        ["原里程碑", task.goal_ref],
        ["仓库", task.repo],
        [
          "交付物",
          `${task.deliver}${task.issue ? `（issue #${task.issue}）` : ""}`,
        ],
        ["详述来源", task.brief_path],
        ["负责人", task.owner],
        ["干活的专员", task.job_ref],
        ["执行者", task.worker],
        ["主机", task.host_ref ?? null],
        ["进程", task.pid],
        ["工作树", task.worktree],
        ["分支", task.branch],
        ["PR", task.pr_url],
        ["本地检查", task.last_check ?? null],
        ["CI", task.ci],
        ["建于", when(task.created_at)],
        ["开始", task.started_at ? when(task.started_at) : null],
        ["结束", task.ended_at ? when(task.ended_at) : null],
      ];
      console.log(
        [
          `${task.ref} · ${tagText(task)}${task.title}`,
          ...rows
            .slice(1)
            .filter(([, value]) => value !== null && value !== "")
            .map(([key, value]) => `  ${key}：${value}`),
          ...hintLines(task, true).map((line) => `  ${line}`),
          ...(task.brief?.trim()
            ? [
                "详述：",
                ...task.brief
                  .trimEnd()
                  .split("\n")
                  .map((line) => `  ${line}`),
              ]
            : task.brief_path
              ? [
                  `详述：没有进库（原文件读不到），补上：atrium task set ${task.ref} --brief 文件`,
                ]
              : []),
          ...(task.holder?.detail?.trim()
            ? [
                "原因全文：",
                ...task.holder.detail
                  .trimEnd()
                  .split("\n")
                  .map((line) => `  ${line}`),
              ]
            : []),
          ...(task.result ? ["结果摘要：", task.result] : []),
          ...(task.events.length
            ? [
                "事件：",
                ...task.events.map(
                  (event) =>
                    `  ${when(event.at)}  ${event.kind}${
                      event.kind === "tell"
                        ? `  ${tellLine(event.detail)}`
                        : event.detail
                          ? `  ${clip(event.detail, 80)}`
                          : ""
                    }`,
                ),
              ]
            : []),
        ].join("\n"),
      );
    }
    recordNext(
      task.children
        ? `看子树：atrium task tree ${task.ref}`
        : `拆子任务：atrium task add 标题 --parent ${task.ref}`,
    );
  },
};

/** 树下面的说明（t155）：哪些顶层任务没列出、怎么看；next 是下一步命令。 */
export function treeMore(
  result: Omit<TaskTree, "tasks">,
  page: { all: boolean; limit?: string },
): { lines: string[]; next: string | null } {
  const lines: string[] = [];
  if (result.truncated)
    lines.push(
      `（任务过多，只显示前 ${TREE_MAX} 个；看某一棵：atrium task tree tN）`,
    );
  let next: string | null = null;
  if (result.next_after) {
    next = `下一页：atrium task tree${page.all ? " --all" : ""} --after ${result.next_after}${page.limit ? ` --limit ${page.limit}` : ""}`;
    lines.push(
      `还有 ${result.remaining} 个${page.all ? "" : "未完成的"}顶层任务没列出`,
    );
  }
  if (result.closed_hidden) {
    lines.push(
      `另有 ${result.closed_hidden} 个已结束的顶层任务没列出：atrium task tree --all`,
    );
  }
  return { lines, next };
}

const tree: Command = {
  args: "[tN] [--all] [--after tN] [--limit N]",
  about: `缩进树：短号、状态、标题、交付物、执行者、PR；不写 tN 列未完成的顶层任务（每页 ${TREE_ROOTS} 个）与最近 ${TREE_RECENT} 个已结束的，--all 按短号翻全部顶层`,
  options: {
    all: { type: "boolean" },
    after: { type: "string" },
    limit: { type: "string" },
  },
  positionals: [0, 1],
  async run({ positionals: [root], values, json }) {
    const search = new URLSearchParams();
    const all = values.all === true;
    if (
      root !== undefined &&
      (all ||
        str(values, "after") !== undefined ||
        str(values, "limit") !== undefined)
    )
      throw new Problem(
        400,
        "--all、--after、--limit 只用于不写 tN 时翻顶层任务",
        "usage",
        undefined,
        `atrium task tree ${root}`,
      );
    if (root !== undefined) search.set("root", ref(root, "任务"));
    if (all) search.set("all", "1");
    const after = str(values, "after");
    if (after !== undefined) search.set("after", ref(after, "--after"));
    const limit = str(values, "limit");
    if (limit !== undefined) search.set("limit", limit);
    const result = await (
      await client()
    ).get<TaskTree>(`/tasks/tree${search.size ? `?${search}` : ""}`);
    const more = treeMore(result, { all, limit });
    if (json) printJson(result);
    else {
      console.log(
        [
          ...(result.tasks.length
            ? renderTree(result.tasks)
            : [
                root !== undefined || all || after !== undefined
                  ? "没有符合条件的任务"
                  : "还没有任务",
              ]),
          ...more.lines,
        ].join("\n"),
      );
    }
    recordNext(
      more.next ??
        (result.tasks.length
          ? `看详情：atrium task show ${root ?? result.tasks[0]!.ref}`
          : "建任务：atrium task add 标题"),
    );
  },
};

const set: Command = {
  args: "tN [--status S] [--with-children] [--pr URL] [--by 专员|''] [--ask 专员[,专员]|''] [--from 节点|''] [--part 节点|''] [--also 部分[,部分]|''] [--brief 文件|-|''] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--urgent|--no-urgent] [--why 原因] [--stopgap 止损动作|''] [--avoid-host hN[,hM]|''] [--priority 闲时|普通]",
  about: `人工修正状态（${TASK_STATUSES.filter((s) => s !== "running").join("、")}）；也可补登 PR 或改标题、干活或请来看的专员、归属部分、牵涉部分、详述、交付物、依赖、自动派发、紧急（--urgent 走紧急通道，排队中的立刻按紧急重排；leader 标须 --why；--stopgap 写了就立刻执行；--avoid-host 派活与检查避开这些主机）和优先级（--priority 闲时 排在普通任务后面、有空闲执行者才派；普通照常排；在跑的不打断）；取消总任务时 --with-children 连带取消没结束的子孙（在跑的先停，已上线、已完成的不动）`,
  options: {
    status: { type: "string" },
    "with-children": { type: "boolean" },
    title: { type: "string" },
    role: { type: "string" },
    job: { type: "string" },
    by: { type: "string" },
    from: { type: "string" },
    part: { type: "string" },
    also: { type: "string" },
    concern: { type: "string" },
    ask: { type: "string" },
    goal: { type: "string" },
    brief: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    pr: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
    urgent: { type: "boolean" },
    "no-urgent": { type: "boolean" },
    why: { type: "string" },
    stopgap: { type: "string" },
    "avoid-host": { type: "string" },
    priority: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    for (const [old, replacement] of [
      ["job", "by"],
      ["concern", "ask"],
    ])
      if (str(values, old) !== undefined)
        console.error(`--${old} 已改为 --${replacement}；旧写法暂可用`);
    if (str(values, "role") !== undefined)
      console.error(
        "--role 已过时；专员用 --by，归属部分用 --part；旧写法暂可用",
      );
    const id = ref(reference, "任务");
    const body: Record<string, string | boolean> = {};
    const wanted = str(values, "status");
    if (wanted !== undefined) body.status = status(wanted);
    if (values["with-children"] === true) {
      if (body.status !== "cancelled")
        throw new Problem(
          400,
          "--with-children 只用于取消总任务：同时给 --status cancelled",
          "usage",
          undefined,
          `atrium task set ${ref(reference, "任务")} --status cancelled --with-children`,
        );
      body.with_children = true;
    }
    const title = str(values, "title");
    if (title !== undefined) {
      if (!title.trim()) throw new Problem(400, "--title 不能为空", "usage");
      body.title = title;
    }
    const role = str(values, "role");
    if (role !== undefined) body.role = role;
    const job = str(values, "job");
    if (job !== undefined) body.job = job;
    const by = str(values, "by");
    if (by !== undefined) body.by = by;
    const from = str(values, "from");
    if (from !== undefined) body.from = from;
    Object.assign(body, partInput(values));
    if (str(values, "also") !== undefined) body.also = str(values, "also")!;
    const concern = str(values, "concern");
    if (concern !== undefined) body.concern = concern;
    const ask = str(values, "ask");
    if (ask !== undefined) body.ask = ask;
    const brief = str(values, "brief");
    if (brief === "") body.brief = "";
    else if (brief !== undefined)
      Object.assign(
        body,
        await briefInput(brief, (path) => existing(path, "--brief", "file")),
      );
    const kind = str(values, "deliver");
    if (kind !== undefined) body.deliver = deliver(kind);
    const issueText = str(values, "issue");
    if (issueText !== undefined) body.issue = String(issue(issueText));
    const pr = str(values, "pr");
    if (pr !== undefined) body.pr_url = pr;
    if (str(values, "after") !== undefined) body.after = str(values, "after")!;
    if (str(values, "after-pr") !== undefined)
      body.after_pr = str(values, "after-pr")!;
    if (values.auto === true) body.auto = true;
    if (values.urgent === true && values["no-urgent"] === true)
      throw new Problem(400, "--urgent 与 --no-urgent 只能给一个", "usage");
    if (values.urgent === true) body.urgent = true;
    if (values["no-urgent"] === true) body.urgent = false;
    Object.assign(body, laneInput(values));
    Object.assign(body, priorityInput(values));
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "至少给一项：--status、--pr、--title、--by、--ask、--from、--part、--also、--brief、--deliver、--issue、--after、--after-pr、--auto、--urgent/--no-urgent、--why、--stopgap、--avoid-host 或 --priority",
        "usage",
        undefined,
        `atrium task set ${id} --status done`,
      );
    const task = await (
      await client()
    ).patch<
      Task &
        UrgentReceipt & { cancelled_children?: string[]; stopped?: string[] }
    >(`/tasks/${id}`, body);
    if (json) printJson(task);
    else
      console.log(
        [
          `${task.ref} 已更新 · [${task.status}] ${task.title}`,
          ...(task.cancelled_children
            ? [
                task.cancelled_children.length
                  ? `连带取消 ${task.cancelled_children.length} 个子孙：${task.cancelled_children.join("、")}`
                  : "没有要连带取消的子孙",
                ...(task.stopped?.length
                  ? [`其中先停掉在跑的：${task.stopped.join("、")}`]
                  : []),
              ]
            : []),
          ...(body.urgent === true ? urgentLines(task) : []),
          ...laneLines(task),
          ...(body.urgent === false
            ? ["已取消紧急：照常排队、照常受本机负载限制"]
            : []),
          ...(body.priority === "idle" && body.urgent !== true
            ? urgentLines(task)
            : []),
          ...(body.priority === "normal"
            ? ["优先级：普通，照常排（紧急的仍在前）"]
            : []),
          ...(role !== undefined ? roleHint(task) : []),
          ...(concern !== undefined || ask !== undefined
            ? [
                task.concerns?.length
                  ? `请了 ${task.concerns.map((c) => `${c.name}（${c.ref}）`).join("、")}：派活时附检查要点，交付后按清单审`
                  : "没有请专员",
              ]
            : []),
          ...hintLines(task),
        ].join("\n"),
      );
    recordNext(`看全貌：atrium task tree ${task.parent_ref ?? task.ref}`);
  },
};

const note: Command = {
  args: "tN 文字 [--as 身份] [--verdict ok|fixed|rejected]",
  about: "追加处理备注（最多 300 字）；最新一条显示为当前说明",
  options: { as: { type: "string" }, verdict: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, text], values, json }) {
    const id = ref(reference, "任务");
    const result = await (
      await client()
    ).post<Task>(`/tasks/${id}/note`, {
      text,
      by:
        str(values, "as") ?? leaderSession()?.leader ?? defaultActor() ?? "u1",
      ...(str(values, "verdict") ? { verdict: str(values, "verdict") } : {}),
    });
    if (json) printJson(result);
    else console.log(`${id} 已追加备注（${result.note_by}）：${result.note}`);
    recordNext(`看详情：atrium task show ${id}`);
  },
};

const TELL_VIA: Record<string, string> = {
  stdin: "即时送入",
  resume: "续上会话",
  restart: "停掉重派",
  prompt: "写进提示词",
};
const TELL_STATE: Record<string, string> = {
  pending: "待送达",
  written: "已写入，待确认",
};

/** task show 里一条捎话事件：作者、送达状态、原文。 */
export function tellLine(detail: string | null) {
  try {
    const tell = JSON.parse(detail ?? "") as {
      by?: string;
      text?: string;
      state?: string;
      delivered_via?: string;
    };
    const state =
      tell.state === "delivered"
        ? `已送达·${TELL_VIA[tell.delivered_via ?? ""] ?? tell.delivered_via}`
        : (TELL_STATE[tell.state ?? ""] ?? "待送达");
    return `${tell.by ?? "未知"} [${state}] ${clip((tell.text ?? "").replace(/\s+/g, " "), 80)}`;
  } catch {
    return clip(detail ?? "", 80);
  }
}

const tell: Command = {
  args: "tN 文字 [--as 身份] [--verdict ok|fixed|rejected]",
  about:
    "给在跑的执行者捎话：Claude Code 即时送入，codex 本轮结束后续上会话，其余停掉带着补充重派；不在跑的下次拉起时写进提示词",
  options: { as: { type: "string" } },
  positionals: [2, 2],
  async run({ positionals: [reference, text], values, json }) {
    const id = ref(reference, "任务");
    const result = await (
      await client()
    ).post<{ task: Task; tell: { id: number; by: string }; how: string }>(
      `/tasks/${id}/tell`,
      {
        text,
        by:
          str(values, "as") ??
          leaderSession()?.leader ??
          defaultActor() ??
          "u1",
      },
    );
    if (json) printJson(result);
    else console.log(`${id} 已登记捎话（${result.tell.by}）：${result.how}`);
    recordNext(`看送达状态：atrium task show ${id}`);
  },
};

type Plan = {
  groups: Record<
    "running" | "ready" | "waiting" | "blocked",
    { task: Task; waiting_for: string[]; reason: string | null }[]
  >;
  next_after: string | null;
};
const plan: Command = {
  args: "[--after tN]",
  about: "按在跑、就绪、等待中、卡住列出待办及依赖；--json 给脚本",
  options: { after: { type: "string" } },
  positionals: [0, 0],
  async run({ values, json }) {
    const after = str(values, "after");
    const result = await (
      await client()
    ).get<Plan>(`/tasks/plan${after ? `?after=${ref(after, "--after")}` : ""}`);
    if (json) printJson(result);
    else {
      // 就绪、等待中的件数与 top、statusline 同一个函数（plan-count.ts）。
      const counts = planCounts(result.groups);
      for (const [group, label] of [
        ["running", "在跑"],
        ["ready", "就绪"],
        ["waiting", "等待中"],
        ["blocked", "卡住"],
      ] as const) {
        const count =
          group === "ready"
            ? counts.ready
            : group === "waiting"
              ? counts.waiting
              : result.groups[group].length;
        console.log(`${label}（${count}）`);
        for (const item of result.groups[group])
          console.log(
            `  ${item.task.ref} ${tagText(item.task)}${item.task.title}${item.task.queued_reason ? ` · ${queuedText(item.task.queued_reason)}` : ""}${item.waiting_for.length ? ` · 等 ${item.waiting_for.join("、")}` : ""}${item.reason ? ` · ${item.reason}` : ""}`,
          );
      }
    }
    recordNext(
      result.next_after
        ? `下一页：atrium task plan --after ${result.next_after}`
        : "建任务：atrium task add 标题",
    );
  },
};

const done: Command = {
  args: "tN",
  about: "人工完成任务；等同 task set tN --status done",
  positionals: [1, 1],
  async run({ positionals: [reference], json }) {
    const id = ref(reference, "任务");
    const task = await (
      await client()
    ).patch<Task>(`/tasks/${id}`, { status: "done" });
    if (json) printJson(task);
    else console.log(`${task.ref} 已完成 · ${task.title}`);
    recordNext("看排期：atrium task plan");
  },
};

const run: Command = {
  args: "tN [--worker 工具+模型[:强度]] [--risk low|medium|high] [--host hN] [--urgent [--why 原因]]",
  about:
    "派给执行者（服务持有进程）；不写 --worker 按额度挑（紧急任务按一次通过率与速度挑），--risk 缺省 low；--host 派到指定的执行机器（不写在能接的主机里挑最空的）；--urgent 同时标紧急走紧急通道：没空位先暂停闲时再普通任务，写了止损动作先执行（额度保留、trust、依赖照旧；leader 标须 --why）",
  options: {
    worker: { type: "string" },
    risk: { type: "string" },
    host: { type: "string" },
    urgent: { type: "boolean" },
    why: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const body: Record<string, string | boolean> = {};
    if (values.urgent === true) body.urgent = true;
    const why = str(values, "why");
    if (why !== undefined) body.why = why;
    const worker = str(values, "worker");
    if (worker !== undefined) {
      if (!worker.trim())
        throw new Problem(
          400,
          "--worker 不能为空，如 codex+gpt-6-sol",
          "usage",
        );
      body.worker = worker;
    }
    const risk = str(values, "risk");
    if (risk !== undefined) {
      if (!["low", "medium", "high"].includes(risk))
        throw new Problem(
          400,
          `--risk 只能是 low、medium、high（收到：${risk}）`,
          "usage",
        );
      body.risk = risk;
    }
    const host = str(values, "host");
    if (host !== undefined) {
      if (!/^h[1-9][0-9]{0,8}$/.test(host.trim()))
        throw new Problem(
          400,
          `--host 应为主机短号，如 h2（收到：${host}）`,
          "usage",
          undefined,
          "atrium host ls",
        );
      body.host = host.trim();
    }
    const result = await (
      await client()
    ).post<
      {
        task: Task & { events: TaskEventRow[] };
        queued: boolean;
        pick?: RunPick;
        reassigned?: { worker: string; from: string; reason: string | null };
      } & UrgentReceipt
    >(`/tasks/${id}/run`, body);
    const { task } = result;
    if (json) printJson(result);
    else
      console.log(
        [
          result.reassigned && result.queued
            ? `${task.ref} 已改派给 ${result.reassigned.worker}，仍在排队：${result.reassigned.reason ?? queuedReason(task.events)}`
            : result.reassigned && task.status !== "running"
              ? `${task.ref} 已改派给 ${result.reassigned.worker}，现在 ${task.status}`
              : result.queued
                ? `${task.ref} 排队中：${queuedReason(task.events)}`
                : `已${result.reassigned ? "改" : ""}派 ${task.ref} 给 ${task.worker}（${task.host_ref ? `${task.host_ref} 上 ` : ""}PID ${task.pid}${task.worktree ? `，工作树 ${task.worktree}，分支 ${task.branch}` : ""}）`,
          ...urgentLines(task),
          ...laneLines(result),
          ...pickLines(result.pick),
        ].join("\n"),
      );
    recordNext(`等结果：atrium task wait ${task.ref}`);
  },
};

/** 自动挑人写理由，写死执行者有更富余的候选时加一行提醒（不拦）。 */
export function pickLines(pick: RunPick | undefined): string[] {
  if (!pick) return [];
  return [
    ...(pick.auto && pick.reason
      ? [
          pick.reason.startsWith("紧急：")
            ? `挑了 ${pick.worker}（${pick.reason}）`
            : `按额度挑了 ${pick.worker}，因为${pick.reason}`,
        ]
      : []),
    ...(pick.notice ? [pick.notice] : []),
  ];
}

const accountCell = (q: PickAccount) => {
  if (q.held_until !== null) return `额度用尽至 ${when(q.held_until)}`;
  const parts = [
    q.used_percent === null ? null : `已用 ${Math.round(q.used_percent)}%`,
    q.spare_percent === null ? null : `富余 ${signedPercent(q.spare_percent)}`,
    q.hours_to_reset === null
      ? null
      : `${q.hours_to_reset < 10 ? q.hours_to_reset.toFixed(1) : Math.round(q.hours_to_reset)} 小时后重置`,
    q.left_percent === null ? null : `扣保留剩 ${Math.round(q.left_percent)}%`,
  ].filter(Boolean);
  return parts.length
    ? `${q.account} ${parts.join("，")}`
    : `${q.account} 无数据`;
};

const recordCell = (r: PickCandidate["record"]) =>
  !r || !r.deliveries
    ? "无记录"
    : `${r.deliveries} 次${r.first_pass_rate === null ? "" : `，一次通过 ${Math.round(r.first_pass_rate * 100)}%`}${r.low_data ? "（样本少）" : ""}`;

const takeCell = (c: PickCandidate, job: PickView["job"]) =>
  [
    c.eligible ? "能接" : `不能接：${c.refusals.join("；")}`,
    c.preferred !== null && job ? `${job.name}专员第 ${c.preferred} 选` : "",
    ...c.notes,
  ]
    .filter(Boolean)
    .join(" · ");

/** 能请的专员一行：本部分、上级与牵涉部分的逐位写出，全组织的折在最后（#373）。 */
export function specialistLine(list: PickSpecialists["available"]): string {
  const near = list
    .filter((s) => s.scope !== "org")
    .map((s) => `${s.name}（${s.part_name ?? s.part}）`);
  const org = list.filter((s) => s.scope === "org").map((s) => s.name);
  return `能请的专员：${[...near, ...(org.length ? [`全组织的 ${org.join("、")}`] : [])].join("；") || "无"}`;
}

/** 候选一览的文本：推荐一句、表格；表格一行一位候选。 */
type HostPick = {
  ref: string;
  name: string;
  status: string;
  running: number;
  max: number | null;
  fit: "ok" | "later" | "never";
  reason: string | null;
  chosen: boolean;
};

/** task pick 的主机一栏（#358）：推荐的执行者在各台能不能跑、自动派会去哪台。 */
function hostPickLines(hosts: HostPick[] | undefined, worker: string | null) {
  if (!hosts?.length || !worker) return [];
  return [
    "",
    `主机（按推荐的 ${worker}）：`,
    table(
      hosts.map((h) => [
        h.chosen ? "→" : "",
        h.ref,
        h.name,
        h.status,
        `${h.running}/${h.max ?? "不限"}`,
        h.fit === "ok"
          ? "能接"
          : h.fit === "later"
            ? `排队：${h.reason}`
            : `不能接：${h.reason}`,
      ]),
    ),
  ];
}

export function formatPick(
  view: PickView & {
    task: string;
    specialists?: PickSpecialists;
    hosts?: HostPick[];
  },
): string {
  const head = view.recommended
    ? `推荐 ${view.recommended}：${view.reason}`
    : `暂无推荐：${view.reason}`;
  const meta = `${view.task} · risk=${view.risk}${view.job ? ` · 干活的专员 ${view.job.name}（${view.job.ref}）` : " · 没指定干活的专员"} · 根章程给用户保留 ${view.reserve_percent}%${view.quota_known ? "" : " · 额度数据不可用"}`;
  const scope = view.specialists
    ? [
        ...(view.specialists.job_outside ? [view.specialists.job_outside] : []),
        specialistLine(view.specialists.available),
      ]
    : [];
  if (!view.candidates.length) return [head, meta, ...scope].join("\n");
  return [
    head,
    meta,
    ...scope,
    ...hostPickLines(view.hosts, view.recommended),
    "",
    table([
      ["", "执行者", "能不能接", "账号额度", "正忙", "交付记录"],
      ...view.candidates.map((c) => [
        c.rank === null ? "-" : String(c.rank),
        c.worker,
        takeCell(c, view.job),
        accountCell(c.quota),
        c.busy ? "正忙，派了会排队" : "空闲",
        recordCell(c.record),
      ]),
    ]),
  ].join("\n");
}

const pick: Command = {
  args: "tN [--risk low|medium|high]",
  about:
    "看派活候选（只读，不派）：候选执行者能不能接、账号额度、是否正忙、在干活的专员下的交付记录，给出推荐与理由；--risk 缺省 low",
  options: { risk: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const risk = str(values, "risk");
    if (risk !== undefined && !["low", "medium", "high"].includes(risk))
      throw new Problem(
        400,
        `--risk 只能是 low、medium、high（收到：${risk}）`,
        "usage",
      );
    const view = await (
      await client()
    ).get<PickView & { task: string; specialists?: PickSpecialists }>(
      `/tasks/${id}/pick${risk ? `?${new URLSearchParams({ risk })}` : ""}`,
    );
    if (json) printJson(view);
    else console.log(formatPick(view));
    const riskFlag = risk && risk !== "low" ? ` --risk ${risk}` : "";
    recordNext(
      view.recommended
        ? `派活：atrium task run ${id} --worker ${view.recommended}${riskFlag}`
        : "看额度：atrium quota",
    );
  },
};

const stop: Command = {
  args: "tN [--as 订阅者]",
  about:
    "停掉执行者或合入队列；由此产生的事件不投给发起者本人（缺省 secretary）",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const who = str(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const result = await (
      await client()
    ).post<{ task: Task; stopping: boolean }>(
      `/tasks/${id}/stop?${new URLSearchParams({ as: who })}`,
    );
    if (json) printJson(result);
    else
      console.log(
        result.stopping
          ? `已向 ${id} 的执行者发停止信号`
          : `${id} 已停 · [${result.task.status}]`,
      );
    recordNext(
      result.stopping
        ? `等它退出：atrium task wait ${id}`
        : `看详情：atrium task show ${id}`,
    );
  },
};

const merge: Command = {
  args: "tN [--as 订阅者]",
  about:
    "将关卡已通过、带 PR 的受阻合入任务重新排队；受阻在专员否决或没出结论上的，负责的 leader 看过理由不认同时用它放行",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const who = str(values, "as") ?? defaultSubscriber();
    if (!who.trim()) throw new Problem(400, "--as 不能为空", "usage");
    const result = await (
      await client()
    ).post<{ task: Task }>(
      `/tasks/${id}/merge?${new URLSearchParams({ as: who })}`,
      {},
    );
    if (json) printJson(result);
    else console.log(`${id} 已排队合入 · [${result.task.status}]`);
    recordNext(`等合入：atrium task wait ${id}`);
  },
};

type LogChunk = {
  text: string;
  next: number;
  size: number;
  running: boolean;
  status: string;
};

const log: Command = {
  args: "tN [--follow] [--after 字节]",
  about: "看执行者日志；--follow 跟到任务结束，--after 从上次的字节偏移续读",
  options: {
    follow: { type: "boolean", default: false },
    after: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const afterText = str(values, "after");
    if (afterText !== undefined && !/^(0|[1-9]\d*)$/.test(afterText))
      throw new Problem(400, "--after 应为非负整数字节偏移", "usage");
    const follow = values.follow === true;
    if (follow && json)
      throw new Problem(400, "--follow 不能与 --json 同时使用", "usage");
    const api = await client();
    let after = afterText === undefined ? 0 : Number(afterText);
    for (;;) {
      const chunk = await api.get<LogChunk>(`/tasks/${id}/log?after=${after}`);
      if (json) {
        printJson(chunk);
        after = chunk.next;
        break;
      }
      if (chunk.text) process.stdout.write(chunk.text);
      const more = chunk.next < chunk.size;
      after = chunk.next;
      if (!follow) {
        if (!more && !chunk.text && !chunk.running)
          console.log(chunk.size ? "（没有新日志）" : "还没有日志");
        break;
      }
      if (!more && !chunk.running) break;
      if (!more) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    recordNext(`续读：atrium task log ${id} --after ${after}`);
  },
};

const wait: Command = {
  args: "tN [--timeout 秒]",
  about: "等任务结束（PR 任务等合入或卡住）或超时；缺省 300 秒",
  options: { timeout: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const seconds = waitSeconds(str(values, "timeout"));
    const api = await client();
    const result = await longWait<{ task: Task; timed_out: boolean }>(
      seconds,
      (timeout) => api.get(`/tasks/${id}/wait?timeout=${timeout}`),
      () => `atrium task wait ${id}`,
    );
    if (json) printJson(result);
    else if (result.timed_out)
      console.log(`${seconds} 秒内 ${id} 还没结束；atrium task wait ${id}`);
    else {
      const task = result.task;
      console.log(
        [
          `${task.ref} [${displayStatus(task)}] ${task.title}`,
          task.pr_url
            ? `  PR：${task.pr_url}${task.ci ? `（CI ${task.ci}）` : ""}`
            : "",
          task.result
            ? `  摘要：${clip(task.result.replace(/\s+/g, " "), 200)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    recordNext(
      result.timed_out
        ? `继续等：atrium task wait ${id}`
        : `看详情与关卡：atrium task show ${id}`,
    );
    return result.timed_out ? 124 : 0;
  },
};

export const taskCommands: Record<string, Command> = {
  "task add": add,
  "task ls": ls,
  "task plan": plan,
  "task show": show,
  "task tree": tree,
  "task set": set,
  "task note": note,
  "task tell": tell,
  "task done": done,
  "task pick": pick,
  "task run": run,
  "task stop": stop,
  "task merge": merge,
  "task log": log,
  "task wait": wait,
};
