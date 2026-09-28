import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Problem } from "../server/problem.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";
import { defaultActor } from "./worker-guard.ts";

/**
 * atrium skill：组织技能（#264 第 3b 步）。技能存在 Atrium，派活时按节点绑定与执行者档案临时挂载。
 */

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
const out = (json: boolean, value: unknown, text: string, next: string) => {
  if (json) printJson(value);
  else console.log(text);
  recordNext(`动作：${next}`);
};
const reason = (values: Values) => {
  const result = str(values, "reason");
  if (!result?.trim()) throw new Problem(400, "--reason 不能为空");
  return result;
};

/** 读技能来源：一个 SKILL.md 文件，或含 SKILL.md 的目录（跳过隐藏文件与符号链接，校验交给服务）。 */
export function readSkillSource(source: string): Record<string, string> {
  const root = resolve(source);
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new Problem(400, `技能来源读不到：${root}`);
  }
  if (stat.isFile()) return { "SKILL.md": readFileSync(root, "utf8") };
  if (!stat.isDirectory())
    throw new Problem(400, `技能来源应为 SKILL.md 文件或目录：${root}`);
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        if (Object.keys(files).length >= 64)
          throw new Problem(400, `${root} 文件太多：技能最多 32 个文件`);
        bytes += lstatSync(full).size;
        if (bytes > 1024 * 1024)
          throw new Problem(400, `${root} 太大：技能合计最多 256 KB`);
        files[rel] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root, "");
  if (!files["SKILL.md"]) throw new Problem(400, `${root} 下没有 SKILL.md`);
  return files;
}

/** 把技能文件写到一个空目录，方便改完再用 skill edit 写回。 */
function exportTo(target: string, files: Record<string, string>) {
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length)
    throw new Problem(400, `--out 目录不是空的：${root}`);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const printDiff = (lines: string[]) => {
  const shown = lines
    .slice(0, 200)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
  if (lines.length > 200) shown.push(`…省略 ${lines.length - 200} 行`);
  return shown.join("\n") || "（无文件变化）";
};

type SkillView = {
  slug: string;
  name: string;
  description: string;
  rev: string;
  owner: string | null;
  bound: string[];
  files: number;
  archived: boolean;
};

/** skill show --history：修订与来源；--rev 看该修订的差异。 */
async function history(slug: string, values: Values, json: boolean) {
  const query = new URLSearchParams();
  for (const key of ["rev", "before", "limit"])
    if (str(values, key)) query.set(key, str(values, key)!);
  type Item = {
    rev: string;
    author: string;
    reviewer: string | null;
    at: number;
    reason: string;
    source: string | null;
  };
  const result = await (
    await client()
  ).get<{
    slug: string;
    items?: Item[];
    has_more?: boolean;
    revision?: Item;
    diff?: string[];
    meta?: { field: string; before: unknown; after: unknown }[];
  }>(`/skills/${path(slug!)}/history?${query}`);
  const line = (r: Item) =>
    `${r.rev} ${new Date(r.at).toLocaleString("zh-CN")} ${person(r.author)}${r.reviewer ? `（${person(r.reviewer)} 审核）` : ""} —— ${r.reason}${r.source ? ` · 出处 ${r.source}` : ""}`;
  if (result.revision) {
    out(
      json,
      result,
      [
        `${result.slug} ${line(result.revision)}`,
        ...(result.meta ?? []).map(
          (m) =>
            `${m.field}：${String(m.before ?? "（空）")} → ${String(m.after ?? "（空）")}`,
        ),
        printDiff(result.diff ?? []),
      ].join("\n"),
      `atrium skill show ${result.slug} --history`,
    );
    return;
  }
  const items = result.items ?? [];
  out(
    json,
    result,
    [
      `${result.slug} 的修订（新→旧）`,
      ...items.map(line),
      ...(result.has_more ? ["还有更早的修订"] : []),
    ].join("\n"),
    result.has_more
      ? `atrium skill show ${result.slug} --history --before ${items.at(-1)!.rev}`
      : `atrium skill show ${result.slug} --history --rev ${items[0]?.rev ?? "r1"}`,
  );
}

