import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Chat } from "../shared/schema.ts";
import type { SpaceFile, SpaceListing } from "../shared/space.ts";
import { Problem } from "./problem.ts";

/** 列表最多给出的文件数。遍历的目录项和层级也有上限，目录再大也不拖慢请求。 */
const MAX_FILES = 300;
const MAX_VISITED = 3000;
const MAX_DEPTH = 8;

export function spacesDir(sqlitePath: string): string | null {
  if (sqlitePath === ":memory:") return null;
  return join(dirname(sqlitePath), "groups");
}

/** full 解析软链接后仍在 root 里时返回真实路径，否则返回 null。 */
function within(root: string, full: string): string | null {
  const real = realpathSync(full);
  return real === root || real.startsWith(root + sep) ? real : null;
}

/**
 * 每个群一个共享目录：<数据目录>/groups/<群短号>，改群名不影响。成员用自己的读写工具
 * 直接改文件；Atrium 只告诉它们路径、给用户列出和预览。谁能写靠约定，这里不校验。
 */
export class GroupSpaces {
  constructor(private root: string | null) {}

  /** 群的共享目录，第一次用到时创建；私聊和内存库没有。 */
  path(chat: Pick<Chat, "kind" | "ref">): string | null {
    if (!this.root || chat.kind !== "group") return null;
    const dir = join(this.root, chat.ref);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private require(chat: Pick<Chat, "kind" | "ref">) {
    const dir = this.path(chat);
    if (!dir) throw new Problem(404, "私聊没有共享目录");
    return dir;
  }

  /** 按修改时间倒序列出文件，含子目录，不列隐藏项和指向目录外的软链接。 */
  list(chat: Pick<Chat, "kind" | "ref">): SpaceListing {
    const dir = this.require(chat);
    const root = realpathSync(dir);
    const files: SpaceFile[] = [];
    let visited = 0,
      truncated = false;
    const walk = (current: string, depth: number) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (++visited > MAX_VISITED) {
          truncated = true;
          return;
        }
        const full = join(current, entry.name);
        let real: string | null;
        try {
          real = within(root, full);
        } catch {
          continue; // 断开的软链接
        }
        if (!real) continue;
        const stat = statSync(real);
        if (stat.isFile())
          files.push({
            path: relative(dir, full).split(sep).join("/"),
            size: stat.size,
            mtime: Math.round(stat.mtimeMs),
          });
        // 指向目录的软链接不进去，免得同一批文件列两遍或绕成环。
        else if (stat.isDirectory() && !entry.isSymbolicLink()) {
          if (depth < MAX_DEPTH) walk(full, depth + 1);
          else truncated = true;
        }
      }
    };
    walk(dir, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    return {
      path: dir,
      files: files.slice(0, MAX_FILES),
      truncated: truncated || files.length > MAX_FILES,
    };
  }

  /** 目录里一个文件的真实路径。只认目录内的相对路径，与列表同一口径：不读隐藏项和目录外的东西。 */
  file(chat: Pick<Chat, "kind" | "ref">, path: string): string {
    const dir = this.require(chat);
    const parts = path.split(/[\\/]/);
    if (
      !path ||
      isAbsolute(path) ||
      /^[\\/]|^[a-z]:/i.test(path) ||
      path.includes("\0") ||
      parts.some((part) => !part || part.startsWith("."))
    )
      throw new Problem(400, "只能读共享目录里的文件，用目录内的相对路径");
    const full = join(dir, path);
    if (!existsSync(full)) throw new Problem(404, "文件不存在");
    const real = within(realpathSync(dir), full);
    if (!real) throw new Problem(400, "这个文件在共享目录之外");
    if (!statSync(real).isFile()) throw new Problem(400, "这不是文件");
    return real;
  }
}
