import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { isBuiltinTool, TOOLS } from "./adapters/index.ts";
import { TOOL_NAME_RE } from "./adapters/cli-spec.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { all, atomically, one } from "./ledger-model.ts";

/**
 * 执行者档案的存储（#355 第 2 项）：三层档案（harness / models / combos）存数据库，每次改动留一条修订。
 * 一份档案 = 原文（frontmatter + 正文），解析与叠加仍在 profiles.ts。
 * 首次启动从旧目录（ATRIUM_WORKERS_DIR 或 ~/Atrium/workers）导入一次，导入后不再读目录。
 */

export const PROFILE_LAYERS = ["harness", "models", "combos"] as const;
export type ProfileLayerName = (typeof PROFILE_LAYERS)[number];
export const isProfileLayer = (value: unknown): value is ProfileLayerName =>
  typeof value === "string" &&
  (PROFILE_LAYERS as readonly string[]).includes(value);

/** 单份档案原文上限；档案是规则与叮嘱，不是日志。 */
export const PROFILE_MAX_BYTES = 64 * 1024;
const NAME_RE = /^[\w.@-]+$/;

export type StoredProfile = {
  layer: ProfileLayerName;
  name: string;
  source: string;
  rev: number;
  updated_by: string;
  updated_at: number;
};

export type ProfileRevision = {
  rev: number;
  author: string;
  at: number;
  reason: string;
  source: string;
};

export function ensureWorkerProfiles(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_profiles (
      layer TEXT NOT NULL CHECK(layer IN ('harness','models','combos')),
      name TEXT NOT NULL, source TEXT NOT NULL, rev INTEGER NOT NULL,
      updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(layer,name));
    CREATE TABLE IF NOT EXISTS worker_profile_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL,
      author TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL,
      UNIQUE(layer,name,rev));
    CREATE TABLE IF NOT EXISTS worker_profile_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dir TEXT NOT NULL, at INTEGER NOT NULL,
      imported INTEGER NOT NULL, skipped TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS worker_profile_revisions_no_update
      BEFORE UPDATE ON worker_profile_revisions BEGIN SELECT RAISE(ABORT,'worker_profile_revisions append only'); END;
    CREATE TRIGGER IF NOT EXISTS worker_profile_revisions_no_delete
      BEFORE DELETE ON worker_profile_revisions BEGIN SELECT RAISE(ABORT,'worker_profile_revisions append only'); END;`);
}

/** 工具名：内置工具，或通用执行者的名字（t271，harness 档案里写 protocol 才登记成执行者）。 */
const toolName = (name: string) => isBuiltinTool(name) || TOOL_NAME_RE.test(name);

/**
 * 档案名是否合法（纯函数）：harness 是工具名，models 是模型名最后一段，combos 是 `工具+模型名`。
 * 合法返回 null，否则返回原因。
 */
export function profileNameProblem(
  layer: ProfileLayerName,
  name: string,
): string | null {
  if (layer === "harness")
    return toolName(name)
      ? null
      : `工具层档案名须是内置工具（${TOOLS.join("、")}）或通用执行者名（小写字母开头，只含小写字母、数字、连字符）`;
  if (layer === "models")
    return NAME_RE.test(name) && !name.startsWith(".")
      ? null
      : "模型层档案名须是模型名最后一段，如 gpt-6-sol";
  const plus = name.indexOf("+");
  const tool = name.slice(0, plus);
  const model = name.slice(plus + 1);
  return plus > 0 &&
    toolName(tool) &&
    NAME_RE.test(model) &&
    !model.startsWith(".")
    ? null
    : "组合层档案名须是 工具+模型名，如 codex+gpt-6-sol";
}

/** 解析 `层/名`（如 harness/codex、combos/codex+gpt-6-sol），不合法抛 400。 */
export function parseProfileRef(value: string) {
  const slash = value.indexOf("/");
  const layer = value.slice(0, slash);
  const name = value.slice(slash + 1);
  if (slash < 0 || !isProfileLayer(layer))
    throw new Problem(
      400,
      `档案应写成 层/名，层是 ${PROFILE_LAYERS.join("、")}，如 harness/codex`,
      "usage",
    );
  const problem = profileNameProblem(layer, name);
  if (problem) throw new Problem(400, problem, "usage");
  return { layer, name };
}

export function readProfile(
  db: DatabaseSync,
  layer: ProfileLayerName,
  name: string,
) {
  return one<StoredProfile>(
    db,
    "SELECT layer,name,source,rev,updated_by,updated_at FROM worker_profiles WHERE layer=? AND name=?",
    layer,
    name,
  );
}

export function listProfiles(db: DatabaseSync) {
  return all<StoredProfile>(
    db,
    "SELECT layer,name,source,rev,updated_by,updated_at FROM worker_profiles ORDER BY CASE layer WHEN 'harness' THEN 0 WHEN 'models' THEN 1 ELSE 2 END, name LIMIT 500",
  );
}

export function profileHistory(
  db: DatabaseSync,
  layer: ProfileLayerName,
  name: string,
  limit = 20,
) {
  return all<ProfileRevision>(
    db,
    "SELECT rev,author,at,reason,source FROM worker_profile_revisions WHERE layer=? AND name=? ORDER BY rev DESC LIMIT ?",
    layer,
    name,
    Math.max(1, Math.min(limit, 200)),
  );
}

/** 原文能否存（纯函数）：只查大小与空字符；规则写法由 profiles.ts 的 profileWarnings 查。 */
export function sourceProblems(source: string): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(source, "utf8") > PROFILE_MAX_BYTES)
    problems.push(`档案超过 ${PROFILE_MAX_BYTES / 1024} KB，请精简`);
  if (source.includes("\0")) problems.push("档案含空字符");
  return problems;
}

/**
 * 写一份档案并留修订；原文没变不加修订。须在调用方校验过层名与原文。
 * 返回新版本号与是否有改动。
 */
export function writeProfile(
  db: DatabaseSync,
  input: {
    layer: ProfileLayerName;
    name: string;
    source: string;
    author: string;
    reason: string;
    at?: number;
  },
) {
  return atomically(db, () => {
    const current = readProfile(db, input.layer, input.name);
    if (current && current.source === input.source)
      return { rev: current.rev, changed: false, created: false };
    const rev = (current?.rev ?? 0) + 1;
    const at = input.at ?? Date.now();
    db.prepare(
      `INSERT INTO worker_profiles(layer,name,source,rev,updated_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(layer,name) DO UPDATE SET source=excluded.source,rev=excluded.rev,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    ).run(input.layer, input.name, input.source, rev, input.author, at);
    db.prepare(
      "INSERT INTO worker_profile_revisions(layer,name,rev,author,at,reason,source) VALUES(?,?,?,?,?,?,?)",
    ).run(
      input.layer,
      input.name,
      rev,
      input.author,
      at,
      input.reason,
      input.source,
    );
    return { rev, changed: true, created: !current };
  });
}

