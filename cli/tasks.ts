import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import { TASK_STATUSES, isTaskStatus } from "../server/tasks/state.ts";
import { DELIVERS, type Deliver } from "../server/tasks/deliver.ts";
import type { Task, TaskEventRow, TaskNode } from "../server/tasks/ledger.ts";
import { formatChildSummary } from "../server/tasks/ledger-summary.ts";
import { recordNext } from "./contract.ts";
import { longWait, waitSeconds } from "./long-wait.ts";
import { clip, printJson, table, when } from "./format.ts";
import type { Command, Values } from "./main.ts";

/** 任务账本的命令行（#262）：只经 HTTP 调服务，不直接开数据库。 */

// 不从 main.ts 取值：测试会先加载本模块，main.ts 再回头引入时会撞上循环初始化。
const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();

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
  [
    task.ref,
    `[${task.status}]`,
    task.title,
    `· ${task.deliver}${task.issue ? ` #${task.issue}` : ""}`,
    task.child_summary ? `· ${formatChildSummary(task.child_summary)}` : "",
    task.worker ? `· ${task.worker}` : "",
    task.pr_url ? `· ${task.pr_url}` : "",
  ]
    .filter(Boolean)
    .join(" ");

export function renderTree(nodes: TaskNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${line(node)}`,
    ...renderTree(node.children, depth + 1),
  ]);
}

const add: Command = {
  args: "标题 [--parent tN] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto] [--role R] [--repo 路径] [--brief 文件] [--owner 订阅者] [--deliver pr|comment|none] [--issue 号]",
  about: "建任务；--parent 挂到父任务下，--brief 附任务详述 md",
  options: {
    parent: { type: "string" },
    role: { type: "string" },
    repo: { type: "string" },
    brief: { type: "string" },
    owner: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
  },
  positionals: [1, 1],
  async run({ positionals: [title], values, json }) {
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
      ...(str(values, "role") === undefined
        ? {}
        : { role: str(values, "role") }),
      ...(repo === undefined
        ? {}
        : { repo: existing(repo, "--repo", "directory") }),
      ...(brief === undefined
        ? {}
        : { brief_path: existing(brief, "--brief", "file") }),
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
    };
    const task = await (await client()).post<Task>("/tasks", body);
    if (json) printJson(task);
    else
      console.log(
        `已建 ${task.ref}：${task.title}${task.parent_ref ? `（父任务 ${task.parent_ref}）` : ""}`,
      );
    recordNext(
      str(values, "after") || str(values, "after-pr") || values.auto === true
        ? "看排期：atrium task plan"
        : task.parent_ref
          ? `派活：atrium task run ${task.ref}`
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
    else
      console.log(
        table([
          ["短号", "状态", "父任务", "标题", "执行者", "PR"],
          ...result.tasks.map((task) => [
            task.ref,
            task.status,
            task.parent_ref ?? "",
            clip(task.title, 40),
            task.worker ?? "",
            task.pr_url ?? "",
          ]),
        ]),
      );
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
      }
    >(`/tasks/${ref(reference, "任务")}`);
    if (json) printJson(task);
    else {
      const rows: [string, string | number | null][] = [
        ["标题", task.title],
        ["状态", task.status],
        ["父任务", task.parent_ref],
        ["子任务", task.children || null],
        [
          "子任务汇总",
          task.child_summary ? formatChildSummary(task.child_summary) : null,
        ],
        ["岗位", task.role],
        ["仓库", task.repo],
        [
          "交付物",
          `${task.deliver}${task.issue ? `（issue #${task.issue}）` : ""}`,
        ],
        ["详述", task.brief_path],
        ["负责人", task.owner],
        ["执行者", task.worker],
        ["进程", task.pid],
        ["工作树", task.worktree],
        ["分支", task.branch],
        ["PR", task.pr_url],
        ["CI", task.ci],
        ["建于", when(task.created_at)],
        ["开始", task.started_at ? when(task.started_at) : null],
        ["结束", task.ended_at ? when(task.ended_at) : null],
      ];
      console.log(
        [
          `${task.ref} · ${task.title}`,
          ...rows
            .slice(1)
            .filter(([, value]) => value !== null && value !== "")
            .map(([key, value]) => `  ${key}：${value}`),
          ...(task.result ? ["结果摘要：", task.result] : []),
          ...(task.events.length
            ? [
                "事件：",
                ...task.events.map(
                  (event) =>
                    `  ${when(event.at)}  ${event.kind}${event.detail ? `  ${clip(event.detail, 80)}` : ""}`,
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

const tree: Command = {
  args: "[tN]",
  about:
    "缩进树：短号、状态、标题、交付物、执行者、PR；不写 tN 显示全部顶层任务",
  positionals: [0, 1],
  async run({ positionals: [root], json }) {
    const result = await (
      await client()
    ).get<{ tasks: TaskNode[]; truncated: boolean }>(
      `/tasks/tree${root === undefined ? "" : `?root=${ref(root, "任务")}`}`,
    );
    if (json) printJson(result);
    else if (!result.tasks.length) console.log("还没有任务");
    else {
      console.log(renderTree(result.tasks).join("\n"));
      if (result.truncated) console.log("（任务过多，只显示前 2000 个）");
    }
    recordNext(
      result.tasks.length
        ? `看详情：atrium task show ${root ?? result.tasks[0]!.ref}`
        : "建任务：atrium task add 标题",
    );
  },
};

const set: Command = {
  args: "tN [--status S] [--after tN[,tM]] [--after-pr owner/repo#N] [--auto]",
  about: `人工修正状态（${TASK_STATUSES.filter((s) => s !== "running").join("、")}）；也可改 --title --role --brief --deliver --issue、依赖和自动派发`,
  options: {
    status: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    brief: { type: "string" },
    deliver: { type: "string" },
    issue: { type: "string" },
    after: { type: "string" },
    "after-pr": { type: "string" },
    auto: { type: "boolean" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const body: Record<string, string | boolean> = {};
    const wanted = str(values, "status");
    if (wanted !== undefined) body.status = status(wanted);
    const title = str(values, "title");
    if (title !== undefined) {
      if (!title.trim()) throw new Problem(400, "--title 不能为空", "usage");
      body.title = title;
    }
    const role = str(values, "role");
    if (role !== undefined) body.role = role;
    const brief = str(values, "brief");
    if (brief !== undefined)
      body.brief_path = brief === "" ? "" : existing(brief, "--brief", "file");
    const kind = str(values, "deliver");
    if (kind !== undefined) body.deliver = deliver(kind);
    const issueText = str(values, "issue");
    if (issueText !== undefined) body.issue = String(issue(issueText));
    if (str(values, "after") !== undefined) body.after = str(values, "after")!;
    if (str(values, "after-pr") !== undefined)
      body.after_pr = str(values, "after-pr")!;
    if (values.auto === true) body.auto = true;
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "至少给一项：--status、--title、--role、--brief、--deliver、--issue、--after、--after-pr 或 --auto",
        "usage",
        undefined,
        `atrium task set ${id} --status done`,
      );
    const task = await (await client()).patch<Task>(`/tasks/${id}`, body);
    if (json) printJson(task);
    else console.log(`${task.ref} 已更新 · [${task.status}] ${task.title}`);
    recordNext(`看全貌：atrium task tree ${task.parent_ref ?? task.ref}`);
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
      for (const [group, label] of [
        ["running", "在跑"],
        ["ready", "就绪"],
        ["waiting", "等待中"],
        ["blocked", "卡住"],
      ] as const) {
        console.log(`${label}（${result.groups[group].length}）`);
        for (const item of result.groups[group])
          console.log(
            `  ${item.task.ref} ${item.task.title}${item.waiting_for.length ? ` · 等 ${item.waiting_for.join("、")}` : ""}${item.reason ? ` · ${item.reason}` : ""}`,
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
  args: "tN [--worker 工具+模型[:强度]] [--risk low|medium|high]",
  about: "派给执行者（服务持有进程）；不写 --worker 按额度挑，--risk 缺省 low",
  options: {
    worker: { type: "string" },
    risk: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const body: Record<string, string> = {};
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
    const result = await (
      await client()
    ).post<{ task: Task & { events: TaskEventRow[] }; queued: boolean }>(
      `/tasks/${id}/run`,
      body,
    );
    const { task } = result;
    if (json) printJson(result);
    else if (result.queued)
      console.log(`${task.ref} 排队中：${queuedReason(task.events)}`);
    else
      console.log(
        `已派 ${task.ref} 给 ${task.worker}（PID ${task.pid}${task.worktree ? `，工作树 ${task.worktree}，分支 ${task.branch}` : ""}）`,
      );
    recordNext(`等结果：atrium task wait ${task.ref}`);
  },
};

const stop: Command = {
  args: "tN [--as 订阅者]",
  about:
    "停掉执行者（排队中的移出队列）；由此产生的事件不投给发起者本人（缺省 secretary）",
  options: { as: { type: "string" } },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const who = str(values, "as") ?? "secretary";
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
  about: "等任务离开 running（完成、失败、受阻）或超时；缺省 300 秒",
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
          `${task.ref} [${task.status}] ${task.title}`,
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
  "task done": done,
  "task run": run,
  "task stop": stop,
  "task log": log,
  "task wait": wait,
};
