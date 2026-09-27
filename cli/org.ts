import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";
import type { Doc } from "../server/org/model.ts";
import { formatParam, type Param } from "../server/org/boundaries.ts";
import { OVERVIEW_KEYS, type Overview } from "../server/org/overview.ts";
import {
  formatOverview,
  isBlank,
  pointLines,
  titleOf,
} from "./org-overview.ts";
import type { Point } from "../server/org/points.ts";

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const path = (value: string) => encodeURIComponent(value);
const as = (values: Values) =>
  str(values, "as") ? `?as=${path(str(values, "as")!)}` : "";
const options = { as: { type: "string" as const } };
const person = (value: string | null) =>
  value === "u1" ? "你" : (value ?? "无");
export function formatOrgChanges(
  changes: Record<string, { before: unknown; after: unknown; diff?: string }>,
): string {
  const boundary = (item: {
    summary?: string;
    param?: Record<string, number>;
  }) =>
    [
      item.summary ?? "（文字沿用上层）",
      ...Object.entries(item.param ?? {}).map(([k, v]) => `${k}=${v}`),
    ].join(" ");
  const value = (key: string, item: unknown) =>
    key.startsWith("boundaries.") && item && typeof item === "object"
      ? boundary(item)
      : key === "leader" && item === "u1"
        ? "你"
        : item == null || item === ""
          ? "（空）"
          : typeof item === "string"
            ? item
            : JSON.stringify(item);
  const lines: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key === "doc_path") continue;
    if (key === "body") {
      const diff = (change.diff ?? "").split("\n");
      lines.push(
        "正文：",
        ...diff
          .slice(0, 80)
          .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line)),
      );
      if (diff.length > 80) lines.push(`…省略 ${diff.length - 80} 行`);
    } else
      lines.push(
        `${key.replace(/^fields\./, "")}：${value(key, change.before)}→ ${value(key, change.after)}`,
      );
  }
  return lines.join("\n") || "无字段变化";
}
type BoundaryView = {
  chars: number;
  inherited: number;
  added: number;
  items: {
    id: string;
    summary: string;
    param: Param | null;
    from: string;
    from_name: string;
    set_by: string;
    set_by_name: string;
  }[];
  own: {
    id: string;
    param: Param | null;
    shadowed_by?: string;
    shadowed_by_name?: string;
  }[];
};
/** org show 的硬边界段：生效条目按根→叶，参数显示最严值与出处。 */
export function formatBoundaries(view: BoundaryView): string[] {
  if (!view.items.length) return ["硬边界：无"];
  const width = Math.max(...view.items.map((e) => e.id.length));
  const lines = [
    `硬边界（继承 ${view.inherited} + 本节点 ${view.added}，summary 合计 ${view.chars}/1200 字）`,
    ...view.items.map((e) => {
      const param = e.param
        ? `：${formatParam(e.param)}${e.set_by !== e.from ? `（${e.set_by} ${e.set_by_name} 收紧）` : ""}`
        : "";
      return `  ${e.id.padEnd(width)}  ${e.summary}${param} · ${e.from} ${e.from_name}`;
    }),
  ];
  for (const own of view.own)
    if (own.shadowed_by && own.param) {
      const live = view.items.find((e) => e.id === own.id)!;
      lines.push(
        `  本节点 ${own.id} 写的${formatParam(own.param)} 已被上层覆盖：${own.shadowed_by} ${own.shadowed_by_name} 要求${formatParam(live.param!)}`,
      );
    }
  return lines;
}
type TaskCounts = { todo: number; running: number; blocked: number };
type BudgetView = {
  own: Record<string, unknown>;
  quota: {
    scope: string;
    amount?: number;
    used?: number | null;
    shared: boolean;
    relevant: boolean;
  }[];
  disk: { amount?: number; shared: boolean };
  money: { amount?: number; shared: boolean };
};
export function formatBudget(view: BudgetView, detail = false): string {
  const quota = view.quota.filter((q) =>
    detail ? q.amount !== undefined : !q.shared || q.relevant,
  );
  const parts = quota.map(
    (q) =>
      `${q.scope} ${q.shared ? "共享池" : "份额"} ${q.amount}${q.used === null || q.used === undefined ? "（额度数据不可用）" : `（约用 ${q.used}）`}`,
  );
  if (detail && !parts.length) parts.push("共享池（暂无额度数据）");
  const disk =
    view.disk.amount === undefined
      ? detail
        ? "磁盘共享池（动态）"
        : ""
      : !detail && view.disk.shared
        ? ""
        : `磁盘 ${view.disk.shared ? "共享池" : "份额"} ${view.disk.amount} GB`;
  const money =
    !detail && view.money.shared
      ? ""
      : `钱 ${view.money.shared ? "共享池" : "份额"} ${view.money.amount ?? 0} 元`;
  return [parts.length ? `额度 ${parts.join("、")}` : "", disk, money]
    .filter(Boolean)
    .join(" · ");
}
/** org tree 的任务计数；为零的项省略。 */
export function formatCounts(own: TaskCounts, sent: TaskCounts): string {
  const parts = [
    own.running ? `在做 ${own.running}` : "",
    own.blocked ? `卡住 ${own.blocked}` : "",
    own.todo ? `待办 ${own.todo}` : "",
  ];
  const out = sent.running + sent.blocked + sent.todo;
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
const FIELD_LABELS: Record<string, string> = {
  goal: "目标",
  report: "汇报",
  escalate: "找上层",
  owns: "负责",
  accepts: "能接",
  status: "现状",
  commitments: "承诺",
  asks: "要上面定",
};
/** 章程／能力卡：逐个字段一行，空字段省略；什么都没写时只标「未填写」。 */
export function formatDoc(
  label: string,
  doc: { rev: string; fields: Record<string, unknown>; body: string } | null,
): string[] {
  const value = (item: unknown): string =>
    Array.isArray(item)
      ? item
          .map((entry) =>
            entry && typeof entry === "object"
              ? (() => {
                  const c = entry as {
                    id?: string;
                    text?: string;
                    due?: string;
                  };
                  return `${c.id ? `${c.id} ` : ""}${c.text ?? ""}${c.due ? `（${c.due}）` : ""}`;
                })()
              : String(entry),
          )
          .join("、")
      : String(item ?? "");
  const lines = Object.entries(doc?.fields ?? {})
    .map(([key, item]) => [FIELD_LABELS[key] ?? key, value(item).trim()])
    .filter(([, text]) => text)
    .map(([key, text]) => `  ${key}：${text}`);
  const body = doc?.body.trim() ?? "";
  if (!lines.length && !body) return [`${label} ${doc?.rev ?? "r0"}：未填写`];
  return [`${label} ${doc?.rev ?? "r0"}`, ...lines, ...(body ? [body] : [])];
}
const reason = (values: Values) => {
  const result = str(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason 不能为空");
  return result;
};
const doc = (values: Values): Doc | undefined =>
  values.charter !== undefined
    ? "charter"
    : values.card !== undefined
      ? "card"
      : undefined;
const file = (values: Values, key: "charter" | "card") => {
  const name = str(values, key);
  if (!name) throw new Problem(400, `--${key} 应指定文件`);
  try {
    return readFileSync(resolve(name), "utf8");
  } catch {
    throw new Problem(400, `--${key} 文件无法读取：${name}`);
  }
};
const common = {
  ...options,
  charter: { type: "string" as const },
  card: { type: "string" as const },
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
          budget: BudgetView;
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
              `${"  ".repeat(depth(n))}${n.ref} [${labels[n.kind]}] ${n.name}${n.leader ? ` · leader ${person(n.leader)}` : ""}${formatCounts(n.tasks, n.sent)}${formatBudget(n.budget) ? ` · ${formatBudget(n.budget)}` : ""}${n.archived_at ? " · 已归档" : ""}`,
          )
          .join("\n") +
          (rows.length ? "\n额度用量为估算；账号总览看 atrium quota" : "") ||
          "组织树为空",
        rows.length ? "atrium org show o1" : "atrium org import",
      );
    },
  },
  "org show": {
    args: "节点 [--detail] [--charter|--card --raw]",
    about:
      "看节点：先讲人话（是什么、能做什么、怎么走完、由哪几部分组成、现状与阶段），--detail 展开章程正文、硬边界、预算、能力卡等技术细节",
    options: {
      ...options,
      detail: { type: "boolean" },
      charter: { type: "boolean" },
      card: { type: "boolean" },
      raw: { type: "boolean" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const target = doc(values);
      if (values.raw && !target)
        throw new Problem(400, "--raw 需同时指定 --charter 或 --card");
      const query = new URLSearchParams();
      if (str(values, "as")) query.set("as", str(values, "as")!);
      if (values.raw && target) query.set("raw", target);
      const result = await (
        await client()
      ).get<Record<string, unknown>>(`/org/nodes/${path(id!)}?${query}`);
      if (values.raw && target) {
        if (json) printJson(result);
        else process.stdout.write(result.raw as string);
        return;
      }
      const node = result as {
        ref: string;
        name: string;
        kind: string;
        path: string;
        leader: string | null;
        repos: string[];
        overview: Overview;
        points: Point[];
        points_chain: { node: string; name: string; points: Point[] }[];
        charter: {
          rev: string;
          fields: Record<string, unknown>;
          body: string;
        } | null;
        card: {
          rev: string;
          fields: Record<string, unknown>;
          body: string;
        } | null;
        chain: { name: string; goal: string }[];
        boundaries: BoundaryView;
        budget: BudgetView;
        recent_tasks: {
          ref: string;
          title: string;
          status: string;
          worker: string | null;
          origin_ref: string | null;
        }[];
      };
      const detail = values.detail === true;
      const technical = node.charter && {
        ...node.charter,
        fields: Object.fromEntries(
          Object.entries(node.charter.fields).filter(
            ([key]) => !OVERVIEW_KEYS.has(key),
          ),
        ),
      };
      const lines = [
        titleOf(node, node.overview),
        `[${KIND_LABEL[node.kind] ?? node.kind}] ${node.path} · leader ${person(node.leader)}`,
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
              ...(node.chain.length
                ? [
                    "目标链",
                    ...node.chain.map(
                      (c) =>
                        `  ${c.name}：${c.goal.split("\n").join("\n    ")}`,
                    ),
                  ]
                : ["目标链：无"]),
              ...formatBoundaries(node.boundaries),
              `预算：${formatBudget(node.budget, true)}`,
              ...formatDoc("章程", technical),
              ...formatDoc("能力卡", node.card),
              ...(node.recent_tasks.length
                ? [
                    `手上的任务（最近 ${node.recent_tasks.length} 条）`,
                    ...node.recent_tasks.map(
                      (t) =>
                        `  ${t.ref} [${t.status}] ${t.title}${t.worker ? ` · ${t.worker}` : ""}${t.origin_ref ? ` · ${t.origin_ref} 投来` : ""}`,
                    ),
                  ]
                : []),
            ]
          : [
              `细节已折叠（章程正文、硬边界、预算、能力卡、手上的任务）：atrium org show ${node.ref} --detail`,
            ]),
      ];
      out(
        json,
        result,
        lines.join("\n"),
        isBlank(node.overview)
          ? `atrium org show ${node.ref} --charter --raw`
          : detail
            ? `atrium org history ${node.ref}`
            : `atrium org show ${node.ref} --detail`,
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
        `已新建 o${result.id} [${result.kind}] ${result.name}，章程与能力卡为空（r0）`,
        `atrium org edit o${result.id} --charter 章程.md --reason 原因`,
      );
    },
  },
  "org edit": {
    args: "节点 [--charter 文件|--card 文件|--name 名称] [--slug 路径名] [--leader aN|none] [--parent 节点] [--repo 路径] [--archive] [--rev rN] [--reason 原因]",
    about: "编辑节点、章程或能力卡",
    options: {
      ...common,
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
      const target = doc(values);
      if (values.charter !== undefined && values.card !== undefined)
        throw new Problem(400, "--charter 与 --card 只能选一个");
      const input: Record<string, unknown> = {
        reason: reason(values),
        rev: str(values, "rev"),
      };
      let result: unknown;
      if (target) {
        if (
          ["slug", "name", "leader", "parent", "repo"].some(
            (key) => values[key] !== undefined,
          ) ||
          values.archive === true
        )
          throw new Problem(400, "--charter/--card 不能与节点字段同时修改");
        input.source = file(values, target);
        result = await (
          await client()
        ).put(`/org/nodes/${path(id!)}/docs/${target}${as(values)}`, input);
      } else {
        Object.assign(input, {
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
        });
        if (
          !input.slug &&
          !input.name &&
          !input.leader &&
          !input.parent &&
          !input.repos &&
          !input.archive
        )
          throw new Problem(400, "org edit 需指定要修改的字段");
        result = await (
          await client()
        ).patch(`/org/nodes/${path(id!)}${as(values)}`, input);
      }
      const value = result as {
        rev: string;
        before?: string;
        converted?: { node: string; id: string }[];
      };
      out(
        json,
        result,
        [
          `已更新 ${id} ${target ?? "节点"} ${value.before ?? ""} → ${value.rev}`,
          ...(value.converted ?? []).map(
            (c) => `${c.node} 的 ${c.id} 不再覆盖上层，转为该节点自有条目`,
          ),
        ].join("\n"),
        `atrium org history ${id}`,
      );
    },
  },
  "org point-add": {
    args: "节点 要点 --why 为什么 --by 谁定的 [--check 检查] [--as aN]",
    about:
      "给节点加一条要点（这一块必须守住的设计约束）：人话一句、为什么、谁定的（如 u1 09-27），可选守护它的检查（测试文件与用例名，或 $ 命令）；不留修订记录",
    options: {
      ...options,
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
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
    args: "kN [--text 要点] [--why 为什么] [--by 谁定的] [--check 检查|''] [--as aN]",
    about: "改一条要点；--check '' 去掉检查",
    options: {
      ...options,
      text: { type: "string" },
      why: { type: "string" },
      by: { type: "string" },
      check: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body: Record<string, string> = {};
      for (const key of ["text", "why", "by", "check"])
        if (str(values, key) !== undefined) body[key] = str(values, key)!;
      if (!Object.keys(body).length)
        throw new Problem(
          400,
          "至少改一项：--text、--why、--by、--check",
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
    args: "节点 [--target node|charter|card] [--rev rN] [--before rN] [--after rN] [--limit N]",
    about: "查看修订历史与字段差异",
    options: {
      ...options,
      target: { type: "string" },
      rev: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const query = new URLSearchParams();
      for (const key of ["as", "target", "rev", "before", "after", "limit"])
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
        `${id} 的修订（新→旧）\n${result.items?.map((r) => `r${r.rev} ${r.target} ${new Date(r.at).toLocaleString("zh-CN")} ${person(r.author)} —— ${r.reason}`).join("\n") ?? ""}`,
        `atrium org show ${id}`,
      );
    },
  },
  "org revert": {
    args: "节点 [--charter|--card] [--to rN] [--reason 原因]",
    about: "恢复旧内容并追加新修订",
    options: {
      ...options,
      charter: { type: "boolean" },
      card: { type: "boolean" },
      to: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const target = doc(values);
      if (!target) throw new Problem(400, "--charter 或 --card 必填");
      const result = await (
        await client()
      ).post<{ rev: string }>(`/org/nodes/${path(id!)}/revert${as(values)}`, {
        doc: target,
        to: str(values, "to"),
        reason: reason(values),
      });
      out(
        json,
        result,
        `已恢复 ${id} ${target}，新增 ${result.rev}`,
        `atrium org history ${id}`,
      );
    },
  },
  "org link-roles": {
    args: "[--apply]",
    about: "把旧 role 字符串的任务关联到组织节点（默认只预览）",
    options: { ...options, apply: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const apply = values.apply === true;
      const result = await (
        await client()
      ).post<{
        preview: boolean;
        linked: number;
        groups: {
          node: string;
          path: string;
          roles: string[];
          tasks: string[];
        }[];
        unmatched: {
          task: string;
          title: string;
          role: string;
          reason: string;
        }[];
        truncated: boolean;
      }>(`/org/link-roles${as(values)}`, { apply });
      const lines = [
        result.preview
          ? `将关联 ${result.linked} 个任务（预览，未写入）：`
          : `已关联 ${result.linked} 个任务：`,
        ...result.groups.map(
          (g) =>
            `  ${g.roles.join(" / ")} → ${g.node} ${g.path}  ${g.tasks.length} 个（${g.tasks.slice(0, 10).join("、")}${g.tasks.length > 10 ? "…" : ""}）`,
        ),
        ...(result.unmatched.length
          ? [
              `无法对应 ${result.unmatched.length} 个（保留原 role，node_id 留空）：`,
              ...result.unmatched
                .slice(0, 50)
                .map(
                  (u) => `  ${u.task}「${u.title}」role=${u.role}：${u.reason}`,
                ),
              ...(result.unmatched.length > 50
                ? [
                    `  …另有 ${result.unmatched.length - 50} 个，用 --json 看全部`,
                  ]
                : []),
            ]
          : []),
        ...(result.truncated
          ? ["一次最多处理 5000 个；apply 后再跑一次处理其余"]
          : []),
      ];
      if (!result.linked && !result.unmatched.length)
        lines.splice(0, lines.length, "没有待关联的旧 role 任务");
      out(
        json,
        result,
        lines.join("\n"),
        result.preview && result.linked
          ? "atrium org link-roles --apply"
          : "atrium org tree",
      );
    },
  },
  "org migrate-goals": {
    args: "[--apply]",
    about:
      "把目标树（gN）迁为所在节点的阶段记录、任务按目标回填归属部分；默认只预览，--apply 先备份再写入，之后 goal 命令下线",
    options: { ...options, apply: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const result = await (
        await client()
      ).post<MigrationView>(`/goals/migrate${as(values)}`, {
        apply: values.apply === true,
      });
      const pending =
        result.stages > 0 || result.tasks.length > 0 || !result.retired;
      out(
        json,
        result,
        formatMigration(result),
        result.preview && pending
          ? "atrium org migrate-goals --apply"
          : `atrium org show ${result.nodes[0]?.node ?? "o1"}`,
      );
    },
  },
  "org import": {
    args: "[章程文件] [--repo 仓库] [--apply]",
    about: "预览或导入根章程与岗位节点",
    options: {
      ...options,
      repo: { type: "string" },
      apply: { type: "boolean" },
    },
    positionals: [0, 1],
    async run({ positionals, values, json }) {
      const charterPath = resolve(
        positionals[0] ?? join(process.env.HOME ?? "", "Atrium/charter.md"),
      );
      let source: string;
      try {
        source = readFileSync(charterPath, "utf8");
      } catch {
        throw new Problem(400, `章程文件无法读取：${charterPath}`);
      }
      if (Buffer.byteLength(source) > 16 * 1024)
        throw new Problem(400, "body 超过 16 KB");
      const repo = resolve(str(values, "repo") ?? process.cwd());
      const goals = [
        ...source.matchAll(/^\d+\. \*\*(Atrium|OpenQuota)\*\*：([^\n]+)/gm),
      ];
      const section = (heading: string) => {
        const marker = `## ${heading}\n`;
        const start = source.indexOf(marker);
        if (start < 0) return "";
        const rest = source.slice(start + marker.length);
        const end = rest.indexOf("\n## ");
        return (end < 0 ? rest : rest.slice(0, end)).trim();
      };
      const goal =
        (goals.find((m) => m[1] === "Atrium")?.[2] ??
          section("目标").slice(0, 300)) ||
        "成为 AI 组织的运行底座";
      const openquotaGoal =
        goals.find((m) => m[1] === "OpenQuota")?.[2] ??
        "各家订阅额度看得清、查得到，供组织按富余调度。";
      const rootGoal = goals.length
        ? goals.map((m) => `${m[1]}：${m[2]}`).join("\n")
        : section("目标").slice(0, 300);
      const reporting = section("汇报")
        .split("\n")
        .filter((line) => line.startsWith("- "));
      const docs: {
        kind: "module" | "concern";
        slug: string;
        name: string;
        source: string;
        body: string;
      }[] = [];
      for (const [directory, kind] of [
        ["modules", "module"],
        ["concerns", "concern"],
      ] as const) {
        let files: string[] = [];
        try {
          files = readdirSync(join(repo, ".agents", directory));
        } catch {
          /* optional directory */
        }
        for (const name of files.filter((f) => f.endsWith(".md"))) {
          const slug = name.slice(0, -3);
          if (!/^(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}$/.test(slug)) continue;
          const source = `.agents/${directory}/${name}`;
          const filename = join(repo, source);
          let body: string;
          try {
            body = readFileSync(filename, "utf8");
          } catch {
            throw new Problem(400, `岗位文件无法读取：${filename}`);
          }
          if (Buffer.byteLength(body) > 16 * 1024)
            throw new Problem(400, `${filename} 正文超过 16 KB`);
          docs.push({
            kind,
            slug,
            name: slug,
            source,
            body,
          });
        }
      }
      const result = await (
        await client()
      ).post<{ preview: boolean; plan: string[]; created?: number }>(
        `/org/import${as(values)}`,
        {
          charter: {
            fields: {
              goal: rootGoal || goal,
              report: reporting[0]?.slice(2) ?? "每周一份目标层面的进展",
              escalate:
                reporting[1]?.slice(2) ??
                "目标冲突、突破边界或预算、修改章程时找用户",
            },
            body: source,
          },
          atrium_goal: goal,
          openquota_goal: openquotaGoal,
          repo,
          docs,
          apply: values.apply === true,
        },
      );
      out(
        json,
        result,
        result.preview
          ? `导入预览（未写入）：\n${result.plan.join("\n")}`
          : result.created
            ? `已导入 ${result.created} 项：\n${result.plan.join("\n")}`
            : "已是最新",
        result.preview
          ? `atrium org import ${charterPath} --repo ${repo} --apply`
          : "atrium org tree",
      );
    },
  },
};

export type MigrationView = {
  preview: boolean;
  retired: boolean;
  backup?: string | null;
  stages: number;
  nodes: {
    node: string;
    name: string;
    path: string;
    stages: {
      id: string;
      result: string;
      status_label: string;
      criteria: number;
      evidence: number;
    }[];
    kept: string[];
  }[];
  tasks: { task: string; goal: string; part: string; part_name: string }[];
  tasks_kept: {
    task: string;
    goal: string;
    part: string;
    part_name: string;
  }[];
  orphans: { goal: string; node: string }[];
};
/** 迁移回执：按节点列「迁入的阶段」与「已在章程里的」，再列任务的 goal → 归属部分对照。 */
export function formatMigration(view: MigrationView): string {
  const head = view.preview
    ? view.retired
      ? "目标树已迁移过；再迁会补上新出现的（预览，未写入）："
      : "目标树迁为节点阶段记录（预览，未写入）："
    : "已迁移：";
  const lines = [head];
  for (const node of view.nodes) {
    if (!node.stages.length && !node.kept.length) continue;
    lines.push(
      `  ${node.node} ${node.name}（${node.path}）← ${node.stages.length} 条阶段${node.kept.length ? `，已在章程里 ${node.kept.join("、")}` : ""}`,
      ...node.stages.map(
        (s) =>
          `    ${s.id} [${s.status_label}] ${s.result}${s.criteria ? ` · 验收 ${s.criteria} 条` : ""}${s.evidence ? ` · 证据 ${s.evidence} 条` : ""}`,
      ),
    );
  }
  if (view.tasks.length)
    lines.push(
      `  任务归属（按目标的负责节点回填 ${view.tasks.length} 个）：`,
      ...view.tasks.map(
        (t) => `    ${t.task} ${t.goal} → ${t.part} ${t.part_name}`,
      ),
    );
  if (view.tasks_kept.length)
    lines.push(
      `  已有归属部分、不改 ${view.tasks_kept.length} 个：${view.tasks_kept.map((t) => `${t.task}（${t.part}）`).join("、")}`,
    );
  if (view.orphans.length)
    lines.push(
      `  负责节点不在组织树里、不能迁：${view.orphans.map((o) => `${o.goal}（${o.node}）`).join("、")}`,
    );
  if (lines.length === 1) lines.push("  没有要迁的目标或任务");
  if (view.preview)
    lines.push(
      "写入时先整库备份；阶段写进各节点章程并留修订（可 atrium org revert），goals 表与任务原来的 goal 不改；写入后 goal 命令下线",
    );
  else if (view.backup) lines.push(`备份：${view.backup}`);
  return lines.join("\n");
}
