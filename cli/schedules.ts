import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson, when } from "./format.ts";
import { recordNext } from "./contract.ts";

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const api = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;

type Schedule = {
  ref: string;
  node: string;
  node_name: string | null;
  title: string;
  kind: "task" | "patrol" | "research";
  every: string;
  at: string | null;
  by: string | null;
  worker: string | null;
  state: "active" | "paused" | "removed";
  next_at: number | null;
  last_task: { ref: string; status: string } | null;
};
type Detail = Schedule & {
  brief: string | null;
  runs: {
    at: number;
    outcome: "created" | "skipped" | "failed";
    task: string | null;
    note: string | null;
  }[];
};

const kindText = { task: "任务", patrol: "体验巡检", research: "调研" };
const stateText = { active: "", paused: "已暂停", removed: "已删除" };
const outcomeText = { created: "生成", skipped: "跳过", failed: "失败" };

/** 周期的人话：每天、每 7 天、每 12 小时。 */
export function everyWords(every: string, at: string | null) {
  const match = /^(\d+)([mhd])$/.exec(every);
  const unit = { m: "分钟", h: "小时", d: "天" }[match?.[2] ?? "d"]!;
  const n = Number(match?.[1] ?? 0);
  const base = !match
    ? `每 ${every}`
    : n === 1 && unit !== "分钟"
      ? unit === "天"
        ? "每天"
        : "每小时"
      : `每 ${n} ${unit}`;
  return at ? `${base} ${at}` : base;
}

