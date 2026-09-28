import { resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";
import type { Overview } from "../server/org/overview.ts";
import { limitText, type Limits } from "../server/org/limits.ts";
import {
  formatOverview,
  isBlank,
  pointLines,
  titleOf,
} from "./org-overview.ts";
import type { Point } from "../server/org/points.ts";
import type { LeaderBrief } from "../server/leaders/model.ts";
import { wakeText } from "./leaders.ts";
import { defaultActor } from "./worker-guard.ts";

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const path = (value: string) => encodeURIComponent(value);
const as = (values: Values) => {
  const who = str(values, "as") ?? defaultActor();
  return who ? `?as=${path(who)}` : "";
};
const options = { as: { type: "string" as const } };
const person = (value: string | null) =>
  value === "u1" ? "你" : value === "secretary" ? "秘书" : (value ?? "无");
export function formatOrgChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
): string {
  const value = (key: string, item: unknown) =>
    key === "leader" && item === "u1"
      ? "你"
      : item == null || item === ""
        ? "（空）"
        : typeof item === "string"
          ? item
          : JSON.stringify(item);
  const lines: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key === "doc_path") continue;
    lines.push(
      `${key}：${value(key, change.before)}→ ${value(key, change.after)}`,
    );
  }
  return lines.join("\n") || "无字段变化";
}
type TaskCounts = {
  todo: number;
  running: number;
  blocked: number;
  reviewing?: number;
  merge_queued?: number;
  merging?: number;
};
/** org tree 的任务计数；为零的项省略。 */
export function formatCounts(own: TaskCounts, sent: TaskCounts): string {
  const parts = [
    own.running ? `在做 ${own.running}` : "",
    own.reviewing ? `审阅中 ${own.reviewing}` : "",
    own.merge_queued ? `排队合入 ${own.merge_queued}` : "",
    own.merging ? `合入中 ${own.merging}` : "",
    own.blocked ? `卡住 ${own.blocked}` : "",
    own.todo ? `待办 ${own.todo}` : "",
  ];
  const out =
    sent.running +
    sent.blocked +
    sent.todo +
    (sent.reviewing ?? 0) +
    (sent.merge_queued ?? 0) +
    (sent.merging ?? 0);
  if (out)
    parts.push(`投出 ${out}${sent.running ? `（在做 ${sent.running}）` : ""}`);
  return parts
    .filter(Boolean)
    .map((p) => ` · ${p}`)
    .join("");
}
const KIND_LABEL: Record<string, string> = {
  org: "组织",
  project: "项目",
  module: "模块",
  concern: "关注点",
};
const reason = (values: Values) => {
  const result = str(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason 不能为空");
  return result;
};
const out = (json: boolean, value: unknown, text: string, next: string) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`动作：${next}`);
};
export const orgCommands: Record<string, Command> = {
  "org tree": {
    args: "",
    about: "查看组织树",
    options,
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (
        await client()
      ).get<
        Array<{
          id: number;
          parent_id: number | null;
          ref: string;
          kind: string;
          name: string;
          leader: string | null;
          archived_at: number | null;
          tasks: TaskCounts;
          sent: TaskCounts;
          leader_state?: LeaderBrief;
        }>
      >(`/org/tree${as(values)}`);
      const labels: Record<string, string> = {
        org: "组织",
        project: "项目",
        module: "模块",
        concern: "关注点",
      };
      const depth = (row: (typeof rows)[number]): number =>
        row.parent_id === null
          ? 0
          : 1 + depth(rows.find((n) => n.id === row.parent_id)!);
      out(
        json,
        rows,
        rows
          .map(
            (n) =>
              `${"  ".repeat(depth(n))}${n.ref} [${labels[n.kind]}] ${n.name}${n.leader ? ` · leader ${person(n.leader)}${n.leader_state ? `（${n.leader_state.name}，${wakeText(n.leader_state.wake)}）` : ""}` : ""}${formatCounts(n.tasks, n.sent)}${n.archived_at ? " · 已归档" : ""}`,
          )
          .join("\n") || "组织树为空",
        rows.length
          ? "atrium org show o1"
          : "atrium org add 父节点 slug --kind org",
      );
    },
  },
  "org show": {
    args: "节点 [--detail]",
    about:
      "看一部分：先讲人话（是什么、能做什么、怎么走完、由哪几部分组成、要点、现状与阶段）；--detail 另列仓库、上级的要点与手上的任务；根节点另给两项配置（给你留的额度、花费上限）",
    options: { ...options, detail: { type: "boolean" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const node = await (
        await client()
      ).get<{
        ref: string;
        name: string;
        kind: string;
        path: string;
        leader: string | null;
        repos: string[];
        overview: Overview;
        points: Point[];
        points_chain: { node: string; name: string; points: Point[] }[];
        limits?: Limits;
        recent_tasks: {
          ref: string;
          title: string;
          status: string;
          delivery_stage?: string | null;
          worker: string | null;
          origin_ref: string | null;
        }[];
      }>(`/org/nodes/${path(id!)}${as(values)}`);
      const detail = values.detail === true;
      const lines = [
        titleOf(node, node.overview),
        `[${KIND_LABEL[node.kind] ?? node.kind}] ${node.path} · leader ${person(node.leader)}`,
        ...(node.limits
          ? [
              `配置：${limitText(node.limits) || "未设（给你留的额度缺省 20%）"}`,
            ]
          : []),
        ...formatOverview(node, node.overview, detail, node.points),
        ...(detail
          ? [
              "—— 细节 ——",
              `仓库：${node.repos.join("、") || "无"}`,
              ...node.points_chain
                .filter((level) => level.node !== node.ref)
                .flatMap((level) =>
                  pointLines(level.points).map((line, i) =>
                    i === 0
                      ? `上级 ${level.node} ${level.name} 的${line}`
                      : line,
                  ),
                ),
              ...(node.recent_tasks.length
                ? [
                    `手上的任务（最近 ${node.recent_tasks.length} 条）`,
                    ...node.recent_tasks.map(
                      (t) =>
                        `  ${t.ref} [${t.delivery_stage === "reviewing" ? "审阅中" : t.delivery_stage === "merge_queued" ? "排队合入" : t.delivery_stage === "merging" ? "合入中" : t.delivery_stage === "merged" ? "已合入" : t.delivery_stage === "online" ? "已上线" : t.status}] ${t.title}${t.worker ? ` · ${t.worker}` : ""}${t.origin_ref ? ` · ${t.origin_ref} 投来` : ""}`,
                    ),
                  ]
                : []),
            ]
          : [
              `细节已折叠（仓库、上级的要点、手上的任务）：atrium org show ${node.ref} --detail`,
            ]),
      ];
      out(
        json,
        node,
        lines.join("\n"),
        isBlank(node.overview)
          ? `atrium map edit ${node.ref} --what 一句话`
          : `atrium org point-add ${node.ref} 要点 --why 为什么 --by 谁定的`,
      );
    },
  },
  "org add": {
    args: "父节点 slug [--kind 类型] [--name 名称] [--reason 原因] [--repo 路径] [--leader u1|aN]",
    about: "添加组织节点",
    options: {
      ...options,
      kind: { type: "string" },
      name: { type: "string" },
      repo: { type: "string", multiple: true },
      leader: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [2, 2],
    async run({ positionals: [parent, slug], values, json }) {
      const repos =
        values.repo === undefined
          ? []
          : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
              (v) => resolve(String(v)),
            );
      const result = await (
        await client()
      ).post<{ id: number; name: string; kind: string }>(
        `/org/nodes${as(values)}`,
        {
          parent,
          slug,
          kind: str(values, "kind"),
          name: str(values, "name") ?? slug,
          leader: str(values, "leader"),
          repos,
          reason: reason(values),
        },
      );
      out(
        json,
        result,
        `已新建 o${result.id} [${result.kind}] ${result.name}`,
        `atrium map edit o${result.id} --what 一句话`,
      );
    },
  },
  "org edit": {
    args: "节点 [--name 名称] [--slug 路径名] [--leader aN|none] [--parent 节点] [--repo 路径] [--archive] [--rev rN] [--reason 原因]",
    about: "编辑节点（名称、路径名、leader、上级、仓库、归档），留节点修订",
    options: {
      ...options,
      slug: { type: "string" },
      name: { type: "string" },
      leader: { type: "string" },
      parent: { type: "string" },
      repo: { type: "string", multiple: true },
      archive: { type: "boolean" },
      rev: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const input: Record<string, unknown> = {
        reason: reason(values),
        rev: str(values, "rev"),
        slug: str(values, "slug"),
        name: str(values, "name"),
        leader: str(values, "leader"),
        parent: str(values, "parent"),
        repos:
          values.repo === undefined
            ? undefined
            : (Array.isArray(values.repo) ? values.repo : [values.repo]).map(
                (repo) => resolve(String(repo)),
              ),
        archive: values.archive === true,
      };
      if (
        !input.slug &&
        !input.name &&
        !input.leader &&
        !input.parent &&
        !input.repos &&
        !input.archive
      )
        throw new Problem(400, "org edit 需指定要修改的字段");
      const result = await (
        await client()
      ).patch<{ rev: string }>(`/org/nodes/${path(id!)}${as(values)}`, input);
      out(
        json,
        result,
        `已更新 ${id} 节点 → ${result.rev}`,
        `atrium org history ${id}`,
      );
    },
  },
  "org limits": {
    args: "[--quota-reserve 百分比] [--money-max 元]",
    about:
      "看或改根节点的两项配置：每个订阅账号给你留的额度（缺省 20%）、花费上限（元）；只有你能改。规矩不写在这里，写成要点",
    options: {
      "quota-reserve": { type: "string" },
      "money-max": { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const body: Record<string, number> = {};
      if (str(values, "quota-reserve") !== undefined)
        body.quota_reserve_percent = Number(str(values, "quota-reserve"));
      if (str(values, "money-max") !== undefined)
        body.money_yuan_max = Number(str(values, "money-max"));
      const api = await client();
      const result = Object.keys(body).length
        ? await api.put<Limits>("/org/limits", body)
        : await api.get<Limits>("/org/limits");
      out(
        json,
        result,
        limitText(result) || "未设（给你留的额度缺省 20%，花费上限未写）",
        "atrium org limits --quota-reserve 20 --money-max 0",
      );
    },
  },
  "org point-add": {
    args: "节点 要点 --why 为什么 --by 谁定的 [--check 检查] [--pos N] [--as aN]",
    about:
      "给一部分加一条要点（规矩只写这里：用户的原则、口味、取舍与这一块必须守住的约束）：人话一句、为什么、谁定的（如 u1 09-27），可选守护它的检查（测试文件与用例名，或 $ 命令）；按树往下继承，跨几块的放共同上级；--pos 排在第几条（1 最重要，冲突时靠前的优先），不写排最后；不留修订记录",
    options: {
      ...options,
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      pos: { type: "string" },
    },
    positionals: [2, 2],
    async run({ positionals: [id, text], values, json }) {
      const result = await (
        await client()
      ).post<Point>(`/org/nodes/${path(id!)}/points${as(values)}`, {
        text,
        ...(str(values, "why") === undefined
          ? {}
          : { why: str(values, "why") }),
        ...(str(values, "by") === undefined ? {} : { by: str(values, "by") }),
        ...(str(values, "check") === undefined
          ? {}
          : { check: str(values, "check") }),
        ...(str(values, "pos") === undefined
          ? {}
          : { pos: str(values, "pos") }),
      });
      out(
        json,
        result,
        `已加 ${result.ref}（${result.node}）：${result.text}`,
        `atrium org show ${result.node}`,
      );
    },
  },
  "org point-edit": {
    args: "kN [--text 要点] [--why 为什么] [--by 谁定的] [--check 检查|''] [--pos N] [--as aN]",
    about:
      "改一条要点；--check '' 去掉检查；--pos 挪到本部分第几条（1 最重要，冲突时靠前的优先）",
    options: {
      ...options,
      text: { type: "string" },
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
      pos: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body: Record<string, string> = {};
      for (const key of ["text", "why", "by", "check", "pos"])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "至少改一项：--text、--why、--by、--check、--pos",
          "usage",
        );
      const result = await (
        await client()
      ).patch<Point>(`/org/points/${path(id!)}${as(values)}`, body);
      out(
        json,
        result,
        `已改 ${result.ref}（${result.node}）：${result.text}`,
        `atrium org show ${result.node}`,
      );
    },
  },
  "org point-rm": {
    args: "kN [--as aN]",
    about: "删掉一条过时的要点（不留修订记录）",
    options,
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (
        await client()
      ).delete<Point>(`/org/points/${path(id!)}${as(values)}`);
      out(
        json,
        result,
        `已删 ${result.ref}（${result.node}）：${result.text}`,
        `atrium org show ${result.node}`,
      );
    },
  },
  "org history": {
    args: "节点 [--rev rN] [--before rN] [--after rN] [--limit N]",
    about:
      "查看节点的修订历史（名称、路径名、leader、上级、仓库、归档）与字段差异",
    options: {
      ...options,
      rev: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const query = new URLSearchParams();
      for (const key of ["as", "rev", "before", "after", "limit"])
        if (str(values, key)) query.set(key, str(values, key)!);
      const result = await (
        await client()
      ).get<{
        items?: {
          rev: number;
          target: string;
          author: string;
          reason: string;
          at: number;
        }[];
        revision?: unknown;
        changes?: Record<
          string,
          { before: unknown; after: unknown; diff?: string }
        >;
        has_more?: boolean;
      }>(`/org/nodes/${path(id!)}/history?${query}`);
      if (result.revision) {
        out(
          json,
          result,
          `${id} 修订详情\n${formatOrgChanges(result.changes ?? {})}`,
          `atrium org history ${id}`,
        );
        return;
      }
      out(
        json,
        result,
        `${id} 的修订（新→旧）\n${result.items?.map((r) => `r${r.rev} ${new Date(r.at).toLocaleString("zh-CN")} ${person(r.author)} —— ${r.reason}`).join("\n") ?? ""}`,
        `atrium org show ${id}`,
      );
    },
  },
};
