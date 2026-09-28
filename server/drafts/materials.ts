import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { hasParentSegment, isAbsolutePath } from "../platform/plan.ts";
import { Problem } from "../problem.ts";
import { redact } from "../secret-redact.ts";
import { exec as defaultExec, type Exec } from "../tasks/git.ts";
import {
  isSecretName,
  OPAQUE_DIRS,
  stripUserinfo,
  type Materials,
} from "./plan.ts";

/**
 * 起草全景初稿的材料（只读）：README 开头、两层目录、最近提交、origin 地址。
 * 不跟软链接、不列隐藏与像凭据的文件；文字过一遍 redact 再进提示词。git 只跑读命令且不拿可选锁。
 */

export const README_MAX = 12 * 1024;
export const TREE_MAX = 150;
export const COMMITS = 20;

const usage = (message: string) => new Problem(400, message, "usage");

/** 仓库路径：绝对路径、不含 ..、是目录（仓库本身是软链接的照着走，里面的软链接不跟）。 */
export function checkRepo(repo: unknown): string {
  if (typeof repo !== "string" || !repo.trim())
    throw usage("仓库路径: 必填，如 /Users/me/code/openquota");
  const path = repo.trim();
  if (
    !isAbsolutePath(process.platform, path) ||
    hasParentSegment(process.platform, path)
  )
    throw usage(`仓库路径: 应为绝对路径，不能包含 ..：${path}`);
  let dir = false;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    throw usage(`仓库路径: 不存在：${path}`);
  }
  if (!dir) throw usage(`仓库路径: 不是目录：${path}`);
  return path;
}

/** 读文件开头至多 max 字节；截在多字节字符中间的替换符去掉。 */
function head(file: string, max: number) {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(max + 1);
    const n = readSync(fd, buffer, 0, max + 1, 0);
    const truncated = n > max;
    const text = buffer
      .subarray(0, Math.min(n, max))
      .toString("utf8")
      .replace(/�+$/, "");
    return { text, truncated };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

type Entry = { name: string; dir: boolean; file: boolean };
function entries(dir: string): Entry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** README：根目录下 README.md 优先，其次 README、readme.*（软链接不读）。 */
function readme(repo: string, list: readonly Entry[]) {
  const candidates = list.filter(
    (e) => e.file && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name),
  );
  const pick =
    candidates.find((e) => /\.md$/i.test(e.name)) ?? candidates[0] ?? null;
  if (!pick) return null;
  const read = head(join(repo, pick.name), README_MAX);
  return read
    ? { file: pick.name, text: redact(read.text), truncated: read.truncated }
    : null;
}

/** 两层目录：隐藏的、像凭据的不列，依赖与产物目录列名字不展开；至多 TREE_MAX 行。 */
function tree(repo: string, root: readonly Entry[]) {
  const lines: string[] = [];
  let skipped = 0;
  let truncated = false;
  const push = (line: string) => {
    if (lines.length >= TREE_MAX) truncated = true;
    else lines.push(line);
  };
  const visible = (list: readonly Entry[]) =>
    list.filter((e) => {
      if (e.name.startsWith(".")) {
        if (e.file && isSecretName(e.name)) skipped++;
        return false;
      }
      if (!e.dir && !e.file) return false;
      if (isSecretName(e.name)) {
        skipped++;
        return false;
      }
      return true;
    });
  for (const entry of visible(root)) {
    push(entry.dir ? `${entry.name}/` : entry.name);
    if (!entry.dir || OPAQUE_DIRS.has(entry.name)) continue;
    for (const child of visible(entries(join(repo, entry.name))))
      push(`  ${child.dir ? `${child.name}/` : child.name}`);
  }
  return { lines, truncated, skipped };
}

export async function repoMaterials(
  path: unknown,
  run: Exec = defaultExec,
): Promise<Materials> {
  const repo = checkRepo(path);
  const root = entries(repo);
  const listed = tree(repo, root);
  const git = (args: string[]) =>
    run("git", ["--no-optional-locks", "-C", repo, ...args], {
      timeoutMs: 10_000,
    });
  const [log, origin] = await Promise.all([
    git(["log", `-n${COMMITS}`, "--date=short", "--format=%h %ad %s"]),
    git(["config", "--get", "remote.origin.url"]),
  ]);
  return {
    repo,
    name: basename(repo),
    origin:
      origin.ok && origin.stdout.trim() ? stripUserinfo(origin.stdout) : null,
    readme: readme(repo, root),
    tree: listed.lines,
    tree_truncated: listed.truncated,
    skipped: listed.skipped,
    commits: log.ok
      ? redact(log.stdout)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, COMMITS)
      : [],
  };
}
