import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import {
  exportBoundaries,
  parseBoundaries,
  type Boundary,
  type ParamKey,
} from "../org/boundaries.ts";
import { ownBoundaries } from "../org/boundary-store.ts";
import { nodes, one, ref, type DocRow } from "../org/model.ts";
import { editDoc } from "../org/write.ts";
import { importMark, markImported } from "./marks.ts";

/**
 * 根章程进库（#355）：预算与硬边界只读组织树根节点章程。首次启动时根节点缺某项预算、
 * 而旧的 `~/Atrium/charter.md` frontmatter 里有，就导入一次（留章程修订）；之后不再读这个文件。
 */

/** 旧章程 budget 下的键 → 根章程边界参数。money 是旧写法；磁盘下限不再使用（u1 09-28 定），读到就跳过。 */
type Imported = Exclude<ParamKey, "disk_min_free_gb">;
const LEGACY_KEYS: Record<string, Imported | null> = {
  quota_reserve_percent: "quota_reserve_percent",
  disk_min_free_gb: null,
  money: "money_yuan_max",
  money_yuan_max: "money_yuan_max",
};
const IMPORTED: Imported[] = ["quota_reserve_percent", "money_yuan_max"];

/** 导入后的边界条目：与 org import 以来根章程里的写法一致。 */
const ENTRY: Record<Imported, { id: string; summary: string }> = {
  quota_reserve_percent: {
    id: "quota-reserve",
    summary: "每个订阅账号的周期额度留给用户",
  },
  money_yuan_max: { id: "money", summary: "花费上限（元）" },
};

export type CharterBudget = {
  entries: Boundary[];
  problems: string[];
};

/** 从旧章程 frontmatter 的 budget 读出边界条目；坏值逐项报，不抛。 */
export function parseCharterBudget(text: string): CharterBudget {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  if (frontmatter === undefined) return { entries: [], problems: [] };
  let data: unknown;
  try {
    data = YAML.parse(frontmatter);
  } catch (error) {
    return {
      entries: [],
      problems: [
        `frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const budget =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).budget
      : undefined;
  if (budget === undefined || budget === null)
    return { entries: [], problems: [] };
  if (typeof budget !== "object" || Array.isArray(budget))
    return { entries: [], problems: ["budget 应为键值"] };
  const entries: Boundary[] = [];
  const problems: string[] = [];
  const seen = new Set<ParamKey>();
  for (const [name, value] of Object.entries(budget)) {
    const key = LEGACY_KEYS[name];
    if (key === null) continue;
    if (!key) {
      problems.push(`budget.${name} 不认识，跳过`);
      continue;
    }
    if (seen.has(key)) continue;
    const parsed = parseBoundaries([
      { ...ENTRY[key], param: { [key]: value } },
    ]);
    if (parsed.problems.length || !parsed.entries[0]?.param) {
      problems.push(
        `budget.${name}：${parsed.problems.map((p) => p.message).join("；") || "无效"}，跳过`,
      );
      continue;
    }
    seen.add(key);
    entries.push(parsed.entries[0]);
  }
  return { entries, problems };
}

/** 根节点还缺哪几项预算：已有同参数的条目就不导入；条目 id 撞上无参数的旧条目也跳过。 */
export function missingBudget(
  own: Boundary[],
  imported: Boundary[],
): { add: Boundary[]; skipped: string[] } {
  const keys = new Set(own.flatMap((e) => (e.param ? [e.param.key] : [])));
  const ids = new Set(own.map((e) => e.id));
  const add: Boundary[] = [];
  const skipped: string[] = [];
  for (const entry of imported) {
    if (!entry.param || keys.has(entry.param.key)) continue;
    if (ids.has(entry.id)) {
      skipped.push(`${entry.param.key}（根章程已有条目 ${entry.id}）`);
      continue;
    }
    add.push(entry);
  }
  return { add, skipped };
}

export type CharterImport =
  | { status: "done"; detail: string }
  | { status: "imported"; keys: ParamKey[] }
  | { status: "no_root" }
  | { status: "no_file" }
  | { status: "nothing" };

/**
 * 导入一次旧章程预算。根节点还没建（组织未初始化）时不记号，等下次启动；
 * 文件不在、没有预算、根节点已有预算都记号，之后不再读文件。
 */
export function importCharterBudget(
  db: DatabaseSync,
  file: string,
  log: (line: string) => void = console.error,
  read: (file: string) => string = (path) => readFileSync(path, "utf8"),
): CharterImport {
  const mark = importMark(db, "charter_budget");
  if (mark) return { status: "done", detail: mark.detail };
  const root = nodes(db).find((n) => n.parent_id === null);
  const charter = root
    ? one<DocRow>(
        db,
        "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
        root.id,
      )
    : undefined;
  if (!root) return { status: "no_root" };
  const own = ownBoundaries(db, root.id);
  if (IMPORTED.every((key) => own.some((e) => e.param?.key === key))) {
    markImported(db, "charter_budget", "根章程已有全部预算");
    return { status: "nothing" };
  }
  let text: string;
  try {
    text = read(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log(`根章程导入：读不到 ${file}（${code}），跳过`);
    markImported(db, "charter_budget", `没有旧章程 ${file}`);
    return { status: "no_file" };
  }
  const parsed = parseCharterBudget(text);
  for (const problem of parsed.problems) log(`根章程导入：${file} ${problem}`);
  const { add, skipped } = missingBudget(own, parsed.entries);
  for (const item of skipped) log(`根章程导入：跳过 ${item}`);
  if (!add.length) {
    markImported(db, "charter_budget", "旧章程没有根章程缺的预算");
    return { status: "nothing" };
  }
  try {
    editDoc(
      db,
      ref(root.id),
      "charter",
      {
        fields: charter ? (JSON.parse(charter.fields) as unknown) : {},
        body: charter?.body ?? "",
        boundaries: [...exportBoundaries(own), ...exportBoundaries(add)],
        rev: `r${charter?.rev ?? 0}`,
        reason: `从 ${file} 导入预算`,
      },
      "u1",
    );
  } catch (error) {
    // 下级已有更严的设定等冲突：记日志、记号，由用户在根章程里改，不挡启动。
    log(
      `根章程导入：写入失败，跳过（${error instanceof Error ? error.message : String(error)}）`,
    );
    markImported(db, "charter_budget", "写入失败，已跳过");
    return { status: "nothing" };
  }
  const keys = add.map((e) => e.param!.key);
  markImported(db, "charter_budget", `导入 ${keys.join("、")}`);
  log(`根章程已导入预算：${keys.join("、")}（来自 ${file}）`);
  return { status: "imported", keys };
}