export const skillCommands: Record<string, Command> = {
  "skill ls": {
    args: "[--all]",
    about: "列出组织技能（--all 含已归档）",
    options: { ...options, all: { type: "boolean" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const rows = await (
        await client()
      ).get<SkillView[]>(`/skills${values.all ? "?archived=1" : ""}`);
      out(
        json,
        rows,
        rows.length
          ? rows
              .map(
                (s) =>
                  `${s.slug} ${s.rev}${s.archived ? " · 已归档" : ""} · owner ${s.owner ?? "你"} · 绑定 ${s.bound.join("、") || "无"}\n  ${s.description}`,
              )
              .join("\n")
          : "还没有技能",
        rows.length
          ? `atrium skill show ${rows[0]!.slug}`
          : "atrium skill add <slug> <目录或SKILL.md> --reason 原因",
      );
    },
  },
  "skill show": {
    args: "slug [--out 目录] [--history [--rev rN] [--before rN] [--limit N]]",
    about:
      "查看技能内容与绑定；--out 导出文件以便修改；--history 看修订与来源，--rev 看该修订的差异",
    options: {
      ...options,
      out: { type: "string" },
      history: { type: "boolean" },
      rev: { type: "string" },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      if (values.history === true || str(values, "rev"))
        return history(slug!, values, json);
      const skill = await (
        await client()
      ).get<
        Omit<SkillView, "files"> & {
          files: Record<string, string>;
          sizes: Record<string, number>;
        }
      >(`/skills/${path(slug!)}`);
      if (str(values, "out")) {
        const root = exportTo(str(values, "out")!, skill.files);
        out(
          json,
          { ...skill, exported: root },
          `已导出 ${skill.slug} ${skill.rev} 到 ${root}`,
          `atrium skill edit ${skill.slug} ${root} --rev ${skill.rev} --reason 原因`,
        );
        return;
      }
      const lines = [
        `${skill.slug} ${skill.rev} · ${skill.name}${skill.archived ? " · 已归档" : ""}`,
        `简介：${skill.description}`,
        `owner：${skill.owner ?? "你"} · 绑定：${skill.bound.join("、") || "无"}`,
        `文件：${Object.entries(skill.sizes)
          .map(([f, n]) => `${f}（${n} 字节）`)
          .join("、")}`,
        "",
        skill.files["SKILL.md"] ?? "",
      ];
      out(
        json,
        skill,
        lines.join("\n").trimEnd(),
        `atrium skill show ${skill.slug} --history`,
      );
    },
  },
  "skill add": {
    args: "slug 目录或SKILL.md [--description 简介] [--name 名称] [--owner 节点] [--source 出处] [--reason 原因]",
    about: "新建组织技能（owner 默认组织根节点）",
    options: {
      ...options,
      description: { type: "string" },
      name: { type: "string" },
      owner: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [2, 2],
    async run({ positionals: [slug, source], values, json }) {
      const result = await (
        await client()
      ).post<{
        slug: string;
        rev: string;
        owner: string | null;
        files: number;
      }>(`/skills${as(values)}`, {
        slug,
        files: readSkillSource(source!),
        description: str(values, "description"),
        name: str(values, "name"),
        owner: str(values, "owner"),
        source: str(values, "source"),
        reason: reason(values),
      });
      out(
        json,
        result,
        `已新建技能 ${result.slug} ${result.rev}（${result.files} 个文件，owner ${result.owner ?? "你"}），还没绑到任何节点`,
        `atrium skill edit ${result.slug} --bind <节点>`,
      );
    },
  },
  "skill edit": {
    args: "slug [目录或SKILL.md] [--name 名称] [--owner 节点] [--archive|--restore] [--to rN] [--bind 节点] [--unbind 节点] [--rev rN] [--source 出处] [--reason 原因]",
    about:
      "修改技能并追加修订；--to 恢复旧修订的内容；--bind 挂到节点（派到该节点及子节点的任务都带上），--unbind 从节点取下；用户纠正写 --reason 用户纠正… --source 出处",
    options: {
      ...options,
      name: { type: "string" },
      owner: { type: "string" },
      archive: { type: "boolean" },
      restore: { type: "boolean" },
      to: { type: "string" },
      bind: { type: "string" },
      unbind: { type: "string" },
      rev: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [1, 2],
    async run({ positionals: [slug, source], values, json }) {
      for (const flag of ["bind", "unbind"] as const) {
        const node = str(values, flag);
        if (node === undefined) continue;
        const result = await (
          await client()
        ).post<{ slug: string; node: string }>(
          `/skills/${path(slug!)}/${flag}${as(values)}`,
          { node },
        );
        out(
          json,
          result,
          flag === "bind"
            ? `已把 ${result.slug} 挂到 ${result.node}；之后派到这里（含子节点）的任务都会带上`
            : `已从 ${result.node} 取下 ${result.slug}`,
          `atrium skill show ${result.slug}`,
        );
        return;
      }
      if (str(values, "to")) {
        const result = await (
          await client()
        ).post<{ slug: string; before: string; rev: string; to: string }>(
          `/skills/${path(slug!)}/revert${as(values)}`,
          { to: str(values, "to"), reason: reason(values) },
        );
        out(
          json,
          result,
          `已把 ${result.slug} 恢复到 ${result.to} 的内容，${result.before} → ${result.rev}`,
          `atrium skill show ${result.slug} --history`,
        );
        return;
      }
      if (values.archive && values.restore)
        throw new Problem(400, "--archive 与 --restore 只能选一个");
      const input: Record<string, unknown> = {
        reason: reason(values),
        rev: str(values, "rev"),
        name: str(values, "name"),
        owner: str(values, "owner"),
        source: str(values, "source"),
        ...(values.archive ? { archive: true } : {}),
        ...(values.restore ? { archive: false } : {}),
      };
      if (source) input.files = readSkillSource(source);
      if (
        !source &&
        input.name === undefined &&
        input.owner === undefined &&
        input.archive === undefined
      )
        throw new Problem(
          400,
          "skill edit 需给出新内容（目录或 SKILL.md），或 --name、--owner、--archive、--restore、--to、--bind、--unbind 之一",
        );
      const result = await (
        await client()
      ).put<{ slug: string; before: string; rev: string }>(
        `/skills/${path(slug!)}${as(values)}`,
        input,
      );
      out(
        json,
        result,
        `已更新技能 ${result.slug} ${result.before} → ${result.rev}；下次派活生效`,
        `atrium skill show ${result.slug} --history`,
      );
    },
  },
};
