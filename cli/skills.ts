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

/**
 * atrium skill：组织技能（#264 第 3b 步）。技能存在 Atrium，派活时按节点绑定与执行者档案临时挂载；
 * 执行者改了挂载副本会在收尾生成修订提议，经审核写成新修订。
 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const path = (value: string) => encodeURIComponent(value);
const as = (values: Values) =>
  str(values, "as") ? `?as=${path(str(values, "as")!)}` : "";
const options = { as: { type: "string" as const } };
const person = (value: string | null) =>
  value === "u1" ? "你" : (value ?? "无");
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
  pending: number;
  archived: boolean;
};

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
                  `${s.slug} ${s.rev}${s.archived ? " · 已归档" : ""} · owner ${s.owner ?? "你"} · 绑定 ${s.bound.join("、") || "无"}${s.pending ? ` · 待审提议 ${s.pending}` : ""}\n  ${s.description}`,
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
    args: "slug [--out 目录]",
    about: "查看技能内容与绑定；--out 导出文件以便修改",
    options: { ...options, out: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      const skill = await (
        await client()
      ).get<
        Omit<SkillView, "files" | "pending"> & {
          files: Record<string, string>;
          sizes: Record<string, number>;
          pending: { ref: string; task: string; base: string }[];
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
        ...(skill.pending.length
          ? [
              `待审提议：${skill.pending.map((p) => `${p.ref}（${p.task}，基于 ${p.base}）`).join("、")}`,
            ]
          : []),
        "",
        skill.files["SKILL.md"] ?? "",
      ];
      out(
        json,
        skill,
        lines.join("\n").trimEnd(),
        skill.pending.length
          ? `atrium skill proposal ${skill.pending[0]!.ref}`
          : `atrium skill history ${skill.slug}`,
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
        `atrium skill bind ${result.slug} <节点>`,
      );
    },
  },
  "skill edit": {
    args: "slug [目录或SKILL.md] [--name 名称] [--owner 节点] [--archive|--restore] [--rev rN] [--proposal pN] [--source 出处] [--reason 原因]",
    about: "修改技能并追加修订；用户纠正写 --reason 用户纠正… --source 出处",
    options: {
      ...options,
      name: { type: "string" },
      owner: { type: "string" },
      archive: { type: "boolean" },
      restore: { type: "boolean" },
      rev: { type: "string" },
      proposal: { type: "string" },
      source: { type: "string" },
      reason: { type: "string" },
    },
    positionals: [1, 2],
    async run({ positionals: [slug, source], values, json }) {
      if (values.archive && values.restore)
        throw new Problem(400, "--archive 与 --restore 只能选一个");
      const input: Record<string, unknown> = {
        reason: reason(values),
        rev: str(values, "rev"),
        name: str(values, "name"),
        owner: str(values, "owner"),
        source: str(values, "source"),
        proposal: str(values, "proposal"),
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
          "skill edit 需给出新内容（目录或 SKILL.md），或 --name、--owner、--archive、--restore 之一",
        );
      const result = await (
        await client()
      ).put<{ slug: string; before: string; rev: string; proposal?: string }>(
        `/skills/${path(slug!)}${as(values)}`,
        input,
      );
      out(
        json,
        result,
        `已更新技能 ${result.slug} ${result.before} → ${result.rev}${result.proposal ? `，${result.proposal} 标为已采纳` : ""}；下次派活生效`,
        `atrium skill history ${result.slug}`,
      );
    },
  },
  "skill history": {
    args: "slug [--rev rN] [--before rN] [--limit N]",
    about: "查看技能修订与来源；--rev 看该修订的差异",
    options: {
      ...options,
      rev: { type: "string" },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
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
          `atrium skill history ${result.slug}`,
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
          ? `atrium skill history ${result.slug} --before ${items.at(-1)!.rev}`
          : `atrium skill history ${result.slug} --rev ${items[0]?.rev ?? "r1"}`,
      );
    },
  },
  "skill revert": {
    args: "slug --to rN [--reason 原因]",
    about: "恢复旧修订的内容并追加新修订",
    options: { ...options, to: { type: "string" }, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [slug], values, json }) {
      if (!str(values, "to")) throw new Problem(400, "--to 必填，如 --to r2");
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
        `atrium skill history ${result.slug}`,
      );
    },
  },
  "skill bind": {
    args: "slug 节点",
    about: "把技能挂到节点：派到该节点及子节点的任务都带上",
    options,
    positionals: [2, 2],
    async run({ positionals: [slug, node], values, json }) {
      const result = await (
        await client()
      ).post<{ slug: string; node: string }>(
        `/skills/${path(slug!)}/bind${as(values)}`,
        { node },
      );
      out(
        json,
        result,
        `已把 ${result.slug} 挂到 ${result.node}；之后派到这里（含子节点）的任务都会带上`,
        `atrium skill show ${result.slug}`,
      );
    },
  },
  "skill unbind": {
    args: "slug 节点",
    about: "从节点上取下技能",
    options,
    positionals: [2, 2],
    async run({ positionals: [slug, node], values, json }) {
      const result = await (
        await client()
      ).post<{ slug: string; node: string }>(
        `/skills/${path(slug!)}/unbind${as(values)}`,
        { node },
      );
      out(
        json,
        result,
        `已从 ${result.node} 取下 ${result.slug}`,
        `atrium skill show ${result.slug}`,
      );
    },
  },
  "skill proposals": {
    args: "[--status pending|accepted|rejected|all] [--limit N]",
    about: "列出执行者改技能生成的修订提议（默认待审）",
    options: {
      ...options,
      status: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      for (const key of ["status", "limit"])
        if (str(values, key)) query.set(key, str(values, key)!);
      const rows = await (
        await client()
      ).get<
        {
          ref: string;
          skill: string;
          task: string;
          base: string;
          current: string;
          status: string;
          reason: string;
          result: string | null;
        }[]
      >(`/skill-proposals?${query}`);
      const labels: Record<string, string> = {
        pending: "待审",
        accepted: "已采纳",
        rejected: "已驳回",
      };
      out(
        json,
        rows,
        rows.length
          ? rows
              .map(
                (p) =>
                  `${p.ref} [${labels[p.status]}] ${p.skill} · ${p.task} · 基于 ${p.base}（当前 ${p.current}）${p.result ? ` → ${p.result}` : ""}\n  ${p.reason.split("\n")[0]}`,
              )
              .join("\n")
          : "没有提议",
        rows.length
          ? `atrium skill proposal ${rows[0]!.ref}`
          : "atrium skill ls",
      );
    },
  },
  "skill proposal": {
    args: "pN [--out 目录]",
    about: "查看一个修订提议的差异；--out 导出提议内容以便手工合并",
    options: { ...options, out: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const p = await (
        await client()
      ).get<{
        ref: string;
        skill: string;
        task: string;
        base: string;
        current: string;
        status: string;
        reason: string;
        decided_by: string | null;
        decision_reason: string | null;
        result: string | null;
        files: Record<string, string>;
        diff: string[];
      }>(`/skill-proposals/${path(id!)}`);
      if (str(values, "out")) {
        const root = exportTo(str(values, "out")!, p.files);
        out(
          json,
          { ...p, exported: root },
          `已导出 ${p.ref} 的内容到 ${root}`,
          `atrium skill edit ${p.skill} ${root} --rev ${p.current} --proposal ${p.ref} --reason 手工合并 ${p.ref}`,
        );
        return;
      }
      const lines = [
        `${p.ref} ${p.skill} · ${p.task} 提出 · 基于 ${p.base}，当前 ${p.current} · ${p.status === "pending" ? "待审" : p.status === "accepted" ? `已采纳（${person(p.decided_by)}，${p.result}）` : `已驳回（${person(p.decided_by)}：${p.decision_reason}）`}`,
        `原因：${p.reason}`,
        printDiff(p.diff),
      ];
      out(
        json,
        p,
        lines.join("\n"),
        p.status === "pending"
          ? `atrium skill accept ${p.ref}`
          : `atrium skill history ${p.skill}`,
      );
    },
  },
  "skill accept": {
    args: "pN [--reason 原因]",
    about: "采纳修订提议：写成新修订（基于旧版本时三方合并）",
    options: { ...options, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (
        await client()
      ).post<{
        ref: string;
        slug: string;
        before: string;
        rev: string;
        merged: boolean;
      }>(`/skill-proposals/${path(id!)}/accept${as(values)}`, {
        reason: str(values, "reason"),
      });
      out(
        json,
        result,
        `已采纳 ${result.ref}：${result.slug} ${result.before} → ${result.rev}${result.merged ? "（与期间的修订自动合并）" : ""}；下次派活生效`,
        `atrium skill history ${result.slug} --rev ${result.rev}`,
      );
    },
  },
  "skill reject": {
    args: "pN [--reason 原因]",
    about: "驳回修订提议",
    options: { ...options, reason: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const result = await (
        await client()
      ).post<{ ref: string; slug: string }>(
        `/skill-proposals/${path(id!)}/reject${as(values)}`,
        { reason: reason(values) },
      );
      out(
        json,
        result,
        `已驳回 ${result.ref}（${result.slug} 不变）`,
        "atrium skill proposals",
      );
    },
  },
};
