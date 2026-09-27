import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const api = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;
const statusText: Record<string, string> = {
  new: "待处理",
  task: "已开任务",
  merged: "并入任务",
  ignored: "已忽略",
};
const output = (json: boolean, result: unknown, line: string, next: string) => {
  if (json) printJson(result);
  else console.log(line);
  recordNext(next);
};
const required = (values: Values, key: string) => {
  const value = str(values, key);
  if (!value?.trim()) throw new Problem(400, `--${key}: 必填`, "usage");
  return value;
};

export const patrolCommands: Record<string, Command> = {
  "patrol run": {
    args: "节点 [--worker 工具+模型[:强度]]",
    about: "手动巡检节点：从 uses 轮换一条场景，在当前真实环境启动体验巡检任务",
    options: { worker: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const result = await (
        await api()
      ).post<{ task: { ref: string }; scenario: string; queued: boolean }>(
        `/patrol/nodes/${enc(node!)}/run`,
        { ...(str(values, "worker") ? { worker: str(values, "worker") } : {}) },
      );
      output(
        json,
        result,
        `${result.task.ref} 巡检已${result.queued ? "排队" : "启动"}：${result.scenario}`,
        `等巡检：atrium task wait ${result.task.ref}`,
      );
    },
  },
  "patrol report": {
    args: "巡检任务 --phenomenon 现象 --step 步骤 --command 命令 --expected 预期 --actual 实际 --kind broken|awkward",
    about: "记录巡检发现；同节点同一现象只记一次，已忽略的现象不再报",
    options: Object.fromEntries(
      ["phenomenon", "step", "command", "expected", "actual", "kind"].map(
        (key) => [key, { type: "string" as const }],
      ),
    ),
    positionals: [1, 1],
    async run({ positionals: [task], values, json }) {
      const body = Object.fromEntries(
        ["phenomenon", "step", "command", "expected", "actual", "kind"].map(
          (key) => [key, required(values, key)],
        ),
      );
      const result = await (
        await api()
      ).post<{ finding: { ref: string }; duplicate: boolean }>(
        `/patrol/tasks/${enc(task!)}/findings`,
        body,
      );
      output(
        json,
        result,
        `${result.finding.ref} ${result.duplicate ? "已有记录，未重复报" : "发现已记录"}`,
        `看巡检任务：atrium task show ${task}`,
      );
    },
  },
  "patrol findings": {
    args: "节点",
    about: "查看节点上的巡检发现与 leader 处理结果",
    positionals: [1, 1],
    async run({ positionals: [node], json }) {
      const rows = await (
        await api()
      ).get<
        {
          ref: string;
          phenomenon: string;
          step: string;
          command: string;
          expected: string;
          actual: string;
          kind: "broken" | "awkward";
          status: string;
          linked_task: string | null;
          reason: string | null;
        }[]
      >(`/patrol/nodes/${enc(node!)}/findings`);
      output(
        json,
        rows,
        rows.length
          ? rows
              .map(
                (f) =>
                  `${f.ref} ${f.phenomenon}（${f.kind === "broken" ? "坏了" : "不顺手"}）· ${statusText[f.status] ?? f.status}${f.linked_task ? ` ${f.linked_task}` : ""}${f.reason ? ` · ${f.reason}` : ""}\n  步骤：${f.step}\n  命令：${f.command}\n  预期：${f.expected}\n  实际：${f.actual}`,
              )
              .join("\n\n")
          : "还没有巡检发现",
        `看全景：atrium map ${node} --json`,
      );
    },
  },
  "patrol decide": {
    args: "发现 (--task tN | --merge tN | --ignore 原因)",
    about: "leader 处理发现：开任务后关联、并入已有任务，或忽略并写原因",
    options: {
      task: { type: "string" },
      merge: { type: "string" },
      ignore: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [finding], values, json }) {
      const choices = [
        str(values, "task"),
        str(values, "merge"),
        str(values, "ignore"),
      ].filter(Boolean);
      if (choices.length !== 1)
        throw new Problem(
          400,
          "--task、--merge、--ignore 必须且只能给一个",
          "usage",
        );
      const body = str(values, "task")
        ? { action: "task", task: str(values, "task") }
        : str(values, "merge")
          ? { action: "merged", task: str(values, "merge") }
          : { action: "ignored", reason: str(values, "ignore") };
      const result = await (
        await api()
      ).post<{ ref: string; status: string; node: string }>(
        `/patrol/findings/${enc(finding!)}/decide`,
        body,
      );
      output(
        json,
        result,
        `${result.ref} 已处理：${statusText[result.status] ?? result.status}`,
        `看处理结果：atrium patrol findings ${result.node}`,
      );
    },
  },
};