/**
 * 改 frontmatter 里的一个键（纯函数）：value 为 undefined 时删掉这一行；没有 frontmatter 就补一段。
 * 值原样写进去（行内写法，如 `high`、`[a, b]`），调用方负责校验结果。
 */
export function patchFront(
  source: string,
  key: string,
  value: string | undefined,
) {
  const text = source.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n"))
    return value === undefined
      ? text
      : `---\n${key}: ${value}\n---\n${text ? `\n${text}` : ""}`;
  const end = text.indexOf("\n---", 3);
  if (end < 0)
    throw new Problem(409, "执行者档案 frontmatter 不完整", "conflict");
  const head = end === 3 ? [] : text.slice(4, end).split("\n");
  const at = head.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (value === undefined) {
    if (at >= 0) head.splice(at, 1);
  } else if (at >= 0) head[at] = `${key}: ${value}`;
  else head.push(`${key}: ${value}`);
  return `---\n${head.length ? `${head.join("\n")}\n` : ""}---${text.slice(end + 4)}`;
}

export type ImportResult = {
  dir: string;
  imported: number;
  skipped: { file: string; reason: string }[];
};

/** 是否已经导入过：导入过（不管来自哪个目录）就不再读旧目录。 */
export const profilesImported = (db: DatabaseSync) =>
  !!one(db, "SELECT 1 AS ok FROM worker_profile_imports LIMIT 1");

/**
 * 首次启动从旧目录导入档案（自愈）：单个文件读不了、名字不合法或超限就跳过并记日志，其余照常；
 * frontmatter 里个别写错的行照旧导入（与读文件时一样只作警告，免得丢掉整份档案的限制）。
 * 库里已有的同名档案不覆盖。导入过就不再读目录（幂等）；目录不存在时什么都不做，用内置缺省。
 */
export function importWorkerProfiles(
  db: DatabaseSync,
  dir: string | undefined,
  log: (message: string) => void = console.warn,
): ImportResult | null {
  if (!dir || profilesImported(db)) return null;
  let top;
  try {
    top = lstatSync(dir);
  } catch {
    return null;
  }
  if (!top.isDirectory()) return null;
  const result: ImportResult = { dir, imported: 0, skipped: [] };
  const skip = (file: string, reason: string) => {
    result.skipped.push({ file, reason });
    log(`执行者档案 ${file} 未导入：${reason}`);
  };
  const at = Date.now();
  for (const layer of PROFILE_LAYERS) {
    const sub = join(dir, layer);
    let names: string[];
    try {
      if (!lstatSync(sub).isDirectory()) continue;
      names = readdirSync(sub).sort();
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.endsWith(".md")) continue;
      const file = join(sub, entry);
      const name = entry.slice(0, -3);
      const problem = profileNameProblem(layer, name);
      if (problem) {
        skip(file, problem);
        continue;
      }
      let source: string;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) {
          skip(file, "不是普通文件");
          continue;
        }
        if (stat.size > PROFILE_MAX_BYTES) {
          skip(file, `超过 ${PROFILE_MAX_BYTES / 1024} KB`);
          continue;
        }
        source = readFileSync(file, "utf8");
      } catch (error) {
        skip(file, `读不了：${(error as Error).message}`);
        continue;
      }
      const problems = sourceProblems(source);
      if (problems.length) {
        skip(file, problems.join("；"));
        continue;
      }
      // 不是内置工具的工具层档案只有写了 protocol 才是通用执行者（t271）；旧目录里的其余名字照旧跳过。
      if (
        layer === "harness" &&
        !isBuiltinTool(name) &&
        parseFrontmatter(source).data.protocol === undefined
      ) {
        skip(file, `不是内置工具（${TOOLS.join("、")}），也没写 protocol`);
        continue;
      }
      if (readProfile(db, layer, name)) continue;
      writeProfile(db, {
        layer,
        name,
        source,
        author: "import",
        reason: `从 ${file} 导入`,
        at,
      });
      result.imported++;
    }
  }
  db.prepare(
    "INSERT INTO worker_profile_imports(dir,at,imported,skipped) VALUES(?,?,?,?)",
  ).run(dir, at, result.imported, JSON.stringify(result.skipped));
  if (result.imported || result.skipped.length)
    log(
      `执行者档案已从 ${dir} 导入 ${result.imported} 份${result.skipped.length ? `，跳过 ${result.skipped.length} 份` : ""}；此后只读数据库`,
    );
  return result;
}
