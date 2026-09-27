import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson, when } from "./format.ts";
import { recordNext } from "./contract.ts";
import type { GoalNode, GoalTasks, GoalView } from "../server/goals/read.ts";
import type { AdoptPlan } from "../server/goals/adopt.ts";
import type { CheckView } from "../server/goals/checks.ts";
import { CHECK_LABEL } from "../server/goals/check-rules.ts";
import { longWait, waitSeconds } from "./long-wait.ts";

/** 目标树的命令行（#313）：只经 HTTP 调服务。--as 是 u1 或组织节点 leader aN。 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const strs = (values: Values, key: string) => {
  const value = values[key];
  return (
    Array.isArray(value) ? value : value === undefined ? [] : [value]
  ).filter((v): v is string => typeof v === "string");
};
const client = async () => (await import("./service.ts")).connect();
const path = (value: string) => encodeURIComponent(value);
const as = (values: Values) =>
  str(values, "as") ? `?as=${path(str(values, "as")!)}` : "";
const options = { as: { type: "string" as const } };
const person = (value: string) => (value === "u1" ? "你" : value);

function ref(value: string | undefined) {
  if (!value || !/^g[1-9][0-9]*$/.test(value))
    throw new Problem(
      400,
      `目标短号应为 g1 这样的格式（收到：${value ?? "空"}）`,
      "usage",
      undefined,
      "atrium goal tree",
    );
  return value;
}

/** 挂着的任务：在跑、未结、共计；没有任务省略。 */
export function formatGoalTasks(tasks: GoalTasks): string {
  const total = Object.values(tasks).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const open = tasks.todo + tasks.running + tasks.blocked;
  return [
    tasks.running ? `在跑 ${tasks.running}` : "",
    tasks.blocked ? `卡住 ${tasks.blocked}` : "",
    `未结 ${open}/${total}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** 一行：短号、状态、结果、负责部门、前置、日期、任务。 */
export function goalLine(goal: GoalView & { tasks?: GoalTasks }): string {
  const waiting = goal.after.filter((a) => !a.met);
  return [
    `${goal.ref} [${goal.status_label}] ${goal.result}`,
    goal.ready ? "· 可标达成" : "",
    `· ${goal.node_ref}${goal.node_name ? ` ${goal.node_name}` : ""}`,
    goal.after.length
      ? `· 前置 ${goal.after.map((a) => `${a.ref}${a.met ? "✓" : ""}`).join(",")}${waiting.length ? `（等 ${waiting.map((a) => a.ref).join(",")}）` : ""}`
      : "",
    goal.due ? `· ${goal.due}` : "",
    goal.tasks && formatGoalTasks(goal.tasks)
      ? `· 任务 ${formatGoalTasks(goal.tasks)}`
      : "",
    goal.status === "dropped" || goal.status === "blocked"
      ? goal.note
        ? `· ${goal.note}`
        : ""
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function renderGoalTree(
  goals: GoalNode[],
  maxDepth = Infinity,
  depth = 0,
): string[] {
  return goals.flatMap((goal) => [
    `${"  ".repeat(depth)}${goalLine(goal)}`,
    ...(depth + 1 < maxDepth
      ? renderGoalTree(goal.children, maxDepth, depth + 1)
      : goal.children.length
        ? [
            `${"  ".repeat(depth + 1)}…下层 ${goal.children.length} 个：atrium goal tree ${goal.ref}`,
          ]
        : []),
  ]);
}

const out = (json: boolean, value: unknown, text: string, next: string) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(next);
};

const tree: Command = {
  args: "[gN] [--depth N]",
  about: "看目标树：各层状态、负责部门、前置和挂着的任务；给 gN 只看那一棵",
  options: { depth: { type: "string" } },
  positionals: [0, 1],
  async run({ positionals: [root], values, json }) {
    const depthText = str(values, "depth");
    const depth = depthText === undefined ? Infinity : Number(depthText);
    if (depthText !== undefined && (!Number.isInteger(depth) || depth < 1))
      throw new Problem(400, "--depth 应为正整数", "usage");
    const result = await (
      await client()
    ).get<{ goals: GoalNode[] }>(
      `/goals/tree${root === undefined ? "" : `?root=${ref(root)}`}`,
    );
    out(
      json,
      result,
      result.goals.length
        ? renderGoalTree(result.goals, depth).join("\n")
        : "还没有目标",
      result.goals.length
        ? `看详情：atrium goal show ${root ?? result.goals[0]!.ref}`
        : "建顶层目标：atrium goal add 结果 --node o1",
    );
  },
};

type Shown = GoalView & {
  path: { ref: string; result: string }[];
  children: { ref: string; status_label: string; result: string }[];
  needed_by: string[];
  task_counts: GoalTasks;
  tasks: {
    ref: string;
    title: string;
    status: string;
    worker: string | null;
  }[];
};
const show: Command = {
  args: "gN",
  about:
    "看目标或里程碑：结果、验收标准、状态、负责部门、前置、下层与挂着的任务",
  positionals: [1, 1],
  async run({ positionals: [id], json }) {
    const goal = await (await client()).get<Shown>(`/goals/${ref(id)}`);
    const lines = [
      `${goal.ref} [${goal.status_label}] ${goal.result}${goal.top ? "（顶层目标）" : ""}`,
      ...(goal.path.length
        ? [
            `  上层：${goal.path.map((p) => `${p.ref} ${p.result}`).join(" › ")}`,
          ]
        : []),
      `  负责：${goal.node_ref}${goal.node_path ? ` ${goal.node_path}` : ""}`,
      ...(goal.due ? [`  目标日期：${goal.due}`] : []),
      ...(goal.note ? [`  说明：${goal.note}`] : []),
      ...(goal.after.length
        ? [
            `  前置：${goal.after.map((a) => `${a.ref} [${a.met ? "达成" : "未达成"}] ${a.result}`).join("；")}`,
          ]
        : []),
      ...(goal.needed_by.length
        ? [`  被依赖：${goal.needed_by.join("、")}`]
        : []),
      ...(goal.repo ? [`  仓库：${goal.repo}`] : []),
      ...(goal.items.length
        ? ["  验收标准：", ...goal.items.flatMap(itemLines)]
        : [
            goal.criteria_broken
              ? "  验收标准：记录损坏，请用 goal edit --criteria 重写"
              : "  验收标准：未填写",
          ]),
      ...(goal.children.length
        ? [
            "  下层：",
            ...goal.children.map(
              (c) => `    ${c.ref} [${c.status_label}] ${c.result}`,
            ),
          ]
        : []),
      ...(goal.tasks.length
        ? [
            `  任务（${formatGoalTasks(goal.task_counts)}）：`,
            ...goal.tasks.map(
              (t) =>
                `    ${t.ref} [${t.status}] ${t.title}${t.worker ? ` · ${t.worker}` : ""}`,
            ),
          ]
        : []),
      ...(goal.ready
        ? ["  验收标准全部满足、前置都已达成：可标达成"]
        : goal.ready_blockers.length && goal.items.length
          ? [`  未满足：${goal.ready_blockers.join("；")}`]
          : []),
      `  最后改动：${person(goal.updated_by)}`,
    ];
    out(
      json,
      goal,
      lines.join("\n"),
      goal.ready
        ? `标达成：atrium goal done ${goal.ref} --note 证据`
        : goal.items.some((i) => i.command && i.latest?.result !== "pass")
          ? `跑命令条目：atrium goal check ${goal.ref}`
          : goal.children.length
            ? `看下层：atrium goal tree ${goal.ref}`
            : goal.tasks[0]
              ? `看任务：atrium task show ${goal.tasks[0].ref}`
              : `挂任务：atrium task add 标题 --goal ${goal.ref}`,
    );
  },
};

/** 判定一行：满足/不满足/执行中，谁判的、何时；命令带退出码。 */
export function checkLine(check: CheckView): string {
  const mark =
    check.result === "pass" ? "✓" : check.result === "running" ? "…" : "✗";
  return `${mark} ${CHECK_LABEL[check.result]}（${
    check.kind === "command"
      ? `运行时${check.exit_code === null ? "" : `，退出码 ${check.exit_code}`}`
      : `${person(check.actor)} 判`
  }，${when(check.ended_at ?? check.started_at)}）`;
}
const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .slice(-8)
    .map((line) => `${prefix}${line}`);
/** 一条验收标准及其最新判定与证据（人工判定的 note，命令的输出摘要末 8 行）。 */
export function itemLines(item: GoalView["items"][number]): string[] {
  const head = `    ${item.n}. ${item.text}`;
  if (!item.latest) return [`${head}  · ${item.command ? "还没跑" : "还没判"}`];
  const evidence = item.latest.note ?? item.latest.summary;
  return [
    `${head}  · ${checkLine(item.latest)}`,
    ...(evidence ? indent(evidence, "       ") : []),
  ];
}

const check: Command = {
  args: "gN [--item N] [--pass|--fail --note 证据] [--timeout 秒] [--as aN]",
  about:
    "判定验收标准：不给 --pass/--fail 时运行时在隔离的临时 worktree 里跑命令条目（`$ ` 开头；给 --item 只跑那条），退出码 0 为满足；写不成命令的条目用 --item N --pass|--fail --note 证据 人工判",
  options: {
    ...options,
    item: { type: "string" },
    pass: { type: "boolean" },
    fail: { type: "boolean" },
    note: { type: "string" },
    timeout: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const goal = ref(id);
    const itemText = str(values, "item");
    const item = itemText === undefined ? undefined : Number(itemText);
    if (
      item !== undefined &&
      (!/^[1-9][0-9]*$/.test(itemText!) || !Number.isSafeInteger(item))
    )
      throw new Problem(400, "--item 应为正整数，如 --item 2", "usage");
    if (values.pass === true && values.fail === true)
      throw new Problem(400, "--pass 与 --fail 只能给一个", "usage");
    const verdict =
      values.pass === true ? "pass" : values.fail === true ? "fail" : undefined;
    if (verdict === undefined && str(values, "note") !== undefined)
      throw new Problem(
        400,
        "--note 只配人工判定：同时给 --item N 和 --pass 或 --fail",
        "usage",
      );
    const seconds = waitSeconds(str(values, "timeout"));
    const api = await client();
    const started = await api.post<{ checks: CheckView[] }>(
      `/goals/${goal}/check${as(values)}`,
      {
        ...(item === undefined ? {} : { item }),
        ...(verdict === undefined
          ? {}
          : { verdict, note: str(values, "note") ?? "" }),
      },
    );
    let checks = started.checks;
    let timedOut = false;
    if (checks.some((c) => c.result === "running")) {
      const ids = checks.map((c) => c.id).join(",");
      const waited = await longWait<{
        checks: CheckView[];
        timed_out: boolean;
        restarting?: boolean;
      }>(
        seconds,
        (timeout) =>
          api.get(`/goals/${goal}/check-wait?ids=${ids}&timeout=${timeout}`),
        () => `atrium goal check ${goal}`,
      );
      checks = waited.checks;
      timedOut = waited.timed_out;
    }
    const view = await api.get<GoalView>(`/goals/${goal}`);
    const number = (c: CheckView) =>
      view.items.find((i) => i.text === c.criterion)?.n;
    const lines = [
      ...checks.flatMap((c) => [
        `${goal} 第 ${number(c) ?? "?"} 条 ${c.criterion}  · ${checkLine(c)}`,
        ...((c.note ?? c.summary)
          ? indent((c.note ?? c.summary)!, "    ")
          : []),
      ]),
      ...(timedOut ? [`${seconds} 秒内还没跑完；再运行同一命令接着等`] : []),
      view.ready
        ? `${goal} 验收标准全部满足、前置都已达成：可标达成（运行时不自动标）`
        : `${goal} 还不能标达成：${view.ready_blockers.join("；") || "已达成或已放弃"}`,
    ];
    out(
      json,
      {
        checks,
        timed_out: timedOut,
        ready: view.ready,
        ready_blockers: view.ready_blockers,
      },
      lines.join("\n"),
      timedOut
        ? `接着等：atrium goal check ${goal}${item === undefined ? "" : ` --item ${item}`}`
        : view.ready
          ? `标达成：atrium goal done ${goal} --note 证据`
          : `看详情：atrium goal show ${goal}`,
    );
  },
};

/** --repo 相对路径按当前目录补成绝对路径；空串表示清掉。 */
const repoPath = (value: string) => (value.trim() ? resolve(value) : "");

const add: Command = {
  args: "结果 [--parent gN] [--node 节点] [--criteria 条目]… [--after gN[,gM]] [--due 日期] [--repo 路径] [--status planned|active] [--as aN]",
  about:
    "建顶层目标（不给 --parent，只有你能建）或里程碑；--node 负责部门（缺省同上层），--criteria 可多次给，以 `$ ` 开头的条目是命令，由运行时在 --repo 仓库里跑",
  options: {
    ...options,
    repo: { type: "string" },
    parent: { type: "string" },
    node: { type: "string" },
    criteria: { type: "string", multiple: true },
    after: { type: "string" },
    due: { type: "string" },
    status: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [result], values, json }) {
    const parent = str(values, "parent");
    const body = {
      result,
      ...(parent === undefined ? {} : { parent: ref(parent) }),
      ...(str(values, "node") === undefined
        ? {}
        : { node: str(values, "node") }),
      ...(values.criteria === undefined
        ? {}
        : { criteria: strs(values, "criteria") }),
      ...(str(values, "after") === undefined
        ? {}
        : { after: str(values, "after") }),
      ...(str(values, "due") === undefined ? {} : { due: str(values, "due") }),
      ...(str(values, "repo") === undefined
        ? {}
        : { repo: repoPath(str(values, "repo")!) }),
      ...(str(values, "status") === undefined
        ? {}
        : { status: str(values, "status") }),
    };
    const goal = await (
      await client()
    ).post<GoalView>(`/goals${as(values)}`, body);
    out(
      json,
      goal,
      `已建 ${goal.ref}${goal.top ? "（顶层目标）" : `（在 ${goal.parent_ref} 下）`}：${goal.result} · ${goal.node_ref}${goal.node_name ? ` ${goal.node_name}` : ""} · ${goal.status_label}${goal.criteria.length ? "" : "\n还没有验收标准：atrium goal edit " + goal.ref + " --criteria 条目"}`,
      `拆里程碑：atrium goal add 结果 --parent ${goal.ref}`,
    );
  },
};

const edit: Command = {
  args: "gN [--result 结果] [--criteria 条目]… [--node 节点] [--parent gN] [--after gN[,gM]|''] [--due 日期|''] [--repo 路径|''] [--status planned|active|blocked] [--note 说明] [--as aN]",
  about:
    "改目标或里程碑；--criteria 整组替换（给一次空串清空），--after 整组替换；不留修订记录",
  options: {
    ...options,
    result: { type: "string" },
    criteria: { type: "string", multiple: true },
    node: { type: "string" },
    parent: { type: "string" },
    after: { type: "string" },
    due: { type: "string" },
    repo: { type: "string" },
    status: { type: "string" },
    note: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const body: Record<string, unknown> = {};
    for (const key of [
      "result",
      "node",
      "after",
      "due",
      "repo",
      "status",
      "note",
    ])
      if (str(values, key) !== undefined) body[key] = str(values, key);
    if (str(values, "repo") !== undefined)
      body.repo = repoPath(str(values, "repo")!);
    if (str(values, "parent") !== undefined)
      body.parent = ref(str(values, "parent"));
    if (values.criteria !== undefined) body.criteria = strs(values, "criteria");
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "至少给一项：--result、--criteria、--node、--parent、--after、--due、--repo、--status 或 --note",
        "usage",
      );
    const goal = await (
      await client()
    ).patch<GoalView & { changed: string[] }>(
      `/goals/${ref(id)}${as(values)}`,
      body,
    );
    out(
      json,
      goal,
      goal.changed.length
        ? `已改 ${goal.ref}（${goal.changed.join("、")}）：[${goal.status_label}] ${goal.result}`
        : `${goal.ref} 没有变化`,
      `看详情：atrium goal show ${goal.ref}`,
    );
  },
};

const done: Command = {
  args: "gN [--note 证据] [--as aN]",
  about: "标为达成（前置须都已达成）；--note 记达成证据",
  options: { ...options, note: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const goal = await (
      await client()
    ).post<GoalView>(`/goals/${ref(id)}/done${as(values)}`, {
      ...(str(values, "note") === undefined
        ? {}
        : { note: str(values, "note") }),
    });
    out(
      json,
      goal,
      `${goal.ref} 已达成：${goal.result}`,
      goal.parent_ref
        ? `看上层：atrium goal show ${goal.parent_ref}`
        : "看全貌：atrium goal tree",
    );
  },
};

const drop: Command = {
  args: "gN --reason 原因 [--as aN]",
  about:
    "放弃目标或里程碑（要写原因；下层与挂着的任务须先收尾）；改回用 goal edit --status",
  options: { ...options, reason: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [id], values, json }) {
    const reason = str(values, "reason");
    if (!reason?.trim())
      throw new Problem(400, "--reason 不能为空：放弃要写原因", "usage");
    const goal = await (
      await client()
    ).post<GoalView>(`/goals/${ref(id)}/drop${as(values)}`, { note: reason });
    out(
      json,
      goal,
      `${goal.ref} 已放弃：${goal.result}（${goal.note}）`,
      `改回：atrium goal edit ${goal.ref} --status active`,
    );
  },
};

const adopt: Command = {
  args: "tN --parent gN [--node 节点] [--apply] [--as aN]",
  about:
    "把只起归类作用的父任务迁为里程碑：子任务挂上并上移一层，父任务标取消（默认只预览）",
  options: {
    ...options,
    parent: { type: "string" },
    node: { type: "string" },
    apply: { type: "boolean" },
  },
  positionals: [1, 1],
  async run({ positionals: [task], values, json }) {
    if (!task || !/^t[1-9][0-9]*$/.test(task))
      throw new Problem(
        400,
        `任务短号应为 t1 这样的格式（收到：${task ?? "空"}）`,
        "usage",
      );
    const parent = str(values, "parent");
    if (parent === undefined)
      throw new Problem(
        400,
        "--parent 必填：挂到哪个目标或里程碑下，如 g1",
        "usage",
        undefined,
        "atrium goal tree",
      );
    const plan = await (
      await client()
    ).post<AdoptPlan>(`/goals/adopt${as(values)}`, {
      task,
      parent: ref(parent),
      ...(str(values, "node") === undefined
        ? {}
        : { node: str(values, "node") }),
      apply: values.apply === true,
    });
    const lines = [
      plan.preview
        ? `将把 ${plan.task} 迁为里程碑（预览，未写入）：`
        : `已把 ${plan.task} 迁为里程碑 ${plan.goal.ref}：`,
      `  结果：${plan.goal.result} · 在 ${plan.goal.parent} 下 · ${plan.goal.node} · ${plan.goal.status_label}`,
      `  挂上的子任务：${plan.attach.join("、") || "无"}`,
      ...(plan.keep.length
        ? [
            `  已挂别处、保持不变：${plan.keep.map((k) => `${k.task}→${k.goal}`).join("、")}`,
          ]
        : []),
      `  子任务上移一层；${plan.task} ${plan.parent_task === "cancel" ? "标为取消" : "保持原状态"}，也挂上新里程碑留痕`,
    ];
    out(
      json,
      plan,
      lines.join("\n"),
      plan.preview
        ? `写入：atrium goal adopt ${plan.task} --parent ${plan.goal.parent}${str(values, "node") ? ` --node ${str(values, "node")}` : ""}${str(values, "as") ? ` --as ${str(values, "as")}` : ""} --apply`
        : `补验收标准：atrium goal edit ${plan.goal.ref} --criteria 条目`,
    );
  },
};

export const goalCommands: Record<string, Command> = {
  "goal tree": tree,
  "goal show": show,
  "goal add": add,
  "goal edit": edit,
  "goal check": check,
  "goal done": done,
  "goal drop": drop,
  "goal adopt": adopt,
};
