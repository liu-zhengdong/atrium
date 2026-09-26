import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import { TASK_STATUSES, isTaskStatus } from "../server/tasks/state.ts";
import type { Task, TaskEventRow, TaskNode } from "../server/tasks/ledger.ts";
import { recordNext } from "./contract.ts";
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

const line = (task: Task) =>
  [
    task.ref,
    `[${task.status}]`,
    task.title,
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
  args: "标题 [--parent tN] [--role R] [--repo 路径] [--brief 文件]",
  about: "建任务；--parent 挂到父任务下，--brief 附任务详述 md",
  options: {
    parent: { type: "string" },
    role: { type: "string" },
    repo: { type: "string" },
    brief: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [title], values, json }) {
    const parent = str(values, "parent");
    const repo = str(values, "repo");
    const brief = str(values, "brief");
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
    };
    const task = await (await client()).post<Task>("/tasks", body);
    if (json) printJson(task);
    else
      console.log(
        `已建 ${task.ref}：${task.title}${task.parent_ref ? `（父任务 ${task.parent_ref}）` : ""}`,
      );
    recordNext(`拆子任务：atrium task add 标题 --parent ${task.ref}`);
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
      recordNext(`看详情：atrium task show ${result.tasks[0].ref}`);
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
    ).get<Task & { children: number; events: TaskEventRow[] }>(
      `/tasks/${ref(reference, "任务")}`,
    );
    if (json) printJson(task);
    else {
      const rows: [string, string | number | null][] = [
        ["标题", task.title],
        ["状态", task.status],
        ["父任务", task.parent_ref],
        ["子任务", task.children || null],
        ["岗位", task.role],
        ["仓库", task.repo],
        ["详述", task.brief_path],
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
  about: "缩进树：短号、状态、标题、执行者、PR；不写 tN 显示全部顶层任务",
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
  args: "tN --status S",
  about: `人工修正状态（${TASK_STATUSES.filter((s) => s !== "running").join("、")}）；也可改 --title --role --brief`,
  options: {
    status: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    brief: { type: "string" },
  },
  positionals: [1, 1],
  async run({ positionals: [reference], values, json }) {
    const id = ref(reference, "任务");
    const body: Record<string, string> = {};
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
    if (!Object.keys(body).length)
      throw new Problem(
        400,
        "至少给一项：--status、--title、--role 或 --brief",
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

export const taskCommands: Record<string, Command> = {
  "task add": add,
  "task ls": ls,
  "task show": show,
  "task tree": tree,
  "task set": set,
};