/** 一行：s1 体验巡检 · 每天 09:30 · 命令行（o2）· 下次 09:30 · 上一轮 t12 done */
export function scheduleLine(s: Schedule) {
  return [
    `${s.ref} ${s.title}`,
    everyWords(s.every, s.at),
    s.kind === "task" || s.title === kindText[s.kind] ? "" : kindText[s.kind],
    `${s.node_name ?? s.node}（${s.node}）`,
    s.state === "active" && s.next_at !== null
      ? `下次 ${when(s.next_at)}`
      : stateText[s.state],
    s.last_task ? `上一轮 ${s.last_task.ref} ${s.last_task.status}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function detailText(s: Detail) {
  return [
    scheduleLine(s),
    ...(s.by ? [`专员：${s.by}`] : []),
    ...(s.worker ? [`执行者：${s.worker}`] : []),
    ...(s.brief ? ["详述：", s.brief.trimEnd()] : []),
    s.runs.length ? "最近几轮：" : "还没有跑过",
    ...s.runs.map(
      (run) =>
        `  ${when(run.at)} ${outcomeText[run.outcome]}${run.task ? ` ${run.task}` : ""}${run.note ? ` · ${run.note}` : ""}`,
    ),
  ].join("\n");
}

const output = (json: boolean, result: unknown, line: string, next: string) => {
  if (json) printJson(result);
  else console.log(line);
  recordNext(next);
};

function file(value: string) {
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Problem(400, `--brief 指向的文件不存在：${path}`, "usage");
  return path;
}

const one = (verb: string, about: string, done: string): Command => ({
  args: "sN",
  about,
  positionals: [1, 1],
  async run({ positionals: [ref], json }) {
    const client = await api();
    const path = `/schedules/${enc(ref!)}${verb === "rm" ? "" : `/${verb}`}`;
    const result =
      verb === "rm"
        ? await client.delete<Detail>(path)
        : await client.post<Detail>(path, {});
    output(
      json,
      result,
      `${result.ref} ${done}：${scheduleLine(result)}`,
      verb === "pause"
        ? `恢复：atrium schedule resume ${result.ref}`
        : `看周期任务：atrium schedule show ${result.ref}`,
    );
  },
});

export const scheduleCommands: Record<string, Command> = {
  "schedule add": {
    args: "节点 [标题] --every 7d|1d|12h [--at 09:00] [--kind task|patrol|research] [--brief 文件|-] [--by 专员] [--worker 工具+模型[:强度]]",
    about:
      "周期任务：到点在节点下生成一件普通任务并派发（闲时/普通按节点缺省）；上一轮没结束就跳过本轮并记一笔，服务停机错过的只补一轮；--at 本机钟点（只用于整天的周期）；--kind patrol 生成与 patrol run 同样的体验巡检（标题可省），research 只调研不交 PR",
    options: {
      every: { type: "string" },
      at: { type: "string" },
      kind: { type: "string" },
      brief: { type: "string" },
      by: { type: "string" },
      worker: { type: "string" },
    },
    positionals: [1, 2],
    async run({ positionals: [node, title], values, json }) {
      if (!str(values, "every"))
        throw new Problem(
          400,
          "--every: 必填，如 7d、1d、12h",
          "usage",
          undefined,
          `atrium schedule add ${node} ${title ?? "标题"} --every 7d`,
        );
      const brief = str(values, "brief");
      const body = {
        node,
        ...(title === undefined ? {} : { title }),
        every: str(values, "every"),
        ...(str(values, "at") ? { at: str(values, "at") } : {}),
        ...(str(values, "kind") ? { kind: str(values, "kind") } : {}),
        ...(str(values, "by") ? { by: str(values, "by") } : {}),
        ...(str(values, "worker") ? { worker: str(values, "worker") } : {}),
        ...(brief === undefined
          ? {}
          : await (await import("./brief-input.ts")).briefInput(brief, file)),
      };
      const result = await (await api()).post<Detail>("/schedules", body);
      output(
        json,
        result,
        `已建 ${scheduleLine(result)}`,
        `马上跑一轮：atrium schedule run ${result.ref}`,
      );
    },
  },
  "schedule ls": {
    args: "[--node 节点] [--all] [--after sN]",
    about:
      "列周期任务：--node 只看该节点及下层，--all 连已删除的一起列；每页至多 200 条",
    options: {
      node: { type: "string" },
      all: { type: "boolean" },
      after: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      if (str(values, "node")) query.set("node", str(values, "node")!);
      if (values.all === true) query.set("all", "1");
      if (str(values, "after")) query.set("after", str(values, "after")!);
      const result = await (
        await api()
      ).get<{ schedules: Schedule[]; next_after: string | null }>(
        `/schedules${query.size ? `?${query}` : ""}`,
      );
      output(
        json,
        result,
        [
          ...(result.schedules.length
            ? result.schedules.map(scheduleLine)
            : ["还没有周期任务"]),
          ...(result.next_after
            ? [`还有更多：atrium schedule ls --after ${result.next_after}`]
            : []),
        ].join("\n"),
        result.schedules.length
          ? `看一条：atrium schedule show ${result.schedules[0]!.ref}`
          : "建一条：atrium schedule add 节点 标题 --every 7d",
      );
    },
  },
  "schedule show": {
    args: "sN",
    about: "看周期任务：节奏、下次时间、详述与最近几轮（生成、跳过、失败）",
    positionals: [1, 1],
    async run({ positionals: [ref], json }) {
      const result = await (await api()).get<Detail>(`/schedules/${enc(ref!)}`);
      output(
        json,
        result,
        detailText(result),
        result.last_task
          ? `看上一轮：atrium task show ${result.last_task.ref}`
          : `马上跑一轮：atrium schedule run ${result.ref}`,
      );
    },
  },
  "schedule run": {
    args: "sN",
    about: "马上跑一轮（不改下次时间）；上一轮没结束时不起",
    positionals: [1, 1],
    async run({ positionals: [ref], json }) {
      const result = await (
        await api()
      ).post<{
        schedule: string;
        task: { ref: string; title: string };
        scenario?: string;
        queued?: boolean;
      }>(`/schedules/${enc(ref!)}/run`, {});
      output(
        json,
        result,
        `${result.schedule} 已生成 ${result.task.ref}：${result.task.title}${result.queued ? "（排队中）" : ""}`,
        `等结果：atrium task wait ${result.task.ref}`,
      );
    },
  },
  "schedule pause": one("pause", "暂停周期任务：到点不再生成", "已暂停"),
  "schedule resume": one(
    "resume",
    "恢复周期任务：暂停期间的轮次不补，从下一个到点开始",
    "已恢复",
  ),
  "schedule rm": one(
    "rm",
    "删除周期任务：不再生成，已生成的任务照常；sN 不复用",
    "已删除",
  ),
};
