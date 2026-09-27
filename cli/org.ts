import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";
import type { Doc } from "../server/org/model.ts";
import { formatParam, type Param } from "../server/org/boundaries.ts";

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
              `${"  ".repeat(depth(n))}${n.ref} [${labels[n.kind]}] ${n.name}${n.leader ? ` · leader ${person(n.leader)}` : ""}${formatCounts(n.tasks, n.sent)}${n.archived_at ? " · 已归档" : ""}`,
          )
          .join("\n") || "组织树为空",
        rows.length ? "atrium org show o1" : "atrium org import",
      );
    },
  },
  "org show": {
    args: "节点 [--charter|--card --raw]",
    about: "查看节点、章程和能力卡",
    options: {
      ...options,
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
        kind: string;
        path: string;
        leader: string | null;
        repos: string[];
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
        recent_tasks: {
          ref: string;
          title: string;
          status: string;
          worker: string | null;
          origin_ref: string | null;
        }[];
      };
      const lines = [
        `${node.ref} [${node.kind}] ${node.path} · leader ${person(node.leader)}`,
        `仓库：${node.repos.join("、") || "无"}`,
        ...(node.chain.length
          ? [
              "目标链",
              ...node.chain.map(
                (c) => `  ${c.name}：${c.goal.split("\n").join("\n    ")}`,
              ),
            ]
          : ["目标链：无"]),
        ...formatBoundaries(node.boundaries),
        ...formatDoc("章程", node.charter),
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
      ];
      out(json, result, lines.join("\n"), `atrium org history ${node.ref}`);
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
